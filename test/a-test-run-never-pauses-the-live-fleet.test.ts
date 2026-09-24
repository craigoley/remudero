import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { realSharedPauseGitDeps, requestPause, resumeFleet, sharedPauseRef } from "../src/lib/fleet-control.js";
import { LiveWriteBlockedError } from "../src/lib/live-write-guard.js";

// 2026-09-24 every daemon held for 32 minutes on `rmd-pause hold 2770992@8d0ad3a86e66`, with no
// `fleet.pause` in any live ledger: a worker's test run drove `rmd pause` through main(), whose
// shared-pause repo follows the cwd — a fleet worktree whose origin is the live repo.

/** Runs `fn` with a `git` on PATH that records every call it receives and exits 0. */
function withRecordingGit(fn: (calls: () => string) => void): void {
  const bin = mkdtempSync(join(tmpdir(), "rmd-live-pause-bin-"));
  const log = join(bin, "calls");
  writeFileSync(log, "");
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$*" >> "${log}"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    fn(() => readFileSync(log, "utf8"));
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
}

test("under the test runner the real shared-pause deps refuse to push the hold, before git runs", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-live-pause-root-"));
  try {
    withRecordingGit((calls) => {
      const deps = realSharedPauseGitDeps(root);
      assert.throws(() => requestPause(root, "a test", deps), LiveWriteBlockedError);
      assert.ok(existsSync(join(root, "state", "PAUSE")), "the local flag still lands first");
      assert.throws(() => resumeFleet(root, deps), LiveWriteBlockedError, "a test can never clear a real hold either");
      assert.doesNotMatch(calls(), /push/, "no push was ever handed to git");
      assert.match(calls(), /commit-tree/, "the anchor was minted, so the refusal sits at the push itself");
      assert.ok(sharedPauseRef().startsWith("refs/rmd-pause/"));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
