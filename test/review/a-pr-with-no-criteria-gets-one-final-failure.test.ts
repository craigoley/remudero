/**
 * W1-T14826: a code PR whose body named no task and no acceptance criteria got five required-semantic review runs
 * (craigoley/remudero-ops#706, 2026-11-25), each ending `review.semantic_incomplete` with reason
 * `required-semantic-not_attempted`: no reviewer is dispatched without criteria, the bare `not_attempted` outcome was
 * read as an unavailable evaluator, and the withheld verdict left the head pending for the sweep to re-admit. Such a
 * PR now posts the floor's no-criteria FAILURE once, under its own reviewer outcome, and names the remedy. Every PR
 * with criteria and every plan-only PR is classified exactly as before.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Config } from "#src/lib/config.js";
import type { ReviewCommandHost } from "#src/cli/commands/review.js";
import { runReview } from "#src/cli/commands/review.js";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { classifyReviewOutcome, type ReviewReplayInput } from "#src/lib/review-outcome-class.js";
import { NO_CRITERIA_FAIL_SUMMARY, NO_CRITERIA_REVIEWER_OUTCOME, requiredSemanticRefusal } from "#src/lib/required-semantic-review.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const HEAD = "a".repeat(40);
const PR = "https://github.com/acme/remudero/pull/706";
const CODE_DIFF = [
  "diff --git a/src/lib/widget.ts b/src/lib/widget.ts",
  "--- a/src/lib/widget.ts",
  "+++ b/src/lib/widget.ts",
  "@@ -1,1 +1,1 @@",
  "-export const widget = 1;",
  "+export const widget = 2;",
  "",
].join("\n");
const PLAN_DIFF = [
  "diff --git a/plan/tasks.d/W1-T9999-x.yaml b/plan/tasks.d/W1-T9999-x.yaml",
  "--- a/plan/tasks.d/W1-T9999-x.yaml",
  "+++ b/plan/tasks.d/W1-T9999-x.yaml",
  "@@ -1,2 +1,2 @@",
  " - id: W1-T9999",
  "-  title: previous filing",
  "+  title: revised filing",
  "",
].join("\n");
const LINT = { ran: true as const, label: "fixture", checked: 1, violations: [] };

function unexpectedReviewDependency(): never { throw new Error("unexpected review fixture dependency"); }
const HOST: ReviewCommandHost = {
  GIT_UNTRACKED_FILES_ALL: "--untracked-files=all",
  JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
  acceptedReviewAttemptId: (value) => typeof value === "string" ? value : undefined,
  attributeWorkerStreamEvent: unexpectedReviewDependency,
  ledgeredNonDispatchSpawn: unexpectedReviewDependency,
  lintPlanForReview: unexpectedReviewDependency,
  liveWorkerRunIds: new Set<string>(),
  materializeReviewWorktree: unexpectedReviewDependency,
  readHeadShaRest: () => HEAD,
  readMainPlanTreeSha: unexpectedReviewDependency,
  realDeps: () => ({ reviewWorktree: { fetch: unexpectedReviewDependency } }) as unknown as ReturnType<ReviewCommandHost["realDeps"]>,
  reviewPostedDescription: (verdict) => verdict.summary,
  reviewWorkerLockId: (runId) => runId,
  reviewerClockBoundMs: unexpectedReviewDependency,
  reviewSubjectGit: unexpectedReviewDependency,
};

/** One real required-semantic runReview over a scripted `gh`, with no reviewer able to spawn: what it returns, the
 *  ledger it wrote, and every `gh` call it made. */
async function drive(t: TestContext, diff: string, body: string) {
  const root = ownedFixtureDir(t, "no-criteria-review").dir;
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const shim = ghShim([
    { when: "/statuses?", stdout: "[[]]" },
    { when: "api repos/", stdout: JSON.stringify({ number: 706, html_url: PR, updated_at: "t", body, head: { ref: "fix/no-task", sha: HEAD }, state: "open" }) },
    { when: "pr diff", stdout: diff },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
  ], { kind: "no-criteria-review" });
  const prior = process.env.PATH;
  process.env.PATH = `${shim.dir}:${prior}`;
  try {
    const result = await runReview(HOST, {
      owner: "acme", repo: "remudero", prUrl: PR, headRefName: "fix/no-task",
      task: { id: "PR-706", acceptance: [], files: [], risk: "medium", budget_usd: 1 }, report: body,
      settingsFile: "", config: { root, claudeBin: "/bin/true" } as Config,
      log: (step: string, extra: Record<string, unknown> = {}) => appendLedger(ledgerPath, { run_id: "R1", task_id: "PR-706", step, ...extra }),
      say: () => undefined, account: (r: unknown) => r,
      requireSemanticReview: true,
      reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 } as never,
      lintPlanForReviewFn: async () => LINT,
      ledgerPath, runId: "R1",
      arm: () => "no-task-id", disarm: () => "not-armed",
    } as never);
    return { result, rows: readLedgerLines(ledgerPath), calls: shim.calls() };
  } finally {
    if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior;
  }
}

test("W1-T14826 criterion 1: a zero-criteria code PR under required semantic review posts one failure naming the cause, not a withheld verdict", async t => {
  const { result, rows, calls } = await drive(t, CODE_DIFF, "Fixes the widget.\n");
  assert.equal(result.reviewerOutcome, NO_CRITERIA_REVIEWER_OUTCOME, `${result.summary} | ${result.verdictWithheld ?? ""}`);
  assert.equal(result.state, "failure", result.summary);
  assert.equal(result.verdictWithheld, undefined, "a missing criterion is a final failure, never a withheld one");
  assert.equal(result.summary, NO_CRITERIA_FAIL_SUMMARY);
  assert.match(result.summary, /Task: \/ Remudero-Task:/);
  assert.ok(result.summary.length <= 140, "the summary is the status description, which GitHub caps at 140 characters");
  assert.ok(!rows.some(row => row.step === "review.semantic_incomplete"), "no withheld row for the sweep to re-run");
  const posted = rows.filter(row => row.step === "review.posted");
  assert.equal(posted.length, 1, rows.map(row => row.step).join(","));
  assert.equal(posted[0]!.state, "failure");
  assert.equal(posted[0]!.reviewer_outcome, NO_CRITERIA_REVIEWER_OUTCOME, "the outcome is countable in the ledger");
  assert.ok(calls.some(call => /statuses\//.test(call) && /state=failure/.test(call)), calls.join("\n"));
  assert.ok(!calls.some(call => /statuses\//.test(call) && /state=success/.test(call)), "a zero-criteria PR never passes");
});

test("W1-T14826 criterion 1: the distinct outcome classifies as posted, and the bare not_attempted it replaces stays withheld", () => {
  const input: ReviewReplayInput = {
    stage: "semantic", plan_only: false, required_semantic: true, criteria_count: 0, risk_present: true,
    budget_present: true, untasked: true, head_task_resolved: true, own_task_record_missing: false,
    reviewer_outcome: NO_CRITERIA_REVIEWER_OUTCOME, verdict_lines: [],
  };
  assert.equal(classifyReviewOutcome(input).class, "posted");
  assert.deepEqual(classifyReviewOutcome({ ...input, reviewer_outcome: "not_attempted" }),
    { class: "withheld", reason: "required-semantic-not_attempted" }, "the ops#706 input still withholds; only the named outcome is final");
  // The outcome is only final with no criteria: a run that somehow reported it beside a criterion is still withheld.
  assert.equal(requiredSemanticRefusal({ required: true, planOnly: false, outcome: NO_CRITERIA_REVIEWER_OUTCOME, criteriaCount: 1, verdicts: undefined }),
    `required-semantic-${NO_CRITERIA_REVIEWER_OUTCOME}`);
});

test("W1-T14826 criterion 2: a PR with criteria and a plan-only PR keep the outcome and class origin/main gave them", async t => {
  const base: ReviewReplayInput = {
    stage: "semantic", plan_only: false, required_semantic: true, criteria_count: 1, risk_present: true,
    budget_present: true, untasked: false, head_task_resolved: true, own_task_record_missing: false,
    reviewer_outcome: "success", verdict_lines: ["REVIEW_VERDICT 1: PASS"],
  };
  // origin/main's classification at ff1db4163: this table also passes with this change's two src lines deleted.
  const expected: Array<[Partial<ReviewReplayInput>, { class: string; reason: string }]> = [
    [{}, { class: "posted", reason: "review-gates-complete" }],
    [{ verdict_lines: ["REVIEW_VERDICT 1: FAIL"] }, { class: "posted", reason: "review-gates-complete" }],
    [{ verdict_lines: [] }, { class: "withheld", reason: "required-semantic-incomplete-verdicts" }],
    [{ reviewer_outcome: "not_attempted", verdict_lines: [] }, { class: "withheld", reason: "required-semantic-not_attempted" }],
    [{ reviewer_outcome: "spawn_error", verdict_lines: [] }, { class: "withheld", reason: "required-semantic-spawn_error" }],
    [{ reviewer_outcome: "not_attempted_deterministic_mode", verdict_lines: [] }, { class: "withheld", reason: "required-semantic-not_attempted_deterministic_mode" }],
    [{ plan_only: true, reviewer_outcome: "not_attempted_plan_only", verdict_lines: [] }, { class: "posted", reason: "review-gates-complete" }],
    [{ plan_only: true, criteria_count: 0, reviewer_outcome: "not_attempted_plan_only", verdict_lines: [] }, { class: "posted", reason: "review-gates-complete" }],
  ];
  for (const [over, want] of expected) assert.deepEqual(classifyReviewOutcome({ ...base, ...over }), want, JSON.stringify(over));

  // Driven: a plan-only PR with no criteria still reports the plan-only outcome, never the new one.
  const plan = await drive(t, PLAN_DIFF, "Revise a filing.\n");
  assert.equal(plan.result.reviewerOutcome, "not_attempted_plan_only", plan.result.summary);
  assert.notEqual(plan.result.summary, NO_CRITERIA_FAIL_SUMMARY);
});
