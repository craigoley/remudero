/**
 * The pre-push path needs the deterministic part of `lint-plan --base` without paying for, or
 * depending on, GitHub. These tests pin the boundary: local blocking rules still refuse, while
 * the one GitHub-backed blocking rule and GitHub-backed advisories are named as omissions.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { lintPlanCommand } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_IDENTITY = { name: "remudero offline lint fixture", email: "fixture@remudero.invalid" };

function git(args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

function baseCommitWithBlob(relPath: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-offline-lint-base-"));
  try {
    const indexFile = join(dir, "index");
    const env = { GIT_INDEX_FILE: indexFile };
    git(["read-tree", "HEAD"], env);
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      input: content,
    }).trim();
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},${relPath}`], env);
    const tree = git(["write-tree"], env);
    return git(["commit-tree", tree, "-p", "HEAD", "-m", "planted: offline lint base"], {
      GIT_AUTHOR_NAME: FIXTURE_IDENTITY.name,
      GIT_AUTHOR_EMAIL: FIXTURE_IDENTITY.email,
      GIT_COMMITTER_NAME: FIXTURE_IDENTITY.name,
      GIT_COMMITTER_EMAIL: FIXTURE_IDENTITY.email,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function taskYaml(proofs: readonly string[]): string {
  return [
    "- id: ZZ-Offline-Lint",
    '  title: "offline lint fixture"',
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  verify: human",
    "  risk: low",
    "  status: queued",
    '  origin: "offline lint test fixture"',
    "  files: [test/example.test.ts]",
    "  acceptance:",
    ...proofs.flatMap((proof, i) => [
      `    - claim: "fixture claim ${i + 1}"`,
      `      proof: "${proof}"`,
    ]),
    "",
  ].join("\n");
}

function fixturePlan(): { dir: string; planPath: string; relPath: string } {
  const dir = mkdtempSync(join(REPO_ROOT, ".rmd-offline-lint-fixture-"));
  const planPath = join(dir, "tasks.yaml");
  return { dir, planPath, relPath: relative(REPO_ROOT, planPath) };
}

async function capturedLint(
  args: string[],
  deps: Parameters<typeof lintPlanCommand>[1],
): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const [oldLog, oldError, oldWarn] = [console.log, console.error, console.warn];
  console.log = (...values: unknown[]) => void lines.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) => void lines.push(values.map(String).join(" "));
  console.warn = (...values: unknown[]) => void lines.push(values.map(String).join(" "));
  try {
    return { code: await lintPlanCommand(args, deps), output: lines.join("\n") };
  } finally {
    console.log = oldLog;
    console.error = oldError;
    console.warn = oldWarn;
  }
}

test("offline plan lint keeps local blocking rules and names every GitHub-backed omission", async () => {
  const { dir, planPath, relPath } = fixturePlan();
  try {
    const clean = taskYaml(["unit test: test/example.test.ts"]);
    const base = baseCommitWithBlob(relPath, clean);
    writeFileSync(planPath, taskYaml(["works"]), "utf8");
    let externalCalls = 0;
    const forbidden = () => {
      externalCalls += 1;
      throw new Error("offline lint attempted a GitHub-backed dependency");
    };

    const result = await capturedLint(["--plan", planPath, "--base", base], {
      offline: true,
      loadConfig: forbidden as never,
      resolveOwnerRepo: forbidden as never,
      ghGateway: forbidden as never,
      projectPlan: forbidden as never,
      openPlanShardSlugs: forbidden as never,
    });

    assert.equal(result.code, 1, "the local proof-shape and proof-dialect blocks must still refuse");
    assert.match(result.output, /\[proof-shape\]/);
    assert.match(result.output, /\[proof-dialect\]/);
    assert.match(result.output, /offline subset/i);
    assert.match(result.output, /post-merge-amendment.*block/i);
    assert.match(result.output, /duplicate-title.*warn/i);
    assert.match(result.output, /duplicate-surface.*may over-report/i);
    assert.equal(externalCalls, 0, "no GitHub-backed dependency may be consulted in offline mode");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the offline runner omits the merged-task amendment block instead of manufacturing a verdict", async () => {
  const { dir, planPath, relPath } = fixturePlan();
  try {
    const oneCriterion = taskYaml(["unit test: test/example.test.ts"]);
    const base = baseCommitWithBlob(relPath, oneCriterion);
    writeFileSync(
      planPath,
      taskYaml(["unit test: test/example.test.ts", "unit test: test/example.test.ts"]),
      "utf8",
    );
    const args = ["--plan", planPath, "--base", base];
    const online = await capturedLint(args, {
      loadConfig: (() => ({ root: "/synthetic" })) as never,
      resolveOwnerRepo: (() => ({ owner: "o", repo: "r" })) as never,
      ghGateway: (() => ({})) as never,
      projectPlan: (() => new Map([["ZZ-Offline-Lint", { merged: true, indeterminate: false }]])) as never,
      openPlanShardSlugs: (() => []) as never,
    });
    const offline = await capturedLint(args, {
      offline: true,
      loadConfig: (() => {
        throw new Error("must stay offline");
      }) as never,
    });

    assert.equal(online.code, 1);
    assert.match(online.output, /\[post-merge-amendment\]/);
    assert.equal(offline.code, 0, "unknown merge state must skip the check, never infer not-merged");
    assert.doesNotMatch(offline.output, /\[post-merge-amendment\]/);
    assert.match(offline.output, /post-merge-amendment.*omitted/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the standalone offline runner never reaches a gh executable", () => {
  const { dir, planPath, relPath } = fixturePlan();
  const shim = ghShim([{ when: "", exit: 99 }], { kind: "offline-lint-no-gh" });
  try {
    const base = baseCommitWithBlob(relPath, taskYaml(["unit test: test/example.test.ts"]));
    writeFileSync(planPath, taskYaml(["unit test: test/example.test.ts", "unit test: test/example.test.ts"]), "utf8");

    const child = spawnSync(
      "npm",
      ["run", "--silent", "lint-plan:offline", "--", "--plan", planPath, "--base", base],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, PATH: `${shim.dir}:${process.env.PATH ?? ""}` },
      },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(shim.calls(), [], "the fake gh executable must remain untouched");
    assert.match(child.stdout, /offline subset/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});
