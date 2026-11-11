import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { accountOwnedFixtureRoot } from "#test/helpers/account-owned-fixture-root.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SUITE = "test/review/evidence-storage.test.ts";
const SYMLINKED_ROOT_TITLE = "evidence root refuses symlinked roots and never recursively enters checkouts";

type Run = { status: number | null; pass: number; fail: number; skipped: number; todo: number; stdout: string; stderr: string };

function plainMkdirMode(tmp: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
  const command = "umask 0002; node -e 'const fs=require(\"node:fs\"); const p=process.env.TMPDIR+\"/plain-mkdir-control\"; fs.mkdirSync(p); const mode=fs.lstatSync(p).mode&0o777; fs.rmSync(p,{recursive:true}); process.stdout.write(mode.toString(8))'";
  const run = spawnSync("bash", ["-c", command], { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 10_000 });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

function runSuite(umask: "0022" | "0002", tmp: string): Run {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
  for (const key of Object.keys(env)) if (key === "NODE_TEST_CONTEXT" || key.startsWith("GIT_")) delete env[key];
  const command = 'umask ' + umask + '; exec "$@"';
  const run = spawnSync("bash", ["-c", command, "bash", process.execPath, "--import", "tsx", "--import",
    "./test/setup/tmp-hygiene.ts", "--test", "--test-reporter=tap", SUITE], {
    cwd: REPO_ROOT, env, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
  });
  const count = (name: string) => Number(new RegExp("^# " + name + " (\\d+)$", "m").exec(run.stdout)?.[1] ?? -1);
  return { status: run.status, pass: count("pass"), fail: count("fail"), skipped: count("skipped"), todo: count("todo"),
    stdout: run.stdout, stderr: run.stderr };
}

function freshPrivateTmpdir(t: TestContext): string {
  const dir = accountOwnedFixtureRoot(t, ".rmd-evidence-umask-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const facts = lstatSync(dir);
  assert.equal(facts.mode & 0o777, 0o700);
  return dir;
}

test("evidence-storage fixtures pass under ordinary and group-writable umasks", (t) => {
  const tmp = freshPrivateTmpdir(t);
  for (const umask of ["0022", "0002"] as const) {
    const result = runSuite(umask, tmp);
    const output = result.stdout + "\n" + result.stderr;
    assert.equal(result.status, 0, "evidence suite under umask " + umask + ":\n" + output.slice(-6000));
    assert.ok(result.pass > 0, "no TAP pass summary under umask " + umask + ":\n" + output.slice(-6000));
    assert.equal(result.fail, 0, "failures under umask " + umask + ":\n" + output.slice(-6000));
    assert.equal(result.skipped, 0, "skips under umask " + umask + ":\n" + output.slice(-6000));
    assert.equal(result.todo, 0, "todos under umask " + umask + ":\n" + output.slice(-6000));
    const titlePassed = result.stdout.split("\n").some((line) => line.startsWith("ok ") && line.endsWith(" - " + SYMLINKED_ROOT_TITLE));
    assert.ok(titlePassed, "symlinked-root title must pass under umask " + umask + ":\n" + output.slice(-6000));
    if (umask === "0002") assert.equal(plainMkdirMode(tmp), "775", "plain mkdir control did not prove umask 0002");
  }

  const source = readFileSync(join(REPO_ROOT, SUITE), "utf8");
  const caseStart = source.indexOf("test('evidence root refuses symlinked roots and never recursively enters checkouts'");
  assert.notEqual(caseStart, -1, "symlinked-root test case must remain present");
  const caseEnd = source.indexOf("\n});", caseStart);
  assert.notEqual(caseEnd, -1, "symlinked-root test case must be closed");
  const symlinkCase = source.slice(caseStart, caseEnd);
  assert.ok(symlinkCase.includes("compactEvidenceRoot(link)"));
  assert.ok(symlinkCase.includes("/unverified-evidence-root/"));
  assert.ok(symlinkCase.includes("readFileSync(join(source, 'nested/closed.log'), 'utf8'), 'retained'"));
});
