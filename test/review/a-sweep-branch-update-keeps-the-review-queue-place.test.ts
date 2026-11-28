import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import {
  DEFAULT_SWEEP_POLICY, drainInFlightReviews, lightPassReviewQueuedAt, observeLightPassReviewEligibility, runSweep,
  runSweepLightPass, type LiveStateResult, type OpenPrView, type SweepDeps,
} from "#test/helpers/sweep-test.js";

// W1-T15162: a head made by the sweep's own branch update keeps the review queue place of the unreviewed head it
// replaced. The fixture is #21097's rows of 2026-11-27: eligible at ba824f8 from 11:18:01Z, a sweep branch update to
// bb74b21 at 12:41:24Z, bb74b21 first eligible at 12:54:33Z, and a PR first eligible at 11:42Z competing for one slot.
// Every `sweep.update_branch.updated` row below is written by runSweep's own update-branch lane, never by hand: the
// live head read after the update is a stub that can lag (still naming the old head), fail (ok:false) or throw.

const at = (hms: string): string => `2026-11-27T${hms}.000Z`;
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const ONE_LANE = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1, reviewLaneMin: 1, reviewLaneMax: 1 };
const UPDATE_POLICY = { ...ONE_LANE, reviewWaitingBranchRefreshEnabled: true, reviewWaitingBranchRefreshThreshold: 10 };

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

/** One live head read after the update settles: a result, or an error the read throws. */
type PostUpdateRead = LiveStateResult | Error;

/** Drives the real full-sweep update-branch lane on `view` (17 commits behind main, a distance refresh) at `ts`.
 *  `reads` answers each live head read made after GitHub accepted the update; an exhausted list answers ok:false. */
async function sweepUpdate(ledger: Ledger, ts: string, view: OpenPrView, reads: PostUpdateRead[]) {
  ledger.setClock(ts);
  let updated = 0;
  let postUpdateReads = 0;
  const queue = [...reads];
  const deps: SweepDeps = {
    ...ledger.baseDeps(),
    behindMainByPr: new Map([[view.prNumber, 17]]),
    updateBranch: (target) => {
      assert.equal(target.headSha, view.headSha);
      updated++;
      return "updated";
    },
    readLiveState: (p) => {
      if (updated === 0) return { ok: true, state: "OPEN", headSha: p.headSha };
      postUpdateReads++;
      const next = queue.shift() ?? { ok: false };
      if (next instanceof Error) throw next;
      return next;
    },
  };
  await runSweep([view], deps, UPDATE_POLICY);
  assert.equal(updated, 1, "the sweep's own update-branch lane pressed the update");
  const row = ledger.rows().findLast((r) => r.step === "sweep.update_branch.updated" && r.pr_number === view.prNumber);
  assert.ok(row, "the update lane wrote its sweep.update_branch.updated row");
  assert.equal(row.head_sha, view.headSha);
  assert.notEqual(row.new_head_sha, view.headSha, "a lagging read never records the old head as the update's head");
  return { row, postUpdateReads };
}

const open = (headSha: string): LiveStateResult => ({ ok: true, state: "OPEN", headSha });

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
  return { unreviewed, competitor, updated: { ...unreviewed, headSha: "bb74b21", lastActivityAt: at("12:41:24") } };
}

/** A head someone other than the sweep's update produced, after the update. */
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
  // GitHub's update-branch is asynchronous: the first live read still names ba824f8. The lag guard re-reads and
  // confirms bb74b21, so bb74b21 queues on ba824f8's 11:18:01Z key, ahead of the input first eligible at 11:42Z.
  await withFixture(async (ledger) => {
    const { unreviewed, competitor, updated } = seed(ledger);
    const { row, postUpdateReads } = await sweepUpdate(ledger, at("12:41:24"), unreviewed, [open("ba824f8"), open("bb74b21")]);
    assert.equal(postUpdateReads, 2, "the lagging read was re-read once");
    assert.equal(row.new_head_sha, "bb74b21");
    assert.equal(ledger.keyOf(at("12:50:00"), updated), at("11:18:01"), "before its own eligibility it already holds A's key");
    ledger.observe(at("12:54:33"), [updated]);
    assert.equal(ledger.keyOf(at("13:22:05"), updated), at("11:18:01"), "B's admission key is A's first eligibility");
    assert.equal(ledger.keyOf(at("13:22:05"), competitor), undefined, "the competitor keeps its createdAt, 11:42Z");
    assert.equal(await lightFirst(ledger, at("13:22:05"), [updated, competitor]), 21097,
      "the updated head queues from 11:18:01Z, ahead of the input first eligible at 11:42Z");
    assert.equal(await fullFirst(ledger, at("13:22:05"), [updated, competitor]), 21097,
      "the full pass ranks the updated head on the same inherited key");
  });

  // A read that is current on the first try confirms the head with no re-read.
  await withFixture(async (ledger) => {
    const { unreviewed, updated } = seed(ledger);
    const { row, postUpdateReads } = await sweepUpdate(ledger, at("12:41:24"), unreviewed, [open("bb74b21")]);
    assert.equal(postUpdateReads, 1);
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
    const updated = pushedHead(firstHead, "first-head-update", at("12:41:24"));
    await sweepUpdate(ledger, at("12:41:24"), firstHead, [open(firstHead.headSha), open(updated.headSha)]);
    ledger.observe(at("12:54:33"), [updated]);
    assert.equal(ledger.keyOf(at("13:22:05"), updated), at("12:00:00"), "the first head's eligibility, not createdAt 06:00Z");
    assert.equal(await lightFirst(ledger, at("13:22:05"), [updated, competitor]), 21112,
      "the first head's 12:00Z eligibility precedes createdAt and places the competitor first at 11:42Z");
  });
});

// W1-T15162 criterion 2 in test/review/a-sweep-branch-update-keeps-the-review-queue-place.test.ts
test("W1-T15162 criterion 2: invariant a-new-head-of-new-work-requeues — a pushed head, or one after a judged head, keeps its own eligibility", async () => {
  // The live read fails (ok:false) after the update: the row confirms no head, and a human push C that lands before
  // the update's head is ever eligible keeps its own key instead of being taken for the update's head.
  await withFixture(async (ledger) => {
    const { unreviewed, competitor, updated } = seed(ledger);
    const { row } = await sweepUpdate(ledger, at("12:41:24"), unreviewed, [{ ok: false }]);
    assert.equal(row.new_head_sha, undefined, "an unread live head confirms nothing");
    const pushed = pushedHead(updated, "human-push-c", at("12:50:00"));
    ledger.observe(at("12:54:33"), [pushed]);
    assert.equal(ledger.keyOf(at("13:22:05"), pushed), at("12:54:33"), "C keeps its own W1-T14073 first eligibility");
    assert.equal(await lightFirst(ledger, at("13:22:05"), [pushed, competitor]), 21112,
      "C queues from 12:54:33Z, behind the input first eligible at 11:42Z");
    assert.equal(await fullFirst(ledger, at("13:22:05"), [pushed, competitor]), 21112);
  });

  // The live read lags on every try: the row never records the old head, and the next head confirms nothing.
  await withFixture(async (ledger) => {
    const { unreviewed, updated } = seed(ledger);
    const { row, postUpdateReads } = await sweepUpdate(ledger, at("12:41:24"), unreviewed,
      [open("ba824f8"), open("ba824f8"), open("ba824f8")]);
    assert.equal(postUpdateReads, 2, "one re-read, then the head stays unconfirmed");
    assert.equal(row.new_head_sha, undefined);
    const pushed = pushedHead(updated, "human-push-c", at("12:50:00"));
    ledger.observe(at("12:54:33"), [pushed]);
    assert.equal(ledger.keyOf(at("13:22:05"), pushed), at("12:54:33"));
  });

  // The live read throws after the update: the update stands, its head is unconfirmed.
  await withFixture(async (ledger) => {
    const { unreviewed, updated } = seed(ledger);
    const { row } = await sweepUpdate(ledger, at("12:41:24"), unreviewed, [new Error("HTTP 502")]);
    assert.equal(row.new_head_sha, undefined);
    const pushed = pushedHead(updated, "human-push-c", at("12:50:00"));
    ledger.observe(at("12:54:33"), [pushed]);
    assert.equal(ledger.keyOf(at("13:22:05"), pushed), at("12:54:33"));
  });

  // The row confirms bb74b21, but a human push C lands before bb74b21 is ever eligible: C is the next eligible
  // head, it is not the confirmed one, and it keeps its own key.
  await withFixture(async (ledger) => {
    const { unreviewed, competitor, updated } = seed(ledger);
    await sweepUpdate(ledger, at("12:41:24"), unreviewed, [open("bb74b21")]);
    const pushed = pushedHead(updated, "human-push-c", at("12:50:00"));
    ledger.observe(at("12:54:33"), [pushed]);
    assert.equal(ledger.keyOf(at("13:22:05"), pushed), at("12:54:33"));
    assert.equal(await lightFirst(ledger, at("13:22:05"), [pushed, competitor]), 21112);
  });

  // The confirmed head was eligible, then an author pushes C on top of it: B keeps A's key, C its own.
  await withFixture(async (ledger) => {
    const { unreviewed, updated } = seed(ledger);
    await sweepUpdate(ledger, at("12:41:24"), unreviewed, [open("bb74b21")]);
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

  // The sweep updated a head that already had a verdict: the new head is a re-review and queues from its own time.
  await withFixture(async (ledger) => {
    const { unreviewed, competitor, updated } = seed(ledger);
    appendAt(ledger.ledgerPath, {
      run_id: "sweep-update-queue-test", task_id: "W1-T21097", step: "review.posted", state: "failure",
      pr_url: "https://github.com/o/r/pull/21097", head_sha: "ba824f8",
    }, at("12:00:00"));
    await sweepUpdate(ledger, at("12:41:24"), unreviewed, [open("bb74b21")]);
    ledger.observe(at("12:54:33"), [updated]);
    assert.equal(ledger.keyOf(at("13:22:05"), updated), at("12:54:33"));
    assert.equal(await lightFirst(ledger, at("13:22:05"), [updated, competitor]), 21112,
      "the earlier head was judged, so the updated head keeps its own 12:54:33Z key");
  });

  // A fix round dispatched after an update whose head read failed: the fix's head is new work.
  await withFixture(async (ledger) => {
    const { unreviewed, competitor, updated } = seed(ledger);
    await sweepUpdate(ledger, at("12:41:24"), unreviewed, [{ ok: false }]);
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
