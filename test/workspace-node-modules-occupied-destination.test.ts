import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deriveWorkspacePaths,
  linkWorkspaceNodeModules,
  workspaceNodeModulesIncomplete,
  worktreeAdd,
} from "../src/lib/worker.js";

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

test("a symlink attempt that throws reports the named 'failed' outcome instead of throwing out of the helper", () => {
  const root = tmp("wsoccupied-symlinkfail-");
  try {
    const repoDir = join(root, "source");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ workspaces: ["apps/dashboard"] }));
    const worktreePath = join(root, "worktree");
    seedWorkspace(repoDir, "apps/dashboard", worktreePath);

    const eperm = Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" });
    const results = linkWorkspaceNodeModules(repoDir, worktreePath, {
      symlink: () => {
        throw eperm;
      },
    });

    assert.deepEqual(results, [{ workspace: "apps/dashboard", outcome: "failed" }]);
    assert.equal(workspaceNodeModulesIncomplete(results), true);
    assert.equal(
      existsSync(join(worktreePath, "apps", "dashboard", "node_modules")),
      false,
      "a failed symlink attempt must leave no partial destination behind",
    );
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

// ── COVERAGE COMPLETENESS (W1-T4003 round 2) ──────────────────────────────────────────────────
// CI's `coverage-ratchet` shards `test/**/*.test.ts` across four independent jobs by DURATION,
// not by which source file a test touches, and each shard's own "Diff coverage" step blocks on
// its OWN partial lcov -- never the union of all four. This file's four sibling proof files
// land in different shards, so a branch exercised only by a sibling still reads as wholly
// uncovered added code in the shard this file lands in. The tests below add no new PROOF of any
// acceptance criterion -- they exist only so THIS file, wherever it lands, independently reaches
// every line this task added to src/lib/worker.ts. (This file's own tests above never exercise
// a wildcard workspace glob, so the wildcard-expansion path is entirely new coverage here.)

test("deriveWorkspacePaths expands a present wildcard parent and degrades an absent one to no matches, using the real listDirs default (coverage completeness)", () => {
  const root = tmp("wsoccupied-cov-wild-");
  try {
    const repoDir = join(root, "source");
    mkdirSync(join(repoDir, "packages", "one"), { recursive: true });
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "fixture", workspaces: ["packages/*"] }));
    assert.deepEqual(deriveWorkspacePaths(repoDir), ["packages/one"]);

    // A sibling repo with the SAME wildcard glob but no matching parent directory at all --
    // real readdirSync's own ENOENT branch must degrade to no matches, not throw.
    const emptyRepoDir = join(root, "empty-source");
    mkdirSync(emptyRepoDir, { recursive: true });
    writeFileSync(join(emptyRepoDir, "package.json"), JSON.stringify({ name: "fixture", workspaces: ["packages/*"] }));
    assert.deepEqual(deriveWorkspacePaths(emptyRepoDir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linkWorkspaceNodeModules degrades to no workspaces when the source has no readable package.json (coverage completeness)", () => {
  const root = tmp("wsoccupied-cov-nomanifest-");
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

test("linkWorkspaceNodeModules reports a named 'no-source' skip for a workspace with no nested node_modules (coverage completeness)", () => {
  const root = tmp("wsoccupied-cov-nosource-");
  try {
    const repoDir = join(root, "source");
    mkdirSync(join(repoDir, "apps", "dashboard"), { recursive: true }); // no node_modules beneath it
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ workspaces: ["apps/dashboard"] }));
    const worktreePath = join(root, "worktree");
    mkdirSync(join(worktreePath, "apps", "dashboard"), { recursive: true });

    const results = linkWorkspaceNodeModules(repoDir, worktreePath);
    assert.deepEqual(results, [{ workspace: "apps/dashboard", outcome: "no-source" }]);
    assert.equal(workspaceNodeModulesIncomplete(results), false, "a no-source skip is a normal, complete outcome");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function seedWorkspaceInstall(clone: string): void {
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
  const root = tmp("wsoccupied-cov-worktreeadd-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedWorkspaceInstall(clone);
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];
    worktreeAdd(clone, wt, "run-wsoccupied-cov-1", "main", { log: (step, extra) => logs.push([step, extra]) });

    const workspaceLog = logs.find(([step]) => step === "worktree.workspace_node_modules");
    assert.ok(workspaceLog, "a non-empty workspace-link result must reach the ledger");
    assert.deepEqual(workspaceLog?.[1]?.results, [{ workspace: "apps/dashboard", outcome: "linked" }]);
    assert.equal(workspaceLog?.[1]?.incomplete, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
