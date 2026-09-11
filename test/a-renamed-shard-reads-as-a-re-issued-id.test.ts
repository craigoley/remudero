import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = process.cwd();
const SCRIPT = join(REPO_ROOT, "scripts", "task-id-existence-check.mjs");

function planRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t3204-plan-`));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir, env });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, env });
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(dir, "plan", "tasks.d", "W1-T900-original.yaml"), '- id: W1-T900\n  title: "t"\n');
  execFileSync("git", ["add", "-A"], { cwd: dir, env });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir, env });
  return dir;
}

function runCheck(cwd: string) {
  return spawnSync(process.execPath, [SCRIPT, "--cwd", cwd, "--base", "main", "--dir", "src", "--baseline", join(REPO_ROOT, "scripts", "task-id-existence-baseline.json")], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

test("W1-T3204: renaming a shard is not re-issuing its id", () => {
  const dir = planRepo();
  try {
    execFileSync("git", ["mv", "plan/tasks.d/W1-T900-original.yaml", "plan/tasks.d/W1-T900-renamed.yaml"], { cwd: dir });
    const result = runCheck(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /ALREADY DECLARED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3204 MUTANT: a second file for an id whose base file survives is still refused", () => {
  const dir = planRepo();
  try {
    writeFileSync(join(dir, "plan", "tasks.d", "W1-T900-collision.yaml"), '- id: W1-T900\n  title: "t"\n');
    const result = runCheck(dir);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /ALREADY DECLARED/);
    assert.match(result.stderr, /W1-T900-original\.yaml/);
    assert.match(result.stderr, /W1-T900-collision\.yaml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
