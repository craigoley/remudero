import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { reviewCommand, type ReviewCommandDeps, type ReviewCommandHost } from "#src/cli/commands/review.js";
import type { Config } from "#src/lib/config.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import { PARKED_PR_REMEDY_STEP } from "#src/lib/parked-pr-remedy.js";
import type { Plan } from "#src/lib/plan.js";
import type { postReviewStatusGuarded } from "#src/lib/review.js";
import { loadedReviewerCodeSha } from "#src/lib/reviewer-health.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import {
  DEFAULT_SWEEP_POLICY,
  REVIEWER_START_FAILED_OUTCOME,
  REVIEW_SETUP_REFUSAL_ESCALATED_STEP,
  buildSweepEffects,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "#test/helpers/sweep-test.js";

// W1-T13380 — the #19030 shape: a review run posted its pending claim, its reviewer could not start (the semantic
// reviewer source checkout did not match the PR head) and the run ended with review.semantic_incomplete. The claim's
// owner is the daemon process, which is alive, so the head read "review in progress" while no review ran.
const NOW = Date.parse("2026-11-17T08:52:00Z");
const PR_NUMBER = 19030;
const PR_URL = `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`;
const TASK = "W1-T900380";
const HEAD = "3c171414c53252b0c67e91ee8d4d8ab6b0b45e1f";
const DIGEST = "v1:t13380-body";
const RUN = "review-PR19030-1794905241617";
const RETRY_RUN = "review-PR19030-1794905600000";
const START_FAILED = `required-semantic-${REVIEWER_START_FAILED_OUTCOME}`;
const CODE = loadedReviewerCodeSha();

type Row = Record<string, unknown>;

function claim(ts: string, run = RUN): Row {
  return { ts, run_id: run, task_id: TASK, step: "review.pending_posted", head_sha: HEAD, owner_pid: process.pid,
    owner_started_at: "2026-11-17T08:00:00Z", pr_url: PR_URL, review_input_digest: DIGEST };
}
function startFailed(ts: string, run = RUN, over: Row = {}): Row[] {
  const at = { ts, run_id: run, task_id: TASK, head_sha: HEAD, pr_url: PR_URL };
  return [
    { ...at, step: "review.reviewer.materialization_error", reason: "head-mismatch",
      error: "semantic reviewer source checkout does not match the PR head" },
    { ...at, step: "review.reviewer.error", error: "semantic reviewer source checkout does not match the PR head" },
    { ...at, step: "review.replay_input", stage: "semantic" },
    { ...at, step: "review.semantic_incomplete", reason: START_FAILED, reviewer_outcome: REVIEWER_START_FAILED_OUTCOME,
      review_input_digest: DIGEST, ...(CODE === null ? {} : { reviewer_code_sha: CODE }), ...over },
  ];
}

const ONE_START_FAILURE: Row[] = [claim("2026-11-17T08:47:49Z"), ...startFailed("2026-11-17T08:48:41Z")];
const TWO_START_FAILURES: Row[] = [...ONE_START_FAILURE, ...startFailed("2026-11-17T08:50:10Z", RETRY_RUN)];

/** The view the producer builds while the live status is the run's own claim and its owner process is alive. */
function viewFor(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR_NUMBER, prUrl: PR_URL, taskId: TASK, headRefName: `run-${TASK}-1794900000000`,
    reviewState: "pending", reviewPendingSince: "2026-11-17T08:47:49Z",
    reviewPendingOwnerRunId: RUN, reviewPendingStatusRunId: RUN,
    // expiring-fixture: exempt -- every sweep here runs on the pinned clock NOW (now: () => NOW), so this stamp never ages against the real date
    checksState: "green", unmetCriteria: [], priorStrikes: 0, lastActivityAt: "2026-11-17T08:47:00Z",
    headSha: HEAD, autoMergeArmed: false, reviewInputDigest: DIGEST, priorReviewAttemptsForInput: 0,
    ...over,
  } as OpenPrView;
}

function sweepDeps(ledgerPath: string, parkedPr?: SweepDeps["parkedPr"]) {
  const escalated: string[] = [];
  const reviewed: string[] = [];
  const deps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {},
    escalate: (_p: OpenPrView, reason: string) => { escalated.push(reason); },
    postReview: (p: { prNumber: number; headSha: string }) => { reviewed.push(`${p.prNumber}@${p.headSha}`); },
    ledgerPath, runId: "SWEEP-1", now: () => NOW,
    ...(parkedPr === undefined ? {} : { parkedPr }),
  } as unknown as SweepDeps;
  return { deps, escalated, reviewed };
}

function rowsOf(path: string): Row[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
}

function disposedRows(path: string): Row[] {
  return rowsOf(path).filter((row) => row.step === "sweep.disposed" && row.pr_number === PR_NUMBER);
}

test("W1-T13380 criterion 1: after a reviewer start failure the next pass admits one review of the current head", async (t) => {
  const ledger = writeLedger(ONE_START_FAILURE, { scope: t });
  const pass = sweepDeps(ledger.path);
  await runSweep([viewFor()], pass.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(pass.reviewed, [`${PR_NUMBER}@${HEAD}`], "one review of the current head is admitted");
  const disposed = disposedRows(ledger.path);
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0]!.disposition, "post-review");
  assert.equal(disposed[0]!.acted, true);
  assert.equal(disposed[0]!.owner_gone_cause, "start-failed");
  assert.match(String(disposed[0]!.reason), /reviewer failed to start \(required-semantic-spawn_error\) and no review is running/);
  assert.deepEqual(pass.escalated, []);

  // Control: the same claim with no start failure is a review in flight, and it waits.
  const live = writeLedger([claim("2026-11-17T08:47:49Z")], { scope: t });
  const waiting = sweepDeps(live.path);
  await runSweep([viewFor()], waiting.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(waiting.reviewed, []);
  assert.equal(disposedRows(live.path)[0]!.disposition, "wait");

  // A newer claim after the start failure is a review running again: it waits too.
  const reclaimed = writeLedger([...ONE_START_FAILURE, claim("2026-11-17T08:49:30Z", RETRY_RUN)], { scope: t });
  const again = sweepDeps(reclaimed.path);
  await runSweep([viewFor({ reviewPendingOwnerRunId: RETRY_RUN, reviewPendingStatusRunId: RETRY_RUN,
    reviewPendingSince: "2026-11-17T08:49:30Z" })], again.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(again.reviewed, []);
});

/** A review command host whose unreached dependencies refuse loudly. */
const host = {
  GIT_UNTRACKED_FILES_ALL: "--untracked-files=all", JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
  acceptedReviewAttemptId: () => undefined, reviewWorktreeAsync: { fetch: () => {} },
  materializeReviewWorktree: () => { throw new Error("forbidden real materialization"); },
  realDeps: () => { throw new Error("forbidden default worker graph"); },
  reviewPostedDescription: () => "fixture",
  liveWorkerRunIds: new Set<string>(), reviewWorkerLockId: (id: string) => `fixture-${id}`,
} as unknown as ReviewCommandHost;

type Posted = { state: string; description?: string; runId: string };

async function reviewRun(t: TestContext, reviewerOutcome: string, claimPosted = true): Promise<Posted[]> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13380-review-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const posted: Posted[] = [];
  const deps: ReviewCommandDeps = {
    fetchView: () => ({ headRefOid: head, headRefName: "codex/t13380-start-failure", number: PR_NUMBER, url: PR_URL,
      body: "## Acceptance\n- it works | grep: review in src/lib/review.ts\n" }),
    fetchHead: () => {},
    loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/bin/true" }) as Config,
    postReviewPending: (async () => ({ posted: claimPosted })) as never,
    materialize: (() => ({ worktreePath: undefined, failure: { errorClass: "test", message: "fixture" } })) as never,
    // The row runReview's withheld semantic verdict writes, through the command's own log.
    runReview: (async (args: { log: (step: string, extra?: Row) => void }) => {
      args.log("review.semantic_incomplete", { reason: `required-semantic-${reviewerOutcome}`, head_sha: head, pr_url: PR_URL,
        reviewer_outcome: reviewerOutcome });
      return { state: "failure", criteria: [], testTheater: false, summary: START_FAILED, floorDegraded: true, capped: true,
        keywordOnly: false, planOnly: false, headSha: head, reviewerOutcome, verdictWithheld: `required-semantic-${reviewerOutcome}` };
    }) as never,
    postStatus: (async (opts: Parameters<typeof postReviewStatusGuarded>[0]) => {
      posted.push({ state: opts.state, description: opts.description, runId: opts.runId });
      return { posted: true };
    }) as never,
  };
  const code = await reviewCommand(host, "codex/t13380-start-failure", ["--repo", "craigoley/remudero"], deps);
  assert.equal(code, 2, "a withheld verdict exits 2");
  return posted;
}

test("W1-T13380 criterion 1: the run whose reviewer failed to start replaces its own claim with the truth", async (t) => {
  const posted = await reviewRun(t, REVIEWER_START_FAILED_OUTCOME);
  assert.equal(posted.length, 1, `one status post: ${JSON.stringify(posted)}`);
  assert.equal(posted[0]!.state, "pending");
  const runId = posted[0]!.runId;
  assert.equal(posted[0]!.description,
    `pending (owned by run ${runId}) — no review running: the reviewer failed to start (${START_FAILED}); retry due`);
  // Controls: a withheld verdict whose reviewer did start, or a run that holds no claim, posts nothing.
  assert.deepEqual(await reviewRun(t, "error_max_turns"), []);
  assert.deepEqual(await reviewRun(t, REVIEWER_START_FAILED_OUTCOME, false), []);
});

/** The production parkedPr host, built by buildSweepEffects; its GitHub issue gateway records every write. */
function productionParkedPr(t: TestContext, ledgerPath: string, issueWrites: string[]): NonNullable<SweepDeps["parkedPr"]> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13380-root-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"));
  const issues: IssueGateway = {
    ensureLabel: () => true, listOpen: () => [],
    create: () => { issueWrites.push("issue"); return "https://github.com/craigoley/remudero/issues/1"; },
    comment: () => { issueWrites.push("comment"); },
  };
  const effects = buildSweepEffects({
    owner: "craigoley", repo: "remudero", repoRoot: root,
    config: { root, claudeBin: "/bin/true" } as Config,
    plan: { tasks: [], byId: new Map() } as unknown as Plan,
    ledgerPath, runId: "SWEEP-1",
    log: () => undefined, issuesImpl: issues, ghRunImpl: () => undefined, nowMsImpl: () => NOW,
    readJsonImpl: async () => ({ user: { login: "remudero-fleet[bot]" } }),
  });
  assert.ok(effects.parkedPr, "the production effects wire the parkedPr host");
  return effects.parkedPr;
}

test("W1-T13380 criterion 2: the same start failure twice at one head, body and reviewer code is held and escalated once", async (t) => {
  assert.notEqual(CODE, null, "fixture assumption: the running reviewer code sha is readable");
  // Legacy path, with no remedy host: one escalation, no review, and a second pass adds neither.
  const ledger = writeLedger(TWO_START_FAILURES, { scope: t });
  const first = sweepDeps(ledger.path);
  await runSweep([viewFor()], first.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(first.reviewed, [], "no review is admitted for the repeated start failure");
  assert.equal(first.escalated.length, 1);
  assert.match(first.escalated[0]!, /refused 2 times at head 3c17141 \(reviewer-start-failed:required-semantic-spawn_error\)/);
  assert.equal(disposedRows(ledger.path).at(-1)!.disposition, "blocked-ambiguous");
  const escalations = () => rowsOf(ledger.path).filter((row) => row.step === REVIEW_SETUP_REFUSAL_ESCALATED_STEP);
  assert.equal(escalations().length, 1);
  assert.equal(escalations()[0]!.review_input_digest, DIGEST);
  const second = sweepDeps(ledger.path);
  await runSweep([viewFor()], second.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(second.reviewed, []);
  assert.deepEqual(second.escalated, [], "one escalation per input, not one per pass");
  assert.equal(escalations().length, 1);

  // Production path: one parked-PR remedy per head and input, and no needs-human issue.
  const parked = writeLedger(TWO_START_FAILURES, { scope: t });
  const issueWrites: string[] = [];
  const parkedPr = productionParkedPr(t, parked.path, issueWrites);
  for (let pass = 0; pass < 2; pass++) {
    const run = sweepDeps(parked.path, parkedPr);
    await runSweep([viewFor()], run.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(run.reviewed, []);
    assert.deepEqual(run.escalated, []);
  }
  const remedies = rowsOf(parked.path).filter((row) => row.step === PARKED_PR_REMEDY_STEP);
  assert.deepEqual(remedies.map((row) => [row.head_sha, row.review_input_digest, row.cause, row.outcome]),
    [[HEAD, DIGEST, "review-setup-refused:reviewer-start-failed:required-semantic-spawn_error", "taken"]]);
  assert.deepEqual(issueWrites, []);
});

test("W1-T13380 criterion 2: a start failure of other reviewer code or another body is retried, not held", async (t) => {
  const otherCode = [...ONE_START_FAILURE, ...startFailed("2026-11-17T08:50:10Z", RETRY_RUN, { reviewer_code_sha: "e".repeat(40) })];
  const otherBody = [...ONE_START_FAILURE, ...startFailed("2026-11-17T08:50:10Z", RETRY_RUN, { review_input_digest: "v1:other" })];
  const judged = [...ONE_START_FAILURE, { ts: "2026-11-17T08:49:00Z", run_id: RETRY_RUN, task_id: TASK, step: "review.posted",
    state: "failure", head_sha: HEAD, pr_url: PR_URL, review_input_digest: DIGEST }, ...startFailed("2026-11-17T08:50:10Z", RETRY_RUN)];
  const cases: Array<[string, Row[], Partial<OpenPrView>]> = [["other code", otherCode, {}],
    ["other body", otherBody, {}], ["a new body", TWO_START_FAILURES, { reviewInputDigest: "v1:new-body" }],
    ["a verdict between", judged, {}]];
  for (const [label, rows, over] of cases) {
    const ledger = writeLedger([...rows], { scope: t });
    const pass = sweepDeps(ledger.path);
    await runSweep([viewFor(over)], pass.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(pass.escalated, [], `${label}: not escalated`);
    assert.notEqual(disposedRows(ledger.path).at(-1)!.disposition, "blocked-ambiguous", `${label}: not held`);
  }
});
