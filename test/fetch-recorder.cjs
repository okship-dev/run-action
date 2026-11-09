// Preloaded (node --require) by the default-base-URL test only. Replaces global
// fetch so the action never reaches the network: it records the URL of every
// request to FETCH_RECORD_PATH and answers 401 invalid_api_key.
const fs = require("node:fs");

globalThis.fetch = async (url) => {
  fs.appendFileSync(process.env.FETCH_RECORD_PATH, String(url) + "\n");
  return new Response(JSON.stringify({ error: "invalid_api_key" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
};
