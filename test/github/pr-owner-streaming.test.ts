import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { prOwnerCommand, fixBranchClaimKey } from "#src/run-task.js";
import { readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";

type Row = Record<string, unknown>;
const ts = "2026-10-21T23:00:00.000Z";
const plainName = "ledger.2026-10-21T00-00-00-000Z.ndjson";
const gzipName = "ledger.2026-10-21T00-01-00-000Z.ndjson.gz";
const text = (rows: Row[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const sweep = (fields: Row = {}): Row => ({ ts, step: "sweep.disposed", pr_number: 44, task_id: "T", head_sha: "H", disposition: "wait", ...fields });
const fix = (fields: Row = {}): Row => ({ ts, step: "fix.dispatch", task_id: "T", head_sha: "H", ...fields });
function corpus(rows: Row[], live: Row[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-owner-stream-test-"));
  writeFileSync(join(dir, plainName), "");
  writeFileSync(join(dir, gzipName), gzipSync(text(rows)));
  writeFileSync(join(dir, "ledger.ndjson"), text(live));
  return dir;
}
async function command(dir: string, oldReader = false): Promise<string> {
  let output = "";
  assert.equal(await prOwnerCommand(["44"], {
    stateDir: dir, write: (value) => { output = value; },
    ...(oldReader ? { readLedger: (path: string) => readLedgerUnionRecordsSync(path, { requireArchives: true, refuseIncomplete: true }) } : {}),
  }), 0);
  return output;
}

for (const [name, rows, live] of [
  ["legacy fix before later task association", [fix()], [sweep()]],
  ["all historical heads and historical fixes remain evidence", [fix({ ts: "2026-10-20", head_sha: "old" }), sweep({ head_sha: "old" })], [sweep({ disposition: "merged", head_sha: "new" })]],
  ["wrong head and SWEEP task do not join", [fix({ head_sha: "wrong" }), fix({ task_id: "SWEEP" }), sweep({ task_id: "SWEEP" })], [sweep()]],
  ["missing head joins while explicit empty head does not", [fix({ head_sha: undefined }), fix({ head_sha: "", run_id: "excluded" })], [sweep()]],
  ["empty target head set admits legacy fix head", [fix({ head_sha: "any" })], [sweep({ head_sha: "" })]],
  ["invalid timestamps still contribute task and head associations", [fix()], [sweep({ ts: "not a date" })]],
  ["numeric PR number takes precedence over conflicting URL", [fix({ pr_number: 99, pr_url: "https://github.com/a/b/pull/44", task_id: "other" })], [sweep({ disposition: "merged" })]],
  ["URL PR evidence works without numeric field", [fix({ pr_url: "https://github.com/a/b/pull/44?x=y", task_id: "other" })], []],
  ["equal timestamp replay must not replace later distinct sweep", [sweep(), sweep({ disposition: "merged" })], [sweep()]],
  ["distinct raw payload remains a genuine later tie", [sweep(), sweep({ disposition: "merged" })], [sweep({ extra: "distinct" })]],
  ["global newest equal-date spellings preserve first distinct replay ordering", [{ ts, step: "other", n: 1 }, { ts: "2026-10-21T19:00:00-04:00", step: "other", n: 2 }], [{ ts, step: "other", n: 1 }]],
] as [string, Row[], Row[]][]) {
  test(`pr-owner streaming agrees with complete union: ${name}`, async () => {
    const dir = corpus(rows, live);
    try { assert.equal(await command(dir), await command(dir, true)); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("pr-owner streaming joins claims from every eligible fix, including invalid-time rows", async () => {
  const dir = corpus([fix({ ts: "invalid", task_id: "claim-only", pr_number: 44 }), fix({ task_id: "newer", pr_number: 44 })], [sweep({ disposition: "merged" })]);
  try {
    mkdirSync(join(dir, "inflight"));
    const key = fixBranchClaimKey("acme", "remudero", "run-claim-only-123");
    writeFileSync(join(dir, "inflight", `${key}.lock`), JSON.stringify({ pid: process.pid, run_id: "live-claim", startedAt: new Date().toISOString() }));
    const actual = await command(dir);
    assert.match(actual, /live fix branch claim/);
    assert.equal(actual, await command(dir, true));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pr-owner pins the live prefix before archives, retaining its task join across rotation", async () => {
  const dir = corpus([fix()], [sweep()]);
  try {
    const { readPrOwnerLedgerProjection } = await import("#src/lib/pr-owner-ledger.js");
    const pending = readPrOwnerLedgerProjection(dir, 44, () => []);
    renameSync(join(dir, "ledger.ndjson"), join(dir, "ledger.2026-10-21T00-02-00-000Z.ndjson"));
    writeFileSync(join(dir, "ledger.ndjson"), text([sweep({ task_id: "replacement", head_sha: "replacement", disposition: "merged" })]));
    const got = await pending;
    assert.equal(got.ok, true);
    assert.equal(got.latestFix?.task_id, "T");
    assert.equal(got.latestSweep?.disposition, "wait");
    assert.equal(got.archiveFiles.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pr-owner ordinary live growth stays outside its pinned prefix without becoming UNKNOWN", async () => {
  const dir = corpus([fix()], [sweep()]);
  try {
    const { readPrOwnerLedgerProjection } = await import("#src/lib/pr-owner-ledger.js");
    const pending = readPrOwnerLedgerProjection(dir, 44, () => []);
    appendFileSync(join(dir, "ledger.ndjson"), text([sweep({ ts: "2026-10-22", disposition: "merged" })]));
    const got = await pending;
    assert.equal(got.ok, true);
    assert.equal(got.corpusNewestTs, ts);
    assert.equal(got.latestSweep?.disposition, "wait");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pr-owner refuses a truncated pinned live prefix instead of reporting FREE", async () => {
  const dir = corpus([], [sweep()]);
  try {
    const { readPrOwnerLedgerProjection } = await import("#src/lib/pr-owner-ledger.js");
    const pending = readPrOwnerLedgerProjection(dir, 44, () => []);
    truncateSync(join(dir, "ledger.ndjson"), 0);
    const got = await pending;
    assert.equal(got.ok, false);
    assert.ok(got.unread.includes(join(dir, "ledger.ndjson")));
    assert.equal(got.latestSweep, undefined);
    assert.equal(got.corpusNewestTs, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pr-owner strict unread archives and live errors match the original UNKNOWN posture", async () => {
  const dir = corpus([], []);
  try {
    writeFileSync(join(dir, gzipName), "not gzip");
    assert.equal(await command(dir), await command(dir, true));
    writeFileSync(join(dir, gzipName), gzipSync(text([])));
    rmSync(join(dir, "ledger.ndjson"));
    mkdirSync(join(dir, "ledger.ndjson"));
    assert.equal(await command(dir), await command(dir, true));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pr-owner removes private projection scratch after successful reads and scratch failures are UNKNOWN", async () => {
  const dir = corpus([sweep()]);
  const scratchRoot = mkdtempSync(join(tmpdir(), "rmd-owner-scratch-test-"));
  const before = process.env.TMPDIR;
  try {
    process.env.TMPDIR = scratchRoot;
    assert.match(await command(dir), /OWNED/);
    assert.deepEqual((await import("node:fs")).readdirSync(scratchRoot), []);
    const blocked = join(scratchRoot, "file");
    writeFileSync(blocked, "not a directory");
    process.env.TMPDIR = blocked;
    assert.match(await command(dir), /UNKNOWN/);
    assert.equal(readFileSync(blocked, "utf8"), "not a directory");
  } finally {
    if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before;
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test("pr-owner default streams gzip and live content without whole-file reads or synchronous expansion", async () => {
  const fs = (await import("node:fs")).default;
  const zlib = (await import("node:zlib")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const originalRead = fs.readFileSync;
  const originalGunzip = zlib.gunzipSync;
  const dir = corpus([fix()], [sweep()]);
  let forbiddenCalls = 0;
  try {
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      const [path] = args;
      if (String(path).includes("ledger.") && /\.(ndjson|gz)$/.test(String(path))) {
        forbiddenCalls += 1;
        throw new Error("whole ledger file read forbidden by streaming control");
      }
      return originalRead(...args);
    }) as typeof fs.readFileSync;
    zlib.gunzipSync = (() => { forbiddenCalls += 1; throw new Error("whole gzip expansion forbidden by streaming control"); }) as typeof zlib.gunzipSync;
    syncBuiltinESMExports();
    assert.match(await command(dir), /OWNED/);
    assert.equal(forbiddenCalls, 0);
  } finally {
    fs.readFileSync = originalRead;
    zlib.gunzipSync = originalGunzip;
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pr-owner distinguishes an unopenable pinned live path from an absent live file", async () => {
  const dir = corpus([]);
  try {
    rmSync(join(dir, "ledger.ndjson"));
    symlinkSync("ledger.ndjson", join(dir, "ledger.ndjson"));
    const output = await command(dir);
    assert.match(output, /UNKNOWN/);
    assert.match(output, /ledger union incomplete/);
    assert.doesNotMatch(output, /FREE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pr-owner refuses an actual projection statement failure and releases its disk scratch", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { readPrOwnerLedgerProjection } = await import("#src/lib/pr-owner-ledger.js");
  const probe = new DatabaseSync(":memory:");
  const statement = probe.prepare("SELECT 1");
  const prototype = Object.getPrototypeOf(statement) as typeof statement;
  const original = prototype.run;
  const dir = corpus([fix()], [sweep()]);
  const scratchRoot = mkdtempSync(join(tmpdir(), "rmd-owner-sql-fault-"));
  const previousTmp = process.env.TMPDIR;
  let faults = 0;
  try {
    process.env.TMPDIR = scratchRoot;
    prototype.run = function (this: typeof statement, ...args: Parameters<typeof original>) {
      if (this.sourceSQL.startsWith("INSERT OR IGNORE INTO evidence")) {
        faults += 1;
        throw new Error("fixture projection evidence write failed");
      }
      return original.apply(this, args);
    } as typeof original;
    const got = await readPrOwnerLedgerProjection(dir, 44, () => []);
    assert.ok(faults > 0);
    assert.equal(got.ok, false);
    assert.equal(got.latestFix, undefined);
    assert.equal(got.corpusNewestTs, undefined);
    assert.ok(got.unread.some((error) => error.includes("fixture projection evidence write failed")));
    assert.deepEqual((await import("node:fs")).readdirSync(scratchRoot), []);
  } finally {
    prototype.run = original;
    probe.close();
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});
