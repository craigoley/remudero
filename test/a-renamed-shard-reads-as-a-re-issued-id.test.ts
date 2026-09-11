import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = process.cwd();
const SCRIPT = join(REPO_ROOT, "scripts", "task-id-existence-check.mjs");

function planFixture(): GitRepo {
  const repo = gitRepo({ kind: "t3204-plan", seedCommit: false });
  const dir = repo.dir;
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(dir, "plan", "tasks.d", "W1-T900-original.yaml"), '- id: W1-T900\n  title: "t"\n');
  repo.git("add", "-A");
  repo.git("commit", "-qm", "base");
  return repo;
}

function runCheck(cwd: string) {
  return spawnSync(process.execPath, [SCRIPT, "--cwd", cwd, "--base", "main", "--dir", "src", "--baseline", join(REPO_ROOT, "scripts", "task-id-existence-baseline.json")], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

test("W1-T3204: renaming a shard is not re-issuing its id", () => {
  const repo = planFixture();
  const dir = repo.dir;
  try {
    repo.git("mv", "plan/tasks.d/W1-T900-original.yaml", "plan/tasks.d/W1-T900-renamed.yaml");
    const result = runCheck(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /ALREADY DECLARED/);
  } finally {
    repo.cleanup();
  }
});

test("W1-T3204 MUTANT: a second file for an id whose base file survives is still refused", () => {
  const repo = planFixture();
  const dir = repo.dir;
  try {
    writeFileSync(join(dir, "plan", "tasks.d", "W1-T900-collision.yaml"), '- id: W1-T900\n  title: "t"\n');
    const result = runCheck(dir);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /ALREADY DECLARED/);
    assert.match(result.stderr, /W1-T900-original\.yaml/);
    assert.match(result.stderr, /W1-T900-collision\.yaml/);
  } finally {
    repo.cleanup();
  }
});
