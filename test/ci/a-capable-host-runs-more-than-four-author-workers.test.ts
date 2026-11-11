import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

// @ts-expect-error This JavaScript CLI module has no declaration file; the test covers its runtime exports.
import * as author from "#scripts/preflight-author.mjs";
// @ts-expect-error This JavaScript CLI module has no declaration file; the test covers its runtime exports.
import { calibrateAuthorRuntime } from "#scripts/calibrate-author-runtime.mjs";
// @ts-expect-error This JavaScript module has no declaration file; the test covers its runtime exports.
import { readRuntimeProfile, runtimeBindings, runtimeDeadlineFit } from "#scripts/lib/native-author-runtime.mjs";
import { acquireTestSlot, readMemoryHeadroom } from "#src/lib/test-slot.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const GiB = 1024 ** 3;
const SUITE = "test/leaf.test.ts";
const enoent = (path: string): string => {
  throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
};
/** A darwin `vm_stat` report whose free pages alone are `bytes`. */
const vmStatReport = (bytes: number): string =>
  `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: ${bytes / 16384}.\n` +
  "Pages active: 1000.\nPages inactive: 0.\nPages speculative: 0.\n";
/** A Linux host: /proc/meminfo plus a bounded cgroup v2 whose room is `bytes` (the smaller reading). */
const linuxFiles = (bytes: number) => (path: string): string => {
  if (path === "/proc/meminfo") return `MemAvailable: ${(bytes * 2) / 1024} kB\n`;
  if (path === "/sys/fs/cgroup/memory.current") return `${GiB}\n`;
  if (path === "/sys/fs/cgroup/memory.max") return `${bytes + GiB}\n`;
  if (path === "/sys/fs/cgroup/memory.high") return "max\n";
  return enoent(path);
};

type Host = { platform: "linux" | "darwin"; cores: number; load1: number; files: (path: string) => string; vmStat?: () => string | undefined };
const linuxHost = (cores: number, load1: number, bytes: number): Host =>
  ({ platform: "linux", cores, load1, files: linuxFiles(bytes) });
const darwinHost = (cores: number, load1: number, report: string | undefined): Host =>
  ({ platform: "darwin", cores, load1, files: enoent, vmStat: () => report });
/** The production reader, driven through its injected seams. */
const readHost = (h: Host) => author.readHostCapacityInputs({ platform: h.platform, vmStat: h.vmStat ?? (() => undefined),
  readFile: h.files, load: () => ({ cores: h.cores, load1: h.load1 }) });

function authorFixture(t: TestContext) {
  const repo = gitRepo({ kind: "w1-t11891-author", seedCommit: false });
  t.after(() => repo.cleanup());
  const root = repo.dir;
  for (const path of ["test/setup", "src", "scripts", "coverage"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, ".nvmrc"), `${process.versions.node}\n`);
  writeFileSync(join(root, ".gitignore"), "node_modules\ncoverage\n");
  const dependencyDonor = dirname(dirname(dirname(realpathSync(join(REPO_ROOT, "node_modules/.bin/tsx")))));
  symlinkSync(dependencyDonor, join(root, "node_modules"));
  writeFileSync(join(root, "package-lock.json"), readFileSync(join(REPO_ROOT, "package-lock.json")));
  writeFileSync(join(root, "scripts/test-duration-reporter.mjs"), readFileSync(join(REPO_ROOT, "scripts/test-duration-reporter.mjs")));
  writeFileSync(join(root, "scripts/test-tier-manifest.json"), JSON.stringify({ version: 1, thresholdMs: 10_000, files: { [SUITE]: 500 } }));
  writeFileSync(join(root, "scripts/census-precheck.mjs"), "console.log('fixture census precheck passed');\n");
  writeFileSync(join(root, "scripts/lint-plan-offline.mjs"), "console.log('fixture plan lint passed');\n");
  writeFileSync(join(root, "test/setup/tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(root, "src/run-task.ts"), "console.log('baseline');\n");
  writeFileSync(join(root, SUITE), "import { test } from 'node:test'; test('leaf', () => {});\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "test: baseline");
  repo.addRemote("origin", root);
  repo.git("checkout", "-b", "run-unfiled-w1-t11891-fixture");
  writeFileSync(join(root, "src/run-task.ts"), "import { writeFileSync } from 'node:fs'; writeFileSync('coverage/static-ran.json', '{}');\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "fix: exercise author validation");
  return { root, receipt: () => JSON.parse(readFileSync(join(root, "coverage/preflight-author.json"), "utf8")) };
}

/** A private slot dir; `fixedSlots` null is the measured pool (RMD_TEST_SLOTS unset). */
function slotEnvironment(t: TestContext, fixedSlots: number | null): string {
  const dir = join(mkdtempSync(join(tmpdir(), "rmd-w1-t11891-")), "slots");
  mkdirSync(dir);
  const keys = ["RMD_TEST_SLOT_DIR", "RMD_TEST_SLOTS", "RMD_TEST_SLOT_PARENT"] as const;
  const saved = keys.map(key => [key, process.env[key]] as const);
  process.env.RMD_TEST_SLOT_DIR = dir;
  if (fixedSlots === null) delete process.env.RMD_TEST_SLOTS;
  else process.env.RMD_TEST_SLOTS = String(fixedSlots);
  delete process.env.RMD_TEST_SLOT_PARENT;
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });
  return dir;
}

function runAuthor(t: TestContext, h: Host, { fixedSlots = 4 as number | null, peerGrant = undefined as number | undefined,
  argv = [] as string[], fixture = undefined as ReturnType<typeof authorFixture> | undefined } = {}) {
  const f = fixture ?? authorFixture(t);
  const dir = slotEnvironment(t, fixedSlots);
  const slotOpts = {
    dir, waitBoundMs: 0, pollMs: 5, log: () => {},
    ...(fixedSlots === null ? {} : { slots: fixedSlots }),
    load: () => ({ cores: h.cores, load1: h.load1 }),
    // The slot's own memory reading goes through the SAME platform reader the host inputs use.
    memoryHeadroom: () => readMemoryHeadroom(h.files, { platform: h.platform, vmStat: h.vmStat }),
  };
  // A live peer already holding part of a measured pool: its grant is active-slot accounting.
  const peer = peerGrant === undefined ? undefined : acquireTestSlot("w1-t11891:peer", { ...slotOpts, maxConcurrency: peerGrant });
  if (peer) assert.equal(peer.concurrency, peerGrant, "the peer holds exactly its grant");
  const affectedArgs: string[][] = [];
  const spawn = (file: string, args: string[], options: Parameters<typeof spawnSync>[2]) => {
    if (args.includes(SUITE)) affectedArgs.push(args);
    return spawnSync(file, args, options);
  };
  try {
    const exitCode = author.main(argv, { root: f.root, spawn, host: () => readHost(h),
      select: () => ({ fullRun: false, suites: [SUITE], narrow: [SUITE], reasons: ["W1-T11891 fixture"] }),
      testSlot: { ...slotOpts, queue: true } });
    const receipt = f.receipt();
    const concurrency = affectedArgs.map(args => args.find(arg => arg.startsWith("--test-concurrency=")));
    return { exitCode, receipt, concurrency };
  } finally { peer?.release(); }
}

function assertGrantAgrees(run: ReturnType<typeof runAuthor>, expected: number) {
  const { exitCode, receipt, concurrency } = run;
  assert.equal(exitCode, 0, JSON.stringify(receipt.error ?? receipt.testSlot));
  assert.equal(receipt.verdict, "passed");
  assert.equal(receipt.testSlot.outcome, "acquired");
  assert.equal(receipt.testSlot.concurrency, expected, "the slot grant");
  assert.equal(receipt.executionWorkers, expected, "the execution width");
  assert.equal(receipt.capacity.workers, expected, "the receipt capacity");
  assert.deepEqual(concurrency, [`--test-concurrency=${expected}`], "the affected-tests child argv");
}

test("capable Linux and Darwin author runs match the measured slot grant above four workers", async (t) => {
  for (const [name, h] of [
    ["linux/cgroup", linuxHost(32, 0, 128 * GiB)],
    ["darwin/vm_stat", darwinHost(32, 0, vmStatReport(128 * GiB))],
  ] as const) {
    await t.test(name, (t) => {
      assert.equal(readHost(h).headroomBytes, 128 * GiB, "the platform reader measured the host's memory");
      const run = runAuthor(t, h);
      // A fixed pool of four on 32 cores shares 30 usable cores: ceil(30 / 4) = 8, above the removed cap.
      assertGrantAgrees(run, 8);
      const inputs = run.receipt.capacity.inputs;
      assert.equal(inputs.cpuWorkers, 30); assert.equal(inputs.memoryWorkers, 256);
      assert.equal(inputs.slotConcurrency, 8); assert.equal(inputs.slotAcquired, true);
      assert.equal(inputs.boundBy, "slot");
      assert.equal(run.receipt.suiteQueue.requestedWorkers, 30, "the slot was asked for the measured width");
    });
  }
});

test("CPU memory and unavailable vm_stat inputs never exceed measured author bounds", async (t) => {
  await t.test("loaded CPU lowers the width", (t) => {
    const run = runAuthor(t, linuxHost(32, 27, 128 * GiB));
    assertGrantAgrees(run, 3);
    assert.equal(run.receipt.capacity.inputs.cpuWorkers, 3);
  });
  await t.test("measured memory headroom lowers the width", (t) => {
    const run = runAuthor(t, linuxHost(32, 0, 3 * 512 * 1024 ** 2));
    assertGrantAgrees(run, 3);
    assert.equal(run.receipt.capacity.inputs.memoryWorkers, 3);
  });
  for (const [name, h] of [
    ["linux with no memory reading", { platform: "linux", cores: 32, load1: 0, files: enoent } as Host],
    ["darwin with vm_stat unavailable", darwinHost(32, 0, undefined)],
  ] as const) {
    await t.test(name, (t) => {
      assert.equal(readHost(h).headroomBytes, undefined, "no memory evidence");
      const pre = author.hostBudget(readHost(h));
      assert.equal(pre.workers, 1); assert.equal(pre.inputs.memoryBound, "unmeasured-one-worker");
      const run = runAuthor(t, h);
      assert.equal(run.receipt.suiteQueue.requestedWorkers, 1, "missing memory never widens the slot request");
      assertGrantAgrees(run, 1);
    });
  }
});

test("author execution preserves reserved core and measured CPU bounds above four", async (t) => {
  for (const [cores, expected] of [[6, 4], [7, 5], [32, 30]] as const) {
    await t.test(`${cores} idle cores keep ${expected} workers after the reserved cores`, (t) => {
      const run = runAuthor(t, linuxHost(cores, 0, 128 * GiB), { fixedSlots: null });
      assertGrantAgrees(run, expected);
      assert.equal(run.receipt.capacity.inputs.cpuWorkers, expected);
    });
  }
  await t.test("a live peer's grant and the host load are accounted before the width", (t) => {
    // 32 cores less 2 reserved less the peer's 10 leaves 20 for this run; load 5 alone would allow 25.
    const run = runAuthor(t, linuxHost(32, 5, 128 * GiB), { fixedSlots: null, peerGrant: 10 });
    assertGrantAgrees(run, 20);
    assert.equal(run.receipt.capacity.inputs.cpuWorkers, 25);
    assert.equal(run.receipt.capacity.inputs.boundBy, "slot");
  });
});

test("runtime deadline admission follows the acquired measured grant above four", (t) => {
  const f = authorFixture(t);
  const grant = { outcome: "acquired", executionAllowed: true, concurrency: 12, waitedMs: 0, note: "fixture grant",
    refresh: () => {}, release: () => {} };
  const calibrated = calibrateAuthorRuntime({ root: f.root, acquireSlot: () => grant });
  const deadline = Date.now() + 60 * 60_000;
  const run = runAuthor(t, linuxHost(32, 0, 128 * GiB), { fixture: f,
    argv: ["--deadline", new Date(deadline).toISOString(), "--runtime-profile", calibrated.path] });
  assertGrantAgrees(run, 8);
  const admission = run.receipt.runtimeAdmission;
  assert.equal(admission.stage, "before-tests", "the width is rechecked after the slot is acquired");
  assert.equal(admission.workers, 8); assert.equal(admission.admittedWorkers, 8);
  assert.equal(admission.authority, "admitted-width"); assert.equal(admission.fits, true);
  assert.equal(run.receipt.capacity.budgetSource, "validated-native-fixed-deadline");
  // A missing or exceeded grant refuses the same execution check.
  const profile = readRuntimeProfile(f.root, calibrated.path, runtimeBindings(f.root, calibrated.head));
  const manifest = { files: { [SUITE]: 500 } };
  const at = { deadline, now: Date.now() };
  assert.equal(runtimeDeadlineFit([SUITE], manifest, profile, { ...at, workers: 12, admittedWorkers: 12 }).workers, 12);
  for (const admittedWorkers of [undefined, 11]) assert.throws(() => runtimeDeadlineFit([SUITE], manifest, profile,
    { ...at, workers: 12, admittedWorkers }), /admitted workers/);
});

test("no fixed author ceiling remains in preflight, calibration or the runtime profile", (t) => {
  assert.equal(Object.hasOwn(author, "AUTHOR_MAX_WORKERS"), false, "preflight-author exports no fixed worker ceiling");
  const f = authorFixture(t);
  const grant = { outcome: "acquired", executionAllowed: true, concurrency: 12, waitedMs: 0, note: "fixture grant 12",
    refresh: () => {}, release: () => {} };
  const calibrated = calibrateAuthorRuntime({ root: f.root, acquireSlot: () => grant });
  assert.equal(calibrated.concurrency, 12, "calibration samples at the admitted grant");
  const raw = readFileSync(calibrated.path, "utf8"), parsed = JSON.parse(raw);
  assert.equal(parsed.concurrency, 12); assert.equal(parsed.slot.concurrency, 12);
  const bindings = runtimeBindings(f.root, calibrated.head);
  assert.equal(readRuntimeProfile(f.root, calibrated.path, bindings).concurrency, 12, "a matching profile above four is accepted");
  const { concurrency: _granted, ...ungranted } = parsed.slot;
  for (const [why, profile] of [
    ["mismatched", { ...parsed, concurrency: 11 }],
    ["mismatched grant", { ...parsed, slot: { ...parsed.slot, concurrency: 16 } }],
    ["ungranted", { ...parsed, slot: ungranted }],
    ["no slot", { ...parsed, slot: undefined }],
  ] as const) {
    writeFileSync(calibrated.path, JSON.stringify(profile));
    assert.throws(() => readRuntimeProfile(f.root, calibrated.path, bindings), /invalid measured concurrency/, why);
  }
  writeFileSync(calibrated.path, raw);
  assert.equal(readRuntimeProfile(f.root, calibrated.path, bindings).concurrency, 12, "restored positive control");
});
