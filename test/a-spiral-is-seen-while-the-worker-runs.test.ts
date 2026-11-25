/**
 * W1-T4049 — A SPIRALING WORKER IS SEEN WHILE IT RUNS, not at run end.
 *
 * collectWorkerResult's stream observer used to carry a tool NAME and an error FLAG only, so the two flight-signals
 * predicates that need more — repetition (name + input) and the error loop (fingerprinted text) — could not run live.
 * Each test here drives the REAL collectWorkerResult over a synthetic SDK stream and reads what the run's flight-signal
 * window wrote, at the moment it wrote it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectWorkerResult,
  errorTextFingerprint,
  FLIGHT_SIGNAL_ERROR_LEDGER_STEP,
  FLIGHT_SIGNAL_TRIPPED_LEDGER_STEP,
  LIVE_FLIGHT_SIGNAL_THRESHOLD,
  toolCallFingerprint,
  withFlightSignals,
  type WorkerStreamEvent,
} from "#src/lib/worker.js";
import type { LedgerLine } from "#src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

interface Step {
  input: Record<string, unknown>;
  error?: string;
}

const RESULT = {
  type: "result", subtype: "success", is_error: false, result: "done", session_id: "sess-spiral",
  total_cost_usd: 0.01, num_turns: 1, permission_denials: [],
};

/** One assistant tool_use + one user tool_result per step; `beforeResult` runs while the stream is still open. */
function stream(steps: Step[], beforeResult?: () => void): AsyncIterable<unknown> {
  return (async function* (): AsyncGenerator<unknown> {
    let n = 0;
    for (const step of steps) {
      const id = `toolu_${n++}`;
      yield { type: "assistant", message: { content: [{ type: "tool_use", id, name: "Read", input: step.input }] } };
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id,
        ...(step.error === undefined ? { content: "ok" } : { is_error: true, content: step.error }) }] } };
    }
    beforeResult?.();
    yield RESULT;
  })();
}

function run(steps: Step[], beforeResult?: (rows: LedgerLine[]) => void) {
  const rows: LedgerLine[] = [];
  const events: WorkerStreamEvent[] = [];
  const result = collectWorkerResult(stream(steps, () => beforeResult?.(rows)), {
    childEnvKeys: [], root: "/nonexistent-root-never-written", runId: `run-${randomUUID()}`, taskId: "W1-T4049",
    flightSignalSink: (row) => { rows.push(row); }, streamObserver: (event) => { events.push(event); },
  });
  return { rows, events, result };
}

const trips = (rows: LedgerLine[]) => rows.filter((row) => row.step === FLIGHT_SIGNAL_TRIPPED_LEDGER_STEP);
const same = (n: number): Step[] => Array.from({ length: n }, () => ({ input: { file_path: "/repo/secret-config.ts" } }));

test("W1-T4049: a tool call carries a fingerprint and never its raw input", async () => {
  const input = { file_path: "/repo/secret-config.ts", limit: 40 };
  const { events, rows, result } = run([...same(5), { input }, { input, error: "EACCES: secret-token-xyz denied" }]);
  await result;
  const calls = events.filter((event) => event.kind === "tool-executing");
  assert.equal(calls.length, 7);
  for (const call of calls) {
    assert.match(call.toolFingerprint ?? "", /^[0-9a-f]{16}$/, "a bounded 16-hex fingerprint rides every tool call");
    assert.ok(!call.toolFingerprint!.includes("secret"), "the fingerprint holds no byte of the input");
  }
  assert.equal(calls[5].toolFingerprint, toolCallFingerprint("Read", input), "name + canonical input is its identity");
  assert.equal(toolCallFingerprint("Read", { limit: 40, file_path: "/repo/secret-config.ts" }), calls[5].toolFingerprint,
    "key order does not change the fingerprint");
  assert.notEqual(toolCallFingerprint("Grep", input), calls[5].toolFingerprint, "the name is part of the identity");
  const errored = events.filter((event) => event.toolOutcome === "error");
  assert.equal(errored.length, 1);
  assert.equal(errored[0].errorFingerprint, errorTextFingerprint("EACCES: secret-token-xyz denied"));
  assert.ok(!JSON.stringify(errored[0]).includes("secret-token"), "the error text itself never crosses the observer");
  assert.equal(events.filter((event) => event.errorFingerprint !== undefined).length, 1, "a success carries no error fingerprint");
  // What IS written is a fingerprint, never the payload.
  assert.equal(trips(rows).length, 1);
  assert.ok(!JSON.stringify(rows).includes("secret"), "no trip row carries the raw input or error text");
});

test("W1-T4049: five identical calls trip the repetition signal mid-run", async () => {
  let seenBeforeResult: LedgerLine[] = [];
  const { result } = run(same(LIVE_FLIGHT_SIGNAL_THRESHOLD), (rows) => { seenBeforeResult = trips(rows).map((row) => ({ ...row })); });
  const settled = await result;
  assert.equal(seenBeforeResult.length, 1, "the trip is in the ledger BEFORE the terminal result envelope arrives");
  const [trip] = seenBeforeResult;
  assert.equal(trip.predicate, "repeated_tool_call");
  assert.equal(trip.turn, LIVE_FLIGHT_SIGNAL_THRESHOLD, "it fires on the turn the fifth identical call lands");
  assert.deepEqual(trip.fingerprints, [toolCallFingerprint("Read", { file_path: "/repo/secret-config.ts" })]);
  assert.equal(trip.count, LIVE_FLIGHT_SIGNAL_THRESHOLD);
  assert.equal(trip.run_id.startsWith("run-"), true);
  assert.equal(trip.task_id, "W1-T4049");
  assert.equal(settled.subtype, "success");
  // Four is not five.
  const four = run(same(LIVE_FLIGHT_SIGNAL_THRESHOLD - 1));
  await four.result;
  assert.equal(trips(four.rows).length, 0);
});

test("W1-T4049: different inputs to the same tool do not trip", async () => {
  const steps = Array.from({ length: 6 }, (_, i) => ({ input: { file_path: `/repo/src/file-${i}.ts` } }));
  const { rows, events, result } = run(steps);
  await result;
  const calls = events.filter((event) => event.kind === "tool-executing");
  // A NAME-ONLY signal would see one tool six times and call it a loop.
  assert.deepEqual(new Set(calls.map((call) => call.toolName)), new Set(["Read"]));
  assert.ok(calls.length > LIVE_FLIGHT_SIGNAL_THRESHOLD);
  assert.equal(new Set(calls.map((call) => call.toolFingerprint)).size, 6, "six inputs, six fingerprints");
  assert.equal(trips(rows).length, 0, "six reads of six files are work, not a spiral");
});

test("W1-T4049: one error repeating trips and different errors do not", async () => {
  // Numbers are volatile (line, pid) and collapse, so this is ONE error recurring five times.
  const repeating = Array.from({ length: 5 }, (_, i) => ({ input: { file_path: `/repo/f-${i}.ts` },
    error: `ENOENT: no such file at line ${i + 10}` }));
  const loop = run(repeating);
  await loop.result;
  const loopTrips = trips(loop.rows);
  assert.equal(loopTrips.length, 1);
  assert.equal(loopTrips[0].predicate, "error_signature_loop");
  assert.deepEqual(loopTrips[0].fingerprints, [errorTextFingerprint("ENOENT: no such file at line 10")]);
  assert.equal(loopTrips[0].turn, 5);

  const varied = ["ENOENT: missing", "EACCES: denied", "TypeError: x is undefined", "SyntaxError: bad token", "timeout"];
  const distinct = run(varied.map((error, i) => ({ input: { file_path: `/repo/g-${i}.ts` }, error })));
  await distinct.result;
  assert.equal(distinct.events.filter((event) => event.toolOutcome === "error").length, 5, "five error FLAGS were raised");
  assert.equal(trips(distinct.rows).length, 0, "five different errors are not one error looping");
});

test("W1-T4049: a trip is ledgered once and does not halt the worker", async () => {
  const { rows, events, result } = run(same(30));
  const settled = await result;
  assert.equal(trips(rows).length, 1, "thirty identical calls still ledger ONE repetition trip");
  assert.equal(settled.subtype, "success", "the worker ran to its own terminal envelope");
  assert.equal(settled.isError, false);
  assert.equal(events.filter((event) => event.kind === "tool-executing").length, 30, "the caller's observer saw every event");

  // A second spawn in the SAME run (a resume) does not re-ledger the trip.
  const runId = `run-${randomUUID()}`;
  const shared: LedgerLine[] = [];
  for (let spawn = 0; spawn < 2; spawn++) {
    await collectWorkerResult(stream(same(6)), { childEnvKeys: [], root: "/nonexistent", runId, flightSignalSink: (row) => { shared.push(row); } });
  }
  assert.equal(trips(shared).length, 1, "once per run, across its spawns");
  assert.equal(shared[0].task_id, "unattributed");

  // A sink that throws never reaches the stream loop.
  const broken = await collectWorkerResult(stream(same(6)), { childEnvKeys: [], root: "/nonexistent", runId: `run-${randomUUID()}`,
    flightSignalSink: () => { throw new Error("ledger unwritable"); } });
  assert.equal(broken.subtype, "success");

  // A predicate that throws is ledgered, and the caller's observer still runs.
  const errors: LedgerLine[] = [];
  const seen: WorkerStreamEvent[] = [];
  const wrapped = withFlightSignals((event) => { seen.push(event); }, { runId: `run-${randomUUID()}`, sink: (row) => { errors.push(row); } })!;
  const poisoned = { kind: "tool-executing", tsMs: 1, toolFingerprint: "0123456789abcdef",
    get turnsSoFar(): number { throw new Error("poisoned turn"); } } as WorkerStreamEvent;
  wrapped(poisoned);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].step, FLIGHT_SIGNAL_ERROR_LEDGER_STEP);
  assert.equal(errors[0].error, "poisoned turn");
  assert.equal(seen.length, 1);

  // No run identity: the caller's observer is returned unchanged.
  const own = (): void => {};
  assert.equal(withFlightSignals(own, {}), own);
});

test("W1-T4049: the default sink appends the trip to the run's own ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}spiral-ledger-`));
  try {
    // Many runs in one process stay bounded: older windows are dropped, this run's is kept.
    for (let i = 0; i < 70; i++) withFlightSignals(undefined, { runId: `filler-${randomUUID()}`, sink: () => {} });
    const runId = `run-${randomUUID()}`;
    await collectWorkerResult(stream(same(5)), { childEnvKeys: [], root, runId, taskId: "W1-T4049" });
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const tripped = ledger.filter((row) => row.step === FLIGHT_SIGNAL_TRIPPED_LEDGER_STEP);
    assert.equal(tripped.length, 1);
    assert.equal(tripped[0].run_id, runId);
    assert.equal(tripped[0].predicate, "repeated_tool_call");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
