import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checksStateFromRollup, dedupeRollupByLatestAttempt, type RollupCheckEntry } from "../src/lib/sweep.js";
import { fetchCiFailures } from "../src/run-task.js";

/**
 * W1-T457 — a SUPERSEDED cancelled check-run makes checksState red forever, so the fix rung
 * dispatches against an empty failing set.
 *
 * ROOT CAUSE, measured live on PR #1728's HEAD 94c97e33: `statusCheckRollup` reported TWO
 * `ci-gate` entries on that ONE sha — `completed/cancelled` started 13:48:42, and
 * `completed/success` started 13:50:02. `checksStateFromRollup` (lib/sweep.ts) walked every
 * reported entry with no dedupe by name, so the stale CANCELLED attempt held `checksState` at
 * "red" forever, even though the check's own newest attempt had already gone green.
 * `fetchCiFailures` (run-task.ts), reading the SAME rollup, filtered to `FAILURE`/`ERROR` only —
 * CANCELLED matched neither — so it reported ZERO failing checks. One predicate said red, the
 * other said nothing was failing: `blocked-fixable` fired a ci-log fix worker with an EMPTY
 * failing set (5 of 6 measured `fix.dispatch` ledger rows for this shape carried
 * `unmet_count: 0`).
 *
 * THE FIX copies `.github/workflows/ci-gate.yml`'s own dedupe (test/ci-gate-dedupe.test.ts, the
 * #242 fixture: group by check name, keep only the latest `started_at` attempt) into
 * `checksStateFromRollup` via the new `dedupeRollupByLatestAttempt`, and aligns `fetchCiFailures`
 * to filter on the SAME `REQUIRED_CHECK_FAIL` set `checksStateFromRollup` vetoes on, after the
 * SAME dedupe — so the two can never drift into naming a different "failing" answer again.
 */

const REQUIRED = ["ci-gate"];

function rollupCheck(over: Partial<RollupCheckEntry> = {}): RollupCheckEntry {
  return { name: "check", conclusion: "SUCCESS", ...over };
}

// ── acceptance 1 — a superseded cancelled run beside a newer success is NOT red ─────────────────

test("checksStateFromRollup: the #1728 fixture — a CANCELLED ci-gate attempt at 13:48:42 superseded by a SUCCESS attempt of the SAME name at 13:50:02 reads green, not red", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "CANCELLED", startedAt: "2026-08-13T13:48:42Z" }),
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS", startedAt: "2026-08-13T13:50:02Z" }),
  ];
  assert.equal(checksStateFromRollup(rollup, REQUIRED), "green", "the newest attempt is SUCCESS — the stale CANCELLED attempt must not outvote it");
});

test("checksStateFromRollup: the SAME #1728 fixture with the two attempts in the OPPOSITE array order still reads green — this is a startedAt comparison, not a last-wins-by-position coincidence", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS", startedAt: "2026-08-13T13:50:02Z" }),
    rollupCheck({ name: "ci-gate", conclusion: "CANCELLED", startedAt: "2026-08-13T13:48:42Z" }),
  ];
  assert.equal(checksStateFromRollup(rollup, REQUIRED), "green");
});

test("checksStateFromRollup: a superseded cancelled attempt beside OTHER required checks still reads green overall when every check's newest attempt is satisfied", () => {
  const required = ["ci-gate", "commitlint"];
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "CANCELLED", startedAt: "2026-08-13T13:48:42Z" }),
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS", startedAt: "2026-08-13T13:50:02Z" }),
    rollupCheck({ name: "commitlint", conclusion: "SUCCESS", startedAt: "2026-08-13T13:49:00Z" }),
  ];
  assert.equal(checksStateFromRollup(rollup, required), "green");
});

// ── acceptance 2 (mirrored here too) — a currently failing required check is STILL red ──────────
// test/sweep-blocked-routing.test.ts already locks the FAILURE-conclusion case end-to-end through
// disposition/isBlockedCi (W1-T394 acceptance 3). These two pin the shape THIS task is about: a
// CANCELLED conclusion, with no newer attempt superseding it, still vetoes — the dedupe above must
// never be mistaken for "CANCELLED no longer counts as a failure."

test("checksStateFromRollup: a CANCELLED ci-gate run with NO later attempt (not superseded) still reads red — dedupe must not weaken a genuine failure", () => {
  const rollup: RollupCheckEntry[] = [rollupCheck({ name: "ci-gate", conclusion: "CANCELLED", startedAt: "2026-08-13T13:48:42Z" })];
  assert.equal(checksStateFromRollup(rollup, REQUIRED), "red");
});

test("checksStateFromRollup: two attempts where the LATEST (by startedAt) is the one that's CANCELLED still reads red, regardless of array order", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS", startedAt: "2026-08-13T13:48:42Z" }),
    rollupCheck({ name: "ci-gate", conclusion: "CANCELLED", startedAt: "2026-08-13T13:50:02Z" }),
  ];
  assert.equal(checksStateFromRollup(rollup, REQUIRED), "red", "the newest attempt is the failure — dedupe keeps it, never the stale success");
});

// ── dedupeRollupByLatestAttempt, directly ────────────────────────────────────────────────────────

test("dedupeRollupByLatestAttempt: collapses N attempts of the SAME name to exactly one entry — the latest by startedAt", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "CANCELLED", startedAt: "2026-08-13T13:40:00Z" }),
    rollupCheck({ name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-08-13T13:45:00Z" }),
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS", startedAt: "2026-08-13T13:50:02Z" }),
  ];
  const deduped = dedupeRollupByLatestAttempt(rollup);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].conclusion, "SUCCESS");
});

test("dedupeRollupByLatestAttempt: entries with DIFFERENT names/contexts are all preserved — only same-name duplicates collapse", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS", startedAt: "t1" }),
    rollupCheck({ name: "commitlint", conclusion: "SUCCESS", startedAt: "t1" }),
    rollupCheck({ context: "remudero-review", state: "SUCCESS" }),
  ];
  const deduped = dedupeRollupByLatestAttempt(rollup);
  assert.equal(deduped.length, 3);
});

// ── acceptance 3 — the state predicate and the failing-list producer AGREE ───────────────────────

test("fetchCiFailures agrees with checksStateFromRollup on the #1728 fixture: BOTH read the superseded-cancelled-then-success rollup as healthy", () => {
  const rollup = [
    { name: "ci-gate", conclusion: "CANCELLED", startedAt: "2026-08-13T13:48:42Z" },
    { name: "ci-gate", conclusion: "SUCCESS", startedAt: "2026-08-13T13:50:02Z" },
  ];
  assert.equal(checksStateFromRollup(rollup, REQUIRED), "green", "the predicate");
  assert.deepEqual(fetchCiFailures("craigoley", "remudero", rollup), [], "the failing-list producer — must agree there is nothing to fix");
});

test("fetchCiFailures agrees with checksStateFromRollup when the LATEST attempt is a genuine CANCELLED (not superseded): BOTH read it as failing and NAME it", () => {
  const rollup = [{ name: "ci-gate", conclusion: "CANCELLED", startedAt: "2026-08-13T13:48:42Z" }];
  assert.equal(checksStateFromRollup(rollup, REQUIRED), "red", "the predicate");
  const failing = fetchCiFailures("craigoley", "remudero", rollup);
  assert.equal(failing.length, 1, "the failing-list producer must now name the CANCELLED check too — the #1728 defect was this list staying empty while the predicate said red");
  assert.equal(failing[0].name, "ci-gate");
});

test("fetchCiFailures still names an ordinary FAILURE the same way it always has (regression lock)", () => {
  const rollup = [{ name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-08-13T13:48:42Z" }];
  assert.equal(checksStateFromRollup(rollup, REQUIRED), "red");
  const failing = fetchCiFailures("craigoley", "remudero", rollup);
  assert.equal(failing.length, 1);
  assert.equal(failing[0].name, "ci-gate");
});

test("fetchCiFailures never reports a SUPERSEDED failed attempt once a later attempt of the same name succeeded — dedupe applies here too, not just in checksStateFromRollup", () => {
  const rollup = [
    { name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-08-13T13:40:00Z" },
    { name: "ci-gate", conclusion: "SUCCESS", startedAt: "2026-08-13T13:50:02Z" },
  ];
  assert.deepEqual(fetchCiFailures("craigoley", "remudero", rollup), []);
});
