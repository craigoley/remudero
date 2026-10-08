import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createLedgerRotationMemo, ledgerRotationEntries } from "../src/lib/ledger-union.js";
import { writeLedger } from "./helpers/ledger-fixture.js";
import { buildActionResultsRoute } from "../src/lib/action-results.js";
import { readReportedAnomalies } from "../src/lib/cost-anomaly.js";
import { createFollowUpHistoryReader } from "../src/lib/follow-up-policy.js";
import { createLatestMeasurementReader } from "../src/lib/measurement-cadence.js";

const reduce = (rows: Array<Record<string, unknown>>) => rows.filter((row) => row.keep);
const noParse = () => { throw new Error("loaded rotations must not be parsed inline"); };
const digestDir = (dir: string, holder = "fixture") => join(dir, "cache", "rotation-digests", holder);
const digestPath = (dir: string, name: string, holder = "fixture") => join(digestDir(dir, holder), `${name}.json`);

test("test/a-cold-memo-reads-rotation-digests.test.ts: cold digests preserve reduced rows and torn evidence without archive reads", async () => {
  const fx = writeLedger([], { rotations: [] });
  try {
    for (const form of ["gzip", "plain"] as const) {
      const name = `ledger.2026-10-01T01-00-00-000Z.ndjson${form === "gzip" ? ".gz" : ""}`;
      const path = join(fx.dir, name);
      const text = '{"step":"fixture","keep":true,"value":"🚀\u2028"}\n{"keep":false}\nbroken\n';
      writeFileSync(path, form === "gzip" ? gzipSync(text) : text);
    }
    const entries = ledgerRotationEntries(readdirSync(fx.dir), fx.dir);
    assert.equal(entries.length, 2);
    const baseline = createLedgerRotationMemo(reduce);
    await baseline.load(entries);
    const versionTwo = (rows: Array<Record<string, unknown>>) => reduce(rows).map((row) => ({ ...row, versionTwo: true }));
    const make = (version = "1", reducer = version === "2" ? versionTwo : reduce) => {
      const reads: string[] = [];
      const memo = createLedgerRotationMemo(reducer, {
        holder: "fixture", durableDigest: { reducerVersion: version },
        readFile: async (path) => { reads.push(path); return readFile(path); },
      });
      return { memo, reads };
    };
    const first = make();
    await first.memo.load(entries);
    assert.equal(first.reads.length, 2);
    assert.equal(first.memo.retention().digestMisses, 2);
    assert.equal(first.memo.retention().digestOutcomes?.missing, 2);
    assert.equal(readdirSync(digestDir(fx.dir)).length, 2, "only committed JSON digests remain");
    const cold = make();
    await cold.memo.load(entries);
    assert.deepEqual(cold.reads, []);
    assert.equal(cold.memo.retention().digestHits, 2);
    for (const entry of entries) {
      assert.deepEqual(cold.memo.pass().rotationRecords(entry, noParse), baseline.pass().rotationRecords(entry, noParse));
    }
    const entry = entries[0];
    const name = entry.path.split("/").at(-1)!;
    const saved = readFileSync(digestPath(fx.dir, name), "utf8");
    for (const content of ["{broken", JSON.stringify({ rows: [] }), saved.replace('"torn":1', '"torn":-1')]) {
      writeFileSync(digestPath(fx.dir, name), content);
      const bad = make();
      await bad.memo.load(entries);
      assert.deepEqual(bad.reads, [entry.path]);
      assert.equal(bad.memo.retention().digestOutcomes?.corrupt, 1);
      assert.deepEqual(bad.memo.pass().rotationRecords(entry, noParse), baseline.pass().rotationRecords(entry, noParse));
    }
    const changedVersion = make("2");
    await changedVersion.memo.load(entries);
    assert.equal(changedVersion.reads.length, 2);
    assert.equal(changedVersion.memo.retention().digestOutcomes?.version, 2);
    assert.equal(changedVersion.memo.pass().rotationRecords(entry, noParse).rows[0].versionTwo, true);
    const stat = statSync(entry.path);
    utimesSync(entry.path, stat.atime, new Date(stat.mtimeMs + 5000));
    const changedIdentity = make("2");
    await changedIdentity.memo.load(entries);
    assert.deepEqual(changedIdentity.reads, [entry.path]);
    assert.equal(changedIdentity.memo.retention().digestOutcomes?.identity, 1);
    writeFileSync(entry.path, entry.form === "gzip" ? gzipSync('{"keep":true,"changed":true}\n') : '{"keep":true,"changed":true}\n');
    const rewritten = make("2");
    await rewritten.memo.load(entries);
    assert.deepEqual(rewritten.reads, [entry.path]);
    assert.deepEqual(rewritten.memo.pass().rotationRecords(entry, noParse).rows, [{ keep: true, changed: true, versionTwo: true }]);
    rmSync(entry.path);
    const survivor = make("2");
    await survivor.memo.load(entries.slice(1));
    assert.deepEqual(readdirSync(digestDir(fx.dir)), [entries[1].path.split("/").at(-1)! + ".json"]);
    assert.equal(survivor.memo.retention().digestOutcomes?.pruned, 1);
    rmSync(entries[1].path);
    await survivor.memo.load([]);
    assert.deepEqual(readdirSync(digestDir(fx.dir)), []);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("digest cache failures retain archive results and report unreadable, write and prune outcomes", async () => {
  const fx = writeLedger([], { rotations: [{ at: "2026-10-01T02:00:00.000Z", rows: [{ keep: true }] }] });
  try {
    const entries = ledgerRotationEntries(readdirSync(fx.dir), fx.dir);
    const name = entries[0].path.split("/").at(-1)!;
    mkdirSync(digestPath(fx.dir, name), { recursive: true });
    const memo = createLedgerRotationMemo(reduce, { holder: "fixture", durableDigest: { reducerVersion: "1" } });
    await memo.load(entries);
    assert.deepEqual(memo.pass().rotationRecords(entries[0], noParse).rows, [{ keep: true }]);
    assert.equal(memo.retention().failedArchives, 0);
    assert.equal(memo.retention().digestOutcomes?.unreadable, 1);
    assert.equal(memo.retention().digestOutcomes?.writeFailed, 1);
    assert.match(memo.retention().digestErrors?.writeFailed ?? "", /EISDIR/);
    assert.deepEqual(readdirSync(digestDir(fx.dir)), [name + ".json"], "a failed atomic rename cleans up its temporary file");
    const orphan = join(digestDir(fx.dir), "ledger.gone.ndjson.json");
    mkdirSync(orphan);
    writeFileSync(join(orphan, "occupied"), "fixture");
    // Node refuses unlinking a directory on every host, but the native errno is
    // EPERM on Darwin and EISDIR on Linux. Pin the real operation, not one OS.
    let nativeDirectoryUnlinkCode: string | undefined;
    assert.throws(() => unlinkSync(orphan), (error: NodeJS.ErrnoException) => {
      assert.match(error.code ?? "", /^(EISDIR|EPERM)$/);
      nativeDirectoryUnlinkCode = error.code;
      return true;
    });
    await memo.load(entries);
    assert.equal(memo.retention().digestOutcomes?.pruneFailed, 1);
    assert.equal(memo.retention().digestErrors?.pruneFailed, nativeDirectoryUnlinkCode);
    assert.equal(readFileSync(join(orphan, "occupied"), "utf8"), "fixture", "a failed prune keeps the directory and its evidence");
    const logged: Record<string, unknown>[] = [];
    memo.reportRetention(fx.dir, "fixture", (_step, row) => logged.push(row));
    assert.equal(logged[0].digestMisses, 2);
    assert.equal(logged[0].digestHits, 0);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("all four async holders reuse their versioned digests in a new process", async () => {
  const fx = writeLedger([], { rotations: [{ at: "2026-10-01T02:00:00.000Z", gz: true,
    rows: [{ step: "measurement_cadence.ran", ts: "2026-10-01T01:00:00.000Z", sample: { value: 42 } },
      { step: "cost.anomaly", run_id: "reported" }] }] });
  try {
    const anomalies = await readReportedAnomalies(fx.dir, []);
    assert.deepEqual([...anomalies.costAnomaly], ["reported"]);
    assert.deepEqual(await createFollowUpHistoryReader()(fx.path), []);
    const measurements = await createLatestMeasurementReader()(fx.dir, 1);
    assert.equal(measurements.status, "ok");
    await buildActionResultsRoute(fx.path).handler({ url: "/v1/action-results" } as never,
      { writeHead() {}, end() {} } as never, {} as never);
    const holders = ["action-results", "cost-anomaly", "follow-up-policy", "measurement-cadence"];
    for (const holder of holders) {
      const files = readdirSync(digestDir(fx.dir, holder));
      assert.equal(files.length, 1);
      const digest = JSON.parse(readFileSync(join(digestDir(fx.dir, holder), files[0]), "utf8"));
      assert.equal(digest.holder, holder);
      assert.equal(digest.reducerVersion, "1");
    }
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const original = fs.createReadStream;
      let archiveReads = 0;
      fs.createReadStream = (...args) => { archiveReads++; return original(...args); };
      syncBuiltinESMExports();
      const { setLedgerMemoRetentionContext } = await import("./src/lib/ledger-union.ts");
      const { buildActionResultsRoute } = await import("./src/lib/action-results.ts");
      const { readReportedAnomalies } = await import("./src/lib/cost-anomaly.ts");
      const { createFollowUpHistoryReader } = await import("./src/lib/follow-up-policy.ts");
      const { createLatestMeasurementReader } = await import("./src/lib/measurement-cadence.ts");
      const dir = process.argv[1];
      const retention = [];
      setLedgerMemoRetentionContext({ thread: "child", instances: [], log: (_step, row) => retention.push(row) });
      const anomalies = await readReportedAnomalies(dir, []);
      const follows = await createFollowUpHistoryReader()(dir + "/ledger.ndjson");
      const measurements = await createLatestMeasurementReader()(dir, 1);
      await buildActionResultsRoute(dir + "/ledger.ndjson").handler({ url: "/v1/action-results" },
        { writeHead() {}, end() {} }, {});
      console.log(JSON.stringify({ archiveReads, anomalies: [...anomalies.costAnomaly], follows, measurements, retention }));
    `, fx.dir], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const output = JSON.parse(child.stdout.trim());
    assert.equal(output.archiveReads, 0);
    assert.deepEqual(output.anomalies, ["reported"]);
    assert.deepEqual(output.follows, []);
    assert.deepEqual(output.measurements, measurements);
    assert.deepEqual(output.retention.map((row: Record<string, unknown>) => row.holder).sort(), holders);
    for (const row of output.retention) {
      assert.equal(row.digestHits, 1);
      assert.equal(row.digestMisses, 0);
    }
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("invalid stores are rejected and cache cleanup failures carry a bounded error code", async () => {
  assert.throws(() => createLedgerRotationMemo(reduce, { durableDigest: { reducerVersion: "1" } }), /holder and reducer version/);
  assert.throws(() => createLedgerRotationMemo(reduce, { holder: "fixture", durableDigest: { reducerVersion: "" } }), /holder and reducer version/);
  const fx = writeLedger([], { rotations: [{ at: "2026-10-01T03:00:00.000Z", rows: [{ keep: true }] }] });
  const fsp = createRequire(import.meta.url)("node:fs/promises") as { unlink: (path: string) => Promise<void> };
  const original = fsp.unlink;
  try {
    fsp.unlink = async (path) => {
      if (path.endsWith(".tmp")) throw Object.assign(new Error("private cache details"), { code: "EACCES" });
      return original(path);
    };
    syncBuiltinESMExports();
    const memo = createLedgerRotationMemo(reduce, { holder: "fixture", durableDigest: { reducerVersion: "1" } });
    await memo.load(ledgerRotationEntries(readdirSync(fx.dir), fx.dir));
    assert.equal(memo.retention().digestOutcomes?.cleanupFailed, 1);
    assert.equal(memo.retention().digestErrors?.cleanupFailed, "EACCES");
    assert.equal(memo.retention().failedArchives, 0);
    assert.equal(memo.retention().rows, 1);
  } finally {
    fsp.unlink = original;
    syncBuiltinESMExports();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("a digest is published by renaming a complete private file over the previous digest", async () => {
  const fx = writeLedger([], { rotations: [{ at: "2026-10-01T04:00:00.000Z", rows: [{ keep: true }] }] });
  const fsp = createRequire(import.meta.url)("node:fs/promises") as { rename: (from: string, to: string) => Promise<void> };
  const original = fsp.rename;
  let renames = 0;
  try {
    const entries = ledgerRotationEntries(readdirSync(fx.dir), fx.dir);
    const target = digestPath(fx.dir, entries[0].path.split("/").at(-1)!);
    mkdirSync(digestDir(fx.dir), { recursive: true });
    writeFileSync(target, "old incomplete digest");
    fsp.rename = async (from, to) => {
      assert.equal(to, target);
      assert.match(from, /\.tmp$/);
      assert.equal(readFileSync(target, "utf8"), "old incomplete digest");
      const digest = JSON.parse(readFileSync(from, "utf8"));
      assert.deepEqual(digest.read, { rows: [{ keep: true }], torn: 0, tornLines: [] });
      assert.equal(statSync(from).mode & 0o777, 0o600);
      renames++;
      await original(from, to);
    };
    syncBuiltinESMExports();
    const memo = createLedgerRotationMemo(reduce, { holder: "fixture", durableDigest: { reducerVersion: "1" } });
    await memo.load(entries);
    assert.equal(renames, 1);
    assert.equal(memo.retention().digestOutcomes?.written, 1);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")).read.rows, [{ keep: true }]);
  } finally {
    fsp.rename = original;
    syncBuiltinESMExports();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
