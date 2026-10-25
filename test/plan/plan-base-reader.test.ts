import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readPlanBase } from "#src/lib/plan-base-reader.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SHARD = `- id: W9-T1
  title: First repository plan
  repo: remudero
  type: implement
  verify: auto
  status: queued
  origin: fixture
  files:
    - docs/a.md
  acceptance:
    - claim: The document says hello
      proof: "grep: hello in docs/a.md"
`;

function fixture(t: TestContext, existingShard = false) {
  const repo = gitRepo({ scope: t, kind: "first-plan" });
  writeFileSync(join(repo.dir, "README.md"), "new repository\n");
  if (existingShard) {
    mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
    writeFileSync(join(repo.dir, "plan/tasks.d/prior.yaml"), SHARD);
  }
  repo.git("add", ".");
  repo.git("commit", "-qm", "README-only base or existing shard");
  const base = repo.git("rev-parse", "HEAD");
  mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
  mkdirSync(join(repo.dir, "docs"));
  copyFileSync(join(REPO_ROOT, "plan/policy.yaml"), join(repo.dir, "plan/policy.yaml"));
  writeFileSync(join(repo.dir, "plan/tasks.yaml"), "[]\n");
  writeFileSync(join(repo.dir, "docs/a.md"), "hello\n");
  const lint = (shard = SHARD) => {
    writeFileSync(join(repo.dir, "plan/tasks.d/prior.yaml"), shard);
    repo.git("add", ".");
    repo.git("commit", "--allow-empty", "-qm", "file plan");
    const result = spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts/lint-plan-offline.mjs"),
      "--repo-root", repo.dir, "--plan", join(repo.dir, "plan/tasks.yaml"), "--base", base], {
      cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, RMD_SELF_SYNC_DONE: "1" },
    });
    assert.ifError(result.error);
    return { code: result.status, output: result.stdout + result.stderr };
  };
  return { repo, base, lint };
}

test("W1-T10621: a README-only repository can qualify its first valid sharded plan", (t) => {
  const { repo, base, lint } = fixture(t);
  assert.deepEqual(readPlanBase(repo.dir, base, "plan/tasks.yaml"), { commit: base, raw: "[]\n", absent: true });
  const result = lint();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /rmd lint-plan: 1 task\(s\) checked/);
});

test("W1-T10621: the first plan still refuses malformed or unreserved new task records", (t) => {
  const { lint } = fixture(t);
  const result = lint(SHARD.replace("grep: hello in docs/a.md", "a bare proof title"));
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /\[proof-dialect\]/);
  assert.match(result.output, /rmd lint-plan: 1 task\(s\) checked/);
});

test("an absent aggregator preserves unchanged base shards in the real lint scope", (t) => {
  const { lint } = fixture(t, true);
  const result = lint();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /rmd lint-plan: 0 task\(s\) checked/);
});

test("W1-T10621: unreadable commits and blobs never become an empty base", (t) => {
  const { repo, base } = fixture(t);
  assert.throws(() => readPlanBase(repo.dir, "not-a-commit", "plan/tasks.yaml"));
  writeFileSync(join(repo.dir, "plan/tasks.yaml"), "broken yaml: [\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "existing malformed blob");
  const head = repo.git("rev-parse", "HEAD");
  assert.deepEqual(readPlanBase(repo.dir, head, "plan/tasks.yaml"), { commit: head, raw: "broken yaml: [\n", absent: false });
  const git = (args: readonly string[]) => {
    if (args[0] === "show") throw new Error("blob read failed");
    return repo.git(...args);
  };
  assert.throws(() => readPlanBase(repo.dir, head, "plan/tasks.yaml", git), /blob read failed/);
  assert.throws(() => readPlanBase(repo.dir, base, "plan/tasks.yaml", () => { throw new Error("tree read failed"); }), /tree read failed/);
});

test("base readers refuse symlinks, trees, unsafe paths and malformed Git metadata", (t) => {
  const { repo } = fixture(t);
  symlinkSync("../README.md", join(repo.dir, "plan/link.yaml"));
  repo.git("add", ".");
  repo.git("commit", "-qm", "symlink base");
  assert.throws(() => readPlanBase(repo.dir, "HEAD", "plan/link.yaml"), /regular blob/);
  assert.throws(() => readPlanBase(repo.dir, "HEAD", "plan"), /regular blob/);
  for (const path of ["../tasks.yaml", "/tasks.yaml", "plan//tasks.yaml", "plan/./tasks.yaml"]) {
    assert.throws(() => readPlanBase(repo.dir, "HEAD", path), /relative path/);
  }
  assert.throws(() => readPlanBase(repo.dir, "HEAD", "plan/tasks.yaml", () => "not a sha"), /commit/);
  let calls = 0;
  assert.throws(() => readPlanBase(repo.dir, "HEAD", "plan/tasks.yaml", () => ++calls === 1 ? "a".repeat(40) : "garbled"), /tree entry/);
});
