import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  DEFAULT_SWEEP_POLICY, drainInFlightReviews, observeLightPassReviewEligibility, runSweep, runSweepLightPass,
  type OpenPrView, type SweepDeps,
} from "#test/helpers/sweep-test.js";

// W1-T15162: a head made by the sweep's own branch update keeps the review queue place of the unreviewed head it
// replaced. The fixture is #21097's rows of 2026-11-27: eligible at ba824f8 from 11:18:01Z, a sweep branch update to
// bb74b21 at 12:41:24Z, bb74b21 first eligible at 12:54:33Z, and a PR first eligible at 11:42Z competing for one slot.

const at = (hms: string): string => `2026-11-27T${hms}.000Z`;
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const ONE_LANE = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1, reviewLaneMin: 1, reviewLaneMax: 1 };

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
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}sweep-update-queue-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  let clock = at("00:00:00");
  const deps = (started: number[], gate?: Promise<void>): SweepDeps => ({
    ledgerPath, runId: "sweep-update-queue-test", now: () => Date.parse(clock),
    readActiveWorkerCount: () => 0,
    appendLine: (path, row) => appendAt(path, row, clock),
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    postReview: async (p) => {
      started.push(p.prNumber);
      await gate;
    },
  });
  return {
    ledgerPath, deps,
    setClock: (ts: string): void => { clock = ts; },
    observe: (ts: string, prs: OpenPrView[]): void => {
      clock = ts;
      observeLightPassReviewEligibility(prs, deps([]));
    },
    cleanup: (): void => rmSync(dir, { recursive: true, force: true }),
  };
}

async function lightFirst(ledger: ReturnType<typeof fixtureLedger>, ts: string, prs: OpenPrView[]): Promise<number | undefined> {
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

async function fullFirst(ledger: ReturnType<typeof fixtureLedger>, ts: string, prs: OpenPrView[]): Promise<number | undefined> {
  ledger.setClock(ts);
  const started: number[] = [];
  await runSweep(prs, ledger.deps(started), ONE_LANE);
  return started[0];
}

/** #21097's history up to the moment before its new head: two earlier heads, the second unreviewed since 11:18:01Z. */
function seed(ledger: ReturnType<typeof fixtureLedger>) {
  const refreshed = pr(21097, at("06:00:00"), "2be9c05");
  const competitor = pr(21112, at("11:42:00"), "head-21112");
  ledger.observe(at("06:24:40"), [refreshed]);
  const unreviewed = { ...refreshed, headSha: "ba824f8", lastActivityAt: at("11:18:00") };
  ledger.observe(at("11:18:01"), [unreviewed]);
  ledger.observe(at("11:42:00"), [competitor]);
  return { unreviewed, competitor, updated: { ...unreviewed, headSha: "bb74b21", lastActivityAt: at("12:41:24") } };
}

const sweepUpdate = (ledger: ReturnType<typeof fixtureLedger>, from: string, to: string): void =>
  appendAt(ledger.ledgerPath, {
    run_id: "sweep-update-queue-test", task_id: "W1-T21097", step: "sweep.update_branch.updated",
    pr_number: 21097, pr_url: "https://github.com/o/r/pull/21097", head_sha: from, new_head_sha: to,
  }, at("12:41:24"));

// W1-T15162 criterion 1 in test/review/a-sweep-branch-update-keeps-the-review-queue-place.test.ts
test("W1-T15162 criterion 1: a head the sweep's branch update made keeps the unreviewed earlier head's queue place", async () => {
  const ledger = fixtureLedger();
  try {
    const { competitor, updated } = seed(ledger);
    sweepUpdate(ledger, "ba824f8", updated.headSha);
    ledger.observe(at("12:54:33"), [updated]);
    assert.equal(await lightFirst(ledger, at("13:22:05"), [updated, competitor]), 21097,
      "the updated head queues from 11:18:01Z, ahead of the input first eligible at 11:42Z");
    assert.equal(await fullFirst(ledger, at("13:22:05"), [updated, competitor]), 21097,
      "the full pass ranks the updated head on the same inherited key");
  } finally {
    ledger.cleanup();
  }

  // A PR's first eligible head has no earlier head key to recurse to. Its inherited key is
  // still its first eligibility, rather than the PR's older createdAt.
  const firstHeadLedger = fixtureLedger();
  try {
    const firstHead = pr(21097, at("06:00:00"), "first-unreviewed-head");
    const competitor = pr(21112, at("11:42:00"), "head-21112");
    firstHeadLedger.observe(at("12:00:00"), [firstHead]);
    firstHeadLedger.observe(at("11:42:00"), [competitor]);
    const updated = { ...firstHead, headSha: "first-head-update", lastActivityAt: at("12:41:24") };
    sweepUpdate(firstHeadLedger, firstHead.headSha, updated.headSha);
    firstHeadLedger.observe(at("12:54:33"), [updated]);
    assert.equal(await lightFirst(firstHeadLedger, at("13:22:05"), [updated, competitor]), 21112,
      "the first head's 12:00Z eligibility precedes createdAt and places the competitor first at 11:42Z");
  } finally {
    firstHeadLedger.cleanup();
  }
});

// W1-T15162 criterion 2 in test/review/a-sweep-branch-update-keeps-the-review-queue-place.test.ts
test("W1-T15162 criterion 2: invariant a-new-head-of-new-work-requeues — a pushed head, or one after a judged head, keeps its own eligibility", async () => {
  // A head pushed by an author after the sweep's update is distinct from the head the update produced.
  {
    const ledger = fixtureLedger();
    try {
      const { competitor, updated } = seed(ledger);
      sweepUpdate(ledger, "ba824f8", updated.headSha);
      const pushed = { ...updated, headSha: "author-push", lastActivityAt: at("12:50:00") };
      ledger.observe(at("12:54:33"), [pushed]);
      assert.equal(await lightFirst(ledger, at("13:22:05"), [pushed, competitor]), 21112,
        "an author push after the update is new work and queues from its own eligibility");
    } finally {
      ledger.cleanup();
    }
  }
  // A head with no sweep update row is new work.
  {
    const ledger = fixtureLedger();
    try {
      const { competitor, updated } = seed(ledger);
      ledger.observe(at("12:54:33"), [updated]);
      assert.equal(await lightFirst(ledger, at("13:22:05"), [updated, competitor]), 21112,
        "a new head with no sweep update before it queues from 12:54:33Z, behind 11:42Z");
    } finally {
      ledger.cleanup();
    }
  }
  // The sweep updated a head that already had a verdict: the new head is a re-review and queues from its own time.
  {
    const ledger = fixtureLedger();
    try {
      const { competitor, updated } = seed(ledger);
      appendAt(ledger.ledgerPath, {
        run_id: "sweep-update-queue-test", task_id: "W1-T21097", step: "review.posted", state: "failure",
        pr_url: "https://github.com/o/r/pull/21097", head_sha: "ba824f8",
      }, at("12:00:00"));
      sweepUpdate(ledger, "ba824f8", updated.headSha);
      ledger.observe(at("12:54:33"), [updated]);
      assert.equal(await lightFirst(ledger, at("13:22:05"), [updated, competitor]), 21112,
        "the earlier head was judged, so the updated head keeps its own 12:54:33Z key");
    } finally {
      ledger.cleanup();
    }
  }
  // A fix round dispatched after the sweep update: the next eligible head is the fix's new work.
  {
    const ledger = fixtureLedger();
    try {
      const { competitor, updated } = seed(ledger);
      sweepUpdate(ledger, "ba824f8", updated.headSha);
      appendAt(ledger.ledgerPath, {
        run_id: "sweep-update-queue-test", task_id: "W1-T21097", step: "fix.retrigger",
        head_sha: "ba824f8",
      }, at("12:45:00"));
      appendAt(ledger.ledgerPath, {
        run_id: "sweep-update-queue-test", task_id: "W1-T21097", step: "fix.dispatch",
        head_sha: "ba824f8",
      }, at("12:45:00"));
      const fixed = { ...updated, headSha: "fix-1", lastActivityAt: at("12:54:00") };
      ledger.observe(at("12:54:33"), [fixed]);
      assert.equal(await lightFirst(ledger, at("13:22:05"), [fixed, competitor]), 21112,
        "a head after a fix dispatch queues from its own eligibility");
    } finally {
      ledger.cleanup();
    }
  }
});
