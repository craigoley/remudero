/**
 * W1-T14319: the worktree reaper never reads another container's run lock as a dead pid.
 *
 * THE INCIDENT. The product planner in the serve container added a locked worktree; 91 s later the
 * daemon container — its own pid namespace, the same worktrees root — reaped it. Its pid was absent
 * from the daemon's namespace, so the reaper called it confirmed dead, and a confirmed-dead lock
 * withdraws the recent-activity rescue (W1-T381).
 *
 * A lock now records its writer's pid namespace (`pidNs`). Only a lock written in the reaper's OWN
 * namespace can name a confirmed-dead pid; any other, or one naming none, is a foreign holder that
 * keeps the rescue and the age gate. Both namespaces and the liveness probe are injected, so the
 * cases are the same on any host.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readRunLock, reapStaleWorktrees, runLockPath, runLockRecord, writeRunLock, type RunLockInfo } from "#src/lib/worker.js";

const HERE = "pid:[4026531836]";
const SIBLING = "pid:[4026532999]";
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

/** One unregistered worktree under a private root, its lock written as `info` names it. */
function tree(name: string, info: RunLockInfo | undefined) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-foreign-holder-")));
  const entry = join(root, name);
  mkdirSync(join(entry, "src"), { recursive: true });
  writeFileSync(join(entry, "src", "work.ts"), "export {};\n");
  if (info) writeFileSync(runLockPath(entry), JSON.stringify(info, null, 2));
  return { root, entry, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function reap(root: string, activityAgeMs: number) {
  return reapStaleWorktrees(root, {
    isPidAlive: () => false, // the holder's pid is absent from THIS namespace
    pidNamespace: () => HERE,
    now: () => NOW,
    newestActivity: () => ({ mtimeMs: NOW - activityAgeMs, complete: true }),
    branchIsLiveUpstream: () => false,
  });
}

const lock = (pidNs?: string): RunLockInfo => ({
  pid: 31337, run_id: "PLANNER-1795355858842", startedAt: "2026-11-22T00:00:00Z", ...(pidNs === undefined ? {} : { pidNs }),
});

test("W1-T14319 criterion 1: a recently active worktree whose lock names another container and a pid absent here is kept with reason foreign-holder", () => {
  for (const [label, info] of [["another pid namespace", lock(SIBLING)], ["no recorded namespace (a lock written before W1-T14319)", lock()]] as const) {
    const t = tree("run-PLANNER-1795355858842", info);
    try {
      const s = reap(t.root, 91_000);
      assert.deepEqual(s.reaped, [], `${label}: a sibling's live run is never reaped on its pid`);
      assert.deepEqual(s.keptReasons, [{ name: "run-PLANNER-1795355858842", reason: "foreign-holder" }], label);
      assert.equal(existsSync(t.entry), true, `${label}: the tree is still on disk`);
      assert.equal(existsSync(runLockPath(t.entry)), true, `${label}: and so is its lock`);
    } finally {
      t.cleanup();
    }
  }
});

test("W1-T14319 criterion 2: a same-container dead pid, and a foreign-locked tree past the age gate, are still reaped", () => {
  const cases: Array<[string, RunLockInfo, number]> = [
    ["a dead pid of this same namespace, recently active (W1-T381 stands)", lock(HERE), 91_000],
    ["a foreign-namespace lock past the age gate", lock(SIBLING), 48 * HOUR],
    ["a namespace-less lock past the age gate", lock(), 48 * HOUR],
  ];
  for (const [label, info, ageMs] of cases) {
    const t = tree("run-W1-T14319-1795355858842", info);
    try {
      const s = reap(t.root, ageMs);
      assert.deepEqual(s.reaped, ["run-W1-T14319-1795355858842"], label);
      assert.deepEqual(s.kept, [], label);
      assert.equal(existsSync(t.entry), false, `${label}: the tree is gone`);
      assert.equal(existsSync(runLockPath(t.entry)), false, `${label}: and its lock with it`);
    } finally {
      t.cleanup();
    }
  }
});

test("every run-lock writer stamps its own pid namespace, and a lock without one still reads as live", () => {
  assert.deepEqual(runLockRecord(lock(), () => HERE), lock(HERE), "the writer's namespace is stamped");
  assert.deepEqual(runLockRecord(lock(SIBLING), () => HERE), lock(SIBLING), "a namespace the caller names is kept");
  assert.deepEqual(runLockRecord(lock(), () => undefined), lock(), "off Linux no namespace is invented");
  const t = tree("run-legacy", lock());
  try {
    assert.deepEqual(readRunLock(t.entry), { kind: "live", info: lock() }, "a legacy lock without pidNs stays readable");
    writeRunLock(t.entry, runLockRecord(lock(), () => SIBLING));
    assert.deepEqual(readRunLock(t.entry), { kind: "live", info: lock(SIBLING) }, "a stamped lock round-trips its namespace");
  } finally {
    t.cleanup();
  }
});
