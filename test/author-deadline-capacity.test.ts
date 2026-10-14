import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { makeRuntimeFixture } from "./helpers/native-runtime-fixture.js";

const author = await import(pathToFileURL(join(process.cwd(), "scripts/preflight-author.mjs")).href);
const calibration = await import(pathToFileURL(join(process.cwd(), "scripts/calibrate-author-runtime.mjs")).href);
const runtime = await import(pathToFileURL(join(process.cwd(), "scripts/lib/native-author-runtime.mjs")).href);

test("deadline capacity uses remaining fixed time without inventing CPU memory or lease workers", () => {
  assert.equal(typeof author.deadlineHostBudget, "function", "deadline-aware host budget is absent");
  const host = { cores: 16, load1: 0, headroomBytes: 64 * 1024 ** 3 };
  for (const slotConcurrency of [1, 2, 3, 4]) {
    const legacy = author.hostBudget(host, { slotConcurrency });
    const deadline = author.deadlineHostBudget(legacy, { now: 1_000, deadline: 1_000 + 60 * 60_000 });
    assert.equal(deadline.workers, legacy.workers);
    assert.equal(deadline.inputs.cpuWorkers, legacy.inputs.cpuWorkers);
    assert.equal(deadline.inputs.memoryWorkers, legacy.inputs.memoryWorkers);
    assert.equal(deadline.inputs.slotConcurrency, slotConcurrency);
    assert.equal(deadline.wallMs, 60 * 60_000 - runtime.AUTHOR_SHUTDOWN_RESERVE_MS);
    assert.equal(deadline.budgetMs, deadline.workers * deadline.wallMs);
    assert.equal(deadline.source, "validated-native-fixed-deadline");
    assert.equal(legacy.wallShare, author.AUTHOR_WALL_SHARE, "legacy object is never mutated");
    const later = author.deadlineHostBudget(legacy, { now: 121_000, deadline: 1_000 + 60 * 60_000 });
    assert.equal(deadline.wallMs - later.wallMs, 120_000, "static work spends the original deadline");
  }
  const squeezed = author.hostBudget(host, { slotConcurrency: 1 });
  assert.equal(author.deadlineHostBudget(squeezed, { now: 100_000, deadline: 1 }).budgetMs, 0);
  const hard = author.deadlineHostBudget(squeezed, { now: 0, deadline: 1e12 });
  assert.equal(hard.wallMs, squeezed.inputs.stepRuntimeMs, "the existing step ceiling still bounds time");
  for (const deadline of [NaN, Infinity, undefined]) assert.throws(() =>
    author.deadlineHostBudget(squeezed, { now: 0, deadline }), /invalid/);
  for (const now of [NaN, Infinity]) assert.throws(() =>
    author.deadlineHostBudget(squeezed, { now, deadline: 100_000 }), /invalid/);
  for (const workers of [0, 5, 1.5, NaN]) assert.throws(() =>
    author.deadlineHostBudget({ ...squeezed, workers }, { now: 0, deadline: 100_000 }), /invalid/);
  for (const stepRuntimeMs of [0, -1, 1.5, NaN, undefined]) assert.throws(() =>
    author.deadlineHostBudget({ ...squeezed, inputs: { ...squeezed.inputs, stepRuntimeMs } },
      { now: 0, deadline: 100_000 }), /invalid/);
});

test("a validated fixed-deadline author runs its whole selection with the workers it priced", (t) => {
  const f = makeRuntimeFixture(); t.after(() => f.cleanup());
  const suites = ["test/a.test.ts", "test/b.test.ts"];
  writeFileSync(join(f.dir, "scripts/test-tier-manifest.json"), JSON.stringify({ version: 1,
    thresholdMs: 10_000, files: Object.fromEntries(suites.map((file) => [file, 1_000_000])) }));
  f.git("add", "scripts/test-tier-manifest.json"); f.git("commit", "-m", "test: expensive manifest fixture");
  const profile = calibration.calibrateAuthorRuntime({ root: f.dir });
  const select = () => ({ fullRun: false, suites, reasons: ["fixture"], recentOnly: { floor: [] } });
  const host = () => ({ cores: 8, load1: 7, headroomBytes: 600 * 1024 ** 2 });
  const manifest = JSON.parse(readFileSync(join(f.dir, "scripts/test-tier-manifest.json"), "utf8"));
  assert.equal(author.capacityVerdict(suites, manifest, author.hostBudget(host())).fits, false,
    "positive control: the unchanged legacy 15-minute budget cannot carry this selection");
  const deadline = Date.now() + 60 * 60_000;
  const status = author.main(["--deadline", new Date(deadline).toISOString(), "--runtime-profile", profile.path],
    { root: f.dir, select, host });
  const receipt = JSON.parse(readFileSync(join(f.dir, "coverage/preflight-author.json"), "utf8"));
  assert.equal(status, 0); assert.equal(receipt.verdict, "passed");
  assert.equal(receipt.assurance, "author-only");
  assert.equal(receipt.hostedFullSuiteAndCoverage, "required-pending");
  assert.equal(receipt.capacity.fits, true);
  assert.equal(receipt.capacity.budgetSource, "validated-native-fixed-deadline");
  assert.equal(receipt.capacity.inputs.deadline, deadline);
  assert.equal(receipt.capacity.workers, 1); assert.equal(receipt.executionWorkers, 1);
  assert.equal(receipt.runtimeAdmission.workers, 1);
  assert.equal(receipt.runtimeAdmission.deadline, deadline);
  assert.equal(receipt.runtimeAdmission.fits, true);
  assert.equal(receipt.tiered, undefined);
  const tests = receipt.steps.find((step: { name: string }) => step.name === "affected-tests");
  assert.equal(tests.ok, true); assert.equal(tests.judge.complete, true);
  assert.equal(tests.judge.given, suites.length); assert.equal(tests.judge.reported, suites.length);
  assert.deepEqual(tests.judge.unreported, []);
  assert.equal(tests.testSummary.tests, 2); assert.equal(tests.testSummary.pass, 2);
  assert.equal(tests.testSummary.fail, 0);
});

test("a fixed deadline refuses a foreign profile before static or affected tests start", (t) => {
  const f = makeRuntimeFixture(); t.after(() => f.cleanup());
  const profile = calibration.calibrateAuthorRuntime({ root: f.dir });
  writeFileSync(join(f.dir, "src/leaf.ts"), "export const changed = 3;\n");
  f.git("add", "src/leaf.ts"); f.git("commit", "-m", "test: source moved after calibration");
  const status = author.main(["--deadline", new Date(Date.now() + 60 * 60_000).toISOString(),
    "--runtime-profile", profile.path], { root: f.dir,
    select: () => ({ fullRun: false, suites: ["test/a.test.ts", "test/b.test.ts"],
      reasons: ["fixture"], recentOnly: { floor: [] } }) });
  const receipt = JSON.parse(readFileSync(join(f.dir, "coverage/preflight-author.json"), "utf8"));
  assert.equal(status, 1); assert.equal(receipt.verdict, "refused");
  assert.match(receipt.error, /binding mismatch/);
  assert.equal(existsSync(join(f.dir, "coverage/static-started")), false);
  assert.equal(receipt.steps.some((step: { name: string }) => step.name.startsWith("affected-tests")), false);
});
