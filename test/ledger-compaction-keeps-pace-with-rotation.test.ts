/**
 * W1-T4262: ledger compaction keeps pace with rotation. On 2026-09-23 the host held 967 archives
 * against a bound of 400 — 768 written that day — while the daemon compacted only rotations older than
 * a day and re-read its own ~1M-row output every pass, so the corpus kept growing until a reader of it
 * exhausted the daemon's heap.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { compactedArchiveName } from "../src/lib/ledger.js";
import { ledgerCompactCommand, selectLedgerCompactionSources } from "../src/lib/ledger-compact.js";
import {
  decideLedgerCompaction,
  DEFAULT_LEDGER_COMPACTION_TRIGGER,
  ledgerCompactionIntervalMs,
  ledgerCompactionProtectedHours,
  readLedgerCorpusPressure,
} from "../src/lib/ledger-compaction-rung.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { daemonLedgerCompactArgs } from "../src/run-task.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

/** `count` rotation names, newest at NOW, evenly spread over the last `hours`. */
function flood(count: number, hours: number): string[] {
  return Array.from({ length: count }, (_, i) => compactedArchiveName(new Date(NOW.getTime() - ((i + 1) * hours * HOUR) / count).toISOString())).reverse();
}

const pressureOf = (names: string[]) => ({ archiveCount: names.length, archiveBytes: names.length * 600_000 });

test("W1-T4262: a flood of same-day rotations is compacted while over bound", () => {
  const names = flood(960, 20);
  const hours = ledgerCompactionProtectedHours(pressureOf(names));
  assert.ok(hours < 24 && hours >= 1, `protects ${hours}h of history`);
  const selected = selectLedgerCompactionSources(names, "/state", hours / 24, 50, NOW);
  assert.equal(selected.sources.length, 50, "a full window is compacted");
  // The fixed one-day cutoff this replaces found nothing to compact in the same corpus.
  assert.equal(selectLedgerCompactionSources(names, "/state", 1, 50, NOW).sources.length, 0);
  // At or under the bound nothing changes: a day of history is left alone.
  assert.equal(ledgerCompactionProtectedHours(pressureOf(flood(400, 20))), 24);
  // Never less than an hour, however far over the bound.
  assert.equal(ledgerCompactionProtectedHours({ archiveCount: 100_000, archiveBytes: 0 }), 1);
});

test("W1-T4262: a pass does not re-open the compactor's own output while rotations remain", () => {
  const merged = compactedArchiveName("2026-09-20T00:00:00.000Z");
  const names = [merged, ...flood(30, 10)];
  const sizeOf = (path: string) => (path.endsWith(merged) ? 300_000_000 : 600_000);
  const selected = selectLedgerCompactionSources(names, "/state", 2 / 24, 50, NOW, sizeOf);
  assert.ok(selected.sources.length > 0);
  assert.ok(selected.sources.every((s) => !s.path.endsWith(merged)), "the previous output is left for later");
  // Once no rotation is eligible, outputs are merged with each other — two at a time.
  const outputs = ["2026-09-18", "2026-09-19", "2026-09-20"].map((d) => compactedArchiveName(`${d}T00:00:00.000Z`));
  const onlyOutputs = selectLedgerCompactionSources([...outputs, ...flood(30, 1)], "/state", 2 / 24, 50, NOW, (p) =>
    outputs.some((o) => p.endsWith(o)) ? 300_000_000 : 600_000,
  );
  assert.deepEqual(onlyOutputs.sources.map((s) => s.path), outputs.slice(0, 2).map((o) => join("/state", o)));
  // An archive that vanished between listing and sizing counts as an ordinary rotation.
  const vanished = selectLedgerCompactionSources(names, "/state", 2 / 24, 50, NOW, (p) => {
    if (p.endsWith(merged)) throw new Error("ENOENT");
    return 600_000;
  });
  assert.ok(vanished.sources.some((s) => s.path.endsWith(merged)));
});

test("W1-T4262: compaction runs sooner when arrivals outpace retirements", () => {
  const atBound = ledgerCompactionIntervalMs({ archiveCount: 400, archiveBytes: 0 });
  const over = ledgerCompactionIntervalMs({ archiveCount: 500, archiveBytes: 0 });
  const farOver = ledgerCompactionIntervalMs({ archiveCount: 967, archiveBytes: 0 });
  assert.equal(atBound, DEFAULT_LEDGER_COMPACTION_TRIGGER.minIntervalMs);
  assert.ok(farOver < over && over < atBound, `${farOver} < ${over} < ${atBound}`);
  // Fifteen minutes after the last pass: a corpus just over the bound waits, one far over it fires.
  const last = NOW.getTime() - 15 * 60_000;
  assert.equal(decideLedgerCompaction({ archiveCount: 450, archiveBytes: 0 }, last, NOW.getTime()).fire, false);
  assert.equal(decideLedgerCompaction({ archiveCount: 967, archiveBytes: 0 }, last, NOW.getTime()).fire, true);
});

test("W1-T4262: the daemon passes an age in hours, and the command takes it", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4262-`));
  const names = flood(450, 20);
  // One old row per rotation: its timestamp names no file in the fixture, so the merged name is free.
  for (const n of names) writeFileSync(join(dir, n), gzipSync(Buffer.from(`{"ts":"2026-09-01T00:00:00.000Z","n":"${n}"}\n`)));
  const args = daemonLedgerCompactArgs(dir);
  assert.equal(args[0], "--older-than-hours");
  assert.equal(Number(args[1]), ledgerCompactionProtectedHours(readLedgerCorpusPressure(dir, { readdir: () => names, sizeOf: () => 0 })));
  const out: string[] = [];
  const errors: string[] = [];
  assert.equal(ledgerCompactCommand([...args, "--dry-run"], { stateDir: dir, out: (l) => out.push(l), error: (l) => errors.push(l) }), 0, errors.join("\n"));
  const report = JSON.parse(out[0]!) as { olderThanDays: number; sourceCount: number };
  assert.equal(report.olderThanDays, Number(args[1]) / 24);
  assert.ok(report.sourceCount > 0);
  // Days and hours together, or hours that are not a number, are refused as misuse.
  assert.equal(ledgerCompactCommand(["--older-than", "1", "--older-than-hours", "2"], { stateDir: dir, out: () => {}, error: () => {} }), 2);
  assert.equal(ledgerCompactCommand(["--older-than-hours", "soon"], { stateDir: dir, out: () => {}, error: () => {} }), 2);
});
