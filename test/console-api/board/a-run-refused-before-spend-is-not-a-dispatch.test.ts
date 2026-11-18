// W1-T13249: `runTaskBody` logs `run.start` BEFORE the dispatch claim, so a run the claim refused (a dead hand claim
// every tick) left a `run.start` and every stall reader saw a busy fleet. These tests drive the shared predicate
// (`queueDispatchRunStarts`) and its two ledger-row readers: the queue-head cadence and the dispatch-stall invariant.
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimRefusedRunIds, queueDispatchRunStarts } from "#src/lib/ledger.js";
import { deriveDispatchCadence } from "#src/lib/status-board.js";
import {
  DISPATCH_STALL_RULE_ID,
  evaluateIncidentInvariants,
  type IncidentInvariantRow,
} from "#src/lib/incident-invariants.js";

const NOW_MS = Date.parse("2026-11-16T20:30:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

const start = (ms: number, runId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ts: iso(ms), run_id: runId, task_id: "W1-T12114", step: "run.start", type: "implement", ...extra,
});
const claim = (ms: number, runId: string, proceed: boolean): Record<string, unknown> => ({
  ts: iso(ms), run_id: runId, task_id: "W1-T12114", step: "dispatch.claim", outcome: proceed ? "created" : "taken", proceed,
});

/** Every tick of the outage: a run.start, then a claim refusal. */
function refusedOnly(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 12; i++) {
    const t = NOW_MS - 2 * 60 * 60_000 + i * 10 * 60_000;
    rows.push(start(t, `refused-${i}`), claim(t + 1000, `refused-${i}`, false));
  }
  return rows;
}

function stallRows(starts: Array<Record<string, unknown>>): IncidentInvariantRow[] {
  const rows: IncidentInvariantRow[] = [...starts];
  for (let t = NOW_MS - 2 * 60 * 60_000; t <= NOW_MS; t += 10 * 60_000) {
    rows.push({ ts: iso(t), run_id: "T", task_id: "T", step: "dispatch.lane_refill_held", reason: "hold" });
  }
  return rows;
}

test("W1-T13249 criterion 1: a window holding only claim-refused runs starts no work", () => {
  const lines = refusedOnly();
  assert.equal(claimRefusedRunIds(lines).size, 12);
  assert.deepEqual(queueDispatchRunStarts(lines), []);

  // The queue-head cadence reads no dispatch at all, so no STALL bound or newest dispatch comes from them.
  assert.deepEqual(deriveDispatchCadence(lines), {});

  // The dispatch-stall invariant fires: holds, and zero implement starts that passed their claim.
  const stall = evaluateIncidentInvariants(stallRows(lines), NOW_MS).find((f) => f.ruleId === DISPATCH_STALL_RULE_ID);
  assert.ok(stall, "claim-refused run.start rows must not mask a dispatch stall");
  assert.match(stall!.message, /implement run starts=0/);
});

test("W1-T13249 criterion 1: a refused run's older real dispatch stays the newest dispatch", () => {
  const real = NOW_MS - 6 * 60 * 60_000;
  const lines = [start(real - 3_600_000, "a"), claim(real - 3_599_000, "a", true), start(real, "b"), claim(real + 1000, "b", true), ...refusedOnly()];
  const cadence = deriveDispatchCadence(lines);
  assert.equal(cadence.newestTs, iso(real));
  assert.equal(cadence.boundMs, 3 * 3_600_000);
});

test("W1-T13249 criterion 3: a-real-dispatch-still-counts for a passed claim and for a run that takes no claim", () => {
  const passed = [start(NOW_MS - 3_000, "p"), claim(NOW_MS - 2_000, "p", true)];
  // A reclaimed silent claim logs a refusing row and then a proceeding one for the same run: it passed.
  const reclaimed = [start(NOW_MS - 9_000, "r"), claim(NOW_MS - 8_000, "r", false), claim(NOW_MS - 7_000, "r", true)];
  // A path that takes no claim: no dispatch.claim row at all, and a legacy row with no run_id or type.
  const noClaim = [start(NOW_MS - 6_000, "n"), { ts: iso(NOW_MS - 5_000), step: "run.start", task_id: "W1-T1" }];
  const lines = [...passed, ...reclaimed, ...noClaim];

  assert.equal(claimRefusedRunIds(lines).size, 0);
  assert.deepEqual(queueDispatchRunStarts(lines), [passed[0], reclaimed[0], noClaim[0], noClaim[1]]);
  // A lane run is still not a queue dispatch, exactly as before.
  assert.deepEqual(queueDispatchRunStarts([start(NOW_MS, "x", { type: "triage" })]), []);
  assert.equal(deriveDispatchCadence(lines).newestTs, iso(NOW_MS - 3_000));

  const real = evaluateIncidentInvariants(stallRows([...passed, ...noClaim]), NOW_MS);
  assert.ok(!real.some((f) => f.ruleId === DISPATCH_STALL_RULE_ID), "a real implement start still clears dispatch-stall");
});
