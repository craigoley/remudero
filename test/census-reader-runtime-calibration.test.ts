import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gitRepo } from "./helpers/git-repo.js";
// @ts-ignore executable gate module.
import { censusReaderBudget, runCensusSuitesViaChild } from "../scripts/census-precheck.mjs";

// @census-reads: none — runtime contexts belong to isolated fixture repositories.
const POLICY = { floorMs: 1000, multiple: 4 };
const FILE = "test/reader.test.ts";
const PASS = "TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
const FAIL = `TAP version 13\nnot ok 1 - reader fails\n  ---\n  location: '${FILE}:1:1'\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n`;
const priority = { wrap: (file: string, args: string[]) => ({ file, args }) };

function fixture(t: TestContext, body = 'test("reader works", () => assert.equal(1, 1));') {
  const repo = gitRepo({ kind: "reader-runtime" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "test"));
  writeFileSync(join(repo.dir, FILE), `import { test } from "node:test";\nimport assert from "node:assert/strict";\n${body}\n`);
  repo.git("add", "."); repo.git("commit", "--quiet", "-m", "reader input");
  return repo;
}

test("source-reader calibration prices that reader including startup, not seven unrelated durations", (t) => {
  const repo = fixture(t), time = [0, 9000, 9001, 9002, 18002], bounds: number[] = [];
  assert.deepEqual(runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY, priority,
    now: () => time.shift()!, readContext: () => "same-runtime-input",
    run: (_f: string, _a: string[], options: { timeout: number }) => {
      bounds.push(options.timeout); return { status: 0, stdout: PASS };
    } }), []);
  assert.deepEqual(bounds, [60000, 36000]);
  assert.equal(time.length, 0);
});

test("source-reader runtime refuses absent stale malformed and other-context calibration", () => {
  const good = { context: "head-A", complete: true, passed: true, tests: 1, elapsedMs: 9000, finishedMs: 10000 };
  assert.equal(censusReaderBudget(good, "head-A", POLICY, 10001), 36000);
  for (const bad of [null, {}, { ...good, context: "head-B" }, { ...good, complete: false }, { ...good, passed: false },
    { ...good, tests: 0 }, { ...good, elapsedMs: NaN }, { ...good, elapsedMs: 0 }, { ...good, finishedMs: 10002 },
    { ...good, finishedMs: -60000 }]) assert.throws(() => censusReaderBudget(bad, "head-A", POLICY, 10001), /UNKNOWN/);
  for (const policy of [null, {}, { floorMs: 0, multiple: 4 }, { floorMs: 1000, multiple: NaN }]) {
    assert.throws(() => censusReaderBudget(good, "head-A", policy, 10001), /UNKNOWN/);
  }
  assert.throws(() => censusReaderBudget({ ...good, elapsedMs: 16000 }, "head-A", POLICY, 10001), /cannot fit/);
});

test("source-reader calibration never retries a failed assertion or learns incomplete output", (t) => {
  const repo = fixture(t); let calls = 0;
  assert.deepEqual(runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY, priority,
    readContext: () => "same", run: () => { calls++; return { status: 1, stdout: FAIL }; } }), [FILE]);
  assert.equal(calls, 1);
  for (const result of [
    { status: 0, stdout: PASS.replace("# skipped 0", "# skipped 1") },
    { status: 0, stdout: PASS.replace("# cancelled 0\n", "") },
    { status: 0, stdout: PASS.replace("# tests 1", "# tests 0") },
    { status: 0, stdout: "no summary" }, { status: 2, stdout: PASS },
    { status: null, signal: "SIGTERM", stdout: PASS }, { status: null, error: new Error("ETIMEDOUT") },
  ]) assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY,
    priority, readContext: () => "same", run: () => result }), /UNKNOWN|0 tests|summary|exited 2|SIGTERM|ETIMEDOUT/);
});

test("source-reader qualification rejects source drift and a new runtime overrun without another try", (t) => {
  const repo = fixture(t); let calls = 0;
  assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY, priority,
    readContext: () => calls ? "changed" : "original", run: () => { calls++; return { status: 0, stdout: PASS }; } }), /inputs changed/);
  assert.equal(calls, 1);
  const time = [0, 1000, 1001, 1002, 6002]; calls = 0;
  assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY, priority,
    now: () => time.shift()!, readContext: () => "same", run: () => { calls++; return { status: 0, stdout: PASS }; } }), /exceeded.*4000ms/);
  assert.equal(calls, 2);
});

test("source-reader calibration exercises real native context and children without a synthetic pass", (t) => {
  const repo = fixture(t);
  assert.deepEqual(runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY }), []);
  assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: ["test/ghost.test.ts"], readerRuntimePolicy: POLICY }), /ENOENT/);
  assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY, timeoutMs: 4000 }), /no timeout override/);
  assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: [FILE, FILE], readerRuntimePolicy: POLICY }), /one reader/);
});

test("source-reader native timeout preserves its started runaway and closed capture rather than reporting a pass", (t) => {
  const marker = "OWN_READER_RUNAWAY_STARTED";
  const repo = fixture(t, `process.on("SIGTERM", () => {}); console.error(${JSON.stringify(marker)}); test("owned runaway", async () => new Promise(() => { setInterval(() => {}, 100); }));`);
  assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: [FILE], timeoutMs: 2000 }), (error: Error) => {
    assert.match(error.message, /exceeded 2000 ms.*capture retained at/);
    const dir = error.message.match(/capture retained at (.+)$/)![1];
    const native = JSON.parse(readFileSync(join(dir, "native.json"), "utf8"));
    assert.equal(native.error.code, "ERR_AUTHOR_STEP_TIMEOUT");
    assert.equal(native.outputComplete, false);
    assert.ok(native.finishedAt);
    assert.match(readFileSync(join(dir, "stderr"), "utf8"), new RegExp(marker));
    return true;
  });
});
