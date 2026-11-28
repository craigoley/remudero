import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { fakeGitHubPullRequest, type FakePullHeadRead, type FakePullRequest } from "#test/helpers/fake-github.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import {
  DEFAULT_SWEEP_POLICY, drainInFlightReviews, lightPassReviewQueuedAt, observeLightPassReviewEligibility, runSweep,
  runSweepLightPass, UPDATE_HEAD_POLL_WAITS_MS, type OpenPrView, type SweepDeps,
} from "#test/helpers/sweep-test.js";

// W1-T15162: a head made by the sweep's own branch update keeps the review queue place of the unreviewed head it
// replaced. The fixture is #21097's rows of 2026-11-27: eligible at ba824f8 from 11:18:01Z, a sweep branch update to
// bb74b21 at 12:41:24Z, bb74b21 first eligible at 12:54:33Z, and a PR first eligible at 11:42Z competing for one slot.
// Every `sweep.update_branch.updated` row below is written by runSweep's own update-branch lane, never by hand, against
// fakeGitHubPullRequest (test/helpers/fake-github.ts): update-branch is accepted at once and GitHub writes its merge
// commit (parents: the old head, then main) some simulated time later; a replica read can lag behind the true head; and
// an author or fix round can push its own commit at any simulated moment. The poll's waits are the fake's only clock.

const at = (hms: string): string => `2026-11-27T${hms}.000Z`;
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const ONE_LANE = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1, reviewLaneMin: 1, reviewLaneMax: 1 };
const UPDATE_POLICY = { ...ONE_LANE, reviewWaitingBranchRefreshEnabled: true, reviewWaitingBranchRefreshThreshold: 10 };
const UPDATED_AT = at("12:41:24");

const appendAt = (path: string, row: object, ts: string): void => appendFileSync(path, JSON.stringify({ ts, ...row }) + "\n");

function pr(n: number, created: string, head: string): OpenPrView {
  return {
    prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, taskId: `W1-T${n}`,
    headSha: head, reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: created, createdAt: created,
  };
}

function fixtureLedger() {
  const { dir, path: ledgerPath } = writeLedger();
  let clock = at("00:00:00");
  const baseDeps = (): SweepDeps => ({
    ledgerPath, runId: "sweep-update-queue-test", now: () => Date.parse(clock),
    readActiveWorkerCount: () => 0,
    appendLine: (path, row) => appendAt(path, row, clock),
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
  });
  const deps = (started: number[], gate?: Promise<void>): SweepDeps => ({
    ...baseDeps(),
    postReview: async (p) => {
      started.push(p.prNumber);
      await gate;
    },
  });
  return {
    ledgerPath, baseDeps, deps,
    setClock: (ts: string): void => { clock = ts; },
    observe: (ts: string, prs: OpenPrView[]): void => {
      clock = ts;
      observeLightPassReviewEligibility(prs, deps([]));
    },
    rows: (): Array<Record<string, unknown>> =>
      readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>),
    /** The admission key the queue ranks `view` on at `ts`, read straight from the fold. */
    keyOf: (ts: string, view: OpenPrView): string | undefined =>
      lightPassReviewQueuedAt({ ledgerPath, now: () => Date.parse(ts) })(view),
    cleanup: (): void => rmSync(dir, { recursive: true, force: true }),
  };
}
type Ledger = ReturnType<typeof fixtureLedger>;

/** #21097 on fakeGitHubPullRequest: head ba824f8 (parent 2be9c05); an accepted update lands merge bb74b21 onto main. */
const AT_BA824F8 = { head: "ba824f8", headParents: ["2be9c05"] };
const MERGE_BB74B21 = { merge: "bb74b21", mainTip: "main-tip" };

/** Drives the real full-sweep update-branch lane on `view` (17 commits behind main, a distance refresh) against `gh`.
 *  `onAccepted` runs the moment GitHub accepts the update, before the sweep's first head read. */
async function sweepUpdate(ledger: Ledger, view: OpenPrView, gh: FakePullRequest, onAccepted?: () => void) {
  ledger.setClock(UPDATED_AT);
  const deps: SweepDeps = {
    ...ledger.baseDeps(),
    behindMainByPr: new Map([[view.prNumber, 17]]),
    updateBranch: (target) => {
      const outcome = gh.updateBranch(target.headSha);
      onAccepted?.();
      return outcome;
    },
    readLiveState: () => gh.readLiveState(),
    readCommitParents: (_pr, sha) => gh.readCommitParents(sha),
    waitForUpdatedHead: (ms) => gh.wait(ms),
  };
  await runSweep([view], deps, UPDATE_POLICY);
  const accepted = gh.calls.findIndex((c) => c.method === "updateBranch");
  assert.ok(accepted >= 0, "the sweep's own update-branch lane pressed the update");
  assert.equal(gh.calls.filter((c) => c.method === "updateBranch").length, 1);
  const row = ledger.rows().findLast((r) => r.step === "sweep.update_branch.updated" && r.pr_number === view.prNumber);
  assert.ok(row, "GitHub accepted the update and the lane wrote its sweep.update_branch.updated row");
  assert.equal(row.head_sha, view.headSha);
  assert.notEqual(row.new_head_sha, view.headSha, "a lagging read never records the old head as the update's head");
  const after = gh.calls.slice(accepted + 1);
  return {
    row,
    reads: after.filter((c) => c.method === "readLiveState").length,
    waits: after.filter((c) => c.method === "wait").map((c) => c.args[0]),
    parentReads: after.filter((c) => c.method === "readCommitParents").map((c) => c.args[0]),
  };
}

async function lightFirst(ledger: Ledger, ts: string, prs: OpenPrView[]): Promise<number | undefined> {
  ledger.setClock(ts);
  const started: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await runSweepLightPass(prs, ledger.deps(started, gate), ONE_LANE);
    for (let i = 0; i < 100 && started.length === 0; i++) await settle();
  } finally {
    const drained = drainInFlightReviews({ boundMs: 1000 });
    release();
    await drained;
  }
  return started[0];
}

async function fullFirst(ledger: Ledger, ts: string, prs: OpenPrView[]): Promise<number | undefined> {
  ledger.setClock(ts);
  const started: number[] = [];
  await runSweep(prs, ledger.deps(started), ONE_LANE);
  return started[0];
}

/** #21097's history up to the moment before its new head: two earlier heads, the second unreviewed since 11:18:01Z. */
function seed(ledger: Ledger) {
  const refreshed = pr(21097, at("06:00:00"), "2be9c05");
  const competitor = pr(21112, at("11:42:00"), "head-21112");
  ledger.observe(at("06:24:40"), [refreshed]);
  const unreviewed = { ...refreshed, headSha: "ba824f8", lastActivityAt: at("11:18:00") };
  ledger.observe(at("11:18:01"), [unreviewed]);
  ledger.observe(at("11:42:00"), [competitor]);
  return { unreviewed, competitor, updated: { ...unreviewed, headSha: "bb74b21", lastActivityAt: UPDATED_AT } };
}

/** The PR at a head someone other than the sweep's update produced. */
const pushedHead = (view: OpenPrView, sha: string, ts: string): OpenPrView => ({ ...view, headSha: sha, lastActivityAt: ts });

async function withFixture(body: (ledger: Ledger) => Promise<void>): Promise<void> {
  const ledger = fixtureLedger();
  try {
    await body(ledger);
  } finally {
    ledger.cleanup();
  }
}

// W1-T15162 criterion 1 in test/review/a-sweep-branch-update-keeps-the-review-queue-place.test.ts
test("W1-T15162 criterion 1: a head the sweep's branch update made keeps the unreviewed earlier head's queue place", async () => {
  // The reviewer's probe: GitHub applies the update 600ms after accepting it, so two reads still name ba824f8. The
  // poll backs off and the third read sees bb74b21, whose own parents [ba824f8, main] prove it is the update's merge.
  await withFixture(async (ledger) => {
    const { unreviewed, competitor, updated } = seed(ledger);
    const gh = fakeGitHubPullRequest({ ...AT_BA824F8, update: { ...MERGE_BB74B21, lagMs: 600 } });
    const { row, reads, waits, parentReads } = await sweepUpdate(ledger, unreviewed, gh);
    assert.equal(reads, 3, "read A, A, then B");
    assert.deepEqual(waits, UPDATE_HEAD_POLL_WAITS_MS.slice(0, 2), "the poll backed off between the lagging reads");
    assert.deepEqual(parentReads, ["bb74b21"], "B was confirmed by its commit's parent list");
    assert.equal(row.new_head_sha, "bb74b21");
    assert.equal(row.update_head_unconfirmed, undefined);
    assert.equal(ledger.keyOf(at("12:50:00"), updated), at("11:18:01"), "before its own eligibility it already holds A's key");
    ledger.observe(at("12:54:33"), [updated]);
    assert.equal(ledger.keyOf(at("13:22:05"), updated), at("11:18:01"), "B's admission key is A's first eligibility");
    assert.equal(ledger.keyOf(at("13:22:05"), competitor), undefined, "the competitor keeps its createdAt, 11:42Z");
    assert.equal(await lightFirst(ledger, at("13:22:05"), [updated, competitor]), 21097,
      "the updated head queues from 11:18:01Z, ahead of the input first eligible at 11:42Z");
    assert.equal(await fullFirst(ledger, at("13:22:05"), [updated, competitor]), 21097,
      "the full pass ranks the updated head on the same inherited key");
  });

  // A longer lag: the merge lands 1.5s after acceptance, so three reads name ba824f8 before bb74b21.
  await withFixture(async (ledger) => {
    const { unreviewed, updated } = seed(ledger);
    const gh = fakeGitHubPullRequest({ ...AT_BA824F8, update: { ...MERGE_BB74B21, lagMs: 1500 } });
    const { row, reads, waits } = await sweepUpdate(ledger, unreviewed, gh);
    assert.equal(reads, 4);
    assert.deepEqual(waits, UPDATE_HEAD_POLL_WAITS_MS.slice(0, 3));
    assert.equal(row.new_head_sha, "bb74b21");
    ledger.observe(at("12:54:33"), [updated]);
    assert.equal(ledger.keyOf(at("13:22:05"), updated), at("11:18:01"));
  });

  // A stale replica: the merge has already landed, but the next three reads still return ba824f8.
  await withFixture(async (ledger) => {
    const { unreviewed, competitor, updated } = seed(ledger);
    const stale = { stale: "ba824f8" };
    const gh = fakeGitHubPullRequest({
      ...AT_BA824F8, update: { ...MERGE_BB74B21, lagMs: 0 }, readsAfterUpdate: [stale, stale, stale],
    });
    const { row, reads, parentReads } = await sweepUpdate(ledger, unreviewed, gh);
    assert.equal(reads, 4, "three stale reads of A, then B");
    assert.deepEqual(parentReads, ["bb74b21"]);
    assert.equal(row.new_head_sha, "bb74b21");
    ledger.observe(at("12:54:33"), [updated]);
    assert.equal(ledger.keyOf(at("13:22:05"), updated), at("11:18:01"));
    assert.equal(await lightFirst(ledger, at("13:22:05"), [updated, competitor]), 21097);
  });

  // A current first read confirms the merge with no wait.
  await withFixture(async (ledger) => {
    const { unreviewed, updated } = seed(ledger);
    const gh = fakeGitHubPullRequest({ ...AT_BA824F8, update: { ...MERGE_BB74B21, lagMs: 0 } });
    const { row, reads, waits } = await sweepUpdate(ledger, unreviewed, gh);
    assert.equal(reads, 1);
    assert.deepEqual(waits, []);
    assert.equal(row.new_head_sha, "bb74b21");
    ledger.observe(at("12:54:33"), [updated]);
    assert.equal(ledger.keyOf(at("13:22:05"), updated), at("11:18:01"));
  });

  // A PR's first eligible head has no earlier head key to recurse to. Its inherited key is
  // still its first eligibility, rather than the PR's older createdAt.
  await withFixture(async (ledger) => {
    const firstHead = pr(21097, at("06:00:00"), "first-unreviewed-head");
    const competitor = pr(21112, at("11:42:00"), "head-21112");
    ledger.observe(at("12:00:00"), [firstHead]);
    ledger.observe(at("11:42:00"), [competitor]);
    const updated = pushedHead(firstHead, "first-head-update", UPDATED_AT);
    const gh = fakeGitHubPullRequest({
      ...AT_BA824F8, head: firstHead.headSha, update: { ...MERGE_BB74B21, merge: updated.headSha, lagMs: 400 },
    });
    const { row } = await sweepUpdate(ledger, firstHead, gh);
    assert.equal(row.new_head_sha, "first-head-update");
    ledger.observe(at("12:54:33"), [updated]);
    assert.equal(ledger.keyOf(at("13:22:05"), updated), at("12:00:00"), "the first head's eligibility, not createdAt 06:00Z");
    assert.equal(await lightFirst(ledger, at("13:22:05"), [updated, competitor]), 21112,
      "the first head's 12:00Z eligibility precedes createdAt and places the competitor first at 11:42Z");
  });
});

// W1-T15162 criterion 2 in test/review/a-sweep-branch-update-keeps-the-review-queue-place.test.ts
test("W1-T15162 criterion 2: invariant a-new-head-of-new-work-requeues — a pushed head, or one after a judged head, keeps its own eligibility", async () => {
  // The reviewer's probe: an author commits C on ba824f8 and pushes 200ms after GitHub accepted the update, before
  // the update's merge lands (GitHub then drops it). The reads go A, then C: C's first parent IS ba824f8, but it is an
  // ordinary one-parent commit, not the update's merge, so it is not credited and keeps its own 12:54:33Z key.
  await withFixture(async (ledger) => {
    const { unreviewed, competitor, updated } = seed(ledger);
    const gh = fakeGitHubPullRequest({ ...AT_BA824F8, update: { ...MERGE_BB74B21, lagMs: 300 } });
    const { row, reads, parentReads } = await sweepUpdate(ledger, unreviewed, gh,
      () => gh.push("human-push-c", ["ba824f8"], 200));
    assert.equal(gh.head(), "human-push-c", "the push landed and GitHub dropped the update's merge");
    assert.equal(reads, 2, "read A, then C");
    assert.deepEqual(parentReads, ["human-push-c"]);
    assert.equal(row.new_head_sha, undefined, "C is not recorded as the update's head");
    assert.match(String(row.update_head_unconfirmed), /human-push-c is not a merge onto ba824f8/);
    const pushed = pushedHead(updated, "human-push-c", at("12:41:24"));
    ledger.observe(at("12:54:33"), [pushed]);
    assert.equal(ledger.keyOf(at("13:22:05"), pushed), at("12:54:33"), "C keeps its own W1-T14073 first eligibility");
    assert.equal(await lightFirst(ledger, at("13:22:05"), [pushed, competitor]), 21112,
      "C queues from 12:54:33Z, behind the input first eligible at 11:42Z");
    assert.equal(await fullFirst(ledger, at("13:22:05"), [pushed, competitor]), 21112);
  });

  // The update's merge B lands at 300ms and a human pushes C on top of B at 400ms, between the update and the read
  // that would have confirmed B. C's first parent is B, not ba824f8: C keeps its own key.
  await withFixture(async (ledger) => {
    const { unreviewed, competitor, updated } = seed(ledger);
    const gh = fakeGitHubPullRequest({ ...AT_BA824F8, update: { ...MERGE_BB74B21, lagMs: 300 } });
    const { row, reads, waits } = await sweepUpdate(ledger, unreviewed, gh, () => gh.push("human-push-c", ["bb74b21"], 400));
    assert.equal(reads, 3, "read A, A, then C");
    assert.deepEqual(waits, UPDATE_HEAD_POLL_WAITS_MS.slice(0, 2));
    assert.equal(row.new_head_sha, undefined);
    const pushed = pushedHead(updated, "human-push-c", at("12:41:30"));
    ledger.observe(at("12:54:33"), [pushed]);
    assert.equal(ledger.keyOf(at("13:22:05"), pushed), at("12:54:33"));
    assert.equal(await lightFirst(ledger, at("13:22:05"), [pushed, competitor]), 21112);
  });

  // A fix round pushes on the update's merge in the same instant GitHub accepted it, before even the first read.
  await withFixture(async (ledger) => {
    const { unreviewed, competitor, updated } = seed(ledger);
    const gh = fakeGitHubPullRequest({ ...AT_BA824F8, update: { ...MERGE_BB74B21, lagMs: 0 } });
    const { row, reads } = await sweepUpdate(ledger, unreviewed, gh, () => gh.push("fix-1", ["bb74b21"]));
    assert.equal(reads, 1);
    assert.equal(row.new_head_sha, undefined);
    const fixed = pushedHead(updated, "fix-1", UPDATED_AT);
    ledger.observe(at("12:54:33"), [fixed]);
    assert.equal(ledger.keyOf(at("13:22:05"), fixed), at("12:54:33"));
    assert.equal(await lightFirst(ledger, at("13:22:05"), [fixed, competitor]), 21112);
  });

  // A read that fails (ok:false), throws, or names a commit GitHub has no parent list for confirms nothing, and the
  // head that is eligible next keeps its own key.
  for (const read of ["unreadable", new Error("HTTP 502"), { stale: "unknown-commit" }] satisfies FakePullHeadRead[]) {
    await withFixture(async (ledger) => {
      const { unreviewed, updated } = seed(ledger);
      const gh = fakeGitHubPullRequest({
        ...AT_BA824F8, update: { ...MERGE_BB74B21, lagMs: 0 }, readsAfterUpdate: [read],
      });
      const { row, reads } = await sweepUpdate(ledger, unreviewed, gh);
      assert.equal(reads, 1, `one read: ${String(read instanceof Error ? read.message : JSON.stringify(read))}`);
      assert.equal(row.new_head_sha, undefined);
      assert.equal(typeof row.update_head_unconfirmed, "string");
      const pushed = pushedHead(updated, "human-push-c", at("12:50:00"));
      ledger.observe(at("12:54:33"), [pushed]);
      assert.equal(ledger.keyOf(at("13:22:05"), pushed), at("12:54:33"));
    });
  }

  // The bound: GitHub has not applied the update within the poll's whole backoff. Nothing is confirmed, and the merge
  // that lands later is read as any other new head, with its own key.
  await withFixture(async (ledger) => {
    const { unreviewed, updated } = seed(ledger);
    const gh = fakeGitHubPullRequest({ ...AT_BA824F8, update: { ...MERGE_BB74B21, lagMs: 60_000 } });
    const { row, reads, waits } = await sweepUpdate(ledger, unreviewed, gh);
    assert.equal(reads, UPDATE_HEAD_POLL_WAITS_MS.length + 1);
    assert.deepEqual(waits, [...UPDATE_HEAD_POLL_WAITS_MS]);
    assert.equal(row.new_head_sha, undefined);
    assert.match(String(row.update_head_unconfirmed), /still ba824f8/);
    await gh.wait(60_000);
    assert.equal(gh.head(), "bb74b21");
    ledger.observe(at("12:54:33"), [updated]);
    assert.equal(ledger.keyOf(at("13:22:05"), updated), at("12:54:33"));
  });

  // The confirmed head was eligible, then an author pushes C on top of it: B keeps A's key, C its own.
  await withFixture(async (ledger) => {
    const { unreviewed, updated } = seed(ledger);
    const gh = fakeGitHubPullRequest({ ...AT_BA824F8, update: { ...MERGE_BB74B21, lagMs: 0 } });
    await sweepUpdate(ledger, unreviewed, gh);
    ledger.observe(at("12:54:33"), [updated]);
    const pushed = pushedHead(updated, "author-push-c", at("13:05:00"));
    ledger.observe(at("13:10:00"), [pushed]);
    assert.equal(ledger.keyOf(at("13:22:05"), updated), at("11:18:01"));
    assert.equal(ledger.keyOf(at("13:22:05"), pushed), at("13:10:00"), "the author push is new work");
  });

  // A head with no sweep update row is new work.
  await withFixture(async (ledger) => {
    const { competitor, updated } = seed(ledger);
    ledger.observe(at("12:54:33"), [updated]);
    assert.equal(ledger.keyOf(at("13:22:05"), updated), at("12:54:33"));
    assert.equal(await lightFirst(ledger, at("13:22:05"), [updated, competitor]), 21112,
      "a new head with no sweep update before it queues from 12:54:33Z, behind 11:42Z");
  });

  // The sweep updated a head that already had a verdict: the confirmed merge is a re-review and queues from its own time.
  await withFixture(async (ledger) => {
    const { unreviewed, competitor, updated } = seed(ledger);
    appendAt(ledger.ledgerPath, {
      run_id: "sweep-update-queue-test", task_id: "W1-T21097", step: "review.posted", state: "failure",
      pr_url: "https://github.com/o/r/pull/21097", head_sha: "ba824f8",
    }, at("12:00:00"));
    const gh = fakeGitHubPullRequest({ ...AT_BA824F8, update: { ...MERGE_BB74B21, lagMs: 0 } });
    const { row } = await sweepUpdate(ledger, unreviewed, gh);
    assert.equal(row.new_head_sha, "bb74b21");
    ledger.observe(at("12:54:33"), [updated]);
    assert.equal(ledger.keyOf(at("13:22:05"), updated), at("12:54:33"));
    assert.equal(await lightFirst(ledger, at("13:22:05"), [updated, competitor]), 21112,
      "the earlier head was judged, so the updated head keeps its own 12:54:33Z key");
  });

  // A fix round dispatched after an update whose head read failed: the fix's head is new work.
  await withFixture(async (ledger) => {
    const { unreviewed, competitor, updated } = seed(ledger);
    const gh = fakeGitHubPullRequest({
      ...AT_BA824F8, update: { ...MERGE_BB74B21, lagMs: 0 }, readsAfterUpdate: ["unreadable"],
    });
    await sweepUpdate(ledger, unreviewed, gh);
    appendAt(ledger.ledgerPath, {
      run_id: "sweep-update-queue-test", task_id: "W1-T21097", step: "fix.dispatch", head_sha: "ba824f8",
    }, at("12:45:00"));
    const fixed = pushedHead(updated, "fix-1", at("12:54:00"));
    ledger.observe(at("12:54:33"), [fixed]);
    assert.equal(ledger.keyOf(at("13:22:05"), fixed), at("12:54:33"));
    assert.equal(await lightFirst(ledger, at("13:22:05"), [fixed, competitor]), 21112,
      "a head after a fix dispatch queues from its own eligibility");
  });
});
