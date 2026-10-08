/**
 * A windowed union read keeps the last lines of every step to drop a replayed row. Kept as the
 * line itself, each is a slice of the decoded chunk it was split from, and V8 keeps that whole
 * chunk alive for it: one kept line per chunk pins the corpus. A full analytics rescan of core's
 * 409 rotations peaked at 2.4 GB that way and killed the 1 GB slow lane on every
 * `archive-rewritten` refusal (73 deaths, 2026-10-06 to 10-08). The windows hold fingerprints.
 */
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { fingerprintLedgerLine, openLedgerUnion } from "../src/lib/ledger-union.js";
import { makeTempDir } from "../src/lib/tmp.js";

/** One rotation of `lines` unique rows; every 64th is a step seen once, so a window keeps it. */
function corpus(lines: number): { dir: string; bytes: number } {
  const dir = makeTempDir("rmd-dedupe-window");
  const pad = "x".repeat(180);
  const rows: string[] = [];
  for (let k = 0; k < lines; k++) rows.push(JSON.stringify({ ts: "2026-10-07T00:00:00.000Z", step: k % 64 === 0 ? `rare.${k}` : "common", seq: k, pad }));
  const text = `${rows.join("\n")}\n`;
  writeFileSync(join(dir, "ledger.2026-10-07T00-00-00-000Z.ndjson.gz"), gzipSync(text));
  return { dir, bytes: Buffer.byteLength(text) };
}

test("a ledger dedupe window holds a fingerprint of each line, never the line and the chunk under it", async (t) => {
  const lines = 131_072;
  const { dir, bytes } = corpus(lines);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  // Measured from the first row, so the reader's own start-up is not counted; stopped on its last
  // row, the read still holds every window it filled.
  const rows = openLedgerUnion(dir, { dedupeWindowPerStep: 200 })[Symbol.asyncIterator]();
  assert.equal((await rows.next()).done, false, "row 0 was read");
  gc();
  const before = process.memoryUsage().heapUsed;
  for (let k = 1; k < lines; k++) assert.equal((await rows.next()).done, false, `row ${k} was read`);
  gc();
  const held = process.memoryUsage().heapUsed - before;
  await rows.return(undefined);
  t.diagnostic(`held ${(held / 2 ** 20).toFixed(1)} MiB of ${(bytes / 2 ** 20).toFixed(1)} MiB`);
  assert.ok(held < bytes / 3, `the windows hold ${(held / 2 ** 20).toFixed(1)} MiB of a ${(bytes / 2 ** 20).toFixed(1)} MiB corpus`);
});

test("an accepted row's callback is handed the fingerprint its window kept", async (t) => {
  const { dir } = corpus(256);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const handed: Array<[string, string | undefined]> = [];
  for await (const _ of openLedgerUnion(dir, { dedupeWindowPerStep: 200, onAcceptedRecord: (_row, raw, fingerprint) => handed.push([raw, fingerprint]) })) void _;
  assert.equal(handed.length, 256);
  for (const [raw, fingerprint] of handed) assert.equal(fingerprint, fingerprintLedgerLine(raw));
  const unwindowed: Array<string | undefined> = [];
  for await (const _ of openLedgerUnion(dir, { onAcceptedRecord: (_row, _raw, fingerprint) => unwindowed.push(fingerprint) })) void _;
  assert.deepEqual([...new Set(unwindowed)], [undefined], "a read with no window hashes nothing");
});
