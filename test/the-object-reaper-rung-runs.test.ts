// Dispatch-time reaping is retired; policy and recovery belong to the cadence rung.
import assert from "node:assert/strict";
import { chmodSync, symlinkSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { clockFromIsoFn } from "../src/lib/clock.js";
import { gitRepo } from "./helpers/git-repo.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import * as cloneReaperLib from "../src/lib/clone-reaper.js";
import {
  LOOSE_OBJECT_FLOOR,
  reapGitObjects,
  recordRefusalStreak,
  readRefusalStreak,
} from "../src/lib/object-reaper.js";
import { logDiskReclaimRung, runRepositoryMaintenanceRung } from "../src/run-task.js";

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

// The cadence rung loads shipped policy; dispatch does not load the retired object policy.

test("the maintenance rung loads shipped policy when the daemon root has no plan", async () => {
  const root = scratch();
  const store = gitRepo({ kind: "maintenance-shipped-policy" });
  assert.equal(existsSync(join(root, "plan", "policy.yaml")), false);
  symlinkSync(store.dir, join(root, "remudero"), "dir");
  writeFileSync(join(store.dir, ".git", "gc.log"), "previous failure\n");
  const rows: Array<[string, Record<string, unknown>]> = [];
  await runRepositoryMaintenanceRung({ root } as never, (s, f) => rows.push([s, f]),
    { activeLanes: 0, disk: "unknown", queueBusy: false });
  const completed = rows.find(([s]) => s === "repository_maintenance.complete")?.[1];
  assert.ok(completed, JSON.stringify(rows));
  assert.equal(completed.kind, "gc");
  assert.equal(completed.gc_log_before, "present");
  assert.equal(completed.gc_log_after, "absent");
  assert.equal(existsSync(join(store.dir, ".git", "gc.log")), false);
});

test("dispatch does not load retired object policy, probe handles or invoke a reaper", async () => {
  const calls: string[] = [];
  const rows: string[] = [];
  const out = await logDiskReclaimRung({ root: scratch() } as never, (s) => rows.push(s), {
    ...noSweeps,
    objectPolicy: () => { calls.push("policy"); throw new Error("retired policy must not load"); },
    objectOpenFileCount: () => { calls.push("handles"); return 0; },
    reapObjects: () => { calls.push("reap"); return { pruned: 50, looseBefore: 9000 }; },
  });
  assert.deepEqual(calls, [], "dispatch invokes no object-maintenance seams");
  assert.deepEqual(rows, [], "dispatch emits no object-maintenance decisions");
  assert.equal(out.objectsPruned, 0);
  assert.equal(out.objectsWouldPrune, 0);
});

// Maintenance relies on Git's object-database lock rather than a recursive handle survey.

test("production maintenance recovers without surveying open handles under the git store", async () => {
  const root = scratch();
  const store = gitRepo({ kind: "maintenance-no-lsof" });
  symlinkSync(store.dir, join(root, "remudero"), "dir");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const invoked = join(root, "lsof-invoked");
  writeFileSync(join(bin, "lsof"), `#!/bin/sh\necho invoked > '${invoked}'\nexit 2\n`);
  chmodSync(join(bin, "lsof"), 0o755);
  writeFileSync(join(store.dir, ".git", "gc.log"), "previous failure\n");
  const rows: Array<[string, Record<string, unknown>]> = [];
  const previous = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${previous}`;
    await runRepositoryMaintenanceRung({ root } as never, (s, f) => rows.push([s, f]),
      { activeLanes: 0, disk: "unknown", queueBusy: false });
  } finally { process.env.PATH = previous; }
  assert.equal(existsSync(invoked), false, "Git's maintenance lock replaces the recursive lsof survey");
  assert.ok(rows.some(([s]) => s === "repository_maintenance.complete"), JSON.stringify(rows));
  assert.equal(existsSync(join(store.dir, ".git", "gc.log")), false);
});

test("W1-T4022: an injected real open-file count of zero is not treated as held", () => {
  // The retained legacy export still honors a real empty handle count.
  const { repoDir } = repoWithGcLog();
  const r = reapGitObjects(repoDir, "/no-inflight", {
    listWorktrees: () => [],
    listInflightLocks: () => [],
    looseObjectCount: () => LOOSE_OBJECT_FLOOR + 1,
    openFileCount: (dir) => cloneReaperLib.defaultOpenFileCount(dir), // the real probe, against a dir nothing holds open
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
    openFileCount: () => 1, // the one arm that still refuses (2026-10-06 ruling)
    streakPath,
    clock: clockFromIsoFn(now),
    runPrune: () => assert.fail("refused"),
  });
  assert.equal(r1.consecutiveRefusals, 1);
  assert.equal(r1.refusingSinceIso, times[0]);

  const r2 = reapGitObjects(busy.repoDir, "/i", {
    ...quietDeps,
    openFileCount: () => 1, // the one arm that still refuses (2026-10-06 ruling)
    streakPath,
    clock: clockFromIsoFn(now),
    runPrune: () => assert.fail("refused"),
  });
  assert.equal(r2.consecutiveRefusals, 2, "a SECOND refusal extends the streak, it does not restart it");
  assert.equal(r2.refusingSinceIso, times[0], "the streak's start stays pinned to when it FIRST began");

  // The fleet goes quiet: the streak resets to zero, not to "one less".
  const r3 = reapGitObjects(busy.repoDir, "/i", {
    ...quietDeps,
    streakPath,
    clock: clockFromIsoFn(now),
    runPrune: () => {},
  });
  assert.equal(r3.consecutiveRefusals, 0);
  assert.equal(r3.refusingSinceIso, undefined, "a zero streak carries no start time");

  // Persisted across what a daemon restart would look like — a fresh read of the same path.
  assert.deepEqual(readRefusalStreak(streakPath), { consecutiveRefusals: 0, refusingSinceIso: null });
});

test("W1-T4022: the default refusal timestamp uses the shared system clock", () => {
  const streakPath = join(scratch(), "default-clock-streak.json");
  const busy = { repoDir: repoWithGcLog().repoDir };
  const result = reapGitObjects(busy.repoDir, "/i", {
    ...quietDeps,
    openFileCount: () => 1, // the one arm that still refuses (2026-10-06 ruling)
    streakPath,
    runPrune: () => assert.fail("refused"),
  });

  assert.equal(result.consecutiveRefusals, 1);
  assert.match(result.refusingSinceIso ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(readRefusalStreak(streakPath), {
    consecutiveRefusals: 1,
    refusingSinceIso: result.refusingSinceIso,
  });
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
  let handleCalls = 0;
  const r = reapGitObjects(repoDir, "/i", {
    ...quietDeps,
    openFileCount: () => {
      handleCalls++;
      // Clear on the FIRST sample, held by the SECOND — a process that opened the store between
      // the two checks. Neither call is skipped: both ends are real reads.
      return handleCalls === 1 ? 0 : 2;
    },
    runPrune: () => assert.fail("a window that closed before the prune must never spawn one"),
  });
  assert.equal(handleCalls, 2, "the predicate must be sampled twice — once per end of the window");
  assert.match(r.refusedBecause ?? "", /quiesced window closed/);
  assert.match(r.refusedBecause ?? "", /open handle/);
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
