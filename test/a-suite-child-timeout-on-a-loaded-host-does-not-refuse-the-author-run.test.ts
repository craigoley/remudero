/**
 * A CENSUS CHILD TIMEOUT ON A LOADED HOST DOES NOT REFUSE THE AUTHOR RUN — W1-T9919.
 *
 * census-precheck's census suite child has a 60 s BACKSTOP. At load 11-14 it fired on healthy trees, and
 * preflight-author refused the whole run on that exit 2, while pre-push already reads exit 2 as not measured.
 * census-precheck now names a backstop stop as its own NOT MEASURED line (elapsed ms, bound, suite count,
 * 1-minute load at start and end), and preflight-author goes on past that line ALONE; CI runs the suites.
 * Every other unmeasured census still refuses before the expensive validation.
 *
 * The census side drives runCensusSuitesViaChild with an injected `run` that returns a timed-out spawn, so
 * nothing waits 60 s. The author side runs preflight-author over a fixture tree whose census-precheck prints
 * the lines the REAL census main() printed for that case, so the two sides are joined by observed output.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
// @ts-ignore the executable .mjs module has no declaration file.
import * as census from "#scripts/census-precheck.mjs";
// @ts-ignore the executable .mjs module has no declaration file.
import * as author from "#scripts/preflight-author.mjs";

type Member = { testFile: string; script: string; walks: string[]; structural?: boolean };
type SpawnResult = { status: number | null; signal?: string | null; error?: Error; stdout?: string; stderr?: string };
type CensusResult = { status: number | null; signal?: string | null; error?: Error; stderr?: string; outputComplete?: boolean };

const MEMBER: Member = { testFile: "test/bounds-census.test.ts", script: "census:bounds", walks: ["lib/"] };
const OTHER: Member = { testFile: "test/other-census.test.ts", script: "", walks: ["lib/"], structural: true };
const SKILL_CENSUS = "test/rules/every-applies-to-skill-is-selectable-and-bounded.test.ts";
const NO_PRIORITY ={ priority: "none", wrap: (file: string, args: string[]) => ({ file, args: [...args] }) };

/** A spawn that the 60 s backstop stopped, in each shape a child runner reports it. */
const TIMED_OUT: SpawnResult[] = [
  { status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync /usr/bin/ionice ETIMEDOUT"), { code: "ETIMEDOUT" }) },
  { status: null, signal: null, error: Object.assign(new Error("native step exceeded 60000 ms"), { code: "ERR_AUTHOR_STEP_TIMEOUT" }) },
];

/** runCensusSuitesViaChild over `result`, with a clock that reads 60 234 ms elapsed and a load of 11.5 then 13.25. */
function timedChild(root: string, files: string[], result: SpawnResult): () => string[] {
  return () => {
    const clock = [1_000, 61_234];
    const loads = [11.5, 13.25];
    return census.runCensusSuitesViaChild({ root, files, priority: NO_PRIORITY, run: () => result,
      now: () => clock.shift(), load1: () => loads.shift() }) as string[];
  };
}

/** A git tree whose `work` branch grows `lib/`, the population MEMBER and OTHER walk. */
function censusTree(t: TestContext): string {
  const tree = gitRepo({ kind: "census-time-bound", scope: t });
  for (const dir of ["lib", "test"]) mkdirSync(join(tree.dir, dir), { recursive: true });
  writeFileSync(join(tree.dir, "lib/bounds.ts"), "export const A = 1;\n");
  // Present at the merge base, so a head-failing suite reaches its base run (never started: runSuites is injected).
  writeFileSync(join(tree.dir, MEMBER.testFile), "export {};\n");
  tree.git("add", "-A");
  tree.git("commit", "--quiet", "-m", "the base");
  tree.git("switch", "--quiet", "-c", "work");
  writeFileSync(join(tree.dir, "lib/bounds.ts"), "export const A = 1;\nexport const B = 2;\n");
  tree.git("add", "-A");
  tree.git("commit", "--quiet", "-m", "the change");
  return tree.dir;
}

/** census main() over a fresh tree with `runSuites`; returns its exit and everything it printed to stderr. */
function censusMain(t: TestContext, members: Member[], runSuites: (input: { root: string; files: string[] }) => string[]) {
  const err: string[] = [];
  const error = t.mock.method(console, "error", (...a: unknown[]) => void err.push(a.join(" ")));
  const log = t.mock.method(console, "log", () => undefined);
  try {
    const root = censusTree(t);
    // The always-on skill census joins every nonempty diff; the injected runs below are about the members alone.
    const memberRuns = (input: { root: string; files: string[] }) =>
      runSuites({ ...input, files: input.files.filter((f) => f !== SKILL_CENSUS) });
    return { status: census.main(["--root", root, "--base", "main"], { admitted: () => members, runSuites: memberRuns }) as number, err };
  } finally {
    error.mock.restore();
    log.mock.restore();
  }
}

/** The census lines main() prints when its one suite child is stopped on the backstop. */
function timeBoundCensusLines(t: TestContext): string[] {
  const out = censusMain(t, [MEMBER], ({ root, files }) => timedChild(root, files, TIMED_OUT[1])());
  assert.equal(out.status, 2, out.err.join("\n"));
  return out.err;
}

/** An author tree (the shape test/author-preflight.test.ts builds) whose census-precheck prints `lines` and exits `status`. */
function authorTree(t: TestContext, lines: string[], status: number) {
  const tree = gitRepo({ kind: "author-time-bound", seedCommit: false, scope: t });
  const root = tree.dir;
  for (const path of ["test/setup", "src", "scripts"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, ".nvmrc"), process.versions.node + "\n");
  writeFileSync(join(root, ".gitignore"), "node_modules\ncoverage\n");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package-lock.json"), readFileSync(join(REPO_ROOT, "package-lock.json")));
  writeFileSync(join(root, "scripts/diff-class.mjs"), "// This fixture has no census path readers.\n");
  writeFileSync(join(root, "test/setup/tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(root, "src/run-task.ts"),
    "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('coverage', { recursive: true }); writeFileSync('coverage/expensive-started', 'yes');\n");
  const leaf = (n: number) => `import { test } from 'node:test'; import assert from 'node:assert/strict'; test('leaf', () => assert.equal(${n}, ${n}));\n`;
  writeFileSync(join(root, "test/leaf.test.ts"), leaf(1));
  writeFileSync(join(root, "scripts/census-precheck.mjs"),
    `for (const line of ${JSON.stringify(lines)}) console.error(line);\nprocess.exitCode = ${status};\n`);
  tree.git("add", ".");
  tree.git("commit", "-m", "test: baseline");
  tree.git("remote", "add", "origin", root);
  tree.git("checkout", "-b", "run-unfiled-author-fixture");
  writeFileSync(join(root, "test/leaf.test.ts"), leaf(2));
  tree.git("add", ".");
  tree.git("commit", "-m", "test: change the leaf");
  const out: string[] = [];
  const log = t.mock.method(console, "log", (...a: unknown[]) => void out.push(a.join(" ")));
  const error = t.mock.method(console, "error", (...a: unknown[]) => void out.push(a.join(" ")));
  let exit: number;
  try {
    exit = author.main([], { root }) as number;
  } finally {
    log.mock.restore();
    error.mock.restore();
  }
  return { exit, out, root, receipt: JSON.parse(readFileSync(join(root, "coverage/preflight-author.json"), "utf8")) };
}

test("W1-T9919: a timed-out census child names its elapsed time, bound, suite count and load", (t) => {
  for (const result of TIMED_OUT) {
    assert.throws(timedChild("/repo", [MEMBER.testFile, OTHER.testFile], result), (e: Error & { censusTimeBound?: boolean }) => {
      assert.match(e.message, /could not run to completion: /);
      assert.ok(e.message.includes(result.error!.message), e.message);
      assert.match(e.message, /time bound: 60234 ms elapsed of the 60000 ms bound, 2 suite\(s\), 1-minute load 11\.50 at start and 13\.25 at end$/);
      assert.equal(e.censusTimeBound, true);
      return true;
    });
  }
  // Control: a spawn error that is not the time bound keeps its old text and no time-bound mark.
  const unreadable = { status: null, error: Object.assign(new Error("spawnSync node ENOENT"), { code: "ENOENT" }) };
  assert.throws(timedChild("/repo", [MEMBER.testFile], unreadable), (e: Error & { censusTimeBound?: boolean }) => {
    assert.equal(e.message, "the census suite child could not run to completion: spawnSync node ENOENT");
    assert.equal(e.censusTimeBound, undefined);
    return true;
  });
  // The CLI gives that stop its own NOT MEASURED label, and still exits 2 (pre-push reads 2 as not blocking).
  const lines = timeBoundCensusLines(t);
  const line = lines.find((l) => l.startsWith(`census-precheck: ${census.CENSUS_TIME_BOUND_LABEL} - `));
  assert.ok(line, lines.join("\n"));
  assert.match(line, /60234 ms elapsed of the 60000 ms bound, 1 suite\(s\), 1-minute load 11\.50 at start and 13\.25 at end$/);
  assert.ok(!lines.some((l) => / NOT MEASURED - /.test(l)), lines.join("\n"));
});

test("W1-T9919: a time-bound census child does not refuse the author run", (t) => {
  const lines = timeBoundCensusLines(t);
  assert.equal(author.censusTimeBoundOnly({ status: 2, stderr: lines.join("\n") }), true, lines.join("\n"));
  const run = authorTree(t, lines, 2);
  assert.equal(run.exit, 0, run.out.join("\n"));
  assert.equal(run.receipt.verdict, "passed", run.receipt.error);
  assert.deepEqual(run.receipt.censusNotMeasured, { reason: "time-bound", checkedBy: "CI" });
  const step = run.receipt.steps[0];
  assert.deepEqual([step.name, step.ok, step.notMeasured, step.exitCode], ["census-precheck", true, "time-bound", 2]);
  assert.ok(run.out.includes("census suites NOT MEASURED (time bound) — CI runs them"), run.out.join("\n"));
  assert.ok(run.out.some((l) => /^census-precheck: NOT MEASURED; /.test(l)), "the step never prints PASS for an unmeasured census");
  assert.deepEqual(run.receipt.steps.map((s: { name: string }) => s.name), ["census-precheck", "static-preflight", "affected-tests"]);
  assert.equal(existsSync(join(run.root, "coverage/expensive-started")), true, "the expensive validation ran");
});

test("W1-T9919: any other unmeasured census still refuses the author run", (t) => {
  // A census main() whose unmeasured causes are NOT the time bound alone keeps the refusing label.
  const plain = () => {
    throw new Error("the census suite child printed no `# tests` summary (exit 1): boom");
  };
  const mixed = ({ root, files }: { root: string; files: string[] }) =>
    files.includes(OTHER.testFile) ? plain() : timedChild(root, files, TIMED_OUT[0])();
  let headRuns = 0;
  // The head fails the suite, so the merge-base run decides; a stop THERE is not a healthy tree's time bound.
  const baseStopped = ({ root, files }: { root: string; files: string[] }) =>
    headRuns++ === 0 ? [MEMBER.testFile] : timedChild(root, files, TIMED_OUT[0])();
  const cases: [string, Member[], (input: { root: string; files: string[] }) => string[]][] = [
    ["no summary", [MEMBER], plain],
    ["time bound beside another cause", [MEMBER, OTHER], mixed],
    ["merge-base stop", [MEMBER], baseStopped],
  ];
  let refusing: string[] = [];
  for (const [name, members, runSuites] of cases) {
    const out = censusMain(t, members, runSuites);
    assert.equal(out.status, 2, `${name}: ${out.err.join("\n")}`);
    assert.ok(out.err.some((l) => l.startsWith("census-precheck: census suites NOT MEASURED - ")), `${name}: ${out.err.join("\n")}`);
    assert.ok(!out.err.some((l) => l.includes(census.CENSUS_TIME_BOUND_LABEL)), `${name}: ${out.err.join("\n")}`);
    assert.equal(author.censusTimeBoundOnly({ status: 2, stderr: out.err.join("\n") }), false, name);
    if (name === "no summary") refusing = out.err;
  }
  // The time-bound line is honoured only on a complete exit 2 with no other unmeasured or could-not-measure line.
  const timeBound = timeBoundCensusLines(t).join("\n");
  const others: CensusResult[] = [
    { status: 2, stderr: `${timeBound}\ncensus-precheck: instrument-surface NOT MEASURED - snapshot lacks declarations` },
    { status: 2, stderr: `${timeBound}\ncensus-precheck: could not measure — boom` },
    { status: 1, stderr: timeBound },
    { status: null, signal: "SIGKILL", stderr: timeBound },
    { status: 2, error: new Error("spawn failed"), stderr: timeBound },
    { status: 2, outputComplete: false, stderr: timeBound },
    { status: 2, stderr: "" },
  ];
  for (const result of others) assert.equal(author.censusTimeBoundOnly(result), false, JSON.stringify(result));
  // End to end: the author run refuses that census before any expensive phase starts.
  const run = authorTree(t, refusing, 2);
  assert.equal(run.exit, 1, run.out.join("\n"));
  assert.equal(run.receipt.verdict, "refused");
  assert.match(run.receipt.error, /census precheck could not measure the author tree; expensive validation was not started/);
  assert.deepEqual(run.receipt.steps.map((s: { name: string; ok: boolean }) => [s.name, s.ok]), [["census-precheck", false]]);
  assert.equal(run.receipt.censusNotMeasured, undefined);
  assert.equal(existsSync(join(run.root, "coverage/expensive-started")), false);
});
