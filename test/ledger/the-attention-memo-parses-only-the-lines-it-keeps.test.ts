import assert from "node:assert/strict";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { ledgerRotationEntries } from "#src/lib/ledger-union.js";
import { ATTENTION_LEDGER_LINE, ATTENTION_LEDGER_STEPS, attentionLedgerMemo, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

// W1-T13622: serve's slow lane folds every ledger archive once per boot for the Inbox attention memo. With no line
// pattern it parsed every line of 211 archives to keep four rare steps: 75% of the slow lane's busy time in two host
// profiles on 2026-11-18, near 0.5 cores for minutes after each restart.

const TS = "2026-11-18T05:00:00.000Z";
const kept = [
  { ts: TS, step: "ratify.approved", task_id: "W1-T1", released: "verify-human", run_id: "r1" },
  { ts: TS, step: "verify_human.judged", task_id: "W1-T2", run_id: "r2" },
  { ts: TS, step: "panel.proposal_declined", task_id: "W1-T3", run_id: "r3" },
  { ts: TS, step: "panel.proposal_restored", task_id: "W1-T4", run_id: "r4" },
];
const filler = Array.from({ length: 500 }, (_, i) => ({ ts: TS, step: "run.start", task_id: `W1-T${100 + i}`, run_id: `f${i}` }));
const noParse = () => { throw new Error("a loaded rotation is never parsed inline"); };

test("W1-T13622 criterion 1: the attention memo keeps the same rows and never parses a line outside its steps", async (t) => {
  const fx = writeLedger([], { rotations: [] });
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const lines = [...filler.slice(0, 250), ...kept, ...filler.slice(250)].map((row) => JSON.stringify(row));
  // A torn line carrying none of the kept steps: parsed, it counts as torn; skipped by the pattern, it is never read.
  writeFileSync(join(fx.dir, "ledger.2026-11-18T05-10-00-000Z.ndjson.gz"), gzipSync(`${lines.join("\n")}\n{"step":"run.start","broken\n`));
  const entries = ledgerRotationEntries(readdirSync(fx.dir), fx.dir);
  assert.equal(entries.length, 1, "the fixture is one archive");
  const memo = attentionLedgerMemo({ ledgerPath: join(fx.dir, "ledger.ndjson") } as PanelGraphDeps);
  await memo.load(entries);
  const read = memo.pass().rotationRecords(entries[0]!, noParse);
  assert.deepEqual(read.rows.map((row) => row.step), kept.map((row) => row.step), "the four kept steps, in order, and no filler");
  assert.equal(memo.retention().tornRows, 0, "the torn filler line was skipped before any parse");
});

test("W1-T13622 criterion 2: the line pattern admits every step the memo keeps and skips other steps", () => {
  assert.deepEqual([...ATTENTION_LEDGER_STEPS].sort(), ["panel.proposal_declined", "panel.proposal_restored", "ratify.approved", "verify_human.judged"]);
  for (const step of ATTENTION_LEDGER_STEPS) assert.ok(ATTENTION_LEDGER_LINE.test(JSON.stringify({ ts: TS, step })), step);
  for (const step of ["run.start", "ratifyXapproved", "panel.proposal_approve_requested"]) {
    assert.equal(ATTENTION_LEDGER_LINE.test(JSON.stringify({ ts: TS, step })), false, step);
  }
});
