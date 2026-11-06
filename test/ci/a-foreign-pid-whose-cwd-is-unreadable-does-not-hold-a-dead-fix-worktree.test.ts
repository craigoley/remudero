// W1-T10389 — the process-cwd census no longer answers `unknown` for a whole dead fix round on the first pid
// whose /proc/<pid>/cwd it may not read. MEASURED 2026-11-05 (core ledger): 22 `sweep.fix.checkout_claim_declined`
// rows (`process_cwd_probe_unreadable`, `cwd_unreadable`) on 9 PRs while review bwrap sandboxes, non-dumpable in a
// child user namespace on the daemon's own uid, were in flight. A foreign-uid pid is skipped; a same-uid pid is
// judged by its nearest readable ancestor's cwd; anything else still fails closed. The /proc reads are injected
// here (the Mac has no /proc); the one real pass runs only where /proc exists.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  describeProcessCwdProbe,
  readBoundedProcessCwdCensus,
  type ProcessCwdCensusDeps,
  type UnreadableCwdDetail,
} from "#src/lib/process-cwd-census.js";

const OWNER = "/fleet/worktrees/sweep-W1-T500-1";
const DAEMON_UID = 1000;
// Every injected test is synchronous and pure; its own bound is a generous multiple of the census wall bound.
const CENSUS_WALL_MS = 100;
const TEST_TIMEOUT_MS = CENSUS_WALL_MS * 50;

interface FakeProc {
  cwd?: string;
  errno?: string;
  uid?: number;
  ppid?: number;
  status?: "missing" | "unreadable";
}

function denied(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** A synthetic process table: the census sees only these pids, cwds and status texts. */
function table(procs: Record<string, FakeProc>, extra: Partial<ProcessCwdCensusDeps> = {}): ProcessCwdCensusDeps {
  const pending = Object.keys(procs);
  return {
    readNextPid: () => pending.shift() ?? null,
    readCwd: (pid) => {
      const p = procs[pid];
      if (!p) throw denied("ENOENT");
      if (p.errno) throw denied(p.errno);
      return p.cwd ?? "/";
    },
    readStatus: (pid) => {
      const p = procs[pid];
      if (!p || p.status === "missing") throw denied("ENOENT");
      if (p.status === "unreadable") throw denied("EACCES");
      return [
        "Name:\tfake",
        ...(p.uid === undefined ? [] : [`Uid:\t${p.uid}\t${p.uid}\t${p.uid}\t${p.uid}`]),
        ...(p.ppid === undefined ? [] : [`PPid:\t${p.ppid}`]),
      ].join("\n");
    },
    ownUid: DAEMON_UID,
    clock: { now: () => 0 },
    ...extra,
  };
}

test("W1-T10389 criterion 1: an unreadable cwd on another uid's pid is skipped, and the census reaches clear", { timeout: TEST_TIMEOUT_MS }, () => {
  const census = readBoundedProcessCwdCensus(OWNER, table({
    "1": { errno: "EACCES", uid: 0, ppid: 0 },
    "40": { cwd: "/tmp" },
    "41": { errno: "EPERM", uid: 65534, ppid: 1 },
  }));
  assert.deepEqual(census, { state: "clear", scanned: 3, skippedForeign: 2 });
  assert.equal(describeProcessCwdProbe(census), "clear skipped_foreign=2");

  // A foreign pid skipped on the way never hides a real owner further on.
  const occupied = readBoundedProcessCwdCensus(OWNER, table({
    "1": { errno: "EACCES", uid: 0, ppid: 0 },
    "50": { cwd: `${OWNER}/src` },
  }));
  assert.deepEqual(occupied, { state: "occupied", scanned: 2, pid: 50, skippedForeign: 1 });
});

test("W1-T10389 criterion 2: an unreadable cwd on the daemon's own uid, an unreadable uid, or another errno still keeps the worktree", { timeout: TEST_TIMEOUT_MS }, () => {
  const seen: UnreadableCwdDetail[] = [];
  const keep = (procs: Record<string, FakeProc>, extra: Partial<ProcessCwdCensusDeps> = {}) => {
    const census = readBoundedProcessCwdCensus(OWNER, table(procs, { onUnreadable: (d) => seen.push(d), ...extra }));
    assert.equal(census.state, "unknown", JSON.stringify(census));
    assert.equal(census.state === "unknown" ? census.reason : undefined, "cwd_unreadable");
    return census;
  };

  // Same uid, and the ancestor walk cannot go anywhere: its PPid is unreadable.
  const sameUid = keep({ "70": { errno: "EACCES", uid: DAEMON_UID } });
  assert.deepEqual(seen.at(-1), { pid: 70, errno: "EACCES", uid: "same", walk: "ppid_unreadable" });
  assert.equal(describeProcessCwdProbe(sameUid, seen.at(-1)), "cwd_unreadable pid=70 errno=EACCES uid=same walk=ppid_unreadable");

  // The uid itself is unreadable: status denied, or present without a Uid line.
  keep({ "71": { errno: "EACCES", status: "unreadable" } });
  assert.deepEqual(seen.at(-1), { pid: 71, errno: "EACCES", uid: "unreadable" });
  keep({ "72": { errno: "EPERM" } });
  assert.deepEqual(seen.at(-1), { pid: 72, errno: "EPERM", uid: "unreadable" });
  for (const errno of ["EACCES", "EPERM"]) {
    const missing = keep({ "73": { errno, status: "missing" } });
    assert.deepEqual(seen.at(-1), { pid: 73, errno, uid: "unreadable" });
    assert.equal(describeProcessCwdProbe(missing, seen.at(-1)), `cwd_unreadable pid=73 errno=${errno} uid=unreadable`);
  }

  // Any errno other than EACCES/EPERM/ENOENT fails closed as before, and the row names it.
  const io = keep({ "74": { errno: "EIO", uid: 0 } });
  assert.deepEqual(seen.at(-1), { pid: 74, errno: "EIO", uid: "foreign" });
  assert.equal(describeProcessCwdProbe(io, seen.at(-1)), "cwd_unreadable pid=74 errno=EIO uid=foreign");

  // A synthetic process table with no status reader never reads the real /proc: the W1-T2952 contract stands.
  const pending = ["10"];
  assert.deepEqual(
    readBoundedProcessCwdCensus(OWNER, {
      readNextPid: () => pending.shift() ?? null,
      readCwd: () => { throw denied("EACCES"); },
      clock: { now: () => 0 },
    }),
    { state: "unknown", scanned: 1, reason: "cwd_unreadable" },
  );
});

test("W1-T10389 criterion 1: a later unreadable uid retains the foreign skip count in the decline reason", () => {
  let detail: UnreadableCwdDetail | undefined;
  const census = readBoundedProcessCwdCensus(OWNER, table({
    "10": { errno: "EACCES", uid: 0 },
    "30": { errno: "EPERM", status: "unreadable" },
  }, { onUnreadable: (value) => { detail = value; } }));
  assert.deepEqual(census, { state: "unknown", scanned: 2, reason: "cwd_unreadable", skippedForeign: 1 });
  assert.equal(describeProcessCwdProbe(census, detail), "cwd_unreadable pid=30 errno=EPERM uid=unreadable skipped_foreign=1");
});

test("W1-T10389 criterion 3: a later decline retains attribution counts and the readable ancestor pid", () => {
  const procs = {
    "1": { errno: "EACCES", uid: 0 },
    "10": { errno: "EACCES", uid: DAEMON_UID, ppid: 20 },
    "20": { cwd: "/another/worktree" },
    "30": { errno: "EACCES", status: "unreadable" as const },
  };
  let detail: UnreadableCwdDetail | undefined;
  const census = readBoundedProcessCwdCensus(OWNER, table(procs, { onUnreadable: (value) => { detail = value; } }));
  assert.deepEqual(census, {
    state: "unknown", scanned: 4, reason: "cwd_unreadable", skippedForeign: 1, attributed: 1, attributedVia: [20],
  });
  assert.equal(describeProcessCwdProbe(census, detail),
    "cwd_unreadable pid=30 errno=EACCES uid=unreadable skipped_foreign=1 attributed=1 attributed_via=20");

  const bounded = readBoundedProcessCwdCensus(OWNER, table(procs, { maxEntries: 3 }));
  assert.deepEqual(bounded, {
    state: "unknown", scanned: 2, reason: "entry_bound", skippedForeign: 1, attributed: 1, attributedVia: [20],
  });
  assert.equal(describeProcessCwdProbe(bounded), "entry_bound skipped_foreign=1 attributed=1 attributed_via=20");

  let time = 0;
  const timed = table(procs, { clock: { now: () => time } });
  const readCwd = timed.readCwd!;
  timed.readCwd = (pid) => {
    const cwd = readCwd(pid);
    time = CENSUS_WALL_MS + 1;
    return cwd;
  };
  const wall = readBoundedProcessCwdCensus(OWNER, timed);
  assert.deepEqual(wall, {
    state: "unknown", scanned: 2, reason: "wall_bound", skippedForeign: 1, attributed: 1, attributedVia: [20],
  });
  assert.equal(describeProcessCwdProbe(wall), "wall_bound skipped_foreign=1 attributed=1 attributed_via=20");

  const pending = ["1", "10"];
  const unavailable = readBoundedProcessCwdCensus(OWNER, table(procs, {
    readNextPid: () => {
      if (pending.length) return pending.shift()!;
      throw denied("EIO");
    },
  }));
  assert.deepEqual(unavailable, {
    state: "unknown", scanned: 2, reason: "proc_unavailable", skippedForeign: 1, attributed: 1, attributedVia: [20],
  });
  assert.equal(describeProcessCwdProbe(unavailable), "proc_unavailable skipped_foreign=1 attributed=1 attributed_via=20");
});

test("W1-T10389 criterion 3: an unreadable cwd on a same-uid sandboxed pid is decided by its nearest readable ancestor's cwd", { timeout: TEST_TIMEOUT_MS }, () => {
  // bwrap (200, non-dumpable) -> sandboxed node (300, non-dumpable) under their launcher (900, readable), all the
  // daemon's uid. The census meets the sandboxed pids before the launcher, as /proc order may.
  const sandbox = (launcherCwd: string): Record<string, FakeProc> => ({
    "200": { errno: "EACCES", uid: DAEMON_UID, ppid: 900 },
    "300": { errno: "EACCES", uid: DAEMON_UID, ppid: 200 },
    "900": { cwd: launcherCwd, uid: DAEMON_UID, ppid: 1 },
  });

  // A review sandbox working in another worktree is attributed to it and does not hold this owner.
  const elsewhere = readBoundedProcessCwdCensus(OWNER, table(sandbox("/fleet/worktrees/review-PR16523-1")));
  assert.deepEqual(elsewhere, { state: "clear", scanned: 3, attributed: 2, attributedVia: [900, 900] });
  assert.equal(describeProcessCwdProbe(elsewhere), "clear attributed=2 attributed_via=900,900");

  // A sandbox whose launcher works inside the owner's worktree is a live owner: occupied, naming the ancestor.
  const inside = readBoundedProcessCwdCensus(OWNER, table(sandbox(`${OWNER}/test`)));
  assert.deepEqual(inside, { state: "occupied", scanned: 1, pid: 200, via: 900, attributed: 1, attributedVia: [900] });
  assert.equal(describeProcessCwdProbe(inside), "attributed pid=200 via=900 attributed=1 attributed_via=900");

  // The walk fails closed: a cycle, reaching init with no readable cwd, or an ancestor that exited mid-walk.
  const seen: UnreadableCwdDetail[] = [];
  const onUnreadable = (d: UnreadableCwdDetail) => seen.push(d);
  const cycle = readBoundedProcessCwdCensus(OWNER, table({
    "500": { errno: "EACCES", uid: DAEMON_UID, ppid: 501 },
    "501": { errno: "EACCES", uid: DAEMON_UID, ppid: 500 },
  }, { onUnreadable }));
  assert.equal(cycle.state, "unknown");
  assert.equal(seen.at(-1)?.walk, "cycle");
  const init = readBoundedProcessCwdCensus(OWNER, table({
    "1": { errno: "EACCES", uid: 0, ppid: 0 },
    "600": { errno: "EACCES", uid: DAEMON_UID, ppid: 1 },
  }, { onUnreadable }));
  assert.equal(init.state, "unknown");
  assert.equal(seen.at(-1)?.walk, "reached_init");
  const exited = readBoundedProcessCwdCensus(OWNER, table({
    "700": { errno: "EACCES", uid: DAEMON_UID, ppid: 701 },
  }, { onUnreadable }));
  assert.equal(exited.state, "unknown");
  assert.equal(seen.at(-1)?.walk, "ancestor_exited");

  // The ancestor reads count against the census's existing entry bound: no new bound. Three pids alone would fit
  // in three entries; the walk's ancestor reads spend them first.
  assert.deepEqual(
    readBoundedProcessCwdCensus(OWNER, table(sandbox("/elsewhere"), { maxEntries: 3 })),
    { state: "unknown", scanned: 2, reason: "entry_bound", attributed: 1, attributedVia: [900] },
  );
});

test("W1-T10389: a real /proc census finds a live child working in the owner's worktree", { timeout: CENSUS_WALL_MS * 300 }, async (t) => {
  if (!existsSync("/proc/self/status")) {
    t.skip("no /proc on this host (macOS); CI's Linux runner is the first real pass");
    return;
  }
  const owner = mkdtempSync(join(tmpdir(), "rmd-w1t10389-owner-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { cwd: owner, stdio: "ignore" });
  t.after(async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    rmSync(owner, { recursive: true, force: true });
  });
  await once(child, "spawn");
  assert.ok(child.pid);
  // Only enumerate the child we own: unrelated host pids may legitimately make a census unknown.
  // The default cwd reader still reads the live child's actual /proc/<pid>/cwd in both passes.
  const censusFor = (path: string) => {
    const pids = [String(child.pid)];
    return readBoundedProcessCwdCensus(path, { readNextPid: () => pids.shift() ?? null });
  };
  assert.deepEqual(censusFor(owner), { state: "occupied", scanned: 1, pid: child.pid });
  assert.deepEqual(censusFor(join(owner, "unowned")), { state: "clear", scanned: 1 });
});
