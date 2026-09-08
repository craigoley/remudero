import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { PreflightSpawn } from "../src/lib/commit-message.js";
import { rule15MixedPlanSourceDiffStep } from "../src/lib/ci-parity.js";
import { rule15MixedPlanSourceDiffViolation } from "../src/lib/task-linter.js";
import { preflightCommand } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_TASK_TS = join(REPO_ROOT, "src", "run-task.ts");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");

const PLAN_HUNK = [
  "diff --git a/plan/tasks.d/W1-T1-x.yaml b/plan/tasks.d/W1-T1-x.yaml",
  "--- a/plan/tasks.d/W1-T1-x.yaml",
  "+++ b/plan/tasks.d/W1-T1-x.yaml",
  "@@ -1,2 +1,4 @@",
  " - id: W1-T1",
  "   acceptance:",
  '+    - claim: "a thing this task must do"',
  '+      proof: "unit test: test/x.test.ts"',
].join("\n");

const SRC_HUNK = [
  "diff --git a/src/lib/x.ts b/src/lib/x.ts",
  "--- a/src/lib/x.ts",
  "+++ b/src/lib/x.ts",
  "@@ -0,0 +1 @@",
  "+export const x = 1;",
].join("\n");

const MIXED_DIFF = `${PLAN_HUNK}\n${SRC_HUNK}\n`;
const PLAN_ONLY_DIFF = `${PLAN_HUNK}\n`;
const MIXED_FILES = ["plan/tasks.d/W1-T1-x.yaml", "src/lib/x.ts"];
const PLAN_ONLY_FILES = ["plan/tasks.d/W1-T1-x.yaml"];

function preflightSpawn(diff: string, files: readonly string[]): PreflightSpawn {
  return (file, args) => {
    if (file === "git" && args[0] === "diff" && args[1] === "--name-only") {
      return { status: 0, stdout: `${files.join("\n")}\n`, stderr: "" };
    }
    if (file === "git" && args[0] === "diff") return { status: 0, stdout: diff, stderr: "" };
    if (args.includes("rev-list")) return { status: 0, stdout: "0\n", stderr: "" };
    if (args.includes("reflog")) return { status: 0, stdout: "", stderr: "" };
    return { status: 0, stdout: "\0feat(x): fine\n", stderr: "" };
  };
}

test("rmd preflight refuses a criteria edit beside src, naming the split", async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  let code: number;
  try {
    code = await preflightCommand([], { spawn: preflightSpawn(MIXED_DIFF, MIXED_FILES) });
  } finally {
    console.log = originalLog;
  }
  assert.equal(code, 1, "a mixed criteria/source diff must block the push");
  const rule15 = lines.find((l) => l.startsWith("rule15-mixed-diff: FAIL"));
  assert.ok(rule15, `expected a named Rule 15 preflight failure in ${JSON.stringify(lines)}`);
  assert.match(rule15, /plan\/tasks\.d\/W1-T1-x\.yaml/, "the shard is named");
  assert.match(rule15, /src\/lib\/x\.ts/, "the entangled source file is named");
  assert.match(rule15, /file the shard in its own plan-only PR/, "the judge's remedy is printed");
});

test("rmd preflight passes the same criteria edit when the diff is plan-only", () => {
  const step = rule15MixedPlanSourceDiffStep("/repo", preflightSpawn(PLAN_ONLY_DIFF, PLAN_ONLY_FILES));
  assert.equal(step.ok, true);
  assert.match(step.detail, /PASS/);
});

test("lint-plan --base refuses the identical mixed diff through the same predicate", () => {
  const { root, base } = fixtureRepo({
    "plan/tasks.d/W1-T1-x.yaml":
      taskYaml("  acceptance:\n    - claim: x\n      proof: \"unit test: test/x.test.ts\"\n"),
    "src/lib/x.ts": "export const x = 1;\n",
  });
  try {
    const r = spawnSync(process.execPath, [TSX, RUN_TASK_TS, "lint-plan", "--base", base], {
      cwd: root,
      encoding: "utf8",
      env: GIT_ENV,
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    assert.equal(r.status, 1, out);
    assert.match(out, /\[rule15-mixed-diff\]/);
    assert.match(out, /plan\/tasks\.d\/W1-T1-x\.yaml/);
    assert.match(out, /src\/lib\/x\.ts/);
    assert.match(out, /file the shard in its own plan-only PR/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the mixed-diff check is load-bearing on the reviewer predicate, not path shape", () => {
  const live = rule15MixedPlanSourceDiffViolation(MIXED_DIFF, MIXED_FILES);
  assert.ok(live, "the real reviewer predicate trips on the fixture");

  const stubbed = rule15MixedPlanSourceDiffViolation(MIXED_DIFF, MIXED_FILES, {
    criterionFieldTampered: () => false,
  });
  assert.equal(stubbed, undefined, "with the shared predicate blind, the path mixture alone passes");
});

const GIT_ENV = {
  ...process.env,
  RMD_SELF_SYNC_DONE: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function fixtureRepo(head: Record<string, string>): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}rule15-mixed-`));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: GIT_ENV });
  git("init", "--quiet", "-b", "main");
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(root, "plan", "tasks.d", "W1-T1-x.yaml"), taskYaml("  acceptance:\n"));
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD").trim();
  for (const [rel, body] of Object.entries(head)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  git("add", "-A");
  git("commit", "--quiet", "-m", "head");
  return { root, base };
}

function taskYaml(tail: string): string {
  return (
    "- id: W1-T1\n" +
    "  title: x\n" +
    "  repo: remudero\n" +
    "  depends_on: []\n" +
    "  type: implement\n" +
    "  verify: auto\n" +
    "  status: queued\n" +
    "  files: [src/lib/x.ts]\n" +
    "  origin: fixture\n" +
    tail
  );
}
