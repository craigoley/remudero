import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { worktreesDir } from "../src/lib/worker.js";
import type { Config } from "../src/lib/config.js";

type RealNodeModulesFinding = {
  worktreePath: string;
  nodeModulesPath: string;
};

type WorktreeNodeModulesReport =
  | { skipped: true; worktreeRoot: string; reason: "no-live-worktrees" }
  | { skipped: false; worktreeRoot: string; realNodeModules: RealNodeModulesFinding[] };

/**
 * The detector deliberately lives beside the regression lock until the cause of the fleet state
 * is separated. It observes only the configured worker-worktree root: it never assumes the fleet's
 * absolute path, follows a node_modules link, or repairs/deletes anything it finds.
 */
function detectRealNodeModules(config: Pick<Config, "root">): WorktreeNodeModulesReport {
  const worktreeRoot = worktreesDir(config as Config);
  let entries;
  try {
    entries = readdirSync(worktreeRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { skipped: true, worktreeRoot, reason: "no-live-worktrees" };
    }
    throw error;
  }

  const realNodeModules: RealNodeModulesFinding[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const worktreePath = join(worktreeRoot, entry.name);
    const nodeModulesPath = join(worktreePath, "node_modules");
    try {
      const nodeModules = lstatSync(nodeModulesPath);
      if (nodeModules.isDirectory() && !nodeModules.isSymbolicLink()) {
        realNodeModules.push({ worktreePath, nodeModulesPath });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  return { skipped: false, worktreeRoot, realNodeModules };
}

function temporaryRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("a fleet worktree with a real node_modules is named while a symlink is ignored", () => {
  const root = temporaryRoot("rmd-real-node-modules-");
  try {
    const config = { root } satisfies Pick<Config, "root">;
    const configuredWorktreeRoot = worktreesDir(config as Config);
    const canonicalNodeModules = join(root, "canonical-install", "node_modules");
    const linkedWorktree = join(configuredWorktreeRoot, "reviewer-linked");
    const realWorktree = join(configuredWorktreeRoot, "sweep-real");
    mkdirSync(canonicalNodeModules, { recursive: true });
    mkdirSync(linkedWorktree, { recursive: true });
    mkdirSync(realWorktree, { recursive: true });
    symlinkSync(canonicalNodeModules, join(linkedWorktree, "node_modules"), "dir");
    mkdirSync(join(realWorktree, "node_modules"), { recursive: true });

    const report = detectRealNodeModules(config);

    assert.equal(report.skipped, false);
    assert.equal(report.worktreeRoot, configuredWorktreeRoot, "the report names the configured root");
    assert.deepEqual(report.realNodeModules, [
      {
        worktreePath: realWorktree,
        nodeModulesPath: join(realWorktree, "node_modules"),
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a configured root with no live worktrees skips instead of failing or inventing a finding", () => {
  const root = temporaryRoot("rmd-no-live-worktrees-");
  try {
    const config = { root } satisfies Pick<Config, "root">;
    const report = detectRealNodeModules(config);

    assert.deepEqual(report, {
      skipped: true,
      worktreeRoot: worktreesDir(config as Config),
      reason: "no-live-worktrees",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
