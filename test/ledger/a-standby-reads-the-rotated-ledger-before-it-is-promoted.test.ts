import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedgerRotationCache } from "#src/lib/ledger-rotation-cache.js";
import { readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import { readRestartHistoryLines } from "#src/lib/daemon.js";

const row = (ts: string, step: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ts, step, ...extra });

function stateDir(t: import("node:test").TestContext): { dir: string; rotation: string; live: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1t14635-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rotation = join(dir, "ledger.2026-11-24T10-00-00-000Z.ndjson.gz");
  writeFileSync(rotation, gzipSync([row("2026-11-24T09:00:00.000Z", "run.start", { run_id: "R1" }),
    row("2026-11-24T09:00:01.000Z", "daemon.tick"), row("2026-11-24T09:00:02.000Z", "verdict", { run_id: "R1" })].join("\n") + "\n"));
  const live = join(dir, "ledger.ndjson");
  writeFileSync(live, row("2026-11-24T11:00:00.000Z", "run.start", { run_id: "R2" }) + "\n");
  return { dir, rotation, live };
}

test("W1-T14635 a rotation read before the promotion is not read again by the boot", (t) => {
  const s = stateDir(t);
  const cache = createLedgerRotationCache();
  const opts = { step: ["run.start", "verdict"], refuseIncomplete: true };
  const warm = cache.read(s.dir, opts);
  assert.deepEqual(cache.counts(), { hits: 0, misses: 1 });
  // The active daemon keeps writing to the live file between the warm read and the promotion.
  writeFileSync(s.live, [row("2026-11-24T11:00:00.000Z", "run.start", { run_id: "R2" }),
    row("2026-11-24T11:30:00.000Z", "verdict", { run_id: "R2" })].join("\n") + "\n");
  const boot = cache.read(s.dir, opts);
  assert.deepEqual(cache.counts(), { hits: 1, misses: 1 }, "the boot answered the rotation from the cache");
  assert.equal(warm.rows.length, 3);
  assert.deepEqual(boot.rows, readLedgerUnionRecordsSync(s.dir, opts).rows, "the boot's rows equal an uncached read");
  assert.equal(boot.rows.length, 4, "the live row written after the warm read is read");
});

test("W1-T14635 a rotation that changed after the warm read is read again", (t) => {
  const s = stateDir(t);
  const cache = createLedgerRotationCache();
  cache.read(s.dir, { step: "run.start" });
  writeFileSync(s.rotation, gzipSync(row("2026-11-24T09:00:00.000Z", "run.start", { run_id: "R9" }) + "\n"));
  utimesSync(s.rotation, new Date(), new Date(Date.now() + 5000));
  const again = cache.read(s.dir, { step: "run.start" });
  assert.deepEqual(cache.counts(), { hits: 0, misses: 2 });
  assert.deepEqual(again.rows.map((r) => r.run_id), ["R9", "R2"]);
});

test("W1-T14635 the cache keeps only the asked steps, and a different filter is its own entry", (t) => {
  const s = stateDir(t);
  const cache = createLedgerRotationCache();
  assert.equal(cache.read(s.dir, { step: "verdict" }).rows.length, 1);
  assert.equal(cache.read(s.dir, {}).rows.length, 4, "an unfiltered read is not answered from the verdict-only entry");
  assert.deepEqual(cache.counts(), { hits: 0, misses: 2 });
  cache.dispose();
  cache.read(s.dir, { step: "verdict" });
  assert.deepEqual(cache.counts(), { hits: 0, misses: 3 }, "dispose dropped the kept rows");
});

test("W1-T14635 the restart history read through the cache equals the uncached read", (t) => {
  const s = stateDir(t);
  const cache = createLedgerRotationCache();
  const now = Date.parse("2026-11-24T12:00:00.000Z");
  readRestartHistoryLines(s.dir, now, cache.read);
  const cached = readRestartHistoryLines(s.dir, now, cache.read);
  assert.deepEqual(cached, readRestartHistoryLines(s.dir, now));
  assert.equal(cache.counts().hits, 1);
});
