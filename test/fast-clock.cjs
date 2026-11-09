// Preloaded (node --require) by the deadline test only. Once the first request
// (the POST /api/runs) has answered, the action's clock runs 1000x fast,
// consistently: Date.now() and every setTimeout delay are both scaled, so the
// rest of a 30-minute budget passes in under 2 real seconds. Nothing in the
// action knows about it. Every fetch is recorded to FETCH_RECORD_PATH as
// "<ms since process start, on the action's clock> <METHOD> <url>".
const fs = require("node:fs");

const SCALE = 1000;
const realNow = Date.now;
const realSetTimeout = globalThis.setTimeout;
const t0 = realNow();
let fastFrom = null;

Date.now = () => (fastFrom === null ? realNow() : fastFrom + (realNow() - fastFrom) * SCALE);
globalThis.setTimeout = (fn, ms, ...args) =>
  realSetTimeout(fn, fastFrom === null ? ms : Math.max(0, (Number(ms) || 0) / SCALE), ...args);

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  fs.appendFileSync(
    process.env.FETCH_RECORD_PATH,
    `${Date.now() - t0} ${(opts && opts.method) || "GET"} ${url}\n`,
  );
  try {
    return await realFetch(url, opts);
  } finally {
    if (fastFrom === null) fastFrom = realNow();
  }
};
