import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { auditLedgerUnion } from "#src/lib/ledger-union.js";
import { MAX_RETAINED_LINES_PER_STEP } from "#src/lib/ledger.js";
import { auditedLifetimeTalliesFromArchives } from "#test/helpers/run-task-test.js"; // the shared run-task seam

type Row = Record<string, unknown>;
const STEPS = ["run.start", "daemon.spawn_infra_blocked", "verdict"];
const TASKS = ["W1-TA", "W1-TB", "W1-TC", "W1-TD"];
const stamp = (n: number): string => new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + n * 1000).toISOString();
let clock = 0;
const start = (task: string, n: number): string =>
  JSON.stringify({ ts: stamp(clock++), task_id: task, run_id: `${task}-${n}`, step: "run.start" });
const verdict = (task: string, n: number, value: string): string =>
  JSON.stringify({ ts: stamp(clock++), task_id: task, run_id: `${task}-${n}`, step: "verdict", verdict: value, reason: "" });
const blocked = (task: string): string =>
  JSON.stringify({ ts: stamp(clock++), task_id: "DAEMON", task, step: "daemon.spawn_infra_blocked", reason: "no headroom" });

const ARCHIVE_SECONDS = 1_790_000_000;

/** Three rotated files, in both forms. Each later file repeats rows of the file before it, as a rotation does. */
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-lifetime-slices-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const name = (n: number, gzip: boolean): string => join(stateDir, `ledger.2026-10-0${n + 1}T00-00-00-000Z.ndjson${gzip ? ".gz" : ""}`);
  /** Writes a rotated file with a whole-second modification time, so a test can put the same time back. */
  const archive = (path: string, lines: readonly string[], seconds = ARCHIVE_SECONDS): void => {
    const text = lines.join("\n") + "\n";
    writeFileSync(path, path.endsWith(".gz") ? gzipSync(text) : text);
    utimesSync(path, seconds, seconds);
  };
  const a0 = start("W1-TA", 0), a1 = start("W1-TA", 1), a0done = verdict("W1-TA", 0, "failed"), aBlocked = blocked("W1-TA");
  const b0 = start("W1-TB", 0);
  // A line that a foreign writer spaced out. Its repeat in the next file has the same bytes.
  const d0 = `{"ts": "${stamp(clock++)}", "task_id": "W1-TD", "run_id": "W1-TD-0", "step": "run.start"}`;
  const first = [
    a0, a1, a1, a0done, aBlocked,
    JSON.stringify({ ts: stamp(clock++), task_id: "W1-TA", run_id: "W1-TA-0", step: "review.posted", note: "a verdict of run.start" }),
    "", "not json {", "[1,2]", b0, d0,
  ];
  const a2 = start("W1-TA", 2), b1 = start("W1-TB", 1);
  const second = [a1, a0done, aBlocked, b0, d0, a2, b1, verdict("W1-TB", 0, "failed"), blocked("W1-TB")];
  // More starts than the window for repeated rows holds: the repeat of the first one is a new row again,
  // and the repeat of the last one is not.
  const many = Array.from({ length: MAX_RETAINED_LINES_PER_STEP + 5 }, (_, n) => start("W1-TC", n));
  const third = [a2, b1, ...many, many[0]!, many.at(-1)!];
  const paths = [name(0, true), name(1, false), name(2, true)];
  archive(paths[0]!, first);
  archive(paths[1]!, second);
  archive(paths[2]!, third);
  // The live ledger repeats the rows that the last rotation kept, then adds one start.
  writeFileSync(join(stateDir, "ledger.ndjson"), [a2, b1, many.at(-1)!, start("W1-TA", 3)].join("\n") + "\n");
  const snapshot = join(stateDir, "cache", "rotation-slices", "dispatch%2Elifetime-history.json");
  /** Replaces a rotated file with bytes that do not parse, at the same size and modification time. */
  const scramble = (path: string): void => {
    const { size, mtimeMs } = statSync(path);
    writeFileSync(path, Buffer.alloc(size, 0x21));
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  };
  return { stateDir, paths, name, archive, scramble, snapshot, second, b1 };
}

async function audit(stateDir: string) {
  const result = await auditedLifetimeTalliesFromArchives(stateDir);
  try {
    const tallies = result.history === undefined ? undefined
      : Object.fromEntries(TASKS.map((task) => [task, result.history!.tallyFor(task)]));
    return { ...result, tallies };
  } finally {
    result.history?.close?.();
  }
}

test("W1-T12235 criterion 1: a second call decompresses no rotated file that the first call read", async (t) => {
  const f = fixture(t);
  const first = await audit(f.stateDir);
  assert.equal(first.loaded.archives_read, 3);
  assert.equal(first.loaded.archives_from_snapshot, 0);
  for (const path of f.paths) f.scramble(path);
  const second = await audit(f.stateDir);
  assert.equal(second.unavailableReason, undefined, "a read of a scrambled file would refuse the history");
  assert.equal(second.loaded.archives_read, 0);
  assert.equal(second.loaded.archives_from_snapshot, 3);
  assert.equal(second.records, first.records);
  assert.deepEqual(second.tallies, first.tallies);
});

test("W1-T12235 criterion 2: with one new rotated file, the call decompresses that file only", async (t) => {
  const f = fixture(t);
  const first = await audit(f.stateDir);
  for (const path of f.paths) f.scramble(path);
  f.archive(f.name(3, true), [start("W1-TA", 9)]);
  const second = await audit(f.stateDir);
  assert.equal(second.unavailableReason, undefined);
  assert.equal(second.loaded.archive_count, 4);
  assert.equal(second.loaded.archives_read, 1);
  assert.equal(second.loaded.archives_from_snapshot, 3);
  assert.equal(second.records, first.records + 1);
  assert.equal(second.tallies?.["W1-TA"]?.starts, (first.tallies?.["W1-TA"]?.starts ?? 0) + 1);
  const third = await audit(f.stateDir);
  assert.equal(third.loaded.archives_read, 0);
  assert.equal(third.loaded.archives_from_snapshot, 4);
  assert.deepEqual(third.tallies, second.tallies);
});

test("W1-T12235 criterion 3: the tallies from the kept slices equal the tallies from a read of every file", async (t) => {
  const f = fixture(t);
  // The reference: the read of every file, with its window for repeated rows, as before this task.
  const accepted: string[] = [];
  const reference = await auditLedgerUnion(f.stateDir, {
    step: STEPS, dedupeWindowPerStep: MAX_RETAINED_LINES_PER_STEP, onRecord: (_row, raw) => accepted.push(raw),
  });
  assert.equal(reference.ok, true);
  // 4 rows of task A, 1 of B and 1 of D in the first file; 4 new rows in the second; the starts of C and
  // the repeat of its first start, outside the window, in the third.
  assert.equal(reference.records, 6 + 4 + MAX_RETAINED_LINES_PER_STEP + 5 + 1);

  const fromFiles = await audit(f.stateDir); // no kept slice yet: the reader loads each file
  const fromSlices = await audit(f.stateDir); // every file from the kept slices
  writeFileSync(f.snapshot, "{ not json");
  const fromFullRead = await audit(f.stateDir); // the read of every file, through the fallback
  assert.equal(fromSlices.loaded.archives_from_snapshot, 3);
  assert.equal(typeof fromFullRead.loaded.slice_fallback, "string");
  for (const result of [fromFiles, fromSlices, fromFullRead]) {
    assert.equal(result.unavailableReason, undefined);
    assert.equal(result.records, reference.records);
    assert.equal(result.archiveCount, reference.archiveCount);
    assert.deepEqual(result.tallies, fromFullRead.tallies);
  }
  assert.deepEqual(fromSlices.tallies, {
    "W1-TA": { starts: 4, capacityBlocked: 1 },
    "W1-TB": { starts: 2, capacityBlocked: 1 },
    "W1-TC": { starts: MAX_RETAINED_LINES_PER_STEP + 5, capacityBlocked: 0 },
    "W1-TD": { starts: 1, capacityBlocked: 0 },
  });
});

test("W1-T12235 criterion 4: a kept slice with another size or modification time is not used", async (t) => {
  const f = fixture(t);
  const first = await audit(f.stateDir);
  // Another size: the second file gains a start.
  f.archive(f.paths[1]!, [...f.second, start("W1-TB", 7)]);
  const grown = await audit(f.stateDir);
  assert.equal(grown.loaded.archives_read, 1);
  assert.equal(grown.loaded.archives_from_snapshot, 2);
  assert.equal(grown.tallies?.["W1-TB"]?.starts, (first.tallies?.["W1-TB"]?.starts ?? 0) + 1);
  // The same size and another modification time: one start of task B becomes a start of task D.
  const moved = f.second.map((line) => (line === f.b1 ? line.replaceAll("W1-TB", "W1-TD") : line));
  const before = statSync(f.paths[1]!).size;
  f.archive(f.paths[1]!, [...moved, start("W1-TB", 7)], ARCHIVE_SECONDS + 5);
  assert.equal(statSync(f.paths[1]!).size, before);
  const retimed = await audit(f.stateDir);
  assert.equal(retimed.loaded.archives_read, 1);
  assert.equal(retimed.loaded.archives_from_snapshot, 2);
  assert.equal(retimed.tallies?.["W1-TD"]?.starts, (grown.tallies?.["W1-TD"]?.starts ?? 0) + 1);
});

test("W1-T12235 criterion 5: an unreadable snapshot gives a read of every rotated file and the same tallies", async (t) => {
  const f = fixture(t);
  const first = await audit(f.stateDir);
  writeFileSync(f.snapshot, "{ not json");
  const second = await audit(f.stateDir);
  assert.equal(second.unavailableReason, undefined);
  assert.equal(second.loaded.archives_read, 3);
  assert.equal(second.loaded.archives_from_snapshot, 0);
  assert.match(String(second.loaded.slice_fallback), /^snapshot: /);
  assert.equal(second.records, first.records);
  assert.deepEqual(second.tallies, first.tallies);
  // That call wrote the snapshot again.
  const third = await audit(f.stateDir);
  assert.equal(third.loaded.archives_from_snapshot, 3);
  assert.equal(third.loaded.slice_fallback, undefined);
  // A snapshot that parses, with a kept row that is not a ledger line, is not used either.
  const kept = JSON.parse(readFileSync(f.snapshot, "utf8")) as { rotations: Array<{ read: { rows: Row[] } }> };
  kept.rotations[0]!.read.rows[0] = { step: "run.start" };
  writeFileSync(f.snapshot, JSON.stringify(kept));
  const fourth = await audit(f.stateDir);
  assert.equal(fourth.loaded.archives_read, 3);
  assert.equal(fourth.loaded.slice_fallback, "slice_row_malformed");
  assert.equal(fourth.records, first.records);
  assert.deepEqual(fourth.tallies, first.tallies);
});

test("W1-T12235 criterion 6: one unreadable rotated file gives no history", async (t) => {
  const f = fixture(t);
  const first = await audit(f.stateDir);
  assert.ok(first.tallies);
  const broken = f.name(3, true);
  writeFileSync(broken, "not gzip");
  const second = await audit(f.stateDir);
  assert.equal(second.history, undefined);
  assert.equal(second.unavailableReason, "archive_unreadable");
  assert.deepEqual(second.unread, [broken]);
  assert.equal(second.archiveCount, 4);

  const fresh = fixture(t); // the same with no kept slice
  writeFileSync(fresh.paths[2]!, "not gzip");
  const refused = await audit(fresh.stateDir);
  assert.equal(refused.history, undefined);
  assert.equal(refused.unavailableReason, "archive_unreadable");
  assert.deepEqual(refused.unread, [fresh.paths[2]]);
});

test("W1-T12235 criterion 7: dispatch.lifetime_history_loaded states the files read and the files from the snapshot", async (t) => {
  const f = fixture(t);
  const first = await audit(f.stateDir);
  assert.deepEqual(first.loaded, {
    archive_count: 3, records: first.records, archives_read: 3, archives_from_snapshot: 0, archives_from_digest: 0,
  });
  const second = await audit(f.stateDir);
  assert.deepEqual(second.loaded, {
    archive_count: 3, records: first.records, archives_read: 0, archives_from_snapshot: 3, archives_from_digest: 0,
  });
  // With the snapshot gone, the digest of each file answers, and the row says so.
  rmSync(f.snapshot);
  const third = await audit(f.stateDir);
  assert.deepEqual(third.loaded, {
    archive_count: 3, records: first.records, archives_read: 0, archives_from_snapshot: 0, archives_from_digest: 3,
  });
});
