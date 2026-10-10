/**
 * Once the W1-T7096 progress judge has ruled on a PR's fix lane, the sweep's disposition reason names
 * the judge's round and verdict. The former "strike n/2" ratio stays only for a lane no judge has ruled
 * on (test fixtures), so an operator or gardener reading the board never sees a stale fixed ceiling.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as sweep from "../src/lib/sweep.js";
import type { OpenPrView, SweepDeps } from "../src/lib/sweep.js";

const NOW = Date.parse("2026-10-10T03:00:00Z");
const RECENT = "2026-10-10T02:50:00Z";

function pr(over: Partial<OpenPrView> & Record<string, unknown> = {}): OpenPrView {
  return {
    prNumber: 10516,
    prUrl: "https://github.com/craigoley/remudero/pull/10516",
    taskId: "W1-TJUDGED",
    reviewState: "pending",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 1,
    lastActivityAt: RECENT,
    headSha: "443ade0aa",
    autoMergeArmed: false,
    ...over,
  } as OpenPrView;
}

const judged = { round: 3, verdict: "continue", reason: "each round changed the red set" };

test("a judged red fix lane's reason names the judge's round and verdict, not a strike ratio", () => {
  const result = sweep.deriveDisposition(pr({ lastProgressJudgement: judged }), sweep.DEFAULT_SWEEP_POLICY, NOW);
  assert.match(result.reason, /fix round 4 — judge: continue \(each round changed the red set\)/);
  assert.doesNotMatch(result.reason, /strike \d+\/\d+/);
});

test("a judged review-failed lane names the judge's round after its unmet criteria", () => {
  const result = sweep.deriveDisposition(pr({
    checksState: "green",
    reviewState: "failure",
    unmetCriteria: [{ claim: "c", proof: "unit test: t", met: false, reason: "r", proof_exec: "executed_fail" }],
    lastProgressJudgement: judged,
  }), sweep.DEFAULT_SWEEP_POLICY, NOW);
  assert.match(result.reason, /1 unmet criterion — fix round 4 — judge: continue/);
  assert.doesNotMatch(result.reason, /strike \d+\/\d+/);
});

test("the sweep labels a PR from its newest fix.progress_judged ledger row", async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-judge-label-")), "ledger.ndjson");
  const rows = [
    { ts: "2026-10-10T02:30:00Z", step: "fix.progress_judged", pr_number: 10516, round_count: 2, verdict: "continue", reason: "older ruling" },
    { ts: "2026-10-10T02:55:00Z", step: "fix.progress_judged", pr_number: 10516, round_count: 3, verdict: "continue", reason: "each round changed the red set" },
    { ts: "2026-10-10T02:56:00Z", step: "fix.progress_judged", pr_number: 9999, round_count: 7, verdict: "escalate", reason: "another PR" },
  ];
  writeFileSync(ledgerPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath, runId: "SWEEP-JUDGE-LABEL", now: () => NOW,
    fixProgressJudge: async () => ({ verdict: "continue", reason: "fixture" }),
  };
  await sweep.runSweep([pr()], deps);
  const disposed = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((r) => r.step === "sweep.disposed" && r.pr_number === 10516);
  assert.ok(disposed.length > 0, "the sweep disposed the PR");
  assert.match(disposed.at(-1).reason, /fix round 4 — judge: continue \(each round changed the red set\)/);
});

test("a lane no judge has ruled on keeps the former strike ratio as its stand-in label", () => {
  const result = sweep.deriveDisposition(pr(), sweep.DEFAULT_SWEEP_POLICY, NOW);
  assert.match(result.reason, /strike 2\/2/);
});
