/**
 * W1-T3231, predicate half — `filingSelfCreditCheck` alone.
 *
 * SPLIT FROM ITS CALLER DELIBERATELY. Rule 25 (`detectInstrumentEntanglement`) refuses a PR that
 * changes an INSTRUMENT_SURFACE path — here `scripts/acceptance-author-gate.mjs` and its workflow —
 * alongside `src/`, because a PR must not quietly change the thing that judges it. So the predicate
 * lands first, on its own, and the gate that calls it follows in an instrument-only PR.
 *
 * THE DEFECT. A plan-only filing PR carrying `Remudero-Task: X` makes `reviewCommand` resolve
 * criteria from X's OWN shard — criteria describing the implementation, whose source files are not
 * in the diff and whose test files do not exist yet. The filing is judged against them and fails
 * closed. Made three times in one session (2026-09-09), a full CI cycle each.
 *
 * WHY IDENTITY AND NOT PLAN-ONLY-NESS. W1-T1004 (merged; it fixed the OTHER half of this mistake,
 * the false merge credit) forbids inferring "this is a filing" from a plan-only diff, having
 * MEASURED 15 plan-only credits of which TWO were CORRECT — those tasks deliver plan text. The last
 * two cases here are the ones a blanket rule would break.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { filingSelfCreditCheck } from "../src/lib/review.js";

const FILING_BODY = ["Plan-only. Files W1-T3231.", "", "Remudero-Task: W1-T3231"].join("\n");

test("W1-T3231: a pull request that adds the shard it credits is refused", () => {
  const r = filingSelfCreditCheck(FILING_BODY, ["W1-T3231"]);
  assert.equal(r.ok, false);
  assert.equal(r.taskId, "W1-T3231");
  // BOTH consequences must be named. An author who only hears "review will fail" re-runs review
  // rather than removing the trailer, and the merge-credit half is the one that silently prevents
  // the implementation from ever being dispatched.
  assert.match(r.message, /fails closed/);
  assert.match(r.message, /credited as built so the implementation is never dispatched/);
  assert.match(r.message, /REMOVE THE TRAILER/);
});

test("W1-T3231: an implementation pull request carrying a trailer is not refused", () => {
  const r = filingSelfCreditCheck(["Implements W1-T3231.", "", "Remudero-Task: W1-T3231"].join("\n"), []);
  assert.equal(r.ok, true);
  assert.match(r.message, /does not introduce that task's record/);
});

test("W1-T3231: a plan-only pull request that does not add its own shard is allowed", () => {
  // W1-T1004's two correct cases: the task's declared deliverable IS plan text, and its shard was
  // filed earlier by a different PR. A plan-only-ness rule refuses this; identity does not — and
  // ANOTHER task's shard being in the diff is irrelevant, which is what the first case pins.
  const body = ["Records the ruling in MASTER-PLAN.", "", "Remudero-Task: W1-T426"].join("\n");
  assert.equal(filingSelfCreditCheck(body, ["W1-T9999"]).ok, true);
  assert.equal(filingSelfCreditCheck(body, []).ok, true);
});

test("W1-T3231: a body with no trailer is never refused, whatever the diff introduces", () => {
  const r = filingSelfCreditCheck("Plan-only. Files W1-T3231.", ["W1-T3231"]);
  assert.equal(r.ok, true);
  assert.match(r.message, /nothing to self-credit/);
});

test("W1-T3231: an empty introduced set never refuses — the caller that cannot see the diff passes one", () => {
  // This is the fail-open contract, asserted here rather than left to the caller: a gate that
  // refuses when it cannot see is the vacuous-refusal mirror of the vacuous pass, and this
  // predicate runs on every PR.
  assert.equal(filingSelfCreditCheck(FILING_BODY, []).ok, true);
});
