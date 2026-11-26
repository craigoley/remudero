/**
 * W1-T14943: the 2026-11-26 04:17Z Field Trials pass read core's ledger observed-partial with one reason,
 * ledger-row-over-bound: under exact dedupe, the union read dropped any row over a default 1 MiB (UTF-16 bytes), and
 * the exact-dedupe index refused one. Neither has a default now; an explicit maxRowBytes still binds as before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createLedgerExactDedupe } from "#src/lib/ledger-exact-dedupe.js";
import { openLedgerUnion } from "#src/lib/ledger-union.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const TWO_MIB = 2 * 1024 * 1024;

async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const row of rows) out.push(row);
  return out;
}

/** A state dir whose archive and live ledger both hold the same 2 MiB row, between two small ones. */
function withOversizedCorpus(fn: (dir: string, big: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14943-`));
  const big = JSON.stringify({ ts: "2026-11-26T04:20:00Z", step: "routing.review", n: 2, note: "x".repeat(TWO_MIB) });
  const row = (n: number) => JSON.stringify({ ts: "2026-11-26T04:20:00Z", step: "routing.review", n });
  writeFileSync(join(dir, "ledger.2026-11-26T04-00-00-000Z.ndjson.gz"), gzipSync(`${row(1)}\n${big}\n`));
  writeFileSync(join(dir, "ledger.ndjson"), `${big}\n${row(3)}\n`);
  return fn(dir, big).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("W1-T14943 criterion 1: a 2 MiB ledger row is read and deduped by an exact-dedupe union read with no maxRowBytes set", async () => {
  await withOversizedCorpus(async (dir, big) => {
    assert.ok(Buffer.byteLength(big) > TWO_MIB, "the row is over 2 MiB");
    const oversized: unknown[] = [];
    const stats: Array<{ rows: number; maxRowBytes: number | null; state: string }> = [];
    const rows = await collect(openLedgerUnion(dir, {
      exactDedupe: { createLedgerExactDedupe, scratchDir: dir },
      onOversizedRow: (item) => { oversized.push(item); },
      onExactDedupeStats: (value) => { stats.push(value); },
    }));
    assert.deepEqual(rows.map((r) => r.n), [1, 2, 3], "the 2 MiB row is read once, between its neighbours");
    assert.equal(String(rows[1]!.note).length, TWO_MIB, "the row is read whole");
    assert.deepEqual(oversized, [], "nothing is reported oversized");
    assert.deepEqual([stats[0]!.rows, stats[0]!.maxRowBytes, stats[0]!.state], [3, null, "observed"]);
    const index = createLedgerExactDedupe({ scratchDir: dir });
    try {
      assert.equal(index.add(big), true, "the index takes a 2 MiB row with no bound set");
      assert.equal(index.add(big), false, "and collapses its duplicate");
    } finally { index.close(); }
  });
});

test("W1-T14943 criterion 2: an explicit row bound still binds and duplicates still collapse", async () => {
  await withOversizedCorpus(async (dir, big) => {
    const oversized: unknown[] = [];
    const rows = await collect(openLedgerUnion(dir, {
      exactDedupe: { createLedgerExactDedupe, scratchDir: dir, maxRowBytes: 1024 * 1024 },
      onOversizedRow: (item) => { oversized.push(item); },
    }));
    assert.deepEqual(rows.map((r) => r.n), [1, 3], "an explicit bound still drops the 2 MiB row");
    assert.equal(oversized.length, 2, "and reports it once per source");
    await assert.rejects(collect(openLedgerUnion(dir, { exactDedupe: { createLedgerExactDedupe, scratchDir: dir, maxRowBytes: 1024 * 1024 } })),
      /ledger-row-byte-bound/, "with no callback the explicit bound still ends the read");
    const index = createLedgerExactDedupe({ scratchDir: dir, maxRowBytes: 1024 * 1024 });
    try {
      assert.throws(() => index.add(big), /ledger-row-byte-bound/, "the index still refuses a row over an explicit bound");
      assert.equal(index.add("small"), true);
      assert.equal(index.add("small"), false, "exact duplicates still collapse to one");
    } finally { index.close(); }
  });
});
