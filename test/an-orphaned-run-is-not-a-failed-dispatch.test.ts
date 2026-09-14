// test/an-orphaned-run-is-not-a-failed-dispatch.test.ts — W1-T3523.
//
// THE DEFECT. `dispatchesWithoutNewOwnedPr` (status.ts) counted every `run.start` line, resetting
// only on `pr.opened`/a merge credit. A worker a container recycle kills before it writes anything
// past its own `run.start` — measured on the live fleet ledger 2026-09-13 at 97 of 203 dispatched
// runs (47%) — incremented that streak IDENTICALLY to a worker that ran and genuinely produced
// nothing. Six tasks (W1-T3349/3362/3363/3364/3365/3366) sat circuit-broken at exactly 5 orphans
// each, for work no worker ever got to attempt.
//
// THE FIX, PER TASK DESIGN. (i) An `orphanedRunIds` reading, first-class, derived entirely from
// rows already on the ledger. (ii) `dispatchesWithoutNewOwnedPr` stops counting an orphaned
// `run.start`; `dispatchesEver` (W1-T271's lifetime counter) is UNCHANGED — it guards a different
// failure and keeps counting every start, orphans included. (iii) Orphans are bounded and
// escalated SEPARATELY (`evaluateOrphanFault`/`isOrphanFaultTripped`), under a reason naming the
// HOST, never the task — so repeated infrastructure death stays visible rather than silently
// forgiven.
//
// THE FALSIFIERS THIS FILE PROVES AGAINST.
//   - LOAD-BEARING, NOT COSMETIC: the exact measured shape (five solo `run.start` rows, one per
//     run_id, nothing else) must NOT trip the streak breaker once each is stale — `# fail 0` here
//     is the fix; deleting `orphanedRunIds`'s exclusion in `dispatchesWithoutNewOwnedPr` reverts
//     every assertion below back to `5`/`true`.
//   - NOT INVISIBLE: repeated orphaning still escalates, under `evaluateOrphanFault`'s own bound —
//     a change that only stopped counting, with nothing taking its place, would be strictly worse.
//   - LIVE, NOT ORPHANED: a `run.start` no older than the ledger's own newest activity is a run
//     still running, asserted explicitly, so the predicate cannot also swallow real in-flight work.
//   - ROTATION-SAFE: a run whose `run.start` and terminal row are handed to the predicate together
//     (the shape a rotation-spanning UNION read produces) is never misread as an orphan merely
//     because the two rows arrived from different retained files.
//
// WHAT THIS PREDICATE DOES **NOT** DO, DELIBERATELY. `orphanedRunIds`/`dispatchesWithoutNewOwnedPr`
// take `lines` as a plain array, exactly like every sibling counter in status.ts — they perform no
// ledger I/O of their own and are agnostic to whether the caller read live-only or a rotation
// union. The one PRODUCTION call site that matters here, `evaluateDispatchBreakerDetailed`, already
// reads the live file alone by a separate, PRE-EXISTING, documented choice (its own
// `ledger-read-intent: live` comment, W1-T2425) that this task does not touch or widen — see this
// PR's body for why that pre-existing choice is out of this task's one concern.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_LIVENESS_BOUND_MS,
  DEFAULT_MAX_TASK_DISPATCHES,
  DEFAULT_MAX_TASK_LIFETIME_DISPATCHES,
  DEFAULT_MAX_TASK_ORPHANED_DISPATCHES,
  dispatchesEver,
  dispatchesWithoutNewOwnedPr,
  evaluateOrphanFault,
  isDispatchBreakerTripped,
  isLifetimeDispatchCapExceeded,
  isOrphanFaultTripped,
  orphanedRunIds,
} from "../src/lib/status.js";

const T = "W1-T9999";

/** A bare `run.start` row — no verdict, no PR, nothing else for its run_id. */
function runStart(runId: string, ts: string, taskId = T): Record<string, unknown> {
  return { ts, step: "run.start", task_id: taskId, run_id: runId };
}

/** A `run.start` FAR ENOUGH BEHIND some later ledger activity to read as stale: this row's own ts
 *  plus {@link DEFAULT_LIVENESS_BOUND_MS} sits well before `laterTs`, the newest activity a real
 *  fleet ledger keeps writing from OTHER tasks/dispatches. */
const OLD_TS = "2026-08-01T00:00:00.000Z";
const NEWER_TS = "2026-08-01T02:00:00.000Z"; // 2h later — comfortably past the 30-minute bound
/** Some OTHER task's row, dated `NEWER_TS` — this is what makes an `OLD_TS` run.start stale: the
 *  ledger's own newest observed activity, never a wall-clock read. */
const laterFleetActivity = () => runStart("noise-run", NEWER_TS, "W1-OTHER");

// ── Acceptance (1): a run.start carrying no subsequent row reads as an orphan ──────────────────

test("a run.start with no subsequent row reads as an orphan", () => {
  const lines = [runStart("r0", OLD_TS), laterFleetActivity()];
  assert.deepEqual([...orphanedRunIds(lines, T)], ["r0"]);
});

test("acceptance 1 (contrast): a run.start followed by ANY other row for its run_id — even a failing verdict — is NOT an orphan", () => {
  const lines = [
    runStart("r0", OLD_TS),
    { ts: OLD_TS, step: "verdict", task_id: T, run_id: "r0", verdict: "no_pr" },
    laterFleetActivity(),
  ];
  assert.deepEqual([...orphanedRunIds(lines, T)], [], "a run that terminated is a distinct outcome from an orphan");
});

test("falsifier — DISTINGUISH AN ORPHAN FROM AN IN-FLIGHT RUN: a run.start no older than the ledger's own newest activity is still running, never an orphan", () => {
  const lines = [runStart("r0", NEWER_TS), laterFleetActivity()];
  assert.deepEqual([...orphanedRunIds(lines, T)], [], "a run this recent has not had time to prove itself an orphan");
});

test("falsifier — ROTATION-SAFE: a run.start and its terminal row, handed to the predicate together as a union read produces, is never an orphan", () => {
  // The shape `readLedgerUnionBounded` hands back after a rotation: the run.start from an older
  // retained file and its terminal row from the live one, both present in the SAME array this
  // predicate reads — exactly what it is handed regardless of which file each line came from.
  const lines = [
    runStart("r0", OLD_TS),
    { ts: NEWER_TS, step: "pr.opened", task_id: T, run_id: "r0", pr_url: "https://github.com/o/r/pull/1" },
  ];
  assert.deepEqual([...orphanedRunIds(lines, T)], [], "a run spanning a rotation boundary still has its terminal row");
});

test("a run_id this repo cannot name, or cannot age, is never orphaned — unknown stays counted", () => {
  // No run_id at all (every fixture predating W1-T2423's per-run tracking).
  assert.deepEqual([...orphanedRunIds([{ ts: OLD_TS, step: "run.start", task_id: T }, laterFleetActivity()], T)], []);
  // No parseable ts on the run.start itself.
  assert.deepEqual([...orphanedRunIds([runStart("r0", "not-a-date"), laterFleetActivity()], T)], []);
  // No parseable ts ANYWHERE in the ledger — no notion of "now" to measure staleness against.
  assert.deepEqual([...orphanedRunIds([runStart("r0", OLD_TS)], T)], [], "with no later activity at all, nothing proves this stale yet");
});

test("the orphan read reflects a later row appended to the same ledger array", () => {
  const lines = [runStart("r0", OLD_TS)];
  assert.deepEqual([...orphanedRunIds(lines, T)], [], "a lone start supplies no later ledger clock");
  lines.push(laterFleetActivity());
  assert.deepEqual([...orphanedRunIds(lines, T)], ["r0"], "the exported reader must not retain an obsolete ledger clock");
});

// ── Acceptance (2): the streak breaker does not count an orphaned run ──────────────────────────

test("the streak breaker does not count an orphaned run", () => {
  const lines = [
    runStart("r0", OLD_TS),
    runStart("r1", OLD_TS),
    runStart("r2", OLD_TS),
    runStart("r3", OLD_TS),
    runStart("r4", OLD_TS),
    laterFleetActivity(),
  ];
  assert.equal(dispatchesWithoutNewOwnedPr(lines, T), 0, "all five are orphans — none tested the task");
  assert.equal(isDispatchBreakerTripped(lines, T, DEFAULT_MAX_TASK_DISPATCHES), false, "# fail 0 — this is the fix");
});

test("acceptance 2 (contrast): the SAME five dispatches, each with its own no-PR verdict, still trip the breaker — a genuine stall is not excused", () => {
  const lines = [0, 1, 2, 3, 4].flatMap((i) => [
    runStart(`r${i}`, OLD_TS),
    { ts: OLD_TS, step: "verdict", task_id: T, run_id: `r${i}`, verdict: "no_pr" },
  ]);
  assert.equal(dispatchesWithoutNewOwnedPr(lines, T), 5, "the worker ran five times and produced nothing — still counted");
  assert.equal(isDispatchBreakerTripped(lines, T, DEFAULT_MAX_TASK_DISPATCHES), true);
});

test("acceptance 2 (mixed): orphans and a genuine no-progress dispatch in the same history — only the genuine one counts", () => {
  const lines = [
    runStart("r0", OLD_TS), // orphan
    runStart("r1", OLD_TS), // orphan
    runStart("r2", OLD_TS),
    { ts: OLD_TS, step: "verdict", task_id: T, run_id: "r2", verdict: "no_pr" }, // genuine
    laterFleetActivity(),
  ];
  assert.equal(dispatchesWithoutNewOwnedPr(lines, T), 1);
});

test("acceptance 2: pr.opened still resets the streak exactly as before, orphans notwithstanding", () => {
  const lines = [
    runStart("r0", OLD_TS), // orphan, excluded
    { ts: OLD_TS, step: "pr.opened", task_id: T, run_id: "r1", pr_url: "https://github.com/o/r/pull/1" },
    runStart("r2", NEWER_TS), // after the reset, recent — counts
  ];
  assert.equal(dispatchesWithoutNewOwnedPr(lines, T), 1, "the reset, then the one dispatch since it");
});

// ── Acceptance (3): the lifetime dispatch counter still counts an orphaned run ─────────────────

test("the lifetime counter still counts an orphaned run", () => {
  const lines = [0, 1, 2, 3, 4].map((i) => runStart(`r${i}`, OLD_TS)).concat([laterFleetActivity()]);
  assert.equal(dispatchesWithoutNewOwnedPr(lines, T), 0, "the streak breaker excuses all five");
  assert.equal(dispatchesEver(lines, T), 5, "the lifetime counter still saw all five");
});

test("acceptance 3: a task whose worker is reliably killed by its host still reaches the lifetime cap — orphans cannot buy infinite redispatch", () => {
  const lines = Array.from({ length: DEFAULT_MAX_TASK_LIFETIME_DISPATCHES }, (_, i) => runStart(`r${i}`, OLD_TS)).concat([
    laterFleetActivity(),
  ]);
  assert.equal(dispatchesWithoutNewOwnedPr(lines, T), 0, "every dispatch here is an orphan");
  assert.equal(
    isLifetimeDispatchCapExceeded(lines, T, DEFAULT_MAX_TASK_LIFETIME_DISPATCHES),
    true,
    "design (ii): the rationale's own forbidden shape — a task that kills its worker every time must not redispatch forever uncounted",
  );
});

// ── Acceptance (4): repeated orphaning escalates as a host fault ───────────────────────────────

test("repeated orphaning escalates as a host fault", () => {
  const lines = [
    runStart("r0", OLD_TS),
    runStart("r1", OLD_TS),
    runStart("r2", OLD_TS),
    runStart("r3", OLD_TS),
    runStart("r4", OLD_TS),
    laterFleetActivity(),
  ];
  const detail = evaluateOrphanFault(lines, T);
  assert.equal(detail.tripped, true);
  assert.equal(detail.maxOrphanedDispatches, DEFAULT_MAX_TASK_ORPHANED_DISPATCHES);
  assert.deepEqual(detail.orphanRunIds.slice().sort(), ["r0", "r1", "r2", "r3", "r4"]);
  assert.match(detail.reason, /HOST FAULT/, "an operator reading only the reason can tell this apart from the task breaker");
  assert.match(detail.reason, /r0/, "the run_ids are named, not merely counted");
  assert.equal(isOrphanFaultTripped(lines, T), true);
});

test("acceptance 4: NOT INVISIBLE — fewer orphans than the bound do not escalate, but are still named in the reason", () => {
  const lines = [runStart("r0", OLD_TS), runStart("r1", OLD_TS), laterFleetActivity()];
  const detail = evaluateOrphanFault(lines, T);
  assert.equal(detail.tripped, false);
  assert.equal(detail.orphanRunIds.length, 2);
  assert.doesNotMatch(detail.reason, /HOST FAULT/);
});

test("acceptance 4: a task whose worker never gets killed never trips the host-fault bound, whatever its own streak does", () => {
  const lines = [0, 1, 2, 3, 4].flatMap((i) => [
    runStart(`r${i}`, OLD_TS),
    { ts: OLD_TS, step: "verdict", task_id: T, run_id: `r${i}`, verdict: "no_pr" },
  ]);
  assert.equal(isOrphanFaultTripped(lines, T), false, "no orphans here — this task's OWN failures, not its host's");
  assert.equal(isDispatchBreakerTripped(lines, T, DEFAULT_MAX_TASK_DISPATCHES), true, "the streak breaker still fires, and separately");
});
