import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { LEDGER_FUTURE_STAMP_TOLERANCE_MS } from "#src/lib/ledger.js";
import { readPrOwnerLedgerProjection } from "#src/lib/pr-owner-ledger.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

type Row = Record<string, unknown>;
const NOW = Date.parse("2026-11-04T14:00:00.000Z");
const at = (ms: number) => new Date(ms).toISOString();
const text = (rows: Row[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const sweep = (ms: number, fields: Row = {}): Row => ({ ts: at(ms), step: "sweep.disposed", pr_number: 44, task_id: "T", head_sha: "H", disposition: "wait", ...fields });
const fix = (ms: number, fields: Row = {}): Row => ({ ts: at(ms), step: "fix.dispatch", task_id: "T", head_sha: "H", ...fields });

function corpus(archived: Row[], live: Row[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t11323-owner-`));
  writeFileSync(join(dir, "ledger.2026-11-03T18-21-51-731Z.ndjson.gz"), gzipSync(text(archived)));
  writeFileSync(join(dir, "ledger.ndjson"), text(live));
  return dir;
}

test("W1-T11323 criterion 1: a row stamped past the tolerance is neither the corpus newest nor the latest fix or sweep, and is counted", async () => {
  const year = 365 * 24 * 3_600_000;
  const dir = corpus(
    [
      { ts: at(NOW + year), step: "cli.invoked", run_id: "CLI-1823549014063" },
      fix(NOW + year, { run_id: "future-fix" }),
      sweep(NOW + year, { run_id: "future-sweep", disposition: "blocked-fixable" }),
    ],
    [fix(NOW - 3_600_000, { run_id: "real-fix" }), sweep(NOW - 60_000, { run_id: "real-sweep" })],
  );
  try {
    const got = await readPrOwnerLedgerProjection(dir, 44, () => [], NOW);
    assert.equal(got.ok, true);
    assert.equal(got.corpusNewestTs, at(NOW - 60_000), "the newest real row, not the 2027 one");
    assert.equal(got.latestFix?.run_id, "real-fix");
    assert.equal(got.latestSweep?.run_id, "real-sweep");
    assert.equal(got.futureStampedSkipped, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("W1-T11323 criterion 1: a row inside the tolerance still counts, and a corpus with no future rows projects as before", async () => {
  const inside = NOW + LEDGER_FUTURE_STAMP_TOLERANCE_MS - 1_000;
  const dir = corpus([fix(NOW - 7_200_000, { run_id: "older-fix" })], [sweep(inside, { run_id: "near-sweep" })]);
  try {
    const got = await readPrOwnerLedgerProjection(dir, 44, () => [], NOW);
    assert.equal(got.corpusNewestTs, at(inside));
    assert.equal(got.latestSweep?.run_id, "near-sweep");
    assert.equal(got.latestFix?.run_id, "older-fix");
    assert.equal(got.futureStampedSkipped, 0);
    const unbounded = await readPrOwnerLedgerProjection(dir, 44, () => [], Number.MAX_SAFE_INTEGER);
    assert.deepEqual({ ...unbounded, archiveFiles: [] }, { ...got, archiveFiles: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
