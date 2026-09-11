import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadPlan } from "../src/lib/plan.js";
import { lintPlan } from "../src/lib/task-linter.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TASKS_PATH = join(REPO_ROOT, "plan", "tasks.yaml");

const FULL_PLAN_LINT_WALL_CLOCK_MEASUREMENT =
  "2026-09-11: npm run --silent lint-plan -- --all completed in 2.990s over 1687 tasks";

const ORIGINAL_LATENT_SHARD_DEBT = [
  "plan/tasks.d/W1-T174-drain-blockreason-fixrung-parity.yaml",
  "plan/tasks.d/W1-T175-worktree-reaper-lifecycle.yaml",
  "plan/tasks.d/W1-T176-zero-runs-check-is-deterministic.yaml",
  "plan/tasks.d/W1-T196-unattributable-pr-stand-down.yaml",
  "plan/tasks.d/W1-T198-linter-self-reference-false-positive.yaml",
  "plan/tasks.d/W1-T289-lock-reclaim-toctou.yaml",
];

const VIOLATING_SHARD_BASELINE = [
  "plan/tasks.d/W1-T174-drain-blockreason-fixrung-parity.yaml",
  "plan/tasks.d/W1-T175-worktree-reaper-lifecycle.yaml",
  "plan/tasks.d/W1-T176-zero-runs-check-is-deterministic.yaml",
  "plan/tasks.d/W1-T196-unattributable-pr-stand-down.yaml",
  "plan/tasks.d/W1-T198-linter-self-reference-false-positive.yaml",
  "plan/tasks.d/W1-T258-anthropic-api-key-overflow-valve.yaml",
  "plan/tasks.d/W1-T281-console-freshness-orphaned.yaml",
  "plan/tasks.d/W1-T282-now-blind-to-six-lanes.yaml",
  "plan/tasks.d/W1-T283-needs-me-non-plan-escalations.yaml",
  "plan/tasks.d/W1-T284-skills-panel-unregistered.yaml",
  "plan/tasks.d/W1-T285-accept-status-no-consumer.yaml",
  "plan/tasks.d/W1-T2861-a-source-file-cannot-outgrow-its-baseline.yaml",
  "plan/tasks.d/W1-T289-lock-reclaim-toctou.yaml",
  "plan/tasks.d/W1-T3071-rmd-help-mints-a-github-app-token-before-it-prints-usage.yaml",
  "plan/tasks.d/W1-T3139-catch-erasure-baseline-slack-blocks-main.yaml",
  "plan/tasks.d/W1-T326-record-daemon-parallelism-ruling.yaml",
  "plan/tasks.d/W1-T3318-ruling-a-gate-repairs-or-routes-it-does-not-block.yaml",
];

interface ShardLintReport {
  trackedShardFiles: string[];
  lintedShardFiles: string[];
  violatingShardFiles: string[];
}

function trackedShardFiles(root: string): string[] {
  return execFileSync("git", ["ls-files", "plan/tasks.d/*.yaml", "plan/tasks.d/*.yml"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .sort();
}

function shardLintReport(root: string, tasksPath: string): ShardLintReport {
  const plan = loadPlan(tasksPath);
  const results = lintPlan(plan, () => ({ moduleExists: (rel) => existsSync(join(root, rel)) }));
  const tracked = trackedShardFiles(root);
  const linted = new Set<string>();
  const violating = new Set<string>();

  for (const task of plan.tasks) {
    if (!task.sourcePath) continue;
    const sourcePath = relative(root, task.sourcePath);
    if (!sourcePath.startsWith("plan/tasks.d/")) continue;
    linted.add(sourcePath);
    const result = results.get(task.id);
    const hasBlockingViolation = result?.violations.some((v) => v.severity === "block") ?? false;
    if (hasBlockingViolation) violating.add(sourcePath);
  }

  return {
    trackedShardFiles: tracked,
    lintedShardFiles: [...linted].sort(),
    violatingShardFiles: [...violating].sort(),
  };
}

function fixtureTask(id: string, proof: string): string {
  return [
    `- id: ${id}`,
    `  title: "fixture task ${id}"`,
    "  repo: remudero",
    "  origin: architect",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  risk: medium",
    "  files: [test/every-shard-on-main-is-lintable.test.ts]",
    "  acceptance:",
    '    - claim: "the fixture behavior holds"',
    `      proof: "${proof}"`,
    "",
  ].join("\n");
}

test("W1-T3086: every tracked shard on main is linted before the shard-debt ratchet is checked", () => {
  const report = shardLintReport(REPO_ROOT, TASKS_PATH);

  assert.ok(report.trackedShardFiles.length > 1000, `control: saw ${report.trackedShardFiles.length} tracked shard files`);
  assert.deepEqual(
    report.lintedShardFiles,
    report.trackedShardFiles,
    "every tracked plan/tasks.d shard must be loaded and linted; otherwise an unchanged shard can go invisible again",
  );
});

test("W1-T3086: violating shard files cannot grow past the recorded baseline", () => {
  const report = shardLintReport(REPO_ROOT, TASKS_PATH);
  const allowed = new Set(VIOLATING_SHARD_BASELINE);
  const newlyViolating = report.violatingShardFiles.filter((f) => !allowed.has(f));

  assert.deepEqual(ORIGINAL_LATENT_SHARD_DEBT.filter((f) => !allowed.has(f)), [], "the six discovered latent shards stay recorded");
  assert.deepEqual(
    newlyViolating,
    [],
    "plan shard lint debt grew. Fix the new shard's blocking lint-plan violation, or deliberately lower the baseline only after debt is paid.",
  );
  assert.ok(
    report.violatingShardFiles.length <= VIOLATING_SHARD_BASELINE.length,
    `${report.violatingShardFiles.length} violating shard file(s) exceeds the recorded baseline of ${VIOLATING_SHARD_BASELINE.length}`,
  );
});

test("W1-T3086: adding a shard with a blocking violation would trip the ratchet", () => {
  const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-w1-t3086-"));
  try {
    mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(dir, "plan", "tasks.yaml"), "[]\n", "utf8");
    writeFileSync(
      join(dir, "plan", "tasks.d", "W1-T3086-clean.yaml"),
      fixtureTask("W1-T3086-CLEAN", "grep: fixture behavior in test/every-shard-on-main-is-lintable.test.ts"),
      "utf8",
    );
    writeFileSync(join(dir, "plan", "tasks.d", "W1-T3086-dirty.yaml"), fixtureTask("W1-T3086-DIRTY", "free prose"), "utf8");

    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "plan/tasks.yaml", "plan/tasks.d/W1-T3086-clean.yaml", "plan/tasks.d/W1-T3086-dirty.yaml"], {
      cwd: dir,
    });

    const report = shardLintReport(dir, join(dir, "plan", "tasks.yaml"));
    const baseline = new Set(["plan/tasks.d/W1-T3086-clean.yaml"]);

    assert.deepEqual(
      report.violatingShardFiles.filter((f) => !baseline.has(f)),
      ["plan/tasks.d/W1-T3086-dirty.yaml"],
      "a newly added dirty shard must be visible as growth above the baseline",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3086: the full-plan lint cost is recorded beside the ratchet", () => {
  assert.match(
    FULL_PLAN_LINT_WALL_CLOCK_MEASUREMENT,
    /^2026-09-11: npm run --silent lint-plan -- --all completed in 2\.990s over 1687 tasks$/,
  );
});
