import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SUITES = [
  "test/review/shared-git-storage.test.ts",
  "test/no-test-fixture-state-lands-under-the-real-scratch-root.test.ts",
];

function runUnderHostConditions(suite: string, tmp: string): { status: number | null; pass: number; fail: number; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
  for (const key of Object.keys(env)) if (key === "NODE_TEST_CONTEXT" || key.startsWith("GIT_")) delete env[key];
  const run = spawnSync("bash", ["-c", 'umask 0002; exec "$0" "$@"', process.execPath, "--import", "tsx", "--import",
    "./test/setup/tmp-hygiene.ts", "--test", "--test-reporter=tap", suite], { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  const count = (name: string) => Number(new RegExp(`^# ${name} (\\d+)$`, "m").exec(run.stdout)?.[1] ?? -1);
  return { status: run.status, pass: count("pass"), fail: count("fail"), out: `${run.stdout}\n${run.stderr}`.slice(-4000) };
}

function assertSuitesPass(tmp: string): void {
  for (const suite of SUITES) {
    const result = runUnderHostConditions(suite, tmp);
    assert.equal(result.fail, 0, `${suite} under umask 0002 and TMPDIR=${tmp}:\n${result.out}`);
    assert.ok(result.pass > 0, `${suite} reported no passing case:\n${result.out}`);
    assert.equal(result.status, 0, result.out);
  }
}

function sharedStickyTempDirs(): string[] {
  const candidates = ["/dev/shm", tmpdir()];
  const found = new Set<string>();
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const dir = realpathSync(candidate);
    const facts = lstatSync(dir);
    const sharedSticky = facts.isDirectory() && (facts.mode & 0o1002) === 0o1002 && facts.uid !== process.getuid?.();
    if (sharedSticky && dir !== "/tmp" && !dir.startsWith("/tmp/") && dir !== "/var/tmp") found.add(dir);
  }
  return [...found];
}

test("W1-T11102 criterion 1: both suites pass under a group-writable umask with TMPDIR at a shared sticky directory outside /tmp", (t) => {
  const dirs = sharedStickyTempDirs();
  if (dirs.length === 0) {
    t.skip("no shared sticky directory other than /tmp exists on this host (checked /dev/shm and the temp root)");
    return;
  }
  for (const dir of dirs) assertSuitesPass(dir);
});
