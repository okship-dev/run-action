import * as core from "@actions/core";
import pkg from "../package.json";

// ── Timing constants ──────────────────────────────────────────
const OVERALL_TIMEOUT_MS = 30 * 60 * 1000;   // 30 min total budget
const INITIAL_POLL_MS = 10 * 1000;            // first sleep before poll 1
const MAX_POLL_MS = 60 * 1000;                // backoff cap
const TRIGGER_TIMEOUT_MS = 30 * 1000;         // POST /api/runs timeout
const POLL_TIMEOUT_MS = 15 * 1000;            // GET /status timeout

const USER_AGENT = `okship-run-action/${pkg.version}`;

// ── Wire types ────────────────────────────────────────────────
interface TriggerResponse {
  run_id: string;
  status: string;
  scenario_count: number;
  uses_byok: boolean;
  overage_units: number;
  warning?: string;
}

interface StatusResponse {
  id: string;
  status: string;
  complete: boolean;
  overall_result?: "pass" | "fail" | "ambiguous" | null;
}

// ── HTTP error ────────────────────────────────────────────────
class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// ── HTTP helpers ──────────────────────────────────────────────
async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    const parsed = text ? safeParseJson(text) : null;
    if (!res.ok) {
      throw new HttpError(
        res.status,
        parsed,
        `POST ${url} returned ${res.status}: ${describeBody(parsed)}`,
      );
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson<T>(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const text = await res.text();
    const parsed = text ? safeParseJson(text) : null;
    if (!res.ok) {
      throw new HttpError(
        res.status,
        parsed,
        `GET ${url} returned ${res.status}: ${describeBody(parsed)}`,
      );
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeBody(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: unknown }).error;
    return typeof err === "string" ? err : JSON.stringify(body);
  }
  return typeof body === "string" ? body : JSON.stringify(body ?? null);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main ──────────────────────────────────────────────────────
async function run(): Promise<void> {
  const apiKey = core.getInput("api_key", { required: true });
  const appId = core.getInput("app_id", { required: true });
  const scenariosRaw = core.getInput("scenarios");
  const waitForCompletion = core.getInput("wait_for_completion") !== "false";
  const apiBaseRaw = core.getInput("okship_api_base", { required: true });
  const apiBase = apiBaseRaw.replace(/\/+$/, "");

  const triggerBody: Record<string, unknown> = { app_id: appId };
  if (scenariosRaw) {
    triggerBody.scenario_ids = scenariosRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const trigger = await postJson<TriggerResponse>(
    `${apiBase}/api/runs`,
    triggerBody,
    { "X-API-Key": apiKey, "User-Agent": USER_AGENT },
    TRIGGER_TIMEOUT_MS,
  );

  const runUrl = `${apiBase}/dashboard/runs/${trigger.run_id}`;
  core.setOutput("run_id", trigger.run_id);
  core.setOutput("run_url", runUrl);

  if (trigger.warning === "run_created_but_enqueue_failed") {
    core.warning(
      `Run ${trigger.run_id} was created but the worker queue rejected it. The run exists in 'pending' state — check the OKShip dashboard.`,
    );
    return;
  }

  if (!waitForCompletion) {
    core.info(
      `Run ${trigger.run_id} enqueued. Skipping poll (wait_for_completion=false).`,
    );
    return;
  }

  core.info(`Run ${trigger.run_id} enqueued. Polling for completion...`);
  const startedAt = Date.now();
  let nextDelayMs = INITIAL_POLL_MS;

  while (Date.now() - startedAt < OVERALL_TIMEOUT_MS) {
    await sleep(nextDelayMs);

    let status: StatusResponse;
    try {
      status = await getJson<StatusResponse>(
        `${apiBase}/api/runs/${trigger.run_id}/status`,
        { "User-Agent": USER_AGENT },
        POLL_TIMEOUT_MS,
      );
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        core.setFailed(`Run ${trigger.run_id} not found during poll.`);
        return;
      }
      core.info(
        `Poll attempt failed (${err instanceof Error ? err.message : String(err)}); retrying.`,
      );
      nextDelayMs = Math.min(nextDelayMs * 2, MAX_POLL_MS);
      continue;
    }

    if (status.complete) {
      if (status.overall_result != null) {
        core.setOutput("verdict", status.overall_result);
        core.info(
          `Run ${trigger.run_id} complete. Verdict: ${status.overall_result}.`,
        );
      } else {
        core.warning(
          `Run ${trigger.run_id} reached terminal status '${status.status}' without a verdict (failed or cancelled before pass2 computed overall_result).`,
        );
      }
      return;
    }

    core.info(
      `Run ${trigger.run_id} status: ${status.status}. Continuing poll.`,
    );
    nextDelayMs = Math.min(nextDelayMs * 2, MAX_POLL_MS);
  }

  core.warning(
    `Polling timeout reached after 30 minutes. Run ${trigger.run_id} is still in flight. ` +
      `Check the OKShip dashboard at ${runUrl} for completion.`,
  );
}

run().catch((err) => {
  if (err instanceof Error) {
    core.setFailed(err.message);
  } else {
    core.setFailed(String(err));
  }
});
