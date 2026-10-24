import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function invoke(t: TestContext, roots?: string): string[] {
  const scratch = mkdtempSync(join(tmpdir(), "rmd-root-scope-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const cleanup = join(scratch, "capture-cleanup.sh");
  writeFileSync(cleanup, '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%s\\n" "${RMD_CLEANUP_ONLY_TMP-unset}" "${RMD_CLEANUP_TMP_ROOTS-unset}" "${IDLE_MINUTES-unset}"\n', { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, RMD_HOST_CLEANUP_SCRIPT: cleanup };
  delete env.RMD_CLEANUP_TMP_ROOTS;
  delete env.IDLE_MINUTES;
  if (roots !== undefined) env.RMD_CLEANUP_TMP_ROOTS = roots;
  return execFileSync("bash", [join(REPO_ROOT, "deploy/rmd-tmp-sweep.sh")], { env, encoding: "utf8" }).trimEnd().split("\n");
}

test("the scheduled root janitor keeps the mounted state temp root outside its default scope", t => {
  const [onlyTmp, roots, idle] = invoke(t);
  assert.equal(onlyTmp, "1");
  assert.equal(roots.split(":").includes("/home/craigoleyagent/rmd-state2/tmp"), false, "the running-container state mount must stay outside scheduled temp pruning");
  assert.deepEqual(roots.split(":"), ["/tmp", "/mnt/rmd/tmp", "/mnt/scratch/tmp", "/mnt/scratch/rmd-work-tmp"]);
  assert.equal(idle, "unset", "the wrapper retains native tiered retention");
});

test("the scheduled root janitor retains an explicitly configured temp scope", t => {
  const [onlyTmp, roots, idle] = invoke(t, "/fixture/approved-temp:/fixture/other-temp");
  assert.equal(onlyTmp, "1");
  assert.equal(roots, "/fixture/approved-temp:/fixture/other-temp");
  assert.equal(idle, "unset");
});
