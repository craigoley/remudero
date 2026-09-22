import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveWorkspacePaths, linkWorkspaceNodeModules } from "../src/lib/worker.js";

// W1-T4003: `linkWorktreeNodeModules` (src/lib/worker.ts) links ONLY the root `node_modules`.
// This fleet's real npm layout can leave a workspace's own dependency nested under ITS OWN
// directory instead (MEASURED: `@vitejs/plugin-react` lives only under
// apps/dashboard/node_modules, not hoisted to root) -- so a fresh worker worktree resolves its
// root CLI but not that plugin, and can fail before its diff is even evaluated. These tests
// pin `linkWorkspaceNodeModules`: it reads the source checkout's OWN `package.json#workspaces`
// manifest, links each declared workspace's nested install by SYMLINK, and never runs npm.

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `rmd-${prefix}`));
}

/** A minimal source checkout: just `package.json` declaring `workspaces`. Each workspace's own
 *  directory (and whether it gets a nested `node_modules`) is seeded separately below, since
 *  which combinations matter differs per test. */
function seedSourceRepo(root: string, workspaces: string[]): string {
  const repoDir = join(root, "source");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "fixture", workspaces }));
  return repoDir;
}

function seedWorkspaceDir(repoDir: string, workspace: string, withNodeModules: boolean): void {
  const dir = join(repoDir, workspace);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: workspace }));
  if (withNodeModules) {
    const nm = join(dir, "node_modules", "marker-pkg");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "index.js"), "module.exports = 'marker';\n");
  }
}

test("linkWorkspaceNodeModules links a declared workspace's nested install by symlink, no npm involved", () => {
  const root = tmp("wslink-");
  try {
    const repoDir = seedSourceRepo(root, ["apps/*"]);
    seedWorkspaceDir(repoDir, "apps/dashboard", true);
    const worktreePath = join(root, "worktree");
    // A fresh worktree gets git-tracked content (package.json here) but NOT the gitignored
    // node_modules -- mirror that shape without a real `git worktree add`.
    mkdirSync(join(worktreePath, "apps", "dashboard"), { recursive: true });
    writeFileSync(join(worktreePath, "apps", "dashboard", "package.json"), JSON.stringify({ name: "dashboard" }));

    // FALSIFIER, before half: resolving the marker package from the worktree's dashboard fails.
    assert.equal(existsSync(join(worktreePath, "apps", "dashboard", "node_modules", "marker-pkg")), false);

    const results = linkWorkspaceNodeModules(repoDir, worktreePath);

    assert.deepEqual(results, [{ workspace: "apps/dashboard", outcome: "linked" }]);
    const dest = join(worktreePath, "apps", "dashboard", "node_modules");
    assert.equal(readlinkSync(dest), join(repoDir, "apps", "dashboard", "node_modules"));
    // FALSIFIER, after half: resolution now reaches the source nested install.
    assert.equal(existsSync(join(dest, "marker-pkg", "index.js")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linkWorkspaceNodeModules falsifier: deleting the helper's effect makes resolution fail again", () => {
  const root = tmp("wslink-falsify-");
  try {
    const repoDir = seedSourceRepo(root, ["apps/*"]);
    seedWorkspaceDir(repoDir, "apps/dashboard", true);
    const worktreePath = join(root, "worktree");
    mkdirSync(join(worktreePath, "apps", "dashboard"), { recursive: true });

    linkWorkspaceNodeModules(repoDir, worktreePath);
    assert.equal(existsSync(join(worktreePath, "apps", "dashboard", "node_modules", "marker-pkg")), true);

    // Undo exactly what the helper did -- without it, the fixture must fail again.
    rmSync(join(worktreePath, "apps", "dashboard", "node_modules"), { recursive: true, force: true });
    assert.equal(existsSync(join(worktreePath, "apps", "dashboard", "node_modules", "marker-pkg")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linkWorkspaceNodeModules expands a wildcard workspace glob using the source manifest, not a hard-coded list", () => {
  const root = tmp("wslink-wild-");
  try {
    const repoDir = seedSourceRepo(root, ["packages/*"]);
    seedWorkspaceDir(repoDir, "packages/api-client", false);
    seedWorkspaceDir(repoDir, "packages/daemon-client-smoke", true);
    const worktreePath = join(root, "worktree");
    mkdirSync(join(worktreePath, "packages", "api-client"), { recursive: true });
    mkdirSync(join(worktreePath, "packages", "daemon-client-smoke"), { recursive: true });

    assert.deepEqual(deriveWorkspacePaths(repoDir), ["packages/api-client", "packages/daemon-client-smoke"]);

    const results = linkWorkspaceNodeModules(repoDir, worktreePath);
    assert.deepEqual(
      results.sort((a, b) => a.workspace.localeCompare(b.workspace)),
      [
        { workspace: "packages/api-client", outcome: "no-source" },
        { workspace: "packages/daemon-client-smoke", outcome: "linked" },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linkWorkspaceNodeModules skips a workspace absent from the worktree (declared in source only)", () => {
  const root = tmp("wslink-absent-");
  try {
    const repoDir = seedSourceRepo(root, ["apps/*"]);
    seedWorkspaceDir(repoDir, "apps/dashboard", true);
    const worktreePath = join(root, "worktree");
    mkdirSync(worktreePath, { recursive: true }); // no apps/dashboard at all in the worktree

    const results = linkWorkspaceNodeModules(repoDir, worktreePath);
    assert.deepEqual(results, [], "a workspace missing from the worktree produces no outcome, not a false claim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linkWorkspaceNodeModules reports no workspaces at all for a repo with no package.json#workspaces", () => {
  const root = tmp("wslink-none-");
  try {
    const repoDir = join(root, "source");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "no-workspaces" }));
    const worktreePath = join(root, "worktree");
    mkdirSync(worktreePath, { recursive: true });
    assert.deepEqual(linkWorkspaceNodeModules(repoDir, worktreePath), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
