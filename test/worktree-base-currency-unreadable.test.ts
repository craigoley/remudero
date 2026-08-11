import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertWorktreeBaseCurrent, worktreeAdd } from "../src/lib/worker.js";

// W1-T405 design note (iii): when the remote head cannot be read -- an unreachable forge, a
// transport error -- dispatch must PROCEED WITH A WARNING, never refuse. Refusing on an
// unmeasurable condition would convert a network blip into a stalled queue, which this repo
// has re-learned the hard way more than once (ci-gate's wait cap, a deploy ceiling burned
// by a dry run, a check-wait bound, the idle-gate ceiling).

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedClone(clone: string): void {
  mkdirSync(clone, { recursive: true });
  execFileSync("git", ["-C", clone, "init", "--quiet", "--initial-branch", "main"]);
  execFileSync("git", ["-C", clone, "config", "user.email", "probe@example.invalid"]);
  execFileSync("git", ["-C", clone, "config", "user.name", "probe"]);
  writeFileSync(join(clone, "seed.txt"), "x\n");
  execFileSync("git", ["-C", clone, "add", "-A"]);
  execFileSync("git", ["-C", clone, "commit", "--no-verify", "--quiet", "-m", "chore: seed"]);
  execFileSync("git", ["-C", clone, "remote", "add", "origin", clone]);
  execFileSync("git", ["-C", clone, "fetch", "origin", "--quiet"]);
}

test("assertWorktreeBaseCurrent PROCEEDS (does not throw) when the remote head cannot be read", () => {
  assert.doesNotThrow(() =>
    assertWorktreeBaseCurrent("aaaaaaa1", "main", {
      readRemoteHead: () => {
        throw new Error("ETIMEDOUT: could not reach the forge");
      },
    }),
  );
});

test("...but it still WARNS, so an operator can tell the check ran and could not measure", () => {
  const warnings: string[] = [];
  assertWorktreeBaseCurrent("aaaaaaa1", "main", {
    readRemoteHead: () => {
      throw new Error("ETIMEDOUT: could not reach the forge");
    },
    warn: (m) => warnings.push(m),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /main/);
  assert.match(warnings[0]!, /ETIMEDOUT|could not reach/);
});

test("a refusing default warn() falls back to console.error, never throws itself", () => {
  // No `warn` override supplied -- the default must not itself become a second failure
  // mode (e.g. by throwing when console.error is unavailable in some odd host).
  assert.doesNotThrow(() =>
    assertWorktreeBaseCurrent("aaaaaaa1", "main", {
      readRemoteHead: () => {
        throw new Error("network unreachable");
      },
    }),
  );
});

test("worktreeAdd proceeds when the remote head cannot be read -- an unreachable forge cannot block dispatch", () => {
  const root = tmp("rmd-wt-unreadable-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    const warnings: string[] = [];
    assert.doesNotThrow(() =>
      worktreeAdd(clone, wt, "run-unreadable-probe", "origin/main", {
        readRemoteHead: () => {
          throw new Error("ETIMEDOUT");
        },
        warn: (m) => warnings.push(m),
      }),
    );
    assert.equal(warnings.length, 1, "the check must still surface a warning, not run silently");
    // And the worktree really was created -- an unreadable remote head degrades to
    // "proceed", not to "abort worktree setup".
    const head = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.match(head, /^[0-9a-f]{40}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
