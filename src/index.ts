import * as core from "@actions/core";
import pkg from "../package.json";

// ── Timing constants ──────────────────────────────────────────
const OVERALL_TIMEOUT_MS = 30 * 60 * 1000;   // 30 min total budget, trigger included
const INITIAL_POLL_MS = 10 * 1000;            // first sleep before poll 1
const MAX_POLL_MS = 60 * 1000;                // backoff cap
const TRIGGER_TIMEOUT_MS = 30 * 1000;         // POST /api/runs timeout
const POLL_TIMEOUT_MS = 15 * 1000;            // GET /status timeout

// ── Admission-busy retry (POST /api/runs answering 503 admission_busy) ──
// OKShip answers 503 { error: "admission_busy" } with Retry-After when another
// run for the same organisation holds the admission lock. It is raised only from
// the admission transaction, which rolls back, so no run was created and the
// identical request is safe to repeat. NO OTHER POST FAILURE IS RETRIED: a POST
// the server accepted but whose answer was lost would create a duplicate run.
const ADMISSION_BUSY_CODE = "admission_busy";
const ADMISSION_BUSY_MAX_RETRIES = 3;
const ADMISSION_BUSY_MAX_WAIT_MS = 60 * 1000;      // cap on any one Retry-After
const ADMISSION_BUSY_DEFAULT_WAIT_MS = 5 * 1000;   // when Retry-After is absent or unreadable

// Production OKShip. Run links and the API share this origin.
const DEFAULT_API_BASE = "https://okship.dev";

const USER_AGENT = `okship-run-action/${pkg.version}`;

// ── Wire types ────────────────────────────────────────────────
// Every value of OKShip's OverallOutcome enum (prisma/schema.prisma).
const VERDICTS = ["pass", "fail", "ambiguous", "mixed"] as const;
type Verdict = (typeof VERDICTS)[number];

function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

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
  // Absent while the run is in flight, and absent on a finished run whose
  // verdict OKShip is withholding (held or quarantined).
  overall_result?: string | null;
}

// ── HTTP error ────────────────────────────────────────────────
class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly retryAfter: string | null,
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
        res.headers.get("retry-after"),
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
        res.headers.get("retry-after"),
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

function isAdmissionBusy(err: unknown): err is HttpError {
  return (
    err instanceof HttpError &&
    err.status === 503 &&
    typeof err.body === "object" &&
    err.body !== null &&
    (err.body as { error?: unknown }).error === ADMISSION_BUSY_CODE
  );
}

// Retry-After is either delay-seconds or an HTTP-date (RFC 9110 §10.2.3).
function retryAfterMs(header: string | null): number {
  if (header !== null) {
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed)) {
      return Math.min(Number(trimmed) * 1000, ADMISSION_BUSY_MAX_WAIT_MS);
    }
    const at = Date.parse(trimmed);
    if (!Number.isNaN(at)) {
      return Math.min(Math.max(0, at - Date.now()), ADMISSION_BUSY_MAX_WAIT_MS);
    }
  }
  return ADMISSION_BUSY_DEFAULT_WAIT_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// POST /api/runs, retried ONLY on 503 admission_busy (see the constants above).
async function triggerRun(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  deadline: number,
): Promise<TriggerResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await postJson<TriggerResponse>(url, body, headers, TRIGGER_TIMEOUT_MS);
    } catch (err) {
      if (!isAdmissionBusy(err) || attempt >= ADMISSION_BUSY_MAX_RETRIES) throw err;
      const waitMs = retryAfterMs(err.retryAfter);
      if (Date.now() + waitMs >= deadline) throw err;
      core.info(
        `OKShip is busy starting another run for this organisation (503 admission_busy). ` +
          `Retry ${attempt + 1} of ${ADMISSION_BUSY_MAX_RETRIES} in ${Math.ceil(waitMs / 1000)}s.`,
      );
      await sleep(waitMs);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────
async function run(): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + OVERALL_TIMEOUT_MS;

  const apiKey = core.getInput("api_key", { required: true });
  const appId = core.getInput("app_id", { required: true });
  const scenariosRaw = core.getInput("scenarios");
  const waitForCompletion = core.getInput("wait_for_completion") !== "false";
  const apiBaseRaw = core.getInput("okship_api_base") || DEFAULT_API_BASE;
  const apiBase = apiBaseRaw.replace(/\/+$/, "");

  const triggerBody: Record<string, unknown> = { app_id: appId };
  if (scenariosRaw) {
    triggerBody.scenario_ids = scenariosRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const trigger = await triggerRun(
    `${apiBase}/api/runs`,
    triggerBody,
    { "X-API-Key": apiKey, "User-Agent": USER_AGENT },
    deadline,
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
  let nextDelayMs = INITIAL_POLL_MS;

  while (Date.now() < deadline) {
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
      reportFinished(trigger.run_id, runUrl, status);
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

// A finished run (status complete, failed or cancelled). OKShip's status route
// returns overall_result for every finished run EXCEPT one whose verdict it is
// withholding (a held or quarantined run): that run still reports its real
// status and complete: true, with overall_result left out. A run only reaches
// status 'complete' with a verdict computed, so 'complete' with none means the
// verdict is being withheld, not that it was never produced.
function reportFinished(runId: string, runUrl: string, status: StatusResponse): void {
  const result = status.overall_result;

  if (result != null) {
    if (!isVerdict(result)) {
      core.setFailed(
        `Run ${runId} finished with verdict '${result}', which this version of the action does not recognise. ` +
          `Update okship-dev/run-action. Run: ${runUrl}`,
      );
      return;
    }
    core.setOutput("verdict", result);
    core.info(`Run ${runId} complete. Verdict: ${result}.`);
    return;
  }

  switch (status.status) {
    case "complete":
      core.warning(
        `Run ${runId} finished, but OKShip is holding its verdict for review, so no verdict is set. ` +
          `Open the run for its current state: ${runUrl}`,
      );
      return;
    case "failed":
      core.warning(
        `Run ${runId} failed before OKShip returned a verdict, so no verdict is set. Open the run: ${runUrl}`,
      );
      return;
    case "cancelled":
      core.warning(
        `Run ${runId} was cancelled before OKShip returned a verdict, so no verdict is set. Open the run: ${runUrl}`,
      );
      return;
    default:
      core.warning(
        `Run ${runId} finished with status '${status.status}' and no verdict. Open the run: ${runUrl}`,
      );
  }
}

run().catch((err) => {
  if (err instanceof Error) {
    core.setFailed(err.message);
  } else {
    core.setFailed(String(err));
  }
});
