/**
 * A TEST RUN ON THE FLEET HOST TAKES A HOST-WIDE SLOT, AT LOW PRIORITY, WITH A BOUNDED CONCURRENCY.
 *
 * MEASURED 2026-10-06: an operator session's coverage run (7+ `node --test` processes) took the
 * 8-core host to load ~33 and review width collapsed to 1. Before src/lib/test-slot.ts the coverage
 * shards ran at Node's default cores−1 files at once, at normal priority, and the only lock was a
 * per-checkout one in a container-local /tmp. Every module import below is dynamic or a namespace
 * import, so at a base without test-slot.ts each test fails by its own assertion, not at load.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { PreflightSpawn } from "../src/lib/commit-message.js";
import * as ciParity from "../src/lib/ci-parity.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const testSlotModule = () => import("../src/lib/test-slot.js");

interface Call {
  file: string;
  args: string[];
  opts?: { env?: NodeJS.ProcessEnv };
}

/** The node argv inside a nice/ionice prefix — spelled here so this file loads at a base without test-slot.ts. */
function nodeArgv(call: Call): string[] {
  let rest = [call.file, ...call.args];
  if (/ionice$/.test(rest[0] ?? "") && rest[1] === "-c") rest = rest.slice(5);
  if (/nice$/.test(rest[0] ?? "") && rest[1] === "-n") rest = rest.slice(3);
  return rest;
}

function isShard(call: Call): boolean {
  return nodeArgv(call).includes("--experimental-test-coverage");
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-test-slot-checkout-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  copyFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), join(root, ".github", "workflows", "ci.yml"));
  return root;
}

function slotDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-test-slot-dir-"));
}

/** A fake spawn answering every child the coverage leaf starts; `onShard` runs inside each shard. */
function coverageSpawn(onShard: (call: Call, shard: number) => void = () => {}) {
  const calls: Call[] = [];
  const spawn: PreflightSpawn = (file, args, opts) => {
    const call = { file, args, opts };
    calls.push(call);
    if (args.some((a) => a.endsWith("scripts/test-tier-manifest.mjs")) && args.includes("--select-all")) {
      const shard = args[args.indexOf("--shard") + 1]!.split("/")[0];
      return { status: 0, stdout: `test/slot-shard-${shard}.test.ts\n`, stderr: "" };
    }
    if (isShard(call)) {
      const shard = Number(nodeArgv(call).find((a) => a.startsWith("test/slot-shard-"))!.match(/(\d+)/)![1]);
      onShard(call, shard);
      const rawDir = opts!.env!.NODE_V8_COVERAGE!;
      mkdirSync(rawDir, { recursive: true });
      writeFileSync(join(rawDir, `coverage-${shard}-0000000000000-0.json`), "{}\n");
      return { status: 0, stdout: "# tests 1\n# pass 1\n# fail 0\n", stderr: "" };
    }
    if (args.some((a) => a.endsWith("coverage-merge-ratchet.mjs"))) {
      if (args.includes("--compact-output")) {
        const dir = args[args.indexOf("--compact-output") + 1]!;
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "coverage-bundle-1-0000000000000-0.json"), "{}\n");
        return { status: 0, stdout: "rawBytes=10 compactBytes=5 peakBytes=15\n", stderr: "" };
      }
      return { status: 0, stdout: "inputBytes=20 stagingBytes=10 peakBytes=30\n", stderr: "" };
    }
    if (file === "git" && args[0] === "rev-parse") return { status: 0, stdout: `${PINNED_BASE_SHA}\n`, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, spawn };
}

function runCoverage(root: string, spawn: PreflightSpawn, testSlot: Record<string, unknown>, discriminator?: string) {
  return (ciParity.testWithCoverageLeaf as (...a: unknown[]) => { ok: boolean; detail: string })(
    root, spawn, join(root, "coverage", "lcov.info"), () => Number.MAX_SAFE_INTEGER, discriminator, testSlot,
  );
}

function cleanup(...paths: string[]): void {
  for (const path of paths) rmSync(path, { recursive: true, force: true });
}

const IDLE_8_CORES = () => ({ cores: 8, load1: 0 });
const NO_PRIORITY_BINARIES = () => false;

test("coverage shard argv carries an explicit --test-concurrency below the host core count", () => {
  const root = fixtureRoot();
  const dir = slotDir();
  const { calls, spawn } = coverageSpawn();
  try {
    // No memory reading: this pins the CPU-derived count (memory sizing is a-worker-test-run-is-sized-by-memory-headroom).
    const result = runCoverage(root, spawn, { dir, slots: 2, load: IDLE_8_CORES, memoryHeadroom: () => undefined, binaryExists: NO_PRIORITY_BINARIES, log: () => {} });
    assert.equal(result.ok, true, result.detail);
    const shards = calls.filter(isShard);
    assert.equal(shards.length, ciParity.CI_COVERAGE_SHARD_COUNT, "every coverage shard must be inspected");
    for (const shard of shards) {
      const argv = nodeArgv(shard);
      const flag = argv.find((a) => a.startsWith("--test-concurrency="));
      assert.ok(flag, `shard argv has no explicit --test-concurrency: ${argv.join(" ")}`);
      const n = Number(flag.split("=")[1]);
      assert.ok(n >= 1 && n < 8, `--test-concurrency=${n} must sit below the 8-core host`);
      assert.equal(n, 3, "an idle 8-core host with two slots grants each run (8−2)/2 = 3");
      assert.ok(argv.indexOf(flag) > argv.indexOf("--test"), "the flag rides after --test, before the files");
    }
  } finally {
    cleanup(root, dir, ciParity.coverageScratchDir(root));
  }
});

test("the coverage shard child is spawned under nice", () => {
  const root = fixtureRoot();
  const dir = slotDir();
  const { calls, spawn } = coverageSpawn();
  try {
    const onlyNice = (path: string) => path === "/usr/bin/nice";
    const result = runCoverage(root, spawn, { dir, load: IDLE_8_CORES, binaryExists: onlyNice, log: () => {} });
    assert.equal(result.ok, true, result.detail);
    const shards = calls.filter(isShard);
    assert.equal(shards.length, ciParity.CI_COVERAGE_SHARD_COUNT);
    for (const shard of shards) {
      assert.equal(shard.file, "/usr/bin/nice");
      assert.deepEqual(shard.args.slice(0, 3), ["-n", "10", process.execPath]);
    }
    const selectors = calls.filter((c) => c.args.includes("--select-all"));
    assert.ok(selectors.length > 0 && selectors.every((c) => c.file === process.execPath), "only the test children are niced");
  } finally {
    cleanup(root, dir, ciParity.coverageScratchDir(root));
  }
});

test("a second coverage run from another checkout waits for the host-wide test slot", () => {
  const rootA = fixtureRoot();
  const rootB = fixtureRoot();
  const dir = slotDir();
  const logsB: string[] = [];
  let sleeps = 0;
  let nowB = Date.parse("2026-10-06T20:00:00.000Z");
  const clockB = { now: () => nowB, date: () => new Date(nowB), iso: () => new Date(nowB).toISOString() };
  let resultB: { ok: boolean; detail: string } | undefined;
  const b = coverageSpawn();
  const a = coverageSpawn((_call, shard) => {
    if (shard !== 1) return;
    // Checkout B starts while A's first shard holds the only slot.
    resultB = runCoverage(rootB, b.spawn, {
      dir, slots: 1, load: IDLE_8_CORES, binaryExists: NO_PRIORITY_BINARIES, clock: clockB, waitBoundMs: 3 * 60_000,
      sleep: (ms: number) => { sleeps += 1; nowB += 60_000; assert.ok(ms > 0); },
      log: (line: string) => logsB.push(line),
    });
  });
  try {
    const resultA = runCoverage(rootA, a.spawn, { dir, slots: 1, load: IDLE_8_CORES, binaryExists: NO_PRIORITY_BINARIES, log: () => {} });
    assert.equal(resultA.ok, true, resultA.detail);
    assert.ok(resultB, "checkout B's run must have been attempted inside A's shard");
    assert.ok(sleeps >= 1, "B must WAIT while A holds the host-wide slot, not run beside it");
    const waiting = logsB.map((l) => JSON.parse(l)).find((e) => e.step === "test_slot.waiting");
    assert.ok(waiting, `B must say it waited: ${logsB.join("\n")}`);
    assert.match(waiting.holders.join(" "), new RegExp(`pid ${process.pid} on ${hostname().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "the wait names the holder");
    assert.equal(resultB.ok, true, resultB.detail);
    assert.match(resultB.detail, /WAIT BOUND EXCEEDED/);
    for (const shard of b.calls.filter(isShard)) {
      assert.ok(nodeArgv(shard).includes("--test-concurrency=1"), "past its bound B runs at concurrency 1");
    }
    assert.equal(readdirSync(dir).length, 0, "A releases its slot when its run ends");
  } finally {
    cleanup(rootA, rootB, dir, ciParity.coverageScratchDir(rootA), ciParity.coverageScratchDir(rootB));
  }
});

test("the host-wide test slot lives on the shared scratch mount, not the container /tmp", async () => {
  const { resolveTestSlotDir, TEST_SLOT_DIR_ENV } = await testSlotModule();
  const shared = "/home/node/rmd-scratch/test-slots";
  assert.deepEqual(resolveTestSlotDir({ [TEST_SLOT_DIR_ENV]: shared }), { dir: shared, scope: "configured" });
  assert.deepEqual(resolveTestSlotDir({}, (p) => p === "/mnt/scratch/rmd"), { dir: "/mnt/scratch/rmd/test-slots", scope: "host-scratch" });
  assert.deepEqual(resolveTestSlotDir({}, () => false), { dir: "/tmp/rmd-test-slots", scope: "local" }, "the narrower fallback names itself");
  const real = resolveTestSlotDir({});
  assert.ok(["host-scratch", "local"].includes(real.scope), "the real mount probe answers one of the two host rungs");
  const underTest = resolveTestSlotDir({ NODE_TEST_CONTEXT: "child" }, () => true);
  assert.equal(underTest.scope, "test-process");
  assert.notEqual(underTest.dir, "/mnt/scratch/rmd/test-slots", "a test process never borrows the shared host slot directory");
  assert.notEqual(underTest.dir, "/tmp/rmd-test-slots", "a test process never borrows the shared fallback slot directory");
  assert.ok(existsSync(underTest.dir), "test isolation is a real, private directory, even when TMPDIR is on scratch");

  // And the coverage run itself takes its slot THERE: the configured dir holds a record mid-shard.
  const root = fixtureRoot();
  const dir = slotDir();
  const saved = process.env[TEST_SLOT_DIR_ENV];
  process.env[TEST_SLOT_DIR_ENV] = dir;
  const seen: string[][] = [];
  const { spawn } = coverageSpawn(() => seen.push(readdirSync(dir)));
  try {
    const result = runCoverage(root, spawn, { load: IDLE_8_CORES, binaryExists: NO_PRIORITY_BINARIES, log: () => {} });
    assert.equal(result.ok, true, result.detail);
    assert.equal(seen.length, ciParity.CI_COVERAGE_SHARD_COUNT);
    for (const entries of seen) assert.ok(entries.some((e) => /^slot-\d+\.json$/.test(e)), "each shard runs holding a slot in the shared dir");
    assert.match(result.detail, new RegExp(`host-wide test slot 1/\\d+ \\(configured: ${dir}\\)`));
  } finally {
    if (saved === undefined) delete process.env[TEST_SLOT_DIR_ENV];
    else process.env[TEST_SLOT_DIR_ENV] = saved;
    cleanup(root, dir, ciParity.coverageScratchDir(root));
  }
});

test("test-slot isolation follows TMPDIR without sharing another test process's namespace", () => {
  const probe = `
    import { existsSync } from 'node:fs';
    import { resolveTestSlotDir } from './src/lib/test-slot.ts';
    const first = resolveTestSlotDir();
    console.log(JSON.stringify({ first, again: resolveTestSlotDir(), exists: existsSync(first.dir) }));
  `;
  for (const parent of new Set([tmpdir(), "/tmp"])) {
    const root = mkdtempSync(join(parent, "rmd-test-slot-tmpdir-"));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root, NODE_TEST_CONTEXT: "child" };
      delete env["RMD_TEST_SLOT_DIR"];
      delete env.NODE_OPTIONS;
      const read = () => JSON.parse(execFileSync(process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", probe], { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 30_000 }));
      const a = read(), b = read();
      for (const result of [a, b]) {
        assert.equal(result.first.scope, "test-process");
        assert.deepEqual(result.again, result.first, "one process keeps its own stable namespace");
        assert.equal(dirname(result.first.dir), root, "the caller's TMPDIR volume is preserved");
        assert.equal(result.exists, true, "the probe observes its real allocated directory");
      }
      assert.notEqual(a.first.dir, b.first.dir, "two processes sharing TMPDIR do not share slots");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function seedHolder(dir: string, holder: Record<string, unknown>): string {
  const path = join(dir, "slot-1.json");
  writeFileSync(path, JSON.stringify({ pid: 4242, host: "other-cell", startedAt: "2026-10-06T19:00:00.000Z", heartbeatAt: "2026-10-06T19:59:00.000Z", label: "seeded", ...holder }));
  return path;
}

test("a dead holder of the host-wide test slot is reclaimed and a live foreign one is waited on", async () => {
  const { acquireTestSlot, TEST_SLOT_LEASE_MS } = await testSlotModule();
  const now = Date.parse("2026-10-06T20:00:00.000Z");
  const clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const base = { slots: 1, clock, load: IDLE_8_CORES, hostname: () => "this-cell", bootId: () => "boot-1", isPidAlive: () => false, waitBoundMs: 0, log: () => {} };
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["same host, dead pid", { host: "this-cell", pid: 4242 }, "acquired"],
    ["another cell on an earlier kernel boot", { bootId: "boot-0" }, "acquired"],
    ["another cell whose lease lapsed", { bootId: "boot-1", heartbeatAt: new Date(now - TEST_SLOT_LEASE_MS - 1).toISOString() }, "acquired"],
    ["an unparseable record", { heartbeatAt: "not-a-time" }, "acquired"],
    ["a live foreign cell, same boot, fresh heartbeat", { bootId: "boot-1" }, "wait_bound_exceeded"],
  ];
  cases.push(["a truncated record", { truncated: true }, "acquired"]);
  for (const [name, holder, expected] of cases) {
    const dir = slotDir();
    try {
      const path = seedHolder(dir, holder);
      if (holder.truncated) writeFileSync(path, "{");
      const lease = acquireTestSlot("reclaim-case", { ...base, dir });
      assert.equal(lease.outcome, expected, name);
      if (expected === "acquired") {
        assert.equal(JSON.parse(readFileSync(path, "utf8")).label, "reclaim-case", `${name}: the slot now names its new holder`);
        lease.release();
        assert.equal(existsSync(path), false, `${name}: release removes the record`);
      } else {
        assert.equal(JSON.parse(readFileSync(path, "utf8")).label, "seeded", `${name}: a live holder's record is never removed`);
      }
    } finally {
      cleanup(dir);
    }
  }
});

test("a test-slot wait past its bound runs unslotted at concurrency 1 and says so", async () => {
  const { acquireTestSlot } = await testSlotModule();
  const dir = slotDir();
  let now = Date.parse("2026-10-06T20:00:00.000Z");
  const clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const logs: string[] = [];
  let sleeps = 0;
  try {
    seedHolder(dir, { bootId: "boot-1", heartbeatAt: new Date(now).toISOString() });
    const lease = acquireTestSlot("bound-case", {
      dir, slots: 1, clock, load: IDLE_8_CORES, hostname: () => "this-cell", bootId: () => "boot-1",
      waitBoundMs: 10 * 60_000, sleep: () => { sleeps += 1; now += 5 * 60_000; }, log: (l) => logs.push(l),
    });
    assert.equal(lease.outcome, "wait_bound_exceeded");
    assert.equal(lease.concurrency, 1);
    assert.equal(lease.waitedMs, 10 * 60_000);
    assert.equal(sleeps, 2, "it waited the bound, polling, before degrading");
    assert.match(lease.note, /WAIT BOUND EXCEEDED after 600s \(slot 1: pid 4242 on other-cell \(seeded\)\); ran UNSLOTTED at --test-concurrency=1/);
    assert.deepEqual(logs.map((l) => JSON.parse(l).step), ["test_slot.waiting", "test_slot.wait_bound_exceeded"]);
    lease.refresh();
    lease.release();
    assert.equal(existsSync(join(dir, "slot-1.json")), true, "an unslotted run never touches the holder it waited on");
  } finally {
    cleanup(dir);
  }
});

test("a waiter takes the slot the moment its holder releases, and says how long it waited", async () => {
  const { acquireTestSlot } = await testSlotModule();
  const dir = slotDir();
  let now = Date.parse("2026-10-06T20:00:00.000Z");
  const clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const logs: string[] = [];
  try {
    const path = seedHolder(dir, { bootId: "boot-1", heartbeatAt: new Date(now).toISOString() });
    const lease = acquireTestSlot("release-case", {
      dir, slots: 1, clock, load: IDLE_8_CORES, hostname: () => "this-cell", bootId: () => "boot-1", pid: 77,
      sleep: () => { now += 30_000; rmSync(path); }, log: (l) => logs.push(l),
    });
    assert.equal(lease.outcome, "acquired");
    assert.equal(lease.waitedMs, 30_000);
    assert.match(lease.note, /slot 1\/1 .*after waiting 30s; --test-concurrency=6, niced/);
    assert.deepEqual(logs.map((l) => JSON.parse(l).step), ["test_slot.waiting", "test_slot.acquired"]);
    now += 60_000;
    lease.refresh();
    assert.equal(JSON.parse(readFileSync(path, "utf8")).heartbeatAt, new Date(now).toISOString(), "refresh renews the lease");
    lease.release();
    lease.release();
    assert.equal(existsSync(path), false);
  } finally {
    cleanup(dir);
  }
});

test("an unusable slot directory runs unslotted at the load-derived concurrency and names why", async () => {
  const { acquireTestSlot } = await testSlotModule();
  const parent = slotDir();
  try {
    const file = join(parent, "a-file");
    writeFileSync(file, "");
    const underFile = acquireTestSlot("unusable", { dir: join(file, "slots"), load: () => ({ cores: 8, load1: 3 }), log: () => {} });
    assert.equal(underFile.outcome, "slot_unavailable");
    assert.equal(underFile.concurrency, 3, "8 cores − 2 headroom − 3 busy");
    assert.match(underFile.note, /test slot UNAVAILABLE .*ran unslotted at --test-concurrency=3/);

    const blocked = join(parent, "blocked");
    mkdirSync(join(blocked, "slot-1.json"), { recursive: true });
    const unreadable = acquireTestSlot("unusable", { dir: blocked, slots: 1, load: IDLE_8_CORES, log: () => {} });
    assert.equal(unreadable.outcome, "slot_unavailable", "a slot path that cannot be read as a record is not waited on forever");
  } finally {
    cleanup(parent);
  }
});

test("a release that cannot remove its record logs it and leaves the verdict alone", async () => {
  const { acquireTestSlot } = await testSlotModule();
  const dir = slotDir();
  const logs: string[] = [];
  try {
    const lease = acquireTestSlot("release-failure", { dir, slots: 1, load: IDLE_8_CORES, log: (l) => logs.push(l) });
    assert.equal(lease.outcome, "acquired");
    const path = join(dir, "slot-1.json");
    rmSync(path);
    mkdirSync(path);
    lease.release();
    assert.equal(JSON.parse(logs.at(-1)!).step, "test_slot.release_failed");
  } finally {
    cleanup(dir);
  }
});

test("test concurrency leaves headroom, shares cores across slots, and yields to existing load", async () => {
  const { testRunConcurrency, testRunArgv, defaultTestSlots, TEST_SLOTS_ENV, readHostLoad } = await testSlotModule();
  assert.equal(testRunConcurrency({ cores: 8, load1: 0 }), 6);
  assert.equal(testRunConcurrency({ cores: 8, load1: 0 }, 2), 3);
  assert.equal(testRunConcurrency({ cores: 8, load1: 33 }), 1, "the 2026-10-06 load ~33 gets one file at a time");
  assert.equal(testRunConcurrency({ cores: 8, load1: 4.9 }), 2);
  assert.equal(testRunConcurrency({ cores: 1, load1: 0 }), 1);
  assert.equal(testRunConcurrency({ cores: Number.NaN, load1: Number.NaN }), 1);
  assert.equal(defaultTestSlots(8, {}), 2);
  assert.equal(defaultTestSlots(2, {}), 1);
  assert.equal(defaultTestSlots(8, { [TEST_SLOTS_ENV]: "3" }), 3);
  assert.equal(defaultTestSlots(8, { [TEST_SLOTS_ENV]: "zero" }), 2);
  assert.deepEqual(testRunArgv(["--import", "tsx", "--test", "--test-concurrency=7", "a.test.ts"], 2), ["--import", "tsx", "--test", "--test-concurrency=2", "a.test.ts"]);
  assert.deepEqual(testRunArgv(["a.test.ts"], 0), ["--test-concurrency=1", "a.test.ts"]);
  const live = readHostLoad();
  assert.ok(live.cores >= 1 && live.load1 >= 0);
});

test("the priority wrapper uses ionice and nice where they exist and says when neither does", async () => {
  const { lowPriorityCommand, unwrapLowPriority } = await testSlotModule();
  const both = lowPriorityCommand("/node", ["--test"], (p) => p === "/usr/bin/ionice" || p === "/bin/nice");
  assert.deepEqual(both, { file: "/usr/bin/ionice", args: ["-c", "2", "-n", "7", "/bin/nice", "-n", "10", "/node", "--test"], priority: "nice+ionice" });
  assert.deepEqual(unwrapLowPriority(both.file, both.args), { file: "/node", args: ["--test"] });
  assert.deepEqual(lowPriorityCommand("/node", ["--test"], () => false), { file: "/node", args: ["--test"], priority: "none" });
  assert.deepEqual(unwrapLowPriority("/node", ["--test"]), { file: "/node", args: ["--test"] });
  assert.ok(["nice", "nice+ionice", "none"].includes(lowPriorityCommand("/node", []).priority), "the real host probe answers");
});

test("the boot id and the real sleep are read from the host, and an absent /proc is not an error", async () => {
  const { readBootId, acquireTestSlot } = await testSlotModule();
  const dir = slotDir();
  try {
    assert.equal(readBootId(join(dir, "no-such-boot-id")), undefined);
    writeFileSync(join(dir, "boot_id"), "abc-123\n");
    assert.equal(readBootId(join(dir, "boot_id")), "abc-123");
    seedHolder(dir, { host: "other-cell", heartbeatAt: new Date().toISOString() });
    const lease = acquireTestSlot("real-sleep", { dir, slots: 1, load: IDLE_8_CORES, waitBoundMs: 1, pollMs: 1, log: () => {} });
    assert.equal(lease.outcome, "wait_bound_exceeded", "the default sleep and clock carry a real bounded wait");
  } finally {
    cleanup(dir);
  }
});
