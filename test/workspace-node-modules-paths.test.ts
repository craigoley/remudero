import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deriveWorkspacePaths,
  isSafeWorkspaceGlob,
  linkWorkspaceNodeModules,
  workspaceNodeModulesIncomplete,
  worktreeAdd,
} from "../src/lib/worker.js";

// W1-T4003: `package.json#workspaces` is untrusted content read off disk, not a value this
// process authored. `isSafeWorkspaceGlob` is the boundary the design calls out by name: only a
// normalized relative path, or that same shape with ONE trailing wildcard segment, is ever
// turned into a filesystem read. These tests pin the refusal itself -- an unsafe entry never
// reaches a `readdir`, a `lstat`, or a `symlink` call, proving the repair cannot be tricked into
// escaping the checkout.

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `rmd-${prefix}`));
}

test("isSafeWorkspaceGlob accepts a normalized relative path and a one-segment trailing wildcard", () => {
  assert.equal(isSafeWorkspaceGlob("apps/dashboard"), true);
  assert.equal(isSafeWorkspaceGlob("packages/api-client"), true);
  assert.equal(isSafeWorkspaceGlob("apps/*"), true);
  assert.equal(isSafeWorkspaceGlob("a"), true);
});

test("isSafeWorkspaceGlob refuses parent traversal anywhere in the path", () => {
  assert.equal(isSafeWorkspaceGlob("../outside"), false);
  assert.equal(isSafeWorkspaceGlob("apps/../../../outside"), false);
  assert.equal(isSafeWorkspaceGlob("apps/../dashboard"), false);
});

test("isSafeWorkspaceGlob refuses an absolute path", () => {
  assert.equal(isSafeWorkspaceGlob("/etc/passwd"), false);
  assert.equal(isSafeWorkspaceGlob("~/secrets"), false);
});

test("isSafeWorkspaceGlob refuses a recursive glob and a non-trailing or partial wildcard", () => {
  assert.equal(isSafeWorkspaceGlob("apps/**"), false);
  assert.equal(isSafeWorkspaceGlob("apps/**/*"), false);
  assert.equal(isSafeWorkspaceGlob("apps/*/nested"), false);
  assert.equal(isSafeWorkspaceGlob("apps/dash*"), false, "a partial wildcard segment is refused, not just a bare one");
  assert.equal(isSafeWorkspaceGlob("*/dashboard"), false, "the wildcard must be the LAST segment");
});

test("isSafeWorkspaceGlob refuses malformed/empty forms", () => {
  assert.equal(isSafeWorkspaceGlob(""), false);
  assert.equal(isSafeWorkspaceGlob("apps//dashboard"), false);
  assert.equal(isSafeWorkspaceGlob("apps/"), false);
  assert.equal(isSafeWorkspaceGlob("./apps"), false);
});

test("deriveWorkspacePaths derives paths from the source manifest, refusing unsafe entries before any expansion read", () => {
  const root = tmp("wspaths-manifest-");
  try {
    const repoDir = join(root, "source");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({
        name: "fixture",
        workspaces: ["apps/dashboard", "../outside", "/etc/passwd", "apps/**", "packages/*"],
      }),
    );
    mkdirSync(join(repoDir, "apps", "dashboard"), { recursive: true });
    mkdirSync(join(repoDir, "packages", "api-client"), { recursive: true });

    const listDirsCalls: string[] = [];
    const paths = deriveWorkspacePaths(repoDir, {
      listDirs: (p) => {
        listDirsCalls.push(p);
        // Delegate to a real, bounded read only for the ONE safe wildcard parent this manifest
        // declares -- proves the unsafe entries above never reach this function at all.
        return p === join(repoDir, "packages") ? ["api-client"] : [];
      },
    });

    assert.deepEqual(paths, ["apps/dashboard", "packages/api-client"]);
    assert.deepEqual(listDirsCalls, [join(repoDir, "packages")], "only the safe wildcard's own parent is ever listed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deriveWorkspacePaths never reads outside the checkout for an unsafe ../outside entry", () => {
  const root = tmp("wspaths-outside-");
  try {
    const repoDir = join(root, "source");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "fixture", workspaces: ["../outside/*"] }),
    );
    // A sibling directory that WOULD be reachable if the wildcard were ever expanded -- its
    // presence makes this a real falsifier: if the helper regressed to expanding unsafe globs,
    // this assertion would catch it by finding entries from here.
    mkdirSync(join(root, "outside", "leaked"), { recursive: true });

    const listDirsCalls: string[] = [];
    const paths = deriveWorkspacePaths(repoDir, { listDirs: (p) => (listDirsCalls.push(p), []) });

    assert.deepEqual(paths, []);
    assert.deepEqual(listDirsCalls, [], "an unsafe glob must cause ZERO directory reads, not just an empty result");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deriveWorkspacePaths, with no listDirs override, uses the real filesystem default and degrades an absent wildcard parent to no matches rather than throwing", () => {
  const root = tmp("wspaths-realdefault-");
  try {
    const repoDir = join(root, "source");
    // Deliberately no `packages/` directory at all -- the safe glob's own parent is absent, so the
    // real `readdirSync` default this function falls back to (no `listDirs` override passed) must
    // hit its own ENOENT branch and degrade to "no matches", not throw and abort the whole read.
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "fixture", workspaces: ["packages/*"] }));

    assert.deepEqual(deriveWorkspacePaths(repoDir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deriveWorkspacePaths degrades to no workspaces when the manifest cannot be read or does not parse as JSON, rather than throwing", () => {
  const root = tmp("wspaths-badmanifest-");
  try {
    const repoDir = join(root, "source");
    mkdirSync(repoDir, { recursive: true });
    // No package.json written at all -- the real default `readManifest` (readFileSync) throws
    // ENOENT, which readRawWorkspaceGlobs must catch and degrade from, not propagate.
    assert.deepEqual(deriveWorkspacePaths(repoDir), []);

    // An unreadable-manifest override (any thrown error, not just ENOENT) hits the identical catch.
    assert.deepEqual(
      deriveWorkspacePaths(repoDir, {
        readManifest: () => {
          throw new Error("EACCES: permission denied");
        },
      }),
      [],
    );

    // A manifest that exists and reads but is not valid JSON hits the SAME catch from the other
    // side -- JSON.parse throwing rather than readManifest itself.
    assert.deepEqual(
      deriveWorkspacePaths(repoDir, { readManifest: () => "{ not valid json" }),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linkWorkspaceNodeModules reports an unsafe glob as a named unsafe-path outcome and never touches disk for it", () => {
  const root = tmp("wspaths-linkunsafe-");
  try {
    const repoDir = join(root, "source");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "fixture", workspaces: ["../outside", "apps/dashboard"] }),
    );
    mkdirSync(join(repoDir, "apps", "dashboard", "node_modules"), { recursive: true });
    const worktreePath = join(root, "worktree");
    mkdirSync(join(worktreePath, "apps", "dashboard"), { recursive: true });

    const existsCalls: string[] = [];
    const results = linkWorkspaceNodeModules(repoDir, worktreePath, {
      exists: (p) => {
        existsCalls.push(p);
        return p.includes(join("apps", "dashboard"));
      },
    });

    assert.deepEqual(
      results.sort((a, b) => a.workspace.localeCompare(b.workspace)),
      [
        { workspace: "../outside", outcome: "unsafe-path" },
        { workspace: "apps/dashboard", outcome: "linked" },
      ],
    );
    assert.equal(
      existsCalls.some((p) => p.includes("outside")),
      false,
      "the refused glob must never reach an fs.exists probe, let alone one outside the checkout",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── COVERAGE COMPLETENESS (W1-T4003 round 2) ──────────────────────────────────────────────────
// CI's `coverage-ratchet` shards `test/**/*.test.ts` across four independent jobs by DURATION,
// not by which source file a test touches, and each shard's own "Diff coverage" step blocks on
// its OWN partial lcov -- never the union of all four. This file's four sibling proof files land
// in different shards, so a branch exercised only by a sibling still reads as wholly uncovered
// added code in the shard this file lands in. The tests below add no new PROOF of any acceptance
// criterion -- they exist only so THIS file, wherever it lands, independently reaches every line
// this task added to src/lib/worker.ts.

test("linkWorkspaceNodeModules reports a named 'no-source' skip for a workspace with no nested node_modules (coverage completeness)", () => {
  const root = tmp("wspaths-cov-nosource-");
  try {
    const repoDir = join(root, "source");
    mkdirSync(join(repoDir, "apps", "dashboard"), { recursive: true }); // no node_modules beneath it
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ workspaces: ["apps/dashboard"] }));
    const worktreePath = join(root, "worktree");
    mkdirSync(join(worktreePath, "apps", "dashboard"), { recursive: true });

    const results = linkWorkspaceNodeModules(repoDir, worktreePath);
    assert.deepEqual(results, [{ workspace: "apps/dashboard", outcome: "no-source" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linkWorkspaceNodeModules covers an occupied destination and a failed symlink, plus workspaceNodeModulesIncomplete's own contract (coverage completeness)", () => {
  const root = tmp("wspaths-cov-sweep-");
  try {
    const repoDir = join(root, "source");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "fixture", workspaces: ["apps/dashboard", "packages/thing"] }),
    );
    const worktreePath = join(root, "worktree");

    // "apps/dashboard": destination OCCUPIED.
    mkdirSync(join(repoDir, "apps", "dashboard", "node_modules"), { recursive: true });
    mkdirSync(join(worktreePath, "apps", "dashboard", "node_modules"), { recursive: true });

    // "packages/thing": destination FREE, but the injected `symlink` throws.
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
  const root = tmp("wspaths-cov-worktreeadd-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedCloneWithWorkspace(clone);
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];
    worktreeAdd(clone, wt, "run-wspaths-cov-1", "main", { log: (step, extra) => logs.push([step, extra]) });

    const workspaceLog = logs.find(([step]) => step === "worktree.workspace_node_modules");
    assert.ok(workspaceLog, "a non-empty workspace-link result must reach the ledger");
    assert.deepEqual(workspaceLog?.[1]?.results, [{ workspace: "apps/dashboard", outcome: "linked" }]);
    assert.equal(workspaceLog?.[1]?.incomplete, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
