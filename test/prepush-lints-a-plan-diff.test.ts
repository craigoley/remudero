/**
 * W1-T4901 — THE PRE-PUSH HOOK LINTS A PLAN DIFF, SO A SHARD CI WILL BLOCK IS FOUND BEFORE THE PUSH.
 *
 * MEASURED 2026-09-16..30: 14 of 55 single-shard test reds were ci-parity's real `lint-plan:fast` run refusing the PR's
 * own changed shard. Every arm that decides a push goes through a REAL `git push` from a LINKED WORKTREE (the shape
 * every fleet lane has, and the only shape in which git exports GIT_DIR to the hook), against a bare remote built by
 * test/helpers/git-repo.ts. The pure arms drive the exported verdict directly.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { gitRepo } from "./helpers/git-repo.js";
// @ts-expect-error -- test executes the untyped executable module directly.
import { lintArgvFromPackage, lintPlanPrecheckVerdict, runLintPlanPrecheck } from "../scripts/lint-plan-precheck.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(REPO_ROOT, "hooks", "pre-push");
const LINT_SCRIPT = `node --import tsx ${join(REPO_ROOT, "scripts", "lint-plan-offline.mjs")} --base origin/main --merge-base`;

let counter = 0;

const CLEAN_SHARD = [
  "- id: W9-T1",
  '  title: "a clean shard"',
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  status: queued",
  '  origin: "fixture"',
  "  files:",
  "    - docs/a.md",
  "  acceptance:",
  '    - claim: "the doc says hello"',
  '      proof: "grep: hello in docs/a.md"',
  "",
].join("\n");

const BARE_TITLE_SHARD = CLEAN_SHARD.replace('"grep: hello in docs/a.md"', '"the doc says hello"');
const MACHINE_ONLY_SHARD = CLEAN_SHARD.replace("verify: auto", "verify: human\n  author_class: machine").replaceAll("docs/a.md", "docs/nowhere.md");

function fixture(t: TestContext, opts: { lintScript?: string } = {}) {
  const remote = gitRepo({ kind: "t4901-remote", bare: true });
  const parent = gitRepo({ kind: "t4901-parent" });
  const work = parent.addWorktree(join(dirname(parent.dir), `rmd-t4901-wt-${process.pid}-${counter++}`), "pushbranch");
  t.after(() => work.cleanup());

  for (const dir of ["hooks", "scripts/lib", "plan/tasks.d", "docs"]) mkdirSync(join(work.dir, dir), { recursive: true });
  copyFileSync(HOOK, join(work.dir, "hooks", "pre-push"));
  chmodSync(join(work.dir, "hooks", "pre-push"), 0o755);
  for (const file of ["lint-plan-precheck.mjs", "lib/argv.mjs", "lib/git.mjs"]) {
    copyFileSync(join(REPO_ROOT, "scripts", file), join(work.dir, "scripts", file));
  }
  const scripts = opts.lintScript === undefined ? { "lint-plan:fast": LINT_SCRIPT } : {};
  writeFileSync(join(work.dir, "package.json"), JSON.stringify({ scripts }));
  writeFileSync(join(work.dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(work.dir, "plan", "tasks.d", ".gitkeep"), "");
  copyFileSync(join(REPO_ROOT, "plan", "policy.yaml"), join(work.dir, "plan", "policy.yaml"));
  // The clean-shard positive control adds the text its grep proof names. Keeping the
  // target absent at the base makes that proof discriminating under lint-plan too.
  writeFileSync(join(work.dir, "docs", "a.md"), "initial fixture text\n");

  work.git("config", "core.hooksPath", "hooks");
  work.addRemote("origin", remote.dir);
  work.git("add", "-A");
  work.git("commit", "--quiet", "-m", "lint-plan fixture base");
  work.git("update-ref", "refs/remotes/origin/main", "HEAD");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(work.dir, "node_modules"));

  const commit = (message: string, paths: string[]) => {
    work.git("add", "--", ...paths);
    work.git("commit", "--quiet", "-m", message);
  };
  const writeShard = (text: string) => writeFileSync(join(work.dir, "plan", "tasks.d", "W9-T1-shard.yaml"), text);
  const push = () => {
    const result = spawnSync("git", ["push", "origin", "HEAD:refs/heads/topic"], {
      cwd: work.dir,
      encoding: "utf8",
      env: { ...process.env, RMD_PREPUSH_GATES: "1" },
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { work, commit, writeShard, push };
}

test("W1-T4901: a real push of a plan-only diff whose shard fails the plan lint is refused, naming the rule and the remedy", (t) => {
  const f = fixture(t);
  f.writeShard(BARE_TITLE_SHARD);
  f.commit("file a shard with a bare-title proof", ["plan"]);
  const result = f.push();
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /lint-plan-precheck: the plan lint CI runs on this diff REFUSES it \[proof-dialect\]/);
  assert.match(result.stderr, /✗ W9-T1: 1 violation/);
  assert.match(result.stderr, /TO FIX: .*npm run lint-plan:fast/);
  assert.match(result.stderr, /pre-push REFUSED/);
});

test("W1-T4901: positive control, a clean shard passes the same real push", (t) => {
  const f = fixture(t);
  f.writeShard(CLEAN_SHARD);
  writeFileSync(join(f.work.dir, "docs", "a.md"), "hello\n");
  f.commit("file a clean shard and its matching documentation", ["plan", "docs/a.md"]);
  const result = f.push();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /lint-plan-precheck: OK/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /^TAP version/m);
});

test("a diff that changes no plan file skips the lint", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.work.dir, "docs", "b.md"), "no plan here\n");
  f.commit("docs only", ["docs"]);
  const result = f.push();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /lint-plan-precheck: SKIP -- no plan\/ path in this diff/);

  let ran = false;
  const verdict = lintPlanPrecheckVerdict({
    changedFiles: ["src/x.ts", "docs/b.md"],
    subjects: [],
    lint: () => {
      ran = true;
      return { status: 1, output: "" };
    },
  });
  assert.equal(verdict.exit, 0);
  assert.equal(ran, false, "the lint is never spawned for a diff with no plan/ path");
});

test("a range holding a squash-merge subject abstains naming git fetch instead of refusing", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.work.dir, "docs", "b.md"), "already merged upstream\n");
  f.commit("feat: something another PR merged (#4242)", ["docs"]);
  f.writeShard(BARE_TITLE_SHARD);
  f.commit("file a shard with a bare-title proof", ["plan"]);
  const result = f.push();
  assert.equal(result.status, 0, `a stale origin/main is not a reason to refuse: ${result.stderr}`);
  assert.match(result.stderr, /lint-plan-precheck: SKIP -- the local origin\/main is behind/);
  assert.match(result.stderr, /run `git fetch origin` and push again/);
  assert.doesNotMatch(result.stderr, /REFUSES it/);
});

test("a machine-filing-admission finding alone is reported and does not block", (t) => {
  const f = fixture(t);
  f.writeShard(MACHINE_ONLY_SHARD);
  f.commit("file a machine shard naming an absent file", ["plan"]);
  const result = f.push();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /REFUSES it \[machine-filing-admission\]/);
  assert.match(result.stderr, /reported, not blocking/);
  assert.doesNotMatch(result.stderr, /pre-push REFUSED/);

  const mixed = lintPlanPrecheckVerdict({
    changedFiles: ["plan/tasks.d/x.yaml"],
    subjects: [],
    lint: () => ({ status: 1, output: "✗ W9-T1: 2 violation(s)\n    [machine-filing-admission] a\n    [sizing] b\n" }),
  });
  assert.equal(mixed.exit, 1, "one blocking rule beside it makes the whole finding block");
});

test("a lint that could not run is never a refusal, whatever the reason", (t) => {
  const unnamed = lintPlanPrecheckVerdict({ changedFiles: ["plan/x.yaml"], subjects: [], lint: () => ({ status: 1, output: "boom" }) });
  assert.equal(unnamed.exit, 2, "exit 1 with no violation it can name is unreadable, not a violation");
  const crashed = lintPlanPrecheckVerdict({ changedFiles: ["plan/x.yaml"], subjects: [], lint: () => ({ status: 2, output: "✗ W9-T1: 1 violation(s)" }) });
  assert.equal(crashed.exit, 2, "a status other than 0 or 1 is could-not-run");

  const f = fixture(t, { lintScript: "" });
  f.writeShard(BARE_TITLE_SHARD);
  f.commit("file a shard, with no lint script to run", ["plan"]);
  const result = f.push();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /lint-plan-precheck: could not run \(package\.json has no plain `node \.\.\.` lint-plan:fast script\)/);
  assert.match(result.stderr, /lint-plan-precheck could not run the lint — not blocking/);
});

test("the precheck takes its lint argv from the lint-plan:fast script and reads its base from there", () => {
  const parsed = lintArgvFromPackage(JSON.stringify({ scripts: { "lint-plan:fast": "node --import tsx scripts/x.mjs --base origin/dev --merge-base" } }));
  assert.deepEqual(parsed, { args: ["--import", "tsx", "scripts/x.mjs", "--base", "origin/dev", "--merge-base"], base: "origin/dev" });
  assert.equal(lintArgvFromPackage(JSON.stringify({ scripts: { "lint-plan:fast": "node scripts/x.mjs" } })).base, undefined);
  assert.equal(lintArgvFromPackage(JSON.stringify({ scripts: { "lint-plan:fast": "npx tsx scripts/x.mjs" } })), undefined);
  assert.equal(lintArgvFromPackage(JSON.stringify({ scripts: {} })), undefined);
});

test("the squash-merge abstain names the merged subject and the git fetch remedy, and never runs the lint", () => {
  const verdict = lintPlanPrecheckVerdict({
    changedFiles: ["plan/tasks.d/W9-T1-shard.yaml"],
    subjects: ["file a shard", "feat: merged elsewhere (#4242)"],
    lint: () => assert.fail("a stale local origin/main must not reach the lint"),
  });
  assert.deepEqual(verdict, {
    exit: 0,
    lines: [
      'lint-plan-precheck: SKIP -- the local origin/main is behind this branch\'s fork point ("feat: merged elsewhere (#4242)" is already merged)',
      "  run `git fetch origin` and push again: against a stale ref the lint would judge other PRs' tasks, and a refusal there is not this branch's",
    ],
  });
});

/** The in-process entry: the same git and lint reads the hook's child makes, driven from a fixture's cwd so coverage
 *  attributes the run to scripts/lint-plan-precheck.mjs itself and not to the copy a hook fixture executes. */
function runIn(dir: string) {
  const out: string[] = [];
  const err: string[] = [];
  const exit = runLintPlanPrecheck({ argv: ["--base", "origin/main"], cwd: dir, log: (l: string) => out.push(l), warn: (l: string) => err.push(l) });
  return { exit, out, err };
}

test("run in-process: a shard that fails the lint exits 1 naming the rule, a clean one exits 0", (t) => {
  const f = fixture(t);
  f.writeShard(BARE_TITLE_SHARD);
  f.commit("file a shard with a bare-title proof", ["plan"]);
  const refused = runIn(f.work.dir);
  assert.equal(refused.exit, 1);
  assert.match(refused.err.join("\n"), /REFUSES it \[proof-dialect\]/);
  assert.deepEqual(refused.out, []);

  f.writeShard(CLEAN_SHARD);
  writeFileSync(join(f.work.dir, "docs", "a.md"), "hello\n");
  f.commit("repair the shard and add its matching documentation", ["plan", "docs/a.md"]);
  assert.deepEqual(runIn(f.work.dir), { exit: 0, out: ["lint-plan-precheck: OK -- the plan lint passes on this diff"], err: [] });
});

test("run in-process: a diff with no plan path skips, and a checkout with no lint script could not run", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.work.dir, "docs", "b.md"), "no plan here\n");
  f.commit("docs only", ["docs"]);
  assert.deepEqual(runIn(f.work.dir), { exit: 0, out: ["lint-plan-precheck: SKIP -- no plan/ path in this diff"], err: [] });

  const bare = fixture(t, { lintScript: "" });
  const result = runIn(bare.work.dir);
  assert.equal(result.exit, 2);
  assert.match(result.err.join("\n"), /could not run \(package\.json has no plain `node \.\.\.` lint-plan:fast script\)/);
});
