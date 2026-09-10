import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  LEDGER_COMPACT_MAX_SOURCES,
  ledgerCompactCommand,
  selectLedgerCompactionSources,
  type LedgerCompactCommandDeps,
  type LedgerCompactFs,
} from "../src/lib/ledger-compact.js";
import { compactedArchiveName } from "../src/lib/ledger.js";
import { fixedClock } from "../src/lib/clock.js";

const STATE_DIR = "/state";
const NOW = new Date("2026-09-10T00:00:00.000Z");
const row = (ts: string, id: string) => JSON.stringify({ ts, step: "run.start", run_id: id, task_id: "T" });

function gzipRows(rows: string[]): Buffer {
  return gzipSync(Buffer.from(rows.join("\n") + "\n", "utf8"));
}

function memoryFs(initial: Record<string, Buffer>) {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const removals: string[] = [];
  let reads = 0;
  const fs: LedgerCompactFs = {
    readdirSync: (dir) => {
      reads += 1;
      return [...files.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1));
    },
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
    gunzipSync: (body) => gunzipSync(body),
  };
  return { files, writes, removals, get reads() { return reads; }, fs };
}

function snapshot(files: Map<string, Buffer>): Array<[string, string]> {
  return [...files]
    .map(([path, body]): [string, string] => [path, body.toString("base64")])
    .sort(([a], [b]) => a.localeCompare(b));
}

function corpusRows(files: Map<string, Buffer>): Set<string> {
  const rows = new Set<string>();
  for (const [path, body] of files) {
    if (!/ledger\..*\.ndjson(?:\.gz)?$/.test(path)) continue;
    const text = path.endsWith(".gz") ? gunzipSync(body).toString("utf8") : body.toString("utf8");
    for (const line of text.split("\n")) if (line) rows.add(line);
  }
  return rows;
}

function command(
  args: string[],
  memory: ReturnType<typeof memoryFs>,
): { code: number; out: string[]; errors: string[] } {
  const out: string[] = [];
  const errors: string[] = [];
  const code = ledgerCompactCommand(args, {
    stateDir: STATE_DIR,
    clock: fixedClock(NOW.getTime()),
    fs: memory.fs,
    out: (line) => out.push(line),
    error: (line) => errors.push(line),
  });
  return { code, out, errors };
}

test("ledger-compact preserves the distinct row set while replacing duplicate source archives", () => {
  const a = row("2026-08-01T00:00:00.000Z", "R1");
  const b = row("2026-08-02T00:00:00.000Z", "R2");
  const recent = row("2026-09-09T00:00:00.000Z", "R3");
  const memory = memoryFs({
    [join(STATE_DIR, compactedArchiveName("2026-08-01T00:00:00.000Z"))]: gzipRows([a]),
    [join(STATE_DIR, compactedArchiveName("2026-08-02T00:00:00.000Z"))]: gzipRows([a, b]),
    [join(STATE_DIR, compactedArchiveName("2026-09-09T00:00:00.000Z"))]: gzipRows([recent]),
  });
  const before = corpusRows(memory.files);

  const result = command([], memory);

  assert.equal(result.code, 0);
  assert.deepEqual(corpusRows(memory.files), before, "apply must preserve every distinct row");
  assert.equal(memory.writes.length, 1, "one atomic replacement is written");
  assert.equal(memory.removals.length, 1, "the non-colliding source is removed after replacement");
  assert.deepEqual(JSON.parse(result.out[0]!), {
    mode: "apply",
    olderThanDays: 7,
    maxSources: 50,
    eligibleCount: 2,
    unparseableAgeCount: 0,
    sourceCount: 2,
    rowsWritten: 2,
    duplicatesCollapsed: 1,
    archiveName: compactedArchiveName("2026-08-02T00:00:00.000Z"),
  });
});

test("ledger-compact dry-run reports the apply counts and mutates nothing", () => {
  const a = row("2026-08-01T00:00:00.000Z", "R1");
  const b = row("2026-08-02T00:00:00.000Z", "R2");
  const initial = {
    [join(STATE_DIR, compactedArchiveName("2026-08-01T00:00:00.000Z"))]: gzipRows([a]),
    [join(STATE_DIR, compactedArchiveName("2026-08-02T00:00:00.000Z"))]: gzipRows([a, b]),
  };
  const applyMemory = memoryFs(initial);
  const dryMemory = memoryFs(initial);
  const before = snapshot(dryMemory.files);

  const applied = command([], applyMemory);
  const dry = command(["--dry-run"], dryMemory);

  assert.equal(applied.code, 0);
  assert.equal(dry.code, 0);
  assert.deepEqual(snapshot(dryMemory.files), before);
  assert.deepEqual(dryMemory.writes, []);
  assert.deepEqual(dryMemory.removals, []);
  const { mode: applyMode, ...applyCounts } = JSON.parse(applied.out[0]!);
  const { mode: dryMode, ...dryCounts } = JSON.parse(dry.out[0]!);
  assert.equal(applyMode, "apply");
  assert.equal(dryMode, "dry-run");
  assert.deepEqual(dryCounts, applyCounts);
});

test("ledger-compact previews and applies a copied fixture through real gzip and atomic filesystem I/O", (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-ledger-compact-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const a = row("2026-08-01T00:00:00.000Z", "REAL-1");
  const b = row("2026-08-02T00:00:00.000Z", "REAL-2");
  const first = compactedArchiveName("2026-08-01T00:00:00.000Z").replace(/\.gz$/, "");
  const second = compactedArchiveName("2026-08-02T00:00:00.000Z");
  writeFileSync(join(stateDir, first), `${a}\n`);
  writeFileSync(join(stateDir, second), gzipRows([a, b]));
  writeFileSync(join(stateDir, "ledger.ndjson"), `${row("2026-09-10T00:00:00.000Z", "LIVE")}\n`);
  const before = readdirSync(stateDir)
    .sort()
    .map((name) => [name, readFileSync(join(stateDir, name)).toString("base64")]);
  const dryOut: string[] = [];
  const errors: string[] = [];

  const dryCode = ledgerCompactCommand(["--dry-run"], {
    stateDir,
    clock: fixedClock(NOW.getTime()),
    out: (line) => dryOut.push(line),
    error: (line) => errors.push(line),
  });

  assert.equal(dryCode, 0);
  assert.deepEqual(
    readdirSync(stateDir).sort().map((name) => [name, readFileSync(join(stateDir, name)).toString("base64")]),
    before,
  );
  const applyOut: string[] = [];
  const applyCode = ledgerCompactCommand([], {
    stateDir,
    clock: fixedClock(NOW.getTime()),
    out: (line) => applyOut.push(line),
    error: (line) => errors.push(line),
  });
  assert.equal(applyCode, 0);
  assert.deepEqual(errors, []);
  const { mode: dryMode, ...dryCounts } = JSON.parse(dryOut[0]!);
  const { mode: applyMode, ...applyCounts } = JSON.parse(applyOut[0]!);
  assert.equal(dryMode, "dry-run");
  assert.equal(applyMode, "apply");
  assert.deepEqual(dryCounts, applyCounts);
  const replacement = gunzipSync(readFileSync(join(stateDir, second))).toString("utf8").trim().split("\n");
  assert.deepEqual(new Set(replacement), new Set([a, b]));
  assert.equal(readFileSync(join(stateDir, "ledger.ndjson"), "utf8"), `${row("2026-09-10T00:00:00.000Z", "LIVE")}\n`);
});

test("ledger-compact gives an all-torn corpus the same deterministic name in preview and apply", () => {
  const name = compactedArchiveName("2026-08-01T00:00:00.000Z");
  const initial = { [join(STATE_DIR, name)]: gzipRows(["torn-row-without-a-timestamp"]) };
  const applyMemory = memoryFs(initial);
  const dryMemory = memoryFs(initial);

  const applied = command([], applyMemory);
  const dry = command(["--dry-run"], dryMemory);

  assert.equal(applied.code, 0);
  assert.equal(dry.code, 0);
  assert.equal(JSON.parse(applied.out[0]!).archiveName, compactedArchiveName(NOW.toISOString()));
  assert.equal(JSON.parse(dry.out[0]!).archiveName, JSON.parse(applied.out[0]!).archiveName);
});

test("ledger-compact caps one invocation at the 50 oldest eligible sources", () => {
  const names = Array.from({ length: 52 }, (_, i) =>
    compactedArchiveName(new Date(Date.UTC(2026, 0, 1) + i * 24 * 60 * 60 * 1_000).toISOString()));
  names.push(compactedArchiveName("2026-09-09T00:00:00.000Z"));

  const selected = selectLedgerCompactionSources(names, STATE_DIR, 7, 10_000, NOW);

  assert.equal(selected.eligibleCount, 52);
  assert.equal(selected.sources.length, LEDGER_COMPACT_MAX_SOURCES);
  assert.equal(selected.sources[0]!.path, join(STATE_DIR, names[0]!));
  assert.equal(selected.sources.at(-1)!.path, join(STATE_DIR, names[49]!));
});

test("ledger-compact names and skips a rotation whose age cannot be parsed", () => {
  const bad = "ledger.not-a-time.ndjson.gz";
  const memory = memoryFs({
    [join(STATE_DIR, bad)]: gzipRows([row("2026-08-01T00:00:00.000Z", "BAD-NAME")]),
  });

  const result = command([], memory);

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.out[0]!), {
    mode: "apply",
    olderThanDays: 7,
    maxSources: 50,
    eligibleCount: 0,
    unparseableAgeCount: 1,
    sourceCount: 0,
    rowsWritten: 0,
    duplicatesCollapsed: 0,
    archiveName: "",
  });
  assert.match(result.errors.join("\n"), /skipped 1 rotation/);
  assert.deepEqual(memory.writes, []);
  assert.deepEqual(memory.removals, []);
});

test("ledger-compact never admits the live ledger into an operator compaction window", () => {
  const rotation = compactedArchiveName("2026-08-01T00:00:00.000Z");

  const selected = selectLedgerCompactionSources(
    ["ledger.ndjson", rotation],
    STATE_DIR,
    7,
    LEDGER_COMPACT_MAX_SOURCES,
    NOW,
  );

  assert.deepEqual(selected.sources.map((entry) => entry.path), [join(STATE_DIR, rotation)]);
  assert.equal(selected.eligibleCount, 1);
});

test("ledger-compact refuses an output collision with an unselected archive before writing or removing", () => {
  const selectedName = compactedArchiveName("2026-08-01T00:00:00.000Z");
  const collidingName = compactedArchiveName("2026-09-01T00:00:00.000Z");
  const memory = memoryFs({
    [join(STATE_DIR, selectedName)]: gzipRows([row("2026-09-01T00:00:00.000Z", "FROM-OLD-FILE")]),
    [join(STATE_DIR, collidingName)]: gzipRows([row("2026-09-01T00:00:00.000Z", "UNSELECTED")]),
  });
  const before = snapshot(memory.files);

  const result = command(["--max-sources", "1"], memory);

  assert.equal(result.code, 1);
  assert.match(result.errors.join("\n"), /refusing to overwrite unselected archive/);
  assert.deepEqual(snapshot(memory.files), before);
  assert.deepEqual(memory.writes, []);
  assert.deepEqual(memory.removals, []);
});

test("ledger-compact refuses an over-ceiling source flag before reading the state directory", () => {
  const memory = memoryFs({});

  const result = command(["--max-sources", String(LEDGER_COMPACT_MAX_SOURCES + 1)], memory);

  assert.equal(result.code, 2);
  assert.equal(memory.reads, 0);
  assert.match(result.errors.join("\n"), /--max-sources must be an integer from 1 to 50/);
});

test("ledger-compact refuses an unknown flag before reading the state directory", () => {
  const memory = memoryFs({});

  const result = command(["--delete"], memory);

  assert.equal(result.code, 2);
  assert.equal(memory.reads, 0);
  assert.match(result.errors.join("\n"), /unexpected argument '--delete'/);
});

test("ledger-compact uses its real stderr sink when no output seam is supplied", (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (...parts: unknown[]) => errors.push(parts.map(String).join(" ")));

  const result = ledgerCompactCommand(["--delete"]);

  assert.equal(result, 2);
  assert.match(errors.join("\n"), /unexpected argument '--delete'/);
});

test("ledger-compact accepts an explicit bounded age", () => {
  const memory = memoryFs({});

  const result = command(["--older-than", "30"], memory);

  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.out[0]!).olderThanDays, 30);
});

test("ledger-compact names a state-directory resolution failure", () => {
  const errors: string[] = [];
  const deps: LedgerCompactCommandDeps = { error: (line) => errors.push(line) };
  Object.defineProperty(deps, "stateDir", {
    get() {
      throw new Error("state root refused");
    },
  });

  const result = ledgerCompactCommand([], deps);

  assert.equal(result, 1);
  assert.match(errors.join("\n"), /cannot resolve the state directory — state root refused/);
});

test("ledger-compact names a selected-source read failure without writing or removing", () => {
  const name = compactedArchiveName("2026-08-01T00:00:00.000Z");
  const memory = memoryFs({ [join(STATE_DIR, name)]: gzipRows([row("2026-08-01T00:00:00.000Z", "R")]) });
  memory.fs.readFileSync = () => { throw new Error("archive unreadable"); };

  const result = command([], memory);

  assert.equal(result.code, 1);
  assert.match(result.errors.join("\n"), /cannot read the selected window — archive unreadable/);
  assert.deepEqual(memory.writes, []);
  assert.deepEqual(memory.removals, []);
});

test("ledger-compact preserves every source when the atomic replacement withdraws", () => {
  const name = compactedArchiveName("2026-08-01T00:00:00.000Z");
  const memory = memoryFs({ [join(STATE_DIR, name)]: gzipRows([row("2026-08-01T00:00:00.000Z", "R")]) });
  const before = snapshot(memory.files);
  memory.fs.writeAtomic = () => false;

  const result = command([], memory);

  assert.equal(result.code, 1);
  assert.match(result.errors.join("\n"), /atomic replacement withdrew before rename/);
  assert.deepEqual(snapshot(memory.files), before);
  assert.deepEqual(memory.removals, []);
});

test("ledger-compact reports a state dir it cannot list, and exits 1 rather than throwing", () => {
  const memory = memoryFs({});
  const boom = new Error("EACCES: permission denied, scandir");
  const failing = {
    ...memory.fs,
    readdirSync: () => {
      throw boom;
    },
  };
  const out: string[] = [];
  const errors: string[] = [];
  const code = ledgerCompactCommand([], {
    stateDir: STATE_DIR,
    clock: fixedClock(NOW.getTime()),
    fs: failing,
    out: (line) => out.push(line),
    error: (line) => errors.push(line),
  });

  assert.equal(code, 1, "an unlistable state dir is a failure, not a silent no-op");
  const said = [...out, ...errors].join("\n");
  assert.match(said, /cannot list/, "the operator must be told the listing failed");
  assert.match(said, /EACCES: permission denied, scandir/, "the underlying reason must survive verbatim");
});
