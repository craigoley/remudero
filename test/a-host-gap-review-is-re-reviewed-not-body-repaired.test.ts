import assert from "node:assert/strict";
import { test } from "node:test";
import type { FixProgressInput } from "../src/lib/fix-progress-judge.js";
import {
  HOST_GAP_REREVIEW_STEP, DEFAULT_SWEEP_POLICY, cappedProofDiscriminationFromLedger,
  hostGapProblem, hostGapProgressInput, hostGapRereviewFacts, hostGapRereviewWaitMs, isHostGapCriterion, planHostGapRereview, runSweep,
  type HostGapRereviewState, type OpenPrView, type SweepDeps,
} from "../src/lib/sweep.js";

const MIN = 60_000;
const NOW = Date.parse("2026-10-11T12:00:00Z");
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * MIN).toISOString();
const PR_URL = "https://github.com/acme/remudero/pull/10741";
const HEAD = "3fb4aab41";
const DIGEST = "host-gap-input";
const attemptId = (n: number) => `review-PR10741-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const criterion = (n: number, proof_exec: string, proof_skip?: string) => ({
  claim: `claim ${n}`, proof: `unit test: proof ${n}`, met: true, reason: "keyword floor", proof_exec,
  ...(proof_skip !== undefined ? { proof_skip } : {}),
});

const reviewPosted = (criteria: ReturnType<typeof criterion>[], minutesAgo: number, attempt = 0): Record<string, unknown> => ({
  ts: at(minutesAgo), task_id: "W1-T7837", step: "review.posted", pr_url: PR_URL, head_sha: HEAD,
  state: "success", capped: true, plan_only: false,
  run_id: `review-PR10741-${1000 + attempt}`, review_attempt_id: attemptId(attempt), review_input_digest: DIGEST,
  decision_verdict: { state: "success", capped: true, planOnly: false, criteria },
});

const reviewAdmitted = (minutesAgo: number, attempt = 0, hostGap = false): Record<string, unknown> => ({
  ts: at(minutesAgo), task_id: "W1-T7837", step: "sweep.review_admitted", pr_number: 10741, head_sha: HEAD,
  pr_url: PR_URL, review_input_digest: DIGEST, review_attempt_id: attemptId(attempt),
  host_gap_rereview: hostGap, skips: ["runner-absent"],
});

const rereviewRow = (minutesAgo: number, skips: string[]): Record<string, unknown> => ({
  ts: at(minutesAgo), task_id: "W1-T7837", step: HOST_GAP_REREVIEW_STEP, pr_number: 10741,
  pr_url: PR_URL, head_sha: HEAD, review_input_digest: DIGEST, skips,
});

const RUNNER_ABSENT = [
  criterion(1, "not_executable", "runner-absent"),
  criterion(2, "not_executable", "runner-absent"),
  criterion(3, "not_executable", "runner-absent"),
];

const openPr = (): OpenPrView => ({
  prNumber: 10741, prUrl: PR_URL, taskId: "W1-T7837", headSha: HEAD, headRefName: "run-W1-T7837-1",
  checksState: "green", reviewState: "success", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
  lastActivityAt: at(30), ciFailures: [],
  reviewInputDigest: DIGEST,
});

interface Harness { rows: Record<string, unknown>[]; effects: string[]; deps: SweepDeps; judged: FixProgressInput[] }

function harness(rows: Record<string, unknown>[], judge?: SweepDeps["fixProgressJudge"]): Harness {
  const effects: string[] = [];
  const judged: FixProgressInput[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused/host-gap-ledger", runId: "host-gap", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    dispatchFix: () => { effects.push("body"); },
    dispatchPlanOnlyRepair: () => { effects.push("plan"); return true; },
    postReview: (pr) => { effects.push(`review:${pr.prNumber}`); },
    arm: () => { effects.push("arm"); return "armed"; },
    escalate: (_pr, reason) => { effects.push(`escalate:${reason}`); },
    close: () => { effects.push("close"); },
    ...(judge ? { fixProgressJudge: async (input: FixProgressInput) => { judged.push(input); return judge(input); } } : {}),
  };
  return { rows, effects, deps, judged };
}

test("W1-T7837: a capped review whose proofs all hit a host gap is re-reviewed at the same head", async () => {
  // The review took 10m (admitted at -40m, posted at -30m); it is now 30m after the post, past the 10m pace.
  const h = harness([reviewAdmitted(40), reviewPosted(RUNNER_ABSENT, 30)]);
  const result = await runSweep([openPr()], h.deps);
  const action = result.actions[0]!;
  assert.equal(action.disposition, "post-review");
  assert.equal(action.acted, true);
  assert.match(action.reason, /runner-absent|sandbox runner missing/);
  assert.doesNotMatch(action.reason, /repair the PR body/);
  assert.deepEqual(h.effects, ["review:10741"], "one fresh review of the same head, no body or shard repair, no arm");
  const request = h.rows.find((row) => row.step === HOST_GAP_REREVIEW_STEP);
  assert.equal(request?.head_sha, HEAD);
  assert.equal(request?.pr_url, PR_URL);
  assert.deepEqual(request?.skips, ["runner-absent"]);
  assert.equal(result.byDisposition["blocked-fixable"], 0);
});

test("W1-T7837: a stale proof beside a host gap still routes to body repair", async () => {
  const mixed = [criterion(1, "not_executable", "runner-absent"), criterion(2, "executed_stale"),
    criterion(3, "not_executable", "prose-no-match")];
  const h = harness([reviewAdmitted(40), reviewPosted(mixed, 30)]);
  const result = await runSweep([openPr()], h.deps);
  const action = result.actions[0]!;
  assert.equal(action.disposition, "blocked-fixable");
  assert.match(action.reason, /repair the PR body/);
  assert.deepEqual(h.effects, ["body"]);
  assert.equal(h.rows.some((row) => row.step === HOST_GAP_REREVIEW_STEP), false);
});

test("W1-T7837: the ledger evidence keeps the proof skip reason", () => {
  const evidence = cappedProofDiscriminationFromLedger(openPr(), [reviewPosted([
    criterion(1, "not_executable", "runner-absent"), criterion(2, "executed_stale"),
    criterion(3, "not_executable", "cwd-missing"),
  ], 30)]);
  assert.deepEqual(evidence?.proofs.map((proof) => proof.proofSkip), ["runner-absent", undefined, "cwd-missing"]);
  assert.equal("proofSkip" in evidence!.proofs[1]!, false, "a proof with no recorded skip carries no field");
  for (const skip of ["runner-absent", "cwd-missing", "incomplete-run", "runtime-broken", "no-exec-context"]) {
    assert.equal(isHostGapCriterion({ proof_exec: "not_executable", proof_skip: skip }), true, skip);
  }
  for (const exec of ["exec_error", "base_unreadable"]) assert.equal(isHostGapCriterion({ proof_exec: exec }), true, exec);
  for (const skip of ["prose-no-match", "no-dialect", "forward-reference", "proof-form"]) {
    assert.equal(isHostGapCriterion({ proof_exec: "not_executable", proof_skip: skip }), false, skip);
  }
  assert.equal(isHostGapCriterion({ proof_exec: "executed_stale" }), false);
});

test("W1-T7837: host-gap re-reviews are paced from the observed history", async () => {
  // The wait is the observed review duration, grown by each re-review that still graded a gap.
  assert.equal(hostGapRereviewWaitMs(10 * MIN, 0), 10 * MIN);
  assert.equal(hostGapRereviewWaitMs(10 * MIN, 2), 30 * MIN);
  assert.equal(hostGapRereviewWaitMs(4 * MIN, 0), 4 * MIN, "a faster review is paced faster: no fixed interval");

  // The duration comes from the ledger: admission -> review.posted for this head (10m here, 4m below).
  const slow = hostGapRereviewFacts(openPr(), [reviewAdmitted(40), reviewPosted(RUNNER_ABSENT, 30)]);
  const fast = hostGapRereviewFacts(openPr(), [reviewAdmitted(34), reviewPosted(RUNNER_ABSENT, 30)]);
  assert.equal(slow.observedReviewMs, 10 * MIN);
  assert.equal(fast.observedReviewMs, 4 * MIN);

  // 5m after a 10m review's post: held, and the hold names the host gap with no row written and no review run.
  const early = harness([reviewAdmitted(15), reviewPosted(RUNNER_ABSENT, 5)]);
  const held = await runSweep([openPr()], early.deps);
  assert.equal(held.actions[0]!.disposition, "wait");
  assert.match(held.actions[0]!.reason, /host gap/);
  assert.deepEqual(early.effects, []);
  assert.equal(early.rows.some((row) => row.step === HOST_GAP_REREVIEW_STEP), false);

  // The same age admits a faster-reviewing input, and a second gap waits twice as long as the first.
  const quick = harness([reviewAdmitted(9), reviewPosted(RUNNER_ABSENT, 5)]);
  assert.equal((await runSweep([openPr()], quick.deps)).actions[0]!.disposition, "post-review");

  const state: HostGapRereviewState = { history: [{ atMs: NOW - 15 * MIN, skips: ["runner-absent"] }],
    skips: ["runner-absent"], lastReviewAtMs: NOW - 12 * MIN, observedReviewMs: 10 * MIN, nowMs: NOW };
  const input = hostGapProgressInput({ headSha: HEAD }, state);
  const second = await planHostGapRereview(state, { input, judge: async () => ({ verdict: "continue", reason: "ok" }) });
  assert.equal(second.kind, "hold", "12m after the newest review is short of the 2 x 10m the second re-review waits");
  const later = await planHostGapRereview({ ...state, nowMs: NOW + 9 * MIN },
    { input, judge: async () => ({ verdict: "continue", reason: "ok" }) });
  assert.equal(later.kind, "rereview");
});

test("W1-T7837: every host-gap grade names its own host problem", () => {
  const expected: Record<string, string> = {
    "runner-absent": "sandbox runner missing",
    "cwd-missing": "review worktree reclaimed",
    "runtime-broken": "runtime broken",
    "incomplete-run": "runtime broken (run ended without its summary)",
    "no-exec-context": "no PR-head checkout to execute in",
    exec_error: "proof execution threw",
    "exec-error": "proof execution threw",
    base_unreadable: "merge-base checkout unreadable",
  };
  for (const [skip, problem] of Object.entries(expected)) assert.equal(hostGapProblem(skip), problem, skip);
  assert.equal(hostGapProblem("something-new"), "something-new", "an unknown grade is named as itself");
});

test("W1-T7837: a persisting host gap escalates through the fix-progress judge", async () => {
  // Two reviews already ran at this head and graded runner-absent; the second re-review is due.
  const rows = () => [reviewAdmitted(200), reviewPosted(RUNNER_ABSENT, 190),
    rereviewRow(180, ["runner-absent"]), reviewAdmitted(180, 1, true), reviewPosted(RUNNER_ABSENT, 170, 1)];

  const escalating = harness(rows(), async () => ({ verdict: "escalate", loop: "runner never appears",
    reason: "the same skip on every re-review" }));
  const escalated = await runSweep([openPr()], escalating.deps);
  assert.equal(escalating.judged.length, 1);
  assert.equal(escalating.judged[0]!.rounds.length, 1);
  assert.deepEqual(escalating.judged[0]!.currentRed, ["host-gap:runner-absent"]);
  assert.equal(escalating.judged[0]!.rounds[0]!.completed, true);
  assert.equal(escalated.actions[0]!.disposition, "blocked-ambiguous");
  assert.match(escalated.actions[0]!.reason, /runner-absent/);
  assert.match(escalated.actions[0]!.reason, /sandbox runner missing/);
  assert.equal(escalating.effects.filter((effect) => effect.startsWith("escalate:")).length, 1);
  assert.equal(escalating.effects.some((effect) => effect === "review:10741" || effect === "body"), false);
  assert.equal(escalating.rows.filter((row) => row.step === HOST_GAP_REREVIEW_STEP).length, 1,
    "no further re-review is requested once the judge escalates");
  assert.equal(escalating.rows.find((row) => row.step === "fix.progress_judged")?.site, "host-gap-rereview");

  const continuing = harness(rows(), async () => ({ verdict: "continue", reason: "the host may recover" }));
  const resumed = await runSweep([openPr()], continuing.deps);
  assert.equal(resumed.actions[0]!.disposition, "post-review");
  assert.deepEqual(continuing.effects, ["review:10741"]);
  assert.equal(continuing.rows.filter((row) => row.step === HOST_GAP_REREVIEW_STEP).length, 2);

  const unavailable = harness(rows(), async () => undefined);
  const held = await runSweep([openPr()], unavailable.deps);
  assert.equal(held.actions[0]!.disposition, "wait");
  assert.deepEqual(unavailable.effects, []);
});
