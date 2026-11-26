/**
 * W1-T15005: a fix round pushed while a review of the PR's head is still running supersedes that review, which then refuses
 * to post ("review input changed after this verdict started"). OBSERVED 2026-11-26: about 12 of 276 review runs ended so,
 * and under CPU contention a review takes 30 to 90 minutes. The sweep's fix dispatch now waits while a live review owns the
 * PR's current head, and dispatches as before once that review settles or its owner is proven dead.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import * as sweep from "#src/lib/sweep.js";
import type { FixDispatchEvidence, OpenPrView, RollupCheckEntry } from "#src/lib/sweep.js";
import type { Config } from "#src/lib/config.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const HEAD = "a".repeat(40);
const OTHER = "c".repeat(40);
const TASK = "W1-T15005X";
const BRANCH = `run-${TASK}-1795700000000`;
const PR_URL = "https://github.com/o/fixture/pull/15005";
const RED: RollupCheckEntry[] = [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }];
const EVIDENCE: FixDispatchEvidence = { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "red at the head" }] };

type Row = { step: string } & Record<string, unknown>;

/** The sweep's real fix dispatch over a ledger holding `ledger`, with every effect past the deferral point faked. */
function dispatcher(t: TestContext, ledger: Row[] | "unreadable", view: Partial<OpenPrView> = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t15005-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["state/inflight", "repos/fixture", "tmp"]) mkdirSync(join(root, dir), { recursive: true });
  const ledgerPath = join(root, "state/ledger.ndjson");
  // A live ledger not yet written: the read fails with ENOENT.
  if (ledger !== "unreadable") appendFileSync(ledgerPath, ledger.map((row) => `${JSON.stringify(row)}\n`).join(""));
  const rows: Row[] = [];
  const seen = { claimKeys: 0, dispatched: 0 };
  const task = { id: TASK, title: "repair", files: [], acceptance: [], verify: "auto", status: "queued", risk: "low" };
  const effects = sweep.buildSweepEffects({
    owner: "o", repo: "fixture", localRepoName: "remudero", repoRoot: process.cwd(), config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath, runId: "SWEEP-T15005",
    plan: { tasks: [task], byId: new Map([[task.id, task]]) }, policy: sweep.DEFAULT_SWEEP_POLICY,
    log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); },
    say: () => {}, reviewRunner: async () => 0, issuesImpl: { create: () => assert.fail("no issue") },
    stallNotice: () => {}, armImpl: () => "armed", armSessionPrsOverride: false, updateBranchImpl: async () => "updated",
    captureRepairFeedbackImpl: () => {}, ghRunImpl: () => {}, disarmImpl: () => undefined,
    readJsonImpl: async () => ({}), updatePrBodyImpl: async () => {},
    registeredWorktreeOwnerImpl: () => undefined,
    registeredOwnerRecovery: { capture: () => { throw new Error("owner snapshot unreadable in this fixture"); }, remove: () => undefined },
    boundedWorktreeOwnerPathImpl: (path: string) => path,
    dispatchFixPreflightStandDownImpl: async () => undefined,
    fixBranchClaimKeyImpl: () => { seen.claimKeys++; return "t15005-claim"; },
    createFixRungWorktreeImpl: () => undefined, captureWorktreeSnapshotImpl: () => ({ headSha: HEAD }),
    buildFixRungDispatchArgsImpl: () => { seen.dispatched++; return {}; },
    openTaskIdsFromPlanImpl: () => new Set([task.id]), readPackageScriptsImpl: () => ({}), worktreeRemoveImpl: () => {},
    ghJsonImpl: (args: string[]) => args[0] === "pr" ? { headRefName: BRANCH, headRefOid: HEAD, body: "", files: [] }
      : { state: "open", head: { sha: HEAD }, mergeable_state: "clean" },
    restRollupForImpl: async () => RED,
    readRequiredContextsImpl: () => ["ci"],
    fetchCiFailuresImpl: () => EVIDENCE.ciFailures,
    runFixRungImpl: async () => ({ outcome: "stood_down", strikes: 0, retriggers: 0 }),
  } as unknown as sweep.BuildSweepEffectsDeps);
  const pr = { prNumber: 15005, taskId: TASK, headSha: HEAD, headRefName: BRANCH, priorStrikes: 0, prUrl: PR_URL,
    checksState: "red", mergeState: "clean", reviewState: "pending", unmetCriteria: [], ...view } as unknown as OpenPrView;
  return { rows, seen, dispatch: () => effects.dispatchFix!(pr, EVIDENCE) };
}

const claim = (run: string, head = HEAD, extra: Record<string, unknown> = {}): Row =>
  ({ step: "review.pending_posted", run_id: run, pr_url: PR_URL, task_id: TASK, head_sha: head, ts: "2026-11-26T16:00:00.000Z", ...extra });
const settled = (run: string, step = "review.posted"): Row =>
  ({ step, run_id: run, pr_url: PR_URL, task_id: TASK, head_sha: HEAD, state: "failure", ts: "2026-11-26T16:30:00.000Z" });
const deferrals = (rows: Row[]) => rows.filter((row) => row.step === "sweep.fix_deferred_review_in_flight");

test("W1-T15005 criterion 1: a fix round waits while a review of the current head is in flight", async (t) => {
  const d = dispatcher(t, [claim("review-PR15005-1")]);
  const outcome = await d.dispatch();
  assert.equal(outcome, false, "THE CLAIM: the round is not dispatched");
  assert.equal(sweep.dispatchFixSpent(outcome), false, "and spends no strike");
  assert.deepEqual(deferrals(d.rows).map((row) => [row.pr_number, row.head, row.review_run]), [[15005, HEAD, "review-PR15005-1"]],
    "THE CLAIM: one row names the review run");
  assert.equal(d.seen.claimKeys, 0, "no branch claim is taken");
  assert.equal(d.seen.dispatched, 0);
  // A takeover's new owner is the one in flight.
  const taken = dispatcher(t, [claim("review-PR15005-1"), claim("review-PR15005-2", HEAD, { took_over_run_id: "review-PR15005-1" })]);
  await taken.dispatch();
  assert.deepEqual(deferrals(taken.rows).map((row) => row.review_run), ["review-PR15005-2"]);
});

test("W1-T15005 criterion 2: a fix round dispatches once the review ends or its owner dies", async (t) => {
  const ended: Array<[string, Row[], Partial<OpenPrView>]> = [
    ["a posted verdict", [claim("review-PR15005-1"), settled("review-PR15005-1")], {}],
    ["a stood-down review", [claim("review-PR15005-1"), settled("review-PR15005-1", "review.stood_down")], {}],
    ["a post refusal", [claim("review-PR15005-1"), settled("review-PR15005-1", "review.post_refused")], {}],
    ["an owner proven dead", [claim("review-PR15005-1")], { reviewPendingOwnerDead: true, reviewPendingOwnerRunId: "review-PR15005-1" }],
  ];
  for (const [why, ledger, view] of ended) {
    const d = dispatcher(t, ledger, view);
    await d.dispatch();
    assert.equal(deferrals(d.rows).length, 0, `THE CLAIM: ${why} ends the wait`);
    assert.equal(d.seen.claimKeys, 1, `${why}: the round takes its branch claim as today`);
  }
  // Positive control: the same dead proof for ANOTHER run leaves the live one waiting.
  const other = dispatcher(t, [claim("review-PR15005-1")], { reviewPendingOwnerDead: true, reviewPendingOwnerRunId: "review-PR15005-0" });
  await other.dispatch();
  assert.equal(deferrals(other.rows).length, 1, "a proof about another run does not end this one");
});

test("W1-T15005 criterion 3: a PR with no review in flight dispatches as today", async (t) => {
  const cases: Array<[string, Row[], Partial<OpenPrView>]> = [
    ["no review at all", [], { reviewState: "none" }],
    ["a review of another head", [claim("review-PR15005-1", OTHER)], {}],
    ["a review of another PR", [{ ...claim("review-PR15005-1"), pr_url: "https://github.com/o/fixture/pull/1" }], {}],
    ["a red verdict on the head", [claim("review-PR15005-1"), settled("review-PR15005-1")], { reviewState: "failure" }],
    ["a pending hold the run already posted", [claim("review-PR15005-1"), { ...settled("review-PR15005-1"), state: "pending" }], {}],
  ];
  for (const [why, ledger, view] of cases) {
    const d = dispatcher(t, ledger, view);
    await d.dispatch();
    assert.equal(deferrals(d.rows).length, 0, `THE CLAIM: ${why} defers nothing`);
    assert.equal(d.seen.claimKeys, 1, `${why}: the round takes its branch claim exactly as today`);
  }
  assert.equal(sweep.reviewInFlightOnHead({ prNumber: 15005, headSha: HEAD, prUrl: PR_URL, taskId: TASK, reviewState: "success" }, [claim("r")]), undefined,
    "a non-pending head never waits, whatever the ledger holds");
});

test("a live ledger not yet written holds no review in flight, so the fix round dispatches as before", async (t) => {
  const d = dispatcher(t, "unreadable");
  await d.dispatch();
  assert.equal(deferrals(d.rows).length, 0, "nothing defers");
  assert.equal(d.seen.claimKeys, 1, "the round takes its branch claim as today");
});

test("W1-T15005 criterion 3: a review that ended with no verdict holds nothing, so a red head's fix round dispatches", async (t) => {
  const reclaimed = (outcome: string): Row => ({ step: sweep.REVIEW_IN_PROCESS_RECLAIMED_STEP, run_id: "SWEEP-PASS", task_id: TASK,
    pr_number: 15005, head_sha: HEAD, outcome, ts: "2026-11-26T16:40:00.000Z" });
  const ended: Array<[string, Row[]]> = [
    // The review lane aborted it: review.lane_aborted is its last row, and the daemon that ran it is still alive.
    ["a lane-aborted review", [claim("review-PR15005-1"), settled("review-PR15005-1", "review.lane_aborted")]],
    // The sweep reclaimed the stuck in-process review under its own run id: aborted, then released unsettled.
    ["an aborted in-process review", [claim("review-PR15005-1"), reclaimed("aborted")]],
    ["a review released unsettled", [claim("review-PR15005-1"), reclaimed("aborted"), reclaimed("released-unsettled")]],
  ];
  for (const [why, ledger] of ended) {
    // Every pass reads the same rows: a review that ended without a verdict never comes back to life.
    for (let pass = 0; pass < 3; pass++) {
      const d = dispatcher(t, ledger);
      await d.dispatch();
      assert.equal(deferrals(d.rows).length, 0, `THE CLAIM: ${why} defers nothing (pass ${pass + 1})`);
      assert.equal(d.seen.claimKeys, 1, `${why}: the red head's round takes its branch claim as today`);
    }
  }
  // Positive controls: a reclaim of another PR or head ends nothing, and a claim posted after the reclaim is in flight.
  for (const [why, ledger] of [
    ["a reclaim of another PR", [claim("review-PR15005-1"), { ...reclaimed("aborted"), pr_number: 1 }]],
    ["a reclaim of another head", [claim("review-PR15005-1"), { ...reclaimed("aborted"), head_sha: OTHER }]],
    ["a new claim after the reclaim", [claim("review-PR15005-1"), reclaimed("released-unsettled"), claim("review-PR15005-2")]],
  ] as Array<[string, Row[]]>) {
    const d = dispatcher(t, ledger);
    await d.dispatch();
    assert.equal(deferrals(d.rows).length, 1, `${why} still waits`);
  }
});

test("W1-T15005 criterion 1: an owned conflicted head whose round waits on a review records no worker round", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t15005-owned-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  const branch = "review-replay-garden-1795700000000";
  const prUrl = "https://github.com/example/fixture/pull/15006";
  const pending = { step: "review.pending_posted", run_id: "review-PR15006-1", pr_url: prUrl, head_sha: HEAD };
  const pass = async (onDisk: Row[]) => {
    writeFileSync(ledgerPath, onDisk.map((row) => `${JSON.stringify(row)}\n`).join(""));
    const ledger: Record<string, unknown>[] = [];
    let dispatched = 0;
    const deps = {
      ledgerPath, runId: "owned-conflict-t15005", readLedger: () => ledger, appendLine: (_p: string, row: Record<string, unknown>) => { ledger.push(row); },
      arm: () => assert.fail("a dirty PR cannot arm"), close: () => assert.fail("a dirty PR is not closed"), escalate: () => {},
      readMainTip: () => "b".repeat(40), dispatchFix: () => { dispatched++; return false; },
      claimFixAdmission: () => ({ admitted: true }), readActiveWorkerCount: () => 0,
      readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
      readPlanRepairFacts: () => ({ authorLogin: "remudero-fleet[bot]", headRepoFork: false }),
      regenerateConflict: async () => ({ outcome: "fell-through", paths: [], reason: "no deterministic tier in this fixture" }),
      postConflictComment: () => {},
    } as unknown as sweep.SweepDeps;
    const pr = { prNumber: 15006, prUrl, headRefName: branch, headSha: HEAD, mergeState: "dirty", mergeableState: "dirty",
      checksState: "none", reviewState: "pending", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
      lastActivityAt: new Date().toISOString(), createdAt: new Date().toISOString(),
      mergeConflict: { files: [{ path: "test/fixtures/review-replay/sample.ndjson", oursDeleted: 1, theirsDeleted: 1 }], oursLog: "h", theirsLog: "m" },
    } as unknown as OpenPrView;
    await withLiveWritesAllowed(async () => { await sweep.runSweep([pr], deps); await sweep.drainDetachedSweepActions(); });
    return { dispatched, rounds: ledger.filter((row) => row.step === sweep.OWNED_CONFLICT_ROUND_STEP && row.round === "worker") };
  };
  const waiting = await pass([pending]);
  assert.equal(waiting.dispatched, 1, "the dispatch still decides, and defers");
  assert.deepEqual(waiting.rounds, [], "THE CLAIM: a round the review holds back records no worker round");
  // Positive control: once that review posts, the round is recorded before it runs, as today.
  const free = await pass([pending, { ...pending, step: "review.posted", state: "failure" }]);
  assert.equal(free.rounds.length, 1, "the worker round is recorded when no review is in flight");
});
