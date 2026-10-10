/**
 * test/the-full-pass-admits-reviews-under-the-same-width-the-light-pass-respects.test.ts — W1-T5931.
 *
 * THE DEFECT. The light pass admits reviews under `effectiveReviewWidth` minus its in-flight
 * reservations (W1-T4732); runSweep's full pass did not subtract them, so it started up to the whole
 * width on top of light reviews still running (#9373, 2026-10-05: four light stand-downs at bound 0,
 * then admitted by the full pass over the same in-flight set).
 *
 * THE FIX. Both sites read one helper, `reviewAdmissionBound`, over one process-wide in-flight count
 * (light reservations plus full-pass reviews), and both stand-down rows name the bound and in-flight.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readLedgerLines } from "../src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY,
  reviewAdmissionBound,
  runSweep,
  runSweepLightPass,
  withFullSweepRepairAdmission,
  type OpenPrView,
  type SweepDeps,
  type SweepPolicy,
} from "./helpers/sweep-test.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");

function width(n: number): SweepPolicy {
  return { ...DEFAULT_SWEEP_POLICY, reviewLanes: n, reviewLaneMin: n, reviewLaneMax: n };
}

/** Green with no review yet: disposition `post-review`. */
function eligiblePr(prNumber: number, createdAt: string): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    taskId: `W1-T${prNumber}`,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    headSha: `head${prNumber}`,
    autoMergeArmed: false,
    isPlanFiling: false,
    createdAt,
  };
}

interface Harness {
  deps: SweepDeps;
  started: number[];
  /** Releases one held review; a PR never held settles at once. */
  release: (prNumber: number) => void;
}

function harness(held: readonly number[] = []): Harness {
  const started: number[] = [];
  const gates = new Map<number, { promise: Promise<void>; resolve: () => void }>();
  for (const n of held) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    gates.set(n, { promise, resolve });
  }
  const deps: SweepDeps = {
    log: () => {},
    arm: () => "armed",
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: async (p) => {
      started.push(p.prNumber);
      await gates.get(p.prNumber)?.promise;
    },
    ledgerPath: join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5931-`)), "ledger.ndjson"),
    runId: "SWEEP-T5931-1",
    now: () => NOW,
  };
  return { deps, started, release: (n) => gates.get(n)?.resolve() };
}

function disposed(deps: SweepDeps, prNumber: number): Record<string, unknown> | undefined {
  return readLedgerLines(deps.ledgerPath).findLast((l) => l.step === "sweep.disposed" && l.pr_number === prNumber);
}

function admitted(deps: SweepDeps, prNumber: number): Record<string, unknown> | undefined {
  return readLedgerLines(deps.ledgerPath).find((l) => l.step === "sweep.review_admitted" && l.pr_number === prNumber);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

test("a busy width stands the full pass down exactly as it stands the light pass down, naming the bound and in-flight count", async () => {
  const h = harness([9301]);
  await runSweepLightPass([eligiblePr(9301, "2026-10-06T09:00:00Z")], h.deps, width(1));
  assert.deepEqual(h.started, [9301], "the light review holds the only slot");
  assert.deepEqual(reviewAdmissionBound(1), { bound: 0, inFlight: 1 });

  await runSweep([eligiblePr(9302, "2026-10-06T10:00:00Z")], withFullSweepRepairAdmission(h.deps), width(1));
  assert.deepEqual(h.started, [9301], "the full pass starts no review over the light one");
  assert.equal(admitted(h.deps, 9302), undefined, "no admission row for the refused review");
  const full = disposed(h.deps, 9302);
  assert.equal(full?.acted, false);
  assert.equal(full?.stand_down_reason, "not admitted this pass: semantic post-review admission bound 0, in-flight 1");

  await runSweepLightPass([eligiblePr(9303, "2026-10-06T11:00:00Z")], h.deps, width(1));
  assert.deepEqual(h.started, [9301]);
  assert.equal(disposed(h.deps, 9303)?.stand_down_reason, "not admitted this pass: semantic post-review admission bound 0, in-flight 1");

  h.release(9301);
  await settle();
  assert.deepEqual(reviewAdmissionBound(1), { bound: 1, inFlight: 0 }, "the light reservation is returned");
});

test("a free slot admits on either surface, and the light pass counts a running full-pass review", async () => {
  const h = harness([9311, 9312]);
  await runSweepLightPass([eligiblePr(9311, "2026-10-06T09:00:00Z")], h.deps, width(2));
  const fullPass = runSweep([eligiblePr(9312, "2026-10-06T10:00:00Z")], withFullSweepRepairAdmission(h.deps), width(2));
  await settle();
  assert.deepEqual(h.started, [9311, 9312], "one slot was free, so the full pass took it");
  assert.equal(admitted(h.deps, 9312)?.surface, "full");
  assert.deepEqual(reviewAdmissionBound(2), { bound: 0, inFlight: 2 });

  await runSweepLightPass([eligiblePr(9313, "2026-10-06T11:00:00Z")], h.deps, width(2));
  assert.deepEqual(h.started, [9311, 9312], "the full pass's review fills the light pass's width too");
  assert.equal(disposed(h.deps, 9313)?.stand_down_reason, "not admitted this pass: semantic post-review admission bound 0, in-flight 2");

  h.release(9311);
  h.release(9312);
  await fullPass;
  await settle();
  assert.equal(disposed(h.deps, 9312)?.acted, true);
  assert.deepEqual(reviewAdmissionBound(2), { bound: 2, inFlight: 0 }, "the full-pass slot is returned");
});

test("a light reservation released mid-pass frees a full-pass slot", async () => {
  const h = harness([9321, 9322, 9323]);
  await runSweepLightPass([eligiblePr(9321, "2026-10-06T09:00:00Z")], h.deps, width(2));
  const fullPass = runSweep(
    [eligiblePr(9323, "2026-10-06T10:30:00Z"), eligiblePr(9322, "2026-10-06T10:00:00Z")],
    withFullSweepRepairAdmission(h.deps),
    width(2),
  );
  await settle();
  assert.deepEqual(h.started, [9321, 9322], "the oldest full-pass review takes the one free slot");
  assert.equal(disposed(h.deps, 9323), undefined, "the next review waits for a slot, not stood down");

  h.release(9321);
  await settle();
  assert.deepEqual(h.started, [9321, 9322, 9323], "the released light slot starts it while #9322 still runs");

  h.release(9322);
  h.release(9323);
  await fullPass;
  assert.equal(disposed(h.deps, 9323)?.acted, true);
  assert.equal(disposed(h.deps, 9323)?.stand_down_reason, undefined);
  assert.deepEqual(reviewAdmissionBound(2), { bound: 2, inFlight: 0 });
});

test("with nothing in flight, the light pass's bound and its loser's row are unchanged", async () => {
  const h = harness();
  await runSweepLightPass(
    [eligiblePr(9332, "2026-10-06T10:00:00Z"), eligiblePr(9331, "2026-10-06T09:00:00Z")],
    h.deps,
    width(1),
  );
  assert.deepEqual(h.started, [9331]);
  assert.equal(admitted(h.deps, 9331)?.surface, "light");
  assert.equal(
    disposed(h.deps, 9332)?.stand_down_reason,
    "not admitted this pass: semantic post-review admission bound 1; admitted #9331 ahead",
  );
  await settle();
  assert.deepEqual(reviewAdmissionBound(1), { bound: 1, inFlight: 0 });
});

test("with nothing in flight, a full pass still drains every eligible review through its own width", async () => {
  const h = harness();
  await runSweep(
    [eligiblePr(9342, "2026-10-06T10:00:00Z"), eligiblePr(9341, "2026-10-06T09:00:00Z")],
    withFullSweepRepairAdmission(h.deps),
    width(1),
  );
  assert.deepEqual(h.started, [9341, 9342], "one lane, both reviews, oldest first");
  assert.equal(disposed(h.deps, 9342)?.acted, true);
  assert.deepEqual(reviewAdmissionBound(1), { bound: 1, inFlight: 0 });
});
