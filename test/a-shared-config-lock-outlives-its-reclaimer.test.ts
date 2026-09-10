import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_CONFIG_LOCK_GRACE_MS,
  configLockPath,
  runConfigLockReclaimRung,
  runWorktreeReapRung,
  wireCredentialHelperSocket,
  worktreeAdd,
} from "../src/lib/worker.js";
import type { Config } from "../src/lib/config.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/** Every temp dir this suite makes carries {@link RMD_TMP_PREFIX}, so `sweepStaleTempDirs` can
 *  reap it on the next boot. The prefix arrives as a PARAMETER, which is why the callsite check
 *  reported it '<unresolvable>' — the checker reads the literal at the callsite, and there was none.
 *  Prepending the constant HERE resolves every caller at once, the same shape
 *  test/adhoc-lane-reap.test.ts already uses. */
function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));
}

function seedClone(repoDir: string): void {
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["-C", repoDir, "init", "--quiet", "--initial-branch", "main"]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "probe@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "probe"]);
  writeFileSync(join(repoDir, "seed.txt"), "x\n");
  execFileSync("git", ["-C", repoDir, "add", "-A"]);
  execFileSync("git", ["-C", repoDir, "commit", "--no-verify", "--quiet", "-m", "chore: seed"]);
  execFileSync("git", ["-C", repoDir, "remote", "add", "origin", repoDir]);
  execFileSync("git", ["-C", repoDir, "fetch", "origin", "--quiet"]);
}

function readConfig(repoDir: string, scope: "--local" | "--worktree", key: string): string {
  try {
    return execFileSync("git", ["-C", repoDir, "config", scope, "--get", key], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function writeConfigLock(repoDir: string, ageMs?: number): string {
  const lockPath = configLockPath(repoDir);
  writeFileSync(lockPath, "");
  if (ageMs !== undefined) {
    const then = new Date(Date.now() - ageMs);
    utimesSync(lockPath, then, then);
  }
  return lockPath;
}

test("W1-T3308 criterion 1: credential and hook configuration are isolated to one linked worktree", () => {
  const root = tmp("rmd-worktree-config-");
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  try {
    seedClone(repo);
    worktreeAdd(repo, worktree, "run-worktree-config", "origin/main");
    wireCredentialHelperSocket(worktree, join(worktree, "credential.sock"));

    assert.equal(readConfig(repo, "--local", "core.hooksPath"), "", "the shared config has no worker hook path");
    assert.equal(readConfig(worktree, "--worktree", "core.hooksPath"), "hooks");
    assert.equal(readConfig(repo, "--local", "credential.useHttpPath"), "", "the shared config has no worker credential setting");
    assert.equal(readConfig(worktree, "--worktree", "credential.useHttpPath"), "true");
    assert.match(
      execFileSync("git", ["-C", worktree, "config", "--worktree", "--get-all", "credential.helper"], { encoding: "utf8" }),
      /git-credential-socket-helper\.mjs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3308 criterion 2: a credential config-write failure propagates to the worker boundary", () => {
  const attempted: string[][] = [];
  assert.throws(
    () =>
      wireCredentialHelperSocket("/worktree", "/worktree/credential.sock", (args) => {
        attempted.push(args);
        throw new Error("could not lock config file");
      }),
    /could not lock config file/,
  );
  assert.deepEqual(attempted, [["credential.helper", ""]], "the first failed write is not swallowed or retried invisibly");
});

test("W1-T3308 criterion 3: the cadence reclaims a stale config lock without a dispatch and leaves a young one", () => {
  const root = tmp("rmd-config-lock-cadence-");
  const repo = join(root, "repos", "remudero");
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const config = { root, claudeBin: "/bin/true" } as Config;
  try {
    seedClone(repo);
    const stale = writeConfigLock(repo, DEFAULT_CONFIG_LOCK_GRACE_MS + 10_000);
    runWorktreeReapRung(config, (step, extra) => logs.push({ step, extra }), {
      configLockRepoDir: repo,
      configLock: { probeLiveGitProcess: () => ({ ran: true, alive: false }) },
    });
    assert.ok(!existsSync(stale), "the idle-fleet rung removes stale debris without an add attempt");
    assert.ok(logs.some((row) => row.step === "worktree.config_lock.reclaiming"), "the destructive action is ledgered");

    const young = writeConfigLock(repo);
    const before = logs.length;
    runWorktreeReapRung(config, (step, extra) => logs.push({ step, extra }), {
      configLockRepoDir: repo,
      configLock: { probeLiveGitProcess: () => ({ ran: true, alive: false }) },
    });
    assert.ok(existsSync(young), "a lock inside the existing grace window survives the cadence");
    assert.equal(logs.length, before, "a young lock is not reported as reclaimed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3308 criterion 4: the cadence preserves a live or uncheckable config lock", () => {
  const root = tmp("rmd-config-lock-cadence-guard-");
  const repo = join(root, "repos", "remudero");
  const config = { root, claudeBin: "/bin/true" } as Config;
  try {
    seedClone(repo);
    for (const probe of [
      () => ({ ran: true, alive: true }),
      () => ({ ran: false, alive: false }),
    ]) {
      const lock = writeConfigLock(repo, DEFAULT_CONFIG_LOCK_GRACE_MS + 10_000);
      runWorktreeReapRung(config, () => undefined, {
        configLockRepoDir: repo,
        configLock: { probeLiveGitProcess: probe },
      });
      assert.ok(existsSync(lock), "a live or uncheckable lock is never evidence authorising removal");
      rmSync(lock);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3308 criterion 5: a reclaimer that THROWS is reported and yields no lock path", () => {
  // The catch arm of `runConfigLockReclaimRung`. Reachable only through the `reclaim` seam the rung
  // already exposes — no new seam, no widened signature. It matters because this rung runs on the
  // idle cadence: a predicate that throws (an unreadable lock, a probe that dies, a permission
  // change under it) must degrade to "no lock reclaimed" and SAY so, never take the cadence down and
  // never report a path it did not reclaim. A caller that received a path here would go on to treat
  // a still-held lock as freed.
  const root = tmp("rmd-config-lock-reap-error-");
  const repo = join(root, "repos", "remudero");
  try {
    seedClone(repo);
    const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const result = runConfigLockReclaimRung(
      repo,
      (step, extra = {}) => logs.push({ step, extra: extra ?? {} }),
      {
        reclaim: () => {
          throw new Error("probe exploded");
        },
      },
    );

    assert.equal(result, null, "a throwing reclaimer yields no lock path, never a path it did not free");
    const errs = logs.filter((l) => l.step === "worktree.config_lock_reap.error");
    assert.equal(errs.length, 1, "the failure is reported exactly once");
    assert.equal(errs[0].extra.config_lock, configLockPath(repo), "the row names WHICH lock it was working on");
    assert.match(String(errs[0].extra.error), /probe exploded/, "and carries the cause, not a bare marker");
    assert.equal(
      logs.filter((l) => l.step === "worktree.config_lock.reclaiming").length,
      0,
      "a throw before any reclaim reports no reclaiming",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
