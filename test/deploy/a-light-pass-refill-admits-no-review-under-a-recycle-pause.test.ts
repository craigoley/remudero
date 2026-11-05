import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import {
  DEFAULT_SWEEP_POLICY, drainInFlightReviews, inFlightReviewCount, runSweepLightPass,
  type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const RECYCLE_REASON = "container recycle (deploy/recycle-container.sh)";
const RECYCLE_DETAIL = `PAUSE requested: ${RECYCLE_REASON}`;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function eventually(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail("the expected refill outcome did not arrive");
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recycle-refill-`));
  const state = join(root, "state");
  mkdirSync(state);
  const now = Date.now();
  const prs: OpenPrView[] = [1, 2, 3, 4].map((n) => ({
    prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, taskId: `W1-T${n}`,
    headSha: `head-${n}`, reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    createdAt: new Date(now - (10 - n) * 60_000).toISOString(),
    lastActivityAt: new Date(now - n * 60_000).toISOString(),
  }));
  const releases = new Map<number, () => void>();
  const gates = new Map(prs.map((pr) => [pr.prNumber,
    new Promise<void>((resolve) => releases.set(pr.prNumber, resolve))]));
  const started: number[] = [];
  const finished: number[] = [];
  const rows: Record<string, unknown>[] = [];
  const deps: SweepDeps = {
    ledgerPath: join(state, "ledger.ndjson"), runId: "recycle-refill", now: () => now,
    readLedger: () => [], appendLine: (_path, row) => { rows.push(row); },
    readActiveWorkerCount: () => 0,
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    postReview: async (pr) => {
      started.push(pr.prNumber);
      await gates.get(pr.prNumber);
      finished.push(pr.prNumber);
    },
  };
  t.after(async () => {
    for (const release of releases.values()) release();
    await drainInFlightReviews({ boundMs: 1000 });
    rmSync(root, { recursive: true, force: true });
    assert.equal(inFlightReviewCount(), 0);
  });
  return {
    deps, prs, started, finished, rows,
    pause: (reason: string) => writeFileSync(join(state, "PAUSE"), JSON.stringify({
      reason, requestedAt: new Date().toISOString(), pid: process.pid, host: "fixture",
    })),
    resume: () => rmSync(join(state, "PAUSE")),
    release: (n: number) => releases.get(n)!(),
    start: async () => {
      await runSweepLightPass(prs, deps, {
        ...DEFAULT_SWEEP_POLICY, reviewLanes: 2, reviewLaneMin: 1, reviewLaneMax: 2,
      });
      await eventually(() => started.length === 2);
      assert.deepEqual(started, [1, 2], "the pass admitted reviews before the pause");
    },
  };
}

describe("test/deploy/a-light-pass-refill-admits-no-review-under-a-recycle-pause.test.ts", () => {
  for (const source of ["local", "injected", "fleet-prefixed"] as const) {
    test(`a ${source} recycle pause holds a running pass's freed lanes and names why once`, async (t) => {
      const h = fixture(t);
      let detail: string | undefined;
      if (source !== "local") h.deps.workerAdmissionHold = () => detail;
      await h.start();
      if (source === "local") h.pause(RECYCLE_REASON);
      else detail = `${source === "fleet-prefixed" ? "fleet PAUSE hold: " : ""}${RECYCLE_DETAIL}; actor: operator@fleet`;
      h.release(1);
      await eventually(() => h.rows.some((row) => row.step === "sweep.review_refill_held"));
      h.release(2);
      await eventually(() => h.finished.length === 2 && inFlightReviewCount() === 0);
      for (let i = 0; i < 5; i++) await settle();
      assert.deepEqual(h.started, [1, 2], "the recycle drain gets no new reviewer");
      assert.deepEqual(h.rows.filter((row) => row.step === "sweep.review_refilled"), []);
      const held = h.rows.filter((row) => row.step === "sweep.review_refill_held");
      assert.equal(held.length, 1, "multiple freed lanes produce one hold row per pass");
      assert.equal(held[0].reason, "recycle_pause");
      assert.equal(held[0].run_id, h.deps.runId);
      assert.match(String(held[0].detail), /^PAUSE requested: container recycle/);
    });
  }

  for (const reason of [undefined, "investigating an incident", `${RECYCLE_REASON} (operator)`]) {
    test(`a freed lane still refills with ${reason ?? "no pause"}`, async (t) => {
      const h = fixture(t);
      await h.start();
      if (reason !== undefined) h.pause(reason);
      h.release(1);
      await eventually(() => h.started.includes(3));
      assert.deepEqual(h.started, [1, 2, 3], "the same next head takes the freed lane");
      assert.deepEqual(h.rows.filter((row) => row.step === "sweep.review_refilled").map((row) => row.pr_number), [3]);
      assert.deepEqual(h.rows.filter((row) => row.step === "sweep.review_refill_held"), []);
    });
  }

  test("a recycle pause clearing lets the same pass refill its next freed lane", async (t) => {
    const h = fixture(t);
    let detail: string | undefined;
    h.deps.workerAdmissionHold = () => detail;
    await h.start();
    detail = RECYCLE_DETAIL;
    h.release(1);
    await eventually(() => h.rows.some((row) => row.step === "sweep.review_refill_held"));
    detail = undefined;
    h.release(2);
    await eventually(() => h.started.includes(3));
    assert.equal(h.rows.filter((row) => row.step === "sweep.review_refill_held").length, 1);
  });

  for (const at of ["queue refresh", "live head read"] as const) {
    test(`a recycle pause beginning during the refill's ${at} prevents admission`, async (t) => {
      const h = fixture(t);
      if (at === "queue refresh") h.deps.readOpenPrsForRefill = async () => {
        await settle();
        h.pause(RECYCLE_REASON);
        return h.prs;
      };
      else h.deps.readLiveHeadSha = async (pr) => {
        await settle();
        h.pause(RECYCLE_REASON);
        return pr.headSha;
      };
      await h.start();
      h.release(1);
      await eventually(() => h.rows.some((row) => row.step === "sweep.review_refill_held"));
      assert.deepEqual(h.started, [1, 2]);
      assert.deepEqual(h.rows.filter((row) => row.step === "sweep.review_refilled"), []);
      h.resume();
      h.deps.readOpenPrsForRefill = undefined;
      h.deps.readLiveHeadSha = undefined;
      h.release(2);
      await eventually(() => h.started.includes(3));
      assert.equal(h.started[2], 3, "the held candidate keeps its place when the pause clears");
    });
  }
});
