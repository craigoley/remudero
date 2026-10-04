import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildCreditCandidates, buildEscalationReconcileCandidates } from "../src/run-task.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const TASK_ID = "W1-T4774";
const PR_NUMBER = 9001;
const task: Task = {
  id: TASK_ID, title: TASK_ID, repo: "target", depends_on: [], type: "implement",
  verify: "auto", risk: "medium", status: "queued", attempts: 0,
};
const plan: Plan = { tasks: [task], byId: new Map([[TASK_ID, task]]) };
const pr = {
  number: PR_NUMBER, url: `https://github.com/o/target/pull/${PR_NUMBER}`, state: "MERGED",
  headRefName: `run-${TASK_ID}-1000`, body: `Remudero-Task: ${TASK_ID}\n`,
};
const github: GitHub = {
  prByRef: () => pr,
  findMergedByTrailer: () => null,
  findMergedByHeadBranch: () => [pr],
  listMergedHeadBranches: () => [pr],
  headRefName: () => pr.headRefName,
  prBody: () => pr.body,
  changedFiles: () => ["src/example.ts"],
};
const creditIo = { readCreditStore: () => ({}), writeCreditStore: () => {} };

function commit(repo: GitRepo, path: string, subject: string): string {
  const full = join(repo.dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${subject}\n`);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", `${subject} (#${PR_NUMBER})`);
  const sha = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", sha);
  return sha;
}

function reconcile(repo: GitRepo, evidenceRootFor: () => string | undefined = () => repo.dir) {
  return buildEscalationReconcileCandidates("o", "target", plan, join(repo.dir, "ledger.ndjson"), undefined, {
    github, creditIo, evidenceRootFor,
    issues: {
      create: () => { throw new Error("reconciliation must only read issues"); },
      listOpen: () => [{ number: 1, url: "issue:1", state: "open", title: "blocked", body: `**Task:** ${TASK_ID}\n` }],
    },
  });
}

function spy(t: TestContext) {
  const logs: string[][] = [];
  const resolutions: string[][] = [];
  let fail: "paths" | "subjects" | undefined;
  const exec = childProcess.execFileSync;
  const spawn = childProcess.spawnSync;
  t.mock.method(childProcess, "execFileSync", (...args: Parameters<typeof exec>) => {
    const argv = args[1] as string[];
    if (args[0] === "git" && argv?.[0] === "log") {
      logs.push([...argv]);
      if (fail === (argv.includes("--name-only") ? "paths" : "subjects")) throw new Error("git log unavailable");
    }
    return Reflect.apply(exec, childProcess, args);
  });
  t.mock.method(childProcess, "spawnSync", (...args: Parameters<typeof spawn>) => {
    const argv = args[1] as string[];
    if (args[0] === "git" && argv?.[0] === "rev-parse") resolutions.push([...argv]);
    return Reflect.apply(spawn, childProcess, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return {
    logs, resolutions,
    paths: () => logs.filter((args) => args.includes("--name-only")).length,
    subjects: () => logs.filter((args) => !args.includes("--name-only")).length,
    fail: (kind: typeof fail) => { fail = kind; },
  };
}

test("W1-T4774: an unmoved main reuses the merged paths scan", (t) => {
  const repo = gitRepo({ kind: "merge-log-reuse" });
  const sha = commit(repo, "src/example.ts", "feat: implement it");
  const calls = spy(t);
  const first = reconcile(repo);
  assert.equal(first[0]?.derived.merged, true);
  assert.deepEqual(reconcile(repo), first);
  assert.equal(calls.paths(), 1);
  assert.equal(calls.subjects(), 1);
  assert.equal(calls.resolutions.length, 2, "one resolution per pass, shared by both scans");
  assert.ok(calls.logs.every((args) => args[1] === sha), "both scans read the resolved commit");
});

test("W1-T4774: a moved main rescans the merged paths", (t) => {
  const repo = gitRepo({ kind: "merge-log-moved" });
  commit(repo, "plan/task.yaml", "chore(plan): file it");
  const calls = spy(t);
  assert.equal(reconcile(repo)[0]?.derived.merged, false, "a filing does not close an escalation");
  const moved = commit(repo, "src/example.ts", "feat: implement it");
  assert.equal(reconcile(repo)[0]?.derived.merged, true, "new paths and subject now prove implementation");
  assert.equal(reconcile(repo)[0]?.derived.merged, true);
  assert.equal(calls.paths(), 2);
  assert.equal(calls.subjects(), 2);
  assert.ok(calls.logs.slice(2).every((args) => args[1] === moved));
  assert.equal(calls.resolutions.length, 3);
});

test("W1-T4774: credit and escalation builders share the successful scans", (t) => {
  const repo = gitRepo({ kind: "merge-log-shared" });
  commit(repo, "src/example.ts", "feat: implement it");
  const calls = spy(t);
  const credits = () => buildCreditCandidates("o", "target", plan, join(repo.dir, "ledger.ndjson"), undefined,
    github, () => repo.dir, () => [], creditIo);
  assert.equal(credits()[0]?.creditIsImplementation, true);
  assert.equal(credits()[0]?.creditHasBuildDiff, true);
  assert.equal(reconcile(repo)[0]?.derived.merged, true);
  assert.equal(calls.paths(), 1);
  assert.equal(calls.subjects(), 1);
});

test("W1-T4774: evidence stays rooted in each target checkout", (t) => {
  const build = gitRepo({ kind: "merge-log-build" });
  const filing = gitRepo({ kind: "merge-log-filing" });
  commit(build, "src/example.ts", "feat: implement it");
  commit(filing, "plan/task.yaml", "chore(plan): file it");
  const calls = spy(t);
  assert.equal(reconcile(build)[0]?.derived.merged, true);
  assert.equal(reconcile(filing)[0]?.derived.merged, false);
  assert.equal(reconcile(build)[0]?.derived.merged, true);
  assert.equal(calls.paths(), 2);
  assert.equal(calls.subjects(), 2);
});

for (const kind of ["paths", "subjects"] as const) {
  test(`W1-T4774: a failed ${kind} scan is retried on unchanged main`, (t) => {
    const repo = gitRepo({ kind: `merge-log-failed-${kind}` });
    commit(repo, kind === "paths" ? "plan/task.yaml" : "src/example.ts",
      kind === "paths" ? "chore(plan): file it" : "feat: implement it");
    const calls = spy(t);
    calls.fail(kind);
    const failed = reconcile(repo);
    assert.equal(failed[0]?.derived.merged, false);
    assert.equal(failed[0]?.derived.source, "head-branch");
    if (kind === "subjects") assert.equal(failed[0]?.derived.indeterminate, true);
    calls.fail(undefined);
    const recovered = reconcile(repo);
    assert.equal(recovered[0]?.derived.merged, kind === "subjects");
    if (kind === "paths") assert.equal(recovered[0]?.derived.source, "none");
    assert.deepEqual(reconcile(repo), recovered);
    assert.equal(calls.paths(), kind === "paths" ? 2 : 1);
    assert.equal(calls.subjects(), kind === "subjects" ? 2 : 1, "successful scans are memoized; failures retry");
  });
}

test("W1-T4774: a missing main cannot reuse stale evidence and recovery rescans", (t) => {
  const repo = gitRepo({ kind: "merge-log-missing-main" });
  const sha = commit(repo, "src/example.ts", "feat: implement it");
  const calls = spy(t);
  assert.equal(reconcile(repo)[0]?.derived.merged, true);
  repo.git("update-ref", "-d", "refs/remotes/origin/main");
  const missing = reconcile(repo);
  assert.equal(missing[0]?.derived.merged, false);
  assert.equal(missing[0]?.derived.indeterminate, true);
  repo.git("update-ref", "refs/remotes/origin/main", sha);
  assert.equal(reconcile(repo)[0]?.derived.merged, true);
  assert.equal(calls.paths(), 3);
  assert.equal(calls.subjects(), 3);
});

test("W1-T4774: an absent evidence root performs no git reads", (t) => {
  const repo = gitRepo({ kind: "merge-log-absent-root" });
  const calls = spy(t);
  const absent = reconcile(repo, () => undefined);
  assert.equal(absent[0]?.derived.merged, false);
  assert.equal(absent[0]?.derived.indeterminate, true);
  assert.equal(calls.logs.length, 0);
  assert.equal(calls.resolutions.length, 0);
});
