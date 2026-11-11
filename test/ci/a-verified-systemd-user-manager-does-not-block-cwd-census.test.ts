// @not-a-rule-suite: a process-cwd utility fixture, not a CI rule suite
// W1-T11659 — MEASURED on the Azure worker host: pid 1220, `/usr/lib/systemd/systemd --user`, uid 1000, PPID 1,
// made the census answer `unknown` (`cwd_unreadable ... uid=same walk=reached_init`) for the whole owner recovery.
// Only that exactly-identified manager is skipped; every other unreadable same-uid pid stays fail-closed.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeProcessCwdProbe,
  readBoundedProcessCwdCensus,
  type ProcessCwdCensusDeps,
  type UnreadableCwdDetail,
} from "#src/lib/process-cwd-census.js";

const OWNER = "/fleet/worktrees/fix-W1-T1-1";
const UID = 1000;
const MANAGER_ARGV = "/usr/lib/systemd/systemd\0--user\0";
const MANAGER_CGROUP = `0::/user.slice/user-${UID}.slice/user@${UID}.service/init.scope\n`;

interface FakeProc {
  cwd?: string;
  errno?: string;
  uid?: number;
  ppid?: number;
  cmdline?: string | "unreadable";
  cgroup?: string | "unreadable";
}

function denied(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function manager(over: Partial<FakeProc> = {}): FakeProc {
  return { errno: "EACCES", uid: UID, ppid: 1, cmdline: MANAGER_ARGV, cgroup: MANAGER_CGROUP, ...over };
}

function table(procs: Record<string, FakeProc>, seen: UnreadableCwdDetail[] = []): ProcessCwdCensusDeps {
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
      if (!p) throw denied("ENOENT");
      return [
        "Name:\tfake",
        ...(p.uid === undefined ? [] : [`Uid:\t${p.uid}\t${p.uid}\t${p.uid}\t${p.uid}`]),
        ...(p.ppid === undefined ? [] : [`PPid:\t${p.ppid}`]),
      ].join("\n");
    },
    readCmdline: (pid) => {
      const c = procs[pid]?.cmdline;
      if (c === undefined || c === "unreadable") throw denied("EACCES");
      return c;
    },
    readCgroup: (pid) => {
      const c = procs[pid]?.cgroup;
      if (c === undefined || c === "unreadable") throw denied("EACCES");
      return c;
    },
    ownUid: UID,
    clock: { now: () => 0 },
    onUnreadable: (d) => seen.push(d),
  };
}

test("a verified per-user systemd manager is skipped and the census reaches clear", () => {
  const census = readBoundedProcessCwdCensus(OWNER, table({ "1220": manager(), "40": { cwd: "/tmp" } }));
  assert.equal(census.state, "clear");
  assert.equal(census.skippedUserManagers, 1);
  assert.equal(describeProcessCwdProbe(census), "clear skipped_user_manager=1");
});

test("a same-uid child under the owner path stays occupied beside a skipped manager", () => {
  const census = readBoundedProcessCwdCensus(OWNER, table({
    "1220": manager(),
    "1300": { cwd: `${OWNER}/src`, uid: UID, ppid: 1220 },
  }));
  assert.equal(census.state, "occupied");
  assert.equal((census as { pid: number }).pid, 1300);
  assert.equal(census.skippedUserManagers, 1);
});

test("an unreadable cwd under a manager-shaped parent is still unknown", () => {
  const seen: UnreadableCwdDetail[] = [];
  const census = readBoundedProcessCwdCensus(OWNER, table({
    "1220": manager(),
    "1300": { errno: "EACCES", uid: UID, ppid: 1220 },
  }, seen));
  assert.equal(census.state, "unknown");
  assert.equal(seen[0]?.pid, 1300);
});

const NEAR_MATCHES: Array<[string, Partial<FakeProc>]> = [
  ["wrong ppid", { ppid: 2 }],
  ["wrong argv flag", { cmdline: "/usr/lib/systemd/systemd\0--system\0" }],
  ["wrong argv binary", { cmdline: "/usr/bin/systemd\0--user\0" }],
  ["extra argv", { cmdline: "/usr/lib/systemd/systemd\0--user\0--x\0" }],
  ["malformed argv", { cmdline: "/usr/lib/systemd/systemd --user" }],
  ["another uid's cgroup", { cgroup: "0::/user.slice/user-1001.slice/user@1001.service/init.scope\n" }],
  ["wrong cgroup leaf", { cgroup: `0::/user.slice/user-${UID}.slice/user@${UID}.service/app.slice\n` }],
  ["cgroup suffix", { cgroup: `0::/user.slice/user-${UID}.slice/user@${UID}.service/init.scope/x\n` }],
  ["cgroup v1 only", { cgroup: `1:name=systemd:/user.slice/user-${UID}.slice/user@${UID}.service/init.scope\n` }],
  ["ambiguous cgroup", { cgroup: `${MANAGER_CGROUP}0::/other\n` }],
  ["unreadable cmdline", { cmdline: "unreadable" }],
  ["unreadable cgroup", { cgroup: "unreadable" }],
  ["missing ppid", { ppid: undefined }],
];

for (const [name, over] of NEAR_MATCHES) {
  test(`a near-match manager (${name}) stays unknown`, () => {
    const census = readBoundedProcessCwdCensus(OWNER, table({ "1220": manager(over) }));
    assert.equal(census.state, "unknown");
    assert.equal(census.skippedUserManagers, undefined);
  });
}

test("a manager-shaped process on a foreign uid keeps its foreign skip", () => {
  const census = readBoundedProcessCwdCensus(OWNER, table({ "1220": manager({ uid: 0 }) }));
  assert.equal(census.state, "clear");
  assert.equal(census.skippedForeign, 1);
  assert.equal(census.skippedUserManagers, undefined);
});

test("a supplied process table with no identity readers never reads the real /proc", () => {
  const base = table({ "1220": manager() });
  const census = readBoundedProcessCwdCensus(OWNER, {
    readNextPid: base.readNextPid, readCwd: base.readCwd, readStatus: base.readStatus,
    ownUid: UID, clock: base.clock,
  });
  assert.equal(census.state, "unknown");
});
