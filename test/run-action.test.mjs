// Local tests for the BUILT action (dist/index.js), run as a child process the
// way the Actions runner runs it: inputs as INPUT_* env vars, outputs written to
// the file named by GITHUB_OUTPUT. A small mock HTTP server stands in for
// OKShip. Real timings and no test-only switches in the action; the one test
// that needs a 30-minute budget to pass quickly preloads test/fast-clock.cjs.
// The cases run concurrently, so the suite takes about as long as its slowest
// case (the 60-second Retry-After cap).
//
//   pnpm test           (after pnpm build)
//
// Each case prints one PASS/FAIL line.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, "..", "dist", "index.js");
const RECORDER = path.join(here, "fetch-recorder.cjs");
const FAST_CLOCK = path.join(here, "fast-clock.cjs");
const API_KEY = "ok_live_TESTKEY_never_printed_0123456789";
const APP_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

const accepted = { run_id: RUN_ID, status: "pending", scenario_count: 2, uses_byok: true, overage_units: 0 };

// A mock OKShip. `script.post` and `script.poll` are arrays of responses served
// in order (the last one repeats). `{ drop: true }` destroys the connection
// after the request body has been received, with no response. Every request is
// recorded with its arrival time.
async function mockOkship(script) {
  const requests = [];
  let posts = 0;
  let polls = 0;
  const server = http.createServer((req, res) => {
    const at = Date.now();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body, at });
      let r;
      if (req.method === "POST" && req.url === "/api/runs") {
        r = script.post[Math.min(posts++, script.post.length - 1)];
      } else if (req.method === "GET" && req.url === `/api/runs/${RUN_ID}/status`) {
        r = script.poll[Math.min(polls++, script.poll.length - 1)];
      } else {
        r = { status: 404, body: { error: "not_found" } };
      }
      if (r.drop) {
        req.socket.destroy();
        return;
      }
      res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const posted = () => requests.filter((q) => q.method === "POST");
  return { base, requests, posted, close: () => new Promise((resolve) => server.close(resolve)) };
}

function runAction({ base, apiKey = API_KEY, extraEnv = {}, nodeArgs = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "okship-run-action-"));
  const outputFile = path.join(dir, "output");
  fs.writeFileSync(outputFile, "");
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot ?? "",
    GITHUB_OUTPUT: outputFile,
    INPUT_API_KEY: apiKey,
    INPUT_APP_ID: APP_ID,
    INPUT_WAIT_FOR_COMPLETION: "true",
    ...(base ? { INPUT_OKSHIP_API_BASE: base } : {}),
    ...extraEnv,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...nodeArgs, DIST], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      const outputs = {};
      const outputText = fs.readFileSync(outputFile, "utf8");
      const re = /^(\w+)<<(\S+)\r?\n([\s\S]*?)\r?\n\2$/gm;
      for (const m of outputText.matchAll(re)) outputs[m[1]] = m[3];
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code, stdout: stdout + stderr, stdoutOnly: stdout, stderr, outputText, outputs });
    });
  });
}

// One PASS/FAIL line per case.
function check(name, fn) {
  return test(name, async () => {
    try {
      await fn();
      console.log(`[test] PASS ${name}`);
    } catch (err) {
      console.log(`[test] FAIL ${name}`);
      throw err;
    }
  });
}

// The key must appear nowhere: not in stdout, stderr, or the outputs file. The
// only exception is the runner's own `::add-mask::` command, which is how
// core.setSecret registers the value for masking (the runner consumes that
// line; it never reaches the job log). Checked in every form a log line could
// carry it: raw, as the workflow-command escaping writes it (%0A, %0D, %25),
// and line by line.
function assertNoKey(r, key = API_KEY) {
  const forms = new Set([
    key,
    key.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A"),
    ...key.split(/[\r\n]+/).filter((l) => l.length >= 4),
  ]);
  const streams = {
    stdout: r.stdoutOnly.split(/\r?\n/).filter((l) => !l.startsWith("::add-mask::")).join("\n"),
    stderr: r.stderr,
    outputs: r.outputText,
  };
  for (const [where, text] of Object.entries(streams)) {
    for (const f of forms) {
      assert.ok(!text.includes(f), `the API key (form ${JSON.stringify(f)}) appeared in ${where}`);
    }
  }
}

const terminal = (overall_result) => ({
  status: 200,
  body: { id: RUN_ID, status: "complete", complete: true, overall_result },
});

describe("okship run-action", { concurrency: true }, () => {
  for (const verdict of ["pass", "fail", "mixed", "ambiguous"]) {
    check(`verdict ${verdict} sets the verdict output`, async () => {
      const ok = await mockOkship({ post: [{ status: 202, body: accepted }], poll: [terminal(verdict)] });
      try {
        const r = await runAction({ base: ok.base });
        assert.equal(r.code, 0, r.stdout);
        assert.equal(r.outputs.verdict, verdict);
        assert.equal(r.outputs.run_id, RUN_ID);
        assert.equal(r.outputs.run_url, `${ok.base}/dashboard/runs/${RUN_ID}`);
        assert.match(r.stdoutOnly, /^::add-mask::/m, "core.setSecret was not called");
        assertNoKey(r);
      } finally {
        await ok.close();
      }
    });
  }

  check("withheld run: polls through in-flight, stops on complete with no verdict, warns, sets no verdict", async () => {
    const ok = await mockOkship({
      post: [{ status: 202, body: accepted }],
      poll: [
        { status: 200, body: { id: RUN_ID, status: "pass2_running", complete: false } },
        // What OKShip's status route returns for a finished, withheld run.
        { status: 200, body: { id: RUN_ID, status: "complete", complete: true } },
      ],
    });
    try {
      const r = await runAction({ base: ok.base });
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.outputs.verdict, undefined);
      assert.match(
        r.stdout,
        /::warning::OKShip is withholding this run's verdict, so no verdict is set\. Open the run to see why: http/,
      );
      assert.equal(ok.requests.filter((q) => q.method === "GET").length, 2);
      assertNoKey(r);
    } finally {
      await ok.close();
    }
  });

  check("failed run with no verdict warns 'failed', sets no verdict", async () => {
    const ok = await mockOkship({
      post: [{ status: 202, body: accepted }],
      poll: [{ status: 200, body: { id: RUN_ID, status: "failed", complete: true, overall_result: null } }],
    });
    try {
      const r = await runAction({ base: ok.base });
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.outputs.verdict, undefined);
      assert.match(r.stdout, /::warning::.*failed before OKShip returned a verdict/);
    } finally {
      await ok.close();
    }
  });

  check("503 admission_busy with Retry-After 1 is retried after ~1s, then succeeds", async () => {
    const busy = { status: 503, headers: { "retry-after": "1" }, body: { error: "admission_busy", message: "busy" } };
    const ok = await mockOkship({ post: [busy, { status: 202, body: accepted }], poll: [terminal("pass")] });
    try {
      const r = await runAction({ base: ok.base });
      assert.equal(r.code, 0, r.stdout);
      const [first, second] = ok.posted();
      assert.equal(ok.posted().length, 2);
      const gap = second.at - first.at;
      // >= 1s: Retry-After was honoured. < 4s: it was READ (absent or unreadable
      // falls back to 5s).
      assert.ok(gap >= 950 && gap < 4000, `gap between POSTs was ${gap} ms`);
      assert.match(r.stdout, /503 admission_busy\)\. Retry 1 of 3 in 1s/);
      assert.equal(r.outputs.verdict, "pass");
      assertNoKey(r);
    } finally {
      await ok.close();
    }
  });

  check("503 admission_busy with Retry-After 300 waits 60s (the cap), not 300s", async () => {
    const busy = { status: 503, headers: { "retry-after": "300" }, body: { error: "admission_busy" } };
    const ok = await mockOkship({ post: [busy, { status: 202, body: accepted }], poll: [terminal("pass")] });
    try {
      const r = await runAction({ base: ok.base });
      assert.equal(r.code, 0, r.stdout);
      const [first, second] = ok.posted();
      const gap = second.at - first.at;
      assert.ok(gap >= 59_500 && gap < 63_000, `gap between POSTs was ${gap} ms`);
      assert.match(r.stdout, /Retry 1 of 3 in 60s/);
    } finally {
      await ok.close();
    }
  });

  check("503 admission_busy is retried at most 3 times, then fails the step", async () => {
    const busy = { status: 503, headers: { "retry-after": "0" }, body: { error: "admission_busy" } };
    const ok = await mockOkship({ post: [busy], poll: [terminal("pass")] });
    try {
      const r = await runAction({ base: ok.base });
      assert.equal(r.code, 1, r.stdout);
      assert.equal(ok.posted().length, 4);
      assert.match(r.stdout, /::error::POST .* returned 503: admission_busy/);
    } finally {
      await ok.close();
    }
  });

  check("500 on POST is NOT retried and fails the step", async () => {
    const ok = await mockOkship({ post: [{ status: 500, body: { error: "internal" } }], poll: [terminal("pass")] });
    try {
      const r = await runAction({ base: ok.base });
      assert.equal(r.code, 1, r.stdout);
      assert.equal(ok.posted().length, 1);
      assert.match(r.stdout, /::error::POST .* returned 500/);
      assertNoKey(r);
    } finally {
      await ok.close();
    }
  });

  check("503 that is NOT admission_busy is NOT retried", async () => {
    const ok = await mockOkship({
      post: [{ status: 503, headers: { "retry-after": "1" }, body: { error: "unavailable" } }],
      poll: [terminal("pass")],
    });
    try {
      const r = await runAction({ base: ok.base });
      assert.equal(r.code, 1, r.stdout);
      assert.equal(ok.posted().length, 1);
    } finally {
      await ok.close();
    }
  });

  check("connection dropped after the POST was received is NOT retried", async () => {
    const ok = await mockOkship({ post: [{ drop: true }, { status: 202, body: accepted }], poll: [terminal("pass")] });
    try {
      const r = await runAction({ base: ok.base });
      assert.equal(r.code, 1, r.stdout);
      assert.equal(ok.posted().length, 1);
      assert.match(r.stdout, /::error::/);
      assertNoKey(r);
    } finally {
      await ok.close();
    }
  });

  check("404 during poll fails the step", async () => {
    const ok = await mockOkship({ post: [{ status: 202, body: accepted }], poll: [{ status: 404, body: { error: "not_found" } }] });
    try {
      const r = await runAction({ base: ok.base });
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stdout, /::error::Run .* not found during poll\./);
    } finally {
      await ok.close();
    }
  });

  check("no okship_api_base input uses https://okship.dev", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "okship-run-action-rec-"));
    const record = path.join(dir, "urls");
    try {
      const r = await runAction({ base: null, nodeArgs: ["--require", RECORDER], extraEnv: { FETCH_RECORD_PATH: record } });
      const urls = fs.readFileSync(record, "utf8").trim().split("\n");
      assert.deepEqual(urls, ["https://okship.dev/api/runs"]);
      assert.equal(r.code, 1, r.stdout); // the recorder answers 401
      assert.match(r.stdout, /invalid_api_key/);
      assertNoKey(r);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  check("deadline: no request starts after the 30-minute budget, and the step ends with the timeout warning", async () => {
    const ok = await mockOkship({
      post: [{ status: 202, body: accepted }],
      poll: [{ status: 200, body: { id: RUN_ID, status: "pass1_running", complete: false } }],
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "okship-run-action-clock-"));
    const record = path.join(dir, "requests");
    try {
      const r = await runAction({ base: ok.base, nodeArgs: ["--require", FAST_CLOCK], extraEnv: { FETCH_RECORD_PATH: record } });
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.stdout, /::warning::Polling timeout reached after 30 minutes/);
      const lines = fs.readFileSync(record, "utf8").trim().split("\n");
      const gets = lines.filter((l) => l.includes(" GET "));
      assert.ok(gets.length > 5, `only ${gets.length} polls recorded`);
      const last = Math.max(...lines.map((l) => Number(l.split(" ")[0])));
      // 30 min = 1,800,000 ms. The 2 s allowance covers the gap between this
      // preload's start and the action reading its own start time. The old loop
      // issued a request at about 30m10s.
      assert.ok(last <= 1_802_000, `a request started at ${last} ms on the action's clock`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await ok.close();
    }
  });

  for (const [label, key] of [
    ["a key containing a newline", "ok_live_abc_first_line\ndef_second_line_secret"],
    ["a key that triggers fetch's header error (carriage return)", "ok_live_header\rbreaker_secret_value"],
  ]) {
    check(`${label} appears in no output, stdout or stderr`, async () => {
      const ok = await mockOkship({ post: [{ status: 202, body: accepted }], poll: [terminal("pass")] });
      try {
        const r = await runAction({ base: ok.base, apiKey: key });
        assert.equal(r.code, 1, r.stdout); // the header is invalid, so the POST never leaves
        assert.equal(ok.posted().length, 0);
        assert.match(r.stdout, /::error::Headers\.append: "\*\*\*" is an invalid header value/);
        assertNoKey(r, key);
      } finally {
        await ok.close();
      }
    });
  }
});
