// test/an-emergency-stop-read-never-reparses-the-archives.test.ts — W1-T4334: emergencyStopRows parses
// the immutable ledger archives once per archive set and re-reads only the live ledger on each call.
import assert from "node:assert/strict";
import { test } from "node:test";

import { EMERGENCY_STOP_CLEARED_LEDGER_STEP, EMERGENCY_STOP_ISSUED_LEDGER_STEP } from "../src/lib/ledger.js";
import type { LedgerGrepFsDeps } from "../src/lib/ledger-union.js";
import { emergencyStopRows } from "../src/lib/operator-agent.js";

function row(step: string, id: string): string {
  return JSON.stringify({ ts: "2026-09-23T10:00:00.000Z", step, stop_id: id });
}

/** An in-memory state dir: file name -> contents, with every readFileSync counted by path. */
function memoryFs(stateDir: string, files: Map<string, string>) {
  const reads = new Map<string, number>();
  const fs: LedgerGrepFsDeps = {
    readdirSync: () => [...files.keys()],
    existsSync: (path) => files.has(path.slice(stateDir.length + 1)),
    readFileSync: (path) => {
      const name = path.slice(stateDir.length + 1);
      reads.set(name, (reads.get(name) ?? 0) + 1);
      const body = files.get(name);
      if (body === undefined) throw new Error(`ENOENT ${path}`);
      return Buffer.from(body);
    },
    gunzipSync: (buf) => buf,
  };
  return { fs, reads };
}

test("W1-T4334: a second emergency read reuses the parsed archives", () => {
  const stateDir = "/state-reuse";
  const files = new Map([
    ["ledger.2026-09-01.ndjson", `${row(EMERGENCY_STOP_ISSUED_LEDGER_STEP, "s1")}\n`],
    ["ledger.2026-09-02.ndjson", `${row("unrelated.step", "x")}\n`],
    ["ledger.ndjson", `${row(EMERGENCY_STOP_CLEARED_LEDGER_STEP, "s1")}\n`],
  ]);
  const { fs, reads } = memoryFs(stateDir, files);
  const first = emergencyStopRows(`${stateDir}/ledger.ndjson`, fs);
  const second = emergencyStopRows(`${stateDir}/ledger.ndjson`, fs);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((r) => r.step), [EMERGENCY_STOP_ISSUED_LEDGER_STEP, EMERGENCY_STOP_CLEARED_LEDGER_STEP]);
  assert.equal(reads.get("ledger.2026-09-01.ndjson"), 1, "each archive is parsed once, not per read");
  assert.equal(reads.get("ledger.2026-09-02.ndjson"), 1);
  assert.equal(reads.get("ledger.ndjson"), 2, "the live ledger is re-read on every call");
});

test("W1-T4334: a stop written to the live ledger after the first read is seen on the next", () => {
  const stateDir = "/state-live";
  const files = new Map([
    ["ledger.2026-09-01.ndjson", `${row(EMERGENCY_STOP_ISSUED_LEDGER_STEP, "old")}\n`],
    ["ledger.ndjson", ""],
  ]);
  const { fs } = memoryFs(stateDir, files);
  assert.equal(emergencyStopRows(`${stateDir}/ledger.ndjson`, fs).length, 1);
  files.set("ledger.ndjson", `${row(EMERGENCY_STOP_ISSUED_LEDGER_STEP, "new")}\n`);
  const rows = emergencyStopRows(`${stateDir}/ledger.ndjson`, fs);
  assert.deepEqual(rows.map((r) => r.stop_id), ["old", "new"], "archive rows first, then the live one");
});

test("W1-T4334: a new archive file invalidates the cached archive rows", () => {
  const stateDir = "/state-rotate";
  const files = new Map([
    ["ledger.2026-09-01.ndjson", `${row(EMERGENCY_STOP_ISSUED_LEDGER_STEP, "a")}\n`],
    ["ledger.ndjson", ""],
  ]);
  const { fs, reads } = memoryFs(stateDir, files);
  emergencyStopRows(`${stateDir}/ledger.ndjson`, fs);
  files.set("ledger.2026-09-02.ndjson.gz", `${row(EMERGENCY_STOP_CLEARED_LEDGER_STEP, "a")}\n`);
  const rows = emergencyStopRows(`${stateDir}/ledger.ndjson`, fs);
  assert.deepEqual(rows.map((r) => r.step), [EMERGENCY_STOP_ISSUED_LEDGER_STEP, EMERGENCY_STOP_CLEARED_LEDGER_STEP]);
  assert.equal(reads.get("ledger.2026-09-01.ndjson"), 2, "a rotation re-parses the archive set once");
  assert.equal(reads.get("ledger.2026-09-02.ndjson.gz"), 1);
});
