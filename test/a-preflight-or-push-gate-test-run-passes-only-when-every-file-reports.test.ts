import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { containmentProbeTestLeaf } from "#src/lib/ci-parity.js";
import { defaultPreflightSpawn, type PreflightSpawn } from "#src/lib/commit-message.js";
// Through the test helper, never src/run-task.ts directly: its direct importers are a shrink-only ceiling.
import { checkFixCensusSnapshot, checkFixCensusSnapshotAsync, runPreflightCiChecks } from "#test/helpers/run-task-test.js";
import { finishJudgedRun } from "#test/helpers/judged-pool-run.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
// @ts-ignore executable gate module.
import { runCensusSuitesViaChild } from "#scripts/census-precheck.mjs";

// W1-T8379: a `node --test` child can exit 0 without finishing. A file that calls `process.exit(0)` part-way loses
// its remaining tests, yet node still prints `# tests 1` and exits 0 — so a gate that reads exit status (or exit
// status plus a nonzero `# tests`) passes it. Each gate below now judges its run the way the CI runners do.

/** Registers one passing test, then exits 0 before the rest run: node's own summary still reads `# tests 1`. */
const STOPS = [
  'import { test } from "node:test";',
  'test("first passes", () => {});',
  'test("second exits", () => { process.exit(0); });',
  'test("third never runs", () => {});',
].join("\n");
/** The control: a file that runs to its own summary. */
const FINISHES = ['import { test } from "node:test";', 'test("only test passes", () => {});'].join("\n");

/** A throwaway root holding `files`, with the repo's dependencies linked so a cwd-relative `--import tsx` resolves. */
function fixtureRoot(t: TestContext, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-judged-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  for (const [path, text] of Object.entries({ "test/setup/tmp-hygiene.ts": "export {};\n", ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `${text}\n`);
  }
  return root;
}

test("the stopping fixture really exits 0 with a nonzero # tests, the reading every gate below used to pass", (t) => {
  const root = fixtureRoot(t, { "stops.test.ts": STOPS });
  const res = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--import", "tsx", "stops.test.ts"],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: undefined } });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^# tests 1$/m);
  assert.match(res.stdout, /^# fail 0$/m);
});

test("W1-T8379: a preflight census check whose suite exits 0 before its summary fails the step", (t) => {
  const root = fixtureRoot(t, {
    "test/help-renders-a-summary-not-a-paragraph.test.ts": STOPS,
    "test/deps-interface-census.test.ts": FINISHES,
  });
  // Every `node --test` child is the real one; only console-parity (an npm script this fixture has no tree for) is stubbed.
  const spawn: PreflightSpawn = (file, args, opts) =>
    file === "npm" ? { status: 0, stdout: "", stderr: "" } : defaultPreflightSpawn(file, args, opts);
  const result = runPreflightCiChecks(root, { spawn });
  const stopped = result.steps.find((s) => s.name === "ci-checks:command-registry-census")!;
  assert.equal(stopped.ok, false);
  assert.match(stopped.detail, /INCOMPLETE — its exit 0 is counted as FAILED/);
  assert.match(stopped.detail, /test-judge: UNREPORTED FILE \S*test\/help-renders-a-summary-not-a-paragraph\.test\.ts/);
  assert.match(stopped.detail, /second exits/, "the line names the test the run stopped in");
  assert.equal(result.ok, false);
  const control = result.steps.find((s) => s.name === "ci-checks:deps-interface-census")!;
  assert.equal(control.ok, true, control.detail);
});

test("W1-T8379: the containment probe fails when its suite exits 0 before its summary", (t) => {
  // The real spawn, minus this runner's own NODE_TEST_CONTEXT: under it a child `node --test` reports to its parent
  // instead of running its reporters, which is a run with no summary at all (and judged so).
  const spawn: PreflightSpawn = (file, args, opts) =>
    defaultPreflightSpawn(file, args, { ...opts, env: { ...opts?.env, NODE_TEST_CONTEXT: undefined } });
  const stopped = containmentProbeTestLeaf(fixtureRoot(t, { "test/containment.test.ts": STOPS }), spawn);
  assert.equal(stopped.ok, false);
  assert.match(stopped.detail, /test-judge: UNREPORTED FILE \S*test\/containment\.test\.ts/);
  assert.match(stopped.detail, /process\.exit\(0\)/, "the line names the exit that cut the run short");
  const control = containmentProbeTestLeaf(fixtureRoot(t, { "test/containment.test.ts": FINISHES }), spawn);
  assert.equal(control.ok, true, control.detail);
});

test("W1-T8379: census-precheck reports a census suite that exits 0 before its own summary as failing", (t) => {
  const root = fixtureRoot(t, { "stops.test.ts": STOPS, "finishes.test.ts": FINISHES });
  // Niced fixture children starve behind a loaded runner; the priority wrap is not under test here.
  const priority = { wrap: (file: string, args: string[]) => ({ file, args }) };
  assert.deepEqual(runCensusSuitesViaChild({ root, files: ["stops.test.ts", "finishes.test.ts"], priority }), ["stops.test.ts"]);
  assert.deepEqual(runCensusSuitesViaChild({ root, files: ["finishes.test.ts"], priority }), [], "a suite that finishes stays clean");
});

const REACH = "test/the-affected-suite-reach-ratchet.test.ts";
const BUDGET = { version: 1, childTimeBoundMs: 120_000,
  stages: { setup: 1, admission: 1, reach: 2, joinedGitFree: 2, structuralGitFree: 4 }, timeoutMs: 1_200_000 };

/** The fix round's census runner: the budget read and the precheck answer clean; the reach suite is `reach`. */
function censusRunner(reach: (args: string[], options: SpawnSyncOptionsWithStringEncoding) => { status: number | null; stdout: string }) {
  return (_file: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => {
    if (args.includes("--snapshot-budget")) return { status: 0, signal: null, stdout: JSON.stringify(BUDGET), stderr: "" };
    if (args[0]!.endsWith("census-precheck.mjs")) return { status: 0, signal: null, stdout: "", stderr: "" };
    assert.equal(args[0], "--test");
    return { signal: null, stderr: "", ...reach(args, options) };
  };
}

test("W1-T8379: a fix round reach-ratchet check refuses a run that stopped before its summary", async (t) => {
  const stopper = join(fixtureRoot(t, { "stops.test.ts": STOPS }), "stops.test.ts");
  const children: Array<{ status: number | null; stdout: string }> = [];
  // The REAL child, with the judge's own argv and env, over a suite that stops: the reach file's place is taken by it.
  const stops = censusRunner((args, options) => {
    const res = spawnSync(process.execPath, args.map((arg) => (arg === REACH ? stopper : arg)), options);
    children.push(res);
    return res;
  });
  const sync = checkFixCensusSnapshot(REPO_ROOT, "/fixture/snapshot.json", () => {}, stops as unknown as typeof spawnSync);
  const async = await checkFixCensusSnapshotAsync(REPO_ROOT, "/fixture/snapshot.json", () => {}, async (file, args, options) =>
    stops(file, args, options) as never);
  for (const outcome of [sync, async]) {
    assert.ok(outcome?.refusal, "a run that stopped before its summary refuses the push");
    assert.deepEqual(outcome.refusal.censuses, ["census-suite"]);
    assert.match(outcome.refusal.text, /census-suite: test\/the-affected-suite-reach-ratchet\.test\.ts fails — test-judge:/);
    assert.match(outcome.refusal.text, /process\.exit\(0\)/, "the refusal carries the judge's line naming the exit");
    assert.equal(outcome.unmeasured, undefined, "a stopped run is a refusal, not an unavailable measurement");
  }
  // The positive control on the child itself: it exited 0 with `# tests 1`, the reading this check used to pass.
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(child.status, 0);
    assert.match(child.stdout, /^# tests 1$/m);
  }
  // A reach run that reached its summary (its tally written as a finished run leaves it) still passes.
  const finished = censusRunner((args, options) => ({ ...finishJudgedRun(args, options), stdout: "# tests 1\n# pass 1\n# fail 0\n" }));
  assert.equal(checkFixCensusSnapshot(REPO_ROOT, "/fixture/snapshot.json", () => {}, finished as unknown as typeof spawnSync)?.refusal, undefined);
});
