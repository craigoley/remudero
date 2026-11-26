/**
 * W1-T15004 — A PROMOTED DAEMON RENAMES ITS PROCESS TITLE. A promoted standby kept its `daemon --standby` argv, so on
 * 2026-11-26 an operator read the live core daemon (host pid 2373165, container pid 2168466) as a stuck standby. On
 * promotion the title now names the active role, and daemon.standby_promoted carries the outermost pid beside its own.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { logPromoted, outermostPid, promotedDaemonTitle, standbyPorts, type StandbyOptions } from "#src/lib/daemon-standby.js";

const ARGV = ["/usr/local/bin/node", "--enable-source-maps", "/home/node/Remudero/state/daemon-slots/a/dist/child-entries/run-task.mjs",
  "daemon", "--standby", "--repo", "remudero", "--allow-self-target"];
const STATUS = "Name:\tnode\nNSpid:\t2373165\t2168466\nNSpgid:\t1\n";
const PARTS = { prepareMs: 15_000, waitMs: 240_000, lockWaitMs: 1_200, takeoverStartMs: 1_795_707_400_000 };

function promote(opts: StandbyOptions) {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const ports = standbyPorts({ stateDir: "/unused", runId: "DAEMON-1795707167649", sha: "cd17c32", pid: 2168466,
    log: (step, extra) => rows.push({ step, extra }) }, { clock: { now: () => 1_795_707_401_500, date: () => new Date(1_795_707_401_500), iso: () => "2026-11-26T15:36:41.500Z" }, ...opts });
  logPromoted(ports, PARTS);
  return rows;
}

test("W1-T15004 criterion 1: promotion renames the process title and records both pids", () => {
  const titles: string[] = [];
  const rows = promote({ argv: ARGV, setTitle: (title) => titles.push(title), readStatus: () => STATUS });
  assert.deepEqual(titles, ["rmd daemon active remudero DAEMON-1795707167649 slot-a"]);
  assert.equal(rows[0]?.extra?.pid, 2168466);
  assert.equal(rows[0]?.extra?.host_pid, 2373165);

  assert.equal(promotedDaemonTitle(["node", "run-task.mjs", "daemon", "--repo=wreckterra"], "DAEMON-2"),
    "rmd daemon active wreckterra DAEMON-2", "no slot tree, no slot suffix");
  assert.equal(outermostPid(undefined), null, "no procfs is null, never a guess");
  assert.equal(outermostPid("NSpid:\t41\n"), 41, "one namespace: the outermost pid is the pid");

  // The real defaults: process.title really changes, and /proc/self/status is really read on Linux.
  const saved = process.title;
  try {
    const real = promote({ argv: ARGV });
    assert.equal(process.title.startsWith("rmd daemon active remudero"), true, process.title);
    const hostPid = real[0]?.extra?.host_pid;
    assert.equal(process.platform === "linux" ? typeof hostPid === "number" : hostPid === null, true, String(hostPid));
  } finally {
    process.title = saved;
  }
});

test("W1-T15004 criterion 2: promotion behaves as before apart from the title and pid", () => {
  const before = { sha: "cd17c32", pid: 2168466, prepare_ms: 15_000, promote_wait_ms: 240_000, lock_wait_ms: 1_200,
    takeover_ms: 1_500 };
  const rows = promote({ argv: ARGV, setTitle: () => {}, readStatus: () => STATUS });
  assert.deepEqual(rows.map((row) => row.step), ["daemon.standby_promoted"]);
  const { host_pid: _hostPid, ...rest } = rows[0]!.extra!;
  assert.deepEqual(rest, before, "every field the row carried before is unchanged");

  // A platform that refuses the title still promotes and writes the same row.
  const refused = promote({ argv: ARGV, setTitle: () => { throw new Error("EPERM"); }, readStatus: () => STATUS });
  assert.deepEqual(refused, rows);
});
