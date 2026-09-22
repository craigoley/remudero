import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linkWorktreeNodeModules, worktreeAdd } from "../src/lib/worker.js";

// W1-T4003: the design's own words: "Retain the root node_modules link and its
// lockfile-mismatch observation unchanged." This file pins that baseline STILL holds with
// workspace-linking wired into `worktreeAdd` alongside it -- the root link, the
// `linked-lockfile-mismatch` detection (W1-T2777), and the pre-existing outcome contract of
// `linkWorktreeNodeModules` (W1-T137) are untouched by the new sibling helper, and the two
// compose in a single `worktreeAdd` call without either one masking the other's signal.

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `rmd-${prefix}`));
}

test("linkWorktreeNodeModules's pre-existing outcome contract is untouched: already-present, no-source, failed, linked", () => {
  // Byte-identical to the assertions in test/worktree-node-modules.test.ts -- re-pinned here as
  // the baseline this task's new sibling helper must not have disturbed.
  assert.equal(
    linkWorktreeNodeModules("/clone", "/wt", { lstat: () => ({}) }),
    "already-present",
  );
  assert.equal(
    linkWorktreeNodeModules("/clone", "/wt", {
      lstat: () => {
        throw new Error("ENOENT");
      },
      resolveSource: () => undefined,
    }),
    "no-source",
  );
  assert.equal(
    linkWorktreeNodeModules("/clone", "/wt", {
      lstat: () => {
        throw new Error("ENOENT");
      },
      resolveSource: () => "/src/node_modules",
      symlink: () => {
        throw new Error("EPERM");
      },
    }),
    "failed",
  );
});

/** A throwaway clone with a package.json declaring a workspace, a matching TRACKED workspace
 *  directory (so it exists in a fresh worktree), plus real, UNTRACKED (gitignored) node_modules
 *  at both root and under the workspace -- the exact split the task's rationale measures on the
 *  real fleet host (root install has the CLI, the workspace has its own nested plugin). */
function seedClone(clone: string): void {
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

  // Real, untracked installs -- what `worktreeAdd` must symlink, never copy or reinstall.
  mkdirSync(join(clone, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(clone, "node_modules", ".bin", "some-cli"), "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(join(clone, "apps", "dashboard", "node_modules", "marker-pkg"), { recursive: true });
  writeFileSync(join(clone, "apps", "dashboard", "node_modules", "marker-pkg", "index.js"), "module.exports = 1;\n");
}

test("worktreeAdd links the root node_modules AND the workspace node_modules together, neither masking the other", () => {
  const root = tmp("baseline-both-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];
    worktreeAdd(clone, wt, "run-baseline-1", "main", { log: (step, extra) => logs.push([step, extra]) });

    // The pre-existing root link, unchanged.
    assert.equal(lstatSync(join(wt, "node_modules")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(wt, "node_modules")), join(clone, "node_modules"));
    assert.equal(existsSync(join(wt, "node_modules", ".bin", "some-cli")), true);

    // The new workspace link, alongside it.
    assert.equal(lstatSync(join(wt, "apps", "dashboard", "node_modules")).isSymbolicLink(), true);
    assert.equal(
      readlinkSync(join(wt, "apps", "dashboard", "node_modules")),
      join(clone, "apps", "dashboard", "node_modules"),
    );
    assert.equal(existsSync(join(wt, "apps", "dashboard", "node_modules", "marker-pkg", "index.js")), true);

    // The pre-existing "worktree.add" ledger line still fires, in the same step name.
    assert.equal(
      logs.some(([step]) => step === "worktree.add"),
      true,
    );
    // The new aggregate is a SEPARATE step, never folded into or replacing the old one.
    const workspaceLog = logs.find(([step]) => step === "worktree.workspace_node_modules");
    assert.ok(workspaceLog, "the aggregate workspace-link result must reach the same observability channel");
    assert.deepEqual(workspaceLog?.[1]?.results, [{ workspace: "apps/dashboard", outcome: "linked" }]);
    assert.equal(workspaceLog?.[1]?.incomplete, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktreeAdd's lockfile-mismatch observation on the ROOT link still fires unaffected by workspace-linking", (t) => {
  const root = tmp("baseline-mismatch-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    // Dirty the CLONE's own working-tree lockfile only (no commit) -- the worktree is cut from
    // the COMMITTED content below, so its package-lock.json stays at the seeded shape while the
    // parent clone's own copy (what `linkWorktreeNodeModules` hashes as the node_modules source)
    // now differs, reproducing the W1-T2777 drift shape without depending on ref divergence.
    writeFileSync(join(clone, "package-lock.json"), JSON.stringify({ name: "fixture", version: "dirty" }));

    // `worktreeAdd` calls `linkWorktreeNodeModules(repoDir, worktreePath)` with no injected
    // `warn`, so the mismatch warning goes to its real default (`console.error`) regardless of
    // the `warn` this test passes to `worktreeAdd` itself (that one only reaches
    // `recordCanonicalCheckoutDrift`) -- pre-existing wiring, unchanged by this task.
    const errors: string[] = [];
    t.mock.method(console, "error", (m: string) => {
      errors.push(m);
    });
    worktreeAdd(clone, wt, "run-baseline-2", "main");

    assert.equal(
      errors.some((w) => w.startsWith("node_modules lockfile mismatch:")),
      true,
      "the root link's W1-T2777 mismatch warning must still fire -- workspace-linking must not swallow it",
    );
    // The workspace link is unaffected by the root mismatch -- it has its own healthy source.
    assert.equal(lstatSync(join(wt, "apps", "dashboard", "node_modules")).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
