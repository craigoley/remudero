// W1-T13215: when an author preflight's affected tests end red, it runs only the failing files again at the merge base
// and says, for each failing test, whether the base fails it too. It never changes who may push.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

// @ts-ignore the executable .mjs module has no declaration file.
import * as authorModule from "#scripts/preflight-author.mjs";
import { makeTempDir } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Failing = { file: string | null; title: string; fileLevel?: boolean };
type Entry = { file: string | null; title: string; state: string; reason: string };
type Counts = { failingAtHead: number; alsoFailingAtBase: number; failingOnlyAtHead: number; unattributed: number };
type Result = { tests: Entry[]; unnamed: number; counts: Counts; cleanup: { removed: boolean; reason?: string }; base: { boundMs?: number } };
type Raw = { status: number | null; signal?: string | null; stdout?: string; stderr?: string; error?: Error; outputComplete?: boolean };
type Receipt = { verdict: string; pushEligible: boolean; pushEligibleReason: string; steps: Array<{ name: string; ok: boolean }>;
  failureAttribution?: { counts: Counts; tests: Entry[]; cleanup: { removed: boolean } } };
const author = authorModule as unknown as {
  failingTestsFromTap(output: string, root: string): Failing[];
  headFilesMs(durations: unknown, files: string[], stageMs: number): number;
  attributeFailures(input: Record<string, unknown>): Result;
  attributionLines(result: Result): string[];
  authorVerdictRow(receipt: Record<string, unknown>, context?: Record<string, unknown>): Record<string, unknown> | undefined;
  authorPushEligibility(receipt: Record<string, unknown>): { pushEligible: boolean; pushEligibleReason: string };
  main(argv: string[], deps: { root: string; select?: () => unknown }): number;
};

// The suite's own real runs hold one scratch slot directory, so a nested preflight never waits on the host's.
const slotDir = makeTempDir("author-attribution-slots");
const originalSlotDir = process.env.RMD_TEST_SLOT_DIR;
process.env.RMD_TEST_SLOT_DIR = slotDir;
after(() => {
  if (originalSlotDir === undefined) delete process.env.RMD_TEST_SLOT_DIR;
  else process.env.RMD_TEST_SLOT_DIR = originalSlotDir;
  rmSync(slotDir, { recursive: true, force: true });
});

const HEAD = "a".repeat(40), BASE = "b".repeat(40), MERGE_BASE = "c".repeat(40);
const ok = (stdout = ""): Raw => ({ status: 0, signal: null, stdout, stderr: "" });
/** A TAP report as node 24 prints it: one failing leaf, its location diagnostic naming the file. */
const tap = (root: string, ...failures: Array<[file: string, title: string]>): string => [
  "TAP version 13",
  ...failures.flatMap(([file, title], index) => [`# Subtest: ${title}`, `not ok ${index + 1} - ${title}`, "  ---", "  duration_ms: 1", "  type: 'test'",
    `  location: '${join(root, file)}:1:1'`, "  failureType: 'testCodeFailure'", "  ..."]),
  `# tests ${failures.length + 2}`, "# suites 0", "# pass 2", `# fail ${failures.length}`, "# cancelled 0", "# skipped 0", "# todo 0", ""].join("\n");

/** A scripted Git for the merge base and the scratch worktree, recording every call; `held` are the files the base has. */
function scriptedGit(options: { held?: string[]; lockfileStatus?: number; add?: Raw; mergeBase?: Raw } = {}) {
  const calls: string[] = [];
  const git = (args: string[]): Raw => {
    const call = args.join(" ");
    calls.push(call);
    if (args[0] === "merge-base") return options.mergeBase ?? ok(`${MERGE_BASE}\n`);
    if (args[0] === "cat-file") return { status: (options.held ?? []).includes(String(args[2]).slice(MERGE_BASE.length + 1)) ? 0 : 128, stdout: "", stderr: "" };
    if (args[0] === "diff") return { status: options.lockfileStatus ?? 0, stdout: "", stderr: "" };
    if (args[0] === "worktree" && args[1] === "add") {
      if (options.add) return options.add;
      mkdirSync(String(args[3]), { recursive: true });
      return ok();
    }
    if (args[0] === "worktree" && args[1] === "remove") { rmSync(String(args[3]), { recursive: true, force: true }); return ok(); }
    return ok();
  };
  return { git, calls };
}
type Run = { file: string; args: string[]; cwd: string; boundMs: number };
const attribute = (failing: Failing[], seams: { git: (args: string[]) => Raw; runBase: (run: Run) => Raw }, extra: Record<string, unknown> = {}): Result => {
  const dependencies = makeTempDir("author-attribution-deps");
  return author.attributeFailures({ root: REPO_ROOT, baseSha: BASE, headSha: HEAD, failing, headMs: 5000, nodeModules: dependencies,
    runnerArgs: (files: string[]) => ["--test", ...files], ...seams, ...extra });
};
const failing: Failing[] = [{ file: "test/a.test.ts", title: "red at both" }, { file: "test/a.test.ts", title: "red only here" }, { file: "test/new.test.ts", title: "new file" }];
const byTitle = (result: Result) => Object.fromEntries(result.tests.map((test) => [test.title, test.state]));

test("W1-T13215 criterion 1: the failing files, and only those the base holds, run again at the merge base in a scratch worktree that is removed", () => {
  const { git, calls } = scriptedGit({ held: ["test/a.test.ts"] });
  const runs: Run[] = [];
  const result = attribute(failing, { git, runBase: (run) => { runs.push(run); assert.ok(existsSync(run.cwd), "the base run happens inside the scratch worktree"); return ok(tap(run.cwd, ["test/a.test.ts", "red at both"])); } });
  assert.equal(runs.length, 1, "one base run, for all the failing files together");
  assert.deepEqual(runs[0]!.args.slice(-1), ["test/a.test.ts"], "only the failing file the base holds is run, never the whole selection");
  assert.deepEqual(byTitle(result), { "red at both": "also-red", "red only here": "only-head", "new file": "only-head" });
  assert.deepEqual(calls.filter((call) => call.startsWith("worktree")).map((call) => call.split(" ")[1]), ["add", "remove"]);
  assert.ok(calls.includes(`worktree add --detach ${runs[0]!.cwd} ${MERGE_BASE}`), "the worktree is cut at the merge base");
  assert.equal(existsSync(runs[0]!.cwd), false, "the scratch worktree is gone");
  assert.deepEqual(result.cleanup.removed, true);
  const lines = author.attributionLines(result);
  assert.ok(lines.includes("author attribution: test/a.test.ts :: red at both: also red at the base on this host"), lines.join("\n"));
  assert.ok(lines.includes("author attribution: test/a.test.ts :: red only here: red only at the head"));
  // Removal does not depend on the base run's outcome: a run that throws still has its worktree removed.
  const thrown = scriptedGit({ held: ["test/a.test.ts"] });
  let cwd = "";
  const broken = attribute(failing, { git: thrown.git, runBase: (run) => { cwd = run.cwd; throw new Error("spawn exploded"); } });
  assert.ok(thrown.calls.some((call) => call.startsWith("worktree remove")), "removed after a throw");
  assert.equal(existsSync(cwd), false);
  assert.match(broken.tests[0]!.reason, /spawn exploded/);
  // A removal that fails is said out loud, never silent.
  const stuck = attribute(failing, { git: (args) => (args[1] === "remove" ? { status: 1, stdout: "", stderr: "locked" } : scriptedGit({ held: ["test/a.test.ts"] }).git(args)),
    runBase: (run) => ok(tap(run.cwd, ["test/a.test.ts", "red at both"])) });
  assert.equal(stuck.cleanup.removed, false);
  assert.match(author.attributionLines(stuck).join("\n"), /was NOT removed \(locked\); remove it by hand/);
});

test("W1-T13215 criterion 1: a real merge base is checked out, the failing file runs there, and the worktree is gone after", () => {
  const repo = gitRepo({ kind: "author-attribution", seedCommit: false });
  const root = repo.dir;
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  const body = (value: number) => `import { test } from "node:test"; import assert from "node:assert/strict";\n` +
    `test("red at both", () => assert.equal(1, 2));\ntest("green at the base", () => assert.equal(${value}, 1));\n`;
  writeFileSync(join(root, "test/mixed.test.ts"), body(1));
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "test: base");
  const mergeBase = repo.git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "test/mixed.test.ts"), body(2));
  writeFileSync(join(root, "test/added.test.ts"), `import { test } from "node:test"; test("added", () => { throw new Error("no"); });\n`);
  repo.git("add", ".");
  repo.git("commit", "-m", "fix: break it");
  const headSha = repo.git("rev-parse", "HEAD").trim();
  // The head's own real report, from the real runner, in the real checkout.
  const headRun = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--import", "tsx", "test/mixed.test.ts", "test/added.test.ts"],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: "", NODE_TEST_CONTEXT: undefined } });
  assert.equal(headRun.status, 1, "positive control: the head run is red");
  const named = author.failingTestsFromTap(`${headRun.stdout}\n${headRun.stderr}`, root);
  assert.deepEqual(named.map((test) => `${test.file}: ${test.title}`).sort(),
    ["test/added.test.ts: added", "test/mixed.test.ts: green at the base", "test/mixed.test.ts: red at both"]);
  const result = author.attributeFailures({ root, baseSha: mergeBase, headSha, failing: named, headMs: 60_000, nodeModules: join(REPO_ROOT, "node_modules"),
    git: (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" }),
    runBase: (run: Run) => spawnSync(run.file, run.args, { cwd: run.cwd, encoding: "utf8", timeout: run.boundMs,
      env: { ...process.env, NODE_V8_COVERAGE: "", NODE_TEST_CONTEXT: undefined } }),
    runnerArgs: (files: string[]) => ["--test", "--test-reporter=tap", "--import", "tsx", ...files] });
  assert.deepEqual(byTitle(result), { "red at both": "also-red", "green at the base": "only-head", added: "only-head" }, JSON.stringify(result.tests));
  assert.deepEqual(result.counts, { failingAtHead: 3, alsoFailingAtBase: 1, failingOnlyAtHead: 2, unattributed: 0 });
  assert.equal(result.cleanup.removed, true);
  assert.equal(repo.git("worktree", "list").trim().split("\n").length, 1, "only the fixture's own worktree is left");
  rmSync(root, { recursive: true, force: true });
});

test("W1-T13215 criterion 2: the base run is bounded by the head's time for the same files, with the stage's ceiling as the backstop", () => {
  const bounds: number[] = [];
  const seams = () => ({ ...scriptedGit({ held: ["test/a.test.ts"] }), bounds });
  for (const [headMs, ceilingMs, expected] of [[5000, 4 * 3600_000, 5000], [9e9, 60_000, 60_000], [undefined, 60_000, 60_000]] as const) {
    const { git } = seams();
    attribute(failing.slice(0, 1), { git, runBase: (run) => { bounds.push(run.boundMs); return ok(tap(run.cwd, ["test/a.test.ts", "red at both"])); } }, { headMs, ceilingMs });
    assert.equal(bounds.at(-1), expected, `head ${headMs} ceiling ${ceilingMs}`);
  }
  assert.equal(author.headFilesMs({ files: { "test/a.test.ts": 300, "test/b.test.ts": 200 } }, ["test/a.test.ts", "test/b.test.ts"], 99_999), 500, "the files' own durations");
  assert.equal(author.headFilesMs({ files: { "test/a.test.ts": 300 } }, ["test/a.test.ts", "test/b.test.ts"], 99_999), 99_999, "an unrecorded file falls back to the whole stage");
  assert.equal(author.headFilesMs({ unreadable: "ENOENT" }, ["test/a.test.ts"], 7), 7);
});

test("W1-T13215 criterion 2: a base run that is cut short, cannot be set up or reports no summary labels its tests unattributed, never pre-existing", () => {
  const one = failing.slice(0, 2);
  const held = { held: ["test/a.test.ts"] };
  const cases: Array<[string, Record<string, unknown>, (run: Run) => Raw, RegExp]> = [
    ["killed by its bound", held, () => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "" }), /cut short \(SIGTERM\) at its bound of 5000ms/],
    ["a spawn error", held, () => ({ status: null, signal: null, error: Object.assign(new Error("boom"), { code: "ETIMEDOUT" }) }), /cut short \(ETIMEDOUT\)/],
    ["output known incomplete", held, (run) => ({ ...ok(tap(run.cwd, ["test/a.test.ts", "red at both"])), outputComplete: false }), /cut short/],
    ["no summary", held, () => ok("TAP version 13\nnot ok 1 - red at both\n"), /reported no test summary/],
    ["a different lockfile", { ...held, lockfileStatus: 1 }, () => ok(), /package-lock\.json differs/],
    ["an unreadable lockfile", { ...held, lockfileStatus: 128 }, () => ok(), /could not be compared/],
    ["no worktree", { ...held, add: { status: 128, stdout: "", stderr: "fatal: read-only" } }, () => ok(), /scratch worktree could not be created: fatal: read-only/],
    ["no merge base", { ...held, mergeBase: { status: 1, stdout: "", stderr: "" } }, () => ok(), /merge base .* could not be read/],
    ["a failure the output does not name", held, (run) => ok(tap(run.cwd, ["test/a.test.ts", "red at both"]).replace("# fail 1", "# fail 4")), /does not name/],
  ];
  for (const [name, options, runBase, reason] of cases) {
    const { git } = scriptedGit(options);
    const result = attribute(one, { git, runBase });
    for (const test of result.tests.filter((entry) => entry.file === "test/a.test.ts" && !(name === "a failure the output does not name" && entry.title === "red at both"))) {
      assert.equal(test.state, "unattributed", `${name}: ${test.title}`);
      assert.match(test.reason, reason, name);
    }
    assert.equal(result.counts.alsoFailingAtBase, name === "a failure the output does not name" ? 1 : 0, `${name}: nothing is also red at the base`);
    assert.equal(result.cleanup.removed, true, `${name}: whatever happened, nothing is left behind`);
  }
  // A failing test the head's output never named is unattributed too.
  const { git } = scriptedGit(held);
  const unnamed = attribute(one, { git, runBase: (run) => ok(tap(run.cwd, ["test/a.test.ts", "red at both"])) }, { unnamed: 2 });
  assert.deepEqual(unnamed.counts, { failingAtHead: 4, alsoFailingAtBase: 1, failingOnlyAtHead: 1, unattributed: 2 });
  // A test with no file under this checkout has nothing to look up.
  const noFile = attribute([{ file: null, title: "elsewhere" }], { git, runBase: () => ok() });
  assert.deepEqual(noFile.tests.map((test) => test.state), ["unattributed"]);
});

/** The fixture of test/author-preflight.test.ts, cut down to what a failing run needs: a base red test, a head-only red test and a new red file. */
function fixture() {
  const repo = gitRepo({ kind: "author-attribution-main", seedCommit: false });
  const root = repo.dir;
  for (const path of ["test/setup", "src", "scripts"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, ".nvmrc"), process.versions.node + "\n");
  writeFileSync(join(root, ".gitignore"), "node_modules\ncoverage\n");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package-lock.json"), readFileSync(join(REPO_ROOT, "package-lock.json")));
  writeFileSync(join(root, "scripts/diff-class.mjs"), "// This fixture has no census path readers.\n");
  writeFileSync(join(root, "scripts/census-precheck.mjs"), "console.log('fixture census precheck passed');\n");
  writeFileSync(join(root, "test/setup/tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(root, "src/run-task.ts"), "console.log('fixture static preflight passed');\n");
  const leaf = (value: number) => `import { test } from "node:test"; import assert from "node:assert/strict";\n` +
    `test("red at both", () => assert.equal(1, 2));\ntest("green at the base", () => assert.equal(${value}, 1));\n`;
  writeFileSync(join(root, "test/leaf.test.ts"), leaf(1));
  repo.git("add", ".");
  repo.git("commit", "-m", "test: baseline");
  repo.git("remote", "add", "origin", root);
  repo.git("checkout", "-b", "run-unfiled-author-attribution");
  writeFileSync(join(root, "test/leaf.test.ts"), leaf(2));
  writeFileSync(join(root, "test/fresh.test.ts"), `import { test } from "node:test"; test("born red", () => { throw new Error("no"); });\n`);
  repo.git("add", ".");
  repo.git("commit", "-m", "fix: change the leaf");
  return { root, git: repo.git, receipt: () => JSON.parse(readFileSync(join(root, "coverage/preflight-author.json"), "utf8")) as Receipt };
}
const select = () => ({ fullRun: false, suites: ["test/leaf.test.ts", "test/fresh.test.ts"], reasons: [] });

test("W1-T13215 criterion 3: the run prints one line per failing test and the verdict row carries the four counts", () => {
  const f = fixture();
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
  let exit: number;
  try { exit = author.main([], { root: f.root, select }); } finally { console.log = log; }
  const receipt = f.receipt();
  assert.equal(exit, 1, "a run with failing tests exits as it always did");
  assert.equal(receipt.verdict, "failed");
  const lines = printed.filter((line) => line.startsWith("author attribution: "));
  assert.deepEqual(receipt.failureAttribution!.counts, { failingAtHead: 3, alsoFailingAtBase: 1, failingOnlyAtHead: 2, unattributed: 0 }, lines.join("\n"));
  assert.ok(lines.includes("author attribution: test/leaf.test.ts :: red at both: also red at the base on this host"), lines.join("\n"));
  assert.ok(lines.includes("author attribution: test/fresh.test.ts :: born red: red only at the head"), lines.join("\n"));
  assert.equal(lines.at(-1), "author attribution: failing at the head 3; also failing at the base 1; failing only at the head 2; unattributed 0");
  assert.equal(receipt.failureAttribution!.cleanup.removed, true);
  assert.equal(f.git("worktree", "list").trim().split("\n").length, 1, "the scratch worktree was removed");
  const row = author.authorVerdictRow(receipt, { exitCode: exit, headRef: "run-W1-T13215-1" })!;
  assert.deepEqual([row.failing_at_head, row.failing_also_at_base, row.failing_only_at_head, row.failing_unattributed], [3, 1, 2, 0]);
  // A run that compared nothing has no counts on its row, and a passed run is not given any.
  const bare = author.authorVerdictRow({ verdict: "failed", steps: [{ name: "census-precheck", ok: false }], startedAt: "2026-11-16T00:00:00.000Z" })!;
  assert.equal("failing_at_head" in bare, false);
  rmSync(f.root, { recursive: true, force: true });
});

test("W1-T13215 criterion 4: invariant a-failure-the-change-caused-is-never-pre-existing, and a run with a failing test stays not push-eligible", () => {
  const f = fixture();
  const quiet = console.log;
  console.log = () => {};
  try { author.main([], { root: f.root, select }); } finally { console.log = quiet; }
  const receipt = f.receipt();
  const states = Object.fromEntries(receipt.failureAttribution!.tests.map((test) => [`${test.file}: ${test.title}`, test.state]));
  assert.deepEqual(states, { "test/leaf.test.ts: red at both": "also-red", "test/leaf.test.ts: green at the base": "only-head", "test/fresh.test.ts: born red": "only-head" },
    "a failing test in a file the base does not hold is the change's; a test that passes at the base is never labelled red there");
  assert.equal(receipt.failureAttribution!.tests.length, 3, "positive control: both failing tests were seen");
  // Even when every failing test is red at the base, the run is not push-eligible, for the reason it always had.
  assert.equal(receipt.pushEligible, false);
  assert.match(receipt.pushEligibleReason, /^affected-tests failed: 3 failing test\(s\)/);
  const allRed = { ...receipt, failureAttribution: { counts: { failingAtHead: 3, alsoFailingAtBase: 3, failingOnlyAtHead: 0, unattributed: 0 } } };
  assert.deepEqual(author.authorPushEligibility(allRed), author.authorPushEligibility({ ...receipt, failureAttribution: undefined }));
  assert.equal(author.authorPushEligibility(allRed).pushEligible, false);
  // The label's only source is a completed base run that named the title: a base run that passes the title labels it the change's.
  const { git } = scriptedGit({ held: ["test/a.test.ts"] });
  const passes = attribute(failing.slice(0, 1), { git, runBase: () => ok("TAP version 13\n# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n") });
  assert.deepEqual(byTitle(passes), { "red at both": "only-head" });
  assert.equal(passes.counts.alsoFailingAtBase, 0);
  rmSync(f.root, { recursive: true, force: true });
});
