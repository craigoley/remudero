import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { coverageGateLockDir, coverageScratchDir, testWithCoverageLeaf } from "../src/lib/ci-parity.js";
import type { PreflightSpawn } from "../src/lib/commit-message.js";

function fixture() {
  const root = mkdtempSync("/tmp/rmd-coverage-holder-");
  const lock = coverageGateLockDir(root);
  const scratch = coverageScratchDir(root);
  const holderPath = join(lock, "holder.json");
  const lcov = join(root, "coverage", "lcov.info");
  return {
    root, lock, scratch, holderPath, lcov,
    run: (spawn: PreflightSpawn) => testWithCoverageLeaf(root, spawn, lcov, () => Number.MAX_SAFE_INTEGER),
    hold: (pid: number, recordedScratch = scratch, host = hostname()) => {
      mkdirSync(lock);
      writeFileSync(holderPath, JSON.stringify({ pid, host, startedAt: new Date().toISOString(), scratch: recordedScratch }));
    },
    cleanup: () => {
      rmSync(lock, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function killedPid() {
  const child = spawnSync(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);
  assert.equal(child.signal, "SIGKILL");
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  return child.pid;
}

function successfulCoverage(observe: () => void): PreflightSpawn {
  return (_file, args, opts) => {
    observe();
    if (args.includes("--select-all")) return { status: 0, stdout: "test/fixture.test.ts\n", stderr: "" };
    if (args.includes("--experimental-test-coverage")) {
      const raw = opts?.env?.NODE_V8_COVERAGE;
      assert.ok(raw);
      writeFileSync(join(raw, "coverage-1-0000000000000-0.json"), "{}\n");
      return { status: 0, stdout: "# tests 1\n# pass 1\n# fail 0\n", stderr: "" };
    }
    if (args.includes("--compact-output")) {
      const compact = args[args.indexOf("--compact-output") + 1];
      mkdirSync(compact, { recursive: true });
      writeFileSync(join(compact, "coverage-1-0000000000000-0.json"), "{}\n");
      return { status: 0, stdout: "rawBytes=2 compactBytes=2 peakBytes=4", stderr: "" };
    }
    if (args.includes("--output")) return { status: 0, stdout: "inputBytes=8 stagingBytes=0 peakBytes=8", stderr: "" };
    return { status: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n", stderr: "" };
  };
}

test("test/a-coverage-lock-names-its-holder-and-a-later-run-reclaims-it.test.ts: dead holder and recorded scratch are reclaimed and live pid is refused", () => {
  const f = fixture();
  const stranded = mkdtempSync("/tmp/rmd-stranded-");
  const oldScratch = join(stranded, "rmd-c-012345abcdef");
  mkdirSync(oldScratch);
  writeFileSync(join(oldScratch, "old-coverage"), "stranded");
  try {
    f.hold(killedPid(), oldScratch);
    let calls = 0;
    const result = f.run(successfulCoverage(() => {
      calls++;
      assert.equal(existsSync(oldScratch), false);
      const holder = JSON.parse(readFileSync(f.holderPath, "utf8"));
      assert.equal(holder.pid, process.pid);
      assert.equal(holder.host, hostname());
      assert.ok(Number.isFinite(Date.parse(holder.startedAt)));
      assert.equal(holder.scratch, f.scratch);
    }));
    assert.equal(result.ok, true, result.detail);
    assert.ok(calls > 0);
    assert.equal(existsSync(f.lock), false);
    assert.equal(existsSync(f.scratch), false);

    mkdirSync(f.scratch);
    writeFileSync(join(f.scratch, "live-coverage"), "preserve");
    f.hold(process.pid);
    const raw = readFileSync(f.holderPath, "utf8");
    const live = f.run(() => { assert.fail("live holder must prevent shard execution"); });
    assert.equal(live.ok, false);
    assert.ok(live.detail.includes(`pid ${process.pid}`), live.detail);
    assert.equal(readFileSync(f.holderPath, "utf8"), raw);
    assert.equal(readFileSync(join(f.scratch, "live-coverage"), "utf8"), "preserve");
  } finally {
    f.cleanup();
    rmSync(stranded, { recursive: true, force: true });
  }
});

test("coverage reclamation preserves scratch with an unsafe basename", () => {
  const f = fixture();
  const unsafe = join(f.root, "keep");
  mkdirSync(unsafe);
  writeFileSync(join(unsafe, "marker"), "preserve");
  try {
    f.hold(killedPid(), unsafe);
    const result = f.run(successfulCoverage(() => {
      assert.equal(readFileSync(join(unsafe, "marker"), "utf8"), "preserve");
    }));
    assert.equal(result.ok, true, result.detail);
    assert.equal(readFileSync(join(unsafe, "marker"), "utf8"), "preserve");
  } finally { f.cleanup(); }
});

for (const raw of [undefined, "{", "{}", JSON.stringify({ pid: 0, host: hostname(), startedAt: new Date().toISOString(), scratch: "/tmp/rmd-c-012345abcdef" })]) {
  test(`coverage refuses an unattributed lock (${String(raw)}) without removing it`, () => {
    const f = fixture();
    mkdirSync(f.lock);
    if (raw !== undefined) writeFileSync(f.holderPath, raw);
    try {
      const result = f.run(() => { assert.fail("unattributed lock must prevent shard execution"); });
      assert.equal(result.ok, false);
      assert.match(result.detail, /unattributed/);
      assert.equal(existsSync(f.lock), true);
      if (raw !== undefined) assert.equal(readFileSync(f.holderPath, "utf8"), raw);
    } finally { f.cleanup(); }
  });
}

test("coverage refuses an unprobeable foreign holder naming its pid", () => {
  const f = fixture();
  try {
    const pid = killedPid();
    f.hold(pid, f.scratch, "other-coverage-host");
    const result = f.run(() => { assert.fail("foreign holder must prevent shard execution"); });
    assert.equal(result.ok, false);
    assert.ok(result.detail.includes(`pid ${pid}`), result.detail);
    assert.equal(existsSync(f.holderPath), true);
  } finally { f.cleanup(); }
});

test("coverage acquisition reports filesystem failure without starting shards", () => {
  const f = fixture();
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = ((path: Parameters<typeof mkdir>[0], options: Parameters<typeof mkdir>[1]) => {
    if (String(path) === f.lock) throw Object.assign(new Error("coverage lock permission denied"), { code: "EACCES" });
    return mkdir(path, options);
  }) as typeof mkdir;
  syncBuiltinESMExports();
  try {
    const result = f.run(() => { assert.fail("failed acquisition must prevent shard execution"); });
    assert.equal(result.ok, false);
    assert.match(result.detail, /cannot acquire.*coverage lock permission denied/);
    assert.equal(existsSync(f.lock), false);
  } finally {
    fs.mkdirSync = mkdir;
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test("coverage retries acquisition only once and preserves the competing live holder", () => {
  const f = fixture();
  f.hold(killedPid());
  const mkdir = fs.mkdirSync;
  let acquisitions = 0;
  fs.mkdirSync = ((path: Parameters<typeof mkdir>[0], options: Parameters<typeof mkdir>[1]) => {
    if (String(path) === f.lock && ++acquisitions === 2) {
      mkdir(f.lock);
      writeFileSync(f.holderPath, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), scratch: f.scratch }));
    }
    return mkdir(path, options);
  }) as typeof mkdir;
  syncBuiltinESMExports();
  try {
    const result = f.run(() => { assert.fail("lost retry must prevent shard execution"); });
    assert.equal(result.ok, false);
    assert.match(result.detail, /unreclaimable.*EEXIST/);
    assert.equal(acquisitions, 2);
    assert.equal(JSON.parse(readFileSync(f.holderPath, "utf8")).pid, process.pid);
  } finally {
    fs.mkdirSync = mkdir;
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test("coverage releases its recorded lock and scratch when shard execution throws", () => {
  const f = fixture();
  try {
    const spawn = successfulCoverage(() => {});
    assert.throws(() => f.run((file, args, opts) => {
      assert.equal(JSON.parse(readFileSync(f.holderPath, "utf8")).pid, process.pid);
      if (args.includes("--experimental-test-coverage")) throw new Error("coverage spawn failed");
      return spawn(file, args, opts);
    }), /coverage spawn failed/);
    assert.equal(existsSync(f.lock), false);
    assert.equal(existsSync(f.scratch), false);
  } finally { f.cleanup(); }
});

test("failed nested holder publication preserves the outer scratch", () => {
  const f = fixture();
  mkdirSync(f.scratch);
  const marker = join(f.scratch, "outer-coverage");
  writeFileSync(marker, "preserve");
  const previousTmp = process.env.TMPDIR;
  const write = fs.writeFileSync;
  process.env.TMPDIR = f.scratch;
  fs.writeFileSync = ((...args: Parameters<typeof write>) => {
    if (String(args[0]) === f.holderPath) throw new Error("holder publication failed");
    return write(...args);
  }) as typeof write;
  syncBuiltinESMExports();
  try {
    assert.throws(() => f.run(() => { assert.fail("unpublished holder must prevent shard execution"); }), /holder publication failed/);
    assert.equal(readFileSync(marker, "utf8"), "preserve");
    assert.equal(existsSync(f.lock), false);
  } finally {
    fs.writeFileSync = write;
    syncBuiltinESMExports();
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    f.cleanup();
  }
});
