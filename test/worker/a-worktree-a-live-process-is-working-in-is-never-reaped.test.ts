/**
 * W1-T15026: the worktree reaper never removes a tree a live process is working in.
 *
 * An operator hand review cuts a detached tree in the shared worktrees root, holds no run lock, is not named
 * review-PR<n>-<ts>, and writes nothing inside the tree while it reviews. Past the activity grace every older gate
 * reads it as terminal. The last gate before removal now asks the bounded working-directory census who works at or
 * below the tree; the census is injected here so the cases are the same on any host.
 */
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readBoundedProcessCwdCensus, type ProcessCwdCensus } from "#src/lib/process-cwd-census.js";
import { reapStaleWorktrees, type WorktreeReapOpts } from "#src/lib/worker.js";

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
function reap(root: string, ageMs: number, census?: (dir: string) => ProcessCwdCensus, extra: WorktreeReapOpts = {}) {
  return reapStaleWorktrees(root, {
    isPidAlive: () => false,
    pidNamespace: () => "pid:[4026531836]",
    now: () => NOW,
    newestActivity: () => ({ mtimeMs: NOW - ageMs, complete: true }),
    branchIsLiveUpstream: () => false,
    cwdCensus: census,
    ...extra,
  });
}

/** A `statProcessTable` that fails with `code`; ENOENT is the one answer that proves a host has no `/proc`. */
function statFails(code: string) {
  return () => {
    throw Object.assign(new Error(`${code}: injected stat of /proc`), { code });
  };
}

/** A supplied process table: each call yields pid 4242 once, then ends, or throws `then` mid-enumeration. */
function onePid(then?: Error) {
  let reads = 0;
  return () => {
    if (reads++ === 0) return "4242";
    if (then) throw then;
    return null;
  };
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

test("W1-T15026 a tree a live process works in is kept as live-cwd through a symlinked path", () => {
  const name = "op-hand-review-1795712378";
  for (const linked of ["root", "tree"] as const) {
    const t = tree(name);
    const links = realpathSync(mkdtempSync(join(tmpdir(), "rmd-live-cwd-link-")));
    try {
      let root = links;
      if (linked === "root") {
        root = join(links, "worktrees");
        symlinkSync(t.root, root);
      } else {
        symlinkSync(t.entry, join(links, name));
      }
      // The real census compares paths; the process's cwd is spelled canonically, as a `/proc` cwd link is.
      const s = reap(root, 2 * HOUR, (dir) =>
        readBoundedProcessCwdCensus(dir, { readNextPid: onePid(), readCwd: () => join(t.entry, "src"), clock: { now: () => 0 } }));
      assert.deepEqual(s.reaped, [], `symlinked ${linked}: an occupied tree is never reaped`);
      assert.deepEqual(s.keptReasons, [{ name, reason: "live-cwd" }], linked);
      assert.equal(existsSync(join(root, name)), true, linked);
      assert.equal(existsSync(t.entry), true, linked);
    } finally {
      rmSync(links, { recursive: true, force: true });
      t.cleanup();
    }
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

test("W1-T15026 a terminal tree no process works in is still reaped when it vanishes mid-pass", () => {
  const t = tree("hd-hand-review-20961");
  const asked: string[] = [];
  try {
    const s = reap(t.root, 2 * HOUR, (dir) => { asked.push(dir); return { state: "clear", scanned: 1 }; }, {
      // A concurrent removal wins after the pass has seen the directory and before the census gate.
      newestActivity: () => {
        rmSync(t.entry, { recursive: true, force: true });
        return { mtimeMs: 0, complete: true };
      },
    });
    assert.deepEqual(s.reaped, ["hd-hand-review-20961"], "a tree proven gone is recorded as it was before the gate");
    assert.deepEqual(s.keptReasons, []);
    assert.deepEqual(asked, [], "a tree that no longer exists is never censused");
  } finally {
    t.cleanup();
  }
});

test("W1-T15026 a tree a later keep rule already holds keeps its own reason and costs no census", () => {
  const t = tree("hd-hand-review-21031");
  const asked: string[] = [];
  try {
    writeFileSync(join(t.entry, ".git"), "not a gitdir pointer\n");
    const s = reap(t.root, 2 * HOUR, (dir) => { asked.push(dir); return { state: "occupied", scanned: 1, pid: 7 }; });
    assert.deepEqual(s.keptReasons, [{ name: "hd-hand-review-21031", reason: "git-unreadable" }]);
    assert.deepEqual(asked, [], "the census is asked only for a tree nothing else keeps");
  } finally {
    t.cleanup();
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
    const s = reap(bare.root, 2 * HOUR, () => ({ state: "unknown", scanned: 0, reason: "proc_unavailable" }),
      { statProcessTable: statFails("ENOENT") });
    assert.deepEqual(s.reaped, ["hd-hand-review-21030"], "a host with no process table at all reaps as it did before the gate");
  } finally {
    bare.cleanup();
  }
});

test("W1-T15026 an undecidable census keeps the tree as cwd-unknown when /proc is not proven absent", () => {
  const unproven: Array<[string, WorktreeReapOpts["statProcessTable"]]> = [
    ["/proc stats", () => ({})],
    ["EACCES", statFails("EACCES")],
    ["EIO", statFails("EIO")],
  ];
  for (const [label, statProcessTable] of unproven) {
    const t = tree("hd-hand-review-21032");
    try {
      const s = reap(t.root, 2 * HOUR, () => ({ state: "unknown", scanned: 0, reason: "proc_unavailable" }),
        { statProcessTable });
      assert.deepEqual(s.reaped, [], label);
      assert.deepEqual(s.keptReasons, [{ name: "hd-hand-review-21032", reason: "cwd-unknown" }], label);
      assert.equal(existsSync(t.entry), true, label);
    } finally {
      t.cleanup();
    }
  }
});

test("W1-T15026 an undecidable census keeps the tree as cwd-unknown when the /proc enumeration breaks", () => {
  const t = tree("hd-hand-review-21033");
  const seen: ProcessCwdCensus[] = [];
  try {
    const broken = Object.assign(new Error("EIO: injected readdir of /proc"), { code: "EIO" });
    const s = reap(t.root, 2 * HOUR, (dir) => {
      const census = readBoundedProcessCwdCensus(dir, { readNextPid: onePid(broken), readCwd: () => "/", clock: { now: () => 0 } });
      seen.push(census);
      return census;
    }, { statProcessTable: () => ({}) });
    assert.deepEqual(seen, [{ state: "unknown", scanned: 1, reason: "proc_unavailable" }]);
    assert.deepEqual(s.keptReasons, [{ name: "hd-hand-review-21033", reason: "cwd-unknown" }]);
    assert.equal(existsSync(t.entry), true);
  } finally {
    t.cleanup();
  }
});

test("W1-T15026 an undecidable census keeps the tree as cwd-unknown when /proc cannot be opened", (ctx) => {
  const t = tree("hd-hand-review-21034");
  const real = fs.opendirSync;
  let refused = 0;
  const patch = ctx.mock.method(fs, "opendirSync", (...args: Parameters<typeof fs.opendirSync>) => {
    if (args[0] !== "/proc") return real(...args);
    refused += 1;
    throw Object.assign(new Error("EMFILE: injected open of /proc"), { code: "EMFILE" });
  });
  syncBuiltinESMExports();
  try {
    // The default census runs. `/proc` stats as present, whatever host this is.
    const s = reap(t.root, 2 * HOUR, undefined, { statProcessTable: () => ({}) });
    assert.equal(refused, 1, "the default census met the refused open");
    assert.deepEqual(s.keptReasons, [{ name: "hd-hand-review-21034", reason: "cwd-unknown" }]);
    assert.equal(existsSync(t.entry), true);
  } finally {
    patch.mock.restore();
    syncBuiltinESMExports();
    t.cleanup();
  }
});

test("W1-T15026 an undecidable census keeps the tree as cwd-unknown when its canonical path cannot be resolved", () => {
  for (const code of ["EIO", "EACCES", "ELOOP", "ENOTDIR"]) {
    const t = tree("hd-hand-review-21035");
    const asked: string[] = [];
    try {
      const s = reap(t.root, 2 * HOUR, (dir) => { asked.push(dir); return { state: "clear", scanned: 1 }; }, {
        realpath: () => {
          throw Object.assign(new Error(`${code}: injected realpath`), { code });
        },
      });
      assert.deepEqual(s.keptReasons, [{ name: "hd-hand-review-21035", reason: "cwd-unknown" }], code);
      assert.deepEqual(asked, [], `${code}: a path with no canonical spelling is never censused`);
      assert.equal(existsSync(t.entry), true, code);
    } finally {
      t.cleanup();
    }
  }
});
