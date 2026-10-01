import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { gitRepo } from "./helpers/git-repo.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let sequence = 0;

function fixture(t: TestContext) {
  const remote = gitRepo({ kind: "self-credit-remote", bare: true });
  const parent = gitRepo({ kind: "self-credit-parent" });
  const work = parent.addWorktree(join(dirname(parent.dir), `rmd-self-credit-${process.pid}-${sequence++}`), "fixture");
  t.after(() => work.cleanup());
  for (const dir of ["hooks", "scripts/lib", "plan/tasks.d", "src"]) mkdirSync(join(work.dir, dir), { recursive: true });
  copyFileSync(join(ROOT, "hooks", "pre-push"), join(work.dir, "hooks", "pre-push"));
  chmodSync(join(work.dir, "hooks", "pre-push"), 0o755);
  for (const file of ["worker-branch-shape.mjs", "lib/argv.mjs", "lib/git.mjs"]) {
    copyFileSync(join(ROOT, "scripts", file), join(work.dir, "scripts", file));
  }
  writeFileSync(join(work.dir, "plan", "tasks.yaml"), "[]\n");
  work.addRemote("origin", remote.dir);
  work.git("config", "core.hooksPath", "hooks");
  work.git("add", "-A");
  work.git("commit", "--quiet", "-m", "fixture base");
  work.git("update-ref", "refs/remotes/origin/main", "HEAD");

  const shard = () => {
    writeFileSync(join(work.dir, "plan", "tasks.d", "W9-T1-shard.yaml"), "- id: W9-T1\n  title: example\n");
    work.git("add", "plan/tasks.d/W9-T1-shard.yaml");
  };
  const commit = () => work.git("commit", "--quiet", "-m", "file a plan shard");
  const push = (head: string, source = "HEAD") => spawnSync("git", ["push", "origin", `${source}:refs/heads/${head}`], {
    cwd: work.dir,
    encoding: "utf8",
    env: { ...process.env, RMD_PREPUSH_GATES: "1" },
  });
  return { work, shard, commit, push };
}

test("self-crediting plan filing is stopped before its first push", (t) => {
  const f = fixture(t);
  f.shard();
  f.commit();
  const result = f.push("run-W9-T1-1790820133000");
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /plan-filing-run-credit/);
  assert.match(result.stderr, /pre-push REFUSED/);
});

test("non-crediting filings and implementation branches remain pushable", (t) => {
  const filing = fixture(t);
  filing.shard();
  filing.commit();
  const ordinary = filing.push("codex/file-W9-T1");
  assert.equal(ordinary.status, 0, ordinary.stderr);
  const malformedRun = filing.push("run-W9-T1-not-an-epoch");
  assert.equal(malformedRun.status, 0, malformedRun.stderr);
  assert.match(malformedRun.stderr, /could not read.*not blocking/);

  const implementation = fixture(t);
  implementation.shard();
  writeFileSync(join(implementation.work.dir, "src", "example.ts"), "export const example = true;\n");
  implementation.work.git("add", "src/example.ts");
  implementation.commit();
  const built = implementation.push("run-W9-T1-1790820133001");
  assert.equal(built.status, 0, built.stderr);
});

test("the committed shard, not a dirty working-tree copy, decides the push", (t) => {
  const f = fixture(t);
  f.shard();
  f.commit();
  writeFileSync(join(f.work.dir, "plan", "tasks.d", "W9-T1-shard.yaml"), "- id: W9-T2\n  title: uncommitted edit\n");
  const result = f.push("run-W9-T1-1790820133003");
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /plan-filing-run-credit/);
});

test("the pushed source commit, not the checked-out HEAD, decides the push", (t) => {
  const f = fixture(t);
  f.shard();
  f.commit();
  f.work.git("branch", "filed-shard");
  f.work.git("switch", "--quiet", "-c", "other", "origin/main");
  const result = f.push("run-W9-T1-1790820133004", "filed-shard");
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /plan-filing-run-credit/);
});

test("unreadable branch-shape evidence cannot strand a push", (t) => {
  const f = fixture(t);
  f.shard();
  f.commit();
  f.work.git("update-ref", "-d", "refs/remotes/origin/main");
  const result = f.push("run-W9-T1-1790820133002");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /could not read.*not blocking/);
});
