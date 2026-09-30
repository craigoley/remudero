import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import * as ledgerCompactModule from "../src/lib/ledger-compact.js";
import {
  ledgerCompactCommand,
  selectLedgerCompactionSources,
  type LedgerCompactFs,
} from "../src/lib/ledger-compact.js";
import { compactedArchiveName } from "../src/lib/ledger.js";
import { fixedClock } from "../src/lib/clock.js";
import { resolveLedgerUnion, rotationStampIso } from "../src/lib/ledger-union.js";

const STATE_DIR = "/state";
const NOW = new Date("2026-09-10T00:00:00.000Z");
const TEST_LIMIT = 128;

function row(ts: string, id: string): string {
  return JSON.stringify({ ts, step: "run.start", run_id: id, task_id: "W1-T4355" });
}

function gzipRows(rows: string[]): Buffer {
  return gzipSync(Buffer.from(`${rows.join("\n")}\n`, "utf8"));
}

function memoryFs(initial: Record<string, Buffer>) {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const removals: string[] = [];
  const outputLimits: Array<number | undefined> = [];
  const fs: LedgerCompactFs = {
    readdirSync: (dir) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1)),
    readFileSync: (path) => {
      const value = files.get(path);
      if (!value) throw new Error(`missing ${path}`);
      return value;
    },
    existsSync: (path) => files.has(path),
    writeAtomic: (path, body) => {
      writes.push(path);
      files.set(path, body);
      return true;
    },
    rmSync: (path) => {
      removals.push(path);
      files.delete(path);
    },
    gzipSync: (body) => gzipSync(body),
    gunzipSync: (body, options) => {
      outputLimits.push(options?.maxOutputLength);
      return gunzipSync(body, options);
    },
    sizeOf: (path) => {
      const value = files.get(path);
      if (!value) throw new Error(`missing ${path}`);
      return value.byteLength;
    },
  };
  return { files, writes, removals, outputLimits, fs };
}

function corpusRows(files: Map<string, Buffer>): string[] {
  return [...files]
    .filter(([path]) => /^\/state\/ledger\..*\.ndjson(?:\.gz)?$/.test(path))
    .flatMap(([path, body]) => (path.endsWith(".gz") ? gunzipSync(body) : body).toString("utf8").split("\n"))
    .filter(Boolean);
}

function run(memory: ReturnType<typeof memoryFs>, maxArchiveBytes = ledgerCompactModule.LEDGER_COMPACT_MAX_ARCHIVE_BYTES) {
  const out: string[] = [];
  const errors: string[] = [];
  const code = ledgerCompactCommand([], {
    stateDir: STATE_DIR,
    clock: fixedClock(NOW.getTime()),
    fs: memory.fs,
    maxArchiveBytes,
    out: (line) => out.push(line),
    error: (line) => errors.push(line),
  });
  return { code, out, errors };
}

test("test/no-union-read-decompresses-a-million-row-archive.test.ts: oversized daily archives split without loss", () => {
  assert.equal(ledgerCompactModule.LEDGER_COMPACT_MAX_ARCHIVE_BYTES, 64 * 1024 * 1024);
  const dayOne = Array.from({ length: 5 }, (_, i) => row(`2026-08-01T${String(8 + i).padStart(2, "0")}:00:00.000Z`, `A-${i}`));
  const dayTwo = Array.from({ length: 5 }, (_, i) => row(`2026-08-02T${String(8 + i).padStart(2, "0")}:00:00.000Z`, `B-${i}`));
  const inputs = [...dayTwo].reverse().concat(dayOne, dayOne[2]!);
  const sourceName = compactedArchiveName("2026-08-02T12:00:00.000Z");
  const memory = memoryFs({ [joinPath(STATE_DIR, sourceName)]: gzipRows(inputs) });
  const before = new Set(inputs);

  const result = run(memory, TEST_LIMIT);

  assert.equal(result.code, 0, result.errors.join("\n"));
  const report = JSON.parse(result.out[0]!);
  assert.equal(report.sourceCount, 1, "the legacy oversized source is selected alone for repair");
  assert.equal(report.rowsWritten, before.size, "duplicates are collapsed, not truncated");
  assert.equal(report.duplicatesCollapsed, 1);
  assert.ok(report.archiveNames.length > 2, "both oversized UTC-day outputs are split into several files");
  assert.equal(report.archiveName, report.archiveNames.at(-1));
  assert.deepEqual(new Set(corpusRows(memory.files)), before);

  for (const name of report.archiveNames as string[]) {
    const bytes = memory.files.get(joinPath(STATE_DIR, name))!;
    const body = gunzipSync(bytes).toString("utf8");
    assert.ok(Buffer.byteLength(body, "utf8") <= TEST_LIMIT, `${name} exceeds the byte ceiling`);
    const day = /^ledger\.(\d{4}-\d{2}-\d{2})T/.exec(name)?.[1];
    assert.ok(day, `${name} must retain a parseable day prefix`);
    const rows = body.trimEnd().split("\n");
    assert.ok(rows.every((line) => JSON.parse(line).ts.startsWith(day)), `${name} crossed a UTC-day boundary`);
  }
  assert.ok(report.archiveNames.every((name: string) => rotationStampIso(name)), "split names remain window-readable");
  const followUp = selectLedgerCompactionSources(report.archiveNames, STATE_DIR, 7, 50, NOW);
  assert.equal(followUp.eligibleCount, report.archiveNames.length, "part filenames remain age-selectable next pass");

  const union = resolveLedgerUnion(STATE_DIR, /W1-T4355/, {
    readdirSync: () => [...memory.files.keys()].map((path) => path.slice(STATE_DIR.length + 1)),
    existsSync: (path) => memory.files.has(path),
    readFileSync: (path) => memory.files.get(path)!,
    gunzipSync: (bytes) => gunzipSync(bytes),
  }, { sinceTs: "2026-08-02T00:00:00.000Z" });
  assert.equal(union.ok, true, "the production union reader must accept the split archive names");
  assert.equal(union.matches.length, 5, "the windowed union still finds every row on the second day");
  assert.equal(union.archiveFiles.length, report.archiveNames.length);
});

test("ledger compact defers sources whose decompressed-byte sum would exceed the ceiling", () => {
  const first = row("2026-08-01T00:00:00.000Z", "FIRST");
  const second = row("2026-08-02T00:00:00.000Z", "SECOND");
  assert.ok(Buffer.byteLength(`${first}\n`) < TEST_LIMIT);
  assert.ok(Buffer.byteLength(`${second}\n`) < TEST_LIMIT);
  assert.ok(Buffer.byteLength(`${first}\n${second}\n`) > TEST_LIMIT);
  const firstName = compactedArchiveName("2026-08-01T00:00:00.000Z");
  const secondName = compactedArchiveName("2026-08-02T00:00:00.000Z");
  const memory = memoryFs({
    [joinPath(STATE_DIR, firstName)]: gzipRows([first]),
    [joinPath(STATE_DIR, secondName)]: gzipRows([second]),
  });
  const before = new Set([first, second]);

  const result = run(memory, TEST_LIMIT);

  assert.equal(result.code, 0, result.errors.join("\n"));
  const report = JSON.parse(result.out[0]!);
  assert.equal(report.sourceCount, 1);
  assert.equal(report.sizeSkippedCount, 1);
  assert.match(result.errors.join("\n"), /deferred 1 eligible rotation/);
  assert.ok(memory.outputLimits.includes(TEST_LIMIT + 1), "gzip sizing stops at ceiling plus one byte");
  assert.deepEqual(new Set(corpusRows(memory.files)), before);
});

test("a legacy oversized merged archive gets repaired before a steady queue of ordinary rotations", () => {
  const oldRows = Array.from({ length: 4 }, (_, i) => row(`2026-08-01T0${i}:00:00.000Z`, `OLD-${i}`));
  const oldName = compactedArchiveName("2026-08-01T03:00:00.000Z");
  const rotationNames = [2, 3, 4].map((day) => compactedArchiveName(`2026-08-0${day}T00:00:00.000Z`));
  const rotationRows = rotationNames.map((_, i) => row(`2026-08-0${i + 2}T00:00:00.000Z`, `NEW-${i}`));
  const memory = memoryFs({
    [joinPath(STATE_DIR, oldName)]: gzipRows(oldRows),
    ...Object.fromEntries(rotationNames.map((name, i) => [joinPath(STATE_DIR, name), gzipRows([rotationRows[i]!])])),
  });
  memory.fs.sizeOf = (path) => path.endsWith(oldName) ? 1_000 : 10;

  const result = run(memory, TEST_LIMIT);

  assert.equal(result.code, 0, result.errors.join("\n"));
  const report = JSON.parse(result.out[0]!);
  assert.equal(report.sourceCount, 1, "the over-ceiling output is repaired on this pass");
  assert.equal(report.sizeSkippedCount, rotationNames.length);
  assert.ok(report.archiveNames.length > 1);
  assert.deepEqual(new Set(corpusRows(memory.files)), new Set([...oldRows, ...rotationRows]));
  assert.ok(rotationNames.every((name) => memory.files.has(joinPath(STATE_DIR, name))), "ordinary rotations remain for later passes");
});

test("an oversized prior archive part remains selectable for re-splitting beside a sibling", () => {
  const firstName = compactedArchiveName("2026-08-01T08:00:00.000Z").replace(
    ".ndjson.gz",
    "-part-000001.ndjson.gz",
  );
  const siblingName = compactedArchiveName("2026-08-02T08:00:00.000Z").replace(
    ".ndjson.gz",
    "-part-000001.ndjson.gz",
  );
  const recentNames = [
    compactedArchiveName("2026-09-08T08:00:00.000Z"),
    compactedArchiveName("2026-09-09T08:00:00.000Z"),
    compactedArchiveName("2026-09-10T08:00:00.000Z"),
  ];
  const names = [firstName, siblingName, ...recentNames];
  const sizeOf = (path: string): number =>
    path.endsWith(firstName) ? 500 : path.endsWith(siblingName) ? 450 : 10;

  const selection = selectLedgerCompactionSources(
    names,
    STATE_DIR,
    7,
    50,
    NOW,
    sizeOf,
    (entry) => (entry.path.endsWith(firstName) ? TEST_LIMIT + 1 : TEST_LIMIT),
    TEST_LIMIT,
  );

  assert.deepEqual(
    selection.sources.map((entry) => entry.path),
    [joinPath(STATE_DIR, firstName)],
    "an over-ceiling part must be selected alone so this pass can split it again",
  );
  assert.equal(selection.sizeSkippedCount, 1, "only the sibling is deferred while the oversized part is repaired");
});

test("invalid decompressed-size measurements refuse source selection", () => {
  const name = compactedArchiveName("2026-08-01T08:00:00.000Z");

  assert.throws(
    () => selectLedgerCompactionSources(
      [name], STATE_DIR, 7, 50, NOW, () => 20, () => Number.NaN, TEST_LIMIT,
    ),
    /invalid decompressed size .*NaN/,
  );
});

test("a lone normal-size archive part is deferred when its sibling cannot fit", () => {
  const firstName = compactedArchiveName("2026-08-01T08:00:00.000Z").replace(
    ".ndjson.gz", "-part-000001.ndjson.gz",
  );
  const siblingName = compactedArchiveName("2026-08-02T08:00:00.000Z").replace(
    ".ndjson.gz", "-part-000001.ndjson.gz",
  );

  const selection = selectLedgerCompactionSources(
    [firstName, siblingName],
    STATE_DIR,
    7,
    50,
    NOW,
    () => 20,
    () => 80,
    TEST_LIMIT,
  );

  assert.deepEqual(selection.sources, [], "rewriting only the first part would make no progress");
  assert.equal(selection.eligibleCount, 2);
  assert.equal(selection.sizeSkippedCount, 2, "both the sibling and the cleared first part are deferred");
});

test("plain ledger rotations are sized and compacted without gzip decoding", () => {
  const source = row("2026-08-01T08:00:00.000Z", "PLAIN");
  const sourceName = compactedArchiveName("2026-08-01T08:00:00.000Z").replace(".ndjson.gz", ".ndjson");
  const memory = memoryFs({ [joinPath(STATE_DIR, sourceName)]: Buffer.from(`${source}\n`, "utf8") });

  const result = run(memory, TEST_LIMIT);

  assert.equal(result.code, 0, result.errors.join("\n"));
  const report = JSON.parse(result.out[0]!);
  assert.equal(report.sourceCount, 1);
  assert.deepEqual(corpusRows(memory.files), [source]);
  assert.ok(report.archiveNames.every((name: string) => name.endsWith(".ndjson.gz")));
  assert.deepEqual(memory.outputLimits, [], "plain rotations do not enter the bounded gzip sizing path");
});

test("a corrupt gzip refuses before writing or removing any selected source", () => {
  const sourceName = compactedArchiveName("2026-08-01T08:00:00.000Z");
  const sourcePath = joinPath(STATE_DIR, sourceName);
  const corrupt = Buffer.from("not a gzip archive", "utf8");
  const memory = memoryFs({ [sourcePath]: corrupt });

  const result = run(memory, TEST_LIMIT);

  assert.equal(result.code, 1);
  assert.match(result.errors.join("\n"), /cannot list or size eligible archives .*cannot read the selected window/);
  assert.deepEqual(memory.writes, []);
  assert.deepEqual(memory.removals, []);
  assert.deepEqual(memory.files.get(sourcePath), corrupt);
});

test("same-stamp split chunks get collision-safe part names without losing rows", () => {
  const rows = [
    row("2026-08-01T08:00:00.000Z", "COLLISION-A"),
    row("2026-08-01T08:00:00.000Z", "COLLISION-B"),
    row("2026-08-01T08:00:00.000Z", "COLLISION-C"),
  ];
  assert.ok(rows.every((line) => Buffer.byteLength(`${line}\n`, "utf8") <= TEST_LIMIT));
  assert.ok(Buffer.byteLength(`${rows[0]}\n${rows[1]}\n`, "utf8") > TEST_LIMIT);
  const sourceName = compactedArchiveName("2026-08-01T12:00:00.000Z");
  const memory = memoryFs({ [joinPath(STATE_DIR, sourceName)]: gzipRows(rows) });

  const result = run(memory, TEST_LIMIT);

  assert.equal(result.code, 0, result.errors.join("\n"));
  const report = JSON.parse(result.out[0]!);
  assert.equal(report.rowsWritten, rows.length);
  assert.ok(report.archiveNames.length > 1);
  assert.ok(report.archiveNames.some((name: string) => /-part-00000[23]\.ndjson\.gz$/.test(name)));
  assert.deepEqual(new Set(corpusRows(memory.files)), new Set(rows));
  for (const name of report.archiveNames as string[]) {
    assert.ok(gunzipSync(memory.files.get(joinPath(STATE_DIR, name))!).byteLength <= TEST_LIMIT, `${name} exceeds the byte ceiling`);
  }
});

test("an unrepresentable single row refuses before replacing or removing its source", () => {
  const tooWide = JSON.stringify({ ts: "2026-08-01T00:00:00.000Z", step: "run.start", run_id: "WIDE", task_id: "T", padding: "x".repeat(TEST_LIMIT) });
  const name = compactedArchiveName("2026-08-01T00:00:00.000Z");
  const memory = memoryFs({ [joinPath(STATE_DIR, name)]: gzipRows([tooWide]) });
  const before = memory.files.get(joinPath(STATE_DIR, name))!.toString("base64");

  const result = run(memory, TEST_LIMIT);

  assert.equal(result.code, 1);
  assert.match(result.errors.join("\n"), /one ledger row is .* over the 128-byte archive ceiling/);
  assert.equal(memory.files.get(joinPath(STATE_DIR, name))!.toString("base64"), before);
  assert.deepEqual(memory.writes, []);
  assert.deepEqual(memory.removals, []);
});

function joinPath(dir: string, name: string): string {
  return `${dir}/${name}`;
}
