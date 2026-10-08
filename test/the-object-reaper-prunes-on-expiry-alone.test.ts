/**
 * Production now uses the cadence controller: live workers defer full GC and each real store has
 * its own decision and retry state. Retained legacy exports are tested directly for the historical
 * expiry barrier, open-handle refusal and stale-lock handling; dispatch never invokes those exports.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, existsSync, symlinkSync, readdirSync, readFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { gitRepo } from "./helpers/git-repo.js";
import { fixedClock } from "../src/lib/clock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { runLockPath } from "../src/lib/worker.js";
import {
  defaultListProcesses,
  readMaintenanceState,
  LOOSE_OBJECT_FLOOR,
  OBJECT_PRUNE_EXPIRY,
  objectReapDecision,
  reapGitObjects,
  reclaimStaleMaintenanceLocks,
  STALE_MAINTENANCE_LOCK_AGE_MS,
  type ObjectReapDeps,
} from "../src/lib/object-reaper.js";
import { runRepositoryMaintenanceRung } from "../src/run-task.js";

const scratch = (label: string) => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${label}-`));

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

test("live workers defer full maintenance and preserve the marker and due episode", async () => {
  const root = scratch("maintenance-busy-root");
  const fixture = gitRepo({ kind: "maintenance-busy-store" });
  const wt = join(scratch("maintenance-busy-wt"), "lane");
  fixture.addWorktree(wt, "lane");
  writeFileSync(runLockPath(wt), JSON.stringify({ pid: process.pid, run_id: "W1-TX-1", startedAt: new Date().toISOString() }));
  mkdirSync(join(root, "repos"));
  symlinkSync(fixture.dir, join(root, "repos", "remudero"), "dir");
  const inflight = join(root, "state", "inflight");
  mkdirSync(inflight, { recursive: true });
  writeFileSync(join(inflight, "W1-T2.lock"), JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
  const marker = join(fixture.dir, ".git", "gc.log");
  writeFileSync(marker, "failure evidence\n");
  const rows: Array<[string, Record<string, unknown>]> = [];
  await runRepositoryMaintenanceRung({ root } as never, (s, f) => rows.push([s, f]),
    { activeLanes: 0, disk: "unknown", queueBusy: false });
  const deferred = rows.find(([s]) => s === "repository_maintenance.defer")?.[1];
  assert.ok(deferred, JSON.stringify(rows));
  assert.equal(deferred.active_lanes, 1, "the default probe sees the live inflight holder");
  assert.match(String(deferred.reason), /full GC requires quiet admission/);
  assert.equal(rows.some(([s]) => s === "repository_maintenance.start"), false);
  assert.equal(readFileSync(marker, "utf8"), "failure evidence\n");
  const stateName = readdirSync(join(root, "state")).find((name) => name.startsWith("repository-maintenance-"))!;
  const state = readMaintenanceState(join(root, "state", stateName));
  assert.equal(state.nextEligibleAt, 0, "a busy deferral does not lose the due GC episode");
  assert.equal(state.failures, 0);

  // Retained raw-prune exports still report the historical expiry barrier; production never calls them.
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

test("the cadence maintains the daemon checkout as a second repo with its own decision and state", async () => {
  const root = scratch("maintenance-two-stores");
  const managed = gitRepo({ kind: "maintenance-managed" });
  const daemon = gitRepo({ kind: "maintenance-daemon" });
  mkdirSync(join(root, "repos"));
  symlinkSync(managed.dir, join(root, "repos", "remudero"), "dir");
  symlinkSync(daemon.dir, join(root, "remudero"), "dir");
  for (const store of [managed, daemon]) writeFileSync(join(store.dir, ".git", "gc.log"), "prior failure\n");
  const rows: Array<[string, Record<string, unknown>]> = [];
  await runRepositoryMaintenanceRung({ root } as never, (s, f) => rows.push([s, f]),
    { activeLanes: 0, disk: "unknown", queueBusy: false });
  const completed = rows.filter(([s]) => s === "repository_maintenance.complete").map(([, f]) => f);
  assert.deepEqual(completed.map((f) => f.repo), [join(root, "repos", "remudero"), join(root, "remudero")]);
  assert.ok(completed.every((f) => f.kind === "gc" && f.gc_log_before === "present" && f.gc_log_after === "absent"));
  assert.equal(readdirSync(join(root, "state")).filter((name) => name.startsWith("repository-maintenance-")).length, 2);
  for (const store of [managed, daemon]) assert.equal(existsSync(join(store.dir, ".git", "gc.log")), false);
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
