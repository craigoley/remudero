// W1-T4771: /v1/status measured 22.4 s on 2026-09-29 and still said "fresh". The 750 ms budget is a timer race, and
// a timer cannot fire while a synchronous gh child holds serve's loop. These tests drive the REAL serve assembly
// over a REAL batched gateway whose gh binary hangs, so the budget and the facts' label are measured end to end.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import type { IssueCloser } from "../src/lib/panel-actions.js";
import { buildServeServer, CONSOLE_READ_ROUTE_BUDGET_MS, type ServeDeps } from "../src/lib/serve.js";
import { buildBatchedGithub, type GitHub } from "../src/lib/status.js";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";

const GH_HANG_S = 4;

function hangableGh(dir: string, hangFlag: string): string {
  const script = `#!/usr/bin/env bash
if [[ -e "${hangFlag}" ]]; then sleep ${GH_HANG_S}; fi
args="$*"
if [[ "$args" == *"state=open"* ]]; then
  echo '[{"number":7,"html_url":"https://github.com/o/r/pull/7","state":"open","merged":false,"body":"","updated_at":"2026-09-24T00:00:00Z","head":{"ref":"run-unfiled-1","sha":"abc"},"auto_merge":null,"title":"an open pr"}]'
elif [[ "$args" == *"/commits/"*"/status"* ]]; then
  echo '{"state":"success","statuses":[]}'
else
  echo '[]'
fi
`;
  const path = join(dir, "hangable-gh");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function serveDeps(root: string, github: GitHub): ServeDeps {
  const stateDir = join(root, "state");
  const planDir = join(root, "plan");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(planDir, { recursive: true });
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const planPath = join(planDir, "tasks.yaml");
  writeFileSync(ledgerPath, "");
  writeFileSync(planPath, "[]\n");
  const issues: IssueCloser = { close: () => {} };
  return {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath,
    issues,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "read-token", write: "write-token" },
    consoleSha: "aaaaaaaa",
    analytics: { readSnapshot: () => new Promise(() => {}) },
  };
}

async function settled(gh: GitHub): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (gh.readState?.() === "in_flight") {
    if (performance.now() >= deadline) throw new Error("the gateway's walk never landed");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

test("serve assembly switches its board gateway to off-loop reads", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-serve-offloop-wiring-"));
  let switched = 0;
  const github: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined, serveOffLoop: () => { switched += 1; } };
  const server = buildServeServer(serveDeps(root, github));
  try {
    assert.equal(switched, 1, "serve must put its own board gateway in off-loop mode exactly once");
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hung gh leaves /v1/status inside its budget with its github facts labelled stale", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-serve-hung-gh-"));
  const hangFlag = join(root, "gh-hangs");
  const ttlMs = 300;
  const github = buildBatchedGithub("o", "r", { ghBin: hangableGh(root, hangFlag), ttlMs });
  const server = buildServeServer(serveDeps(root, github));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { authorization: "Bearer read-token" };

    github.warm?.();
    await settled(github);
    assert.equal(github.listOpenHeadBranches?.()?.length, 1, "a positive control: the first walk landed one open PR");

    writeFileSync(hangFlag, "");
    await new Promise((resolve) => setTimeout(resolve, ttlMs + 100));
    const started = performance.now();
    const res = await fetch(`${base}/v1/status`, { headers });
    const elapsedMs = performance.now() - started;
    const body = (await res.json()) as { github_facts_age_ms?: number; github_facts_status?: string; staleness?: { status?: string } };

    assert.equal(res.status, 200);
    assertWallClockBound(elapsedMs, CONSOLE_READ_ROUTE_BUDGET_MS + 250, "/v1/status must answer inside its budget while gh hangs");
    assert.ok((body.github_facts_age_ms ?? -1) >= ttlMs, `the facts' age must be their real age, got ${body.github_facts_age_ms}`);
    assert.equal(body.github_facts_status, "stale", "github facts past their TTL are never labelled fresh");
  } finally {
    server.close();
    if (existsSync(hangFlag)) rmSync(hangFlag);
    rmSync(root, { recursive: true, force: true });
  }
});
