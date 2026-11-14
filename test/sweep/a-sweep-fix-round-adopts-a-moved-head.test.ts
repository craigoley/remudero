/**
 * W1-T12546: a head can move between the sweep's read and its fix dispatch (an update-branch, a fix
 * push, a fleet bot commit). The dispatch used to decline its checkout claim with
 * head_identity_changed, and the rung stood down at rung.evidence_head. Now each reads the checks at
 * the new head and continues only with red failures read there.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import * as sweep from "#src/lib/sweep.js";
import type { CiFailure, FixDispatchEvidence, OpenPrView, RollupCheckEntry } from "#src/lib/sweep.js";
import type { Config } from "#src/lib/config.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const TASK = "W1-T12546X";
const BRANCH = `run-${TASK}-1794600000000`;
const PR_URL = "https://github.com/o/fixture/pull/12546";
const RED: RollupCheckEntry[] = [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }];
const PENDING: RollupCheckEntry[] = [{ name: "ci", status: "IN_PROGRESS" }];
const GREEN: RollupCheckEntry[] = [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
const OPTIONAL_RED: RollupCheckEntry[] = [...GREEN, { name: "optional", status: "COMPLETED", conclusion: "FAILURE" }];
const NEW_FAILURES: CiFailure[] = [{ name: "ci", logTail: "failure read at the new head" }];
const CI_EVIDENCE: FixDispatchEvidence = { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "failure read at the old head" }] };

type Row = { step: string } & Record<string, unknown>;
interface World {
  headRefOid?: string;
  headRefName?: string;
  live?: Record<string, unknown>;
  rollup?: RollupCheckEntry[] | Error;
  requiredContexts?: string[];
  owner?: string;
}

function dispatcher(t: TestContext, world: World) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12546-effects-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["state/inflight", "repos/fixture", "tmp"]) mkdirSync(join(root, dir), { recursive: true });
  const rows: Row[] = [];
  const seen = { preflightHeads: [] as string[], rollupHeads: [] as string[], prReads: 0, claimKeys: 0, ownerReads: 0,
    dispatched: [] as Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> };
  const task = { id: TASK, title: "repair", files: [], acceptance: [], verify: "auto", status: "queued", risk: "low" };
  const effects = sweep.buildSweepEffects({
    owner: "o", repo: "fixture", localRepoName: "remudero", repoRoot: process.cwd(), config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "state/ledger.ndjson"), runId: "SWEEP-T12546",
    plan: { tasks: [task], byId: new Map([[task.id, task]]) }, policy: sweep.DEFAULT_SWEEP_POLICY,
    log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); },
    say: () => {}, reviewRunner: async () => 0, issuesImpl: { create: () => assert.fail("no issue") },
    stallNotice: () => {}, armImpl: () => "armed", armSessionPrsOverride: false, updateBranchImpl: async () => "updated",
    captureRepairFeedbackImpl: () => {}, ghRunImpl: () => {}, disarmImpl: () => undefined,
    readJsonImpl: async () => ({}), updatePrBodyImpl: async () => {},
    registeredWorktreeOwnerImpl: () => { seen.ownerReads++; return world.owner; },
    registeredOwnerRecovery: { capture: () => { throw new Error("owner snapshot unreadable in this fixture"); }, remove: () => undefined },
    boundedWorktreeOwnerPathImpl: (path: string) => path,
    dispatchFixPreflightStandDownImpl: async (_live: unknown, pr: OpenPrView) => { seen.preflightHeads.push(pr.headSha); return undefined; },
    fixBranchClaimKeyImpl: () => { seen.claimKeys++; return "t12546-claim"; },
    createFixRungWorktreeImpl: () => undefined, captureWorktreeSnapshotImpl: () => ({ headSha: NEW }),
    buildFixRungDispatchArgsImpl: (args: { pr: OpenPrView; evidence: FixDispatchEvidence }) => {
      seen.dispatched.push({ pr: args.pr, evidence: args.evidence });
      return {};
    },
    openTaskIdsFromPlanImpl: () => new Set([task.id]), readPackageScriptsImpl: () => ({}), worktreeRemoveImpl: () => {},
    ghJsonImpl: (args: string[]) => {
      if (args[0] === "pr") {
        return { ...(world.headRefName === undefined ? {} : { headRefName: world.headRefName }),
          ...(world.headRefOid === undefined ? {} : { headRefOid: world.headRefOid }), body: "", files: [] };
      }
      seen.prReads++;
      return world.live ?? { state: "open", head: { sha: NEW }, mergeable_state: "clean" };
    },
    restRollupForImpl: async (_o: string, _r: string, sha: string) => {
      seen.rollupHeads.push(sha);
      if (world.rollup instanceof Error) throw world.rollup;
      return world.rollup ?? RED;
    },
    readRequiredContextsImpl: () => world.requiredContexts ?? ["ci"],
    fetchCiFailuresImpl: () => NEW_FAILURES,
    runFixRungImpl: async () => ({ outcome: "stood_down", strikes: 0, retriggers: 0 }),
  } as unknown as sweep.BuildSweepEffectsDeps);
  const pr = { prNumber: 12546, taskId: TASK, headSha: OLD, headRefName: BRANCH, priorStrikes: 0, prUrl: PR_URL,
    checksState: "red", mergeState: "clean", reviewState: "none", unmetCriteria: [] } as unknown as OpenPrView;
  const dispatch = (evidence: FixDispatchEvidence = CI_EVIDENCE) => effects.dispatchFix!(pr, evidence);
  return { rows, seen, dispatch };
}

const steps = (rows: Row[], step: string) => rows.filter((row) => row.step === step);

test("W1-T12546 criterion 1: a moved head that is still red is adopted with the failures read at that head", async (t) => {
  const d = dispatcher(t, { headRefOid: NEW, headRefName: BRANCH });
  await d.dispatch();
  assert.deepEqual(steps(d.rows, "sweep.fix.head_adopted").map((row) => [row.from_head, row.to_head]), [[OLD, NEW]]);
  assert.equal(steps(d.rows, "sweep.fix.checkout_claim_declined").length, 0, "a moved head writes no claim decline");
  assert.deepEqual(d.seen.rollupHeads, [NEW], "the checks are read at the exact new head");
  assert.equal(d.seen.dispatched.length, 1, "the dispatch continues to the rung");
  assert.equal(d.seen.dispatched[0]!.pr.headSha, NEW);
  assert.deepEqual(d.seen.dispatched[0]!.evidence.ciFailures, NEW_FAILURES, "the old head's failures are not carried forward");
});

test("W1-T12546 criterion 2: a moved head that is not fixable yet defers with its reason and takes no claim", async (t) => {
  const cases: Array<[World, FixDispatchEvidence, string, number]> = [
    [{ rollup: PENDING }, CI_EVIDENCE, "checks_pending", 1],
    [{ rollup: GREEN }, CI_EVIDENCE, "checks_green", 1],
    [{ rollup: OPTIONAL_RED }, CI_EVIDENCE, "checks_green", 1],
    [{ rollup: [{ name: "optional", status: "COMPLETED", conclusion: "FAILURE" }] }, CI_EVIDENCE, "checks_pending", 1],
    [{ rollup: new Error("rollup read failed") }, CI_EVIDENCE, "checks_unreadable: rollup read failed", 1],
    [{ live: { state: "closed", head: { sha: NEW } } }, CI_EVIDENCE, "not_open", 0],
    [{ live: { state: "open", head: { sha: "c".repeat(40) } } }, CI_EVIDENCE, "head_moved_again", 0],
    [{ live: { state: "open", head: { sha: NEW }, mergeable_state: "dirty" } }, CI_EVIDENCE, "merge_conflict", 0],
    [{}, { unmetCriteria: [{ claim: "c", proof: "p", met: false, reason: "r", proof_exec: "not_executable" }] }, "evidence_not_ci", 0],
  ];
  for (const [world, evidence, reason, rollupReads] of cases) {
    const d = dispatcher(t, { headRefOid: NEW, headRefName: BRANCH, ...world });
    const outcome = await d.dispatch(evidence);
    assert.equal(outcome, false, `${reason}: a deferral is a dispatch that was not accepted`);
    assert.equal(sweep.dispatchFixSpent(outcome), false, `${reason}: no strike is spent`);
    assert.notEqual(typeof outcome, "object", `${reason}: a deferral is not a claim decline`);
    assert.deepEqual(steps(d.rows, "sweep.fix.head_moved_deferred").map((row) => [row.from_head, row.to_head, row.reason]),
      [[OLD, NEW, reason]]);
    assert.equal(steps(d.rows, "sweep.fix.checkout_claim_declined").length, 0, `${reason}: no claim-decline row feeds the backstop`);
    assert.equal(steps(d.rows, "sweep.fix.head_adopted").length, 0);
    assert.equal(d.seen.claimKeys, 0, `${reason}: no branch claim is taken`);
    assert.equal(d.seen.dispatched.length, 0);
    assert.equal(d.seen.rollupHeads.length, rollupReads);
    if (reason === "evidence_not_ci") assert.equal(d.seen.prReads, 0, "evidence judged at the old head is not re-read");
  }
});

test("W1-T12546 criterion 3: an unreadable head identity still declines with head_identity_unreadable", async (t) => {
  const d = dispatcher(t, { headRefName: BRANCH });
  const outcome = await d.dispatch();
  assert.deepEqual(outcome, { claimDeclined: true, ownerRecoveryReason: "head_identity_unreadable" });
  assert.deepEqual(steps(d.rows, "sweep.fix.checkout_claim_declined").map((row) => [row.owner_recovery_reason, row.head_sha]),
    [["head_identity_unreadable", OLD]]);
  assert.equal(d.seen.prReads, 0);
  assert.equal(steps(d.rows, "sweep.fix.head_moved_deferred").length + steps(d.rows, "sweep.fix.head_adopted").length, 0);
});

test("W1-T12546 criterion 5: an adopted head runs the live-state preflight, the creditable-head check and the branch claim", async (t) => {
  const adopted = dispatcher(t, { headRefOid: NEW, headRefName: BRANCH });
  await adopted.dispatch();
  assert.deepEqual(adopted.seen.preflightHeads, [OLD, NEW], "the live-state preflight runs again at the new head");
  assert.equal(adopted.seen.ownerReads, 1, "the registered worktree owner is read for the adopted head");
  assert.equal(adopted.seen.claimKeys, 1, "the branch claim is taken for the adopted head");

  const foreign = dispatcher(t, { headRefOid: NEW, headRefName: "feature/not-a-run-branch" });
  await foreign.dispatch();
  assert.deepEqual(steps(foreign.rows, "sweep.fix.head_adopted").length, 1);
  assert.deepEqual(steps(foreign.rows, "sweep.fix.uncreditable_head").map((row) => row.head_sha), [NEW],
    "the creditable-head check refuses a foreign head at the adopted sha");
  assert.equal(foreign.seen.claimKeys, 0);
  assert.equal(foreign.seen.dispatched.length, 0);

  const owned = dispatcher(t, { headRefOid: NEW, headRefName: BRANCH, owner: "/elsewhere/worktree" });
  const outcome = await owned.dispatch();
  assert.deepEqual(outcome, { claimDeclined: true, ownerRecoveryReason: "owner_snapshot_unreadable" });
  assert.deepEqual(steps(owned.rows, "sweep.fix.checkout_claim_declined").map((row) => [row.owner_recovery_reason, row.head_sha]),
    [["owner_snapshot_unreadable", NEW]], "the claim's identity checks run, and decline, at the adopted head");
  assert.equal(owned.seen.dispatched.length, 0);
});

// ── the rung: a published branch that advanced before the worker started ──────────────────────────

const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;

function worker(): WorkerResult {
  return {
    sessionId: "fix-session", costUsd: 0, numTurns: 1, text: "", blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: mount.model, effort: mount.effort,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    qualitySuspect: false,
  };
}

async function advancedRound(rollup: RollupCheckEntry[] | Error) {
  const source = gitRepo({ kind: "t12546-source" });
  const before = source.git("rev-parse", "HEAD");
  const clone = gitRepo({ kind: "t12546-round", cloneFrom: source.dir });
  clone.git("commit", "--quiet", "--allow-empty", "-m", "an update-branch merge");
  const published = clone.git("rev-parse", "HEAD");
  const rows: Row[] = [];
  const prompts: string[] = [];
  const review = { state: "failure" as const, criteria: [], testTheater: false, summary: "sweep-reconstructed: required checks red",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: before, reviewerOutcome: "sweep-reconstructed-ci-log" };
  try {
    const outcome = await runFixRung({
      taskId: TASK, runId: "DAEMON-T12546", task: { id: TASK, title: "moved head" }, prUrl: PR_URL, branch: BRANCH,
      worktreePath: clone.dir, initialSessionId: "implement-session", mount, settingsFile: join(clone.dir, "settings.json"),
      config: { root: clone.dir } as Config, budgetUsd: 5, strikeCap: 1, initialReview: review,
      ...{ requiredContexts: ["ci"] },
      ciFailures: [{ name: "ci", logTail: "failure read at the old head" }],
      reviewBase: { owner: "o", repo: "fixture", headCheckoutDir: clone.dir, reviewerMount: mount },
      escalationJudge: async () => ({ decision: "deliver", reason: "fixture" }),
      deps: {
        spawn: async (args) => { prompts.push(String(args.prompt)); return worker(); },
        harnessCommitForShellLessWorker: () => 1, commitsAhead: () => 1, worktreeHasUncommittedChanges: () => false,
        readLiveState: async () => ({ ok: true, state: "OPEN" }),
        readRemoteBranchHead: async () => published,
        readCiRollup: async () => { if (rollup instanceof Error) throw rollup; return rollup; },
        waitForCiGreen: async () => ({ state: "green", sha: "fixed-head" }),
        fetchCiFailures: async (): Promise<CiFailure[]> => NEW_FAILURES,
        runReview: async () => ({ ...review, state: "success", headSha: "fixed-head" }),
        fetchPrBody: async () => `## Summary\n\nfixture\n\nRemudero-Task: ${TASK}\n`,
        push: () => {},
        issues: { create: () => "https://github.com/o/fixture/issues/1", listOpen: () => [], comment: () => {} },
        ledgerPath: join(clone.dir, "ledger.ndjson"), ledgerLines: () => rows,
        log: (step, extra) => { rows.push({ step, ...extra }); }, say: () => {}, account: (r) => r,
      },
    });
    return { outcome, rows, prompts, before, published };
  } finally {
    clone.cleanup();
    source.cleanup();
  }
}

test("W1-T12546 criterion 4: a rung adopts a published head whose checks are red and stands down otherwise", async () => {
  const red = await advancedRound(RED);
  assert.deepEqual(steps(red.rows, "fix.evidence_head_adopted").map((row) => [row.head_sha, row.current_head_sha]),
    [[red.before, red.published]]);
  assert.equal(steps(red.rows, "fix.evidence_head_superseded").length, 0);
  assert.equal(red.prompts.length, 1, "the worker runs on the adopted head");
  assert.match(red.prompts[0]!, /failure read at the new head/);
  assert.doesNotMatch(red.prompts[0]!, /failure read at the old head/);
  assert.deepEqual(steps(red.rows, "fix.dispatch").map((row) => row.head_sha), [red.published]);

  for (const [name, rollup] of [["pending", PENDING], ["green", GREEN], ["optional red", OPTIONAL_RED],
    ["unreadable", new Error("rollup unreadable")]] as const) {
    const r = await advancedRound(rollup);
    assert.equal(r.outcome.outcome, "stood_down", `${name}: stands down as before`);
    assert.equal(r.prompts.length, 0, `${name}: no worker runs`);
    assert.equal(steps(r.rows, "fix.evidence_head_adopted").length, 0);
    assert.deepEqual(steps(r.rows, "fix.stood_down").map((row) => row.site), ["rung.evidence_head"]);
  }
});
