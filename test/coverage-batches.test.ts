import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { testSlotProcessFacts } from "../src/lib/test-slot.js";
import { gitRepo } from "./helpers/git-repo.js";
import { ownedFixtureDir } from "./helpers/owned-fixture-dir.js";
// @ts-expect-error Plain repository CLI exports are exercised through their real implementation.
import { guardCoverageLease, runCoverageBatches, runCoverageCommand } from "../scripts/coverage-batches.mjs";

function lease(dir: string) {
  const path = join(dir, "slot-1.json"), start = testSlotProcessFacts(process.pid)!.start;
  const held = { pid: process.pid, processStart: start, ownerNonce: "fixture", concurrency: 1 };
  const write = (value = held) => writeFileSync(path, JSON.stringify(value)); write();
  return { path, held, write, slot: { outcome: "acquired", concurrency: 1,
    childEnvironment: { RMD_TEST_SLOT_PARENT: JSON.stringify({ path, pid: process.pid, start, nonce: held.ownerNonce, concurrency: 1 }) },
    refresh() {}, release() { rmSync(path, { force: true }); } } };
}

test("coverage command waits for an aborted child's close even when its signal handler exits zero", async (t) => {
  const fixture = ownedFixtureDir(t, "batch-child-close"), pidPath = join(fixture.dir, "pid");
  const abort = new AbortController();
  const running = runCoverageCommand(["-e", `const fs=require('node:fs');process.on('SIGTERM',()=>process.exit(0));fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000)`],
    { cwd: fixture.dir, env: process.env, signal: abort.signal });
  fixture.until(running);
  try {
  for (let i = 0; i < 100 && !existsSync(pidPath); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(existsSync(pidPath), "real child reached its signal handler");
  const pid = Number(readFileSync(pidPath, "utf8")); abort.abort();
  const result = await running;
  assert.equal(result.status, 0); assert.equal(result.interrupted, "lease-lost");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { abort.abort(); await running; }
});

test("coverage command reaps its own stubborn child and reports a real spawn failure", async (t) => {
  const fixture = ownedFixtureDir(t, "batch-stubborn"), pidPath = join(fixture.dir, "pid");
  const abort = new AbortController();
  const running = runCoverageCommand(["-e", `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000)`],
    { cwd: fixture.dir, env: process.env, signal: abort.signal, terminateAfterMs: 20 });
  fixture.until(running);
  try {
    for (let i = 0; i < 100 && !existsSync(pidPath); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(pidPath)); const pid = Number(readFileSync(pidPath, "utf8"));
    abort.abort(); const result = await running;
    assert.equal(result.signal, "SIGKILL"); assert.notEqual(result.status, 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
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
  const result = await runCoverageBatches({ cwd: repo.dir, flags: ["--enable-source-maps", "--experimental-test-coverage", "--test",
    "--test-reporter=tap", "--test-reporter-destination=stderr", "--test-reporter=lcov", "--test-reporter-destination=coverage/lcov.info"],
    files: ["test/0.test.mjs", "test/1.test.mjs"], batchSize: 1, lcov, base: "HEAD" }, { acquire: async () => f.slot, log() {} });
  assert.equal(result.status, 0, readFileSync(result.receiptPath, "utf8"));
  const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
  assert.equal(receipt.state, "complete"); assert.equal(receipt.batches.length, 2);
  for (const batch of receipt.batches) {
    assert.equal(batch.verdict.complete, true); assert.equal(batch.verdict.reported, 1);
    assert.equal(batch.rawDisposed, true); assert.equal(existsSync(batch.raw), false);
    assert.match(readFileSync(batch.tap, "utf8"), /# tests 1/);
  }
  const text = readFileSync(lcov, "utf8");
  assert.match(text, /SF:subject\.mjs\n/); assert.match(text, /DA:1,[1-9]/);
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
  const blocked = await runCoverageBatches({ ...opts,
    diskProfile: { minimumFreeBytes: Number.MAX_SAFE_INTEGER, reservedBytes: 0, estimatedPeakBytes: 1 } },
  { acquire: async () => f.slot, log() {} });
  assert.equal(blocked.status, 75);
  const blockedReceipt = JSON.parse(readFileSync(blocked.receiptPath, "utf8"));
  assert.equal(blockedReceipt.state, "not-run-disk-capacity"); assert.equal(blockedReceipt.batches.length, 0);
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
