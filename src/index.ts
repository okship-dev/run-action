import * as core from "@actions/core";
import pkg from "../package.json";

// ── Timing constants ──────────────────────────────────────────
// The total budget, trigger included, is the `timeout_minutes` input:
// default 30 (ruling 123, R123.2), accepted range 1..120. A value outside the
// range, or not a whole number, fails the step BEFORE any run is started.
const DEFAULT_TIMEOUT_MINUTES = 30;
const MAX_TIMEOUT_MINUTES = 120;
const INITIAL_POLL_MS = 10 * 1000;            // first sleep before poll 1
const MAX_POLL_MS = 60 * 1000;                // backoff cap
const TRIGGER_TIMEOUT_MS = 30 * 1000;         // POST /api/runs timeout
const POLL_TIMEOUT_MS = 15 * 1000;            // one MCP get_run call's timeout
// Every sleep and every request timeout is clamped to what is left of the
// budget, and the deadline is rechecked before every request.

// ── Reading the verdict: MCP get_run (owner ruling 130, 2026-11-19) ──
// The poll is a stateless MCP tools/call to POST {base}/api/mcp, authenticated
// with the SAME X-API-Key that started the run. The key therefore needs BOTH
// scopes: `run` (POST /api/runs) and `read` (POST /api/mcp) -- R123.5. The
// REST read API is NOT used: API_READ_ENABLED stays off in production.
const MCP_PROTOCOL_VERSION = "2025-11-25";
const TERMINAL_STATUSES = ["complete", "failed", "cancelled"] as const;

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

// OKShip's agent-read facts carry { value, provenance } (lib/agent-read/read.ts).
interface Fact<T> {
  value: T;
  provenance?: string;
}

// The fields of MCP get_run's `run` this action reads (lib/mcp/schemas.ts).
interface McpRun {
  id: Fact<string>;
  status: Fact<string>;
  // ABSENT (not null) on a run whose verdict OKShip is withholding (held or
  // quarantined); null while no verdict has been computed.
  overall_result?: Fact<string | null>;
  scenarios?: Array<{ result: Fact<string> }>;
}

// A refusal that is final: polling again cannot change it.
class ReadRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadRefused";
  }
}

// ── Secret redaction ──────────────────────────────────────────
// The API key is registered with core.setSecret as soon as it is read, so the
// runner masks it in the job log. That is not enough on its own: a key with an
// internal newline is masked line by line at best, and an error thrown while
// building the request (fetch's header validation) quotes the raw value. So
// every message this action logs passes through redact() as well.
const secrets: string[] = [];

function addSecret(value: string): void {
  if (!value) return;
  core.setSecret(value);
  const forms = new Set<string>([value, JSON.stringify(value).slice(1, -1)]);
  // Split on any run of CR and/or LF: a lone CR separates pieces too.
  for (const line of value.split(/[\r\n]+/)) {
    if (line.trim().length >= 4) forms.add(line);
  }
  // Longest first, so a whole key is replaced before any of its lines.
  secrets.push(...[...forms].sort((a, b) => b.length - a.length));
}

function redact(message: string): string {
  let out = message;
  for (const s of secrets) out = out.split(s).join("***");
  return out;
}

const log = {
  info: (message: string) => core.info(redact(message)),
  warning: (message: string) => core.warning(redact(message)),
  fail: (message: string) => core.setFailed(redact(message)),
};

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

// One MCP tools/call get_run. Returns the run, or throws:
//   ReadRefused -- final (401/403 from the route, a tool error such as
//                  run_not_found or insufficient_scope): the step fails now;
//   anything else -- transient (network, 5xx, timeout): the caller retries.
async function mcpGetRun(
  apiBase: string,
  runId: string,
  apiKey: string,
  rpcId: number,
  timeoutMs: number,
): Promise<McpRun> {
  const url = `${apiBase}/api/mcp`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        "X-API-Key": apiKey,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId,
        method: "tools/call",
        params: { name: "get_run", arguments: { run_id: runId } },
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    // The route answers plain JSON or a one-event SSE stream ("data: {...}").
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    const parsed = text ? safeParseJson(dataLine ? dataLine.slice(5).trim() : text) : null;
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw new ReadRefused(`OKShip could not read the run: ${describeBody(parsed)}`);
    }
    if (!res.ok) {
      throw new HttpError(
        res.status,
        parsed,
        res.headers.get("retry-after"),
        `POST ${url} (get_run) returned ${res.status}: ${describeBody(parsed)}`,
      );
    }
    const rpc = parsed as {
      result?: { isError?: boolean; structuredContent?: { run?: McpRun }; content?: Array<{ text?: string }> };
      error?: { message?: string };
    } | null;
    if (rpc?.error) {
      throw new ReadRefused(`OKShip could not read the run: ${rpc.error.message ?? JSON.stringify(rpc.error)}`);
    }
    if (rpc?.result?.isError) {
      const errText = rpc.result.content?.[0]?.text ?? "";
      throw new ReadRefused(`OKShip could not read the run: ${describeBody(safeParseJson(errText))}`);
    }
    const run = rpc?.result?.structuredContent?.run;
    if (!run || typeof run.status?.value !== "string") {
      throw new Error(`POST ${url} (get_run) returned no run.`);
    }
    return run;
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

// A refusal's `message` is OKShip's approved copy (for the CI gate, ADR-0046's
// CI_GATE_COPY) and is printed VERBATIM after the error code, never reworded.
function describeBody(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: unknown }).error;
    const msg = (body as { message?: unknown }).message;
    const code = typeof err === "string" ? err : JSON.stringify(body);
    return typeof msg === "string" && msg.length > 0 ? `${code}: ${msg}` : code;
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

class BudgetExhausted extends Error {
  constructor(minutes: number) {
    super(`The ${minutes}-minute budget ran out before OKShip accepted the run.`);
    this.name = "BudgetExhausted";
  }
}

// POST /api/runs, retried ONLY on 503 admission_busy (see the constants above).
async function triggerRun(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  deadline: number,
  minutes: number,
): Promise<TriggerResponse> {
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new BudgetExhausted(minutes);
    try {
      return await postJson<TriggerResponse>(
        url,
        body,
        headers,
        Math.min(TRIGGER_TIMEOUT_MS, remaining),
      );
    } catch (err) {
      if (!isAdmissionBusy(err) || attempt >= ADMISSION_BUSY_MAX_RETRIES) throw err;
      const waitMs = retryAfterMs(err.retryAfter);
      if (Date.now() + waitMs >= deadline) throw err;
      log.info(
        `OKShip is busy starting another run for this organisation (503 admission_busy). ` +
          `Retry ${attempt + 1} of ${ADMISSION_BUSY_MAX_RETRIES} in ${Math.ceil(waitMs / 1000)}s.`,
      );
      await sleep(waitMs);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────
function readTimeoutMinutes(): number | null {
  const raw = core.getInput("timeout_minutes").trim();
  if (raw === "") return DEFAULT_TIMEOUT_MINUTES;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_TIMEOUT_MINUTES ? n : null;
}

async function run(): Promise<void> {
  const startedAt = Date.now();

  const apiKey = core.getInput("api_key", { required: true });
  addSecret(apiKey);
  const appId = core.getInput("app_id", { required: true });
  const scenariosRaw = core.getInput("scenarios");
  const waitForCompletion = core.getInput("wait_for_completion") !== "false";
  const apiBaseRaw = core.getInput("okship_api_base") || DEFAULT_API_BASE;
  const apiBase = apiBaseRaw.replace(/\/+$/, "");

  // Validated BEFORE the POST, so a bad value never starts a billable run.
  const minutes = readTimeoutMinutes();
  if (minutes === null) {
    log.fail(
      `timeout_minutes must be a whole number from 1 to ${MAX_TIMEOUT_MINUTES}. No run was started.`,
    );
    return;
  }
  const deadline = startedAt + minutes * 60 * 1000;

  const triggerBody: Record<string, unknown> = { app_id: appId };
  if (scenariosRaw) {
    triggerBody.scenario_ids = scenariosRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Any refusal (non-2xx) fails the step, as `curl --fail` does; the server's
  // message is quoted verbatim (describeBody).
  const trigger = await triggerRun(
    `${apiBase}/api/runs`,
    triggerBody,
    { "X-API-Key": apiKey, "User-Agent": USER_AGENT },
    deadline,
    minutes,
  );

  // MCP has no proof-link read (generate_proof_link is not served), so the
  // link printed is the run's dashboard page.
  const runUrl = `${apiBase}/dashboard/runs/${trigger.run_id}`;
  core.setOutput("run_id", trigger.run_id);
  core.setOutput("run_url", runUrl);

  if (trigger.warning === "run_created_but_enqueue_failed") {
    log.warning(
      `Run ${trigger.run_id} was created but the worker queue rejected it. The run exists in 'pending' state — check the OKShip dashboard.`,
    );
    return;
  }

  if (!waitForCompletion) {
    log.info(
      `Run ${trigger.run_id} enqueued. Skipping poll (wait_for_completion=false).`,
    );
    return;
  }

  log.info(`Run ${trigger.run_id} enqueued. Waiting up to ${minutes} minutes for the verdict...`);
  let nextDelayMs = INITIAL_POLL_MS;
  let rpcId = 0;

  for (;;) {
    let remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(nextDelayMs, remaining));

    remaining = deadline - Date.now();
    if (remaining <= 0) break;

    let runRead: McpRun;
    try {
      runRead = await mcpGetRun(
        apiBase,
        trigger.run_id,
        apiKey,
        ++rpcId,
        Math.min(POLL_TIMEOUT_MS, remaining),
      );
    } catch (err) {
      if (err instanceof ReadRefused) {
        log.fail(`${err.message} Run: ${runUrl}`);
        return;
      }
      log.info(
        `Poll attempt failed (${err instanceof Error ? err.message : String(err)}); retrying.`,
      );
      nextDelayMs = Math.min(nextDelayMs * 2, MAX_POLL_MS);
      continue;
    }

    if ((TERMINAL_STATUSES as readonly string[]).includes(runRead.status.value)) {
      reportFinished(trigger.run_id, runUrl, runRead);
      return;
    }

    log.info(
      `Run ${trigger.run_id} status: ${runRead.status.value}. Continuing poll.`,
    );
    nextDelayMs = Math.min(nextDelayMs * 2, MAX_POLL_MS);
  }

  log.fail(`No answer from OKShip within ${minutes} minutes. The run keeps going: ${runUrl}`);
}

function countResults(run: McpRun, result: string): number {
  return (run.scenarios ?? []).filter((s) => s.result?.value === result).length;
}

// A finished run (status complete, failed or cancelled). ONLY `pass` passes the
// job. `fail`, `ambiguous` ("not sure") and `mixed` fail it: by v0.1.0's rule
// (README, Verdicts) a mixed run's scenarios disagree, so it always holds at
// least one fail or not-sure. No verdict -- withheld, failed, cancelled -- fails
// it too: the job cannot claim a pass it was not shown.
function reportFinished(runId: string, runUrl: string, run: McpRun): void {
  const withheld = !("overall_result" in run);
  const result = run.overall_result?.value ?? null;

  if (result != null) {
    if (!isVerdict(result)) {
      log.fail(
        `Run ${runId} finished with verdict '${result}', which this version of the action does not recognise. ` +
          `Update okship-dev/run-action. Run: ${runUrl}`,
      );
      return;
    }
    core.setOutput("verdict", result);
    const failed = countResults(run, "fail");
    const notSure = countResults(run, "ambiguous");
    switch (result) {
      case "pass":
        log.info(`All scenarios passed. Run: ${runUrl}`);
        return;
      case "fail":
      case "ambiguous":
      case "mixed": {
        const parts: string[] = [];
        if (failed > 0) parts.push(`${failed} scenario(s) failed.`);
        if (notSure > 0) parts.push(`${notSure} scenario(s) came back not sure.`);
        if (parts.length === 0) parts.push(`Verdict: ${result}.`);
        log.fail(`${parts.join(" ")} Run: ${runUrl}`);
        return;
      }
    }
  }

  if (withheld && run.status.value === "complete") {
    log.fail(`This run's results are on hold. See the dashboard: ${runUrl}`);
    return;
  }
  log.fail(`OKShip couldn't finish this run (${run.status.value}). Run: ${runUrl}`);
}

run().catch((err) => {
  log.fail(err instanceof Error ? err.message : String(err));
});
