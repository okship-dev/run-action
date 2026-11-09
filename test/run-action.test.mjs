// Local tests for the BUILT action (dist/index.js), run as a child process the
// way the Actions runner runs it: inputs as INPUT_* env vars, outputs written to
// the file named by GITHUB_OUTPUT. A small mock HTTP server stands in for
// OKShip. Real timings, no test-only switches in the action: the cases run
// concurrently, so the suite takes about as long as its slowest case.
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
const API_KEY = "ok_live_TESTKEY_never_printed_0123456789";
const APP_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

const accepted = { run_id: RUN_ID, status: "pending", scenario_count: 2, uses_byok: true, overage_units: 0 };

// A mock OKShip. `script.post` and `script.poll` are arrays of responses served
// in order (the last one repeats). Every request is recorded.
async function mockOkship(script) {
  const requests = [];
  let posts = 0;
  let polls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      let r;
      if (req.method === "POST" && req.url === "/api/runs") {
        r = script.post[Math.min(posts++, script.post.length - 1)];
      } else if (req.method === "GET" && req.url === `/api/runs/${RUN_ID}/status`) {
        r = script.poll[Math.min(polls++, script.poll.length - 1)];
      } else {
        r = { status: 404, body: { error: "not_found" } };
      }
      res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

function runAction({ base, extraEnv = {}, nodeArgs = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "okship-run-action-"));
  const outputFile = path.join(dir, "output");
  fs.writeFileSync(outputFile, "");
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot ?? "",
    GITHUB_OUTPUT: outputFile,
    INPUT_API_KEY: API_KEY,
    INPUT_APP_ID: APP_ID,
    INPUT_WAIT_FOR_COMPLETION: "true",
    ...(base ? { INPUT_OKSHIP_API_BASE: base } : {}),
    ...extraEnv,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...nodeArgs, DIST], { env });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stdout += c));
    child.on("close", (code) => {
      const outputs = {};
      const text = fs.readFileSync(outputFile, "utf8");
      const re = /^(\w+)<<(\S+)\r?\n([\s\S]*?)\r?\n\2$/gm;
      for (const m of text.matchAll(re)) outputs[m[1]] = m[3];
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code, stdout, outputs });
    });
  });
}

// One PASS/FAIL line per case, and never the key.
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

function assertNoKey(stdout) {
  assert.ok(!stdout.includes(API_KEY), "the API key appeared in the action's log");
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
        assertNoKey(r.stdout);
      } finally {
        await ok.close();
      }
    });
  }

  check("held run: polls through in-flight, stops on complete with no verdict, warns, sets no verdict", async () => {
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
      assert.match(r.stdout, /::warning::.*holding its verdict for review/);
      assert.equal(ok.requests.filter((q) => q.method === "GET").length, 2);
      assertNoKey(r.stdout);
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

  check("503 admission_busy with Retry-After is retried, then succeeds", async () => {
    const busy = {
      status: 503,
      headers: { "retry-after": "1" },
      body: { error: "admission_busy", message: "busy" },
    };
    const ok = await mockOkship({
      post: [busy, { status: 202, body: accepted }],
      poll: [terminal("pass")],
    });
    try {
      const t0 = Date.now();
      const r = await runAction({ base: ok.base });
      assert.equal(r.code, 0, r.stdout);
      assert.equal(ok.requests.filter((q) => q.method === "POST").length, 2);
      assert.match(r.stdout, /503 admission_busy\)\. Retry 1 of 3 in 1s/);
      assert.equal(r.outputs.verdict, "pass");
      assert.ok(Date.now() - t0 >= 1000, "Retry-After was not honoured");
      assertNoKey(r.stdout);
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
      assert.equal(ok.requests.filter((q) => q.method === "POST").length, 4);
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
      assert.equal(ok.requests.filter((q) => q.method === "POST").length, 1);
      assert.match(r.stdout, /::error::POST .* returned 500/);
      assertNoKey(r.stdout);
    } finally {
      await ok.close();
    }
  });

  check("503 that is NOT admission_busy is NOT retried", async () => {
    const ok = await mockOkship({ post: [{ status: 503, headers: { "retry-after": "1" }, body: { error: "unavailable" } }], poll: [terminal("pass")] });
    try {
      const r = await runAction({ base: ok.base });
      assert.equal(r.code, 1, r.stdout);
      assert.equal(ok.requests.filter((q) => q.method === "POST").length, 1);
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
      const r = await runAction({
        base: null,
        nodeArgs: ["--require", RECORDER],
        extraEnv: { FETCH_RECORD_PATH: record },
      });
      const urls = fs.readFileSync(record, "utf8").trim().split("\n");
      assert.deepEqual(urls, ["https://okship.dev/api/runs"]);
      assert.equal(r.code, 1, r.stdout); // the recorder answers 401
      assert.match(r.stdout, /invalid_api_key/);
      assertNoKey(r.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
