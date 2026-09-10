/**
 * The retro's retained-byte bound originally sat OUTSIDE openLedgerUnion's process-wide exact-line
 * Set. The 2026-09-10 production corpus had grown to 771 rotations, so the reader still retained
 * every distinct input line even while it evicted old output rows. These tests pin one ownership
 * rule: retro dedupe owns exactly the rows still retained for the report, never the whole stream.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { readRetroLedgerNdjson } from "../src/lib/retro.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

function stateDir(kind: string): { root: string; state: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}`));
  const state = join(root, "state");
  mkdirSync(state);
  return { root, state };
}

function writePlain(path: string, rows: readonly Record<string, unknown>[]): void {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

test("a newer duplicate survives after its older copy leaves the retained window", async () => {
  const { root, state } = stateDir("retro-retained-dedupe-");
  try {
    const duplicate = { ts: "2026-09-01T00:00:00.000Z", step: "duplicate", payload: "a" };
    const middle = { ts: "2026-09-01T00:00:01.000Z", step: "middle", payload: "b" };
    writePlain(join(state, "ledger.2026-09-01T00-00-00-000Z.ndjson"), [duplicate, middle]);
    writePlain(join(state, "ledger.ndjson"), [duplicate]);

    const maxBytes = Buffer.byteLength(JSON.stringify(middle), "utf8") + 1;
    const read = await readRetroLedgerNdjson(state, { maxBytes });

    assert.equal(read.ndjson, JSON.stringify(duplicate), "the live copy must replace the evicted archive copy");
    assert.equal(read.rowsKept, 1);
    assert.equal(read.droppedRows, 2);
    assert.equal(read.duplicatesCollapsed, 0, "an evicted identity cannot suppress a newer copy");
    assert.equal(read.dedupeEntriesPeak, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the row ceiling bounds exact dedupe and a repeated identity becomes newest", async () => {
  const { root, state } = stateDir("retro-row-bound-");
  try {
    const row = (id: string): Record<string, unknown> => ({ ts: "2026-09-01T00:00:00.000Z", step: id });
    writePlain(join(state, "ledger.ndjson"), [row("A"), row("B"), row("A"), row("C")]);

    const read = await readRetroLedgerNdjson(state, { maxBytes: 1_000_000, maxRows: 2 });
    assert.deepEqual(read.ndjson.split("\n").map((line) => JSON.parse(line)), [row("A"), row("C")]);
    assert.equal(read.dedupeEntriesPeak, 2, "the identity map must never outgrow the configured row ceiling");
    assert.equal(read.duplicatesCollapsed, 1);
    assert.equal(read.droppedRows, 1, "refreshing A makes B, not A, the oldest identity evicted by C");
    assert.equal(read.rowsKept + read.droppedRows + read.duplicatesCollapsed, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the byte ceiling counts UTF-8 bytes rather than UTF-16 code units", async () => {
  const { root, state } = stateDir("retro-utf8-byte-bound-");
  try {
    const first = { ts: "2026-09-01T00:00:00.000Z", step: "first", payload: "💡".repeat(20) };
    const second = { ts: "2026-09-01T00:00:01.000Z", step: "second", payload: "💡".repeat(20) };
    writePlain(join(state, "ledger.ndjson"), [first, second]);
    const maxBytes = Buffer.byteLength(JSON.stringify(second), "utf8") + 1;

    const read = await readRetroLedgerNdjson(state, { maxBytes });
    assert.equal(read.ndjson, JSON.stringify(second));
    assert.equal(read.droppedRows, 1);
    assert.ok(Buffer.byteLength(read.ndjson, "utf8") <= maxBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid byte and row ceilings are refused before the corpus is opened", async () => {
  await assert.rejects(readRetroLedgerNdjson("/not-opened", { maxBytes: 0 }), /maxBytes must be a positive safe integer/);
  await assert.rejects(readRetroLedgerNdjson("/not-opened", { maxRows: 0 }), /maxRows must be a positive safe integer/);
});

test("771 rotations complete under a 128 MiB old-space ceiling", () => {
  const { root, state } = stateDir("retro-771-rotations-");
  try {
    let index = 0;
    for (let rotation = 0; rotation < 771; rotation += 1) {
      const lines: string[] = [];
      for (let row = 0; row < 200; row += 1, index += 1) {
        lines.push(JSON.stringify({
          ts: "2026-09-01T00:00:00.000Z",
          run_id: `R${index}`,
          step: "run.start",
          pad: `${index}:${"x".repeat(600)}`,
        }));
      }
      const minute = String(Math.floor(rotation / 60) % 60).padStart(2, "0");
      const second = String(rotation % 60).padStart(2, "0");
      const millis = String(rotation).padStart(3, "0");
      writeFileSync(
        join(state, `ledger.2026-09-01T00-${minute}-${second}-${millis}Z.ndjson.gz`),
        gzipSync(`${lines.join("\n")}\n`),
      );
    }
    writeFileSync(join(state, "ledger.ndjson"), "");

    const retroUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "retro.ts")).href;
    const childSource = [
      `import { readRetroLedgerNdjson } from ${JSON.stringify(retroUrl)};`,
      `const read = await readRetroLedgerNdjson(${JSON.stringify(state)}, { maxBytes: 2 * 1024 * 1024 });`,
      "process.stdout.write(JSON.stringify({ rowsKept: read.rowsKept, droppedRows: read.droppedRows, dedupeEntriesPeak: read.dedupeEntriesPeak, heapUsed: process.memoryUsage().heapUsed }));",
    ].join("\n");
    const env = { ...process.env, NODE_V8_COVERAGE: undefined };
    const child = spawnSync(
      process.execPath,
      ["--max-old-space-size=128", "--import", "tsx", "--input-type=module", "-e", childSource],
      { cwd: join(dirname(fileURLToPath(import.meta.url)), ".."), env, encoding: "utf8", timeout: 20_000 },
    );

    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout) as Record<string, number>;
    assert.equal(result.rowsKept! + result.droppedRows!, index);
    assert.ok(result.dedupeEntriesPeak! < index / 40, `peak Set entries were ${result.dedupeEntriesPeak}`);
    assert.ok(result.heapUsed! < 128 * 1024 * 1024, `child used ${result.heapUsed} heap bytes`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
