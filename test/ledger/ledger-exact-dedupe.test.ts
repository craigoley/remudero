import { REPO_ROOT as __workspaceRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL as __workspaceUrl } from "node:url";
const __workspaceRootUrl = __workspaceUrl(__workspaceRoot + "/");
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { createLedgerExactDedupe, LedgerExactDedupeError } from "#src/lib/ledger-exact-dedupe.js";
import { openLedgerUnion } from "#src/lib/ledger-union.js";
import { RmdError, exitCodeFor } from "#src/lib/errors.js";

test("the real disk index preserves exact identities including NUL, separators and unpaired surrogates", () => {
  const index = createLedgerExactDedupe();
  try {
    const distinct = ["", "a", "A", "a\0", "a\u2028b", "a\u2029b", "\ud800", "\ud801", "\ufffd"];
    for (const line of distinct) assert.equal(index.add(line), true);
    for (const line of distinct.toReversed()) assert.equal(index.add(line), false);
    const evidence = index.evidence();
    assert.equal(evidence.accepted, distinct.length); assert.equal(evidence.replayed, distinct.length);
    assert.equal(evidence.directoryMode, 0o700); assert.equal(evidence.databaseMode, 0o600);
    assert.ok(evidence.pageBytes !== null && evidence.pageBytes <= evidence.maxBytes); assert.equal(evidence.mmapBytes, 0);
  } finally { index.close(); }
  index.close();
  assert.throws(() => index.add("later"), LedgerExactDedupeError);
  assert.throws(() => index.evidence(), LedgerExactDedupeError);
});

test("actual SQLite FULL refuses distinctness instead of evicting a replay or counting a made-up row", () => {
  const before = readdirSync(tmpdir()).filter(name => name.startsWith("rmd-ledger-exact-dedupe-"));
  const index = createLedgerExactDedupe(16_384);
  try {
    assert.equal(index.add("positive control"), true);
    assert.equal(index.add("positive control"), false);
    assert.throws(() => {
      for (let i = 0; i < 64; i++) {
        const key = "x".repeat(1000) + String(i);
        assert.ok(key.length * 2 < 16_384, "every individual key fits below the existing whole-store bound");
        index.add(key);
      }
    }, error => error instanceof LedgerExactDedupeError && error.reason === "ledger-dedupe-storage-bound");
    assert.throws(() => index.add("positive control"), LedgerExactDedupeError, "a terminal write failure never reuses a possibly damaged OFF-journal index");
    assert.ok(index.evidence().accepted > 1, "real native SQLite accepted multiple small keys before aggregate page exhaustion");
    assert.equal(index.evidence().pageBytes, null);
    assert.equal(index.evidence().complete, false);
  } finally { index.close(); }
  assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith("rmd-ledger-exact-dedupe-")), before);
  for (const bound of [0, 16_383, NaN, Infinity, 128 * 1024 ** 2 + 1])
    assert.throws(() => createLedgerExactDedupe(bound), TypeError);
});

test("the exact index and native union agree on far-separated gzip plain live replays and distinct accepted units", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-exact-union-fixture-"));
  const index = createLedgerExactDedupe();
  const row = (id: string) => JSON.stringify({ ts: "2026-10-02T10:00:00Z", step: "fixture", marker: id });
  const a = row("a"), b = row("b"), c = row("c");
  try {
    writeFileSync(join(dir, "ledger.2026-10-02T11-00-00-000Z.ndjson.gz"), gzipSync(`${a}\n${b}\n{"broken":\n`));
    writeFileSync(join(dir, "ledger.2026-10-02T12-00-00-000Z.ndjson"), `${c}\n${a}\n${b}\n`);
    writeFileSync(join(dir, "ledger.ndjson"), `${c}\n${a}\n${b}\n${b.replace('"marker":"b"', '"marker": "b"')}\n`);
    const read = async (exactDedupe?: typeof index) => {
      const rows: unknown[] = [], findings: unknown[] = [], accepted: string[] = [];
      for await (const value of openLedgerUnion(dir, { exactDedupe, onMalformedRow: f => findings.push(f),
        onAcceptedRecord: (_row, raw) => accepted.push(raw) })) rows.push(value);
      return { rows, findings, accepted };
    };
    assert.deepEqual(await read(index), await read());
    assert.equal(index.evidence().accepted, 4, "same values in different raw JSON remain distinct");
    assert.equal(index.evidence().replayed, 5);
  } finally { index.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a failed exact index aborts and releases the active union without labelling it corrupt or opening later sources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-exact-union-refusal-"));
  const index = createLedgerExactDedupe(16_384);
  const unread: string[] = [], accepted: unknown[] = [];
  try {
    writeFileSync(join(dir, "ledger.2026-10-02T11-00-00-000Z.ndjson"),
      JSON.stringify({ step: "fixture", positive: true }) + "\n" + JSON.stringify({ step: "fixture", data: "x".repeat(100_000) }) + "\n");
    writeFileSync(join(dir, "ledger.ndjson"), JSON.stringify({ step: "later-must-not-run" }) + "\n");
    await assert.rejects(async () => { for await (const row of openLedgerUnion(dir, { exactDedupe: index,
      onUnreadArchive: path => unread.push(path) })) accepted.push(row); }, LedgerExactDedupeError);
    assert.deepEqual(accepted, [{ step: "fixture", positive: true }]); assert.deepEqual(unread, []);
    for (const opts of [{ dedupe: false }, { dedupeWindowPerStep: 1 }, { dedupeSeed: [] }])
      await assert.rejects(async () => { for await (const _row of openLedgerUnion(dir, { ...opts, exactDedupe: index })) void _row; }, TypeError);
  } finally { index.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("the existing daily collector reports actual dedupe exhaustion as incomplete trial evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-exact-daily-refusal-"));
  try {
    writeFileSync(join(dir, "ledger.ndjson"), [
      { ts: "2026-10-02T10:00:00Z", step: "fixture", positive: true },
      { ts: "2026-10-02T10:01:00Z", step: "fixture", data: "x".repeat(100_000) },
      { ts: "2026-10-02T10:02:00Z", step: "fixture", notObserved: true },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const { dailyRoutingReview } = await import(new URL("scripts/private-routing-daily-review.mjs", __workspaceRootUrl).href);
    const { snapshot } = await dailyRoutingReview({ sources: [{ label: "synthetic", stateDir: dir }],
      outDir: join(dir, "out"), asOf: "2026-10-02T14:00:00Z", dedupeMaxBytes: 16_384 });
    const source = snapshot.sources[0];
    assert.equal(source.state, "observed-partial"); assert.equal(source.rowsRead, 1);
    assert.ok(source.reasons.includes("ledger-dedupe-storage-bound"));
    assert.equal(source.retention.distinctScanComplete, false);
    assert.equal(source.retention.dedupeEvidence.accepted, 1);
    assert.ok(source.reports.every((report: { reviewState: string }) => report.reviewState === "source-incomplete"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("a real SQLite open refusal closes failed initialization and reports unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-exact-native-init-refusal-"));
  try {
    const module = new URL("src/lib/ledger-exact-dedupe.ts", __workspaceRootUrl).href;
    const code = `
      import fs from "node:fs";
      import { join } from "node:path";
      import { syncBuiltinESMExports } from "node:module";
      const original = fs.mkdtempSync;
      // Inject only the private scratch prerequisite. Native SQLite must really refuse
      // a directory at its database path; all database open/close and cleanup ports are real.
      fs.mkdtempSync = (...args) => { const directory = original(...args); fs.mkdirSync(join(directory,"seen.sqlite")); return directory; };
      syncBuiltinESMExports();
      const { createLedgerExactDedupe } = await import(${JSON.stringify(module)});
      try { const index = createLedgerExactDedupe(); index.close(); process.stdout.write(JSON.stringify({unexpectedSuccess:true})); }
      catch (error) { process.stdout.write(JSON.stringify({type:error.constructor.name,reason:error.reason,nativeCause:error.cause?.code ?? null,resourceEnvironment:{nodeOptions:process.env.NODE_OPTIONS ?? null,goMaxProcs:process.env.GOMAXPROCS ?? null,uvThreadpoolSize:process.env.UV_THREADPOOL_SIZE ?? null}})); }
      finally { fs.mkdtempSync = original; syncBuiltinESMExports(); }
    `;
    const result = spawnSync(process.execPath, ["--enable-source-maps", "--import", "tsx", "--input-type=module", "-e", code], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 65_536,
      // The loader cache must not share the directory whose product cleanup we measure.
      env: { PATH: "/usr/bin:/bin", TMPDIR: root, NODE_DISABLE_COMPILE_CACHE: "1", TSX_DISABLE_CACHE: "1",
        NODE_OPTIONS: process.env.NODE_OPTIONS, GOMAXPROCS: process.env.GOMAXPROCS, UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE },
    });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null); assert.equal(result.error, undefined);
    const actual = JSON.parse(result.stdout);
    assert.deepEqual(actual.resourceEnvironment, { nodeOptions: process.env.NODE_OPTIONS ?? null,
      goMaxProcs: process.env.GOMAXPROCS ?? null, uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? null },
      "the real refusal child keeps inherited resource policy while credentials stay absent");
    assert.equal(actual.type, "LedgerExactDedupeError");
    assert.equal(actual.reason, "ledger-dedupe-unavailable");
    assert.equal(actual.nativeCause, "ERR_SQLITE_ERROR", "the real native database refused its open");
    assert.deepEqual(readdirSync(root), [], "failed native initialization removed its private scratch directory");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a completed exact index never labels a damaged source scan complete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-exact-source-quality-"));
  try {
    writeFileSync(join(dir, "ledger.ndjson"), JSON.stringify({ ts: "2026-10-02T10:00:00Z", step: "fixture", positive: true })
      + '\n{"damaged":\n' + JSON.stringify({ ts: "2026-10-02T10:01:00Z", step: "fixture", positive: "later" }) + "\n");
    const { dailyRoutingReview } = await import(new URL("scripts/private-routing-daily-review.mjs", __workspaceRootUrl).href);
    const { snapshot } = await dailyRoutingReview({ sources: [{ label: "synthetic", stateDir: dir }],
      outDir: join(dir, "out"), asOf: "2026-10-02T14:00:00Z" });
    const source = snapshot.sources[0];
    assert.equal(source.rowsRead, 2); assert.equal(source.malformedRows, 1);
    assert.equal(source.retention.dedupeEvidence.complete, true);
    assert.equal(source.retention.distinctScanComplete, false);
    assert.equal(source.state, "observed-partial");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the exact dedupe error uses the shared envelope and preserves explicit cause and terminal reason", () => {
  const cause = new Error("native fixture cause");
  const error = new LedgerExactDedupeError("ledger-dedupe-unavailable", { cause });
  assert.ok(error instanceof Error); assert.ok(error instanceof RmdError);
  assert.equal(error.kind, "read-model"); assert.equal(error.reason, "ledger-dedupe-unavailable");
  assert.equal(error.message, "ledger-dedupe-unavailable"); assert.equal(exitCodeFor(error), 1);
  assert.equal(error.cause, cause);
  assert.equal(Object.hasOwn(new LedgerExactDedupeError("ledger-dedupe-storage-bound"), "cause"), false);
  assert.equal(Object.hasOwn(new LedgerExactDedupeError("ledger-dedupe-storage-bound", { cause: undefined }), "cause"), true);
});


test("a key larger than the complete SQLite budget refuses before UTF-16 allocation", t => {
  const index = createLedgerExactDedupe(16_384), oversized = "x".repeat(100_000);
  const original = Buffer.from;
  let utf16Allocations = 0;
  const intercepted = t.mock.method(Buffer, "from", ((...args: unknown[]) => {
    if (args[1] === "utf16le") {
      utf16Allocations++;
      if (args[0] === oversized) throw new Error("oversized synthetic key reached native buffer allocation");
    }
    return Reflect.apply(original, Buffer, args);
  }) as typeof Buffer.from);
  try {
    assert.equal(index.add("positive native allocation"), true);
    assert.equal(utf16Allocations, 1);
    assert.throws(() => index.add(oversized), error => error instanceof LedgerExactDedupeError
      && error.reason === "ledger-dedupe-storage-bound");
    assert.equal(utf16Allocations, 1, "the rejected key reached neither Buffer.from nor SQLite");
    assert.equal(index.evidence().accepted, 1);
    assert.equal(index.evidence().complete, false);
    assert.throws(() => index.add("positive native allocation"), LedgerExactDedupeError,
      "even a pre-allocation refusal seals the observer instead of silently resuming its scan");
  } finally { intercepted.mock.restore(); index.close(); }
});
