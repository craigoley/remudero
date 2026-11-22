// W1-T5474: the config gardener's 60-day ledger union read is bounded to the steps its inventory
// prices (CONFIG_GARDEN_LEDGER_STEPS), its inventory is unchanged by every row outside that set, and
// the garden child heap cap that waited on this drops to 2048 MB.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { fixedClock } from "#src/lib/clock.js";
import * as gardener from "#src/lib/config-gardener.js";
import * as registry from "#src/lib/garden-registry.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS } from "#src/lib/learnings.js";
import { readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { at, corpus, fixture, NOW_MS, sources } from "#test/helpers/the-config-gardener-reads-only-the-ledger-steps-it-prices.js";
import fs from "node:fs";
import { readFileTail, readPeakSamples } from "#src/lib/host-memory-learning.js";

test("W1-T10962: learning reads bound bytes and discard incomplete or malformed evidence", (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}bounded-learning-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "estimates"));
  const path = join(dir, "estimates", "garden.ndjson");
  writeFileSync(path, `${"prefix".repeat(1000)}\n🙂é終\n`);
  const read = fs.readSync;
  let bytes = 0;
  t.mock.method(fs, "readSync", (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    bytes += length;
    return read(fd, buffer, offset, length, position);
  });
  assert.equal(readFileTail(path, 14), "🙂é終\n");
  assert.ok(bytes <= 15, "the 14-byte tail may inspect one preceding byte for a line boundary");
  bytes = 0;
  assert.equal(readFileTail(path, 10), "🙂é終\n", "a full row at the start of the tail is retained");
  assert.ok(bytes <= 11);
  writeFileSync(path, "one unbroken record");
  assert.equal(readFileTail(path, 8), "");
  writeFileSync(path, "whole\n");
  assert.equal(readFileTail(path, 8), "whole\n");
  writeFileSync(path, Buffer.from([0xff]));
  assert.throws(() => readFileTail(path, 8), /malformed/);
  assert.throws(() => readFileTail(join(dir, "absent"), 8), /absent/);
  assert.throws(() => readFileTail(dir, 8), /unreadable/);
  const diagnostics: Array<Record<string, unknown>> = [];
  assert.deepEqual(readPeakSamples("garden", { location: () => ({ dir }), log: (row) => diagnostics.push(row) }), []);
  assert.ok(diagnostics.some((row) => row.op === "read" && String(row.reason).includes("malformed")));
});

const WINDOW = { rotationWindowMs: 60 * 24 * 3600 * 1000, minRotations: 4 };
const steps = (): readonly string[] => gardener.CONFIG_GARDEN_LEDGER_STEPS;

function recordingReader() {
  const calls: Array<Parameters<typeof readLedgerUnionRecordsSync>[1]> = [];
  const returned: Array<Record<string, unknown>> = [];
  const reader: typeof readLedgerUnionRecordsSync = (dir, options, fs) => {
    calls.push(options);
    const result = readLedgerUnionRecordsSync(dir, options, fs);
    returned.push(...result.rows);
    return result;
  };
  return { calls, returned, reader };
}

test("the-config-gardener-reads-only-the-ledger-steps-it-prices.test.ts: the read is filtered to CONFIG_GARDEN_LEDGER_STEPS and the inventory equals the unfiltered read's", async (t) => {
  const f = fixture(t);
  const rows = corpus();
  const third = Math.floor(rows.length / 3);
  writeLedger(rows.slice(2 * third), { dir: f.stateDir, rotations: [
    { at: fixedClock(NOW_MS - 2 * 24 * 3600 * 1000).iso(), gz: true, rows: rows.slice(0, third) },
    { at: fixedClock(NOW_MS - 24 * 3600 * 1000).iso(), rows: rows.slice(third, 2 * third) },
  ] });

  const rec = recordingReader();
  const filtered = await gardener.configInventory(f.garden, sources(), rec.reader);
  assert.equal(rec.calls.length, 1, "one bounded union read per inventory");
  assert.deepEqual(rec.calls[0]?.step, steps(), "the read passes the step set itself");
  assert.equal(rec.calls[0]?.refuseIncomplete, true, "a bounded read still refuses an incomplete union");
  assert.deepEqual([rec.calls[0]?.rotationWindowMs, rec.calls[0]?.minRotations], [WINDOW.rotationWindowMs, WINDOW.minRotations], "the same 60-day window");
  const kept = new Set(rec.returned.map((r) => String(r.step)));
  assert.deepEqual([...kept].filter((s) => !steps().includes(s)), [], "no row outside the set is materialised");

  const everything = readLedgerUnionRecordsSync(f.stateDir, WINDOW).rows;
  assert.ok(everything.length > rec.returned.length && everything.some((r) => r.step === "worker.activity"), "positive control: the corpus holds rows outside the set");
  assert.equal(rec.returned.length, everything.filter((r) => steps().includes(String(r.step))).length, "every in-set row is read");
  const unfiltered = await gardener.configInventory(f.garden, sources(everything));
  assert.ok(filtered.runs.length > 20 && filtered.cap?.derivation.pressure !== undefined && filtered.cap.derivation.cacheHitRatioUsed !== undefined, "positive control: runs, pressure and the cache mix are all measured");
  assert.deepEqual(filtered, unfiltered);
});

test("the config gardener's bounded read refuses an incomplete ledger union", async (t) => {
  const f = fixture(t);
  writeLedger([{ step: "run.start", run_id: "r1", ts: at(0) }], { dir: f.stateDir });
  writeFileSync(join(f.stateDir, "ledger.2026-09-30T00-00-00-000Z.ndjson.gz"), "not a gzip archive");
  await assert.rejects(() => gardener.configInventory(f.garden, sources()), /config gardener: incomplete ledger union: .*ledger\.2026-09-30/);
  assert.throws(() => gardener.readConfigGardenLedgerRows(f.stateDir), /config gardener: incomplete ledger union/);
});

test("the garden child heap cap is 2048 MB once the config garden's read is filtered", () => {
  assert.equal(registry.GARDEN_CHILD_HEAP_LIMIT_MB, 2048);
});

/** One child, one read, under a bounded heap: the heap above the post-import baseline at its peak
 *  (sampled on every materialised row) and what stays retained after a full GC. */
function measureRead(stateDir: string, mode: "filtered" | "unfiltered", scratch: string) {
  const src = (p: string) => pathToFileURL(resolve("src/lib", p)).href;
  const script = join(scratch, `measure-${mode}.mjs`);
  writeFileSync(script, [
    `import { getHeapStatistics } from "node:v8";`,
    `import { readConfigGardenLedgerRows } from ${JSON.stringify(src("config-gardener.ts"))};`,
    `import { readLedgerUnionRecordsSync } from ${JSON.stringify(src("ledger-union.ts"))};`,
    `globalThis.gc(); const base = getHeapStatistics().used_heap_size; let peak = base;`,
    `const sample = () => { const u = getHeapStatistics().used_heap_size; if (u > peak) peak = u; };`,
    `const reader = (dir, o, fs) => readLedgerUnionRecordsSync(dir, { ...o, ${mode === "unfiltered" ? "step: undefined, " : ""}onRecord: sample }, fs);`,
    `const rows = readConfigGardenLedgerRows(${JSON.stringify(stateDir)}, reader);`,
    `sample(); globalThis.gc(); const retained = getHeapStatistics().used_heap_size - base;`,
    `console.log(JSON.stringify({ rows: rows.length, peakMb: (peak - base) / 1048576, retainedMb: retained / 1048576 }));`,
  ].join("\n"));
  const out = spawnSync(process.execPath, ["--import", "tsx", "--expose-gc", "--max-old-space-size=512", script], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim().split("\n").at(-1)!) as { rows: number; peakMb: number; retainedMb: number };
}

test("the filtered read's peak heap on a realistic synthetic ledger is a small fraction of the unfiltered read's", (t) => {
  const f = fixture(t);
  // The live 60-day mix (2026-10-03): 6.9% of rows are in the set, ~420 bytes a row. 7 of every 100 here.
  const units = 1500;
  const perRotation: Array<Array<Record<string, unknown>>> = [[], [], [], []];
  for (let u = 0; u < units; u++) {
    const id = `run-${u}`;
    const ts = at(u);
    const bucket = perRotation[u % 4]!;
    bucket.push(
      { step: "run.start", run_id: id, task_id: `W1-T${u}`, type: "implement", risk: "low", task_class: "src", ts },
      { step: "learnings.injected", run_id: id, budget_chars: DEFAULT_KNOWLEDGE_BUDGET_CHARS, dropped: ["fact-a", "fact-b"], injected: ["fact-c"], ts },
      { step: "implement.done", run_id: id, num_turns: 40, cost_usd: 2.5, model: "opus", effort: "high", tokens: { cacheRead: 900_000, input: 1200, cacheCreation: 40_000, output: 9000 }, ts },
      { step: "pr.opened", run_id: id, pr_url: `https://github.com/acme/remudero/pull/${u}`, ts },
      { step: "verdict", run_id: id, task_id: `W1-T${u}`, verdict: "merged", cost_usd: 3.1, pr_url: `https://github.com/acme/remudero/pull/${u}`, ts },
      { step: "review.posted", run_id: id, pr_url: `https://github.com/acme/remudero/pull/${u}`, verdict: "approve", ts },
      { step: "automerge.armed", run_id: id, at: "open", outcome: "armed", ts },
    );
    for (let n = 0; n < 93; n++) {
      bucket.push({ step: ["worker.activity", "run.running_long", "worker.turns", "worker.state", "sweep.disposed", "ci.polling"][n % 6], run_id: n % 6 === 4 ? "sweep" : id, seq: n, detail: `${"activity ".repeat(38)}${u}:${n}`, ts });
    }
  }
  const tail = perRotation.pop()!;
  writeLedger(tail, { dir: f.stateDir, rotations: perRotation.map((rows, i) => ({ at: fixedClock(NOW_MS - (3 - i) * 24 * 3600 * 1000).iso(), gz: true, rows })) });

  const filtered = measureRead(f.stateDir, "filtered", f.stateDir);
  const unfiltered = measureRead(f.stateDir, "unfiltered", f.stateDir);
  t.diagnostic(`synthetic ledger ${units * 100} rows: filtered ${filtered.rows} rows peak ${filtered.peakMb.toFixed(1)} MB retained ${filtered.retainedMb.toFixed(1)} MB; unfiltered ${unfiltered.rows} rows peak ${unfiltered.peakMb.toFixed(1)} MB retained ${unfiltered.retainedMb.toFixed(1)} MB`);
  assert.equal(unfiltered.rows, units * 100, "positive control: the unfiltered read materialises every row");
  assert.equal(filtered.rows, units * 7);
  assert.ok(filtered.retainedMb < unfiltered.retainedMb * 0.15, `retained ${filtered.retainedMb} MB filtered vs ${unfiltered.retainedMb} MB unfiltered`);
  assert.ok(filtered.peakMb < unfiltered.peakMb * 0.5, `peak ${filtered.peakMb} MB filtered vs ${unfiltered.peakMb} MB unfiltered`);
});
