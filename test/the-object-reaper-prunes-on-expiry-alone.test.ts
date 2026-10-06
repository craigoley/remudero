/**
 * OPERATOR RULING 2026-10-06, "prune on expiry alone". The armed object reaper refused 58 ticks in a
 * row (state/object-reap-refusal-streak.json) while the managed checkout held 51,865 loose objects and
 * the daemon's own checkout 141,536, because a working fleet always has a registered worktree or an
 * inflight lock. Those two quiet arms no longer refuse: the prune runs with its 24h expiry and the
 * decision row names the barrier that carried it. An open handle under `.git` still refuses. Stale
 * maintenance leftovers (`objects/maintenance.lock`, `gc.pid`) are reclaimed before the prune, and the
 * daemon's own checkout is reaped as a second repo.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { gitRepo } from "./helpers/git-repo.js";
import { fixedClock } from "../src/lib/clock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { runLockPath } from "../src/lib/worker.js";
import {
  defaultListProcesses,
  LOOSE_OBJECT_FLOOR,
  OBJECT_PRUNE_EXPIRY,
  objectReapDecision,
  reapGitObjects,
  reclaimStaleMaintenanceLocks,
  STALE_MAINTENANCE_LOCK_AGE_MS,
  type ObjectReapDeps,
} from "../src/lib/object-reaper.js";
import { logDiskReclaimRung } from "../src/run-task.js";

const scratch = (label: string) => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${label}-`));

const noSweeps = {
  sweepTempDirs: () => ({ removed: [] }) as never,
  reapClonesSurvey: () => ({ reaped: [], bytesReclaimed: 0 }) as never,
  sweepWorkerHomes: () => ({ removed: [] }) as never,
  workerHomeRoot: () => "/nowhere",
  objectPolicy: () => ({ enabled: true }),
  ratifications: new Map(),
};

/** A store with a `.git` dir; nothing about it is busy unless a test says so. */
function store(): string {
  const dir = scratch("expiry-store");
  mkdirSync(join(dir, ".git", "objects"), { recursive: true });
  return dir;
}

const busy: ObjectReapDeps = {
  listWorktrees: () => ["/w/live"],
  listInflightLocks: () => ["W1-T2.lock"],
  openFileCount: () => 0,
  looseObjectCount: () => LOOSE_OBJECT_FLOOR + 1,
  listProcesses: () => [],
};

test("registered worktrees and inflight locks with no open git handle still prune, and the row says expiry carried it", () => {
  // Through the REAL rung and the REAL worktree listing and active-worker probes: a registered worktree
  // whose run lock names this live process, and another task's live inflight lock.
  const fixture = gitRepo();
  const wt = join(scratch("expiry-wt"), "lane");
  fixture.addWorktree(wt, "lane");
  writeFileSync(runLockPath(wt), JSON.stringify({ pid: process.pid, run_id: "W1-TX-1", startedAt: new Date().toISOString() }));
  const inflight = scratch("expiry-inflight");
  writeFileSync(join(inflight, "W1-T2.lock"), JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));

  const argv: string[][] = [];
  const rows: Array<[string, Record<string, unknown>]> = [];
  const out = logDiskReclaimRung({ root: scratch("expiry-root") } as never, (s, f) => rows.push([s, f]), {
    ...noSweeps,
    objectRepoDir: () => fixture.dir,
    objectInflightDir: () => inflight,
    objectOpenFileCount: () => 0,
    objectOwnInflightLock: "W1-T1.lock",
    reapObjects: ((dir: string, inf: string, d: ObjectReapDeps) =>
      reapGitObjects(dir, inf, {
        ...d,
        looseObjectCount: (() => {
          let n = 0;
          return () => (n++ === 0 ? LOOSE_OBJECT_FLOOR + 100 : 10);
        })(),
        runPrune: (_dir, args) => argv.push([...args]),
        listProcesses: () => [],
      })) as never,
  });

  assert.deepEqual(argv, [["prune", `--expire=${OBJECT_PRUNE_EXPIRY}`]], "the busy store is pruned, with its expiry");
  assert.equal(out.objectsPruned, LOOSE_OBJECT_FLOOR + 90);
  assert.equal(rows.some(([s]) => s === "run.disk_reclaim.objects_declined"), false, "a busy fleet is no longer a refusal");
  const decision = rows.find(([s]) => s === "run.disk_reclaim.objects_decision");
  assert.equal(decision?.[1].carried_by, "expiry", "the row names the barrier that carried the prune");
  assert.equal(decision?.[1].repo, "managed");
  assert.match(String(decision?.[1].quiet_shortfall), /worktree/, "and the quiet condition that failed");

  // POSITIVE CONTROL: with nothing busy, the same decision says quiet carried it.
  assert.deepEqual(objectReapDecision("/r", "/i", { ...busy, listWorktrees: () => [], listInflightLocks: () => [] }), { carriedBy: "quiet" });
  assert.match(String(objectReapDecision("/r", "/i", { ...busy, listWorktrees: () => [] }).quietShortfall), /inflight lock/);
});

test("an open handle under the git dir still refuses the prune even with the fleet busy", () => {
  const streakPath = join(scratch("expiry-streak"), "streak.json");
  const r = reapGitObjects(store(), "/i", {
    ...busy,
    openFileCount: () => 3,
    streakPath,
    runPrune: () => assert.fail("an open handle must refuse the prune"),
  });
  assert.match(r.refusedBecause ?? "", /3 open handle\(s\) under \.git/);
  assert.equal(r.carriedBy, undefined, "a refusal names no barrier");
  assert.equal(r.consecutiveRefusals, 1, "and it extends the refusal streak");
  // Fail closed: no counter supplied reads as held.
  const { openFileCount: _omit, ...noCounter } = busy;
  assert.match(objectReapDecision("/r", "/i", noCounter).refusedBecause ?? "", /open handle/);
});

test("the disk reclaim rung reaps the daemon checkout as a second repo with its own decision row", () => {
  const root = scratch("expiry-root2");
  mkdirSync(join(root, "remudero", ".git"), { recursive: true });
  const calls: Array<{ dir: string; streakPath?: string }> = [];
  const rows: Array<[string, Record<string, unknown>]> = [];
  const out = logDiskReclaimRung({ root } as never, (s, f) => rows.push([s, f]), {
    ...noSweeps,
    reapObjects: ((dir: string, _i: string, d: ObjectReapDeps) => {
      calls.push({ dir, streakPath: d.streakPath });
      return dir.endsWith(join("repos", "remudero"))
        ? { pruned: 0, looseBefore: 9000, refusedBecause: "1 open handle(s) under .git", consecutiveRefusals: 4 }
        : { pruned: 700, looseBefore: 141536, carriedBy: "expiry", quietShortfall: "2 worktree(s) registered" };
    }) as never,
  });
  assert.deepEqual(calls.map((c) => c.dir), [join(root, "repos", "remudero"), join(root, "remudero")]);
  assert.notEqual(calls[0].streakPath, calls[1].streakPath, "each repo keeps its own refusal streak");
  assert.equal(out.objectsPruned, 700);
  const declined = rows.find(([s]) => s === "run.disk_reclaim.objects_declined");
  assert.equal(declined?.[1].repo, "managed");
  const decision = rows.find(([s]) => s === "run.disk_reclaim.objects_decision");
  assert.equal(decision?.[1].repo, "daemon-checkout");
  assert.equal(decision?.[1].carried_by, "expiry");
});

test("a stale maintenance lock and gc pid are reclaimed before the prune and a fresh one is kept", () => {
  const repoDir = store();
  const git = join(repoDir, ".git");
  const now = Date.parse("2026-10-06T12:00:00.000Z");
  const old = (now - STALE_MAINTENANCE_LOCK_AGE_MS - 60_000) / 1000;
  writeFileSync(join(git, "objects", "maintenance.lock"), "");
  utimesSync(join(git, "objects", "maintenance.lock"), old, old);
  writeFileSync(join(git, "gc.pid"), `4242 ${hostname()}`);
  utimesSync(join(git, "gc.pid"), old, old);
  writeFileSync(join(git, "gc.log.lock"), ""); // fresh: a live gc may own it

  let presentAtPrune: boolean[] = [];
  const r = reapGitObjects(repoDir, "/i", {
    ...busy,
    clock: fixedClock(now),
    listProcesses: () => [{ pid: 1, args: "/sbin/init" }],
    runPrune: () => {
      presentAtPrune = [existsSync(join(git, "objects", "maintenance.lock")), existsSync(join(git, "gc.pid"))];
    },
  });
  assert.deepEqual(presentAtPrune, [false, false], "both stale leftovers are gone BEFORE the prune runs");
  assert.deepEqual(r.locks?.reclaimed, ["objects/maintenance.lock", "gc.pid"]);
  assert.equal(existsSync(join(git, "gc.log.lock")), true, "a lock younger than its bound is kept");

  // Each keep arm: a live maintenance process, gc.pid naming a live pid here, an unreadable process list.
  const stage = () => {
    const d = store();
    writeFileSync(join(d, ".git", "gc.pid"), `4242 ${hostname()}`);
    utimesSync(join(d, ".git", "gc.pid"), old, old);
    return join(d, ".git");
  };
  const gcLive = reclaimStaleMaintenanceLocks(stage(), { clock: fixedClock(now), listProcesses: () => [{ pid: 9, args: "git gc --auto" }] });
  assert.match(gcLive.kept?.reason ?? "", /live git maintenance process 9/);
  const pidLive = reclaimStaleMaintenanceLocks(stage(), { clock: fixedClock(now), listProcesses: () => [{ pid: 4242, args: "git" }] });
  assert.match(pidLive.kept?.reason ?? "", /gc\.pid names live process 4242/);
  const blind = reclaimStaleMaintenanceLocks(stage(), { clock: fixedClock(now), listProcesses: () => { throw new Error("ps gone"); } });
  assert.match(blind.kept?.reason ?? "", /process list unavailable.*ps gone/);
  for (const k of [gcLive, pidLive, blind]) assert.deepEqual(k.reclaimed, []);

  // A removal that fails costs that lock, never the reclaim of the others.
  const dirLock = stage();
  mkdirSync(join(dirLock, "gc.log.lock", "x"), { recursive: true });
  utimesSync(join(dirLock, "gc.log.lock"), old, old);
  const partial = reclaimStaleMaintenanceLocks(dirLock, { clock: fixedClock(now), listProcesses: () => [] });
  assert.deepEqual(partial.reclaimed, ["gc.pid"]);
  assert.equal(partial.failed?.[0].path, "gc.log.lock");

  // The real process listing shells out and finds this very process.
  assert.ok(defaultListProcesses().some((p) => p.pid === process.pid));
});

test("the prune argv always carries the 24 hour expiry whichever barrier carried it", () => {
  const seen: Array<{ argv: readonly string[]; carriedBy?: string }> = [];
  for (const deps of [busy, { ...busy, listWorktrees: () => [], listInflightLocks: () => [] }]) {
    let argv: readonly string[] = [];
    const r = reapGitObjects(store(), "/i", { ...deps, runPrune: (_d, a) => { argv = a; } });
    seen.push({ argv, carriedBy: r.carriedBy });
  }
  assert.equal(OBJECT_PRUNE_EXPIRY, "24.hours.ago");
  assert.deepEqual(seen, [
    { argv: ["prune", "--expire=24.hours.ago"], carriedBy: "expiry" },
    { argv: ["prune", "--expire=24.hours.ago"], carriedBy: "quiet" },
  ]);
  // A survey of a busy store estimates with the same expiry and names the same barrier.
  let surveyArgv: readonly string[] = [];
  const dry = reapGitObjects(store(), "/i", { ...busy, dryRun: true, countPrunable: (_d, a) => { surveyArgv = a; return 5; } });
  assert.deepEqual(surveyArgv, ["prune", "-n", "--expire=24.hours.ago"]);
  assert.equal(dry.carriedBy, "expiry");
});
