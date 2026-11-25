/**
 * W1-T14837: on 2026-11-25 the host's routing review named 112 core rows future-dated; all but 5 were rows the daemon
 * appended while the 20-minute scan ran. Both ledger readers fixed "now" at the start of the read, so any scan longer
 * than the 5-minute allowance marked itself partial. "Now" now moves with the scan; a row stamped past the advanced
 * clock is still future-dated, and the routing review skips the Field Trials quarantine's fingerprints by name.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readFieldTrialsLedger } from "#src/lib/field-trials-flow.js";
import { quarantinedLedgerFingerprints } from "#src/lib/field-trials-ledger-quarantine.js";
import { fingerprintLedgerLine } from "#src/lib/ledger-union.js";

// `scripts/**` has no declarations, so the review loads through a dynamic specifier, as its other suites load it.
const reviewModule = "#scripts/private-routing-daily-review.mjs";
const { dailyRoutingReview } = await import(reviewModule);

const asOf = "2026-10-02T14:00:00.000Z";
const MIN = 60_000;
const at = (minutes: number) => new Date(Date.parse(asOf) + minutes * MIN).toISOString();
const line = (row: unknown) => JSON.stringify(row);
// The clock has advanced 20 minutes by the time any row is read.
const twentyMinutesIn = () => 20 * MIN;

function ledger(rows: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t14837-"));
  const stateDir = join(dir, "state");
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, "ledger.ndjson"), `${[line({ ts: at(-60), step: "worker.assignment", task_id: "W1-T1" }), ...rows].join("\n")}\n`);
  return { dir, stateDir, close: () => rmSync(dir, { recursive: true, force: true }) };
}
async function review(rows: string[], extra: Record<string, unknown> = {}) {
  const f = ledger(rows);
  try {
    const { snapshot } = await dailyRoutingReview({ sources: [{ label: "core", stateDir: f.stateDir }], outDir: join(f.dir, "out"),
      asOf, retention: { scratchDir: f.dir }, elapsedMs: twentyMinutesIn, ...extra });
    return snapshot.sources[0];
  } finally { f.close(); }
}
async function fieldTrials(rows: string[]) {
  const f = ledger(rows);
  try { return await readFieldTrialsLedger(f.stateDir, Date.parse(asOf), new Set(), twentyMinutesIn); }
  finally { f.close(); }
}

test("W1-T14837 criterion 1: a row stamped 10 minutes after a scan began 20 minutes ago is not future-dated", async () => {
  const appended = line({ ts: at(10), step: "spawn.routed" });
  const source = await review([appended]);
  assert.equal(source.futureRows, 0);
  assert.ok(!source.reasons.includes("ledger-source-future-dated"), source.reasons.join(","));
  const read = await fieldTrials([appended]);
  assert.equal(read.futureRows, 0);
  assert.equal(read.state, "observed");
});

test("W1-T14837 criterion 2: invariant:a-truly-future-row-is-still-future", async () => {
  const future = line({ ts: at(26), step: "cli.invoked" });
  const source = await review([future]);
  assert.equal(source.futureRows, 1);
  assert.ok(source.reasons.includes("ledger-source-future-dated"));
  const read = await fieldTrials([future]);
  assert.equal(read.futureRows, 1);
  assert.equal(read.reason, "ledger-source-future-dated");
});

test("W1-T14837 criterion 3: the routing review skips a Field Trials quarantine fingerprint without a future-dated reason", async () => {
  const future = line({ ts: "2027-10-14T21:23:34.063Z", step: "cli.invoked" });
  const quarantine = quarantinedLedgerFingerprints([{ fingerprint: fingerprintLedgerLine(future), ts: "2027-10-14T21:23:34.063Z", reason: "test" }]);
  const source = await review([future], { quarantinedFingerprints: quarantine });
  assert.equal(source.quarantinedRows, 1);
  assert.equal(source.futureRows, 0);
  assert.ok(!source.reasons.includes("ledger-source-future-dated"), source.reasons.join(","));
  assert.equal(source.findings.filter((item: { kind: string }) => item.kind === "future-timestamp").length, 0);
});
