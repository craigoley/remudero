// W1-T9710 — OBSERVED 2026-10-15 on the core daemon: the first quiet bound after the 17:32Z boot loaded 368 rotations
// off the loop, then its synchronous union pass read 24.8 MB of the digests that load had just written, on the loop.
// Between restarts, each pass JSON-parsed every new live line although ~1.6% of them were in the slice. These tests pin
// that a slice reader's union keeps what its off-loop load just loaded (it is seeded, never re-read from the digest),
// that the live pass parses only lines that can name an asked step and still answers what a full parse answers, and
// that the quiet bound's row names both costs. Real rotations, real digests, a counting fs seam.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createIncrementalLedgerUnion, readLedgerUnionRecordsSync, realLedgerFs, type LedgerGrepFsDeps } from "../src/lib/ledger-union.js";
import { createQuietBoundHistory, projectQuietHistoryRow, QUIET_HISTORY_STEPS } from "../src/lib/quiet-worker-watchdog.js";
import { createEscalationTriageHistoryReader } from "../src/lib/sweep.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const STEPS = [...QUIET_HISTORY_STEPS];
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();

function state(run: string, value: string, s: number): Record<string, unknown> {
  return { ts: at(s), host: "h1", actor_pid: 7, run_id: run, task_id: "W1-T1", step: "worker.state", state: value };
}

function noise(tag: string, count: number, s: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({ ts: at(s), run_id: `${tag}-${i}`, task_id: "W1-T1", step: "heartbeat.tick", note: "worker.state in prose" }));
}

/** Not in the slice, yet it names a slice step (JSON-quoted) in another field: a candidate line `stepMatches` drops. */
function decoy(s: number): Record<string, unknown> {
  return { ts: at(s), run_id: "D1", task_id: "W1-T1", step: "worker.blocked", last_step_before_block: "worker.state" };
}

/** Three rotations (gzip, plain, gzip) and a live file, every one holding slice rows among noise. */
function corpus() {
  return writeLedger([state("R4", "working", 3000), ...noise("live", 20, 3001), decoy(3002), state("R4", "quiet", 3003)], {
    rotations: [
      { at: at(999), gz: true, rows: [state("R1", "working", 0), ...noise("a", 30, 1), state("R1", "quiet", 2)] },
      { at: at(1999), gz: false, rows: [state("R2", "working", 1000), ...noise("b", 30, 1001), decoy(1002)] },
      { at: at(2999), gz: true, rows: [state("R3", "working", 2000), ...noise("c", 30, 2001), state("R3", "quiet", 2002)] },
    ],
  });
}

function countingFs() {
  const counts = { digestReads: 0, digestBytes: 0, rotationReads: 0 };
  const fs: LedgerGrepFsDeps = {
    ...realLedgerFs,
    readFileSync: (path) => {
      const buf = realLedgerFs.readFileSync(path);
      if (path.includes("rotation-digests")) {
        counts.digestReads += 1;
        counts.digestBytes += buf.length;
      } else if (/ledger\.[^/]*\.ndjson(\.gz)?$/.test(path)) counts.rotationReads += 1;
      return buf;
    },
  };
  return { counts, fs };
}

const slice = { holder: "test.w9710-slice", steps: STEPS, project: projectQuietHistoryRow, version: "1" };

/** JSON.parse calls made while `run` runs: every line a union parses goes through it. */
function countParses<T>(run: () => T): { value: T; parses: number } {
  const original = JSON.parse;
  let parses = 0;
  JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
    parses += 1;
    return original(text, reviver);
  }) as typeof JSON.parse;
  try {
    return { value: run(), parses };
  } finally {
    JSON.parse = original;
  }
}

test("W1-T9710: a loaded rotation is never re-read from its digest on the loop", async (t) => {
  const fixture = corpus();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const whole = readLedgerUnionRecordsSync(fixture.dir, { step: STEPS, refuseIncomplete: true });
  assert.equal(whole.ok, true, "control: the whole union reads the corpus");

  const first = countingFs();
  const loads: string[] = [];
  const reader = createEscalationTriageHistoryReader({ fs: first.fs, slice, readFile: async (path) => (loads.push(path), readFile(path)) });
  const read = await reader(fixture.dir);
  assert.equal(loads.length, 3, "control: each rotation is loaded once, off the loop");
  assert.equal(first.counts.digestReads, 0, `the union pass read ${first.counts.digestBytes} digest bytes on the loop for rotations the load had just kept`);
  assert.equal(first.counts.rotationReads, 0, "nor any rotation itself");
  assert.deepEqual(read.rows, whole.rows.map(projectQuietHistoryRow), "the seeded pass answers what the whole union answers");

  // A restarted process: its load answers from the durable digests off the loop, and the union is seeded from that load.
  const restart = countingFs();
  const restarted = createEscalationTriageHistoryReader({ fs: restart.fs, slice, readFile: (path) => readFile(path) });
  const again = await restarted(fixture.dir);
  assert.equal(restart.counts.digestReads, 0, `after a restart the loop read ${restart.counts.digestBytes} digest bytes`);
  assert.deepEqual(again.rows, read.rows);

  // A rotation whose load fails is still read by the union, as before: the corpus is refused as incomplete.
  writeFileSync(join(fixture.dir, `ledger.${at(500).replace(/[:.]/g, "-")}.ndjson.gz`), Buffer.from("not gzip"));
  const refused = await reader(fixture.dir);
  assert.equal(refused.ok, false, "a damaged rotation is never seeded as if it had loaded");
  assert.deepEqual(refused.rows, []);
});

test("W1-T9710: the live pass parses only candidate lines and answers the same rows", (t) => {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 1000; i += 1) {
    if (i % 100 === 0) rows.push(state(`R${i}`, i % 200 === 0 ? "quiet" : "working", i));
    else if (i === 555) rows.push(decoy(i));
    else rows.push({ ts: at(i), run_id: `n-${i}`, task_id: "W1-T1", step: "heartbeat.tick", note: "worker.state in prose" });
  }
  const fixture = writeLedger(rows);
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const full = readLedgerUnionRecordsSync(fixture.dir, { step: STEPS });
  assert.equal(full.rows.length, 10, "control: ten of the thousand lines are in the slice");
  assert.ok(!full.rows.some((row) => row.run_id === "D1"), "control: the decoy is not a slice row");

  const union = createIncrementalLedgerUnion({ holder: "test.w9710-live", reducerVersion: "1" });
  const first = countParses(() => union(fixture.dir, { step: STEPS }));
  assert.ok(first.parses <= 11, `a live pass parsed ${first.parses} of 1,000 lines; only the 10 slice rows and the decoy name a step`);
  assert.deepEqual(first.value.rows, full.rows, "the pre-filtered pass answers exactly what a full parse answers");

  // The tail written since: only its candidates are parsed, and the answer still equals a full parse.
  fixture.append([...noise("tail", 50, 2000), decoy(2001), state("R9", "quiet", 2002)]);
  const second = countParses(() => union(fixture.dir, { step: STEPS }));
  assert.ok(second.parses <= 2, `the tail pass parsed ${second.parses} lines`);
  assert.deepEqual(second.value.rows, readLedgerUnionRecordsSync(fixture.dir, { step: STEPS }).rows);
});

test("W1-T9710: the bound row names its loop parse and seeded rotations", async (t) => {
  const fixture = corpus();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const history = createQuietBoundHistory({
    holder: "test.w9710-bound",
    createReader: (io) => createEscalationTriageHistoryReader({ ...io, readFile: (path) => readFile(path) }),
  });
  const first = await history(fixture.dir);
  assert.equal(first.cost.history_ok, true);
  assert.equal(first.cost.history_rotations_unseen, 3);
  assert.equal(first.cost.history_seeded_rotations, 3, "every rotation the load kept is seeded, none read from its digest");
  assert.equal(first.cost.history_loop_parsed_lines, 3, "the live file's two slice rows and its decoy, nothing else");

  fixture.append([...noise("more", 40, 3100), state("R5", "working", 3101)]);
  const second = await history(fixture.dir);
  assert.equal(second.cost.history_rotations_unseen, 0);
  assert.equal(second.cost.history_seeded_rotations, 0, "nothing new was loaded, so nothing is seeded");
  assert.equal(second.cost.history_loop_parsed_lines, 1, "only the appended slice row is parsed");
  assert.ok(second.cost.history_loop_read_bytes > 0, "and the tail it read is still counted");
});
