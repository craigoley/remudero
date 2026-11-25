/**
 * W1-T14781: five 2027-dated rows in one archive made every Field Trials ledger read partial. Craig chose
 * to quarantine exactly those rows by line fingerprint; any other future row still marks the read partial.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { readFieldTrialsLedger } from "#src/lib/field-trials-flow.js";
import { QUARANTINED_LEDGER_ROWS, quarantinedLedgerFingerprints } from "#src/lib/field-trials-ledger-quarantine.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const NOW = Date.parse("2026-11-25T02:00:00.000Z");
const present = { ts: "2026-11-24T12:00:00.000Z", run_id: "r1", task_id: "T1", step: "worker.attempt" };
const future = { ts: "2027-10-14T21:23:34.063Z", run_id: "CLI-1", task_id: "CLI", step: "cli.invoked", verb: "onboard" };
const digest = (row: Record<string, unknown>) => createHash("sha256").update(JSON.stringify(row)).digest("hex");

test("W1-T14781: a quarantined ledger row is skipped and named", async () => {
  const ledger = writeLedger([present], { rotations: [{ at: "2026-11-23T22:53:59.999Z", gz: true, rows: [future] }] });
  try {
    const read = await readFieldTrialsLedger(ledger.dir, NOW, quarantinedLedgerFingerprints([{ fingerprint: digest(future), ts: future.ts, reason: "test" }]));
    assert.equal(read.state, "observed", JSON.stringify({ reason: read.reason, futureRows: read.futureRows }));
    assert.equal(read.reason, null);
    assert.equal(read.futureRows, 0);
    assert.equal(read.quarantinedRows, 1);
    assert.deepEqual(read.quarantinedFingerprints, [digest(future)]);
    assert.equal(read.forms.gzip, 1, "the quarantined row came from the gzip archive form");
  } finally {
    rmSync(ledger.dir, { recursive: true, force: true });
  }
});

test("W1-T14781: an unlisted future ledger row still marks the read partial", async () => {
  const other = { ...future, ts: "2027-10-14T21:23:34.064Z" };
  const ledger = writeLedger([present, other]);
  try {
    const read = await readFieldTrialsLedger(ledger.dir, NOW, quarantinedLedgerFingerprints([{ fingerprint: digest(future), ts: future.ts, reason: "test" }]));
    assert.equal(read.state, "observed-partial");
    assert.equal(read.reason, "ledger-source-future-dated");
    assert.equal(read.futureRows, 1);
    assert.equal(read.quarantinedRows, undefined, "a read that matched nothing carries no quarantine fields");
    const byDefault = await readFieldTrialsLedger(ledger.dir, NOW);
    assert.equal(byDefault.reason, "ledger-source-future-dated", "the production list never matches an unlisted line");
  } finally {
    rmSync(ledger.dir, { recursive: true, force: true });
  }
});

test("W1-T14781: the ledger quarantine names exactly five rows", () => {
  assert.equal(QUARANTINED_LEDGER_ROWS.length, 5);
  assert.deepEqual(QUARANTINED_LEDGER_ROWS.map((row) => row.ts), ["2027-10-14T21:23:34.063Z", "2027-10-14T21:23:34.137Z",
    "2027-10-14T21:23:38.323Z", "2027-10-14T21:24:38.162Z", "2027-10-14T21:24:52.494Z"]);
  for (const row of QUARANTINED_LEDGER_ROWS) assert.match(row.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(quarantinedLedgerFingerprints().size, 5, "five distinct fingerprints");
  assert.ok(Object.isFrozen(QUARANTINED_LEDGER_ROWS));
});
