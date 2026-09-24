/**
 * test/the-object-reaper-rung-runs.test.ts — W1-T4022: the object reaper's three refusals were
 * each individually correct, and their conjunction never passed on a working fleet — but the
 * AMENDED finding was worse: the rung never even REACHED that conjunction. Two defaults were
 * wrong before any of the three conditions were ever evaluated:
 *
 *   (1) `logDiskReclaimRung` read its policy from `loadPolicy(policyPath(config.root))` —
 *       `config.root`, on the daemon, is not a plan-bearing checkout and carries no
 *       `plan/policy.yaml` at all. That load THREW on every tick and was silently swallowed by
 *       the rung's own best-effort catch, so the object reaper never ran once in production
 *       (measured: 0 `objects_declined` rows in four days).
 *   (2) Production injected no open-file counter, so `objectReapRefusal`'s third arm fell back to
 *       its fail-closed default `() => 1` and refused UNCONDITIONALLY, making the other two
 *       conditions moot even on a genuinely idle host.
 *
 * This file proves both are fixed, plus the three additions the task's acceptance also names: a
 * CONSECUTIVE REFUSAL streak (so a single busy tick and a three-week block stop reading
 * identically), a QUIESCED WINDOW bracketing the one destructive call (so a stale sample cannot
 * authorise a prune), and that none of the three original refusal conditions was ever weakened to
 * get there — see src/lib/object-reaper.ts's own doc comments for that half of the evidence.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { defaultOpenFileCount } from "../src/lib/clone-reaper.js";
import {
  LOOSE_OBJECT_FLOOR,
  reapGitObjects,
  recordRefusalStreak,
  readRefusalStreak,
} from "../src/lib/object-reaper.js";
import { logDiskReclaimRung } from "../src/run-task.js";

const noSweeps = {
  sweepTempDirs: () => ({ removed: [] }) as never,
  reapClonesSurvey: () => ({ reaped: [], bytesReclaimed: 0 }) as never,
  sweepWorkerHomes: () => ({ removed: [] }) as never,
  workerHomeRoot: () => "/nowhere",
};

function scratch(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}obj-rung-`));
}

/** A repo dir with a `.git` and a `gc.log`, so the ordering assertions have something to observe. */
function repoWithGcLog(): { repoDir: string; gcLog: string } {
  const repoDir = scratch();
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  const gcLog = join(repoDir, ".git", "gc.log");
  writeFileSync(gcLog, "warning: There are too many unreachable loose objects\n");
  return { repoDir, gcLog };
}

const quietDeps = {
  listWorktrees: () => [],
  listInflightLocks: () => [],
  openFileCount: () => 0,
  looseObjectCount: () => LOOSE_OBJECT_FLOOR + 1,
};

// ── claim 1: the rung loads the DAEMON's policy, so it runs at all ─────────────────────────────

test("W1-T4022: the disk reclaim rung loads the daemon policy and runs", () => {
  // config.root deliberately carries NO plan/policy.yaml — mirrors exactly the daemon checkout
  // the amended note measured: `loadPolicy(policyPath(config.root))` threw here on every tick.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}no-policy-`));
  assert.equal(existsSync(join(root, "plan", "policy.yaml")), false, "the fixture really has no policy.yaml");

  let reached = false;
  let sawDryRun: boolean | undefined;
  const out = logDiskReclaimRung({ root } as never, () => {}, {
    ...noSweeps,
    objectRepoDir: () => "/unused-repo",
    objectInflightDir: () => "/unused-inflight",
    // Deliberately NOT overriding `objectPolicy` — production's own default must resolve on its
    // own, against the REAL shipped plan/policy.yaml (via loadDefaultPolicy()), not config.root's.
    reapObjects: ((_r: string, _i: string, d: { dryRun?: boolean }) => {
      reached = true;
      sawDryRun = d.dryRun;
      return { pruned: 0, looseBefore: 9000 };
    }) as never,
  });

  assert.equal(reached, true, "the rung must reach its reaper even when config.root has no plan/policy.yaml");
  // The shipped plan/policy.yaml ships objectReap.enabled: true (pinned by
  // test/object-reaper-rung-wiring.test.ts), so loading the daemon's REAL policy — not
  // config.root's absent one, silently swallowed — is what decided this, not a fallback.
  assert.equal(sawDryRun, false, "the real shipped policy decided this, not a swallowed load failure defaulting to survey");
  assert.equal(out.objectsPruned, 0);
});

test("W1-T4022: a policy load failure is logged, not silently folded into the generic catch", () => {
  const rows: Array<[string, Record<string, unknown>]> = [];
  logDiskReclaimRung({ root: "/wherever" } as never, (s, f) => rows.push([s, f]), {
    ...noSweeps,
    objectPolicy: () => {
      throw new Error("policy.yaml is not valid YAML");
    },
    reapObjects: (() => {
      throw new Error("must never be reached — the policy load already failed");
    }) as never,
  });
  const err = rows.find(([s]) => s === "run.disk_reclaim.policy_error");
  assert.ok(err, "a policy-load failure must be its own named, logged line");
  assert.match(String(err?.[1].error), /policy\.yaml is not valid YAML/);
});

// ── claim 2: the open-file refusal reads a REAL count, not the fail-closed constant ────────────

test("W1-T4022: the open-file refusal reads a real count", () => {
  let captured: { openFileCount?: (dir: string) => number } | undefined;
  logDiskReclaimRung({ root: scratch() } as never, () => {}, {
    ...noSweeps,
    objectPolicy: () => ({ enabled: false }),
    reapObjects: ((_r: string, _i: string, d: { openFileCount?: (dir: string) => number }) => {
      captured = d;
      return { pruned: 0, looseBefore: 9000 };
    }) as never,
  });
  assert.equal(
    captured?.openFileCount,
    defaultOpenFileCount,
    "production must wire the REAL lsof-backed counter (src/lib/clone-reaper.ts) as the DEFAULT " +
      "— not the fail-closed `() => 1` object-reaper.ts falls back to when nothing supplies one, " +
      "which refused unconditionally and made the other two conditions moot",
  );
});

test("W1-T4022: an injected real open-file count of zero is not treated as held", () => {
  // The behavioural half of the claim above: driven through the REAL reaper, not a double, an
  // empty directory that a REAL counter reports as unheld must actually proceed.
  const { repoDir } = repoWithGcLog();
  const r = reapGitObjects(repoDir, "/no-inflight", {
    listWorktrees: () => [],
    listInflightLocks: () => [],
    looseObjectCount: () => LOOSE_OBJECT_FLOOR + 1,
    openFileCount: (dir) => defaultOpenFileCount(dir), // the real probe, against a dir nothing holds open
    runPrune: () => {},
  });
  assert.equal(r.refusedBecause, undefined, "nothing holds this throwaway directory open");
});

// ── claim 3: a refusal records how long the rung has been refusing ─────────────────────────────

test("W1-T4022: consecutive refusals accumulate, and reset the instant the fleet goes quiet", () => {
  const streakPath = join(scratch(), "streak.json");
  const times = ["2026-09-01T00:00:00.000Z", "2026-09-01T01:00:00.000Z", "2026-09-01T02:00:00.000Z"];
  let i = 0;
  const now = () => times[i++];

  const busy = { repoDir: repoWithGcLog().repoDir };
  const r1 = reapGitObjects(busy.repoDir, "/i", {
    ...quietDeps,
    listWorktrees: () => ["/w/live"],
    streakPath,
    now,
    runPrune: () => assert.fail("refused"),
  });
  assert.equal(r1.consecutiveRefusals, 1);
  assert.equal(r1.refusingSinceIso, times[0]);

  const r2 = reapGitObjects(busy.repoDir, "/i", {
    ...quietDeps,
    listWorktrees: () => ["/w/live"],
    streakPath,
    now,
    runPrune: () => assert.fail("refused"),
  });
  assert.equal(r2.consecutiveRefusals, 2, "a SECOND refusal extends the streak, it does not restart it");
  assert.equal(r2.refusingSinceIso, times[0], "the streak's start stays pinned to when it FIRST began");

  // The fleet goes quiet: the streak resets to zero, not to "one less".
  const r3 = reapGitObjects(busy.repoDir, "/i", {
    ...quietDeps,
    streakPath,
    now,
    runPrune: () => {},
  });
  assert.equal(r3.consecutiveRefusals, 0);
  assert.equal(r3.refusingSinceIso, undefined, "a zero streak carries no start time");

  // Persisted across what a daemon restart would look like — a fresh read of the same path.
  assert.deepEqual(readRefusalStreak(streakPath), { consecutiveRefusals: 0, refusingSinceIso: null });
});

test("W1-T4022: below-the-floor never touches the refusal streak, a different condition entirely", () => {
  const streakPath = join(scratch(), "streak.json");
  recordRefusalStreak(streakPath, true, "2026-09-01T00:00:00.000Z");
  recordRefusalStreak(streakPath, true, "2026-09-01T01:00:00.000Z");
  assert.equal(readRefusalStreak(streakPath).consecutiveRefusals, 2);

  const r = reapGitObjects(repoWithGcLog().repoDir, "/i", {
    looseObjectCount: () => LOOSE_OBJECT_FLOOR - 1,
    streakPath,
    runPrune: () => assert.fail("must not prune below the floor"),
  });
  assert.match(r.refusedBecause ?? "", /below the \d+ floor/);
  assert.equal(r.consecutiveRefusals, undefined, "the floor skip reports no streak of its own");
  assert.equal(readRefusalStreak(streakPath).consecutiveRefusals, 2, "and it left the real streak untouched");
});

// ── claim 4: the reaper runs inside a quiesced window, re-checked before the destructive call ──

test("W1-T4022: a quiesced window closes between the two checks and the prune never spawns", () => {
  const { repoDir, gcLog } = repoWithGcLog();
  let worktreeCalls = 0;
  const r = reapGitObjects(repoDir, "/i", {
    ...quietDeps,
    listWorktrees: () => {
      worktreeCalls++;
      // Quiet on the FIRST sample, busy by the SECOND — exactly what a fleet that dispatches
      // between the two checks produces. Neither call is skipped: both ends are real reads.
      return worktreeCalls === 1 ? [] : ["/w/late-arrival"];
    },
    runPrune: () => assert.fail("a window that closed before the prune must never spawn one"),
  });
  assert.equal(worktreeCalls, 2, "the predicate must be sampled twice — once per end of the window");
  assert.match(r.refusedBecause ?? "", /quiesced window closed/);
  assert.match(r.refusedBecause ?? "", /worktree/);
  assert.equal(existsSync(gcLog), true, "a window that closed must leave gc.log exactly where a first-check refusal would");
});

test("W1-T4022: a window that stays quiet at both ends prunes exactly as before", () => {
  const { repoDir } = repoWithGcLog();
  let worktreeCalls = 0;
  const r = reapGitObjects(repoDir, "/i", {
    ...quietDeps,
    listWorktrees: () => {
      worktreeCalls++;
      return [];
    },
    runPrune: () => {},
  });
  assert.equal(worktreeCalls, 2, "both ends of the window are genuinely checked, not short-circuited");
  assert.equal(r.refusedBecause, undefined);
});

test("W1-T4022: a survey never reaches the second, window-closing check — it returns before gc.log is touched", () => {
  const { repoDir, gcLog } = repoWithGcLog();
  let worktreeCalls = 0;
  const r = reapGitObjects(repoDir, "/i", {
    ...quietDeps,
    listWorktrees: () => {
      worktreeCalls++;
      return [];
    },
    dryRun: true,
    countPrunable: () => 3,
    runPrune: () => assert.fail("a survey must never spawn a prune"),
  });
  assert.equal(worktreeCalls, 1, "a survey samples once — it never commits to a destructive call, so it never opens the window");
  assert.equal(r.wouldPrune, 3);
  assert.equal(existsSync(gcLog), true);
});
