// test/an-emergency-stop-read-never-reparses-the-archives.test.ts — W1-T4334: emergencyStopRows parses
// each immutable ledger archive once and re-reads only the live ledger on each call. A new rotation costs
// its own parse: it never re-parses the archives already read.
import assert from "node:assert/strict";
import { statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { EMERGENCY_STOP_CLEARED_LEDGER_STEP, EMERGENCY_STOP_ISSUED_LEDGER_STEP } from "../src/lib/ledger.js";
import { emergencyStopRows } from "../src/lib/operator-agent.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const ARCHIVE_MTIME_S = 1_790_000_000;

function row(step: string, id: string): Record<string, unknown> {
  return { ts: "2026-09-23T10:00:00.000Z", step, stop_id: id };
}

/** Same length, same mtime, unreadable bytes: only a read that re-opens the archive can notice. */
function spoil(path: string): void {
  const before = statSync(path);
  writeFileSync(path, Buffer.alloc(before.size, 0x21));
  utimesSync(path, ARCHIVE_MTIME_S, ARCHIVE_MTIME_S);
}

function pinMtime(dir: string, name: string): string {
  const path = join(dir, name);
  utimesSync(path, ARCHIVE_MTIME_S, ARCHIVE_MTIME_S);
  return path;
}

test("W1-T4334: a second emergency read reuses the parsed archives", () => {
  const ledger = writeLedger([row(EMERGENCY_STOP_CLEARED_LEDGER_STEP, "s1")], {
    rotations: [
      { at: "2026-09-01T00:00:00.000Z", rows: [row(EMERGENCY_STOP_ISSUED_LEDGER_STEP, "s1")] },
      { at: "2026-09-02T00:00:00.000Z", rows: [row("unrelated.step", "x")], gz: true },
    ],
  });
  const archive = pinMtime(ledger.dir, "ledger.2026-09-01T00-00-00-000Z.ndjson");
  const first = emergencyStopRows(ledger.path);
  spoil(archive);
  const second = emergencyStopRows(ledger.path);
  assert.deepEqual(second, first, "the second read is answered from the parsed archive");
  assert.deepEqual(first.map((r) => r.step), [EMERGENCY_STOP_ISSUED_LEDGER_STEP, EMERGENCY_STOP_CLEARED_LEDGER_STEP]);
});

test("W1-T4334: a stop written to the live ledger after the first read is seen on the next", () => {
  const ledger = writeLedger([], { rotations: [{ at: "2026-09-01T00:00:00.000Z", rows: [row(EMERGENCY_STOP_ISSUED_LEDGER_STEP, "old")] }] });
  assert.equal(emergencyStopRows(ledger.path).length, 1);
  ledger.append([row(EMERGENCY_STOP_ISSUED_LEDGER_STEP, "new")]);
  const rows = emergencyStopRows(ledger.path);
  assert.deepEqual(rows.map((r) => r.stop_id), ["old", "new"], "archive rows first, then the live one");
});

test("a new rotation parses only itself and never the archives already read", () => {
  const ledger = writeLedger([], { rotations: [{ at: "2026-09-01T00:00:00.000Z", rows: [row(EMERGENCY_STOP_ISSUED_LEDGER_STEP, "a")] }] });
  const archive = pinMtime(ledger.dir, "ledger.2026-09-01T00-00-00-000Z.ndjson");
  emergencyStopRows(ledger.path);
  spoil(archive);
  writeLedger([], { dir: ledger.dir, rotations: [{ at: "2026-09-02T00:00:00.000Z", rows: [row(EMERGENCY_STOP_CLEARED_LEDGER_STEP, "a")], gz: true }] });
  const rows = emergencyStopRows(ledger.path);
  assert.deepEqual(rows.map((r) => r.step), [EMERGENCY_STOP_ISSUED_LEDGER_STEP, EMERGENCY_STOP_CLEARED_LEDGER_STEP], "the old archive's row still comes from its first parse");
});

test("W1-T4334: an unreadable state directory reads as no emergency rows", () => {
  const ledger = writeLedger();
  assert.deepEqual(emergencyStopRows(join(ledger.dir, "missing", "ledger.ndjson")), []);
});
