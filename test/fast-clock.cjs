// Preloaded (node --require) by the deadline tests only. A VIRTUAL clock:
// Date.now() starts at the real time and advances ONLY when a timer fires, and
// then exactly to that timer's due time. Each timer really waits its delay
// divided by FAST_CLOCK_SCALE (default 20). So the action's timeline is exact
// and repeatable: real timer jitter and network latency add no virtual time,
// and a request that the server holds ends when the action's own abort timer
// says it does. Nothing in the action knows about it.
//
// Recorded to FETCH_RECORD_PATH, each line "<ms since start, virtual> <WHAT>":
//   <t> <METHOD> <url>   a request started
//   <t> ERROR <METHOD>   that request rejected (for a poll: aborted)
//   <t> EXIT             the process is exiting
// Each request also carries the virtual elapsed time in an x-fake-elapsed
// header, so a mock server can see the action's own clock.
const fs = require("node:fs");

const SCALE = Number(process.env.FAST_CLOCK_SCALE || 20);
const realSetTimeout = globalThis.setTimeout;
const t0 = Date.now();
let now = t0;

Date.now = () => now;
globalThis.setTimeout = (fn, ms, ...args) => {
  // Only the ACTION's timers drive the virtual clock. Node's built-in fetch
  // (undici) arms its own housekeeping timers through the global setTimeout;
  // left on this clock, one firing under load would push virtual time forward.
  const caller = (new Error().stack || "").split("\n")[2] || "";
  if (caller.includes("node:internal")) return realSetTimeout(fn, ms, ...args);
  const delay = Math.max(0, Number(ms) || 0);
  const due = now + delay;
  return realSetTimeout(() => {
    if (due > now) now = due;
    fn(...args);
  }, delay / SCALE);
};

const record = (what) =>
  fs.appendFileSync(process.env.FETCH_RECORD_PATH, `${now - t0} ${what}\n`);

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || "GET";
  record(`${method} ${url}`);
  const headers = { ...(opts.headers || {}), "x-fake-elapsed": String(now - t0) };
  try {
    return await realFetch(url, { ...opts, headers });
  } catch (err) {
    record(`ERROR ${method}`);
    throw err;
  }
};

process.on("exit", () => record("EXIT"));
