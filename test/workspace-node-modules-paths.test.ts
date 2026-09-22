import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveWorkspacePaths, isSafeWorkspaceGlob, linkWorkspaceNodeModules } from "../src/lib/worker.js";

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
