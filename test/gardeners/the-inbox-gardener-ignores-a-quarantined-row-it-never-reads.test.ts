// W1-T13586: on the host (2026-11-18 02:30Z) the Inbox gardener had read all 194 ledger archives, yet every shadow pass
// reported coverage:ledger partial. Its read model had quarantined the five W1-T5407 `cli.invoked` rows stamped
// 2027-10-14, and any quarantine set a sticky fault that nothing cleared. Only a quarantined row the gardener reads may
// keep its read partial, and a fault from an older projection goes with that projection's rows.
import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { test, type TestContext } from "node:test";
import { readInboxGardenerLedger } from "#src/lib/inbox-gardener.js";
import { readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

const SCOPE = { repository: "craigoley/remudero", instance: "core", root: "/r" };
const PAST = Date.now() - 86_400_000, FUTURE = Date.now() + 330 * 86_400_000;
const row = (at: number, step: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ts: new Date(at).toISOString(), host: "h", run_id: "R", task_id: "CLI", step, ...extra });

/** An archive holding one relevant row, plus a live ledger holding `liveRows`. */
function ledgerDir(t: TestContext, liveRows: string[]): string {
  // The read model publishes its transaction records from a worker after the read returns; the shared fixture flushes
  // them before it removes the dir, which a bare rmSync races (ENOTEMPTY under the flake screen).
  const { dir } = readModelFixtureDir(t, "gardener-quarantine");
  writeFileSync(join(dir, "ledger.2026-11-17T16-21-21-036Z.ndjson.gz"),
    gzipSync(row(PAST, "panel.proposal_declined", { proposal_id: "ask-old" }) + "\n" + row(PAST + 1000, "worker.activity") + "\n"));
  writeFileSync(join(dir, "ledger.ndjson"), liveRows.map(r => r + "\n").join(""));
  return dir;
}
const futureCli = (i: number) => row(FUTURE + i, "cli.invoked", { verb: "wipe-test", argv_shape: [] });

test("W1-T13586 criterion 1: a future-stamped row of a step the gardener never reads is quarantined and the read is observed", t => {
  const dir = ledgerDir(t, [row(PAST + 2000, "worker.activity"), futureCli(0), futureCli(1)]);
  const read = readInboxGardenerLedger(dir, SCOPE, ["ask-old"]);
  assert.equal(read.state, "observed");
  assert.deepEqual(read.rows.map(r => `${r.proposal_id}:${r.step}`), ["ask-old:panel.proposal_declined"]);
  assert.equal(readInboxGardenerLedger(dir, SCOPE, ["ask-old"]).state, "observed", "and stays observed on the next pass");
});

test("W1-T13586 criterion 2: invariant relevant-quarantine-stays-partial, a future-stamped relevant row keeps the read partial", t => {
  const named = ledgerDir(t, [futureCli(0), row(FUTURE, "panel.proposal_declined", { proposal_id: "ask-new" })]);
  assert.equal(readInboxGardenerLedger(named, SCOPE, ["ask-old"]).state, "partial", "a quarantined relevant step");
  const nested = ledgerDir(t, [JSON.stringify({ ts: new Date(FUTURE).toISOString(), wrap: { step: "x" }, step: "inbox.gardener_retired" })
    .replace('"wrap":{"step":"x"}', '"wrap":{"step":"cli.invoked"}')]);
  assert.equal(readInboxGardenerLedger(nested, SCOPE, ["ask-old"]).state, "partial", "a relevant step behind a nested one");
  const control = ledgerDir(t, [futureCli(0)]);
  assert.equal(readInboxGardenerLedger(control, SCOPE, ["ask-old"]).state, "observed", "the control: only an irrelevant row quarantined");
});

test("W1-T13586 criterion 3: a store holding the old projection's sticky torn-or-quarantined fault re-reads and reaches observed", t => {
  const dir = ledgerDir(t, [futureCli(0)]);
  assert.equal(readInboxGardenerLedger(dir, SCOPE, ["ask-old"]).state, "observed");
  const models = join(dir, "inbox-gardener-evidence", "read-model");
  const [store] = readdirSync(models).filter(name => name.endsWith(".sqlite"));
  assert.ok(store, "the read pass built its store");
  const db = new DatabaseSync(join(models, store));
  db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES('inbox-source-fault', 'torn-or-quarantined')").run();
  db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES('projection:inbox-gardener-evidence', '2')").run();
  db.close();
  const read = readInboxGardenerLedger(dir, SCOPE, ["ask-old"]);
  assert.equal(read.state, "observed");
  assert.deepEqual(read.rows.map(r => `${r.proposal_id}:${r.step}`), ["ask-old:panel.proposal_declined"], "the re-read found the archived row again");
});
