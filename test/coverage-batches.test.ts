import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, fstatSync, mkdirSync, readFileSync, readSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { testSlotProcessFacts } from "../src/lib/test-slot.js";
import { gitRepo } from "./helpers/git-repo.js";
import { ownedFixtureDir } from "./helpers/owned-fixture-dir.js";
// @ts-expect-error Plain repository CLI exports are exercised through their real implementation.
import { coverageArtifactDigest, guardCoverageLease, main as batchMain, releaseCoverageLease, runCoverageBatches, runCoverageCommand } from "../scripts/coverage-batches.mjs";
// @ts-expect-error Plain repository CLI exports supply the real CI coverage scope.
import { extractCoverageFlags, main as localMain, readCiYaml } from "../scripts/diff-coverage-local.mjs";

test("coverage batch CLI preserves explicit selection retention and refused exit status", async () => {
  let calls = 0;
  const status = await batchMain(["--batch-size", "2", "--base", "HEAD", "--lcov", "/private/fixture/lcov.info",
    "--keep-raw", "test/first.test.ts", "test/second.test.ts"], { run: async (options: {
      files: string[]; flags: string[]; batchSize: number; base: string; lcov: string; keepRaw: boolean;
    }) => {
    calls++;
    assert.deepEqual(options.files, ["test/first.test.ts", "test/second.test.ts"]);
    assert.ok(options.flags.includes("--experimental-test-coverage"));
    assert.equal(options.batchSize, 2); assert.equal(options.base, "HEAD");
    assert.equal(options.lcov, "/private/fixture/lcov.info"); assert.equal(options.keepRaw, true);
    return { status: 75 };
  } });
  assert.equal(calls, 1); assert.equal(status, 75);
});

test("the actual coverage CLI rejects an invalid batch before running work", () => {
  const result = childProcess.spawnSync(process.execPath, ["--max-old-space-size=512", "--import", "tsx",
    "scripts/coverage-batches.mjs", "--batch-size", "0", "test/coverage-batches.test.ts"], {
    cwd: new URL("..", import.meta.url), env: { ...process.env }, encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024,
  });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 1);
  assert.match(result.stderr, /batch size must be a positive integer/);
  assert.doesNotMatch(result.stderr, /coverage-batches: receipt/);
});

test("the local batch delegate preserves failed and unavailable child outcomes", async (t) => {
  assert.equal(await localMain(["--batch-size", "0", "test/coverage-batches.test.ts"]), 1,
    "the real default delegate reaches the CLI validation failure");
  const argv = ["--batch-size", "1", "--keep-raw", "test/coverage-batches.test.ts"];
  let status: number | null = 7, calls = 0;
  const stub = t.mock.method(childProcess, "spawnSync", ((file: string, args: string[], options: {
    env: NodeJS.ProcessEnv; stdio: string;
  }) => {
    calls++; assert.equal(file, process.execPath); assert.deepEqual(args.slice(-argv.length), argv);
    assert.equal(options.env.NODE_V8_COVERAGE, ""); assert.equal(options.stdio, "inherit");
    return { status };
  }) as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try {
    assert.equal(await localMain(argv), 7);
    status = null; assert.equal(await localMain(argv), 1, "a killed or unstarted child is not success");
    status = 0; assert.equal(await localMain(argv), 0); assert.equal(calls, 3);
  } finally { stub.mock.restore(); syncBuiltinESMExports(); }
});

test("coverage artifact hashing reads the opened regular file and refuses empty linked or replaced evidence", (t) => {
  const { dir } = ownedFixtureDir(t, "batch-artifact"), file = join(dir, "lcov.info");
  const bytes = Buffer.alloc(128 * 1024 + 7, "x"); writeFileSync(file, bytes);
  assert.equal(coverageArtifactDigest(file), createHash("sha256").update(bytes).digest("hex"));
  const link = join(dir, "linked.info"); symlinkSync(file, link);
  assert.throws(() => coverageArtifactDigest(link));
  assert.throws(() => coverageArtifactDigest(dir), /regular file/);
  writeFileSync(join(dir, "empty.info"), "");
  assert.throws(() => coverageArtifactDigest(join(dir, "empty.info")), /non-empty/);
  let replaced = false;
  assert.throws(() => coverageArtifactDigest(file, { read(fd: number, target: Buffer, offset: number, length: number, position: number) {
    assert.ok(length <= 64 * 1024, "artifact reads keep a fixed memory bound");
    const count = readSync(fd, target, offset, length, position);
    if (!replaced) { replaced = true; renameSync(file, file + ".original"); writeFileSync(file, bytes); }
    return count;
  } }), /changed while/);
  assert.equal(readFileSync(file, "utf8"), bytes.toString(), "replacement evidence is preserved");
});

test("coverage artifact hashing refuses in-place growth and closes its descriptor after a read failure", (t) => {
  const { dir } = ownedFixtureDir(t, "batch-artifact-change"), file = join(dir, "lcov.info");
  writeFileSync(file, "LCOV");
  assert.throws(() => coverageArtifactDigest(file, { read(fd: number, target: Buffer, offset: number, length: number, position: number) {
    const count = readSync(fd, target, offset, length, position); appendFileSync(file, "changed"); return count;
  } }), /changed while/);
  const original = new Error("actual read seam failed"); let opened = -1;
  assert.throws(() => coverageArtifactDigest(file, { read(fd: number) { opened = fd; throw original; } }),
    (error: unknown) => error === original);
  assert.throws(() => fstatSync(opened), { code: "EBADF" });
});

function lease(dir: string) {
  const path = join(dir, "slot-1.json"), start = testSlotProcessFacts(process.pid)!.start;
  const held = { pid: process.pid, processStart: start, ownerNonce: "fixture", concurrency: 1 };
  const write = (value = held) => writeFileSync(path, JSON.stringify(value)); write();
  return { path, held, write, slot: { outcome: "acquired", concurrency: 1,
    childEnvironment: { RMD_TEST_SLOT_PARENT: JSON.stringify({ path, pid: process.pid, start, nonce: held.ownerNonce, concurrency: 1 }) },
    refresh() {}, release() { rmSync(path, { force: true }); } } };
}

function observedSpawn() {
  // A readiness file may still be empty, and a closed child's PID can be reused. Observe the
  // real handle's close event; the deliberately empty marker only orders handler installation.
  const state = { child: undefined as ChildProcess | undefined, closed: false,
    spawnProcess(file: string, args: readonly string[], opts: SpawnOptions) {
      state.child = spawn(file, [...args], opts);
      state.child.once("close", () => { state.closed = true; });
      return state.child;
    } };
  return state;
}

test("coverage command waits for an aborted child's close even when its signal handler exits zero", async (t) => {
  const fixture = ownedFixtureDir(t, "batch-child-close"), readyPath = join(fixture.dir, "ready");
  const abort = new AbortController();
  const observed = observedSpawn();
  const running = runCoverageCommand(["-e", `const fs=require('node:fs');process.on('SIGTERM',()=>process.exit(0));fs.writeFileSync(${JSON.stringify(readyPath)},'');setInterval(()=>{},1000)`],
    { cwd: fixture.dir, env: process.env, signal: abort.signal, spawnProcess: observed.spawnProcess });
  fixture.until(running);
  try {
  for (let i = 0; i < 100 && !existsSync(readyPath); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(existsSync(readyPath), "real child reached its signal handler");
  assert.ok(observed.child?.pid && observed.child.pid > 1); abort.abort();
  const result = await running;
  assert.equal(result.status, 0); assert.equal(result.interrupted, "lease-lost");
  assert.ok(observed.closed, "the actual child closed before the caller received its result");
  assert.equal(observed.child.exitCode, 0);
  } finally { abort.abort(); await running; }
});

test("coverage command reaps its own stubborn child and reports a real spawn failure", async (t) => {
  const fixture = ownedFixtureDir(t, "batch-stubborn"), readyPath = join(fixture.dir, "ready");
  const abort = new AbortController();
  const observed = observedSpawn();
  const running = runCoverageCommand(["-e", `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(readyPath)},'');setInterval(()=>{},1000)`],
    { cwd: fixture.dir, env: process.env, signal: abort.signal, terminateAfterMs: 20, spawnProcess: observed.spawnProcess });
  fixture.until(running);
  try {
    for (let i = 0; i < 100 && !existsSync(readyPath); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(readyPath)); assert.ok(observed.child?.pid && observed.child.pid > 1);
    abort.abort(); const result = await running;
    assert.equal(result.signal, "SIGKILL"); assert.notEqual(result.status, 0);
    assert.ok(observed.closed, "the reaped child is identified by its native handle, not a reused PID");
    assert.equal(observed.child.signalCode, "SIGKILL");
  } finally { abort.abort(); await running; }
  const logs: string[] = [];
  const failed = await runCoverageCommand(["-e", "0"], { cwd: join(fixture.dir, "missing"), env: process.env, log: (text: string) => logs.push(text) });
  assert.notEqual(failed.status, 0); assert.match(failed.error, /ENOENT/); assert.equal(logs.length, 1);
});

test("coverage batch authority refuses released replaced and vanished lease anchors", (t) => {
  const { dir } = ownedFixtureDir(t, "batch-lease");
  const f = lease(dir), verify = guardCoverageLease(f.slot); verify();
  for (const value of [null, false, 0, ""]) {
    writeFileSync(f.path, JSON.stringify({ ...f.held, releaseRequestedAt: value }));
    assert.throws(verify, /authority lost/);
  }
  f.write(); renameSync(f.path, f.path + ".old"); f.write();
  assert.throws(verify, /identity changed/);
  rmSync(f.path); assert.throws(verify, /ENOENT/);
  assert.throws(() => guardCoverageLease({}), /physical owner claim/);
});

test("coverage completion refuses silent owned-release failure and preserves a replacement owner", (t) => {
  const { dir } = ownedFixtureDir(t, "batch-release");
  const f = lease(dir);
  assert.throws(() => releaseCoverageLease({ ...f.slot, release() {} }), /unconfirmed/);
  const other = { ...f.held, ownerNonce: "other-owner" }; f.write(other);
  assert.doesNotThrow(() => releaseCoverageLease({ ...f.slot, release() {} }));
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).ownerNonce, "other-owner");
  f.slot.release(); assert.doesNotThrow(() => releaseCoverageLease(f.slot));
});

test("real serial coverage batches conserve positive line hits and dispose only closed raw scratch", async (t) => {
  const repo = gitRepo({ scope: t, seedCommit: false });
  mkdirSync(join(repo.dir, "test"));
  writeFileSync(join(repo.dir, ".gitignore"), "coverage\n");
  writeFileSync(join(repo.dir, ".nvmrc"), process.versions.node + "\n");
  writeFileSync(join(repo.dir, "subject.mjs"), "export function value(n) { return n ? 1 : 2; }\n");
  for (const [i, value] of [1, 2].entries()) writeFileSync(join(repo.dir, `test/${i}.test.mjs`),
    `import{test}from'node:test';import assert from'node:assert/strict';import{value}from'../subject.mjs';test('branch ${i}',()=>assert.equal(value(${i === 0}),${value}));`);
  repo.git("add", "."); repo.git("commit", "-m", "test: coverage fixture");
  const f = lease(ownedFixtureDir(t, "batch-native-lease").dir);
  const lcov = join(repo.dir, "coverage/lcov.info");
  // Keep the native fixture on CI's source population. Node 22's test wrappers have
  // reporter-specific anonymous ranges; CI already excludes test/** from coverage.
  const coverageScope = extractCoverageFlags(readCiYaml()).filter((flag: string) =>
    flag.startsWith("--test-coverage-exclude=") || flag.startsWith("--test-coverage-include="));
  assert.ok(coverageScope.includes("--test-coverage-exclude=test/**"));
  const result = await runCoverageBatches({ cwd: repo.dir, flags: ["--enable-source-maps", "--experimental-test-coverage", "--test",
    ...coverageScope,
    "--test-reporter=tap", "--test-reporter-destination=stderr", "--test-reporter=lcov", "--test-reporter-destination=coverage/lcov.info"],
    files: ["test/0.test.mjs", "test/1.test.mjs"], batchSize: 1, lcov, base: "HEAD" }, { acquire: async () => f.slot, log() {} });
  assert.equal(result.status, 0, readFileSync(result.receiptPath, "utf8"));
  const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
  assert.equal(receipt.state, "complete"); assert.equal(receipt.batches.length, 2);
  assert.equal(receipt.resourceScope, "workspace-and-registered-scratch");
  assert.equal(receipt.diskProfile, null); assert.equal(receipt.estimatedPeakBasis, "not-supplied");
  assert.ok(receipt.resources.samples[3].generatedPathBytes > receipt.resources.samples[4].generatedPathBytes,
    "the raw-plus-compact phase charges external raw output before its confirmed disposal");
  for (const batch of receipt.batches) {
    assert.equal(batch.verdict.complete, true); assert.equal(batch.verdict.reported, 1);
    assert.equal(batch.rawDisposed, true); assert.equal(existsSync(batch.raw), false);
    assert.match(readFileSync(batch.tap, "utf8"), /# tests 1/);
  }
  const text = readFileSync(lcov, "utf8");
  assert.match(text, /SF:subject\.mjs\n/); assert.match(text, /DA:1,[1-9]/);
  assert.doesNotMatch(text, /^SF:test\//m, "the fixture uses the real CI coverage exclusion");
});

test("coverage batches refuse ghost inputs and retain an actual failing batch without starting the next", async (t) => {
  const repo = gitRepo({ scope: t, seedCommit: false }); mkdirSync(join(repo.dir, "test"));
  writeFileSync(join(repo.dir, ".gitignore"), "coverage\n");
  for (const name of ["fail", "later"]) writeFileSync(join(repo.dir, `test/${name}.test.mjs`),
    `import{test}from'node:test';test('${name}',()=>{${name === "fail" ? "throw Error('original batch failure')" : ""}});`);
  repo.git("add", "."); repo.git("commit", "-m", "test: failing batch fixture");
  const f = lease(ownedFixtureDir(t, "batch-failure-lease").dir);
  const opts = { cwd: repo.dir, flags: ["--test", "--test-reporter=tap", "--test-reporter-destination=stderr",
    "--test-reporter=lcov", "--test-reporter-destination=coverage/lcov.info", "--experimental-test-coverage"],
    files: ["test/fail.test.mjs", "test/later.test.mjs"], batchSize: 1, lcov: join(repo.dir, "coverage/lcov.info"), base: "HEAD" };
  await assert.rejects(runCoverageBatches({ ...opts, files: ["test/ghost.test.mjs"] }), /ENOENT/);
  mkdirSync(join(repo.dir, "coverage"), { recursive: true }); writeFileSync(opts.lcov, "previous evidence");
  const blocked = await runCoverageBatches({ ...opts,
    diskProfile: { minimumFreeBytes: Number.MAX_SAFE_INTEGER, reservedBytes: 0, estimatedPeakBytes: 1 } },
  { acquire: async () => f.slot, log() {} });
  assert.equal(blocked.status, 75);
  const blockedReceipt = JSON.parse(readFileSync(blocked.receiptPath, "utf8"));
  assert.equal(blockedReceipt.state, "not-run-disk-capacity"); assert.equal(blockedReceipt.batches.length, 0);
  assert.equal(readFileSync(opts.lcov, "utf8"), "previous evidence", "capacity refusal preserves previous evidence");
  assert.equal(blockedReceipt.estimatedPeakBasis, "declared-profile");
  f.write();
  const lost = await runCoverageBatches(opts, { acquire: async () => f.slot, log() {},
    run: async () => { rmSync(f.path); return { status: 7, signal: null }; } });
  assert.notEqual(lost.status, 0);
  const lostReceipt = JSON.parse(readFileSync(lost.receiptPath, "utf8"));
  assert.equal(lostReceipt.phases[0].result.status, 7, "the original child failure survives later authority loss");
  assert.equal(lostReceipt.batches.length, 1);
  rmSync(lostReceipt.batches[0].raw, { recursive: true, force: true }); f.write();
  const result = await runCoverageBatches(opts, { acquire: async () => f.slot, log() {} });
  assert.notEqual(result.status, 0);
  const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
  assert.equal(receipt.state, "failed"); assert.equal(receipt.batches.length, 1);
  assert.ok(existsSync(receipt.batches[0].raw));
  assert.match(readFileSync(receipt.batches[0].tap, "utf8"), /original batch failure/);
  rmSync(receipt.batches[0].raw, { recursive: true, force: true });
});

test("coverage batches preserve an admission refusal without starting a child", async (t) => {
  const repo = gitRepo({ scope: t, seedCommit: false }); mkdirSync(join(repo.dir, "test"));
  writeFileSync(join(repo.dir, ".gitignore"), "coverage\n");
  writeFileSync(join(repo.dir, "test/ready.test.mjs"), "import{test}from'node:test';test('ready',()=>{});\n");
  repo.git("add", "."); repo.git("commit", "-m", "test: refused batch fixture");
  let released = 0, spawned = 0;
  const result = await runCoverageBatches({ cwd: repo.dir, flags: [], files: ["test/ready.test.mjs"], batchSize: 1,
    lcov: join(repo.dir, "coverage/lcov.info") }, { log() {},
    acquire: async () => ({ outcome: "not-run", executionAllowed: false, note: "another owner retains the slot", release() { released++; } }),
    run: async () => { spawned++; throw new Error("unadmitted child started"); },
  });
  const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
  assert.equal(result.status, 75); assert.equal(receipt.state, "not-run");
  assert.equal(receipt.reason, "another owner retains the slot"); assert.deepEqual(receipt.batches, []);
  assert.equal(spawned, 0); assert.equal(released, 1);
});

test("coverage batches preserve a replaced raw scratch root after the compactor closes", async (t) => {
  const repo = gitRepo({ scope: t, seedCommit: false });
  const fixture = ownedFixtureDir(t, "batch-raw-swap");
  mkdirSync(join(repo.dir, "test"));
  writeFileSync(join(repo.dir, ".gitignore"), "coverage\n");
  writeFileSync(join(repo.dir, ".nvmrc"), process.versions.node + "\n");
  writeFileSync(join(repo.dir, "subject.mjs"), "export const value = 1;\n");
  writeFileSync(join(repo.dir, "test/ready.test.mjs"),
    "import{test}from'node:test';import{value}from'../subject.mjs';test('ready',()=>{if(value!==1)throw Error('wrong value')});\n");
  repo.git("add", "."); repo.git("commit", "-m", "test: raw replacement fixture");
  const f = lease(fixture.dir);
  let replacement = "";
  const result = await runCoverageBatches({ cwd: repo.dir, flags: ["--test", "--experimental-test-coverage",
    "--test-coverage-exclude=test/**", "--test-reporter=tap", "--test-reporter-destination=stderr",
    "--test-reporter=lcov", "--test-reporter-destination=coverage/lcov.info"],
    files: ["test/ready.test.mjs"], batchSize: 1, lcov: join(repo.dir, "coverage/lcov.info"), base: "HEAD" }, {
    acquire: async () => f.slot, log() {},
    run: async (args: string[], options: SpawnOptions) => {
      const closed = await runCoverageCommand(args, options);
      if (args.includes("--compact-output") && closed.status === 0) {
        replacement = args.at(-1)!;
        renameSync(replacement, join(fixture.dir, "original-raw"));
        mkdirSync(replacement); writeFileSync(join(replacement, "replacement-evidence"), "preserve");
      }
      return closed;
    },
  });
  assert.ok(replacement, "the real compactor closed successfully before the path swap");
  assert.notEqual(result.status, 0, "a replaced raw directory cannot qualify successful disposal");
  assert.equal(readFileSync(join(replacement, "replacement-evidence"), "utf8"), "preserve");
  assert.ok(existsSync(join(fixture.dir, "original-raw")), "the original raw evidence is retained");
  const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
  assert.equal(receipt.state, "failed"); assert.notEqual(receipt.batches[0].rawDisposed, true);
  assert.match(receipt.reason, /scratch.*changed/);
});
