import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linkWorkspaceNodeModules, workspaceNodeModulesIncomplete } from "../src/lib/worker.js";

// W1-T4003 falsifier: "Seed an occupied destination and an unsafe ../outside workspace value:
// both must leave their paths untouched and report incomplete, proving the repair neither
// overwrites worker state nor escapes the checkout." These tests pin BOTH halves of that
// sentence together, plus the unreadable-destination case the design names alongside occupied
// ("an occupied or unreadable destination is never overwritten, never deleted").

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `rmd-${prefix}`));
}

function seedWorkspace(repoDir: string, workspace: string, worktreePath: string): void {
  mkdirSync(join(repoDir, workspace, "node_modules", "marker-pkg"), { recursive: true });
  writeFileSync(join(repoDir, workspace, "node_modules", "marker-pkg", "index.js"), "module.exports = 'source';\n");
  mkdirSync(join(worktreePath, workspace), { recursive: true });
}

test("an occupied workspace destination is left untouched and reported incomplete, never overwritten", () => {
  const root = tmp("wsoccupied-");
  try {
    const repoDir = join(root, "source");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ workspaces: ["apps/dashboard"] }));
    const worktreePath = join(root, "worktree");
    seedWorkspace(repoDir, "apps/dashboard", worktreePath);

    // Occupy the destination with WORKER-AUTHORED state that must survive byte-identically.
    const destDir = join(worktreePath, "apps", "dashboard", "node_modules");
    mkdirSync(join(destDir, "worker-owned"), { recursive: true });
    writeFileSync(join(destDir, "worker-owned", "do-not-touch.txt"), "worker state\n");

    const results = linkWorkspaceNodeModules(repoDir, worktreePath);

    assert.deepEqual(results, [{ workspace: "apps/dashboard", outcome: "occupied" }]);
    assert.equal(workspaceNodeModulesIncomplete(results), true);
    assert.equal(
      readFileSync(join(destDir, "worker-owned", "do-not-touch.txt"), "utf8"),
      "worker state\n",
      "an occupied destination must never be overwritten or deleted",
    );
    assert.equal(existsSync(join(destDir, "marker-pkg")), false, "the source's own contents must not appear either");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable (non-ENOENT) destination state is treated the same as occupied -- never linked over", () => {
  const root = tmp("wsoccupied-eacces-");
  try {
    const repoDir = join(root, "source");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ workspaces: ["apps/dashboard"] }));
    const worktreePath = join(root, "worktree");
    seedWorkspace(repoDir, "apps/dashboard", worktreePath);

    let symlinkCalled = false;
    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const results = linkWorkspaceNodeModules(repoDir, worktreePath, {
      lstat: () => {
        throw eacces;
      },
      symlink: () => {
        symlinkCalled = true;
      },
    });

    assert.deepEqual(results, [{ workspace: "apps/dashboard", outcome: "occupied" }]);
    assert.equal(workspaceNodeModulesIncomplete(results), true);
    assert.equal(symlinkCalled, false, "an unreadable destination must never be linked over -- its state is unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an ENOENT destination IS treated as free -- the boundary the EACCES case above is compared against", () => {
  const root = tmp("wsoccupied-enoent-");
  try {
    const repoDir = join(root, "source");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ workspaces: ["apps/dashboard"] }));
    const worktreePath = join(root, "worktree");
    seedWorkspace(repoDir, "apps/dashboard", worktreePath);

    const results = linkWorkspaceNodeModules(repoDir, worktreePath);
    assert.deepEqual(results, [{ workspace: "apps/dashboard", outcome: "linked" }]);
    assert.equal(workspaceNodeModulesIncomplete(results), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unsafe ../outside workspace value leaves its path untouched and reports incomplete, alongside an occupied one", () => {
  const root = tmp("wsoccupied-unsafe-");
  try {
    const repoDir = join(root, "source");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ workspaces: ["../outside", "apps/dashboard"] }),
    );
    const worktreePath = join(root, "worktree");
    seedWorkspace(repoDir, "apps/dashboard", worktreePath);

    // Occupy the SAFE workspace's destination too, so this test proves both incomplete shapes
    // report the same way, in the same call, exactly as the falsifier requires.
    mkdirSync(join(worktreePath, "apps", "dashboard", "node_modules"), { recursive: true });

    // A sibling directory the helper must never read or touch if the unsafe glob is truly refused
    // pre-filesystem, not merely caught after an attempted read.
    mkdirSync(join(root, "outside"), { recursive: true });
    writeFileSync(join(root, "outside", "sentinel.txt"), "must never be read\n");

    const results = linkWorkspaceNodeModules(repoDir, worktreePath);

    assert.deepEqual(
      results.sort((a, b) => a.workspace.localeCompare(b.workspace)),
      [
        { workspace: "../outside", outcome: "unsafe-path" },
        { workspace: "apps/dashboard", outcome: "occupied" },
      ],
    );
    assert.equal(workspaceNodeModulesIncomplete(results), true, "both shapes are named incomplete, never silently healthy");
    assert.equal(
      existsSync(join(worktreePath, "apps", "dashboard", "node_modules", "marker-pkg")),
      false,
      "the occupied destination's emptiness (no marker-pkg) proves it was never linked over",
    );
    assert.equal(
      readFileSync(join(root, "outside", "sentinel.txt"), "utf8"),
      "must never be read\n",
      "the sentinel is untouched -- it is read here only to prove it was never disturbed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
