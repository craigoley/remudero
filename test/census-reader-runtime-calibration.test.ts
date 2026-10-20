import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test, type TestContext } from "node:test";
import { FAST_GATE_CENSUS_REMEASURE_MARGIN } from "#src/lib/ci-parity.js";
import { gitRepo } from "#test/helpers/git-repo.js";
// @ts-ignore executable gate module.
import { censusReaderBudget, main as censusMain, runCensusSuitesViaChild } from "#scripts/census-precheck.mjs";

// @census-reads: none — runtime contexts belong to isolated fixture repositories.
const POLICY = { floorMs: 1000, multiple: 4, remeasureMargin: FAST_GATE_CENSUS_REMEASURE_MARGIN };
const FILE = "test/reader.test.ts";
const PASS = "TAP version 13\nok 1 - reader works\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
const FAIL = `TAP version 13\nnot ok 1 - reader fails\n  ---\n  location: '${FILE}:1:1'\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n`;
// Niced fixture readers starve behind a loaded runner (flake screen, #12600); the wrap is not under test here.
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
  assert.equal(censusReaderBudget(good, "head-A", POLICY, 10001, 1.1), 39600);
  for (const margin of [0.9, NaN, Infinity]) assert.throws(() => censusReaderBudget(good, "head-A", POLICY, 10001, margin), /UNKNOWN/);
  assert.equal(censusReaderBudget({ ...good, elapsedMs: 16000 }, "head-A", POLICY, 10001), 60000);
  assert.throws(() => censusReaderBudget({ ...good, elapsedMs: 60001 }, "head-A", POLICY, 10001), /exceeded.*backstop/);
  assert.throws(() => censusReaderBudget(good, "head-A", { floorMs: Number.MAX_VALUE, multiple: 4 }, 10001), /UNKNOWN/);
});

test("source-reader calibration caps its budget rather than rejecting a healthy reader", (t) => {
  const repo = fixture(t), time = [0, 18000, 18001, 18002, 36002], bounds: number[] = [];
  assert.deepEqual(runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY, priority,
    now: () => time.shift()!, readContext: () => "same-runtime-input", run: (_f: string, _a: string[], options: { timeout: number }) => {
      bounds.push(options.timeout); return { status: 0, stdout: PASS };
    } }), []);
  assert.deepEqual(bounds, [60000, 60000]);
  const overrun = [0, 18000, 18001, 18002, 79003, 79004, 140005];
  assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY, priority,
    now: () => overrun.shift()!, readContext: () => "same-runtime-input", run: () => ({ status: 0, stdout: PASS }) }), /exceeded.*60000ms/);
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
    { status: 0, stdout: PASS, outputComplete: false }, { status: 0, stdout: PASS + "# tests 1\n" },
  ]) assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY,
    priority, readContext: () => "same", run: () => result }), /UNKNOWN|0 tests|summary|exited 2|SIGTERM|ETIMEDOUT|incomplete/);
});

test("source-reader qualification rejects source drift without another try", (t) => {
  const repo = fixture(t); let calls = 0;
  assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY, priority,
    readContext: () => calls ? "changed" : "original", run: () => { calls++; return { status: 0, stdout: PASS }; } }), /inputs changed/);
  assert.equal(calls, 1);
  assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: [FILE], priority,
    readerRuntimePolicy: { floorMs: 1000, multiple: 4 }, run: () => assert.fail("no child without a re-measure margin") }), /invalid calibration policy/);
});

// The fast gate refuses a RUNAWAY only after the run plus one re-measure within FAST_GATE_CENSUS_REMEASURE_MARGIN
// (ci-parity.ts); a loaded author host overran a 4000ms reader budget once on 2026-10-19 and the push was refused.
const OVERRAN = { status: null, error: Object.assign(new Error("native step exceeded 4000 ms"), { code: "ERR_AUTHOR_STEP_TIMEOUT" }) };

test("source-reader qualification re-measures one overrun and passes a re-measure within the fast gate's margin", (t) => {
  const repo = fixture(t), lines: string[] = [];
  t.mock.method(console, "log", (...parts: unknown[]) => { lines.push(parts.join(" ")); });
  for (const first of ["late", "stopped"]) {
    const time = first === "late" ? [0, 1000, 1001, 1002, 6002, 6003, 10303] : [0, 1000, 1001, 1002, 5002, 6003, 10303],
      bounds: number[] = [];
    assert.deepEqual(runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY, priority,
      now: () => time.shift()!, readContext: () => "same", run: (_f: string, _a: string[], options: { timeout: number }) => {
        bounds.push(options.timeout);
        return bounds.length === 2 && first === "stopped" ? OVERRAN : { status: 0, stdout: PASS };
      } }), []);
    assert.deepEqual(bounds, [60000, 4000, 4400]);
    const runtime = JSON.parse(lines.filter((line) => line.startsWith("census-reader-runtime: ")).at(-1)!.slice(23));
    assert.equal(runtime.budgetMs, 4400);
    assert.equal(runtime.measuredMs, 4300);
    assert.match(runtime.remeasuredAfter, first === "late" ? /took 5000ms against 4000ms/ : /stopped at its 4000ms bound/);
  }
});

test("source-reader qualification refuses a reader that overruns both samples", (t) => {
  const repo = fixture(t);
  const late = [0, 1000, 1001, 1002, 6002, 6003, 11003];
  assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY, priority,
    now: () => late.shift()!, readContext: () => "same", run: () => ({ status: 0, stdout: PASS }) }), /exceeded its 4000ms measured budget/);
  let calls = 0;
  assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY, priority,
    readContext: () => "same", run: () => (calls++ === 0 ? { status: 0, stdout: PASS } : OVERRAN) }), /could not run to completion/);
});

test("source-reader calibration exercises real native context and children without a synthetic pass", (t) => {
  const repo = fixture(t);
  assert.deepEqual(runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY, priority }), []);
  assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: ["test/ghost.test.ts"], readerRuntimePolicy: POLICY, priority }), /ENOENT/);
  assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY, timeoutMs: 4000 }), /no timeout override/);
  assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: [FILE, FILE], readerRuntimePolicy: POLICY }), /one reader/);
});

test("source-reader calibration rejects a changed count or case identity even if both runs pass", (t) => {
  const repo = fixture(t);
  for (const changed of [PASS.replace("# tests 1", "# tests 2").replace("# pass 1", "# pass 2"), PASS.replace("reader works", "different reader")]) {
    let calls = 0;
    assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY, priority,
      readContext: () => "same", run: () => ({ status: 0, stdout: calls++ === 0 ? PASS : changed }) }), /case inventory differs/);
    assert.equal(calls, 2);
  }
});

test("source-reader native context refuses a regular file disguised as the dependency donor", (t) => {
  const repo = fixture(t); writeFileSync(join(repo.dir, "node_modules"), "not a donor"); let calls = 0;
  assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY, priority,
    run: () => { calls++; return { status: 0, stdout: PASS }; } }), /not a directory donor/);
  assert.equal(calls, 0);
});

test("source-reader snapshot dispatch reports unavailable calibration instead of dropping the policy", (t) => {
  const repo = fixture(t), path = join(repo.dir, "snapshot.json"), messages: string[] = [];
  writeFileSync(path, JSON.stringify({ version: 1, root: repo.dir, mergeBase: repo.git("rev-parse", "HEAD"),
    headPaths: [FILE], basePaths: [FILE], baseBlobs: { [FILE]: "old source" }, mainBlobs: {},
    instrumentSurface: [], instrumentExclusions: {} }));
  const prior = process.env.RMD_CENSUS_SNAPSHOT; process.env.RMD_CENSUS_SNAPSHOT = path;
  t.mock.method(console, "error", (...parts: unknown[]) => { messages.push(parts.join(" ")); });
  try {
    assert.equal(censusMain(["--root", repo.dir], {
      admitted: () => [{ testFile: FILE, script: "", walks: ["test/"], structural: true, readerRuntimePolicy: POLICY }],
      runSuites: () => { assert.fail("an unqualified snapshot adapter must not start a child"); },
    }), 2);
    assert(messages.some(line => line.includes("source-reader runtime calibration is unavailable in git-free snapshot mode")));
  } finally {
    if (prior === undefined) delete process.env.RMD_CENSUS_SNAPSHOT; else process.env.RMD_CENSUS_SNAPSHOT = prior;
  }
});

test("source-reader calibration admits a healthy real nested proof beyond the unrelated four-second limit", (t) => {
  const repo = fixture(t, 'import { spawnSync } from "node:child_process"; test("nested proof", () => { const r = spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 4200)"]); assert.equal(r.status, 0); });');
  assert.deepEqual(runCensusSuitesViaChild({ root: repo.dir, files: [FILE], readerRuntimePolicy: POLICY, priority }), []);
});

test("source-reader native timeout preserves its started runaway and closed capture rather than reporting a pass", (t) => {
  // The timer counts startup, so the runaway gets the budget this host's measured healthy startup earns.
  const healthy = fixture(t), startedMs = performance.now();
  assert.deepEqual(runCensusSuitesViaChild({ root: healthy.dir, files: [FILE], priority }), []);
  const finishedMs = performance.now();
  const timeoutMs = censusReaderBudget({ context: "startup", complete: true, passed: true, tests: 1,
    elapsedMs: finishedMs - startedMs, finishedMs }, "startup", POLICY, finishedMs);
  const marker = "OWN_READER_RUNAWAY_STARTED";
  const repo = fixture(t, `import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => {}); writeFileSync("started-control", ${JSON.stringify(marker)} + " " + process.pid); test("owned runaway", async () => new Promise(() => { setInterval(() => {}, 100); }));`);
  assert.throws(() => runCensusSuitesViaChild({ root: repo.dir, files: [FILE], timeoutMs, priority }), (error: Error) => {
    assert.match(error.message, new RegExp(`exceeded ${timeoutMs} ms.*capture retained at`));
    const dir = error.message.match(/capture retained at (.+)$/)![1];
    const native = JSON.parse(readFileSync(join(dir, "native.json"), "utf8"));
    assert.equal(native.error.code, "ERR_AUTHOR_STEP_TIMEOUT");
    assert.equal(native.outputComplete, false);
    assert.ok(native.finishedAt);
    const [started, pid] = readFileSync(join(repo.dir, "started-control"), "utf8").split(" ");
    assert.equal(started, marker);
    assert.throws(() => process.kill(Number(pid), 0), { code: "ESRCH" }, "the SIGTERM-ignoring runaway outlived its capture");
    return true;
  });
});
