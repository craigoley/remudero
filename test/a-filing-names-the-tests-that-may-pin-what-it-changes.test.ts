/**
 * test/a-filing-names-the-tests-that-may-pin-what-it-changes.test.ts — W1-T14230.
 *
 * `lint-plan --base` lists the existing tests that import a src module a new or changed implement task declares
 * and name a word its design uses, as an advisory pinning-tests warning. Criteria 1-4 and 6 drive the check on
 * in-memory fixtures with an injected clock. Criteria 3 and 5 also run the production entry,
 * scripts/lint-plan-offline.mjs, as a child over a temp git repo, as
 * test/plan/the-plan-lint-checks-a-plan-that-lives-apart-from-its-code.test.ts does: a test that imports
 * src/run-task.ts in-process would grow the affected-reach importer ceiling.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { clockFromMillisFn, fixedClock, type Clock } from "#src/lib/clock.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import {
  pinningTestCandidates, pinningTestsApply, pinningTestViolations, readPinningTestInput, runPinningTests,
  type PinningTestInput,
} from "#src/lib/pinning-tests.js";
import { lintTask } from "#src/lib/task-linter.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const A_TS = [
  "export const FOO_LIMIT = 3;",
  "export const BAR_LIMIT = 4;",
  "export const BAZ_LIMIT = 5;",
  "export function readFooThing(): number { return FOO_LIMIT; }",
  'export const SELF_PATH = "src/lib/a.ts";',
  "",
].join("\n");
const B_TS = 'import { FOO_LIMIT } from "#src/lib/a.js";\nexport const twice = FOO_LIMIT * 2;\n';
const PACKAGE_JSON = `${JSON.stringify({ name: "fixture", type: "module", imports: { "#src/*": "./src/*" } })}\n`;

/** The fixture tree: the pinning test, and one test per precision filter. */
const FIXTURE_TESTS: Record<string, string> = {
  "test/x.test.ts": 'import { FOO_LIMIT } from "#src/lib/a.js";\nassert.equal(FOO_LIMIT, 3);\n',
  "test/no-token.test.ts": 'import * as a from "#src/lib/a.js";\nvoid a;\n',
  "test/through-b.test.ts": 'import { twice } from "#src/lib/b.js";\nconst FOO_LIMIT = 3;\nassert.equal(twice, 2 * FOO_LIMIT);\n',
  "test/foreign.test.ts": 'import * as a from "#src/lib/a.js";\nconst NOT_IN_A_MODULE = a;\n',
  "test/comment-only.test.ts": 'import * as a from "#src/lib/a.js";\n// FOO_LIMIT is only in a comment here\nvoid a;\n',
};

const SRC: Record<string, string> = { "src/lib/a.ts": A_TS, "src/lib/b.ts": B_TS };

function taskYaml(id: string, o: { design: string; files?: string[]; note?: string; type?: string }): string {
  return [
    `- id: ${id}`, `  title: "pinning tests fixture ${id}"`, "  repo: remudero", "  depends_on: []",
    `  type: ${o.type ?? "implement"}`, "  verify: human", "  risk: high", "  status: queued",
    '  origin: "W1-T14230 test fixture"',
    `  design: ${JSON.stringify(`NO-INVARIANTS: synthetic lint fixture with no inherited behavior to preserve. ${o.design}`)}`,
    ...(o.note === undefined ? [] : [`  note: ${JSON.stringify(o.note)}`]),
    `  files: [${(o.files ?? ["src/lib/a.ts", "test/new.test.ts"]).join(", ")}]`,
    "  acceptance:", '    - claim: "something is proven"', '      proof: "unit test: test/new.test.ts"', "",
  ].join("\n");
}

const parse = (yaml: string) => loadPlanFromYaml(yaml, "fixture.yaml").tasks[0]!;

/** The in-memory input. The repo's own package.json maps #src/* to ./src/*, as the fixture repo's does. */
function input(tests: Record<string, string>, clock: Clock = fixedClock(0)): PinningTestInput {
  return { tests: new Map(Object.entries(tests)), srcText: (p) => SRC[p], aliasRoot: REPO_ROOT, clock };
}

const DESIGN = "Raise FOO_LIMIT to 5. NOT_IN_A_MODULE stays.";

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text, "utf8");
}

function commit(repo: GitRepo, message: string): void {
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", message);
}

/** A repo whose base commit holds the source, the tests and `baseRecords` in the monolith; branch `base` marks it. */
function fixtureRepo(t: { after: (fn: () => void) => void }, baseRecords: string[]): GitRepo {
  const repo = gitRepo({ kind: "w1-t14230" });
  t.after(() => repo.cleanup());
  for (const [rel, text] of Object.entries({ ...SRC, ...FIXTURE_TESTS, "package.json": PACKAGE_JSON })) put(repo.dir, rel, text);
  put(repo.dir, "plan/tasks.yaml", baseRecords.length === 0 ? "[]\n" : baseRecords.join(""));
  commit(repo, "base");
  repo.git("branch", "base");
  return repo;
}

/** Runs the production entry, scripts/lint-plan-offline.mjs, as a child over the fixture repo. */
function lint(repo: GitRepo, args: string[]): { code: number | null; output: string; events: Record<string, unknown>[] } {
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
    join(REPO_ROOT, "scripts/lint-plan-offline.mjs"), "--repo-root", repo.dir, ...args], {
    cwd: repo.dir, encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", LANG: "C", TZ: "UTC" },
  });
  assert.equal(r.error, undefined, "the offline lint child completes");
  const output = `${r.stdout}${r.stderr}`;
  const events = output.split("\n").filter((l) => l.startsWith("{") && l.includes('"lint_plan.pinning_tests"'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { code: r.status, output, events };
}

function captureEvents<T>(fn: () => T): { result: T; events: Record<string, unknown>[] } {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    const result = fn();
    const events = lines.filter((l) => l.includes('"lint_plan.pinning_tests"')).map((l) => JSON.parse(l) as Record<string, unknown>);
    return { result, events };
  } finally {
    console.error = orig;
  }
}

test("W1-T14230 criterion 1: a test that imports the declared module and names a design token is one warn, and lint stays ok", () => {
  const task = parse(taskYaml("ZZ-T1", { design: DESIGN }));
  const got = pinningTestCandidates(task, input(FIXTURE_TESTS));
  assert.equal(got.outcome, "ran");
  if (got.outcome !== "ran") return;
  assert.deepEqual(got.listed.map((l) => l.path), ["test/x.test.ts"]);
  const v = pinningTestViolations(task, got);
  assert.equal(v.length, 1);
  assert.equal(v[0]!.check, "pinning-tests");
  assert.equal(v[0]!.severity, "warn");
  assert.match(v[0]!.message, /test\/x\.test\.ts \(FOO_LIMIT\)/);
  assert.match(v[0]!.message, /^task ZZ-T1 declares src\/lib\/a\.ts\. /);
  assert.match(v[0]!.message, /ADVISORY, never blocking/);
  const base = lintTask(task);
  const ok = [...base.violations, ...v].every((x) => x.severity !== "block");
  assert.equal(ok, base.ok, "the advisory never changes the task's ok");
});

test("W1-T14230 criterion 2: a test with no token, one that reaches the module through another, and a foreign token are not listed", () => {
  const task = parse(taskYaml("ZZ-T1", { design: DESIGN }));
  const got = pinningTestCandidates(task, input(FIXTURE_TESTS));
  assert.equal(got.outcome, "ran");
  if (got.outcome !== "ran") return;
  const paths = got.listed.map((l) => l.path);
  assert.ok(!paths.includes("test/no-token.test.ts"), "imports a.ts but names no design token");
  assert.ok(!paths.includes("test/through-b.test.ts"), "names FOO_LIMIT but reaches a.ts only through b.ts");
  assert.ok(!paths.includes("test/foreign.test.ts"), "names only a token src/lib/a.ts does not contain");
  assert.ok(!paths.includes("test/comment-only.test.ts"), "names the token only in a comment");
  assert.deepEqual(got.tokens, ["FOO_LIMIT"], "NOT_IN_A_MODULE is not in src/lib/a.ts, so it is not a token");
});

test("W1-T14230 criterion 3: tests in files: or named by design or note are not listed; other types and unchanged tasks are not checked", (t) => {
  const inFiles = parse(taskYaml("ZZ-T1", { design: DESIGN, files: ["src/lib/a.ts", "test/x.test.ts"] }));
  const inDesign = parse(taskYaml("ZZ-T1", { design: `${DESIGN} test/x.test.ts only reads it.` }));
  const inNote = parse(taskYaml("ZZ-T1", { design: DESIGN, note: "test/x.test.ts does not change" }));
  for (const task of [inFiles, inDesign, inNote]) {
    const got = pinningTestCandidates(task, input(FIXTURE_TESTS));
    assert.equal(got.outcome, "ran");
    if (got.outcome === "ran") assert.equal(got.listed.length, 0);
    assert.equal(pinningTestViolations(task, got).length, 0);
  }
  const task = parse(taskYaml("ZZ-T1", { design: DESIGN }));
  assert.equal(pinningTestsApply(task, undefined), true, "a new implement task is checked");
  assert.equal(pinningTestsApply(parse(taskYaml("ZZ-T1", { design: DESIGN, type: "recon" })), undefined), false);
  assert.equal(pinningTestsApply(task, parse(taskYaml("ZZ-T1", { design: DESIGN, note: "only the note moved" }))), false);
  assert.equal(pinningTestsApply(task, parse(taskYaml("ZZ-T1", { design: "Raise FOO_LIMIT to 4." }))), true);
  assert.equal(pinningTestsApply(task, parse(taskYaml("ZZ-T1", { design: DESIGN, files: ["src/lib/a.ts"] }))), true);
  // The production path: a note-only edit of an implement task is linted but gets no pinning-tests finding.
  const repo = fixtureRepo(t, [taskYaml("ZZ-OLD", { design: DESIGN })]);
  put(repo.dir, "plan/tasks.yaml", taskYaml("ZZ-OLD", { design: DESIGN, note: "a note-only edit" }));
  commit(repo, "head edits the note");
  const run = lint(repo, ["--base", "base"]);
  assert.match(run.output, /1 task\(s\) checked/, run.output);
  assert.doesNotMatch(run.output, /pinning-tests|lint_plan\.pinning_tests/, run.output);
});

test("W1-T14230 criterion 4: with 14 candidates the message names the 10 highest scores and says how many more", () => {
  // Every test names FOO_LIMIT (1/14 each), t00-t04 also BAR_LIMIT (1/5), and t00 also BAZ_LIMIT (1).
  const tests: Record<string, string> = {};
  for (let i = 0; i < 14; i++) {
    const used = ["FOO_LIMIT", ...(i < 5 ? ["BAR_LIMIT"] : []), ...(i === 0 ? ["BAZ_LIMIT"] : [])].join(", ");
    tests[`test/t${String(i).padStart(2, "0")}.test.ts`] = `import { ${used} } from "#src/lib/a.js";\nassert.ok([${used}]);\n`;
  }
  const task = parse(taskYaml("ZZ-T1", { design: "Change FOO_LIMIT, BAR_LIMIT and BAZ_LIMIT." }));
  const got = pinningTestCandidates(task, input(tests));
  assert.equal(got.outcome, "ran");
  if (got.outcome !== "ran") return;
  assert.equal(got.listed.length, 14);
  assert.equal(got.listed[0]!.path, "test/t00.test.ts");
  assert.ok(Math.abs(got.listed[0]!.score - (1 / 14 + 1 / 5 + 1)) < 1e-9);
  assert.deepEqual(got.listed.slice(1, 5).map((l) => l.path), ["test/t01.test.ts", "test/t02.test.ts", "test/t03.test.ts", "test/t04.test.ts"]);
  const message = pinningTestViolations(task, got)[0]!.message;
  const named = [...message.matchAll(/test\/t(\d\d)\.test\.ts/g)].map((m) => m[1]);
  assert.deepEqual(named, ["00", "01", "02", "03", "04", "05", "06", "07", "08", "09"]);
  assert.match(message, /test\/t09\.test\.ts \(FOO_LIMIT\) and 4 more\. They may pin the old behaviour\./);
});

test("W1-T14230 criterion 5: lint-plan --base warns, returns 0 and writes one event; without --base it does neither", (t) => {
  const repo = fixtureRepo(t, []);
  put(repo.dir, "plan/tasks.d/ZZ-T1-pinning-tests-fixture.yaml", taskYaml("ZZ-T1", { design: DESIGN }));
  commit(repo, "head adds ZZ-T1");
  const run = lint(repo, ["--base", "base"]);
  assert.equal(run.code, 0, run.output);
  assert.match(run.output, /⚠ ZZ-T1: \[pinning-tests\] task ZZ-T1 declares src\/lib\/a\.ts\. [^\n]*test\/x\.test\.ts \(FOO_LIMIT\)/);
  assert.equal(run.events.length, 1, run.output);
  const e = run.events[0]!;
  assert.equal(e.task, "ZZ-T1");
  assert.equal(e.outcome, "ran");
  assert.deepEqual(e.listed, ["test/x.test.ts"]);
  assert.deepEqual(e.tokens, ["FOO_LIMIT"]);
  assert.equal(typeof e.ms, "number");
  const whole = lint(repo, []);
  assert.doesNotMatch(whole.output, /\[pinning-tests\]/, whole.output);
  assert.equal(whole.events.length, 0);
});

test("W1-T14230 criterion 6: a clock past the 10000 ms budget stops the check with one warn and an over_budget event", (t) => {
  const task = parse(taskYaml("ZZ-T1", { design: DESIGN }));
  let ms = 0;
  const got = pinningTestCandidates(task, { ...input(FIXTURE_TESTS, clockFromMillisFn(() => (ms += 6_000))), startedAt: 0 });
  assert.equal(got.outcome, "over_budget");
  const v = pinningTestViolations(task, got);
  assert.equal(v.length, 1);
  assert.equal(v[0]!.severity, "warn");
  assert.match(v[0]!.message, /^pinning-tests did not run: over its 10000 ms budget after \d+ ms$/);
  // Control: a clock that stands still lets the same input run.
  assert.equal(pinningTestCandidates(task, input(FIXTURE_TESTS)).outcome, "ran");
  // The unit lintPlanCommand's --base pass calls: it reads the clock, writes the over_budget event, and its only
  // violation is that warn, so the lint result's ok, and so lintPlanCommand's exit code, stay as they were.
  const repo = fixtureRepo(t, []);
  let at = 0;
  const { result, events } = captureEvents(() => runPinningTests(task, repo.dir, clockFromMillisFn(() => (at += 6_000))));
  assert.equal(result.outcome, "over_budget");
  assert.deepEqual(events.map((e) => [e.task, e.outcome]), [["ZZ-T1", "over_budget"]]);
  assert.equal(typeof events[0]!.ms, "number");
  const after = pinningTestViolations(task, result);
  assert.deepEqual(after.map((x) => x.severity), ["warn"]);
  const base = lintTask(task);
  assert.equal([...base.violations, ...after].every((x) => x.severity !== "block"), base.ok);
});

test("W1-T14230: the reader greps only the importers, and a read failure, no token or a late start lists nothing", (t) => {
  const repo = fixtureRepo(t, []);
  put(repo.dir, "src/lib/c.ts", "export const LONELY_LIMIT = 1;\n");
  commit(repo, "a module no test imports");
  const read = readPinningTestInput(repo.dir, ["src/lib/a.ts"]);
  assert.deepEqual([...read.tests.keys()].sort(), ["test/comment-only.test.ts", "test/foreign.test.ts", "test/no-token.test.ts", "test/x.test.ts"]);
  assert.equal(readPinningTestInput(repo.dir, ["src/lib/c.ts"]).tests.size, 0, "git grep's exit 1 is an empty list");
  assert.equal(readPinningTestInput(repo.dir, ["src/lib/absent.ts"]).tests.size, 0, "a module that does not exist is not grepped");
  const task = parse(taskYaml("ZZ-T1", { design: DESIGN }));
  const outside = mkdtempSync(join(tmpdir(), "rmd-w1-t14230-not-a-repo-"));
  put(outside, "src/lib/a.ts", A_TS);
  const lonely = parse(taskYaml("ZZ-T2", { design: "Raise LONELY_LIMIT.", files: ["src/lib/c.ts"] }));
  const { result, events } = captureEvents(() => [
    runPinningTests(lonely, repo.dir, fixedClock(0)),
    runPinningTests(task, outside, fixedClock(0)),
  ]);
  const [none, broken] = result;
  assert.deepEqual(none!.outcome === "ran" ? none!.listed : "not ran", []);
  assert.equal(broken!.outcome, "unreadable");
  assert.equal(pinningTestViolations(task, broken!).length, 0, "a read failure adds no violation");
  assert.deepEqual(events.map((e) => [e.task, e.outcome]), [["ZZ-T2", "ran"], ["ZZ-T1", "unreadable"]]);
  assert.deepEqual(events[0]!.listed, [], "the event is written when nothing is listed, too");
  assert.equal(typeof events[1]!.reason, "string");
  const noToken = pinningTestCandidates(parse(taskYaml("ZZ-T1", { design: "Nothing named here." })), input(FIXTURE_TESTS));
  // A quoted path is the import itself, which every importer names; a quoted message is a token.
  const quoted = pinningTestCandidates(parse(taskYaml("ZZ-T1", {
    design: 'The prefilter greps "src/lib/a". The reply "the limit doubles" goes.' })), input(FIXTURE_TESTS));
  assert.deepEqual(quoted.outcome === "ran" ? [quoted.tokens, quoted.listed] : "not ran", [[], []], "src/lib/a is not a token");
  assert.deepEqual(noToken.outcome === "ran" ? [noToken.tokens, noToken.listed] : "not ran", [[], []]);
  const late = pinningTestCandidates(task, { ...input(FIXTURE_TESTS, fixedClock(20_000)), startedAt: 0 });
  assert.deepEqual(late, { outcome: "over_budget", budgetMs: 10_000, ms: 20_000 });
});
