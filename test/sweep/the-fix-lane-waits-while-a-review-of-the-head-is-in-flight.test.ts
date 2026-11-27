/**
 * W1-T15005: a fix round pushed while a review of the PR's head is still running supersedes that review, which then refuses
 * to post ("review input changed after this verdict started"). OBSERVED 2026-11-26: about 12 of 276 review runs ended so,
 * and under CPU contention a review takes 30 to 90 minutes. The sweep's fix dispatch now waits while a live review owns the
 * PR's current head, and dispatches as before once that review settles or its owner is proven dead.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import * as sweep from "#src/lib/sweep.js";
import type { FixDispatchEnvelope, FixDispatchEvidence, OpenPrView, RollupCheckEntry } from "#src/lib/sweep.js";
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

let liveSeq = 0;
/** A review of `head` running in this process, through the real review mutex a review run child holds
 *  (registerChildWork) until it settles. Returns its settle. */
function liveReview(view: Pick<OpenPrView, "prNumber" | "taskId" | "reviewInputDigest">, head = HEAD): () => void {
  const runId = `t15005-live-${++liveSeq}`;
  sweep.registerChildWork({ runId, kind: "review", taskId: view.taskId ?? "PR-15005", prNumber: view.prNumber, headSha: head,
    reviewKey: `${sweep.reviewOutcomeTaskIdFor(view)}@${head}` });
  return () => { sweep.settleChildWork(runId); };
}

/** The sweep's real fix dispatch over a ledger holding `ledger`, with every effect past the deferral point faked. By
 *  default a review of the head is running (`live`); `live: false` is a review that ended by an exit writing no row. */
function dispatcher(t: TestContext, ledger: Row[] | "unreadable", view: Partial<OpenPrView> = {}, live: boolean | string = true) {
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
  const dispatch = async () => {
    const settle = live === false ? undefined : liveReview(pr, typeof live === "string" ? live : HEAD);
    try { return await effects.dispatchFix!(pr, EVIDENCE); } finally { settle?.(); }
  };
  return { rows, seen, dispatch, effects, ledgerPath, pr };
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

test("W1-T15005: legacy rows for an unfiled PR use its PR ledger key", async (t) => {
  const unfiledClaim: Row = { step: "review.pending_posted", run_id: "review-PR15005-1", task_id: "PR-15005", head_sha: HEAD };
  const unfiled = { taskId: undefined };
  const live = dispatcher(t, [unfiledClaim], unfiled);
  await live.dispatch();
  assert.deepEqual(deferrals(live.rows).map((row) => row.review_run), ["review-PR15005-1"],
    "a taskless legacy claim still owns the PR's current head");
  assert.equal(live.seen.claimKeys, 0);

  const held = { ...unfiledClaim, step: "review.capped_pass_held" };
  assert.equal(sweep.reviewInFlightOnHead({ prNumber: 15005, headSha: HEAD, prUrl: PR_URL, taskId: undefined,
    reviewState: "pending" }, [unfiledClaim, held]), undefined, "a taskless held pass ends that claim");
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

test("W1-T15005 criterion 3: a review that ended its pass on a held pending status holds nothing on later passes", async (t) => {
  // OBSERVED 2026-11-26 (review of 83132de7b): a real capped runReview writes review.pending_posted, then
  // review.capped_pass_held, and returns; no settled row follows, and its daemon stays alive. Each row below carries the
  // fields its producer in src/lib/review.ts writes (publishCappedHold, publishSemanticHold, publishTaskHold).
  const held: Array<[string, Row]> = [
    ["a capped pass held", { step: "review.capped_pass_held", run_id: "review-PR15005-1", task_id: TASK, head_sha: HEAD,
      attempted_state: "success", reason: "capped", outcome: "pending", ts: "2026-11-26T16:30:00.000Z" }],
    ["a semantic pass refused", { step: "review.semantic_pass_refused", run_id: "review-PR15005-1", task_id: TASK, head_sha: HEAD,
      pr_url: PR_URL, attempted_state: "success", reason: "no semantic judgement", reviewer_outcome: null, ts: "2026-11-26T16:30:00.000Z" }],
    ["a dispatch hold held", { step: "review.dispatch_hold_held", run_id: "review-PR15005-1", task_id: TASK, head_sha: HEAD,
      attempted_state: "success", reason: "dispatch_hold", outcome: "pending", ts: "2026-11-26T16:30:00.000Z" }],
  ];
  for (const [why, row] of held) {
    for (let pass = 0; pass < 3; pass++) {
      const d = dispatcher(t, [claim("review-PR15005-1"), row]);
      await d.dispatch();
      assert.equal(deferrals(d.rows).length, 0, `THE CLAIM: ${why} defers nothing (pass ${pass + 1})`);
      assert.equal(d.seen.claimKeys, 1, `${why}: the red head's round takes its branch claim as today`);
    }
    // Positive controls: a hold by another run, or on another head, ends nothing; a new claim after the hold is in flight.
    for (const [control, ledger] of [
      ["a hold by another run", [claim("review-PR15005-1"), { ...row, run_id: "review-PR15005-0" }]],
      ["a hold on another head", [claim("review-PR15005-1"), { ...row, head_sha: OTHER }]],
      ["a new claim after the hold", [claim("review-PR15005-1"), row, claim("review-PR15005-2")]],
    ] as Array<[string, Row[]]>) {
      const d = dispatcher(t, ledger);
      await d.dispatch();
      assert.equal(deferrals(d.rows).length, 1, `${why}: ${control} still waits`);
    }
  }
  assert.deepEqual([...sweep.REVIEW_HELD_PASS_STEPS].sort(), [...held.map(([, row]) => row.step)].sort(), "each held step is exercised above");
});

test("W1-T15005 criterion 3: a claim whose review is no longer running holds nothing, whatever rows it left", async (t) => {
  // OBSERVED 2026-11-27 (review of 49e977384): a real runReview that throws at publish (a GitHub rate limit) writes no
  // ending row after its claim, and the daemon stays alive. In flight now needs the review itself running: its key in the
  // review mutex, released when the attempt settles by any exit.
  const exits: Array<[string, Row[]]> = [
    ["a throw after the claim (no row)", [claim("review-PR15005-1")]],
    ["a throw after reviewer progress", [claim("review-PR15005-1"), { step: "review.reviewer.materialized", run_id: "review-PR15005-1",
      task_id: TASK, pr_url: PR_URL, head_sha: HEAD, ts: "2026-11-26T16:10:00.000Z" }]],
    ["a throw after proof execution", [claim("review-PR15005-1"), { step: "review.proof_execution", run_id: "review-PR15005-1",
      task_id: TASK, head_sha: HEAD, ts: "2026-11-26T16:12:00.000Z" }]],
    ["a pending-post error", [claim("review-PR15005-1"), { step: "review.pending_post.error", run_id: "review-PR15005-1",
      task_id: TASK, pr_url: PR_URL, head_sha: HEAD, ts: "2026-11-26T16:13:00.000Z" }]],
  ];
  for (const [why, ledger] of exits) {
    for (let pass = 0; pass < 3; pass++) {
      const d = dispatcher(t, ledger, {}, false);
      await d.dispatch();
      assert.equal(deferrals(d.rows).length, 0, `THE CLAIM: ${why} defers nothing once its review stopped running (pass ${pass + 1})`);
      assert.equal(d.seen.claimKeys, 1, `${why}: the round takes its branch claim as today`);
    }
    // Positive control: the same rows with the review still running wait.
    const running = dispatcher(t, ledger);
    await running.dispatch();
    assert.equal(deferrals(running.rows).length, 1, `${why}: a review still running waits`);
  }
  // A review running on ANOTHER head is not this head's review.
  const elsewhere = dispatcher(t, [claim("review-PR15005-1")], {}, OTHER);
  await elsewhere.dispatch();
  assert.equal(deferrals(elsewhere.rows).length, 0, "a live review of another head holds nothing");
});

test("W1-T15005 criterion 3: an untasked PR's held pass, written under PR-<n> with no url, holds nothing", async (t) => {
  // OBSERVED 2026-11-27 (review of 49e977384): for an untasked PR publishCappedHold writes task_id PR-<n> and no pr_url.
  const key = "PR-15005";
  const untaskedClaim: Row = { ...claim("review-PR15005-1"), task_id: key };
  const capped: Row = { step: "review.capped_pass_held", run_id: "review-PR15005-1", task_id: key, head_sha: HEAD,
    attempted_state: "success", reason: "capped", outcome: "pending", ts: "2026-11-26T16:30:00.000Z" };
  for (let pass = 0; pass < 3; pass++) {
    const d = dispatcher(t, [untaskedClaim, capped], { taskId: undefined });
    await d.dispatch();
    assert.equal(deferrals(d.rows).length, 0, `THE CLAIM: the untasked held pass defers nothing (pass ${pass + 1})`);
  }
  const waiting = dispatcher(t, [untaskedClaim], { taskId: undefined });
  await waiting.dispatch();
  assert.equal(deferrals(waiting.rows).length, 1, "positive control: the untasked claim with its review running waits");
});

/** One real sweep pass over `d`'s PR with the run-child host on, as `sweep.runChild.mode: auto` resolves it in production.
 *  The host's fix child runs the real {@link sweep.runFixDispatchChild} on the envelope the sweep built, in a process of its
 *  own: before it starts, the review that is live in the sweep's process is not live in the child's (`settle`). */
async function hostedPass(t: TestContext, d: ReturnType<typeof dispatcher>, settle: (() => void) | undefined) {
  const sweepRows: Row[] = [];
  const envelopes: FixDispatchEnvelope[] = [];
  sweep.installDetachedWorkHost({
    hosts: new Set(["review", "fix-dispatch"]), mode: () => "on", spawnReview: async () => undefined,
    spawnFix: async (input) => {
      envelopes.push(input.envelope);
      settle?.();
      const settled = sweep.runFixDispatchChild({ envelope: input.envelope }, {
        readLivePr: async () => ({ state: "OPEN", headSha: HEAD }),
        readTask: () => ({ found: true, merged: false, retired: false }),
        hold: () => undefined, claimFixAdmission: () => ({ admitted: true }),
        dispatcher: () => ({ dispatchFix: d.effects.dispatchFix! }),
        log: (step, extra) => { d.rows.push({ step, child: true, ...extra }); },
      }).catch(() => undefined);
      return { runId: `work-fix-dispatch-${TASK}-${envelopes.length}`, settled };
    },
  });
  t.after(() => { sweep.installDetachedWorkHost(undefined); sweep.resetChildWork(); });
  const deps = {
    ledgerPath: d.ledgerPath, runId: "SWEEP-T15005-hosted", detachFixWait: true,
    readLedger: () => sweepRows, appendLine: (_p: string, row: Row) => { sweepRows.push(row); },
    log: (step: string, extra?: Record<string, unknown>) => { sweepRows.push({ step, ...extra }); },
    arm: () => {}, close: () => assert.fail("a red PR is not closed"), escalate: () => {},
    dispatchFix: d.effects.dispatchFix!, claimFixAdmission: () => ({ admitted: true }), readActiveWorkerCount: () => 0,
    readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
  } as unknown as sweep.SweepDeps;
  await withLiveWritesAllowed(async () => { await sweep.runSweep([d.pr], deps); await sweep.drainDetachedSweepActions(); });
  return { sweepRows, envelopes };
}

test("W1-T15005 criterion 1: a round the sweep starts as a run child waits in the sweep, before any child is spawned", async (t) => {
  // OBSERVED 2026-11-27 (review of 68cde97a3): with runChild.mode auto the round ran in a fix child, whose review mutex is
  // empty, so a real runFixDispatchChild wrote 0 deferrals and took the branch claim while the review was live.
  const d = dispatcher(t, [claim("review-PR15005-1")], {}, false);
  const settle = liveReview(d.pr);
  let settledOnce = false;
  const hosted = await hostedPass(t, d, () => { if (!settledOnce) { settledOnce = true; settle(); } });
  if (!settledOnce) settle();
  assert.deepEqual(hosted.envelopes, [], "THE CLAIM: no fix child is spawned while the review of the head is live");
  assert.deepEqual(deferrals(hosted.sweepRows).map((row) => [row.pr_number, row.head, row.review_run]), [[15005, HEAD, "review-PR15005-1"]],
    "THE CLAIM: the sweep writes the one deferral row, naming the review run");
  assert.equal(d.seen.claimKeys, 0, "no branch claim is taken");

  // Positive control: once the review is no longer running, the same pass spawns the child, which dispatches on the
  // sweep's decision (carried in its envelope) and takes its branch claim, as today.
  const free = dispatcher(t, [claim("review-PR15005-1")], {}, false);
  const freed = await hostedPass(t, free, undefined);
  assert.equal(freed.envelopes.length, 1, "positive control: the round is started as a run child");
  assert.deepEqual(freed.envelopes[0]!.evidence.reviewInFlight, { headSha: HEAD }, "the child carries the sweep's decision");
  assert.equal(free.seen.claimKeys, 1, "the child takes its branch claim");
  assert.equal(deferrals([...freed.sweepRows, ...free.rows]).length, 0);
});

/** A review owned by ANOTHER process on this host, as an operator `rmd review` writes its claim: a real live process whose
 *  pid, host and start the claim row records (review.ts postReviewPending). Returns the claim's owner fields and its kill. */
async function otherProcessOwner(t: TestContext) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
  await once(child, "spawn");
  const owner = { owner_pid: child.pid!, owner_started_at: new Date().toISOString(), host: hostname() };
  const kill = async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); } };
  t.after(kill);
  return { owner, kill };
}

test("W1-T15005 criterion 1: a fix round waits while a review owned by another live process holds the head", async (t) => {
  // OBSERVED 2026-11-27 (review of 198c86322): a live `rmd review` in its own process wrote its claim with owner pid
  // "active", yet the sweep's mutex held no key for it, so a real runSweep on red CI wrote 0 deferrals and took the claim.
  const { owner, kill } = await otherProcessOwner(t);
  const ledger = [claim("review-PR15005-op", HEAD, owner)];
  const d = dispatcher(t, ledger, {}, false);
  assert.equal(await d.dispatch(), false, "THE CLAIM: the round is not dispatched");
  assert.deepEqual(deferrals(d.rows).map((row) => [row.pr_number, row.head, row.review_run]), [[15005, HEAD, "review-PR15005-op"]],
    "THE CLAIM: one row names the other process's review run");
  assert.equal(d.seen.claimKeys, 0, "no branch claim is taken");

  // The same through one real sweep pass, run-child host on: the sweep defers before any fix child is spawned.
  const swept = dispatcher(t, ledger, {}, false);
  const hosted = await hostedPass(t, swept, undefined);
  assert.deepEqual(hosted.envelopes, [], "THE CLAIM: no fix child is spawned while another process's review is live");
  assert.deepEqual(deferrals(hosted.sweepRows).map((row) => row.review_run), ["review-PR15005-op"]);
  assert.equal(swept.seen.claimKeys, 0);

  // Criterion 2: once that owner process is gone, the same claim holds nothing and the round dispatches as today.
  await kill();
  const after = dispatcher(t, ledger, {}, false);
  await after.dispatch();
  assert.equal(deferrals(after.rows).length, 0, "THE CLAIM: a dead owner ends the wait");
  assert.equal(after.seen.claimKeys, 1, "the round takes its branch claim as today");
});

test("W1-T15005 criterion 3: a claim this process wrote is judged by its mutex key, never by its own live pid", async (t) => {
  // This process's pid is alive by definition: a review it ran that ended with no row must not hold the round.
  const own = { owner_pid: process.pid, owner_started_at: new Date(Date.now() - 60_000).toISOString(), host: hostname() };
  const d = dispatcher(t, [claim("review-PR15005-1", HEAD, own)], {}, false);
  await d.dispatch();
  assert.equal(deferrals(d.rows).length, 0, "THE CLAIM: an own-process claim with no key defers nothing");
  assert.equal(d.seen.claimKeys, 1);
  // The owner rule takes only an "active" assessment; another host or an incomplete identity proves nothing.
  const view = { prNumber: 15005, headSha: HEAD, prUrl: PR_URL, taskId: TASK, reviewState: "pending" } as const;
  const foreign = claim("review-PR15005-2", HEAD, { owner_pid: 4242, owner_started_at: "2026-11-26T15:59:00.000Z", host: "elsewhere" });
  for (const assessed of ["unknown", "dead"] as const) {
    assert.equal(sweep.reviewInFlightOnHead(view, [foreign], () => false, (row) => sweep.reviewClaimOwnerLiveElsewhere(row, () => assessed)),
      undefined, `an owner assessed ${assessed} holds nothing`);
  }
  assert.equal(sweep.reviewInFlightOnHead(view, [foreign], () => false, (row) => sweep.reviewClaimOwnerLiveElsewhere(row, () => "active")),
    "review-PR15005-2", "positive control: an active owner in another process holds the head");
  assert.equal(sweep.reviewClaimOwnerLiveElsewhere({ ...foreign, owner_pid: 4242 }, () => "active", 4242), false,
    "the same claim read by its own process is not judged by pid");
  assert.equal(sweep.reviewClaimOwnerLiveElsewhere({ ...foreign, owner_pid: undefined }, () => "active"), false,
    "a legacy claim with no owner pid is not live by this rule");
  // An ending row still ends a live other-process claim.
  assert.equal(sweep.reviewInFlightOnHead(view, [foreign, settled("review-PR15005-2")], () => false, () => true), undefined);
});

test("W1-T15005 finding 2: a carried decision for the head is used as made, and one for another head is made again", async (t) => {
  const d = dispatcher(t, [claim("review-PR15005-1")], {}, false);
  const pr = d.pr;
  // A carried "in flight" is honoured without a liveness read: the process that made it held the mutex.
  const held = await sweep.decideReviewInFlight(pr, { ...EVIDENCE, reviewInFlight: { headSha: HEAD, reviewRun: "review-PR15005-1" } }, d.ledgerPath);
  assert.equal(held.reviewInFlight.reviewRun, "review-PR15005-1");
  const deferred = await d.effects.dispatchFix!(pr, held);
  assert.equal(deferred, false, "the dispatch defers on the carried decision");
  assert.equal(deferrals(d.rows).length, 1);
  // A decision for another head (a moved head) is made again, here: no review is live, so it reads none.
  const moved = await sweep.decideReviewInFlight(pr, { ...EVIDENCE, reviewInFlight: { headSha: OTHER, reviewRun: "review-PR15005-1" } }, d.ledgerPath);
  assert.deepEqual(moved.reviewInFlight, { headSha: HEAD });
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
  const settle = liveReview({ prNumber: 15006, taskId: undefined, reviewInputDigest: undefined });
  const waiting = await pass([pending]).finally(settle);
  assert.equal(waiting.dispatched, 1, "the dispatch still decides, and defers");
  assert.deepEqual(waiting.rounds, [], "THE CLAIM: a round the review holds back records no worker round");
  // Positive control: once that review posts, the round is recorded before it runs, as today.
  const free = await pass([pending, { ...pending, step: "review.posted", state: "failure" }]);
  assert.equal(free.rounds.length, 1, "the worker round is recorded when no review is in flight");
});
