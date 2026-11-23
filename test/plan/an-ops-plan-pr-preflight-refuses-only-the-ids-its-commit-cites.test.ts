/**
 * W1-T14187: an ops (code-root) plan-PR preflight refuses task-id-existence only for an unresolvable id the commit
 * itself newly cites. One bad prose citation already on ops main refused every lane's unrelated ops landing
 * (41 refusals 11-20/21, 8 more 11-23). The check script these trees run is a stand-in at the code root that
 * traces its argv and then runs the REAL scripts/task-id-existence-check.mjs over the tree, so the unresolved-id
 * block the preflight reads is the real script's own output, not a copy of its format.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { planPrPreflightAtCommitAsync, type PlanPrPreflightAsyncChecks, type PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const REAL_CHECK = join(REPO_ROOT, "scripts/task-id-existence-check.mjs");
const CHECK = "scripts/task-id-existence-check.mjs";
const BODY = "Acceptance:\n- fixture proof | grep: fixture in plan/tasks.yaml\n";
const GREEN = async () => ({ status: 0, output: "fixture check passed" });
const OTHER: PlanPrPreflightAsyncChecks = { lintPlan: GREEN, shardCensus: GREEN, checkProof: async () => 0, destinationStateDir: () => undefined };
const HEAD_REF = "run-fixture-ops-landing";

function put(path: string, text: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }

/** The stand-in check: trace the argv, refuse as unreadable on a `plan/unreadable` marker, else run the real check. */
function standIn(trace: string, baseline: string): string {
  const j = JSON.stringify;
  return [
    "import { appendFileSync, existsSync } from 'node:fs'; import { spawnSync } from 'node:child_process';",
    `appendFileSync(${j(trace)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + String.fromCharCode(10));`,
    "if (existsSync('plan/unreadable')) { console.error('task-id-existence: could not read the public reservation origin -- NOT reporting clean'); process.exit(2); }",
    `const r = spawnSync(process.execPath, [${j(REAL_CHECK)}, '--dir', 'plan', '--baseline', ${j(baseline)}], { encoding: 'utf8' });`,
    "process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exitCode = r.status ?? 2;",
    "",
  ].join("\n");
}

interface Fixture { code: GitRepo; ops: GitRepo; land(file: string, text: string): string; calls(): Array<{ cwd: string; args: string[] }> }
/** An ops-shaped plan repository whose main already cites W1-T999 in prose (no reservation, no record), and a code
 *  root holding the check. `publicTree` also commits the check into the plan tree, the public repository's shape. */
function fixture(t: TestContext, opts: { publicTree?: boolean; rootCommit?: boolean; parentUnreadable?: boolean } = {}): Fixture {
  const dir = ownedFixtureDir(t, "ops-inherited-id").dir;
  const trace = join(dir, "task-id-argv.ndjson");
  const baseline = join(dir, "baseline.json");
  put(baseline, "[]\n");
  const code = gitRepo({ scope: t, kind: "inherited-id-code" });
  put(join(code.dir, CHECK), standIn(trace, baseline));
  code.git("add", "--all"); code.git("commit", "-qm", "code root with the check");
  const origin = gitRepo({ bare: true, scope: t, kind: "inherited-id-origin" });
  const ops = gitRepo({ scope: t, kind: "inherited-id-ops", seedCommit: !opts.rootCommit });
  ops.addRemote("origin", origin.dir);
  put(join(ops.dir, "plan/tasks.yaml"), "[]\n");
  put(join(ops.dir, "plan/tasks.d/W1-T900-held.yaml"), "- id: W1-T900\n  note: misreads PR 999 as W1-T999 in prose\n");
  if (opts.publicTree) put(join(ops.dir, CHECK), standIn(trace, baseline));
  if (opts.parentUnreadable) put(join(ops.dir, "plan/unreadable"), "the check cannot run on this tree\n");
  ops.git("add", "--all"); ops.git("commit", "-qm", "ops main carrying an inherited citation");
  ops.git("update-ref", "refs/remotes/origin/main", "HEAD");
  return {
    code,
    ops,
    land(file: string, text: string): string {
      if (text === "") ops.git("rm", "-q", file); else { put(join(ops.dir, file), text); ops.git("add", "--all"); }
      ops.git("commit", "-qm", `land ${file}`);
      return ops.git("rev-parse", "HEAD");
    },
    calls: () => (existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}
/** The ops shape passes the code root; `publicPlan` passes none, as every public lane does. */
function preflight(f: Fixture, sha: string, opts: { publicPlan?: boolean } = {}): Promise<PlanPrPreflightResult> {
  const pr = { title: "chore(plan): fixture", body: BODY, headRef: HEAD_REF };
  return planPrPreflightAtCommitAsync(f.ops.dir, sha, opts.publicPlan ? pr : { ...pr, codeRoot: f.code.dir }, OTHER);
}
const taskIdFailures = (r: PlanPrPreflightResult) => r.failures.filter((x) => x.check === "task-id-existence");
function assertTreesCleaned(f: Fixture): void {
  const listed = f.ops.git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "));
  assert.deepEqual(listed, [`worktree ${realpathSync(f.ops.dir)}`], "both the commit tree and its first-parent tree are removed");
}

test("W1-T14187 criterion 1: an ops commit citing only resolvable ids passes although its parent already cites an unresolvable one", async (t) => {
  const f = fixture(t);
  const sha = f.land("plan/tasks.d/W1-T901-new.yaml", "- id: W1-T901\n  depends_on: [W1-T900]\n");
  const whole = spawnSync(process.execPath, [join(f.code.dir, CHECK)], { cwd: f.ops.dir, encoding: "utf8" });
  assert.equal(whole.status, 1, "control: the commit's whole tree is red, and only with the inherited id");
  assert.match(whole.stderr, /^ {2}W1-T999$/m);
  assert.doesNotMatch(whole.stderr, /^ {2}W1-T90[01]$/m);
  const before = f.calls().length;
  const r = await preflight(f, sha);
  assert.deepEqual(taskIdFailures(r), [], JSON.stringify(r));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.unreadable, []);
  const calls = f.calls().slice(before);
  assert.equal(calls.length, 2, "the commit's tree, then its first parent's, read the same way");
  assert.deepEqual(calls[1]!.args, calls[0]!.args);
  assert.equal(calls[0]!.args[calls[0]!.args.indexOf("--code-root") + 1], realpathSync(f.code.dir));
  assert.notEqual(calls[1]!.cwd, calls[0]!.cwd);
  assertTreesCleaned(f);
});

test("W1-T14187 criterion 2: an ops commit newly citing an unresolvable id is refused, naming that id and not the inherited one", async (t) => {
  const f = fixture(t);
  const sha = f.land("plan/tasks.d/W1-T902-new.yaml", "- id: W1-T902\n  depends_on: [W1-T998]\n");
  const r = await preflight(f, sha);
  assert.equal(r.ok, false, JSON.stringify(r));
  const failures = taskIdFailures(r);
  assert.equal(failures.length, 1, JSON.stringify(r));
  assert.match(failures[0]!.firstLine, /^task-id-existence: FAILED -- .* resolve to NEITHER/);
  const named = JSON.stringify(failures[0]);
  assert.match(named, /W1-T998/);
  assert.doesNotMatch(named, /W1-T999/);
  assert.equal(f.calls().length, 2);
  assertTreesCleaned(f);
});

test("W1-T14187 criterion 3: with no code root the public verdict reads the whole tree, inherited ids included, with the same argv", async (t) => {
  const f = fixture(t, { publicTree: true });
  const sha = f.land("plan/tasks.d/W1-T901-new.yaml", "- id: W1-T901\n  depends_on: [W1-T900]\n");
  const r = await preflight(f, sha, { publicPlan: true });
  const failures = taskIdFailures(r);
  assert.equal(failures.length, 1, JSON.stringify(r));
  assert.match(JSON.stringify(failures[0]), /W1-T999/);
  const calls = f.calls();
  assert.equal(calls.length, 1, "no first-parent tree is read for a public plan PR");
  assert.deepEqual(calls[0]!.args, ["--base", "origin/main", "--require-open-prs", "--head-ref", HEAD_REF]);
  assertTreesCleaned(f);
});

test("W1-T14187 criterion 3: an ops commit reading the check could not run stays unreadable, never a pass", async (t) => {
  const f = fixture(t);
  const sha = f.land("plan/unreadable", "the check cannot run on this tree\n");
  const r = await preflight(f, sha);
  assert.deepEqual(r.unreadable.map((x) => x.check), ["task-id-existence"], JSON.stringify(r));
  assert.equal(f.calls().length, 1, "an unreadable commit reading consults no parent");
  assertTreesCleaned(f);
});

test("W1-T14187 criterion 3: an ops parent the check cannot read leaves the commit's red standing", async (t) => {
  const f = fixture(t, { parentUnreadable: true });
  const sha = f.land("plan/unreadable", "");
  const r = await preflight(f, sha);
  const failures = taskIdFailures(r);
  assert.equal(failures.length, 1, JSON.stringify(r));
  assert.match(JSON.stringify(failures[0]), /W1-T999/);
  assertTreesCleaned(f);
});

test("W1-T14187 criterion 3: an ops root commit has no first parent to read, so its red stands", async (t) => {
  const f = fixture(t, { rootCommit: true });
  const sha = f.ops.git("rev-parse", "HEAD");
  assert.equal(f.ops.git("rev-list", "--count", "HEAD"), "1");
  const r = await preflight(f, sha);
  const failures = taskIdFailures(r);
  assert.equal(failures.length, 1, JSON.stringify(r));
  assert.match(JSON.stringify(failures[0]), /W1-T999/);
  assert.equal(f.calls().length, 1);
  assertTreesCleaned(f);
});
