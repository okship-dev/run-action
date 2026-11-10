// Preloaded (node --require) by the fragment-redaction tests only. Replaces
// global fetch with a script: the Nth request gets the Nth entry of the JSON
// array in FETCH_SCRIPT ({ status, body }); the last entry repeats. Nothing goes
// to the network, so a key that fetch's header check would refuse still lets
// the action reach code that logs the server's answers. That is how a single
// piece of the key, on its own, is fed through the action's logging path.
const script = JSON.parse(process.env.FETCH_SCRIPT);
let n = 0;

globalThis.fetch = async () => {
  const r = script[Math.min(n++, script.length - 1)];
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { "content-type": "application/json" },
  });
};
