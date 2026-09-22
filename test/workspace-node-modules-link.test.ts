import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deriveWorkspacePaths,
  linkWorkspaceNodeModules,
  workspaceNodeModulesIncomplete,
  worktreeAdd,
} from "../src/lib/worker.js";

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

// ── COVERAGE COMPLETENESS (W1-T4003 round 2) ──────────────────────────────────────────────────
// CI's `coverage-ratchet` shards `test/**/*.test.ts` across four independent jobs by DURATION,
// not by which source file a test touches, and each shard's own "Diff coverage" step blocks on
// its OWN partial lcov -- never the union of all four. This file's five sibling proof files
// (task acceptance criteria 1-4 plus the pre-existing root baseline) land in FOUR DIFFERENT
// shards, so a branch exercised only by one of them still reads as wholly uncovered added code
// in the other three. The tests below add no new PROOF of any acceptance criterion (each is
// already proven by its own dedicated file) -- they exist only so THIS file, wherever it lands,
// independently reaches every line this task added to src/lib/worker.ts.

test("deriveWorkspacePaths, real listDirs default, degrades an absent wildcard parent to no matches (coverage completeness)", () => {
  const root = tmp("wslink-cov-absentparent-");
  try {
    const repoDir = join(root, "source");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "fixture", workspaces: ["packages/*"] }));
    // No `packages/` directory at all -- the real (non-overridden) listDirs default must hit its
    // own ENOENT branch and degrade to no matches, not throw.
    assert.deepEqual(deriveWorkspacePaths(repoDir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linkWorkspaceNodeModules degrades to no workspaces when the source has no readable package.json (coverage completeness)", () => {
  const root = tmp("wslink-cov-nomanifest-");
  try {
    const repoDir = join(root, "source"); // deliberately no package.json written at all
    mkdirSync(repoDir, { recursive: true });
    const worktreePath = join(root, "worktree");
    mkdirSync(worktreePath, { recursive: true });
    assert.deepEqual(linkWorkspaceNodeModules(repoDir, worktreePath), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linkWorkspaceNodeModules covers a non-wildcard safe glob, an unsafe glob, an occupied destination, and a failed symlink together (coverage completeness)", () => {
  const root = tmp("wslink-cov-sweep-");
  try {
    const repoDir = join(root, "source");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "fixture", workspaces: ["../outside", "apps/dashboard", "packages/thing"] }),
    );
    const worktreePath = join(root, "worktree");

    // "apps/dashboard": a non-wildcard safe glob (the `else { safe.add(glob) }` branch, never
    // exercised by this file's wildcard-only tests above) whose worktree destination is OCCUPIED.
    mkdirSync(join(repoDir, "apps", "dashboard", "node_modules"), { recursive: true });
    mkdirSync(join(worktreePath, "apps", "dashboard", "node_modules"), { recursive: true });

    // "packages/thing": another non-wildcard safe glob whose destination is FREE, but the
    // injected `symlink` throws -- the named "failed" outcome, never a thrown exception.
    mkdirSync(join(repoDir, "packages", "thing", "node_modules"), { recursive: true });
    mkdirSync(join(worktreePath, "packages", "thing"), { recursive: true });

    const eperm = Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" });
    const results = linkWorkspaceNodeModules(repoDir, worktreePath, {
      symlink: () => {
        throw eperm;
      },
    });

    assert.deepEqual(
      results.sort((a, b) => a.workspace.localeCompare(b.workspace)),
      [
        { workspace: "../outside", outcome: "unsafe-path" },
        { workspace: "apps/dashboard", outcome: "occupied" },
        { workspace: "packages/thing", outcome: "failed" },
      ],
    );
    assert.equal(workspaceNodeModulesIncomplete(results), true);
    assert.equal(workspaceNodeModulesIncomplete([{ workspace: "apps/dashboard", outcome: "linked" }]), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A throwaway git clone with a workspace declared, matching what `seedClone` in
 *  test/workspace-node-modules-root-baseline.test.ts builds -- duplicated here (not imported)
 *  because this task's declared file scope has no shared test-support module, and this shard
 *  needs its OWN real `worktreeAdd` call to reach the wiring lines that gate the workspace
 *  ledger line on a non-empty result. */
function seedCloneWithWorkspace(clone: string): void {
  mkdirSync(clone, { recursive: true });
  execFileSync("git", ["-C", clone, "init", "--quiet", "--initial-branch", "main"]);
  execFileSync("git", ["-C", clone, "config", "user.email", "probe@example.invalid"]);
  execFileSync("git", ["-C", clone, "config", "user.name", "probe"]);
  writeFileSync(join(clone, "package.json"), JSON.stringify({ name: "fixture", workspaces: ["apps/*"] }));
  writeFileSync(join(clone, ".gitignore"), "node_modules\n");
  mkdirSync(join(clone, "apps", "dashboard"), { recursive: true });
  writeFileSync(join(clone, "apps", "dashboard", "package.json"), JSON.stringify({ name: "dashboard" }));
  execFileSync("git", ["-C", clone, "add", "-A"]);
  execFileSync("git", ["-C", clone, "commit", "--no-verify", "--quiet", "-m", "chore: seed"]);
  execFileSync("git", ["-C", clone, "remote", "add", "origin", clone]);
  execFileSync("git", ["-C", clone, "fetch", "origin", "--quiet"]);
  mkdirSync(join(clone, "apps", "dashboard", "node_modules", "marker-pkg"), { recursive: true });
  writeFileSync(join(clone, "apps", "dashboard", "node_modules", "marker-pkg", "index.js"), "module.exports = 1;\n");
}

test("worktreeAdd wires a non-empty workspace-link result through its own ledger line (coverage completeness)", () => {
  const root = tmp("wslink-cov-worktreeadd-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedCloneWithWorkspace(clone);
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];
    worktreeAdd(clone, wt, "run-wslink-cov-1", "main", { log: (step, extra) => logs.push([step, extra]) });

    const workspaceLog = logs.find(([step]) => step === "worktree.workspace_node_modules");
    assert.ok(workspaceLog, "a non-empty workspace-link result must reach the ledger");
    assert.deepEqual(workspaceLog?.[1]?.results, [{ workspace: "apps/dashboard", outcome: "linked" }]);
    assert.equal(workspaceLog?.[1]?.incomplete, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
