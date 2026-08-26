/**
 * W1-T2300 (blocker two + rationale ii/iii, note Q1) — A REST-SOURCED ROLLUP ENTRY GAINS A
 * START TIME.
 *
 * Before this task `RestRollupEntry` declared no `startedAt` at all: neither the check-runs
 * endpoint's `started_at` nor the combined-status endpoint's `created_at` was ever read, so
 * every REST-mapped entry reached `dedupeRollupByLatestAttempt` with `startedAt` absent. That
 * function's own contract (lib/sweep.ts) is documented plainly: an entry missing the field sorts
 * as older than any timestamped peer, and a TIE (including two entries both missing it) keeps the
 * LAST one *encountered* — so on REST, where every entry ties at "", array order (never true
 * recency) decided which attempt of a repeated check name survived the dedupe. This suite proves
 * (1) both REST entry shapes now carry a real `startedAt`, mapped from two DIFFERENT source keys
 * because the two endpoints do not agree on one; (2) `dedupeRollupByLatestAttempt` now picks the
 * chronologically later attempt on a REST rollup, not the array-order survivor; and (3)
 * `stillRedRequiredNames` — the reader whose early return fires for EVERY name on a field-less
 * REST rollup (rationale note (v), its own "fail-open" comment) — is exercised on both sides of
 * this change: still fail-open on an entry that genuinely carries no start time, and now able to
 * recognize a fresh in-flight attempt once the field is populated.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { rollupFromRest } from "../src/lib/open-prs-rest.js";
import { dedupeRollupByLatestAttempt, stillRedRequiredNames } from "../src/lib/sweep.js";

// ── acceptance 1: both entry shapes carry a real startedAt, from two different source keys ──────

test("rollupFromRest maps a check run's own started_at to startedAt", () => {
  const got = rollupFromRest(
    [{ name: "ci", status: "completed", conclusion: "success", started_at: "2026-08-26T10:00:00Z" }],
    [],
  );
  assert.equal(got.length, 1);
  assert.equal(got[0].startedAt, "2026-08-26T10:00:00Z");
});

test("rollupFromRest maps a status context's created_at to startedAt — a StatusContext carries no started_at key of its own", () => {
  const got = rollupFromRest(
    [],
    [{ context: "remudero-review", state: "success", created_at: "2026-08-26T09:00:00Z" }],
  );
  assert.equal(got.length, 1);
  assert.equal(got[0].startedAt, "2026-08-26T09:00:00Z");
});

test("rollupFromRest leaves NEITHER entry shape untimestamped when a composed rollup carries both a check run and a status context", () => {
  const got = rollupFromRest(
    [{ name: "ci", status: "completed", conclusion: "success", started_at: "2026-08-26T10:00:00Z" }],
    [{ context: "remudero-review", state: "success", created_at: "2026-08-26T09:00:00Z" }],
  );
  assert.equal(got.length, 2);
  for (const entry of got) {
    assert.equal(typeof entry.startedAt, "string", `expected every entry to carry startedAt, got ${JSON.stringify(entry)}`);
    assert.ok(entry.startedAt!.length > 0);
  }
});

test("rollupFromRest degrades to no startedAt (never a synthesized one) when the API payload omits the source key entirely", () => {
  const got = rollupFromRest([{ name: "ci", status: "completed", conclusion: "success" }], []);
  assert.equal("startedAt" in got[0], false, "no started_at in the payload — never invent one");
});

// ── acceptance 2: dedupe keeps the LATEST attempt by time, not the last element encountered ──────

test("dedupeRollupByLatestAttempt on a REST-mapped rollup: the OLDER attempt encountered SECOND no longer wins — recency decides, not array position", () => {
  // The #1728 shape this whole dedupe exists for (sweep.ts's own doc): two attempts of ONE check
  // name on one head sha. Here the chronologically-later (CANCELLED) attempt is encountered
  // FIRST and the older (SUCCESS) attempt SECOND — before this task, on REST, the SECOND one
  // (lacking startedAt) would have won purely by array order.
  const rollup = rollupFromRest(
    [
      { name: "ci-gate", status: "completed", conclusion: "cancelled", started_at: "2026-08-26T14:27:16Z" },
      { name: "ci-gate", status: "completed", conclusion: "success", started_at: "2026-08-26T14:20:00Z" },
    ],
    [],
  );
  const deduped = dedupeRollupByLatestAttempt(rollup);
  assert.equal(deduped.length, 1, "two attempts of one name still collapse to exactly one row");
  assert.equal(deduped[0].conclusion, "CANCELLED", "the LATER startedAt wins even though it was encountered first");
});

test("dedupeRollupByLatestAttempt on a REST-mapped rollup: the truly later attempt (also encountered last) still wins", () => {
  const rollup = rollupFromRest(
    [
      { name: "ci-gate", status: "completed", conclusion: "cancelled", started_at: "2026-08-26T14:20:00Z" },
      { name: "ci-gate", status: "completed", conclusion: "success", started_at: "2026-08-26T14:27:16Z" },
    ],
    [],
  );
  const deduped = dedupeRollupByLatestAttempt(rollup);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].conclusion, "SUCCESS", "recency, not merely 'not first', decides the winner");
});

test("BEFORE-this-task CONTRAST: with startedAt absent on both sides (the pre-population REST shape), dedupe still ties toward the LAST element encountered, never recency — this function's own documented disclaimer, unchanged by this task", () => {
  const rollup = [{ name: "ci-gate", conclusion: "SUCCESS" }, { name: "ci-gate", conclusion: "CANCELLED" }];
  const deduped = dedupeRollupByLatestAttempt(rollup);
  assert.equal(deduped.length, 1);
  assert.equal(
    deduped[0].conclusion,
    "CANCELLED",
    "with no startedAt anywhere, array order (not recency) still decides — proving the fix is populating the field, not changing this function's contract",
  );
});

// ── acceptance 3: stillRedRequiredNames exercised on BOTH sides of the change ─────────────────────

test("stillRedRequiredNames: a REST rollup entry that still carries NO startedAt (the pre-population shape) fails open — still red, exactly as documented", () => {
  const rollup = rollupFromRest([{ name: "ci", status: "completed", conclusion: "success" }], []);
  assert.equal(rollup[0].startedAt, undefined);
  assert.deepEqual(stillRedRequiredNames(["ci"], rollup), ["ci"], "no observed start time — fail open, still red");
});

test("stillRedRequiredNames: a REST rollup entry WITH a populated startedAt and a non-terminal status is recognized as a fresh attempt in flight and dropped", () => {
  const rollup = rollupFromRest(
    [{ name: "ci", status: "in_progress", conclusion: null, started_at: "2026-08-26T18:00:00Z" }],
    [],
  );
  assert.equal(rollup[0].startedAt, "2026-08-26T18:00:00Z");
  assert.deepEqual(
    stillRedRequiredNames(["ci"], rollup),
    [],
    "an observed later attempt in flight is now recognized and dropped — this early return no longer fires unconditionally",
  );
});

test("stillRedRequiredNames: a REST rollup entry WITH a populated startedAt but a TERMINAL failing conclusion is still red", () => {
  const rollup = rollupFromRest(
    [{ name: "ci", status: "completed", conclusion: "failure", started_at: "2026-08-26T18:00:00Z" }],
    [],
  );
  assert.deepEqual(stillRedRequiredNames(["ci"], rollup), ["ci"], "a fresh attempt that concluded failing is still red");
});

test("stillRedRequiredNames: a REST rollup entry WITH a populated startedAt that already CONCLUDED SUCCESS stays in the returned set — this function's contract is narrower than 'no longer red' (design note v), unchanged by populating the field", () => {
  const rollup = rollupFromRest(
    [{ name: "ci", status: "completed", conclusion: "success", started_at: "2026-08-26T18:00:00Z" }],
    [],
  );
  assert.deepEqual(
    stillRedRequiredNames(["ci"], rollup),
    ["ci"],
    "only an OBSERVED in-flight attempt is ever dropped — a concluded SUCCESS is left exactly as before this task",
  );
});
