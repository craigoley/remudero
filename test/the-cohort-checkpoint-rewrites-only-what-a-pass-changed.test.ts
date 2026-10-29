import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  renameSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { BENCHMARK_COHORT_VERSION, runBenchmarkCohortPass,
  type BenchmarkCohortSnapshot } from "#src/lib/benchmark-cohort.js";
import { runDaemon } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import { drainDetachedSweepActions } from "#src/lib/sweep.js";

const INDEX = "benchmark-cohort-index.json";
const LEGACY = "benchmark-cohort-v1.json";
const nowIso = "2026-10-16T12:00:00.000Z";
const assignment = (id: string) => JSON.stringify({ ts: nowIso, step: "worker.assignment",
  worker_assignment: { id, selected: { provider: "cash", model: "gpt-5-nano" } } }) + "\n";
type Reference = { name: string; form: string; segment: string; segmentBytes: number;
  segmentSha256: string; rowCount: number };
const indexAt = (root: string) => JSON.parse(readFileSync(join(root, INDEX), "utf8"));
const semantic = (snapshot: BenchmarkCohortSnapshot) => ({ ...snapshot, pressure: undefined });

function fixture(history = 4000): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-cohort-segments-"));
  for (let n = 0; n < 2; n += 1) writeFileSync(join(root, `ledger.2026-10-1${n + 1}T12-00-00-000Z.ndjson.gz`),
    gzipSync(Array.from({ length: history }, (_, i) => assignment(`sealed-${n}-${i}`)).join("")));
  writeFileSync(join(root, "ledger.ndjson"), assignment("live-0"));
  return root;
}

function legacyFromSegments(root: string): unknown {
  const index = indexAt(root);
  const sources = index.sources.map((source: Reference) => {
    const { segment, segmentBytes, segmentSha256: _hash, rowCount: _count, ...metadata } = source;
    const encoded = readFileSync(join(root, segment)).subarray(0, segmentBytes).toString();
    return { ...metadata, rows: encoded.trim() ? encoded.trimEnd().split("\n").map((line) => JSON.parse(line)) : [] };
  });
  return { ...index, version: BENCHMARK_COHORT_VERSION, sources };
}

test("W1-T9911: a tail-only pass rewrites no sealed segment", async (t) => {
  const root = fixture();
  try {
    const first = await runBenchmarkCohortPass(root, { maxSources: 4, nowIso });
    assert.equal(first.state, "complete");
    const before = indexAt(root);
    assert.equal(before.version, "benchmark-cohort-segments-v2");
    assert.equal(before.sources.length, 3, "positive control: every source got a segment");
    const sealed = before.sources.filter((s: Reference) => s.form !== "live");
    const stamps = sealed.map((s: Reference) => statSync(join(root, s.segment)));
    const sealedBytes = stamps.reduce((sum: number, s: { size: number }) => sum + s.size, 0);
    const initialBytes = before.sources.reduce((sum: number, s: Reference) => sum + s.segmentBytes, 0)
      + statSync(join(root, INDEX)).size;
    assert.equal(first.checkpointWrittenBytes, initialBytes);
    for (const s of before.sources) assert.equal(Object.hasOwn(s, "rows"), false);
    assert.ok(statSync(join(root, INDEX)).size < sealedBytes / 10);
    const liveBefore = before.sources.find((s: Reference) => s.form === "live");
    const liveText = readFileSync(join(root, liveBefore.segment));
    const liveInode = statSync(join(root, liveBefore.segment)).ino;
    appendFileSync(join(root, "ledger.ndjson"), assignment("live-1"));
    const started = performance.now();
    const planPath = join(root, "tasks.yaml");
    const eventPath = join(root, "daemon-events.ndjson");
    writeFileSync(planPath, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
    let second: Awaited<ReturnType<typeof runBenchmarkCohortPass>> | undefined;
    await runDaemon(loadPlan(planPath), {
      refreshMerged: () => () => false,
      runOne: async (id: string) => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0,
        verdict: "merged" }),
      sleep: async () => {}, sweep: async () => {},
      checkBenchmarkCohort: () => true,
      runBenchmarkCohortPass: async () => {
        second = await runBenchmarkCohortPass(root, { maxSources: 4, nowIso });
        return second;
      },
      log: (step: string, fields?: Record<string, unknown>) => {
        if (step === "benchmark_cohort.ran")
          appendFileSync(eventPath, JSON.stringify({ step, ...fields }) + "\n");
      },
    }, { max: 1 });
    await drainDetachedSweepActions();
    assert.ok(second, "the daemon completed the tail pass");
    const ledgered = JSON.parse(readFileSync(eventPath, "utf8").trim());
    assert.equal(ledgered.step, "benchmark_cohort.ran");
    assert.deepEqual({ checkpoint_bytes: ledgered.checkpoint_bytes,
      checkpoint_read_bytes: ledgered.checkpoint_read_bytes,
      checkpoint_written_bytes: ledgered.checkpoint_written_bytes }, {
      checkpoint_bytes: second.checkpointBytes,
      checkpoint_read_bytes: second.checkpointReadBytes,
      checkpoint_written_bytes: second.checkpointWrittenBytes,
    }, "the persisted daemon event carries the pass's measured checkpoint I/O");
    assert.ok(ledgered.checkpoint_written_bytes < sealedBytes,
      "the host ledger records a tail write smaller than the sealed rows it kept");
    const elapsed = performance.now() - started;
    assert.equal(second.state, "complete");
    assert.equal(second.scannedSources, 1);
    assert.equal(second.snapshot.sourceRows.assignments, 8002);
    const after = indexAt(root);
    for (const [i, s] of sealed.entries()) {
      assert.equal(after.sources[i].segment, s.segment);
      const stat = statSync(join(root, s.segment));
      assert.equal(stat.ino, stamps[i].ino);
      assert.equal(stat.mtimeMs, stamps[i].mtimeMs);
      assert.equal(stat.size, stamps[i].size);
    }
    const liveAfter = after.sources.find((s: Reference) => s.form === "live");
    assert.equal(liveAfter.segment, liveBefore.segment);
    assert.equal(statSync(join(root, liveAfter.segment)).ino, liveInode);
    assert.deepEqual(readFileSync(join(root, liveAfter.segment)).subarray(0, liveText.length), liveText);
    const delta = liveAfter.segmentBytes - liveBefore.segmentBytes;
    assert.ok(delta > 0);
    assert.equal(second.checkpointWrittenBytes, statSync(join(root, INDEX)).size + delta);
    assert.equal(second.checkpointReadBytes, Buffer.byteLength(JSON.stringify(before))
      + before.sources.reduce((sum: number, s: Reference) => sum + s.segmentBytes, 0));
    assert.ok(second.checkpointWrittenBytes! < sealedBytes);
    assert.equal(second.checkpointBytes, after.sources.reduce((sum: number, s: Reference) => sum + s.segmentBytes, 0)
      + statSync(join(root, INDEX)).size);
    t.diagnostic(JSON.stringify({ historyAssignments: 8000, elapsedMs: elapsed,
      deriveSnapshotMs: second.snapshot.pressure.rebuildMs,
      readBytes: second.checkpointReadBytes, writtenBytes: second.checkpointWrittenBytes, sealedBytes }));
    const cached = await runBenchmarkCohortPass(root, { nowIso });
    assert.equal(cached.checkpointWrittenBytes, 0);
    assert.ok(cached.checkpointReadBytes! > sealedBytes);
    const archive = join(root, sealed[0].name);
    const stamp = new Date(statSync(archive).mtimeMs + 1000);
    utimesSync(archive, stamp, stamp);
    const reaudited = await runBenchmarkCohortPass(root, { nowIso });
    assert.equal(reaudited.scannedSources, 1);
    assert.equal(indexAt(root).sources[0].segment, sealed[0].segment, "the same name and sha keeps its immutable segment");
    assert.equal(statSync(join(root, sealed[0].segment)).mtimeMs, stamps[0].mtimeMs);
    assert.equal(reaudited.checkpointWrittenBytes, statSync(join(root, INDEX)).size);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T9911: the segmented checkpoint yields the whole-file snapshot", async () => {
  const root = fixture(5);
  try {
    const fresh = await runBenchmarkCohortPass(root, { maxSources: 4, nowIso });
    const sources = readdirSync(root).filter((name) => name.startsWith("ledger.")).sort().map((name) => {
      const path = join(root, name);
      const bytes = readFileSync(path);
      const text = name.endsWith(".gz") ? gunzipSync(bytes).toString() : bytes.toString();
      const stat = statSync(path);
      return { name, form: name.endsWith(".gz") ? "gzip" : "live", size: stat.size, mtimeMs: stat.mtimeMs,
        sha256: createHash("sha256").update(bytes).digest("hex"), projection: "implement-forecast-v1",
        rows: text.trimEnd().split("\n").map((line) => ({ fingerprint: createHash("sha256").update(line).digest("hex"),
          bytes: Buffer.byteLength(line), row: JSON.parse(line) })) };
    });
    const v1 = { version: BENCHMARK_COHORT_VERSION, sources };
    writeFileSync(join(root, LEGACY), JSON.stringify(v1));
    unlinkSync(join(root, INDEX));
    const migrated = await runBenchmarkCohortPass(root, { maxSources: 4, nowIso });
    assert.deepEqual(semantic(migrated.snapshot), semantic(fresh.snapshot));
    assert.equal(migrated.scannedSources, 0);
    assert.equal(indexAt(root).version, "benchmark-cohort-segments-v2");
    appendFileSync(join(root, "ledger.ndjson"), assignment("live-next"));
    const appended = await runBenchmarkCohortPass(root, { maxSources: 4, nowIso });
    for (const name of readdirSync(root).filter((s) => s.startsWith("benchmark-cohort-"))) unlinkSync(join(root, name));
    const replayed = await runBenchmarkCohortPass(root, { maxSources: 4, nowIso });
    assert.deepEqual(semantic(appended.snapshot), semantic(replayed.snapshot));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T9911: a v1 checkpoint is migrated once without a rescan", async () => {
  const root = fixture(5);
  try {
    await runBenchmarkCohortPass(root, { maxSources: 4, nowIso });
    const v1 = legacyFromSegments(root);
    for (const name of readdirSync(root).filter((s) => s.startsWith("benchmark-cohort-"))) unlinkSync(join(root, name));
    writeFileSync(join(root, LEGACY), JSON.stringify(v1));
    const migrated = await runBenchmarkCohortPass(root, { maxSources: 4, nowIso });
    assert.equal(migrated.scannedSources, 0);
    assert.equal(migrated.snapshot.sourceRows.assignments, 11);
    assert.equal(indexAt(root).version, "benchmark-cohort-segments-v2");
    assert.equal(existsSync(join(root, LEGACY)), false);
    assert.ok(migrated.checkpointWrittenBytes! > 0);
    const stamps = indexAt(root).sources.map((s: Reference) => statSync(join(root, s.segment)).mtimeMs);
    const next = await runBenchmarkCohortPass(root, { nowIso });
    assert.equal(next.scannedSources, 0);
    assert.equal(next.checkpointWrittenBytes, 0);
    assert.deepEqual(indexAt(root).sources.map((s: Reference) => statSync(join(root, s.segment)).mtimeMs), stamps);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T9911: a corrupt segment rescans its source, never reads as empty", async () => {
  for (const form of ["gzip", "live"]) for (const damage of ["missing", "directory", "torn", "hash", "row", "newline", "count", "trailing"]) {
    if (form === "live" && damage === "trailing") continue;
    const root = fixture(5);
    try {
      const first = await runBenchmarkCohortPass(root, { maxSources: 4, nowIso });
      const index = indexAt(root);
      const source = index.sources.find((s: Reference) => s.form === form);
      const path = join(root, source.segment);
      if (damage === "missing") unlinkSync(path);
      if (damage === "directory") { unlinkSync(path); mkdirSync(path); }
      if (damage === "torn") truncateSync(path, source.segmentBytes - 1);
      if (damage === "trailing") appendFileSync(path, "uncommitted-sealed-bytes");
      if (damage === "hash") writeFileSync(path, readFileSync(path, "utf8").replace("gpt-5-nano", "gpt-6-luna"));
      if (damage === "row" || damage === "newline" || damage === "count") {
        const encoded = damage === "row" ? "null\n" : damage === "newline"
          ? readFileSync(path, "utf8").trimEnd() : readFileSync(path, "utf8");
        writeFileSync(path, encoded);
        source.segmentBytes = Buffer.byteLength(encoded);
        source.segmentSha256 = createHash("sha256").update(encoded).digest("hex");
        if (damage === "count") source.rowCount += 1;
        writeFileSync(join(root, INDEX), JSON.stringify(index));
      }
      const recovered = await runBenchmarkCohortPass(root, { maxSources: 4, nowIso });
      assert.equal(recovered.scannedSources, 1, `${form}/${damage} must rescan its real source`);
      assert.equal(recovered.state, "complete");
      assert.deepEqual(semantic(recovered.snapshot), semantic(first.snapshot));
      assert.notEqual(indexAt(root).sources.find((s: Reference) => s.form === form).segment, source.segment);
      assert.equal((await runBenchmarkCohortPass(root, { nowIso })).scannedSources, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("cohort segment metadata damage and incomplete recovery cannot return a cached complete cohort", async () => {
  const root = fixture(5);
  try {
    await runBenchmarkCohortPass(root, { maxSources: 4, nowIso });
    const index = indexAt(root);
    for (const source of index.sources.filter((s: Reference) => s.form === "gzip")) unlinkSync(join(root, source.segment));
    const partial = await runBenchmarkCohortPass(root, { maxSources: 1, nowIso });
    assert.equal(partial.state, "partial");
    assert.equal(partial.pendingSources, 1);
    assert.equal(partial.snapshot.state, "unavailable");
    assert.equal((await runBenchmarkCohortPass(root, { nowIso })).snapshot.sourceRows.assignments, 11);
    for (const encoded of ["null", "{torn", JSON.stringify({ ...index, sources: [{ ...index.sources[0], segment: "../outside.ndjson" }] })]) {
      writeFileSync(join(root, INDEX), encoded);
      const replay = await runBenchmarkCohortPass(root, { maxSources: 4, nowIso });
      assert.equal(replay.scannedSources, 3);
      assert.equal(replay.snapshot.sourceRows.assignments, 11);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cohort segments discard an uncommitted append and retain baseline prefixes across restart", async () => {
  const root = fixture(5);
  try {
    const first = await runBenchmarkCohortPass(root, { maxSources: 4, nowIso });
    const source = indexAt(root).sources.find((s: Reference) => s.form === "live");
    const path = join(root, source.segment);
    appendFileSync(path, '{"torn-uncommitted-append":');
    const cached = await runBenchmarkCohortPass(root, { nowIso });
    assert.deepEqual(semantic(cached.snapshot), semantic(first.snapshot));
    appendFileSync(join(root, "ledger.ndjson"), assignment("live-next"));
    const changed = await runBenchmarkCohortPass(root, { nowIso, onBeforeLivePrefixVerify: () => {
      writeFileSync(join(root, "ledger.ndjson"), assignment("rewritten"));
    } });
    assert.equal(changed.state, "partial");
    const index = indexAt(root);
    assert.equal(index.baselineSources.find((s: Reference) => s.form === "live").segment, source.segment);
    assert.equal(index.baselineSources.find((s: Reference) => s.form === "live").segmentBytes, source.segmentBytes);
    assert.equal(readFileSync(path, "utf8").includes("torn-uncommitted"), false);
    const refused = await runBenchmarkCohortPass(root, { nowIso });
    assert.equal(refused.state, "unavailable");
    assert.equal(refused.snapshot.reason, "retired-source-evidence-not-reconciled");
    assert.equal(refused.snapshot.lastGoodAt, first.snapshot.asOf);
    assert.equal(existsSync(path), true, "a baseline still references the old live segment");
    writeFileSync(join(root, "ledger.ndjson"), assignment("live-0") + assignment("live-next"));
    assert.equal((await runBenchmarkCohortPass(root, { nowIso })).state, "complete");
    assert.equal(existsSync(path), false, "retired segments are removed after baseline reconciliation");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cohort tail writes stay on the inspected segment when its path is replaced", async () => {
  const root = fixture(5);
  const fs = createRequire(import.meta.url)("node:fs");
  const { openSync: open, fstatSync: fstat, statSync: stat } = fs;
  try {
    await runBenchmarkCohortPass(root, { maxSources: 4, nowIso });
    const source = indexAt(root).sources.find((s: Reference) => s.form === "live");
    const path = join(root, source.segment);
    const moved = join(root, "opened-segment.ndjson");
    const prefix = readFileSync(path);
    const replacement = "replacement must stay untouched\n";
    appendFileSync(path, "uncommitted tail");
    appendFileSync(join(root, "ledger.ndjson"), assignment("live-next"));
    let appendFd: number | undefined;
    let replaced = false;
    const replace = () => {
      renameSync(path, moved);
      writeFileSync(path, replacement);
      replaced = true;
    };
    fs.openSync = (file: string, flags: string, ...rest: unknown[]) => {
      const fd = open(file, flags, ...rest);
      if (file === path && flags === "r+") appendFd = fd;
      return fd;
    };
    fs.fstatSync = (fd: number, ...rest: unknown[]) => {
      const result = fstat(fd, ...rest);
      if (!replaced && fd === appendFd) replace();
      return result;
    };
    fs.statSync = (file: string, ...rest: unknown[]) => {
      const result = stat(file, ...rest);
      if (!replaced && file === path) replace();
      return result;
    };
    syncBuiltinESMExports();
    const appended = await runBenchmarkCohortPass(root, { nowIso });
    assert.equal(replaced, true, "positive control: the segment path changed after inspection");
    assert.equal(appended.state, "complete");
    assert.equal(readFileSync(path, "utf8"), replacement, "the replacement was never truncated or appended to");
    const committed = readFileSync(moved);
    assert.deepEqual(committed.subarray(0, prefix.length), prefix);
    assert.equal(committed.includes("uncommitted tail"), false);
    assert.equal(JSON.parse(committed.toString().trimEnd().split("\n").at(-1)!).row.worker_assignment.id, "live-next");
    fs.openSync = open; fs.fstatSync = fstat; fs.statSync = stat;
    syncBuiltinESMExports();
    const recovered = await runBenchmarkCohortPass(root, { nowIso });
    assert.equal(recovered.scannedSources, 1, "the replaced segment is recovered from its ledger source");
    assert.deepEqual(semantic(recovered.snapshot), semantic(appended.snapshot));
  } finally {
    fs.openSync = open; fs.fstatSync = fstat; fs.statSync = stat;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cohort append handles short writes and refuses lost prefixes or stalled writes", async () => {
  const fs = createRequire(import.meta.url)("node:fs");
  const { openSync: open, ftruncateSync: truncate, writeSync: write } = fs;
  for (const failure of ["missing", "torn", "stalled", "short"] as const) {
    const root = fixture(5);
    try {
      await runBenchmarkCohortPass(root, { maxSources: 4, nowIso });
      const source = indexAt(root).sources.find((s: Reference) => s.form === "live");
      const path = join(root, source.segment);
      const saved = readFileSync(join(root, INDEX), "utf8");
      appendFileSync(join(root, "ledger.ndjson"), assignment("live-next"));
      let appendFd: number | undefined;
      fs.openSync = (file: string, flags: string, ...rest: unknown[]) => {
        if (file === path && flags === "r+") {
          if (failure === "missing") unlinkSync(path);
          appendFd = open(file, flags, ...rest);
          if (failure === "torn") truncate(appendFd, source.segmentBytes - 1);
          return appendFd;
        }
        return open(file, flags, ...rest);
      };
      fs.writeSync = (fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
        fd === appendFd ? failure === "stalled" ? 0 : write(fd, buffer, offset, Math.min(length, 7), position)
          : write(fd, buffer, offset, length, position);
      syncBuiltinESMExports();
      if (failure === "short") {
        const appended = await runBenchmarkCohortPass(root, { nowIso });
        assert.equal(appended.snapshot.sourceRows.assignments, 12);
        assert.equal(appended.state, "complete");
      } else {
        await assert.rejects(runBenchmarkCohortPass(root, { nowIso }),
          failure === "missing" ? /ENOENT/ : failure === "torn" ? /checkpoint-segment-torn/ : /checkpoint-segment-write-stalled/);
        assert.equal(readFileSync(join(root, INDEX), "utf8"), saved, "a failed append never publishes an index");
      }
      fs.openSync = open; fs.writeSync = write;
      syncBuiltinESMExports();
      const recovered = await runBenchmarkCohortPass(root, { nowIso });
      assert.equal(recovered.state, "complete");
      assert.equal(recovered.snapshot.sourceRows.assignments, 12);
    } finally {
      fs.openSync = open; fs.writeSync = write;
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("cohort migration keeps v1 recoverable when index publication fails", async () => {
  const root = fixture(5);
  const fs = createRequire(import.meta.url)("node:fs");
  const rename = fs.renameSync;
  try {
    await runBenchmarkCohortPass(root, { maxSources: 4, nowIso });
    writeFileSync(join(root, LEGACY), JSON.stringify(legacyFromSegments(root)));
    unlinkSync(join(root, INDEX));
    fs.renameSync = (from: string, to: string) => {
      if (to === join(root, INDEX)) throw Object.assign(new Error("index publication failed"), { code: "EIO" });
      return rename(from, to);
    };
    syncBuiltinESMExports();
    await assert.rejects(runBenchmarkCohortPass(root, { nowIso }), /index publication failed/);
    assert.equal(existsSync(join(root, LEGACY)), true);
    assert.equal(existsSync(join(root, INDEX)), false);
    fs.renameSync = rename;
    syncBuiltinESMExports();
    assert.equal((await runBenchmarkCohortPass(root, { maxSources: 4, nowIso })).scannedSources, 0);
    assert.equal(existsSync(join(root, LEGACY)), false);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});

test("cohort migration finishes legacy removal after index publication was interrupted", async () => {
  const root = fixture(5);
  const fs = createRequire(import.meta.url)("node:fs");
  const rename = fs.renameSync;
  try {
    await runBenchmarkCohortPass(root, { maxSources: 4, nowIso });
    writeFileSync(join(root, LEGACY), JSON.stringify(legacyFromSegments(root)));
    unlinkSync(join(root, INDEX));
    fs.renameSync = (from: string, to: string) => {
      rename(from, to);
      if (to === join(root, INDEX)) throw new Error("interrupted after publication");
    };
    syncBuiltinESMExports();
    await assert.rejects(runBenchmarkCohortPass(root, { nowIso }), /interrupted after publication/);
    assert.equal(existsSync(join(root, LEGACY)), true);
    assert.equal(existsSync(join(root, INDEX)), true);
    fs.renameSync = rename;
    syncBuiltinESMExports();
    const recovered = await runBenchmarkCohortPass(root, { nowIso });
    assert.equal(recovered.scannedSources, 0);
    assert.equal(recovered.checkpointWrittenBytes, 0);
    assert.equal(recovered.snapshot.sourceRows.assignments, 11);
    assert.equal(existsSync(join(root, LEGACY)), false);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});
