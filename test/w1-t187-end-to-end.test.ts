import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import { FIXED_NOW_ISO, corpusLedgerPath, loadCorpusGithub, loadCorpusPlan } from "./fixtures/w1-t187/load.js";

/**
 * W1-T187 acceptance criterion 5 — "the measured end-to-end budget is met — first paint to
 * data under 2 seconds, W1-T154's own bar". Proof required: an integration/timing test against
 * a RUNNING SERVER at production corpus scale: GET / and GET /v1/status each return in under
 * 2000ms.
 *
 * FALSIFIER, measured 2026-07-20 pre-fix: GET / at 49.0s cold and 42.6s warm, GET /v1/status at
 * 58.7s/54.0s/34.5s, with connect time 0.0002s and payloads of 78KB/67KB -- entirely server
 * time. This test drives a REAL `buildServeServer` instance (the same assembly `rmd serve`
 * boots) bound to an ephemeral port, over the SAME committed production-scale corpus the other
 * four W1-T187 criteria use, and times real HTTP round-trips against it -- not a unit call.
 */

const READ_TOKEN = "w1-t187-e2e-read-token";
const WRITE_TOKEN = "w1-t187-e2e-write-token";

function fakeTraceGithub(): TraceGithub {
  return { prView: () => null };
}

function fakeIssueCloser(): IssueCloser {
  return { close() {} };
}

test("W1-T187 criterion 5: GET / and GET /v1/status each answer in UNDER 2000ms against a real server over the production-scale corpus", async () => {
  const plan = loadCorpusPlan();
  const github = loadCorpusGithub();
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t187-e2e-"));
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  // GET /v1/trace/GET /v1/drain/preview reload this fresh from disk on every request (their own
  // module header); neither route is exercised here, so an empty plan is sufficient and keeps
  // this test's only source of truth for the corpus itself in ./fixtures/w1-t187.
  writeFileSync(planPath, "[]\n");

  const deps: ServeDeps = {
    board: { plan, ledgerPath: corpusLedgerPath(), github, now: () => Date.parse(FIXED_NOW_ISO) },
    panelGraph: { root, planPath, ledgerPath: corpusLedgerPath(), github: fakeTraceGithub(), statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath: corpusLedgerPath(),
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
  };

  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const shellStart = performance.now();
    const shellRes = await fetch(`${base}/`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    await shellRes.text();
    const shellMs = performance.now() - shellStart;
    assert.equal(shellRes.status, 200);
    assert.ok(shellMs < 2000, `GET / took ${shellMs.toFixed(1)}ms -- must be < 2000ms (pre-fix measured 49.0s cold / 42.6s warm)`);

    const statusStart = performance.now();
    const statusRes = await fetch(`${base}/v1/status`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    const body = (await statusRes.json()) as { tasks: unknown[] };
    const statusMs = performance.now() - statusStart;
    assert.equal(statusRes.status, 200);
    assert.equal(body.tasks.length, plan.tasks.length);
    assert.ok(
      statusMs < 2000,
      `GET /v1/status took ${statusMs.toFixed(1)}ms over ${plan.tasks.length} tasks -- must be < 2000ms (pre-fix measured 58.7s/54.0s/34.5s)`,
    );

    // A second /v1/status request proves the budget holds on a warm server too, not just the
    // very first request after boot.
    const secondStart = performance.now();
    const secondRes = await fetch(`${base}/v1/status`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    await secondRes.text();
    const secondMs = performance.now() - secondStart;
    assert.equal(secondRes.status, 200);
    assert.ok(secondMs < 2000, `second GET /v1/status took ${secondMs.toFixed(1)}ms -- must be < 2000ms`);
  } finally {
    server.close();
  }
});
