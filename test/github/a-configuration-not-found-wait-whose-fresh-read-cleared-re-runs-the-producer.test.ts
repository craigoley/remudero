// W1-T13787 — PR 19489's security-merge-policy status read `unknown: codeql-configuration-not-found` for 58 minutes after
// GitHub had re-judged its CodeQL check in place: no event ran the trusted producer again. When the sweep's fresh security
// read at the same head no longer shows the warning, it dispatches the producer once for that head. It never writes the
// status itself: the producer re-derives the decision from trusted metadata.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import * as sweep from "#src/lib/sweep.js";
import type { OpenPrView, SecurityMergeObservation, SweepDeps } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const REASON = "codeql-configuration-not-found";
const STEP = "security.producer_redispatched";
const HEAD = "41a67e1c0ffee0000000000000000000000000aa";
const NEXT = "52b78f2c0ffee0000000000000000000000000bb";
const PR = 19489;
const TASK = "W1-T13787";
const PR_URL = `https://github.com/craigoley/remudero/pull/${PR}`;
const T1 = "2026-11-18T20:20:41Z";
const CLEARED: SecurityMergeObservation = { headSha: HEAD, decision: { state: "safe", mergeAllowed: true, reason: "no-new-high-or-critical-alert" },
  observation: { latest: { id: 3 } } };
const WARNING = { checkId: 2, headSha: HEAD, completedAt: T1, conclusion: "neutral", title: "1 configuration not found",
  summary: null, summarySha256: null, truncated: false, alertsLink: null };
const STILL_WARNS: SecurityMergeObservation = { headSha: HEAD, decision: { state: "unknown", mergeAllowed: false, reason: REASON },
  observation: { latest: { id: 2 }, configurationWarning: WARNING } };

const ROOT = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t13787-`));
after(() => rmSync(ROOT, { recursive: true, force: true }));

function view(over: Partial<OpenPrView> = {}): OpenPrView {
  return { prNumber: PR, prUrl: PR_URL, taskId: TASK, reviewState: "none", checksState: "red", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: T1, headSha: HEAD, headRefName: `run-${TASK}-1795067238000`, autoMergeArmed: false,
    ciFailures: [{ name: "security-merge-policy", logTail: "" }],
    securityMergePolicy: { state: "unknown", reason: REASON }, ...over };
}

/** A sweep pass's deps: every arm effect that could act on GitHub fails the test; the security seams record. */
function harness(prior: Record<string, unknown>[], answer: () => Promise<SecurityMergeObservation>,
  dispatch: (pr: OpenPrView) => Promise<void> = async () => {}) {
  const rows: Record<string, unknown>[] = [];
  const dispatched: number[] = [];
  const forbidden = (what: string) => () => assert.fail(`a configuration-not-found wait never ${what}`);
  const deps: SweepDeps = {
    arm: forbidden("arms"), close: forbidden("closes"), dispatchFix: forbidden("dispatches a fix round"),
    postReview: forbidden("posts a review status"), updateBranch: forbidden("updates the branch"),
    requeueCheck: forbidden("re-runs a check"), rerunFailedChecks: forbidden("re-runs failed checks"),
    readyDraft: forbidden("readies a draft"), disarmAutoMerge: forbidden("disarms"), escalate: forbidden("escalates"),
    readSecurityMergeObservation: answer,
    readCodeqlWorkflowRuns: async () => ({ workflow_runs: [] }),
    dispatchSecurityMergeProducer: async (pr) => { dispatched.push(pr.prNumber); await dispatch(pr); },
    ledgerPath: "/nonexistent/rmd-w1-t13787/rows.ndjson", runId: "SWEEP-13787", now: () => Date.parse(T1) + 3_600_000,
    readLedger: () => [...prior, ...rows], appendLine: (_path, row) => { rows.push(row); },
    log: (step, extra = {}) => { rows.push({ run_id: "SWEEP-13787", step, ...extra }); },
  };
  return { deps, rows, dispatched };
}

test("W1-T13787 criterion 1: a cleared fresh read at the same head dispatches the producer once and writes one row", async () => {
  const h = harness([], async () => CLEARED);
  const reason = await sweep.observeCodeqlConfigurationWarning(h.deps, [], view(), "wait");
  assert.deepEqual(h.dispatched, [PR]);
  assert.deepEqual(h.rows, [{ run_id: "SWEEP-13787", task_id: TASK, pr_number: PR, pr_url: PR_URL, head_sha: HEAD, step: STEP,
    decision: "safe: no-new-high-or-critical-alert", posted_status: `unknown: ${REASON}` }]);
  assert.match(reason, /^wait — the fresh read answers safe: no-new-high-or-critical-alert, so the security-merge-policy producer was dispatched once for this head$/);
});

test("W1-T13787 criterion 2: the producer is re-run at most once per head, and a new head is re-run again", async () => {
  const first = harness([], async () => CLEARED);
  await sweep.observeCodeqlConfigurationWarning(first.deps, [], view(), "wait");
  const ledger = [...first.rows];
  const again = harness(ledger, async () => CLEARED);
  const reason = await sweep.observeCodeqlConfigurationWarning(again.deps, ledger, view(), "wait");
  assert.deepEqual([again.dispatched.length, again.rows.length], [0, 0]);
  assert.match(reason, /the security-merge-policy producer was already re-run at this head/);

  const moved = harness(ledger, async () => ({ ...CLEARED, headSha: NEXT }));
  await sweep.observeCodeqlConfigurationWarning(moved.deps, ledger, view({ headSha: NEXT }), "wait");
  assert.deepEqual(moved.dispatched, [PR], "a new head is its own dispatch");
  assert.deepEqual(moved.rows.map((r) => [r.step, r.head_sha]), [[STEP, NEXT]]);
  const otherPr = harness(ledger, async () => CLEARED);
  await sweep.observeCodeqlConfigurationWarning(otherPr.deps, ledger, view({ prNumber: PR + 1 }), "wait");
  assert.deepEqual(otherPr.dispatched, [PR + 1], "another PR at the same head is not covered by this PR's row");
});

test("W1-T13787 criterion 3: no dispatch without a cleared read at this head; a failed dispatch is written once and keeps the wait", async () => {
  for (const [why, answer] of [
    ["the warning still stands", async () => STILL_WARNS],
    ["the reason still reads configuration-not-found", async () => ({ ...CLEARED, decision: { state: "unknown", mergeAllowed: false, reason: REASON } })],
    ["the read answered another head", async () => ({ ...CLEARED, headSha: NEXT })],
    ["the read failed", async () => { throw new Error("HTTP 502"); }],
  ] as Array<[string, () => Promise<SecurityMergeObservation>]>) {
    const h = harness([], answer);
    await sweep.observeCodeqlConfigurationWarning(h.deps, [], view(), "wait");
    assert.equal(h.dispatched.length, 0, why);
    assert.equal(h.rows.filter((r) => r.step === STEP).length, 0, why);
  }

  const refused = harness([], async () => CLEARED, async () => { throw new Error("HTTP 422 workflow not dispatchable"); });
  await sweep.runSweep([view()], refused.deps);
  assert.deepEqual(refused.dispatched, [PR]);
  assert.equal(refused.rows.filter((r) => r.step === STEP).length, 1, "the row is written before the dispatch");
  assert.equal(refused.rows.some((r) => String(r.step).startsWith("fix.") || r.step === "sweep.fix_dispatch"), false, "no fix round row");
  const disposed = refused.rows.filter((r) => r.step === "sweep.disposed");
  assert.equal(disposed.length, 1);
  assert.deepEqual([disposed[0]!.disposition, disposed[0]!.acted, disposed[0]!.blocker], ["wait", false, "security-unknown-hold"]);
  assert.match(String(disposed[0]!.reason), /the producer dispatch failed \(HTTP 422 workflow not dispatchable\) and is not repeated at this head/);
  const retry = harness(refused.rows, async () => CLEARED);
  await sweep.observeCodeqlConfigurationWarning(retry.deps, refused.rows, view(), "wait");
  assert.equal(retry.dispatched.length, 0, "a failed dispatch is not retried at this head");
});

test("W1-T13787 criterion 4: the production effects dispatch security-merge-policy.yml on main with the pr_number input", async () => {
  const calls: string[][] = [];
  const effects = sweep.buildSweepEffects({ owner: "craigoley", repo: "remudero", config: { claudeBin: "/usr/bin/true", root: ROOT } as never,
    ledgerPath: join(ROOT, "ledger.ndjson"), runId: "SWEEP-13787", plan: { tasks: [] } as never, log: () => {},
    ghRunImpl: (file, args) => { calls.push([file, ...args]); } });
  const h = harness([], async () => CLEARED);
  const deps = { ...h.deps, dispatchSecurityMergeProducer: effects.dispatchSecurityMergeProducer } as SweepDeps;
  await sweep.observeCodeqlConfigurationWarning(deps, [], view(), "wait");
  assert.deepEqual(calls, [["gh", "api", "-X", "POST", "repos/craigoley/remudero/actions/workflows/security-merge-policy.yml/dispatches",
    "-f", "ref=main", "-f", `inputs[pr_number]=${PR}`]]);
  assert.equal(h.rows.filter((r) => r.step === STEP).length, 1);
});
