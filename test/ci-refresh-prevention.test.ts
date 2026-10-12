import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CI_REFRESH_GUARD_VERSION, observeCiRefreshDeferrals } from "../src/lib/ci-refresh-prevention.js";
import { meaningOfStep } from "../src/lib/ledger-steps.js";
import type { LedgerLine } from "../src/lib/ledger.js";
import { DEFAULT_SWEEP_POLICY, runSweep, selectUpdateBranchDecision, selectUpdateBranchTarget,
  type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";

const NOW = Date.parse("2026-10-08T12:00:00.000Z"), ASOF = new Date(NOW).toISOString();
const START = new Date(NOW - 86_400_000).toISOString();
const POLICY = { ...DEFAULT_SWEEP_POLICY, reviewWaitingBranchRefreshEnabled: true,
  reviewWaitingBranchRefreshThreshold: 10 };
const A = "a".repeat(40), B = "b".repeat(40);
function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return { prNumber: 9993, prUrl: "https://github.com/craigoley/remudero/pull/9993", headSha: A,
    reviewState: "success", checksState: "pending", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: new Date(NOW - 30 * 60_000).toISOString(), autoMergeArmed: false,
    mergeState: "clean", changedFiles: ["src/mine.ts"], ...over };
}
function decision(views: OpenPrView[], inFlight = new Set<string>(), behind = 30) {
  return selectUpdateBranchDecision(views, NOW, inFlight, new Map(), new Set(),
    new Map(views.map(p => [p.prNumber, behind])), POLICY, new Set(), new Map());
}
function receipt(over: Record<string, unknown> = {}) {
  return { run_id: "test-run", ts: new Date(NOW - 1000).toISOString(),
    sweep_input_as_of: new Date(NOW - 2000).toISOString(), step: "sweep.update_branch.pending_guard",
    pr_number: 9993, pr_url: "https://github.com/craigoley/remudero/pull/9993", head_sha: A,
    guard_version: CI_REFRESH_GUARD_VERSION, outcome: "guarded", evidence: "sweep-input-snapshot",
    counterfactual_selected_without_pending_guard: true, selected_refresh_head: null,
    update_reason: "distance-unknown", ...over };
}

test("pending guard evidence requires a real otherwise eligible oldest candidate and preserves actual selection", () => {
  const pending = pr(), completed = pr({ prNumber: 9994, prUrl: "https://github.com/craigoley/remudero/pull/9994",
    headSha: B, checksState: "green", lastActivityAt: new Date(NOW - 20 * 60_000).toISOString() });
  const observed = decision([pending, completed]);
  assert.equal(observed.pendingGuard?.headSha, A);
  assert.equal(observed.target?.headSha, B);
  assert.equal(selectUpdateBranchTarget([pending, completed], NOW, new Set(), new Map(), new Set(),
    new Map([[9993, 30], [9994, 30]]), POLICY, new Set(), new Map())?.headSha, B);
  assert.equal(decision([pending]).target, undefined);
  assert.equal(decision([pending]).pendingGuard?.headSha, A);
  for (const view of [pr({ isDraft: true }), pr({ headRefName: "run-W1-T9993-123" }), pr({ checksState: "none" })]) {
    assert.equal(decision([view], new Set(["W1-T9993"])).pendingGuard, undefined);
  }
  assert.equal(decision([pending], new Set(), 0).pendingGuard, undefined);
  const older = { ...completed, lastActivityAt: new Date(NOW - 40 * 60_000).toISOString() };
  assert.equal(decision([pending, older]).pendingGuard, undefined, "an eligible pending head that would not win is not a deferred refresh");
  assert.deepEqual(decision([]), { target: undefined });
});

test("the shipped sweep writes one actual pending guard counterfactual and keeps the next completed refresh moving", async () => {
  const rows: LedgerLine[] = [], updates: string[] = [];
  const pending = pr(), completed = pr({ prNumber: 9994, prUrl: "https://github.com/craigoley/remudero/pull/9994",
    headSha: B, checksState: "green", lastActivityAt: new Date(NOW - 20 * 60_000).toISOString() });
  const deps: SweepDeps = { arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath: "/tmp/rmd-ci-guard-evidence-synthetic.ndjson", runId: "guard-test", now: () => NOW,
    readLedger: () => rows.slice(), appendLine: (_path, row) => rows.push({ ...row, ts: ASOF }),
    behindMainByPr: new Map([[9993, 30], [9994, 30]]), baseChangedFilesByPr: new Map(),
    updateBranch: candidate => { updates.push(candidate.headSha); return "updated"; } };
  await runSweep([pending, completed], deps, POLICY);
  const guarded = rows.filter(r => r.step === "sweep.update_branch.pending_guard");
  assert.equal(guarded.length, 1);
  assert.equal(guarded[0].head_sha, A);
  assert.equal(guarded[0].sweep_input_as_of, ASOF);
  assert.equal(guarded[0].selected_refresh_head, B);
  assert.equal(guarded[0].counterfactual_selected_without_pending_guard, true);
  assert.deepEqual(updates, [B]);
  assert.equal(observeCiRefreshDeferrals(guarded, ASOF, START).uniqueDeferredHeads, 1);
  await runSweep([pending], deps, POLICY);
  assert.equal(rows.filter(r => r.step === "sweep.update_branch.pending_guard").length, 1);
  assert.deepEqual(updates, [B]);
});

test("CI refresh observations deduplicate raw rows and heads, qualify repositories and leave savings unavailable", () => {
  const original = receipt();
  const observed = observeCiRefreshDeferrals([original, original, receipt({ run_id: "second-run" }),
    receipt({ pr_url: "https://github.com/craigoley/remudero-site/pull/9993" })], ASOF, START);
  assert.equal(observed.uniqueDeferredHeads, 2);
  assert.equal(observed.duplicateRows, 1);
  assert.equal(observed.repeatedHeadObservations, 1);
  assert.equal(observed.savedCiRuns, null);
  assert.equal(observed.savedCpuSeconds, null);
  assert.equal(observed.savedCashUsd, null);
  assert.equal(observed.historyCompleteness, "uncertified");
  assert.equal(observed.liveCiState, "not-proven-by-input-snapshot");
  assert.equal(observed.efficacyClaim, "none");
});

test("missing, future, unknown-version and unqualified CI deferrals cannot become a measured zero or savings", () => {
  const invalid = [receipt({ guard_version: "unknown" }), receipt({ selected_refresh_head: A }),
    receipt({ counterfactual_selected_without_pending_guard: false }), receipt({ pr_number: 9994 }),
    receipt({ head_sha: "unknown" }), receipt({ run_id: "" }), receipt({ update_reason: "unrelated" }),
    receipt({ ts: new Date(NOW + 1000).toISOString() }), receipt({ sweep_input_as_of: new Date(NOW).toISOString() })];
  const result = observeCiRefreshDeferrals(invalid, ASOF, START);
  assert.equal(result.invalidRows, invalid.length);
  assert.equal(result.uniqueDeferredHeads, null);
  assert.equal(result.state, "unavailable");
  assert.equal(observeCiRefreshDeferrals([receipt({ step: "sweep.disposed" }), receipt({ ts: new Date(NOW - 90_000_000).toISOString(), sweep_input_as_of: new Date(NOW - 90_001_000).toISOString() })], ASOF, START).uniqueDeferredHeads, null);
  assert.equal(observeCiRefreshDeferrals([receipt(), ...invalid], ASOF, START).state, "observed-partial");
  assert.throws(() => observeCiRefreshDeferrals([], "invalid", START));
  assert.throws(() => observeCiRefreshDeferrals([], START, ASOF));
  assert.throws(() => observeCiRefreshDeferrals(Array(100_001).fill({}), ASOF, START));
});

test("the actual daily CLI retains CI guard decisions in its existing bounded source and reports no causal savings", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-ci-deferrals-"));
  try {
    const state = join(root, "state"), out = join(root, "out");mkdirSync(state, { mode: 0o700 });
    const now = Date.now();
    const row = receipt({ ts: new Date(now - 1000).toISOString(), sweep_input_as_of: new Date(now - 2000).toISOString() });
    writeFileSync(join(state, "ledger.ndjson"), JSON.stringify(row) + "\n", { mode: 0o600 });
    const env = { ...process.env };
    for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "AZURE_API_KEY"]) delete env[key];
    const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/private-routing-daily-review.mjs",
      "--source", "core=" + state, "--out-dir", out], { cwd: join(import.meta.dirname, ".."), env, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const saved = JSON.parse(readFileSync(join(out, "latest.json"), "utf8"));
    const metric = saved.sources[0].selfImprovement.ciRefreshDeferrals;
    assert.equal(metric.uniqueDeferredHeads, 1);
    assert.equal(metric.savedCiRuns, null);
    assert.equal(metric.efficacyClaim, "none");
    assert.equal(saved.sources[0].selfImprovement.sourceComplete, false);
    assert.equal(saved.routingChanged, false);
    assert.equal(saved.comparativeClaims, "none");
    assert.match(meaningOfStep("sweep.update_branch.pending_guard")!.meaning, /no saved run/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
