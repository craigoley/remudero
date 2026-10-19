import assert from "node:assert/strict";
import fs, { chmodSync, mkdirSync, readFileSync, renameSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import * as metrics from "#src/lib/gate-sandbox-metrics.js";
import * as preopen from "#src/lib/preopen-gate.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const diskMount = "44 20 8:2 /rmd-proof-home-fixture/.rmd-private-tmp /tmp rw - ext4 /dev/fixture rw\n";
const tmpfsMount = "40 20 0:44 / /tmp rw - tmpfs tmpfs rw\n";
const diskStat = { type: 0xef53n, blocks: 2n ** 30n, bfree: 1n, bsize: 4096n };
const fileScope = "boundary-sampled-logical-file-bytes" as const;
const usage = () => ({ maxRSS: 3, userCPUTime: 4000, systemCPUTime: 500 });
const cache = () => ({ files: 0, bytes: 0 });

test("private disk tmp measurements name tree bytes instead of the whole filesystem", () => {
  let reads = 0;
  const sample = metrics.privateTmpSample("/tmp", () => tmpfsMount + diskMount, () => diskStat as never, () => { reads++; return 8; });
  assert.deepEqual(sample, { bytes: 8, scope: fileScope });
  assert.equal(reads, 1, "only one bounded private-tree sample is requested");
  assert.notEqual(sample.bytes, Number((diskStat.blocks - diskStat.bfree) * diskStat.bsize));
  const legacy = metrics.privateTmpSample("/tmp", () => tmpfsMount, () => ({ type: 0x01021994n, blocks: 10n, bfree: 4n, bsize: 1024n }) as never);
  assert.deepEqual(legacy, { bytes: 6144, scope: "boundary-sampled" });
});

test("private disk tmp byte scope survives the actual preopen transport", () => {
  const samples = [8, 32, 16];
  const sampler = metrics.createGateSandboxMetrics({ tmp: () => ({ bytes: samples.shift()!, scope: fileScope }), cache, usage });
  assert.equal(sampler.observe(() => "same gate result"), "same gate result");
  const result = sampler.finish();
  assert.ok("sandbox" in result, JSON.stringify(result));
  assert.equal(result.sandbox.tmp_peak_bytes, 32);
  assert.equal(result.sandbox.tmp_peak_scope, fileScope);
  assert.deepEqual(metrics.parseGateSandboxMeasurement(result), result);
  assert.deepEqual(preopen.preopenGateLedgerFields({ kind: "pass", durationMs: 1, sandboxMetrics: result }).sandbox, result.sandbox);
  assert.ok("sandbox_unmeasured" in metrics.parseGateSandboxMeasurement({ sandbox: { ...result.sandbox, tmp_peak_scope: "whole-volume" } }));
});

test("private disk tmp mounts precede the preopen harness binds", () => {
  const tail = ["--dir", "/home", "--dir", "/home/runner", "--bind", "/checkout", "/checkout", "--chdir", "/checkout", "--"];
  const disk = ["--unshare-net", "--bind", "/owned-home/.rmd-private-tmp", "/tmp", ...tail];
  const tmpfs = ["--unshare-net", "--tmpfs", "/tmp", ...tail];
  assert.equal(disk[preopen.preopenSandboxBindStart(disk)], "--bind");
  assert.equal(preopen.preopenSandboxBindStart(disk), 8);
  assert.equal(preopen.preopenSandboxBindStart(tmpfs), 7);
  assert.throws(() => preopen.preopenSandboxBindStart(["--chdir", "/checkout", "--"]), /no private \/tmp mount/);
});

test("private disk tmp partial readings and changing byte bases never become zero", () => {
  assert.throws(() => metrics.privateTmpSample("/tmp", () => diskMount, () => diskStat as never, () => { throw Error("private tree over budget"); }), /over budget/);
  const unreadable = metrics.createGateSandboxMetrics({ tmp: () => { throw Error("private tree unreadable"); }, cache, usage }).finish();
  assert.deepEqual(unreadable, { sandbox_unmeasured: "private tree unreadable" });
  let first = true;
  const changing = metrics.createGateSandboxMetrics({ tmp: () => {
    const scope = first ? fileScope : "boundary-sampled";
    first = false;
    return { bytes: 8, scope };
  }, cache, usage }).finish();
  assert.ok("sandbox_unmeasured" in changing);
  assert.match(changing.sandbox_unmeasured, /scope|basis/);
  const invalid = metrics.createGateSandboxMetrics({ tmp: () => ({ bytes: NaN, scope: fileScope }), cache, usage }).finish();
  assert.ok("sandbox_unmeasured" in invalid);
});

test("private disk tmp refuses shared mounts, whole volumes and RAM-backed lookalikes", () => {
  let read = false;
  for (const mount of [diskMount.replace("rw -", "rw shared:9 -"), diskMount.replace("/rmd-proof-home-fixture/.rmd-private-tmp", "/"), diskMount.replace("ext4 /dev/fixture", "ramfs ramfs")]) {
    assert.throws(() => metrics.privateTmpSample("/tmp", () => mount, () => diskStat as never, () => { read = true; return 0; }), /private|disk|tmpfs/);
  }
  for (const type of [0x01021994n, 0x858458f6n]) {
    assert.throws(() => metrics.privateTmpSample("/tmp", () => diskMount, () => ({ ...diskStat, type }) as never, () => { read = true; return 0; }), /disk|tmpfs|RAM/);
  }
  assert.equal(read, false, "an invalid mount is refused before traversing it");
});

test("the real private disk tree reader is bounded, private and read-only", (t) => {
  const { dir } = ownedFixtureDir(t, "disk-tmp-metrics");
  if (process.platform !== "linux") {
    assert.throws(() => metrics.privateDiskTmpBytes(dir), /requires Linux/);
    t.diagnostic("Linux descriptor-backed positive cases require Linux; no disk-byte count fabricated on this host");
    return;
  }
  if ([0x01021994n, 0x858458f6n].includes(statfsSync(dir, { bigint: true }).type)) {
    assert.throws(() => metrics.privateDiskTmpBytes(dir), /disk|RAM/);
    t.diagnostic("fixture is RAM-backed in this outer sandbox; the real disk reader correctly refuses it");
    return;
  }
  const root = join(dir, "private");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "one"), "abc");
  writeFileSync(join(root, "nested", "two"), "12345");
  const started = performance.now();
  assert.equal(metrics.privateDiskTmpBytes(root), 8);
  t.diagnostic(`real bounded private-tree read: ${Math.round(performance.now() - started)} ms, two files/eight logical bytes`);
  assert.equal(readFileSync(join(root, "one"), "utf8"), "abc");
  assert.throws(() => metrics.privateDiskTmpBytes(root, 0), /budget/);
  let clock = 0;
  assert.throws(() => metrics.privateDiskTmpBytes(root, 100, () => clock++ * 101), /budget/);
  chmodSync(root, 0o777);
  assert.throws(() => metrics.privateDiskTmpBytes(root), /private/);
  chmodSync(root, 0o700);
  symlinkSync(root, join(dir, "link"));
  assert.throws(() => metrics.privateDiskTmpBytes(join(dir, "link")), /ELOOP|ENOTDIR/);
  assert.throws(() => metrics.privateDiskTmpBytes(join(dir, "absent")), /ENOENT/);
});

test("private disk tmp enumeration retains its opened root during replacement", (t) => {
  const { dir } = ownedFixtureDir(t, "disk-tmp-root");
  if (process.platform !== "linux") {
    assert.throws(() => metrics.privateDiskTmpBytes(dir), /requires Linux/);
    t.diagnostic("real unsupported-platform refusal verified; Linux descriptor replacement is not exercised here");
    return;
  }
  if ([0x01021994n, 0x858458f6n].includes(statfsSync(dir, { bigint: true }).type)) {
    assert.throws(() => metrics.privateDiskTmpBytes(dir), /disk|RAM/);
    t.diagnostic("real RAM-backed refusal verified; disk descriptor replacement is not exercised here");
    return;
  }
  const root = join(dir, "private"), other = join(dir, "outside");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(other, { mode: 0o700 });
  writeFileSync(join(root, "one"), "abc");
  writeFileSync(join(other, "other"), "x".repeat(100));
  const inode = fs.lstatSync(root).ino, original = fs.fstatSync;
  let replaced = false;
  try {
    t.mock.method(fs, "fstatSync", ((...args: Parameters<typeof fs.fstatSync>) => {
      const stat = original(...args) as fs.Stats;
      if (!replaced && stat.isDirectory() && stat.ino === inode) {
        replaced = true;
        renameSync(root, join(dir, "moved"));
        symlinkSync(other, root);
      }
      return stat;
    }) as typeof fs.fstatSync);
    syncBuiltinESMExports();
    assert.equal(metrics.privateDiskTmpBytes(root), 3);
    assert.equal(replaced, true, "the real descriptor is pinned before its pathname changes");
    assert.equal(readFileSync(join(other, "other"), "utf8"), "x".repeat(100));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
