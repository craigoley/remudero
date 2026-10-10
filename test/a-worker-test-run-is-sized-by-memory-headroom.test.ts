// test/a-worker-test-run-is-sized-by-memory-headroom.test.ts — OBSERVED 2026-10-10 in the core daemon container: a
// worker's `node --test <many files>` at Node's default concurrency held 7–8 file children at 300–570 MB each, 2.8 GB for
// one tree, with no slot and no admission. Node refuses `--test-concurrency` in NODE_OPTIONS, so: `npm test` runs through
// a memory-sized slot (scripts/test-run.mjs), a slotted test run's concurrency is sized by headroom as well as CPU, and a
// hand-typed runner's file children wait in the setup preload until the headroom holds them.
// FIXTURES ONLY: every slot dir and admission dir lives under this test's tmp dirs; no seam reads the real host.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { admitTestFile, isTestRunnerArgv, type TestFileAdmissionOptions } from "../src/lib/test-file-admission.js";
import { boundedTestArgv, explicitTestConcurrency, NPM_TEST_SLOT_LABEL, runBoundedTest } from "../src/lib/test-run.js";
import { acquireTestSlot, memoryTestConcurrency, TEST_FILE_PEAK_BYTES, type TestSlotLease } from "../src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const SUITE = ["--test", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", "test/**/*.test.ts"];

function scratch(t: TestContext, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fixture slot pool on a 16-core host at no load, so the CPU-derived concurrency is 14 and memory decides below it. */
const pool = (dir: string, headroom: number | undefined) => ({
  dir, slots: 1, load: () => ({ cores: 16, load1: 0 }), memoryHeadroom: () => headroom, log: () => {}, binaryExists: () => false,
});

test("the package.json test entrypoint resolves to the memory-sized wrapper, and CI's test:ci is unchanged", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.test, 'node --import tsx scripts/test-run.mjs --test --import tsx --import ./test/setup/tmp-hygiene.ts "test/**/*.test.ts"');
  assert.match(readFileSync(join(REPO_ROOT, "scripts", "test-run.mjs"), "utf8"), /import \{ runBoundedTest \} from "\.\.\/src\/lib\/test-run\.ts"/);
  assert.doesNotMatch(pkg.scripts["test:ci"]!, /test-run\.mjs/, "CI's own entrypoint keeps its concurrency");
});

test("a test run's concurrency scales with injected memory headroom: per-file peak, at least one, CPU-capped only", (t) => {
  assert.equal(TEST_FILE_PEAK_BYTES, 512 * MiB);
  assert.equal(memoryTestConcurrency(undefined), undefined, "no reading sizes nothing");
  assert.equal(memoryTestConcurrency(0), 1, "the floor");
  assert.equal(memoryTestConcurrency(1.6 * GiB), 3);
  assert.equal(memoryTestConcurrency(64 * GiB), 128, "no fixed cap of its own");

  const sized = (headroom: number | undefined): TestSlotLease => {
    const lease = acquireTestSlot("sized", { ...pool(scratch(t, "sized-slots"), headroom), perFileBytes: TEST_FILE_PEAK_BYTES });
    lease.release();
    return lease;
  };
  assert.equal(sized(1.6 * GiB).concurrency, 3, "1.6 GiB holds three 512 MiB files");
  assert.equal(sized(4 * GiB).concurrency, 8);
  assert.equal(sized(0.2 * GiB).concurrency, 1, "a starved container still runs one file at a time");
  assert.equal(sized(100 * GiB).concurrency, 14, "a roomy host (a CI runner) keeps the CPU-derived count");
  assert.equal(sized(undefined).concurrency, 14, "no reading (macOS) keeps the CPU-derived count");
  const unsized = acquireTestSlot("unsized", pool(scratch(t, "unsized-slots"), 0.2 * GiB));
  unsized.release();
  assert.equal(unsized.concurrency, 14, "a run that names no per-file peak is sized by CPU alone, as before");
});

test("a sized test run reserves room for the live holders' named peaks and names its own as concurrency × per file", (t) => {
  const dir = scratch(t, "shared-slots");
  const opts = { ...pool(dir, 3 * GiB), slots: 2 };
  const typecheck = acquireTestSlot("typecheck", { ...opts, memoryBytes: 2 * GiB });
  const run = acquireTestSlot("suite", { ...opts, perFileBytes: TEST_FILE_PEAK_BYTES });
  assert.equal(run.outcome, "acquired");
  assert.equal(run.concurrency, 2, "3 GiB less the 2 GiB a cold typecheck named holds two files");
  const records = readdirSync(dir).map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as { label: string; memoryBytes?: number });
  assert.deepEqual(records.find((r) => r.label === "suite")?.memoryBytes, 2 * TEST_FILE_PEAK_BYTES);
  run.release();
  typecheck.release();

  const held = acquireTestSlot("typecheck", { ...opts, memoryBytes: 2 * GiB });
  const waited = acquireTestSlot("suite", { ...opts, memoryHeadroom: () => 2.2 * GiB, perFileBytes: TEST_FILE_PEAK_BYTES, waitBoundMs: 0 });
  assert.equal(waited.outcome, "wait_bound_exceeded", "a warm test run now waits on memory too, not only a cold tsc");
  assert.equal(waited.concurrency, 1);
  held.release();
});

test("npm test's wrapper runs the caller's node --test argv at the lease's concurrency, keeping a lower explicit one", async () => {
  assert.equal(explicitTestConcurrency(["--test", "--test-concurrency=2"]), 2);
  assert.equal(explicitTestConcurrency(["--test", "--test-concurrency", "5", "a.test.ts"]), 5);
  assert.equal(explicitTestConcurrency(SUITE), undefined);
  assert.deepEqual(boundedTestArgv(SUITE, 3), ["--test", "--test-concurrency=3", ...SUITE.slice(1)]);
  assert.deepEqual(boundedTestArgv(["--test", "--test-concurrency", "2", "a.test.ts"], 6), ["--test", "--test-concurrency=2", "a.test.ts"]);
  assert.deepEqual(boundedTestArgv(["--test", "--test-concurrency=9", "a.test.ts"], 2), ["--test", "--test-concurrency=2", "a.test.ts"]);

  const events: string[] = [];
  const lease: TestSlotLease = {
    outcome: "acquired", concurrency: 3, waitedMs: 0, note: "fixture slot", childEnvironment: { RMD_TEST_SLOT_PARENT: "{}" },
    refresh: () => events.push("refresh"), release: () => events.push("release"),
  };
  const seen: { file: string; args: readonly string[]; parent?: string }[] = [];
  const code = await runBoundedTest(SUITE, {
    acquireSlot: async (label) => { events.push(`acquire:${label}`); return lease; },
    spawn: async (file, args, env) => { seen.push({ file, args, parent: env.RMD_TEST_SLOT_PARENT }); events.push("spawn"); return 7; },
    binaryExists: () => false,
    log: () => {},
  });
  assert.equal(code, 7, "the runner's own exit code");
  assert.deepEqual(events, [`acquire:${NPM_TEST_SLOT_LABEL}`, "spawn", "release"]);
  assert.deepEqual(seen, [{ file: process.execPath, args: ["--test", "--test-concurrency=3", ...SUITE.slice(1)], parent: "{}" }]);
});

/** Seams for one file child of runner pid 100: its own pid 201, every process alive with start `s<pid>`. */
function child(dir: string, over: Partial<TestFileAdmissionOptions> = {}): TestFileAdmissionOptions {
  return {
    env: { NODE_TEST_CONTEXT: "child-v8" }, pid: 201, runnerPid: 100, dir,
    isRunner: (pid) => pid === 100, facts: (pid) => ({ start: `s${pid}`, parent: 100 }), rss: () => undefined,
    headroom: () => 4 * GiB, sleep: async () => {}, log: () => {}, ...over,
  };
}
const ticket = (dir: string, seq: number, pid: number, state: "waiting" | "running") =>
  writeFileSync(join(dir, `seq-${seq}`), JSON.stringify({ pid, start: `s${pid}`, state }));

test("a hand-run runner's file child waits while the headroom cannot hold it beside its running siblings' growth", async (t) => {
  const dir = scratch(t, "admit");
  ticket(dir, 1, 150, "running");
  ticket(dir, 2, 151, "running");
  let headroom = 0.9 * GiB;
  const reads: number[] = [];
  const admission = await admitTestFile(child(dir, {
    rss: (pid) => (pid === 150 ? 500 * MiB : 100 * MiB),
    headroom: () => { reads.push(headroom); return headroom; },
    sleep: async () => { headroom = 1.0 * GiB; },
  }));
  // Need: 512 MiB for itself + 12 MiB sibling 150 still grows + 412 MiB sibling 151 still grows = 936 MiB.
  assert.equal(admission.outcome, "admitted");
  assert.deepEqual(reads.slice(1), [0.9 * GiB, 1.0 * GiB], "waited at 0.9 GiB, admitted once 1.0 GiB held 936 MiB");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "seq-3"), "utf8")), { pid: 201, start: "s201", state: "running" });
  assert.equal(statSync(join(dir, "seq-3")).mode & 0o777, 0o600, "a ticket is owner-only");
  admission.release();
  assert.deepEqual(readdirSync(dir).sort(), ["seq-1", "seq-2"]);
});

test("file admission is first-come, keeps a floor of one, and ignores a dead sibling", async (t) => {
  const dir = scratch(t, "admit-order");
  ticket(dir, 1, 150, "waiting");
  let polls = 0;
  const behind = await admitTestFile(child(dir, {
    sleep: async () => { polls += 1; if (polls === 2) ticket(dir, 1, 150, "running"); },
  }));
  assert.equal(behind.outcome, "admitted");
  assert.equal(polls, 2, "a later child waits for an earlier waiting one even with room to spare");
  behind.release();

  const alone = scratch(t, "admit-floor");
  const floor = await admitTestFile(child(alone, { headroom: () => 0, sleep: async () => assert.fail("the floor never waits") }));
  assert.equal(floor.outcome, "admitted", "no running sibling: one file always progresses, whatever the headroom");
  floor.release();

  const ghosts = scratch(t, "admit-ghost");
  ticket(ghosts, 1, 150, "running");
  ticket(ghosts, 2, 151, "waiting");
  const past = await admitTestFile(child(ghosts, {
    headroom: () => 0, facts: (pid) => (pid === 150 || pid === 151 ? { start: "reused", parent: 1 } : { start: `s${pid}`, parent: 100 }),
    sleep: async () => assert.fail("a dead or pid-reused sibling is never waited on"),
  }));
  assert.equal(past.outcome, "admitted");
  past.release();
});

test("only a node --test runner's own file child queues: no reading, no runner context, or a non-runner parent run at once", async (t) => {
  const dir = scratch(t, "admit-skip");
  const never = async () => assert.fail("never waits");
  assert.equal((await admitTestFile(child(dir, { env: {}, sleep: never }))).outcome, "not-a-runner-child");
  assert.equal((await admitTestFile(child(dir, { headroom: () => undefined, sleep: never }))).outcome, "no-memory-reading");
  assert.equal((await admitTestFile(child(dir, { isRunner: () => false, sleep: never }))).outcome, "not-a-runner-child",
    "a subprocess a test spawns inherits NODE_TEST_CONTEXT but its parent is the test file, not a runner");
  assert.deepEqual(readdirSync(dir), [], "nothing recorded on a skip");
  assert.equal(isTestRunnerArgv(["node", "--test", "--import", "tsx", "a.test.ts"]), true);
  assert.equal(isTestRunnerArgv(["/usr/local/bin/node", "--test-concurrency=0", "--test-isolation=process", "a.test.ts"]), false,
    "a file child's argv carries --test-* options, never bare --test");
  assert.equal(isTestRunnerArgv(["bash", "-c", "node --test"]), false);

  const blocked = join(scratch(t, "admit-unusable"), "file");
  writeFileSync(blocked, "");
  const unqueued = await admitTestFile(child(join(blocked, "under-a-file"), { sleep: never }));
  assert.equal(unqueued.outcome, "unqueued", "an unusable admission dir runs the file and names why");
  const shared = scratch(t, "admit-shared");
  chmodSync(shared, 0o755);
  assert.equal((await admitTestFile(child(shared, { sleep: never }))).outcome, "unqueued", "a dir other users can read is never trusted");
  assert.deepEqual(readdirSync(shared), [], "and nothing is written into it");
});

test("the setup preload every runner child loads awaits file admission before any test file is imported", () => {
  const preload = readFileSync(join(REPO_ROOT, "test", "setup", "tmp-hygiene.ts"), "utf8");
  assert.match(preload, /import \{ admitTestFile \} from "\.\.\/\.\.\/src\/lib\/test-file-admission\.js";/);
  assert.match(preload, /const admission = await admitTestFile\(\);\n\s*process\.on\("exit", admission\.release\);/);
});
