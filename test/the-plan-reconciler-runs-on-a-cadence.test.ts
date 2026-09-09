/**
 * W1-T3226 — THE PLAN RECONCILER RUNS ON A CADENCE.
 *
 * `rmd plan-reconcile` existed, was registered, was dispatched and was unit-tested. Nothing
 * scheduled it. MEASURED 2026-09-09: a dry run reported 85 shards credited-merged but still
 * `status: queued`, so the prioritised queue read 21 open when 20 were already on main — including
 * both items an operator asked to start next. Two were checked before building and both were
 * already done and green.
 *
 * WHAT THIS SUITE HOLDS, and the order matters: that the drift COUNT is reported every cycle
 * including zero, that a small drift lands NOTHING, that a large one lands through the caller's
 * seam and never in place, and that a shard the credit predicate refuses is never reconciled at
 * all. Without the last, the suite could not tell "reconciles what is credited" from "reconciles
 * everything", and the second silently empties the queue.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { planReconcileCadence, runMeasurementCadenceReport } from "../src/lib/measurement-cadence.js";
import { makeTempDir } from "../src/lib/tmp.js";

/** A shard record as `reconcilePlan` takes it: an id and the YAML text it will rewrite. */
const shard = (id: string, status = "queued") =>
  ({ taskId: id, text: `- id: ${id}\n  title: t\n  status: ${status}\n` }) as const;

/** Credits exactly the ids named — the predicate `reconcilePlan` already owns, passed through. */
const credits = (...ids: string[]) => (id: string) => ids.includes(id);

test("W1-T3226: the drift count is reported on a clean pass, not only when there is drift", () => {
  // A number nobody sees until it is large is how 85 accumulated.
  const r = planReconcileCadence({
    shards: [shard("W1-T1"), shard("W1-T2")],
    isCreditedMerged: credits(), // nothing credited
    threshold: 5,
  });
  assert.equal(r.drift, 0);
  assert.equal(r.status, "clear");
  assert.deepEqual(r.taskIds, []);
  assert.equal(r.threshold, 5, "the report names the threshold it judged against");
});

test("W1-T3226: BELOW the threshold it reports the drift and lands nothing", () => {
  let landed = 0;
  const r = planReconcileCadence({
    shards: [shard("W1-T1"), shard("W1-T2"), shard("W1-T3")],
    isCreditedMerged: credits("W1-T1", "W1-T2"),
    threshold: 5,
    land: () => void (landed += 1),
  });
  assert.equal(r.status, "reported");
  assert.equal(r.drift, 2);
  assert.deepEqual(r.taskIds, ["W1-T1", "W1-T2"], "and NAMES them — a count alone cannot be checked");
  assert.equal(landed, 0, "a plan diff is not free and must not fire for one stale shard");
});

test("W1-T3226: AT the threshold it lands, through the caller's seam", () => {
  const seen: string[][] = [];
  const r = planReconcileCadence({
    shards: [shard("W1-T1"), shard("W1-T2")],
    isCreditedMerged: credits("W1-T1", "W1-T2"),
    threshold: 2,
    land: (writes) => void seen.push(writes.map((w) => w.taskId)),
  });
  assert.equal(r.status, "landed");
  assert.deepEqual(seen, [["W1-T1", "W1-T2"]], "the rewritten shards reach the landing bridge");
});

test("W1-T3226: with NO landing seam it reports and cannot write, whatever the drift", () => {
  // Report-only BY CONSTRUCTION rather than by a caller remembering: the daemon's own checkout must
  // stay clean, because checkCliFreshness refuses a dirty tree and an in-place write breaks its
  // self-sync. There is no code path here that writes a file.
  const r = planReconcileCadence({
    shards: [shard("W1-T1"), shard("W1-T2"), shard("W1-T3")],
    isCreditedMerged: credits("W1-T1", "W1-T2", "W1-T3"),
    threshold: 1,
  });
  assert.equal(r.status, "reported");
  assert.equal(r.drift, 3, "the drift is still MEASURED — silence about a large drift would be worse");
});

test("W1-T3226: a shard the credit predicate REFUSES is never reconciled, so a false flip cannot hide work", () => {
  // The safety direction. A wrong flip does not make noise — it removes a real task from the queue.
  const seen: string[] = [];
  const r = planReconcileCadence({
    shards: [shard("W1-T1"), shard("W1-T2")],
    isCreditedMerged: credits("W1-T1"), // W1-T2 is NOT credited
    threshold: 1,
    land: (writes) => void seen.push(...writes.map((w) => w.taskId)),
  });
  assert.deepEqual(r.taskIds, ["W1-T1"]);
  assert.deepEqual(seen, ["W1-T1"], "only the credited shard is rewritten");
  assert.ok(!seen.includes("W1-T2"), "an uncredited shard stays queued — stale beats hidden");
});

test("W1-T3226: a shard that is already merged is not re-reconciled, so the count means what it says", () => {
  // Without this, `drift` would count settled shards every cycle and no threshold could be chosen.
  const r = planReconcileCadence({
    shards: [shard("W1-T1", "merged"), shard("W1-T2", "queued")],
    isCreditedMerged: credits("W1-T1", "W1-T2"),
    threshold: 99,
  });
  assert.deepEqual(r.taskIds, ["W1-T2"], "only the queued-but-credited shard is drift");
});

// ── THE RUNG IS ON THE HOST. The two tests above exercise the verb; these two are why the task
//    exists at all — `rmd plan-reconcile` was already correct and already unit-tested, and still
//    nothing ran it. A verb nothing calls is the defect, so the wiring needs its own assertion.

/** A checkout skeleton the cadence host can read: the other verbs refuse on it rather than throw,
 *  which is what makes it a usable bed for asserting one rung's presence. */
const cadenceBed = () => {
  const dir = makeTempDir("t3226");
  mkdirSync(join(dir, "state"), { recursive: true });
  return dir;
};

/** No git history: every history-backed verb refuses, leaving this rung's field the subject. */
const NO_HISTORY = () => {
  throw new Error("git history unavailable");
};

test("W1-T3226: a cadence fire CARRIES the drift report, which is the whole defect", () => {
  const dir = cadenceBed();
  try {
    const result = runMeasurementCadenceReport({
      stateDir: join(dir, "state"),
      cwd: dir,
      escalate: false,
      gitLog: NO_HISTORY,
      checkoutDir: dir,
      planReconcile: {
        shards: [shard("W1-T1"), shard("W1-T2")],
        isCreditedMerged: credits("W1-T1"),
        threshold: 9,
      },
    });
    assert.equal(result.planReconcile?.drift, 1);
    assert.deepEqual(result.planReconcile?.taskIds, ["W1-T1"]);
    assert.equal(result.planReconcile?.status, "reported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3226: with the rung unsupplied the field is ABSENT, not an undefined key", () => {
  // The prior verbs' field order is pinned by test/the-verb-census-reaches-a-reader.test.ts. An
  // optional rung that always attached a key would move that list; two siblings already spread
  // conditionally for the same reason, and this holds the new one to it.
  const dir = cadenceBed();
  try {
    const result = runMeasurementCadenceReport({
      stateDir: join(dir, "state"),
      cwd: dir,
      escalate: false,
      gitLog: NO_HISTORY,
      checkoutDir: dir,
    });
    assert.ok(!Object.keys(result).includes("planReconcile"), "a skipped rung leaves no key behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
