// test/incident-invariants.test.ts — W1-T4384: the SRE gardener's phase 2. The pure evaluator
// (evaluateIncidentInvariants) is driven directly over synthetic ledger rows for the multi-window
// burn-rate contract and the dispatch-stall rule; the event-loop-lag ledger row is proven both as
// a pure shape (eventLoopLagLedgerLine) and over serve.ts's REAL minute-timer wiring
// (startIncidentInvariantsMonitor), so the row it "records" is proven appended, not merely shaped.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DISPATCH_STALL_RULE_ID,
  evaluateIncidentInvariants,
  eventLoopLagLedgerLine,
  invariantFindingLedgerLine,
  LOOP_LAG_P99_BOUND_MS,
  LOOP_LAG_RULE_ID,
  RUNTIME_LOOP_LAG_STEP,
  type IncidentInvariantRow,
} from "../src/lib/incident-invariants.js";
import { startIncidentInvariantsMonitor } from "../src/lib/serve.js";
import type { EventLoopLag } from "../src/lib/daemon-health.js";

const NOW_MS = Date.parse("2026-09-23T12:00:00.000Z");

function row(atMs: number, fields: Record<string, unknown>): IncidentInvariantRow {
  return { ts: new Date(atMs).toISOString(), run_id: "TEST", task_id: "TEST", ...fields };
}

/** One `runtime.loop_lag` row every minute, back to `sinceMs`, all reading `p99Ms`. */
function loopLagRowsEveryMinute(sinceMs: number, nowMs: number, p99Ms: number): IncidentInvariantRow[] {
  const rows: IncidentInvariantRow[] = [];
  for (let t = sinceMs + 60_000; t <= nowMs; t += 60_000) {
    rows.push(row(t, { step: RUNTIME_LOOP_LAG_STEP, p50Ms: p99Ms / 2, p99Ms, maxMs: p99Ms, windowMs: 60_000 }));
  }
  return rows;
}

test("an invariant fires only when both its long and short windows burn", () => {
  const longMs = 15 * 60_000; // loop-lag's own long window
  const shortMs = longMs / 12; // 75s

  // Bad for the FULL long window, including its short tail -> both windows burn -> fires.
  const sustained = loopLagRowsEveryMinute(NOW_MS - longMs, NOW_MS, LOOP_LAG_P99_BOUND_MS + 100);
  const sustainedFindings = evaluateIncidentInvariants(sustained, NOW_MS);
  assert.ok(
    sustainedFindings.some((f) => f.ruleId === LOOP_LAG_RULE_ID),
    "a bad long window with a bad short tail must fire loop-lag",
  );

  // Bad for the long window EXCEPT the short window has already recovered (a blip that cleared) ->
  // the long window alone burns, the short one does not -> must NOT fire.
  const recovered = [
    ...loopLagRowsEveryMinute(NOW_MS - longMs, NOW_MS - shortMs - 60_000, LOOP_LAG_P99_BOUND_MS + 100),
    ...loopLagRowsEveryMinute(NOW_MS - shortMs - 60_000, NOW_MS, LOOP_LAG_P99_BOUND_MS - 100),
  ];
  const recoveredFindings = evaluateIncidentInvariants(recovered, NOW_MS);
  assert.ok(
    !recoveredFindings.some((f) => f.ruleId === LOOP_LAG_RULE_ID),
    "a long-window-only burn (the short confirmation window already reads fine) must not fire",
  );

  // dispatch-stall's own rule is count-based rather than max-based, so unlike loop-lag it CAN
  // read bad in its short window while its long window (a wider sum that still includes an older
  // fulfilled dispatch) reads clean — the mirror-image half of the AND, proven directly below.
  const dispatchLongMs = 2 * 60 * 60_000;
  const dispatchShortMs = dispatchLongMs / 12; // 10 minutes
  const shortOnlyBad: IncidentInvariantRow[] = [
    // Inside the long window only (older than the short window's own 10-minute reach): a
    // fulfilled dispatch, so the LONG window reads "queue is moving" even though nothing has
    // fulfilled recently.
    row(NOW_MS - dispatchLongMs + 60_000, { step: "queue.priority_snapshot", queuedPriority1: 1 }),
    row(NOW_MS - dispatchLongMs + 60_000, { step: "dispatch.settled_set", dispatched: 1, fulfilled: 1, rejected: 0 }),
    // Inside BOTH windows: priority-1 work is still queued right now, with nothing fulfilled
    // since -> the SHORT window alone reads stalled.
    row(NOW_MS - dispatchShortMs / 2, { step: "queue.priority_snapshot", queuedPriority1: 1 }),
  ];
  const shortOnlyFindings = evaluateIncidentInvariants(shortOnlyBad, NOW_MS);
  assert.ok(
    !shortOnlyFindings.some((f) => f.ruleId === DISPATCH_STALL_RULE_ID),
    "a bad short window alone (an old fulfilled dispatch still inside the long window) must not fire",
  );
});

test("zero fulfilled dispatches with queued priority-one work fires the dispatch-stall rule", () => {
  const longMs = 2 * 60 * 60_000; // dispatch-stall's own long window
  const rows: IncidentInvariantRow[] = [];
  // Queued priority-1 work is visible throughout both windows...
  for (let t = NOW_MS - longMs; t <= NOW_MS; t += 10 * 60_000) {
    rows.push(row(t, { step: "queue.priority_snapshot", queuedPriority1: 2 }));
  }
  // ...and NOT ONE dispatch pass reports a fulfilled task the whole time (worse: some passes ran
  // and settled nothing, so this is not merely "no evidence" — it's evidence of zero).
  for (let t = NOW_MS - longMs; t <= NOW_MS; t += 20 * 60_000) {
    rows.push(row(t, { step: "dispatch.settled_set", dispatched: 0, fulfilled: 0, rejected: 0 }));
  }

  const findings = evaluateIncidentInvariants(rows, NOW_MS);
  const stall = findings.find((f) => f.ruleId === DISPATCH_STALL_RULE_ID);
  assert.ok(stall, "queued priority-1 work + zero fulfilled dispatches, sustained, must fire dispatch-stall");
  assert.match(stall!.message, /queued priority-1 tasks=2/);
  assert.match(stall!.message, /fulfilled dispatches=0/);

  const ledgerLine = invariantFindingLedgerLine(stall!, NOW_MS);
  assert.equal(ledgerLine.step, "incident.event");
  assert.equal(ledgerLine.kind, "invariant");
  assert.equal(ledgerLine.name, DISPATCH_STALL_RULE_ID);
});

test("a fulfilled dispatch in the window clears the dispatch-stall rule even with priority-1 work queued", () => {
  const longMs = 2 * 60 * 60_000;
  const rows: IncidentInvariantRow[] = [];
  for (let t = NOW_MS - longMs; t <= NOW_MS; t += 10 * 60_000) {
    rows.push(row(t, { step: "queue.priority_snapshot", queuedPriority1: 1 }));
  }
  rows.push(row(NOW_MS - 5 * 60_000, { step: "dispatch.settled_set", dispatched: 1, fulfilled: 1, rejected: 0 }));

  const findings = evaluateIncidentInvariants(rows, NOW_MS);
  assert.ok(
    !findings.some((f) => f.ruleId === DISPATCH_STALL_RULE_ID),
    "a single fulfilled dispatch in the window is evidence the queue is moving; the rule must not fire",
  );
});

test("no evidence of queued priority-1 work never fires dispatch-stall, no matter how quiet dispatch is", () => {
  const findings = evaluateIncidentInvariants([], NOW_MS);
  assert.ok(!findings.some((f) => f.ruleId === DISPATCH_STALL_RULE_ID), "an empty ledger is 'no evidence', never 'stalled'");
});

test("event-loop lag is recorded as a ledger row", () => {
  const written: Array<{ path: string; line: Record<string, unknown> }> = [];
  const writeLedger = (path: string, line: Record<string, unknown>) => {
    written.push({ path, line });
  };
  const reading: EventLoopLag = { p50Ms: 12.3, p99Ms: 640.1, maxMs: 900.4, windowMs: 60_000 };

  let tick: (() => void) | undefined;
  const fakeSetInterval = ((cb: () => void, _ms: number) => {
    tick = cb;
    return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const fakeClearInterval = (() => {}) as typeof clearInterval;

  const stop = startIncidentInvariantsMonitor("/tmp/does-not-matter/ledger.ndjson", {
    writeLedger,
    readLedger: () => [],
    eventLoopLag: () => reading,
    clock: { now: () => NOW_MS, date: () => new Date(NOW_MS), iso: () => new Date(NOW_MS).toISOString() },
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
  });

  assert.ok(tick, "the monitor must arm its tick via the injected setInterval");
  tick!();
  stop();

  const lagRow = written.find((w) => w.line.step === RUNTIME_LOOP_LAG_STEP);
  assert.ok(lagRow, "the gateway's minute tick must ledger a runtime.loop_lag row");
  assert.equal(lagRow!.line.p99Ms, reading.p99Ms);
  assert.equal(lagRow!.line.p50Ms, reading.p50Ms);
  assert.equal(lagRow!.line.maxMs, reading.maxMs);

  // The pure shape agrees with what the real tick wrote, so the two never drift apart.
  assert.deepEqual(eventLoopLagLedgerLine(reading, NOW_MS), lagRow!.line);
});
