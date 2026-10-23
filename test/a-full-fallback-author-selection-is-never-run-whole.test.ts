import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitRepo } from "#test/helpers/git-repo.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
type Budget = { workers: number; budgetMs: number; inputs: Record<string, unknown> };
type Selection = { fullRun: boolean; suites: string[]; narrow?: string[]; reasons: string[]; recentOnly: { floor: string[] } };
const author = (await import(pathToFileURL(join(ROOT, "scripts/preflight-author.mjs")).href)) as {
  main: (argv: string[], deps: { root: string; select?: (changed: string[], range: string) => Selection;
    host?: () => unknown; spawn?: typeof spawnSync; admitHost?: (stage: string) => unknown }) => number;
  hostBudget: (host: object, opts?: object) => Budget;
  deadlineHostBudget: (budget: Budget, opts: { deadline: number }) => Budget;
  capacityVerdict: (suites: string[], manifest: object, budget: Budget) => { fits: boolean };
  OVER_CAPACITY_EXIT: number;
  fullFallbackPartialSet: (opts: { root: string; changed: string[]; suites: string[]; fullRun: boolean; range: string;
    select: (changed: string[], range: string) => Selection; readInput?: (files: string[]) => { files: Map<string, string> } }) => {
    setAside: string[]; suites: string[]; unavailable?: string[];
    tiers: { changed: string[]; setAsideReaders: string[]; modelled: string[] } };
  partialSentence: (ran: number, total: number, setAside: string[]) => string;
};
const calibration = (await import(pathToFileURL(join(ROOT, "scripts/calibrate-author-runtime.mjs")).href)) as {
  calibrateAuthorRuntime: (opts: { root: string }) => { path: string };
};

const DEPLOY = "deploy/acr-login.sh";
const HELPER = "test/helpers/shared.ts";
const DEPLOY_REASON = `full run: ${DEPLOY} is outside what the selector models (the read map cannot speak for it: no read map supplied)`;
const CHANGED = "test/changed.test.ts", READER = "test/uses-helper.test.ts", MODELLED = "test/modelled.test.ts";
const DECOYS = ["test/decoy-one.test.ts", "test/decoy-three.test.ts", "test/decoy-two.test.ts"];
const ALL = [CHANGED, MODELLED, READER, ...DECOYS].sort();

/** Six trivial suites. The head commit changes a deploy script, a test helper, a src leaf and one test
 *  (`mixed`), or only `.gitignore`. READER imports the helper; nothing in the tree reaches the decoys. */
function fixture(change: "mixed" | "gitignore", manifest: Record<string, number> = {}) {
  const repo = gitRepo({ kind: "full-fallback-partial", seedCommit: false });
  const root = repo.dir;
  for (const dir of ["scripts", "test/setup", "test/helpers", "src", "deploy"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, ".nvmrc"), process.versions.node + "\n");
  writeFileSync(join(root, ".gitignore"), "coverage\nnode_modules\n");
  writeFileSync(join(root, "package-lock.json"), readFileSync(join(ROOT, "package-lock.json")));
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "scripts/test-duration-reporter.mjs"), readFileSync(join(ROOT, "scripts/test-duration-reporter.mjs")));
  writeFileSync(join(root, "scripts/test-tier-manifest.json"), JSON.stringify({ version: 1, thresholdMs: 10_000,
    files: { ...Object.fromEntries(ALL.map((suite) => [suite, 1500])), ...manifest } }));
  writeFileSync(join(root, "scripts/diff-class.mjs"), "// No census readers in this fixture.\n");
  writeFileSync(join(root, "scripts/census-precheck.mjs"), "console.log('fixture census passed');\n");
  writeFileSync(join(root, "test/setup/tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(root, "src/run-task.ts"), "console.log('fixture static preflight passed');\n");
  writeFileSync(join(root, "src/leaf.ts"), "export const leaf = 1;\n");
  writeFileSync(join(root, DEPLOY), "#!/bin/sh\necho login\n");
  writeFileSync(join(root, HELPER), "export const shared = 1;\n");
  const suite = (name: string) => `import { test } from 'node:test'; test('${name}', () => {});\n`;
  for (const file of [CHANGED, MODELLED, ...DECOYS]) writeFileSync(join(root, file), suite(file));
  // The fixture's own import is relative; this file's text names it through a variable.
  const helper = [".", "helpers", "shared.js"].join("/");
  writeFileSync(join(root, READER), `import { test } from 'node:test'; import { shared } from '${helper}';\n` +
    "test('reads the helper', () => { if (shared < 1) throw new Error('helper'); });\n");
  repo.git("add", "."); repo.git("commit", "-m", "test: full-fallback baseline");
  repo.git("remote", "add", "origin", root);
  repo.git("checkout", "-b", "run-unfiled-full-fallback-partial");
  if (change === "gitignore") writeFileSync(join(root, ".gitignore"), "coverage\nnode_modules\n*.swp\n");
  else {
    writeFileSync(join(root, DEPLOY), "#!/bin/sh\necho login again\n");
    writeFileSync(join(root, HELPER), "export const shared = 2;\n");
    writeFileSync(join(root, "src/leaf.ts"), "export const leaf = 2;\n");
    writeFileSync(join(root, CHANGED), suite("changed again"));
  }
  repo.git("add", "."); repo.git("commit", "-m", "fix: full-fallback head");
  return { root, cleanup: () => repo.cleanup(),
    receipt: () => JSON.parse(readFileSync(join(root, "coverage/preflight-author.json"), "utf8")),
    manifest: () => JSON.parse(readFileSync(join(root, "scripts/test-tier-manifest.json"), "utf8")) };
}

/** The injected selector: a deploy/ or .gitignore change is a full run; the modelled rest selects MODELLED. */
function selector() {
  const calls: string[][] = [];
  const select = (changed: string[]): Selection => {
    calls.push([...changed]);
    const trigger = changed.find((file) => file === DEPLOY || file === ".gitignore" || file === HELPER);
    if (trigger !== undefined) return { fullRun: true, suites: [], recentOnly: { floor: [] },
      reasons: [trigger === DEPLOY ? DEPLOY_REASON : `full run: ${trigger} is outside what the selector models`] };
    return { fullRun: false, suites: [MODELLED], reasons: ["fixture"], recentOnly: { floor: [] } };
  };
  return { select, calls };
}

/** A real spawn that records every argv, so the affected-tests suites can be read back. */
function recordingSpawn() {
  const calls: string[][] = [];
  const spawn = ((file: string, args: string[], opts: object) => {
    calls.push([file, ...args]);
    return spawnSync(file, args, opts as never);
  }) as unknown as typeof spawnSync;
  const testRuns = () => calls.filter((argv) => argv.includes("--test"))
    .map((argv) => argv.filter((arg) => /^test\/.*\.test\.ts$/.test(arg)));
  return { spawn, testRuns };
}

function run(t: { mock: { method: (...a: never[]) => { mock: { calls: { arguments: unknown[] }[] } } } },
  argv: string[], deps: Parameters<typeof author.main>[1]) {
  const logged = t.mock.method(console as never, "log" as never, (() => {}) as never);
  const status = author.main(argv, deps);
  return { status, output: logged.mock.calls.map((c) => c.arguments.join(" ")).join("\n") };
}

const host = () => ({ cores: 8, load1: 7, headroomBytes: 600 * 1024 ** 2 });

test("W1-T9953: a full-fallback selection names the file that forced it", (t) => {
  const f = fixture("mixed"); t.after(() => f.cleanup());
  const { select } = selector();
  const { status, output } = run(t as never, ["--dry-run"], { root: f.root, select });
  assert.equal(status, 0);
  const lines = output.split("\n");
  const at = lines.findIndex((line) => line.startsWith("author selection: full-fallback, 6 suite(s)"));
  assert.ok(at >= 0, output);
  assert.equal(lines[at + 1], `full-fallback because: ${DEPLOY_REASON}`, "the reason follows the selection line");
  assert.deepEqual(f.receipt().reasons, [DEPLOY_REASON], "the receipt keeps its reasons");
});

test("W1-T9953: a deadline that would fit the whole suite still runs only the partial set", (t) => {
  const huge = 1_000_000;
  const f = fixture("mixed", Object.fromEntries(DECOYS.map((suite) => [suite, huge]))); t.after(() => f.cleanup());
  const profile = calibration.calibrateAuthorRuntime({ root: f.root });
  const deadline = Date.now() + 3 * 60 * 60_000;
  const legacy = author.hostBudget(host());
  assert.equal(legacy.workers, 1);
  assert.equal(author.capacityVerdict(ALL, f.manifest(), author.deadlineHostBudget(legacy, { deadline })).fits, true,
    "positive control: the native deadline budget would carry every suite");
  assert.equal(author.capacityVerdict(ALL, f.manifest(), legacy).fits, false, "the host's own wall share would not");
  const { select } = selector();
  const { spawn, testRuns } = recordingSpawn();
  const { status } = run(t as never, ["--deadline", new Date(deadline).toISOString(), "--runtime-profile", profile.path],
    { root: f.root, select, host, spawn });
  const receipt = f.receipt();
  assert.equal(status, author.OVER_CAPACITY_EXIT, JSON.stringify(receipt.error ?? receipt.steps));
  assert.deepEqual(testRuns(), [[CHANGED, MODELLED, READER]], "the only test run is the partial set");
  for (const decoy of DECOYS) assert.ok(!testRuns().flat().includes(decoy), `${decoy} is CI's`);
  assert.equal(receipt.capacity.budgetSource, "legacy-wall-share", "a full fallback is priced against the host");
  assert.equal(receipt.runtimeAdmission.stage, "before-tests");
  assert.equal(receipt.runtimeAdmission.fits, true);
  assert.equal(receipt.runtimeAdmission.totalFiles, 3, "runtime admission judges the subset that runs");
});

test("W1-T9953: the partial set takes changed tests, set-aside readers and the modelled rest", (t) => {
  const f = fixture("mixed"); t.after(() => f.cleanup());
  const { select, calls } = selector();
  const { spawn, testRuns } = recordingSpawn();
  run(t as never, [], { root: f.root, select, host, spawn });
  const receipt = f.receipt();
  assert.deepEqual(receipt.partial.setAside, [DEPLOY, HELPER]);
  assert.deepEqual(receipt.partial.tiers, { changed: [CHANGED], setAsideReaders: [READER], modelled: [MODELLED] });
  assert.deepEqual(calls[1], ["src/leaf.ts", CHANGED], "the modelled rest is selected without the set-aside files");
  assert.deepEqual(receipt.partial.ran, [CHANGED, MODELLED, READER]);
  assert.deepEqual(testRuns(), [[CHANGED, MODELLED, READER]]);

  // Bounded by the host budget: the modelled suite the host cannot carry is left to CI, the rest still run.
  const bounded = fixture("mixed", { [MODELLED]: 10 * 60 * 60_000 }); t.after(() => bounded.cleanup());
  const second = recordingSpawn();
  run(t as never, [], { root: bounded.root, select: selector().select, host, spawn: second.spawn });
  const boundedReceipt = bounded.receipt();
  assert.deepEqual(boundedReceipt.partial.ran, [CHANGED, READER]);
  assert.deepEqual(boundedReceipt.tiered.skipped, [MODELLED]);
  assert.deepEqual(second.testRuns(), [[CHANGED, READER]]);
  assert.equal(boundedReceipt.capacity.budgetSource, "legacy-wall-share");
});

test("W1-T9953: a full-fallback run says it is partial and is never green", (t) => {
  const f = fixture("mixed"); t.after(() => f.cleanup());
  const { status, output } = run(t as never, [], { root: f.root, select: selector().select, host });
  const receipt = f.receipt();
  assert.equal(status, author.OVER_CAPACITY_EXIT);
  assert.equal(receipt.verdict, "over-capacity");
  assert.equal(receipt.selection, "over-capacity");
  assert.equal(receipt.selectedArm, "full-fallback");
  assert.equal(receipt.partial.leftToCi, 3);
  assert.deepEqual(receipt.partial.reasons, [DEPLOY_REASON]);
  const tests = receipt.steps.find((step: { name: string }) => step.name === "affected-tests-subset");
  assert.equal(tests?.ok, true, "the partial set itself passed");
  assert.ok(output.includes(`full-fallback: PARTIAL — ran 3 of 6 suite(s) chosen by reach and measured cost; ` +
    `CI's full run is the check for ${DEPLOY}, ${HELPER} and the other 3`), output);

  // Nothing reaches a .gitignore change: no suite step starts, and the same sentence says why.
  const empty = fixture("gitignore"); t.after(() => empty.cleanup());
  const none = run(t as never, [], { root: empty.root, select: selector().select, host });
  const skipped = empty.receipt();
  assert.equal(none.status, author.OVER_CAPACITY_EXIT);
  assert.equal(skipped.verdict, "over-capacity");
  assert.deepEqual(skipped.partial.ran, []);
  assert.ok(!skipped.steps.some((step: { name: string }) => step.name.startsWith("affected-tests")));
  const sentence = "full-fallback: PARTIAL — ran 0 of 6 suite(s) chosen by reach and measured cost; " +
    "CI's full run is the check for .gitignore and the other 6";
  assert.equal(skipped.affectedTestsNotRunReason, sentence);
  assert.ok(none.output.includes(`affected-tests: NOT RUN — ${sentence}`), none.output);
});

test("W1-T9953: a partial-set part that cannot be read is named, never silently empty", () => {
  const changed = [DEPLOY, "src/leaf.ts", CHANGED];
  const base = { root: "/nonexistent", changed, suites: ALL, fullRun: true, range: "a...b" };
  const broken = author.fullFallbackPartialSet({ ...base,
    readInput: () => { throw new Error("listing exploded"); },
    select: () => { throw new Error("selector exploded"); } });
  assert.deepEqual(broken.setAside, [DEPLOY]);
  assert.deepEqual(broken.suites, [CHANGED], "the changed test still runs");
  assert.deepEqual(broken.unavailable, ["set-aside readers could not be read: listing exploded",
    "modelled rest could not be selected: selector exploded"]);
  const restFellBack = author.fullFallbackPartialSet({ ...base, readInput: () => ({ files: new Map() }),
    select: () => ({ fullRun: true, suites: [], reasons: ["full run: again"], recentOnly: { floor: [] } }) });
  assert.deepEqual(restFellBack.unavailable, ["modelled rest fell back too: full run: again"]);
  const narrowed = author.fullFallbackPartialSet({ ...base, readInput: () => ({ files: new Map() }),
    select: () => ({ fullRun: false, suites: DECOYS, narrow: [MODELLED, "test/gone.test.ts"], reasons: [], recentOnly: { floor: [] } }) });
  assert.deepEqual(narrowed.tiers.modelled, [MODELLED], "the narrow arm wins, and only verified suites stay");
  assert.equal(narrowed.unavailable, undefined);
  // An empty affected floor is a full fallback with nothing set aside: only the changed tests run.
  let selected = false;
  const emptyFloor = author.fullFallbackPartialSet({ ...base, fullRun: false,
    select: () => { selected = true; throw new Error("not asked"); } });
  assert.deepEqual(emptyFloor.setAside, []);
  assert.deepEqual(emptyFloor.suites, [CHANGED]);
  assert.equal(selected, false);
  assert.equal(author.partialSentence(1, 6, []), "full-fallback: PARTIAL — ran 1 of 6 suite(s) chosen by reach and " +
    "measured cost; CI's full run is the check for the cause of the fallback and the other 5");
});


test("an author phase refused before test execution records no planned suite as ran", async (t) => {
  const { MacAuthorCapacityRefusal } = await import(pathToFileURL(join(ROOT, "scripts/lib/mac-author-admission.mjs")).href);
  for (const fullFallback of [true, false]) {
    const f = fixture("mixed", fullFallback ? {} : { [MODELLED]: 10 * 60 * 60_000 });
    t.after(() => f.cleanup());
    const recorded = recordingSpawn();
    const admitHost = (stage: string) => {
      if (stage === "affected-tests") throw new MacAuthorCapacityRefusal(stage, { state: "not-run", pressure: "warning" });
      return { stage, state: "admitted" };
    };
    const select = fullFallback ? selector().select : () => ({ fullRun: false, suites: ALL,
      reasons: ["fixture affected floor"], recentOnly: { floor: ALL } });
    const { status, output } = run(t as never, [], { root: f.root, select, host, spawn: recorded.spawn, admitHost });
    const receipt = f.receipt();
    assert.equal(status, author.OVER_CAPACITY_EXIT);
    assert.equal(receipt.verdict, "over-capacity");
    assert.deepEqual(recorded.testRuns(), [], "the refused test phase starts no child");
    assert.ok(receipt.tiered.planned.length > 0, "the selection is retained as a positive control");
    assert.deepEqual(receipt.tiered.ran, [], "a planned subset is not an execution receipt");
    assert.ok(!receipt.steps.some((step: { name: string }) => step.name.startsWith("affected-tests")));
    if (fullFallback) {
      assert.deepEqual(receipt.partial.planned, [CHANGED, MODELLED, READER]);
      assert.deepEqual(receipt.partial.ran, []);
      assert.equal(receipt.partial.leftToCi, ALL.length);
      assert.ok(!output.includes("PARTIAL — ran 3"), output);
    }
  }
});
