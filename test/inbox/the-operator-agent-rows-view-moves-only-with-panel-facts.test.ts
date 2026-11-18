import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { OPERATOR_AGENT_PROPOSAL_STEP } from "#src/lib/operator-agent.js";
import { createOperatorAgentRowsView, type OperatorAgentRowsData } from "#src/lib/operator-agent-read-model.js";
import { createReadModelTicker, ledgerSource, type ReadModelWorkerMessage } from "#src/lib/read-model-worker.js";
import type { ViewBodyEntry } from "#src/lib/views.js";
import { readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

// W1-T13666: the operator-agent rows view republished its whole body whenever ANY fact advanced the projector, since it
// compared its fold's seq. With a Console open on 2026-11-18 that was 23 full builds per 10 min (5.8 s of heavy-lane CPU)
// for no new `panel.*` row. It now moves only with a panel fact, and declares that read so its source is judged by it.

const line = (row: Record<string, unknown>): string => `${JSON.stringify(row)}\n`;

function worker(stateDir: string) {
  const posted: ViewBodyEntry[] = [];
  const sourceReads: Array<Record<string, Record<string, string | null>>> = [];
  const view = createOperatorAgentRowsView(ledgerSource);
  /** Bodies the view built: what each build costs is mapping and serializing every panel row. */
  let built = 0;
  const counted = { ...view, materialize: (ctx: Parameters<typeof view.materialize>[0]) => { const out = view.materialize(ctx); built += out.length; return out; } };
  const ticker = createReadModelTicker({
    stateDir, instances: [{ name: "core", ledgerDir: stateDir }], views: [counted], holder: "w1-t13655",
    post: (message: ReadModelWorkerMessage) => {
      if (message.type === "body" && message.entry.view === "operator-agent-rows") posted.push(message.entry);
      if (message.type === "sources" && message.ledgerReads) sourceReads.push(message.ledgerReads);
    },
  });
  return { posted, sourceReads, built: () => built, settle: () => { for (let i = 0; i < 6; i++) ticker.tick(); }, release: () => void ticker.release() };
}

test("W1-T13666 criterion 1: facts that are not panel rows build no operator-agent rows body, and a panel fact builds it again", (t) => {
  const dir = readModelFixtureDir(t, "w1-t13655-rows").dir;
  const ledger = join(dir, "ledger.ndjson");
  writeFileSync(ledger, line({ ts: "2026-11-18T10:00:00.000Z", step: OPERATOR_AGENT_PROPOSAL_STEP, n: 1 }));
  const w = worker(dir);
  t.after(() => w.release());
  w.settle();
  assert.ok(w.built() >= 1, "the first fold builds the rows");
  const before = w.built();
  for (let i = 0; i < 5; i++) {
    appendFileSync(ledger, line({ ts: `2026-11-18T10:0${i + 1}:00.000Z`, step: "worker.assignment", run_id: `r${i}`, n: 100 + i }));
    w.settle();
  }
  assert.equal(w.built(), before, "five facts the store keeps but that are not panel rows build no new operator-agent body");
  appendFileSync(ledger, line({ ts: "2026-11-18T10:09:00.000Z", step: OPERATOR_AGENT_PROPOSAL_STEP, n: 2 }));
  w.settle();
  assert.ok(w.built() > before, "a panel fact builds the rows again");
  const data = w.posted.at(-1)!.body.data as OperatorAgentRowsData;
  assert.deepEqual(data.rows.map((row) => row.n), [1, 2]);
  assert.equal(data.newestTs, "2026-11-18T10:09:00.000Z");
});

test("W1-T13666 criterion 2: the view declares the newest panel fact as its ledger read, unmoved by other facts", (t) => {
  const dir = readModelFixtureDir(t, "w1-t13655-reads").dir;
  const ledger = join(dir, "ledger.ndjson");
  writeFileSync(ledger, line({ ts: "2026-11-18T10:00:00.000Z", step: OPERATOR_AGENT_PROPOSAL_STEP, n: 1 }));
  const w = worker(dir);
  t.after(() => w.release());
  w.settle();
  appendFileSync(ledger, line({ ts: "2026-11-18T10:05:00.000Z", step: "worker.assignment", run_id: "r9" }) + line({ ts: "2026-11-18T10:06:00.000Z", step: "panelx.not_a_panel_row" }));
  w.settle();
  const reads = w.sourceReads.at(-1)?.["operator-agent-rows"];
  assert.deepEqual(reads, { "ledger:core": "2026-11-18T10:00:00.000Z" }, "the read names the newest panel fact, not the projector head");
  const source = w.posted.at(-1)!.body.sources.find((s) => s.name === "ledger:core");
  assert.equal(source?.asOf, "2026-11-18T10:00:00.000Z", "the posted body's ledger source is stamped with that read");
});
