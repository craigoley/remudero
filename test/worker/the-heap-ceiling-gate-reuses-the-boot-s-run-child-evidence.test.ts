// W1-T14756: the heap ceiling gate decides `auto` from the tracker this process's boot folded, not from a second
// whole-ledger union read (that read held the first heap proposal ~110 s on the 11-24 22:12Z hand-over).
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runChildrenAdoptedGate } from "#src/lib/daemon-memory-policy.js";
import { bootRunChildMode } from "#src/lib/run-child-mode.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const PROMOTED = [{ step: "run_child.mode_decision", ts: "2026-10-27T00:00:00.000Z", from: "shadow", to: "on" }];
const AUTO = () => "auto" as const;

test("W1-T14756 the heap ceiling gate reads no ledger union once the boot has folded its evidence", () => {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}heap-gate-`));
  try {
    let bootReads = 0;
    bootRunChildMode({ stateDir, auto: true, liveRows: [], log: () => {},
      read: (() => { bootReads += 1; return { ok: true, rows: PROMOTED, unread: [] }; }) as never });
    assert.equal(bootReads, 1, "the boot reads the union once");
    let gateReads = 0;
    const gate = runChildrenAdoptedGate(stateDir, AUTO, () => { gateReads += 1; return { rows: [], unread: [] }; });
    assert.equal(gateReads, 0, "the gate reuses the boot's evidence instead of reading the union again");
    assert.deepEqual(gate, { applies: true, reason: "sweep.runChild.mode auto decided on: runs are adopted children" });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("W1-T14756 with no boot tracker the heap ceiling gate still reads the union", () => {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}heap-gate-`));
  try {
    let gateReads = 0;
    const gate = runChildrenAdoptedGate(stateDir, AUTO, () => { gateReads += 1; return { rows: [], unread: ["ledger.1.ndjson.gz"] }; });
    assert.equal(gateReads, 1);
    assert.deepEqual(gate, { applies: false, reason: "auto's evidence is unreadable (ledger.1.ndjson.gz)" });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
