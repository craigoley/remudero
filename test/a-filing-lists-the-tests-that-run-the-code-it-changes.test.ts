/**
 * test/a-filing-lists-the-tests-that-run-the-code-it-changes.test.ts — W1-T14512.
 *
 * A filing lists the tests that run the code it changes: the pinning-tests advisory reads the nightly test impact
 * map, and warns when no design symbol is in the declared files. Each criterion drives runPinningTests over a
 * fixture git repo with a small map written under its git common dir. Criteria 1 and 4 also run the production
 * entry, scripts/lint-plan-offline.mjs, as a child.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs, { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import { clockFromMillisFn, fixedClock, type Clock } from "#src/lib/clock.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import {
  PINNING_IMPACT_MAP_FILE, PINNING_TESTS_NAMED_WITH_MAP, pinningTestViolations, runPinningTests,
  type PinningTestCandidates,
} from "#src/lib/pinning-tests.js";
import { lintTask } from "#src/lib/task-linter.js";
import { IMPACT_MAP_FORMAT, IMPACT_MAP_STALENESS_BOUND } from "#src/lib/test-impact-map.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/** Line 2-4 is fooTotal, line 5-7 is hubThing: the map's function rows below use these lines. */
const A_TS = [
  "export const FOO_LIMIT = 3;",
  "export function fooTotal(n: number): number {",
  "  return n + FOO_LIMIT;",
  "}",
  "export function hubThing(): number {",
  "  return 1;",
  "}",
  "",
].join("\n");
const B_TS = 'import { fooTotal } from "#src/lib/a.js";\nexport const viaB = (): number => fooTotal(1);\n';
const C_TS = "export function moveMe(): number {\n  return 2;\n}\n";
const PACKAGE_JSON = `${JSON.stringify({ name: "fixture", type: "module", imports: { "#src/*": "./src/*" } })}\n`;
const FOO_ROW: [number, number] = [2, 4];
const HUB_ROW: [number, number] = [5, 7];

const pad = (i: number, n: number): string => String(i).padStart(n, "0");
const TOKS = Array.from({ length: 12 }, (_, i) => `test/tok-${pad(i, 2)}.test.ts`);
const hubPaths = (n: number): string[] => Array.from({ length: n }, (_, i) => `test/hub-${pad(i, 3)}.test.ts`);

function tree(hubs: number): Record<string, string> {
  const files: Record<string, string> = {
    "src/lib/a.ts": A_TS, "src/lib/b.ts": B_TS, "src/lib/c.ts": C_TS, "package.json": PACKAGE_JSON,
    "test/x.test.ts": 'import { FOO_LIMIT } from "#src/lib/a.js";\nassert.equal(FOO_LIMIT, 3);\n',
    "test/through-b.test.ts": 'import { viaB } from "#src/lib/b.js";\nassert.equal(viaB(), 4);\n',
  };
  for (const p of TOKS) files[p] = 'import { FOO_LIMIT } from "#src/lib/a.js";\nvoid FOO_LIMIT;\n';
  for (const p of hubPaths(hubs)) files[p] = 'import { viaB } from "#src/lib/b.js";\nvoid viaB;\n';
  return files;
}

function record(id: string, design: string, files = ["src/lib/a.ts", "test/new.test.ts"]): string {
  return [
    `- id: ${id}`, `  title: "impact map fixture ${id}"`, "  repo: remudero", "  depends_on: []",
    "  type: implement", "  verify: human", "  risk: high", "  status: queued",
    '  origin: "W1-T14512 test fixture"',
    `  design: ${JSON.stringify(`NO-INVARIANTS: synthetic lint fixture with no inherited behavior to preserve. ${design}`)}`,
    `  files: [${files.join(", ")}]`,
    "  acceptance:", '    - claim: "something is proven"', '      proof: "unit test: test/new.test.ts"', "",
  ].join("\n");
}

const parse = (yaml: string) => loadPlanFromYaml(yaml, "fixture.yaml").tasks[0]!;

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text, "utf8");
}

function commitAll(repo: GitRepo, message: string): void {
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", message);
}

/** A fixture repo whose base commit (branch `base`) holds the source, the tests and an empty plan. */
function seeded(t: TestContext, hubs = 0): GitRepo {
  const repo = gitRepo({ scope: t, kind: "w1-t14512" });
  for (const [rel, text] of Object.entries(tree(hubs))) put(repo.dir, rel, text);
  put(repo.dir, "plan/tasks.yaml", "[]\n");
  commitAll(repo, "base");
  repo.git("branch", "base");
  return repo;
}

/** A map whose a.ts rows say which suites ran fooTotal and hubThing. */
function mapText(sha: string, ran: { fooTotal?: string[]; hubThing?: string[] }, format = IMPACT_MAP_FORMAT): string {
  const suites = [...new Set([...(ran.fooTotal ?? []), ...(ran.hubThing ?? [])])].sort();
  const ids = (paths: string[] = []) => paths.map((p) => suites.indexOf(p));
  return JSON.stringify({
    format, sha, suites, orphanReports: 0,
    files: { "src/lib/a.ts": { loadedBy: ids(suites), functions: [[...FOO_ROW, ...ids(ran.fooTotal)], [...HUB_ROW, ...ids(ran.hubThing)]] } },
  });
}

const mapPathOf = (repo: GitRepo): string => join(repo.dir, ".git", PINNING_IMPACT_MAP_FILE);
const putMap = (repo: GitRepo, text: string): void => put(repo.dir, join(".git", PINNING_IMPACT_MAP_FILE), text);

function captured(fn: () => PinningTestCandidates): { result: PinningTestCandidates; event: Record<string, unknown> } {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    const result = fn();
    const events = lines.filter((l) => l.includes('"lint_plan.pinning_tests"')).map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(events.length, 1, lines.join("\n"));
    return { result, event: events[0]! };
  } finally {
    console.error = orig;
  }
}

const run = (repo: GitRepo, task: ReturnType<typeof parse>, clock: Clock = fixedClock(0)) =>
  captured(() => runPinningTests(task, repo.dir, clock));

function ranListing(result: PinningTestCandidates) {
  assert.equal(result.outcome, "ran", JSON.stringify(result));
  return result.outcome === "ran" ? result : assert.fail("not ran");
}

/** Runs the production entry, scripts/lint-plan-offline.mjs, as a child over the fixture repo. */
function lintChild(repo: GitRepo): { code: number | null; output: string } {
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
    join(REPO_ROOT, "scripts/lint-plan-offline.mjs"), "--repo-root", repo.dir, "--base", "base"], {
    cwd: repo.dir, encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", LANG: "C", TZ: "UTC" },
  });
  assert.equal(r.error, undefined, "the offline lint child completes");
  return { code: r.status, output: `${r.stdout}${r.stderr}` };
}

test("W1-T14512 criterion 1: a test that reaches the changed function only through another module is listed from the map", (t) => {
  const repo = seeded(t);
  putMap(repo, mapText(repo.git("rev-parse", "HEAD"), { fooTotal: ["test/through-b.test.ts"] }));
  const task = parse(record("ZZ-T1", "Change fooTotal so it adds twice."));
  const { result } = run(repo, task);
  const got = ranListing(result);
  assert.deepEqual(got.listed.map((l) => [l.path, l.arms, l.ran]), [["test/through-b.test.ts", ["impact"], ["fooTotal"]]]);
  const v = pinningTestViolations(task, result);
  assert.equal(v.length, 1);
  assert.equal(v[0]!.check, "pinning-tests");
  assert.equal(v[0]!.severity, "warn");
  assert.match(v[0]!.message, /test\/through-b\.test\.ts \(ran fooTotal\)/);
  // The production path: lint-plan --base reads the map from the git common dir and exits 0.
  put(repo.dir, "plan/tasks.d/ZZ-T1-impact-map-fixture.yaml", record("ZZ-T1", "Change fooTotal so it adds twice."));
  commitAll(repo, "head adds ZZ-T1");
  const lint = lintChild(repo);
  assert.equal(lint.code, 0, lint.output);
  assert.match(lint.output, /\[pinning-tests\] task ZZ-T1 declares src\/lib\/a\.ts\. [^\n]*test\/through-b\.test\.ts \(ran fooTotal\)/);
  assert.match(lint.output, /"impact":\{"outcome":"ran"/);
  // Without the map (the token arm alone, as before) the same task lists nothing.
  rmSync(mapPathOf(repo));
  const without = ranListing(run(repo, task).result);
  assert.equal(without.listed.length, 0);
  assert.equal(pinningTestViolations(task, without).length, 0);
});

test("W1-T14512 criterion 2: both arms rank first, each symbol adds 1/N, the message names 25 and the event 200", (t) => {
  const repo = seeded(t, 205);
  const sha = repo.git("rev-parse", "HEAD");
  const hubs = hubPaths(205);
  putMap(repo, mapText(sha, { fooTotal: ["test/x.test.ts", "test/through-b.test.ts"], hubThing: hubs }));
  const task = parse(record("ZZ-T2", "Raise FOO_LIMIT, change fooTotal and hubThing."));
  const { result, event } = run(repo, task);
  const got = ranListing(result);
  assert.equal(got.listed.length, 2 + TOKS.length + hubs.length);
  assert.deepEqual(got.listed.slice(0, 2).map((l) => [l.path, l.arms]),
    [["test/x.test.ts", ["token", "impact"]], ["test/through-b.test.ts", ["impact"]]]);
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
  near(got.listed[0]!.score, 1 / 13 + 1 / 2);
  near(got.listed[1]!.score, 1 / 2);
  assert.deepEqual(got.listed.slice(2, 14).map((l) => l.path), TOKS);
  const hub = got.listed.find((l) => l.path === hubs[0]);
  near(hub!.score, 1 / 205);
  assert.deepEqual(got.listed.slice(14).map((l) => l.path), hubs, "the hub symbol's suites rank last");
  const message = pinningTestViolations(task, result)[0]!.message;
  assert.match(message, /test\/x\.test\.ts \(FOO_LIMIT; ran fooTotal\); test\/through-b\.test\.ts \(ran fooTotal\);/);
  assert.equal([...message.matchAll(/test\/[\w-]+\.test\.ts \(/g)].length, PINNING_TESTS_NAMED_WITH_MAP);
  assert.match(message, / and 194 more\. They may pin the old behaviour\./);
  assert.equal((event.listed as string[]).length, 200);
  assert.equal(event.listedCount, 219);
  assert.deepEqual(event.impact, { outcome: "ran", sha, distance: 0, symbols: ["FOO_LIMIT", "fooTotal", "hubThing"] });
});

test("W1-T14512 criterion 3: with no map, another format, a sha HEAD does not descend from, or a stale map, the token arm is unchanged", (t) => {
  const repo = seeded(t);
  const sha = repo.git("rev-parse", "HEAD");
  const task = parse(record("ZZ-T3", "Raise FOO_LIMIT and change fooTotal."));
  const tokenOnly = [...TOKS, "test/x.test.ts"];
  const check = (outcome: string, reason?: RegExp): string => {
    const { result, event } = run(repo, task);
    assert.deepEqual(ranListing(result).listed.map((l) => l.path), tokenOnly, outcome);
    const impact = event.impact as Record<string, unknown>;
    assert.equal(impact.outcome, outcome);
    if (reason) assert.match(String(impact.reason), reason);
    const message = pinningTestViolations(task, result)[0]!.message;
    assert.equal([...message.matchAll(/test\/[\w-]+\.test\.ts \(/g)].length, 10);
    assert.match(message, /These existing tests import it and name what its design changes: [^\n]* and 3 more\. They may pin/);
    return message;
  };
  const noMap = check("no-map");
  assert.match(noMap, /No impact map was read; put the test-impact-map artifact of a coverage-nightly run at \S*\.git\/rmd\/test-impact-map\.json to also list the tests that run the changed code\./);
  putMap(repo, mapText(sha, { fooTotal: ["test/through-b.test.ts"] }, "another-format-v9"));
  assert.doesNotMatch(check("unusable", /is not a non-empty rmd-test-impact-map-v1 map/), /No impact map was read/);
  const orphan = repo.git("commit-tree", "HEAD^{tree}", "-m", "not an ancestor");
  putMap(repo, mapText(orphan, { fooTotal: ["test/through-b.test.ts"] }));
  check("unusable", /does not descend from/);
  // Control: the same map at an ancestor sha is used.
  putMap(repo, mapText(sha, { fooTotal: ["test/through-b.test.ts"] }));
  assert.ok(ranListing(run(repo, task).result).listed.some((l) => l.path === "test/through-b.test.ts"));
  const stream = Array.from({ length: IMPACT_MAP_STALENESS_BOUND + 1 }, (_, i) =>
    `commit refs/heads/main\ncommitter f <f@fixture.invalid> ${i} +0000\ndata 1\ns\n${i === 0 ? `from ${sha}\n` : ""}\n`).join("");
  execFileSync("git", ["-C", repo.dir, "fast-import", "--quiet"], { input: stream });
  check("unusable", new RegExp(`${IMPACT_MAP_STALENESS_BOUND + 1} commits past the map, over the bound of ${IMPACT_MAP_STALENESS_BOUND}`));
});

test("W1-T14512 criterion 4: a design symbol declared only outside the declared src files warns that the code may have moved", (t) => {
  const repo = seeded(t);
  const moved = (design: string) => {
    const task = parse(record("ZZ-T4", design));
    const v = pinningTestViolations(task, run(repo, task).result).filter((x) => /The code may have moved/.test(x.message));
    const base = lintTask(task);
    assert.equal([...base.violations, ...v].every((x) => x.severity !== "block"), base.ok, "the task's ok is unchanged");
    return v;
  };
  const one = moved("Change moveMe.");
  assert.equal(one.length, 1);
  assert.equal(one[0]!.check, "pinning-tests");
  assert.equal(one[0]!.severity, "warn");
  assert.match(one[0]!.message, /^task ZZ-T4 names moveMe \(declared in src\/lib\/c\.ts\), but none of its declared src files declares a symbol its design names\. The code may have moved: check files:\.$/);
  assert.equal(moved("Change moveMe and fooTotal.").length, 0, "the declared src/lib/a.ts declares fooTotal");
  assert.equal(moved("Add brandNewThing to the module.").length, 0, "a symbol declared nowhere never counts");
  assert.doesNotMatch(moved("Add brandNewThing beside moveMe.")[0]!.message, /brandNewThing/);
  put(repo.dir, "plan/tasks.d/ZZ-T4-impact-map-fixture.yaml", record("ZZ-T4", "Change moveMe."));
  commitAll(repo, "head adds ZZ-T4");
  const lint = lintChild(repo);
  assert.equal(lint.code, 0, lint.output);
  assert.match(lint.output, /\[pinning-tests\] task ZZ-T4 names moveMe \(declared in src\/lib\/c\.ts\)/);
});

test("W1-T14512 criterion 5: the map read counts against the budget, and a run past it warns over budget and lists nothing", (t) => {
  const repo = seeded(t);
  putMap(repo, mapText(repo.git("rev-parse", "HEAD"), { fooTotal: ["test/through-b.test.ts"] }));
  const task = parse(record("ZZ-T5", "Change fooTotal so it adds twice."));
  assert.equal(ranListing(run(repo, task).result).listed.length, 1, "control: a clock that stands still lists the test");
  // The clock jumps past the budget once the map file is read, so only a clock started before the read sees it.
  let mapRead = false;
  const orig = fs.readFileSync;
  fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(path).endsWith(PINNING_IMPACT_MAP_FILE)) mapRead = true;
    return (orig as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  let got: ReturnType<typeof run>;
  try {
    got = run(repo, task, clockFromMillisFn(() => (mapRead ? 20_000 : 0)));
  } finally {
    fs.readFileSync = orig;
    syncBuiltinESMExports();
  }
  assert.ok(mapRead, "the map was read");
  assert.deepEqual(got.result, { outcome: "over_budget", budgetMs: 10_000, ms: 20_000 });
  assert.equal(got.event.outcome, "over_budget");
  const v = pinningTestViolations(task, got.result);
  assert.equal(v.length, 1);
  assert.equal(v[0]!.severity, "warn");
  assert.match(v[0]!.message, /^pinning-tests did not run: over its 10000 ms budget after \d+ ms$/);
});
