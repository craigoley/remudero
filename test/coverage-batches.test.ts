import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { testSlotProcessFacts } from "../src/lib/test-slot.js";
import { gitRepo } from "./helpers/git-repo.js";
import { ownedFixtureDir } from "./helpers/owned-fixture-dir.js";
// @ts-expect-error Plain repository CLI exports are exercised through their real implementation.
import { guardCoverageLease, runCoverageBatches } from "../scripts/coverage-batches.mjs";

function lease(dir: string) {
  const path = join(dir, "slot-1.json"), start = testSlotProcessFacts(process.pid)!.start;
  const held = { pid: process.pid, processStart: start, ownerNonce: "fixture", concurrency: 1 };
  const write = (value = held) => writeFileSync(path, JSON.stringify(value)); write();
  return { path, held, write, slot: { outcome: "acquired", concurrency: 1,
    childEnvironment: { RMD_TEST_SLOT_PARENT: JSON.stringify({ path, pid: process.pid, start, nonce: held.ownerNonce, concurrency: 1 }) },
    refresh() {}, release() { rmSync(path, { force: true }); } } };
}

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
  const result = await runCoverageBatches(opts, { acquire: async () => f.slot, log() {} });
  assert.notEqual(result.status, 0);
  const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
  assert.equal(receipt.state, "failed"); assert.equal(receipt.batches.length, 1);
  assert.ok(existsSync(receipt.batches[0].raw));
  assert.match(readFileSync(receipt.batches[0].tap, "utf8"), /original batch failure/);
  rmSync(receipt.batches[0].raw, { recursive: true, force: true });
});
