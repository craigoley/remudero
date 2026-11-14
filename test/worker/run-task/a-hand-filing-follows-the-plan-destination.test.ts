import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/** Plain git in `dir`, for the fixture's own setup and reads. */
function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
const TASK = "plan/tasks.d/W1-T300-a-hand-filed-ops-task.yaml";

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
const seedTask = (id: number) => `- id: W1-T${id}\n  title: fixture task\n  repo: remudero\n  type: implement\n  status: queued\n  depends_on: []\n`;

/** A public origin and clone, an ops origin, the ops checkout at `<root>/repos/fixture-ops` and a hand worktree of it. */
function fixture(t: TestContext, switchText?: string, opsSeed = true) {
  const root = ownedFixtureDir(t, "hand-filing-destination").dir;
  const origin = gitRepo({ bare: true, scope: t, kind: "hand-public-origin" });
  const pub = gitRepo({ scope: t, kind: "hand-public" });
  pub.addRemote("origin", origin.dir);
  put(join(pub.dir, "plan/tasks.yaml"), seedTask(100));
  pub.git("add", "-A"); pub.git("commit", "-qm", "public plan");
  pub.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  // The ops origin's path ends in <owner>/<name>.git, so its checkout names the repository the host file names.
  const opsOrigin = join(root, "origins", "fixture-owner", "fixture-ops.git");
  mkdirSync(opsOrigin, { recursive: true });
  git(opsOrigin, "init", "--quiet", "--bare", "-b", "main");
  const ops = join(root, "repos", "fixture-ops");
  pub.git("clone", "--quiet", opsOrigin, ops);
  // The lint cases read the real public plan as their code root, which holds every small id: they seed no ops task.
  put(join(ops, "plan/tasks.yaml"), opsSeed ? seedTask(200) : "[]\n");
  pub.git("-C", ops, "add", "-A"); pub.git("-C", ops, "commit", "-qm", "ops plan");
  pub.git("-C", ops, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  pub.git("-C", ops, "fetch", "--quiet", "origin");
  // A public filing branch: a reservation is never held by main.
  pub.git("checkout", "--quiet", "-b", "public-filing-branch");
  const hand = join(root, "hand-ops");
  pub.git("-C", ops, "worktree", "add", "--quiet", "-b", "ops-filing-branch", hand, "origin/main");
  const home = join(root, "home");
  put(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root, installRoot: REPO_ROOT, claudeBin: "/usr/bin/true" }));
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  if (switchText !== undefined) writeFileSync(join(state, "plan-destination.json"), switchText);
  return { root, origin, pub, opsOrigin, ops, hand, home, state };
}

// The real exported commands in a child of their own: HOME names the fixture's config, and the working
// directory is the hand worktree. Every git writer is confined to the disposable bare fixtures.
const CHILD = String.raw`
const req=JSON.parse(process.env.RMD_HAND_CASE);
const {spawnSync}=await import('node:child_process');
const mod=await import(req.source+'/src/run-task.ts');
const out=[],err=[];console.log=(...a)=>out.push(a.join(' '));console.error=(...a)=>err.push(a.join(' '));
process.chdir(req.cwd);
let code;
try{
  if(req.mode==='command')code=await mod.HANDLERS.get('plan-destination')(req.args);
  else if(req.mode==='lint')code=await mod.lintPlanCommand(['--base','origin/main','--merge-base','--offline'],{offline:true,repoRoot:req.cwd});
  else{
    const runGit=(args)=>{const r=spawnSync('git',['-C',req.pub,...args],{encoding:'utf8'});return{status:r.status,stdout:r.stdout??'',stderr:r.stderr??''};};
    code=await mod.nextTaskIdCommand(req.args,{},{repoRoot:req.pub,runGit,openPrTexts:()=>[],destinationPrFetch:()=>[]});
  }
}catch(error){err.push(String(error?.stack??error));code=99;}
process.stdout.write(JSON.stringify({code,out,err})+'\n');
`;
function invoke(f: ReturnType<typeof fixture>, mode: "command" | "lint" | "next", args: string[] = [], cwd = f.hand) {
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", CHILD], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, HOME: f.home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
      GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
      RMD_GH_CACHE_HOME: join(f.root, "gh-cache"),
      RMD_HAND_CASE: JSON.stringify({ source: REPO_ROOT, pub: f.pub.dir, cwd, mode, args }) },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").at(-1)!) as { code: number; out: string[]; err: string[] };
}
const ON = JSON.stringify({ repository: "fixture-owner/fixture-ops", kinds: ["task"] });

/** A new ops task that depends on a public task (W1-T12200) and names a public source file. */
function fileOpsTask(f: ReturnType<typeof fixture>): void {
  put(join(f.hand, TASK), [
    "- id: W1-T300", "  title: a hand-filed ops task reads public code", "  repo: remudero", "  origin: operator-session#hand",
    "  depends_on: [W1-T12200]", "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0",
    "  files: [src/lib/plan-destination.ts]", "  acceptance:",
    "    - claim: the resolver names the hand-filed marker",
    "      proof: \"grep: hand-filed ops marker in src/lib/plan-destination.ts\"",
    "  design: |", "    NO-INVARIANTS: a fixture task.", ""].join("\n"));
  spawnSync("git", ["-C", f.hand, "add", "-A"]);
  spawnSync("git", ["-C", f.hand, "commit", "-qm", "chore(plan): file W1-T300"], {
    env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
}

test("W1-T12216 criterion 1: rmd plan-destination prints the repository and checkout for a kind, and an unreadable host file", (t) => {
  const f = fixture(t, ON);
  const on = invoke(f, "command", ["task"]);
  assert.equal(on.code, 0, on.err.join("\n"));
  assert.deepEqual(on.out.join("\n").split("\n"),
    ["kind: task", "outcome: destination", "repository: fixture-owner/fixture-ops", `checkout: ${join(f.root, "repos", "fixture-ops")}`]);
  const notListed = invoke(f, "command", ["feedback"]);
  assert.match(notListed.out.join("\n"), /^outcome: not_listed$/m);
  assert.match(notListed.out.join("\n"), /^repository: craigoley\/remudero$/m);
  writeFileSync(join(f.state, "plan-destination.json"), "{ not json");
  const unreadable = invoke(f, "command", ["task"]);
  assert.equal(unreadable.code, 1);
  assert.match(unreadable.out.join("\n"), /^outcome: unreadable$/m);
  assert.match(unreadable.out.join("\n"), /^reason: .*not valid JSON$/m);
  assert.doesNotMatch(unreadable.out.join("\n"), /^repository:/m, "an unreadable host file names no repository");
  assert.equal(invoke(f, "command", ["tasks"]).code, 2, "a kind that is not one of the three is a usage error");
});

test("W1-T12216 criterion 2: rmd next-task-id --branch takes a branch of the destination checkout and records it as the holder", (t) => {
  const f = fixture(t, ON);
  const named = invoke(f, "next", ["--reserve", "--branch", "ops-filing-branch"]);
  assert.equal(named.code, 0, named.err.join("\n"));
  assert.match(named.out.join("\n"), /^RESERVED W1-T201 on origin/m, "the id is above both catalogs");
  assert.match(f.origin.git("log", "-1", "--format=%B", "refs/rmd-id/W1-T201"), /ops-filing-branch/, "the holder is the destination branch");
  assert.equal(git(f.opsOrigin, "for-each-ref", "--format=%(refname)", "refs/rmd-id/"), "", "the reservation ref stays on the public repository");
  const current = invoke(f, "next", ["--reserve"]);
  assert.equal(current.code, 0, current.err.join("\n"));
  assert.match(f.origin.git("log", "-1", "--format=%B", "refs/rmd-id/W1-T202"), /ops-filing-branch/,
    "with no --branch, the holder is the current branch of the destination worktree");
});

test("W1-T12216 criterion 3: the fast plan lint in a destination checkout takes the public checkout as its code root", (t) => {
  const f = fixture(t, ON, false);
  fileOpsTask(f);
  const linted = invoke(f, "lint");
  assert.equal(linted.code, 0, [...linted.out, ...linted.err].join("\n"));
  assert.match(linted.out.join("\n"), /1 task\(s\) checked/);
  rmSync(join(f.state, "plan-destination.json"));
  const alone = invoke(f, "lint");
  assert.notEqual(alone.code, 0, "positive control: without the switch the ops checkout holds no public dependency or code");
  assert.match(alone.err.join("\n"), /W1-T12200/);
});

test("W1-T12216 criterion 4: with no host file the command names the public repository, and the other two behave as today", (t) => {
  const f = fixture(t, undefined, false);
  const off = invoke(f, "command", ["task"]);
  assert.equal(off.code, 0, off.err.join("\n"));
  assert.deepEqual(off.out.join("\n").split("\n"), ["kind: task", "outcome: off", "repository: craigoley/remudero", `checkout: ${REPO_ROOT}`]);
  const minted = invoke(f, "next", ["--reserve"]);
  assert.equal(minted.code, 0, minted.err.join("\n"));
  assert.match(minted.out.join("\n"), /^RESERVED W1-T101 on origin/m, "the mint reads the public plan alone, as before");
  assert.match(f.origin.git("log", "-1", "--format=%B", "refs/rmd-id/W1-T101"), /public-filing-branch/,
    "with no host file the holder is the branch of the reserving checkout, as before");
  fileOpsTask(f);
  assert.notEqual(invoke(f, "lint").code, 0, "with no host file the lint reads the checkout's own code, as before");
});
