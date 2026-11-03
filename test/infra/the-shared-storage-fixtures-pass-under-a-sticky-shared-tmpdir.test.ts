import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test, type TestContext } from "node:test";

import { accountOwnedFixtureRoot } from "#test/helpers/account-owned-fixture-root.js";
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

/** A FRESH world-writable sticky (1777) directory, made here rather than searched for, so the case
 * asserts something on every host. It lives under an account-owned 0700 parent outside /tmp. */
function freshStickyTmpdir(t: TestContext): string {
  const parent = accountOwnedFixtureRoot(t, ".rmd-sticky-tmpdir-");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const sticky = join(parent, "shared-tmp");
  mkdirSync(sticky);
  chmodSync(sticky, 0o1777);
  const facts = lstatSync(sticky);
  assert.equal(facts.mode & 0o7777, 0o1777, "the TMPDIR under test must be world-writable and sticky");
  assert.ok(!realpathSync(sticky).startsWith("/tmp/"), "the sticky TMPDIR must sit outside /tmp");
  return realpathSync(sticky);
}

test("W1-T11102 criterion 1: both suites pass under a group-writable umask with TMPDIR at a fresh sticky 1777 directory", (t) => {
  const sticky = freshStickyTmpdir(t);
  for (const suite of SUITES) {
    const result = runUnderHostConditions(suite, sticky);
    assert.equal(result.fail, 0, `${suite} under umask 0002 and TMPDIR=${sticky}:\n${result.out}`);
    assert.ok(result.pass > 0, `${suite} reported no passing case:\n${result.out}`);
    assert.equal(result.status, 0, result.out);
  }
});

test("W1-T11102 criterion 2: the shared helper roots a fixture in an account-owned 0700 dir outside every shared temp root", (t) => {
  const root = accountOwnedFixtureRoot(t, "rmd-account-owned-probe-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const facts = lstatSync(root);
  assert.ok(facts.isDirectory());
  assert.equal(facts.uid, process.getuid?.());
  assert.equal(facts.mode & 0o777, 0o700);
  // The test setup relocates HOME into TMPDIR, so this fails for a helper that roots under homedir().
  for (const shared of [tmpdir(), realpathSync(tmpdir()), "/tmp", "/var/tmp", "/dev/shm"]) {
    assert.ok(root !== shared && !root.startsWith(shared.endsWith(sep) ? shared : shared + sep), `${root} sits under shared ${shared}`);
  }
  assert.match(root, /rmd-account-owned-probe-[^/]+$/, "the rmd- ancestor naming the scratch planner reads is kept");
});
