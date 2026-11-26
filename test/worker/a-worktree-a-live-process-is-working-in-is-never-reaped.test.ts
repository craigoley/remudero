/**
 * W1-T15026: the worktree reaper never removes a tree a live process is working in.
 *
 * An operator hand review cuts a detached tree in the shared worktrees root, holds no run lock, is not named
 * review-PR<n>-<ts>, and writes nothing inside the tree while it reviews. Past the activity grace every older gate
 * reads it as terminal. The last gate before removal now asks the bounded working-directory census who works at or
 * below the tree; the census is injected here so the cases are the same on any host.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProcessCwdCensus } from "#src/lib/process-cwd-census.js";
import { reapStaleWorktrees } from "#src/lib/worker.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

/** One unregistered, lock-free tree under a private root, as a hand-review tree looks to the reaper. */
function tree(name: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-live-cwd-")));
  const entry = join(root, name);
  mkdirSync(join(entry, "src"), { recursive: true });
  writeFileSync(join(entry, "src", "work.ts"), "export {};\n");
  return { root, entry, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Reap `root` with every older gate reading terminal: no live pid, no live branch, activity `ageMs` old. */
function reap(root: string, ageMs: number, census: (dir: string) => ProcessCwdCensus) {
  return reapStaleWorktrees(root, {
    isPidAlive: () => false,
    pidNamespace: () => "pid:[4026531836]",
    now: () => NOW,
    newestActivity: () => ({ mtimeMs: NOW - ageMs, complete: true }),
    branchIsLiveUpstream: () => false,
    cwdCensus: census,
  });
}

test("W1-T15026 a tree a live process works in is kept as live-cwd", () => {
  const t = tree("op-hand-review-1795712377");
  try {
    const s = reap(t.root, 2 * HOUR, () => ({ state: "occupied", scanned: 212, pid: 4242 }));
    assert.deepEqual(s.reaped, [], "a tree a review is working in is never reaped");
    assert.deepEqual(s.keptReasons, [{ name: "op-hand-review-1795712377", reason: "live-cwd" }]);
    assert.equal(existsSync(t.entry), true, "the tree is still on disk");
  } finally {
    t.cleanup();
  }
});

test("W1-T15026 a terminal tree no process works in is still reaped", () => {
  const t = tree("hd-hand-review-20960");
  const asked: string[] = [];
  try {
    const s = reap(t.root, 2 * HOUR, (dir) => { asked.push(dir); return { state: "clear", scanned: 212 }; });
    assert.deepEqual(asked, [t.entry], "the census is asked once, for the tree about to be removed");
    assert.deepEqual(s.reaped, ["hd-hand-review-20960"], "a clear census lets the removal run");
    assert.equal(existsSync(t.entry), false, "the tree is gone");
  } finally {
    t.cleanup();
  }
  const young = tree("review-PR21032-1795713276026");
  const youngAsked: string[] = [];
  try {
    const s = reap(young.root, 60_000, (dir) => { youngAsked.push(dir); return { state: "clear", scanned: 1 }; });
    assert.deepEqual(s.keptReasons, [{ name: "review-PR21032-1795713276026", reason: "recent-activity" }]);
    assert.deepEqual(youngAsked, [], "a tree an older gate keeps never costs a census");
  } finally {
    young.cleanup();
  }
});

test("W1-T15026 an undecidable census keeps the tree as cwd-unknown", () => {
  for (const reason of ["cwd_unreadable", "entry_bound", "wall_bound"] as const) {
    const t = tree("hd-hand-review-21029");
    try {
      const s = reap(t.root, 2 * HOUR, () => ({ state: "unknown", scanned: 0, reason }));
      assert.deepEqual(s.reaped, [], `${reason}: an unproven absence never authorizes a removal`);
      assert.deepEqual(s.keptReasons, [{ name: "hd-hand-review-21029", reason: "cwd-unknown" }], reason);
      assert.equal(existsSync(t.entry), true, reason);
    } finally {
      t.cleanup();
    }
  }
  const bare = tree("hd-hand-review-21030");
  try {
    const s = reap(bare.root, 2 * HOUR, () => ({ state: "unknown", scanned: 0, reason: "proc_unavailable" }));
    assert.deepEqual(s.reaped, ["hd-hand-review-21030"], "a host with no process table at all reaps as it did before the gate");
  } finally {
    bare.cleanup();
  }
});
