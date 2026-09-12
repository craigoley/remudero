import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(REPO_ROOT, "hooks", "pre-push");
const CONTROL_PRECHECK = join(REPO_ROOT, "scripts", "ci-control-plane-precheck.mjs");
const CAPABILITY_CHECK = join(REPO_ROOT, "scripts", "generate-capability-snapshot.mjs");

let counter = 0;

function fixture(t: TestContext) {
  const remote = gitRepo({ kind: "t3423-remote", bare: true });
  const parent = gitRepo({ kind: "t3423-parent" });
  const work = parent.addWorktree(join(dirname(parent.dir), `rmd-t3423-wt-${process.pid}-${counter++}`), "pushbranch");
  t.after(() => work.cleanup());

  mkdirSync(join(work.dir, "hooks"), { recursive: true });
  mkdirSync(join(work.dir, "scripts"), { recursive: true });
  mkdirSync(join(work.dir, ".github", "workflows"), { recursive: true });
  mkdirSync(join(work.dir, "plan"), { recursive: true });
  mkdirSync(join(work.dir, "src"), { recursive: true });
  copyFileSync(HOOK, join(work.dir, "hooks", "pre-push"));
  chmodSync(join(work.dir, "hooks", "pre-push"), 0o755);
  writeFileSync(join(work.dir, "scripts", "rule15-precheck.mjs"), "process.exit(0)\n");
  writeFileSync(join(work.dir, "scripts", "rule25-precheck.mjs"), "process.exit(0)\n");
  writeFileSync(join(work.dir, "scripts", "test-tier-manifest.mjs"), "process.exit(0)\n");
  writeFileSync(
    join(work.dir, "scripts", "ci-control-plane-precheck.mjs"),
    `import { runCiControlPlanePrecheck } from ${JSON.stringify(CONTROL_PRECHECK)};\nprocess.exit(runCiControlPlanePrecheck());\n`,
  );
  writeFileSync(
    join(work.dir, "scripts", "generate-capability-snapshot.mjs"),
    `import { spawnSync } from "node:child_process";\nconst r = spawnSync(process.execPath, ["--import", "tsx", ${JSON.stringify(CAPABILITY_CHECK)}, "--check"], { cwd: process.cwd(), stdio: "inherit" });\nprocess.exit(r.status ?? 1);\n`,
  );
  for (const file of readdirSync(join(REPO_ROOT, ".github", "workflows"))) {
    if (/\.ya?ml$/.test(file)) copyFileSync(join(REPO_ROOT, ".github", "workflows", file), join(work.dir, ".github", "workflows", file));
  }
  copyFileSync(join(REPO_ROOT, "MASTER-PLAN.md"), join(work.dir, "MASTER-PLAN.md"));
  copyFileSync(join(REPO_ROOT, "plan", "policy.yaml"), join(work.dir, "plan", "policy.yaml"));
  copyFileSync(join(REPO_ROOT, "plan", "plan-index.json"), join(work.dir, "plan", "plan-index.json"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(work.dir, "node_modules"));

  work.git("config", "core.hooksPath", "hooks");
  work.addRemote("origin", remote.dir);
  work.git("add", "-A");
  work.git("commit", "--quiet", "-m", "control-plane fixture base");
  work.git("update-ref", "refs/remotes/origin/main", "HEAD");

  const commit = (message: string) => {
    work.git("add", "-A");
    work.git("commit", "--quiet", "-m", message);
  };
  const push = () => {
    const result = spawnSync("git", ["push", "origin", "HEAD:refs/heads/main"], {
      cwd: work.dir,
      encoding: "utf8",
      env: { ...process.env, RMD_PREPUSH_GATES: "1" },
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { work, commit, push };
}

test("W1-T3423: a missing PR check registry entry refuses the real hook", (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.work.dir, ".github", "workflows", "forgotten-check.yml"),
    "on:\n  pull_request:\njobs:\n  forgotten-check:\n    name: forgotten-check\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
  );
  f.commit("add forgotten check");
  const result = f.push();
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /forgotten-check/);
  assert.match(result.stderr, /ci-gate\.yml/);
});

test("W1-T3423: an unpaired CI job refuses before push", (t) => {
  const f = fixture(t);
  const ciPath = join(f.work.dir, ".github", "workflows", "ci.yml");
  writeFileSync(ciPath, `${readFileSync(ciPath, "utf8")}\n  unpaired-ci-job:\n    name: unpaired-ci-job\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n`);
  const gatePath = join(f.work.dir, ".github", "workflows", "ci-gate.yml");
  writeFileSync(gatePath, readFileSync(gatePath, "utf8").replace('"dashboard",', '"unpaired-ci-job",\n        "dashboard",'));
  f.commit("add unpaired CI job");
  const result = f.push();
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /unpaired-ci-job.*no CI_PARITY_TABLE entry/);
  assert.match(result.stderr, /src\/lib\/ci-parity\.ts/);
});

test("W1-T3423: a stale capability snapshot refuses before push without rewriting it", (t) => {
  const f = fixture(t);
  const masterPlan = join(f.work.dir, "MASTER-PLAN.md");
  writeFileSync(masterPlan, readFileSync(masterPlan, "utf8").replace("Daemon dispatch lanes", "STALE Daemon dispatch lanes"));
  f.commit("make snapshot stale");
  const before = readFileSync(masterPlan, "utf8");
  const result = f.push();
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /capability snapshot is stale|CAPABILITY SNAPSHOT block is STALE/);
  assert.equal(readFileSync(masterPlan, "utf8"), before, "the hook must report the deterministic remedy, never rewrite generated output");
});

test("W1-T3423: an unrelated product push skips the static route without a test runner", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.work.dir, "src", "product.ts"), "export const productChange = true;\n");
  f.commit("unrelated product change");
  const result = f.push();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ci-control-plane-precheck: SKIP/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /^TAP version/m);
});
