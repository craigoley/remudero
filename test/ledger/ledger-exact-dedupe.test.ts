import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { createLedgerExactDedupe } from "#src/lib/ledger-exact-dedupe.js";
import { ndjsonLines, openLedgerUnion } from "#src/lib/ledger-union.js";

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const rows: T[] = [];
  for await (const row of input) rows.push(row);
  return rows;
}

test("W1-T10953: exact dedupe preserves distinct ledger rows and complete corpus controls within byte and disk bounds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-exact-dedupe-"));
  try {
    const index = createLedgerExactDedupe({ scratchDir: dir, maxDiskBytes: 65536, cacheBytes: 4096, maxRowBytes: 4096 });
    try {
      for (const raw of ["\ud800", "\ud801", "�", "\0", "", "😀"]) {
        assert.equal(index.add(raw), true);
        assert.equal(index.add(raw), false);
      }
      assert.equal(index.stats().rows, 6);
      assert.ok(index.stats().diskBytes <= 65536);
      assert.equal(index.stats().cacheTargetBytes, 4096);
      assert.throws(() => index.add("x".repeat(2049)), /ledger-row-byte-bound/);
      assert.equal(index.add("still usable"), true);
      assert.throws(() => { for (let n = 0; n < 100; n++) index.add(`${n}${"x".repeat(2000)}`); }, /ledger-dedupe-disk-bound/);
      assert.throws(() => index.add("\ud800"), /ledger-dedupe-disk-bound/, "a full transaction cannot silently reset exact identity");
      assert.equal(index.stats().state, "partial");
      assert.equal(index.stats().reason, "ledger-dedupe-disk-bound");
      assert.ok(index.stats().diskBytes <= 65536);
    } finally { index.close(); index.close(); }
    assert.deepEqual(readdirSync(dir), [], "the private SQLite scratch is removed");
    const row = (n: number) => JSON.stringify({ ts: "2026-10-02T10:00:00Z", step: "worker.assignment", n });
    writeFileSync(join(dir, "ledger.2026-10-02T11-00-00-000Z.ndjson.gz"), gzipSync(`${row(1)}\n${row(2)}\n`));
    writeFileSync(join(dir, "ledger.2026-10-02T12-00-00-000Z.ndjson"), `${row(2)}\n${row(3)}\n`);
    writeFileSync(join(dir, "ledger.ndjson"), `${row(3)}\n${row(4)}\n`);
    const stats: Array<{ rows: number; diskBytes: number }> = [];
    const rows = await collect(openLedgerUnion(dir, { exactDedupe: { createLedgerExactDedupe, scratchDir: dir, maxDiskBytes: 65536 },
      onExactDedupeStats: value => stats.push(value) }));
    assert.deepEqual(rows.map(row => row.n), [1, 2, 3, 4]);
    assert.equal(stats[0]!.rows, 4, "the maintained union really constructed the exact index");
    assert.ok(stats[0]!.diskBytes <= 65536);
    assert.equal(readdirSync(dir).length, 3);
    await assert.rejects(collect(openLedgerUnion(dir, { exactDedupe: { createLedgerExactDedupe, scratchDir: dir, maxRowBytes: 2 } })), /ledger-row-byte-bound/);
    assert.equal(readdirSync(dir).length, 3, "failed scans release scratch too");
    const stream = openLedgerUnion(dir, { exactDedupe: { createLedgerExactDedupe, scratchDir: dir } });
    await stream.next(); await stream.return(undefined);
    assert.equal(readdirSync(dir).length, 3, "early consumers release scratch");
    assert.equal((await collect(openLedgerUnion(dir, { dedupe: false, exactDedupe: { createLedgerExactDedupe } }))).length, 4);
    await assert.rejects(collect(openLedgerUnion(dir, { dedupeWindowPerStep: 2, exactDedupe: { createLedgerExactDedupe } })), /requires whole-corpus/);
    assert.throws(() => createLedgerExactDedupe({ scratchDir: join(dir, "missing") }), /ledger-dedupe-index-unavailable/);
    await assert.rejects(collect(ndjsonLines((async function* () { yield "abc"; yield "def"; })(), 8)), /ledger-row-byte-bound/);
    await assert.rejects(collect(ndjsonLines((async function* () { yield Buffer.from([0xe2]); })(), 1)), /ledger-row-byte-bound/);
    const closed = createLedgerExactDedupe({ scratchDir: dir });
    closed.close();
    assert.throws(() => closed.add("after close"), /ledger-dedupe-index-failed/);
    await assert.rejects(collect(openLedgerUnion(dir, { exactDedupe: { createLedgerExactDedupe, scratchDir: dir },
      onExactDedupeStats: () => { throw new Error("stats sink unavailable"); } })), /stats sink unavailable/);
    assert.equal(readdirSync(dir).length, 3);
    const controller = new AbortController();
    controller.abort(new Error("audit cancelled"));
    await assert.rejects(collect(openLedgerUnion(dir, { exactDedupe: { createLedgerExactDedupe, scratchDir: dir }, signal: controller.signal })), /audit cancelled/);
    assert.equal(readdirSync(dir).length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("exact index refuses invalid limits before allocating scratch", () => {
  for (const limits of [{ maxDiskBytes: 1 }, { cacheBytes: 0 }, { maxRowBytes: -1 }, { maxDiskBytes: NaN }]) {
    assert.throws(() => createLedgerExactDedupe(limits), /bound/);
  }
});
