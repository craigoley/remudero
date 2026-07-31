import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { linkWorktreeNodeModules, resolveNodeModulesSource, worktreeAdd } from "../src/lib/worker.js";

// W1-T137 (#842) shipped `hooks/commit-msg` and wired it into every worktree via
// `core.hooksPath`, but `worktreeAdd` never supplied the `node_modules` that hook
// resolves `commitlint` from -- so every commit from every worktree verb was rejected
// with "commitlint is not installed in this worktree". These tests pin BOTH halves:
// the gate now passes a well-formed message, and STILL rejects a malformed one.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HAS_COMMITLINT = existsSync(join(REPO_ROOT, "node_modules", ".bin", "commitlint"));

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return dir;
}

test("resolveNodeModulesSource prefers the parent clone's own install when it has one", () => {
  const seen: string[] = [];
  const source = resolveNodeModulesSource("/clone", "/install", (p) => {
    seen.push(p);
    return true;
  });
  assert.equal(source, join("/clone", "node_modules"));
  assert.deepEqual(seen, [join("/clone", "node_modules")], "must not probe the fallback once the clone answers");
});

test("resolveNodeModulesSource falls back to the rmd install root when the clone has no node_modules", () => {
  // This is the fleet host's real shape: worktrees are cut from <root>/repos/<repo>,
  // which carries no install at all. A repoDir-only source would ship inert here.
  const source = resolveNodeModulesSource("/clone", "/install", (p) => p === join("/install", "node_modules"));
  assert.equal(source, join("/install", "node_modules"));
});

test("resolveNodeModulesSource returns undefined when neither candidate exists", () => {
  assert.equal(resolveNodeModulesSource("/clone", "/install", () => false), undefined);
});

test("linkWorktreeNodeModules never links over a path that is already taken", () => {
  // Guards a real incident: `ln -s` onto an existing directory-symlink writes INSIDE
  // the target rather than replacing it. lstat (not stat) so a BROKEN link counts too.
  let linked = 0;
  const outcome = linkWorktreeNodeModules("/clone", "/wt", {
    lstat: () => ({}),
    symlink: () => {
      linked += 1;
    },
  });
  assert.equal(outcome, "already-present");
  assert.equal(linked, 0, "an occupied destination must never be linked over");
});

test("linkWorktreeNodeModules reports failure instead of throwing -- a worktree must still be created", () => {
  const outcome = linkWorktreeNodeModules("/clone", "/wt", {
    lstat: () => {
      throw new Error("ENOENT");
    },
    resolveSource: () => "/src/node_modules",
    symlink: () => {
      throw new Error("EPERM");
    },
  });
  assert.equal(outcome, "failed", "every outcome is a return value, never a throw");
});

test("linkWorktreeNodeModules reports no-source when nothing can be linked", () => {
  const outcome = linkWorktreeNodeModules("/clone", "/wt", {
    lstat: () => {
      throw new Error("ENOENT");
    },
    resolveSource: () => undefined,
  });
  assert.equal(outcome, "no-source");
});

test("linkWorktreeNodeModules really symlinks a resolvable source onto disk", () => {
  const root = tmp("rmd-link-");
  try {
    const source = join(root, "clone", "node_modules");
    mkdirSync(source, { recursive: true });
    const wt = join(root, "wt");
    mkdirSync(wt, { recursive: true });

    const outcome = linkWorktreeNodeModules(join(root, "clone"), wt);

    assert.equal(outcome, "linked");
    assert.equal(lstatSync(join(wt, "node_modules")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(wt, "node_modules")), source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "worktreeAdd wires a node_modules so the commit-msg hook ACCEPTS a well-formed message",
  { skip: HAS_COMMITLINT ? false : "requires node_modules/.bin/commitlint" },
  () => {
    const root = tmp("rmd-wt-accept-");
    const clone = join(root, "clone");
    const wt = join(root, "wt");
    try {
      seedClone(clone);
      worktreeAdd(clone, wt, "run-probe-1", "main");

      // The mechanism: worktreeAdd supplied a node_modules the hook can resolve.
      assert.equal(lstatSync(join(wt, "node_modules")).isSymbolicLink(), true);
      assert.equal(
        existsSync(join(wt, "node_modules", ".bin", "commitlint")),
        true,
        "the linked node_modules must actually resolve commitlint",
      );

      writeFileSync(join(wt, "touched.txt"), "x\n");
      execFileSync("git", ["-C", wt, "add", "touched.txt"]);
      // Exactly the message shape `rmd triage` commits (src/run-task.ts:9598).
      execFileSync("git", ["-C", wt, "commit", "-m", "chore(triage): record verdicts for 1 feedback item"], {
        stdio: "pipe",
      });

      const subject = execFileSync("git", ["-C", wt, "log", "-1", "--pretty=%s"], { encoding: "utf8" }).trim();
      assert.equal(subject, "chore(triage): record verdicts for 1 feedback item");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "the commit-msg gate is REPAIRED, not disabled -- a malformed message is still rejected",
  { skip: HAS_COMMITLINT ? false : "requires node_modules/.bin/commitlint" },
  () => {
    const root = tmp("rmd-wt-reject-");
    const clone = join(root, "clone");
    const wt = join(root, "wt");
    try {
      seedClone(clone);
      worktreeAdd(clone, wt, "run-probe-2", "main");

      writeFileSync(join(wt, "touched.txt"), "x\n");
      execFileSync("git", ["-C", wt, "add", "touched.txt"]);
      assert.throws(
        () =>
          execFileSync("git", ["-C", wt, "commit", "-m", "This Is Not Conventional At All"], {
            stdio: "pipe",
          }),
        /commitlint rejected the message/,
        "supplying node_modules must not weaken the gate -- it must let it RUN",
      );
      assert.equal(
        execFileSync("git", ["-C", wt, "log", "--oneline"], { encoding: "utf8" }).includes("Not Conventional"),
        false,
        "the malformed commit must not exist",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

/** A throwaway clone carrying the REAL tracked `hooks/commit-msg` and the REAL
 *  `commitlint.config.mjs`, so the hook under test is this repo's own, never a
 *  reimplementation of it. Its own node_modules is linked to this install's so the
 *  hook can resolve commitlint without paying for an install (the same technique
 *  test/commit-msg-hook.test.ts:78 uses). */
function seedClone(clone: string): void {
  mkdirSync(join(clone, "hooks"), { recursive: true });
  execFileSync("git", ["-C", clone, "init", "--quiet", "--initial-branch", "main"]);
  execFileSync("git", ["-C", clone, "config", "user.email", "probe@example.invalid"]);
  execFileSync("git", ["-C", clone, "config", "user.name", "probe"]);
  writeFileSync(join(clone, "hooks", "commit-msg"), readFileSync(join(REPO_ROOT, "hooks", "commit-msg")), {
    mode: 0o755,
  });
  writeFileSync(join(clone, "commitlint.config.mjs"), readFileSync(join(REPO_ROOT, "commitlint.config.mjs")));
  execFileSync("git", ["-C", clone, "add", "-A"]);
  execFileSync("git", ["-C", clone, "commit", "--no-verify", "--quiet", "-m", "chore: seed"]);
  // `worktreeAdd` fetches origin; point it at itself so that fetch is a local no-op.
  execFileSync("git", ["-C", clone, "remote", "add", "origin", clone]);
  execFileSync("git", ["-C", clone, "fetch", "origin", "--quiet"]);
  symlinkSync(join(REPO_ROOT, "node_modules"), join(clone, "node_modules"), "dir");
}
