// @not-a-rule-suite: drives the precheck's bounding function with fixtures; it walks no population of the tree and asserts no count.
/**
 * A CENSUS SUITE'S TIME BOUND COMES FROM ITS OWN MEASURED RUNTIME — W1-T13146.
 *
 * OBSERVED 2026-11-15/16 on the operator Mac: a census suite that passes 15 of 15 alone in 179.4 s was stopped at
 * the fixed 120 s backstop on four author preflights, and each over-capacity run was then not push-eligible.
 * The child now reads its bound from its own recorded runs on the host (the multiple of the floored median that
 * W1-T11100 prices a reader from); with no history, or after an overrun, the fixed backstop and today's label apply.
 *
 * Every case injects the child runner and the clock, so nothing here waits for a bound or runs a real suite.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
// @ts-ignore the executable .mjs module has no declaration file.
import * as census from "#scripts/census-precheck.mjs";

type Policy = { floorMs: number; multiple: number; remeasureMargin: number };
type SuiteHistory = { path: string | null; policy?: Partial<Policy>; runtime?: typeof RUNTIME };
type Bound = { ms: number; source: "history" | "backstop"; historyRuns: number };
type ChildResult = { status: number | null; stdout: string; signal?: string | null; error?: Error };
type Member = { testFile: string; script: string; walks: string[]; structural?: boolean; readerRuntimePolicy?: Policy };

/** A reader policy in the shape the admission table child hands every reader: W1-T11100's floor, multiple and margin
 *  (FAST_GATE_CENSUS_REFERENCE_FLOOR_MS, _RUNAWAY_MULTIPLE and _REMEASURE_MARGIN in src/lib/ci-parity.ts). A fixture:
 *  the bound function prices from whatever policy its caller hands it. */
const POLICY: Policy = { floorMs: 1000, multiple: 4, remeasureMargin: 1.1 };
const RUNTIME = { version: "v24.0.0", platform: "darwin", arch: "arm64", cores: 10 };
const SLOW = "test/slow-census.test.ts";
const OTHER = "test/other-census.test.ts";
const SKILL_CENSUS = "test/rules/every-applies-to-skill-is-selectable-and-bounded.test.ts";
const PASS = "TAP version 13\nok 1 - slow census holds\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
const FAIL = `TAP version 13\nnot ok 1 - slow census holds\n  ---\n  location: '/tree/${SLOW}:1:1'\n  ...\n1..1\n` +
  "# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n";
const identity = { wrap: (file: string, args: string[]) => ({ file, args }) };
const passed = (): ChildResult => ({ status: 0, stdout: PASS });
/** A child the bound stopped, as the native capture reports it. */
const stopped = (boundMs: number): ChildResult => ({ status: null, signal: null, stdout: "",
  error: Object.assign(new Error(`native step exceeded ${boundMs} ms`), { code: "ERR_AUTHOR_STEP_TIMEOUT" }) });

/** The bound of a child with no history: the fixed backstop, asked of the function under test. */
const backstopMs = (): number => (census.censusSuiteChildBound() as Bound).ms;

function store(t: TestContext): string {
  return join(ownedFixtureDir(t, "w13146-history").dir, "nested", "census-reader-history.json");
}

function seed(path: string, files: string[], runs: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, runs: { [census.censusSuiteChildHistoryKey(files, RUNTIME)]: runs } }));
}

const recorded = (path: string, files: string[]): number[] | undefined =>
  census.readCensusReaderHistory(path).runs[census.censusSuiteChildHistoryKey(files, RUNTIME)];

/** `policy: null` is a caller that has none to give. */
const boundOf = (path: string | null, files: string[], policy: Partial<Policy> | null = POLICY): Bound =>
  census.censusSuiteChildBound({ files, suiteHistory: { path, policy: policy ?? undefined, runtime: RUNTIME } });

/** One runCensusSuitesViaChild call over injected seams: the bound handed to each child, what it returned or threw. */
function drive(input: { files: string[]; times: number[]; outcome: (boundMs: number) => ChildResult; suiteHistory?: SuiteHistory;
  root?: string; readerRuntimePolicy?: Policy }) {
  const bounds: number[] = [];
  const times = [...input.times];
  let failing: string[] | undefined;
  let error: (Error & { censusTimeBound?: boolean }) | undefined;
  try {
    failing = census.runCensusSuitesViaChild({ root: input.root ?? "/tree", files: input.files, priority: identity,
      suiteHistory: input.suiteHistory, readerRuntimePolicy: input.readerRuntimePolicy, history: { path: null },
      now: () => times.shift()!, load1: () => 5.9, readContext: () => "same-runtime-input",
      run: (_file: string, _args: string[], options: { timeout: number }) => {
        bounds.push(options.timeout);
        return input.outcome(options.timeout);
      } }) as string[];
  } catch (e) {
    error = e as Error & { censusTimeBound?: boolean };
  }
  return { failing, error, bounds };
}

test("W1-T13146 criterion 1: a suite child with recorded runs is bounded by the policy multiple of their floored median, and a run that completes inside it is measured where the backstop would have ended it", (t) => {
  const path = store(t);
  seed(path, [SLOW], [179_000, 181_000, 183_000]);
  const bound = boundOf(path, [SLOW]);
  assert.deepEqual(bound, { ms: 181_000 * POLICY.multiple, source: "history", historyRuns: 3 });
  assert.ok(bound.ms > backstopMs(), "this history asks for more than the fixed backstop");
  const run = drive({ files: [SLOW], times: [0, 179_400], outcome: passed, suiteHistory: { path, policy: POLICY, runtime: RUNTIME } });
  assert.equal(run.error, undefined, run.error?.message);
  assert.deepEqual(run.failing, [], "the suite is measured, and it passes");
  assert.deepEqual(run.bounds, [bound.ms], "the child ran under its history bound");
  assert.ok(179_400 > backstopMs(), "the fixed backstop would have ended this run as not measured");
  assert.deepEqual(recorded(path, [SLOW]), [179_000, 181_000, 183_000, 179_400], "the completed runtime joins the history");
  // The rule is W1-T11100's: the reader budget is the same number, capped at the backstop.
  assert.equal(census.censusReaderHistoryBudget([179_000, 181_000, 183_000], POLICY), backstopMs());
  // The history is per child: another suite, and the same suite joined by another, have none of it.
  assert.equal(boundOf(path, [OTHER]).source, "backstop");
  assert.equal(boundOf(path, [SLOW, OTHER]).source, "backstop");
  assert.deepEqual(boundOf(path, [OTHER, SLOW]), boundOf(path, [SLOW, OTHER]), "a joined child is keyed by its suites, in any order");
});

test("W1-T13146 criterion 1: a history that asks for less than the backstop never lowers the bound, and the median is floored first", (t) => {
  const path = store(t);
  seed(path, [SLOW], [100, 200]);
  assert.deepEqual(boundOf(path, [SLOW]), { ms: backstopMs(), source: "backstop", historyRuns: 2 });
  seed(path, [SLOW], [22_000, 22_500, 23_000]);
  assert.deepEqual(boundOf(path, [SLOW]), { ms: backstopMs(), source: "backstop", historyRuns: 3 },
    "4 x 22.5 s is under the backstop: a healthy suite that took 93 s on a loaded host is not stopped at 90 s");
  const run = drive({ files: [SLOW], times: [0, 92_966], outcome: passed, suiteHistory: { path, policy: POLICY, runtime: RUNTIME } });
  assert.deepEqual([run.failing, run.bounds], [[], [backstopMs()]]);
});

test("W1-T13146 criterion 1: a source reader's calibration and qualification both run under its child's history bound", (t) => {
  const path = store(t);
  const root = ownedFixtureDir(t, "w13146-reader").dir;
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, SLOW), "export {};\n");
  seed(path, [SLOW], [backstopMs()]);
  const bound = boundOf(path, [SLOW]);
  assert.deepEqual(bound, { ms: backstopMs() * POLICY.multiple, source: "history", historyRuns: 1 });
  // Calibration 0 -> 179 400 ms, the budget read 1 ms later, qualification 179 400 ms more.
  const run = drive({ root, files: [SLOW], times: [0, 179_400, 179_401, 179_402, 358_802], outcome: passed,
    readerRuntimePolicy: POLICY, suiteHistory: { path, policy: POLICY, runtime: RUNTIME } });
  assert.equal(run.error, undefined, run.error?.message);
  assert.deepEqual(run.failing, []);
  assert.deepEqual(run.bounds, [bound.ms, bound.ms],
    "calibration under the child bound, and a qualification budget of 4 x 179.4 s capped at that same bound");
  assert.deepEqual(recorded(path, [SLOW]), [backstopMs(), 179_400, 179_400], "both completed runs join the history");
});

test("W1-T13146 criterion 2: a suite child with no history runs under the fixed backstop and stops as today's time bound, and the overrun is recorded so the next run's bound sees it", (t) => {
  const path = store(t);
  assert.deepEqual(boundOf(path, [SLOW]), { ms: backstopMs(), source: "backstop", historyRuns: 0 });
  const first = drive({ files: [SLOW], times: [0, backstopMs() + 46], outcome: stopped, suiteHistory: { path, policy: POLICY, runtime: RUNTIME } });
  assert.deepEqual(first.bounds, [backstopMs()], "no history: the fixed backstop");
  assert.equal(first.failing, undefined, "a stopped child is never a clean result");
  assert.equal(first.error?.censusTimeBound, true, "it carries the mark main() turns into today's label");
  assert.deepEqual(recorded(path, [SLOW]), [backstopMs()], "the overrun is recorded");
  assert.deepEqual(boundOf(path, [SLOW]), { ms: backstopMs() * POLICY.multiple, source: "history", historyRuns: 1 },
    "the next run's bound is the policy multiple of the bound that was too small");
  const second = drive({ files: [SLOW], times: [0, 179_400], outcome: passed, suiteHistory: { path, policy: POLICY, runtime: RUNTIME } });
  assert.deepEqual([second.failing, second.bounds], [[], [backstopMs() * POLICY.multiple]], "and the 179 s suite is measured on that run");
});

test("W1-T13146 criterion 2: a suite child that overruns its history bound stops as today's time bound, and its history restarts from the fixed backstop instead of climbing", (t) => {
  const path = store(t);
  seed(path, [SLOW], [179_000, 181_000, 183_000]);
  const boundMs = boundOf(path, [SLOW]).ms;
  const overrun = drive({ files: [SLOW], times: [0, boundMs + 50], outcome: stopped, suiteHistory: { path, policy: POLICY, runtime: RUNTIME } });
  assert.deepEqual(overrun.bounds, [boundMs]);
  assert.equal(overrun.error?.censusTimeBound, true);
  assert.deepEqual(recorded(path, [SLOW]), [backstopMs()], "the runs it no longer behaves like are dropped; the fixed backstop is what is known");
  const next = boundOf(path, [SLOW]);
  assert.deepEqual(next, { ms: backstopMs() * POLICY.multiple, source: "history", historyRuns: 1 });
  assert.ok(next.ms < boundMs, "an overrun never raises the next bound above the one it overran");
  // A child that hangs on every run keeps one bound: the tiers do not stack.
  for (let round = 0; round < 3; round++) {
    const hung = drive({ files: [SLOW], times: [0, next.ms + 50], outcome: stopped, suiteHistory: { path, policy: POLICY, runtime: RUNTIME } });
    assert.deepEqual(hung.bounds, [next.ms], `round ${round}`);
    assert.deepEqual(boundOf(path, [SLOW]), next, `round ${round}`);
  }
});

/** A git tree whose `work` branch grows `lib/`, which SLOW walks; READER walks `docs/` and only carries the policy. */
function censusTree(t: TestContext): string {
  const tree = gitRepo({ kind: "w13146-census", scope: t });
  for (const dir of ["lib", "test"]) mkdirSync(join(tree.dir, dir), { recursive: true });
  writeFileSync(join(tree.dir, "lib/bounds.ts"), "export const A = 1;\n");
  writeFileSync(join(tree.dir, SLOW), "export {};\n");
  tree.git("add", "-A");
  tree.git("commit", "--quiet", "-m", "the base");
  tree.git("switch", "--quiet", "-c", "work");
  writeFileSync(join(tree.dir, "lib/bounds.ts"), "export const A = 1;\nexport const B = 2;\n");
  tree.git("add", "-A");
  tree.git("commit", "--quiet", "-m", "the change");
  return tree.dir;
}

/** census main() over `root` with the store at `path`; the SLOW child returns `outcome` after `elapsedMs`. */
function censusMain(t: TestContext, root: string, path: string, elapsedMs: number, outcome: (boundMs: number, childRoot: string) => ChildResult) {
  const members: Member[] = [
    { testFile: SLOW, script: "", walks: ["lib/"], structural: true },
    { testFile: "test/reader-census.test.ts", script: "", walks: ["docs/"], structural: true, readerRuntimePolicy: POLICY },
  ];
  const err: string[] = [];
  const out: string[] = [];
  const bounds: number[] = [];
  const error = t.mock.method(console, "error", (...a: unknown[]) => void err.push(a.join(" ")));
  const log = t.mock.method(console, "log", (...a: unknown[]) => void out.push(a.join(" ")));
  try {
    const status = census.main(["--root", root, "--base", "main"], { admitted: () => members, suiteHistoryPath: path,
      runSuites: (input: { root: string; files: string[]; suiteHistory?: SuiteHistory }) => {
        // The always-on skill census joins every nonempty diff; this run is about SLOW alone.
        const files = input.files.filter((f) => f !== SKILL_CENSUS);
        if (files.length === 0) return [];
        const clock = [0, elapsedMs];
        return census.runCensusSuitesViaChild({ ...input, files, priority: identity, now: () => clock.shift()!, load1: () => 5.9,
          // main() keys the history by the host's own runtime; the fixture leaves that as it is.
          run: (_file: string, _args: string[], options: { timeout: number }) => { bounds.push(options.timeout); return outcome(options.timeout, input.root); } });
      } }) as number;
    return { status, err, out, bounds };
  } finally {
    error.mock.restore();
    log.mock.restore();
  }
}

test("W1-T13146 criterion 2: through main(), the first stop prints today's label alone and exits 2, and the next run of the same suite is measured under the bound that stop recorded", (t) => {
  const root = censusTree(t);
  const path = store(t);
  const first = censusMain(t, root, path, backstopMs() + 46, stopped);
  assert.equal(first.status, 2, first.err.join("\n"));
  assert.deepEqual(first.bounds, [backstopMs()]);
  const line = first.err.find((l) => l.startsWith(`census-precheck: ${census.CENSUS_TIME_BOUND_LABEL} - `));
  assert.ok(line, first.err.join("\n"));
  assert.ok(!first.err.some((l) => / NOT MEASURED - /.test(l)), "no refusing label beside it");
  const second = censusMain(t, root, path, 179_400, passed);
  assert.equal(second.status, 0, second.err.join("\n"));
  assert.deepEqual(second.bounds, [backstopMs() * POLICY.multiple]);
  assert.ok(second.out.some((l) => l.startsWith("census-precheck: OK")), second.out.join("\n"));
});

test("W1-T13146 criterion 3: a not-measured census line names the suite, its elapsed time, the bound applied and whether that bound came from history or the backstop", (t) => {
  const path = store(t);
  const fresh = drive({ files: [SLOW], times: [0, backstopMs() + 46], outcome: stopped, suiteHistory: { path, policy: POLICY, runtime: RUNTIME } });
  assert.match(fresh.error!.message, new RegExp(
    ` - ${SLOW.replaceAll(".", "\\.")} under the fixed backstop \\(no recorded run\\) - time bound: ${backstopMs() + 46} ms elapsed of the ${backstopMs()} ms bound, 1 suite\\(s\\), 1-minute load 5\\.90 at start and 5\\.90 at end$`));
  seed(path, [SLOW, OTHER], [179_000, 181_000, 183_000]);
  const boundMs = boundOf(path, [SLOW, OTHER]).ms;
  const learned = drive({ files: [SLOW, OTHER], times: [0, boundMs + 50], outcome: stopped, suiteHistory: { path, policy: POLICY, runtime: RUNTIME } });
  assert.match(learned.error!.message, new RegExp(
    ` - ${SLOW.replaceAll(".", "\\.")}, ${OTHER.replaceAll(".", "\\.")} under a bound from its history \\(3 recorded run\\(s\\)\\) - time bound: ${boundMs + 50} ms elapsed of the ${boundMs} ms bound, 2 suite\\(s\\), `));
  assert.ok(!learned.error!.message.includes("backstop"), "a history bound is not called the backstop");
  // The line main() prints carries the same four facts after today's label.
  const cli = censusMain(t, censusTree(t), store(t), backstopMs() + 46, stopped).err
    .find((l) => l.startsWith(`census-precheck: ${census.CENSUS_TIME_BOUND_LABEL} - `));
  assert.ok(cli);
  for (const fact of [SLOW, `${backstopMs() + 46} ms elapsed`, `of the ${backstopMs()} ms bound`, "under the fixed backstop (no recorded run)"]) {
    assert.ok(cli.includes(fact), `${fact}: ${cli}`);
  }
});

test("W1-T13146 criterion 4: invariant:a-hung-child-still-ends — every census suite child runs under a finite bound whatever its history or policy holds, and a hung child is never a clean result", (t) => {
  const cases: [string, (path: string) => void, Partial<Policy> | null][] = [
    ["no history file", () => undefined, POLICY],
    ["a history that is not JSON", (path) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "{ not json"); }, POLICY],
    ["runs that are not a list", (path) => seed(path, [SLOW], { ms: 500_000 }), POLICY],
    ["runs that are not runtimes", (path) => seed(path, [SLOW], [-5, 0, "500000", null]), POLICY],
    ["a runtime no budget can hold", (path) => seed(path, [SLOW], [1e300]), POLICY],
    ["a recorded history", (path) => seed(path, [SLOW], [179_000]), POLICY],
    ["no policy", (path) => seed(path, [SLOW], [179_000]), null],
    ["a policy with no multiple", (path) => seed(path, [SLOW], [179_000]), { floorMs: 1000 }],
    ["a policy whose multiple is not finite", (path) => seed(path, [SLOW], [179_000]), { floorMs: 1000, multiple: Infinity }],
    ["a policy whose floor is zero", (path) => seed(path, [SLOW], [179_000]), { floorMs: 0, multiple: 4 }],
  ];
  for (const [name, prepare, policy] of cases) {
    const path = store(t);
    prepare(path);
    const bound = boundOf(path, [SLOW], policy);
    assert.ok(Number.isSafeInteger(bound.ms) && bound.ms >= backstopMs(), `${name}: ${JSON.stringify(bound)}`);
    assert.equal(bound.source, name === "a recorded history" ? "history" : "backstop", name);
    const hung = drive({ files: [SLOW], times: [0, bound.ms + 1], outcome: stopped, suiteHistory: { path, policy: policy ?? undefined, runtime: RUNTIME } });
    assert.deepEqual(hung.bounds, [bound.ms], `${name}: the child was started under that bound`);
    assert.equal(hung.failing, undefined, `${name}: a hung child is never a clean result`);
    assert.equal(hung.error?.censusTimeBound, true, name);
  }
  // No history asked for at all (a snapshot-mode child, an injected timeout) is the fixed backstop too.
  assert.deepEqual(census.censusSuiteChildBound({ files: [SLOW] }), { ms: backstopMs(), source: "backstop", historyRuns: 0 });
  assert.deepEqual(boundOf(null, [SLOW]), { ms: backstopMs(), source: "backstop", historyRuns: 0 });
  assert.deepEqual(boundOf(store(t), []), { ms: backstopMs(), source: "backstop", historyRuns: 0 });
});

test("W1-T13146 criterion 4: a failing suite under a history bound still fails the precheck, is never read as not measured, and leaves the history as it was", (t) => {
  const path = store(t);
  seed(path, [SLOW], [179_000, 181_000, 183_000]);
  const failed = (): ChildResult => ({ status: 1, stdout: FAIL });
  const run = drive({ files: [SLOW], times: [0, 150_000], outcome: failed, suiteHistory: { path, policy: POLICY, runtime: RUNTIME } });
  assert.equal(run.error, undefined, run.error?.message);
  assert.deepEqual(run.failing, [SLOW], "the failing suite is named, not thrown as unmeasured");
  assert.deepEqual(recorded(path, [SLOW]), [179_000, 181_000, 183_000], "a failed run is neither a completed runtime nor an overrun");
  const verdict = census.evaluateAdmittedCensusSuites({ changed: ["lib/bounds.ts"],
    loadMembers: () => [{ testFile: SLOW, script: "", walks: ["lib/"], structural: true }],
    runSuites: (files: string[]) => drive({ files: files.filter((f) => f !== SKILL_CENSUS), times: [0, 150_000],
      outcome: files.includes(SLOW) ? failed : passed, suiteHistory: { path, policy: POLICY, runtime: RUNTIME } }).failing });
  assert.equal(verdict.unmeasured, null, "a failure is a verdict");
  assert.deepEqual(verdict.violations, [`census-suite: ${SLOW} fails — run node --test --import tsx ${SLOW}`]);
  // Through main(): red at the head and green at the merge base is exit 1 with the suite's row, and no not-measured line.
  const root = censusTree(t);
  const cli = censusMain(t, root, path, 150_000, (_boundMs, childRoot) => (childRoot === root ? failed() : passed()));
  assert.equal(cli.status, 1, cli.err.join("\n"));
  assert.ok(cli.err.some((l) => l.includes(`census-suite: ${SLOW} fails`)), cli.err.join("\n"));
  assert.ok(!cli.err.some((l) => l.includes("NOT MEASURED")), cli.err.join("\n"));
});

test("W1-T13146 criterion 4: the fix-lane controller's pinned total is the sum of the same per-suite bounds, and a child given no history runs under the bound that total is built from", (t) => {
  const report = census.snapshotControllerBudget() as { version: number; childTimeBoundMs: number; stages: Record<string, number>; timeoutMs: number };
  const fallback = census.censusSuiteChildBound() as Bound;
  assert.equal(report.childTimeBoundMs, fallback.ms, "the report states the bound function's own fallback");
  assert.equal(report.timeoutMs, Object.values(report.stages).reduce((sum, count) => sum + count * fallback.ms, 0),
    "the total is that bound once per stage");
  assert.equal(report.childTimeBoundMs, 120_000, "the value src/run-task.ts's fix-lane controller pins and refuses any other for");
  // A snapshot-mode round starts its children with no suite history, whatever the host's store holds for them.
  const path = store(t);
  seed(path, [SLOW], [179_000, 181_000, 183_000]);
  assert.equal(boundOf(path, [SLOW]).source, "history", "the store does hold a longer bound for this child");
  const snapshotChild = drive({ files: [SLOW], times: [0, 5_000], outcome: passed });
  assert.deepEqual(snapshotChild.bounds, [report.childTimeBoundMs]);
  assert.deepEqual(recorded(path, [SLOW]), [179_000, 181_000, 183_000], "and it records nothing");
});
