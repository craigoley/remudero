/**
 * deploy/rmd-session-reaper.sh, run as the REAL script against a fixture host: a fake /proc tree, a
 * fake logind session directory, and fake loginctl/systemctl/journalctl/kill commands that record
 * every call. Nothing here can signal a real process or restart a real logind.
 *
 * The incident (2026-10-20, Azure host): logind lost its subscription to PID 1 and stopped
 * finalising sessions, leaving 3,073 `closing` sessions with no scope; processes leaked from long
 * closed sessions sat re-parented to PID 1. Each rule is held from both sides, so deleting it from
 * the script turns a KEEP into a STOP (or a restart into none) and fails here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "deploy/rmd-session-reaper.sh");
const HOUR = 3600;
const T0 = 1_792_700_000;
const LIVE_SCOPE = "session-200.scope";

interface Proc {
  pid: number;
  ppid: number;
  cgroup: string; // a bare `session-N.scope` is placed under user-1000.slice
  comm: string;
  exe: string;
  cwd: string;
  ticks?: number;
  start?: number;
  /** se.exec_start (ms) per thread; omitted = no scheduler record */
  lastRanMs?: number[];
  holds?: string[]; // ref fifos this process holds open, by session id
  fds?: Record<number, string>; // other open fds, by number: the link target /proc shows
}

interface Fx {
  root: string;
  proc: string;
  sessions: string;
  state: string;
  calls: string;
}

const fake = (body: string) => `#!/usr/bin/env bash\nfx="$(cd "$(dirname "$0")/.." && pwd)"\n[ -t 0 ] || cat >/dev/null\n${body}\n`;

function fixture(t: { after: (fn: () => void) => void }): Fx {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-session-reaper-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fx = { root, proc: join(root, "proc"), sessions: join(root, "sessions"), state: join(root, "state"), calls: join(root, "calls.log") };
  for (const d of [fx.proc, fx.sessions, join(root, "bin")]) mkdirSync(d, { recursive: true });
  // The fakes drain stdin, so a reaper that lets a probe read its stdin loses its own script on `bash -s`.
  writeFileSync(join(root, "bin", "loginctl"), fake(String.raw`
table="$fx/sessions.tsv"
if [ -e "$fx/restarted" ] && [ -e "$fx/sessions-after.tsv" ]; then table="$fx/sessions-after.tsv"; fi
touch "$table"
cmd="$1"; shift
case "$cmd" in
  list-sessions) while read -r id state scope leader; do [ -n "$id" ] && printf '%s 1000 craigoleyagent - - %s no -\n' "$id" "$state"; done < "$table" ;;
  show-session)
    props=""; ids=""
    while [ $# -gt 0 ]; do case "$1" in -p) props="$props $2"; shift 2 ;; *) ids="$ids $1"; shift ;; esac; done
    first=1
    for id in $ids; do
      row="$(awk -v i="$id" '$1 == i' "$table")"
      if [ -z "$row" ]; then echo "Failed to get path for session '$id': No session '$id' known" >&2; exit 1; fi
      set -- $row
      [ "$first" = 1 ] || echo
      first=0
      scope="$3"; [ "$scope" = "-" ] && scope=""
      for p in Id Scope Leader State; do
        case " $props " in *" $p "*) ;; *) continue ;; esac
        case "$p" in Id) v="$1" ;; Scope) v="$scope" ;; Leader) v="$4" ;; State) v="$2" ;; esac
        printf '%s=%s\n' "$p" "$v"
      done
    done ;;
esac`), { mode: 0o755 });
  writeFileSync(join(root, "bin", "systemctl"), fake(String.raw`
cmd="$1"; shift
case "$cmd" in
  show)
    units=""
    while [ $# -gt 0 ]; do case "$1" in -p) shift 2 ;; *) units="$units $1"; shift ;; esac; done
    first=1
    for u in $units; do
      row="$(awk -v u="$u" '$1 == u' "$fx/scopes.tsv" 2>/dev/null)"
      if [ -n "$row" ]; then set -- $row; load="$2"; act="$3"; tasks="$4"; else load=not-found; act=inactive; tasks=unset; fi
      [ "$tasks" = unset ] && tasks="[not set]"
      [ "$first" = 1 ] || echo
      first=0
      printf 'TasksCurrent=%s\nId=%s\nLoadState=%s\nActiveState=%s\n' "$tasks" "$u" "$load" "$act"
    done ;;
  restart) echo "restart $1" >> "$fx/calls.log"; touch "$fx/restarted"; [ -e "$fx/restart-fails" ] && exit 1; exit 0 ;;
  is-active) if [ -e "$fx/logind-stays-down" ]; then echo failed; exit 3; fi; echo active ;;
esac`), { mode: 0o755 });
  writeFileSync(join(root, "bin", "journalctl"), fake(`[ -e "$fx/journal.txt" ] && cat "$fx/journal.txt"; exit 0`), { mode: 0o755 });
  writeFileSync(join(root, "bin", "kill"), fake(String.raw`
sig="$1"; pid="$2"; echo "$sig $pid" | sed "s/^-//" >> "$fx/calls.log"
case "$sig" in
  -TERM) grep -qx "$pid" "$fx/ignores-term" 2>/dev/null || rm -rf "$fx/proc/$pid" ;;
  -KILL) grep -qx "$pid" "$fx/survives-kill" 2>/dev/null || rm -rf "$fx/proc/$pid" ;;
esac`), { mode: 0o755 });
  return fx;
}

function sessions(fx: Fx, rows: string[], file = "sessions.tsv") {
  writeFileSync(join(fx.root, file), rows.map((r) => r + "\n").join(""));
}

function scopes(fx: Fx, rows: string[]) {
  writeFileSync(join(fx.root, "scopes.tsv"), rows.map((r) => r + "\n").join(""));
}

function proc(fx: Fx, p: Proc) {
  const d = join(fx.proc, String(p.pid));
  rmSync(d, { recursive: true, force: true });
  mkdirSync(join(d, "fd"), { recursive: true });
  const ticks = p.ticks ?? 0;
  const start = p.start ?? 1000 + p.pid;
  writeFileSync(join(d, "stat"), `${p.pid} (${p.comm}) S ${p.ppid} ${p.pid} ${p.pid} 0 -1 4194560 0 0 0 0 ${ticks} 0 0 0 20 0 1 0 ${start} 1000 100\n`);
  writeFileSync(join(d, "comm"), `${p.comm}\n`);
  const cg = p.cgroup.includes("/") ? p.cgroup : `/user.slice/user-1000.slice/${p.cgroup}`;
  writeFileSync(join(d, "cgroup"), `0::${cg}\n`);
  writeFileSync(join(d, "cmdline"), "node\0--token=SECRET-CMDLINE\0");
  writeFileSync(join(d, "environ"), "GH_TOKEN=SECRET-ENV\0");
  symlinkSync(p.exe, join(d, "exe"));
  symlinkSync(p.cwd, join(d, "cwd"));
  (p.holds ?? []).forEach((sid, i) => {
    writeFileSync(join(fx.sessions, `${sid}.ref`), "");
    symlinkSync(join(fx.sessions, `${sid}.ref`), join(d, "fd", String(10 + i)));
  });
  for (const [fd, target] of Object.entries(p.fds ?? {})) symlinkSync(target, join(d, "fd", fd));
  (p.lastRanMs ?? []).forEach((ms, i) => {
    mkdirSync(join(d, "task", String(p.pid + i)), { recursive: true });
    writeFileSync(join(d, "task", String(p.pid + i), "sched"), `${p.comm} (${p.pid}, #threads: 1)\n---\nse.exec_start                                :    ${ms}.838795\nse.vruntime : 1.0\n`);
  });
}

/** "now" in the scheduler clock, as the reading process's own /proc/self/sched would say. */
function schedNow(fx: Fx, ms: number) {
  mkdirSync(join(fx.proc, "self"), { recursive: true });
  writeFileSync(join(fx.proc, "self", "sched"), `awk (1, #threads: 1)\n---\nse.exec_start                                :    ${ms}.000001\n`);
}

/** The live session every fixture has: sshd leader 700 holds its ref fifo; logind holds every fifo. */
function liveHost(fx: Fx, extraRefs: string[] = []) {
  proc(fx, { pid: 700, ppid: 650, cgroup: LIVE_SCOPE, comm: "sshd-session", exe: "/usr/sbin/sshd", cwd: "/", holds: ["200"] });
  proc(fx, { pid: 650, ppid: 1, cgroup: "/system.slice/ssh.service", comm: "sshd", exe: "/usr/sbin/sshd", cwd: "/" });
  proc(fx, { pid: 543, ppid: 1, cgroup: "/system.slice/systemd-logind.service", comm: "systemd-logind", exe: "/usr/lib/systemd/systemd-logind", cwd: "/", holds: ["200", ...extraRefs] });
  scopes(fx, [`${LIVE_SCOPE} loaded active 3`]);
}

function run(fx: Fx, env: Record<string, string> = {}, viaStdin = false) {
  const vars = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    RMD_REAPER_UID: "0",
    RMD_REAPER_NOW: String(T0),
    RMD_REAPER_TERM_GRACE_S: "0",
    RMD_REAPER_PROC: fx.proc,
    RMD_REAPER_SESSIONS_DIR: fx.sessions,
    RMD_REAPER_STATE_DIR: fx.state,
    RMD_REAPER_LOGINCTL: join(fx.root, "bin", "loginctl"),
    RMD_REAPER_SYSTEMCTL: join(fx.root, "bin", "systemctl"),
    RMD_REAPER_JOURNALCTL: join(fx.root, "bin", "journalctl"),
    RMD_REAPER_KILL: join(fx.root, "bin", "kill"),
    ...env,
  };
  const r = viaStdin
    ? spawnSync("bash", ["-s"], { input: readFileSync(SCRIPT), cwd: fx.root, encoding: "utf8", env: vars })
    : spawnSync("bash", [SCRIPT], { encoding: "utf8", env: vars, stdio: ["ignore", "pipe", "pipe"] });
  const out = `${r.stdout}${r.stderr}`;
  return { status: r.status, out };
}

const calls = (fx: Fx) => (existsSync(fx.calls) ? readFileSync(fx.calls, "utf8").trim().split("\n").filter(Boolean) : []);

test("session reaper: a proven orphan session triggers exactly one logind restart and the session count drops", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["101 closing session-101.scope 5001", "102 closing session-102.scope 5002", "200 active session-200.scope 700"]);
  sessions(fx, ["200 active session-200.scope 700"], "sessions-after.tsv");
  const r = run(fx);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /ORPHAN session 101: closing, session-101\.scope not-found\/inactive, no process in its cgroup, ref fifo unheld/);
  assert.match(r.out, /ORPHAN session 102: /);
  assert.deepEqual(calls(fx), ["restart systemd-logind.service"], "two orphans, ONE restart");
  assert.match(r.out, /RESTART systemd-logind\.service: 2 proven orphan session\(s\); sessions 3 -> 1/);
  assert.match(r.out, /rmd-session-reaper: sessions 3 \(closing 2, orphans 2\); logind restarted \(3 -> 1\); processes stopped 0, kept 1/);
});

test("session reaper: every orphan across several probe batches is proven, none lost at a batch boundary", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  const ids = Array.from({ length: 600 }, (_, i) => 85363 + i); // the probes are asked 256 at a time
  sessions(fx, [...ids.map((id) => `${id} closing session-${id}.scope ${id + 100000}`), "200 active session-200.scope 700"]);
  sessions(fx, ["200 active session-200.scope 700"], "sessions-after.tsv");
  const r = run(fx);
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /did not report/);
  assert.equal(r.out.split("\n").filter((l) => l.startsWith("ORPHAN session ")).length, 600);
  assert.match(r.out, /sessions 601 \(closing 600, orphans 600\); logind restarted \(601 -> 1\)/);
  assert.deepEqual(calls(fx), ["restart systemd-logind.service"]);
});

test("session reaper: a closing session whose scope still has tasks restarts nothing", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["103 closing session-103.scope 5003", "200 active session-200.scope 700"]);
  scopes(fx, [`${LIVE_SCOPE} loaded active 3`, "session-103.scope loaded active 2"]);
  const r = run(fx);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /KEEP session 103: closing, but session-103\.scope is loaded\/active with 2 tasks/);
  assert.doesNotMatch(r.out, /ORPHAN/);
  assert.deepEqual(calls(fx), [], "no restart for a scope that still has tasks");
});

test("session reaper: a closing session systemd forgot but whose cgroup still holds a process is kept", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["104 closing session-104.scope 5004", "200 active session-200.scope 700"]);
  // systemd reports the scope not-found, yet /proc shows a busy process in its cgroup: /proc wins
  proc(fx, { pid: 910, ppid: 1, cgroup: "session-104.scope", comm: "sleep", exe: "/usr/bin/sleep", cwd: "/home/u" });
  const r = run(fx);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /KEEP session 104: closing, session-104\.scope is not-found, but 1 process\(es\) are still in its cgroup/);
  assert.deepEqual(calls(fx), []);
});

test("session reaper: a closing session whose ref fifo a process other than logind holds restarts nothing", (t) => {
  const held = fixture(t);
  liveHost(held, ["105"]);
  sessions(held, ["105 closing session-105.scope 5005", "200 active session-200.scope 700"]);
  proc(held, { pid: 800, ppid: 650, cgroup: LIVE_SCOPE, comm: "sshd-session", exe: "/usr/sbin/sshd", cwd: "/", holds: ["105"] });
  const r = run(held);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /KEEP session 105: closing, but its ref fifo is held by sshd-session\(800\)/);
  assert.deepEqual(calls(held), [], "a held ref fifo is a live session");

  // Positive control: logind's own hold on the same fifo proves nothing, so the session is an orphan.
  const logindOnly = fixture(t);
  liveHost(logindOnly, ["105"]);
  sessions(logindOnly, ["105 closing session-105.scope 5005", "200 active session-200.scope 700"]);
  sessions(logindOnly, ["200 active session-200.scope 700"], "sessions-after.tsv");
  const c = run(logindOnly);
  assert.equal(c.status, 0, c.out);
  assert.match(c.out, /ORPHAN session 105: /);
  assert.deepEqual(calls(logindOnly), ["restart systemd-logind.service"]);
});

test("session reaper: a leaked process with a deleted cwd under a re-parented root is stopped with SIGTERM, then SIGKILL", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["200 active session-200.scope 700"]); // session 77679 is gone from logind
  proc(fx, { pid: 613359, ppid: 1, cgroup: "session-77679.scope", comm: "MainThread", exe: "/usr/bin/node", cwd: "/mnt/scratch/api-1/t-2/rmd-reader-runtime-a (deleted)", ticks: 22694 });
  proc(fx, { pid: 613400, ppid: 613359, cgroup: "session-77679.scope", comm: "node", exe: "/usr/bin/node", cwd: "/tmp/rmd-reader-runtime-b (deleted)", ticks: 9 });
  writeFileSync(join(fx.root, "ignores-term"), "613400\n");
  const r = run(fx);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /STOP pid=613359 comm=MainThread exe=\/usr\/bin\/node scope=session-77679\.scope: session 77679 is unknown to logind, re-parented to PID 1, cwd deleted/);
  assert.match(r.out, /STOP pid=613400 comm=node .*descends from re-parented pid 613359, cwd deleted/);
  assert.deepEqual(calls(fx), ["TERM 613359", "TERM 613400", "KILL 613400"], "TERM both, KILL only the one that ignored it");
  assert.equal(existsSync(join(fx.proc, "613359")), false);
  assert.equal(existsSync(join(fx.proc, "613400")), false);
  assert.doesNotMatch(r.out, /SECRET/, "cmdline and environment are never logged");
  assert.match(r.out, /processes stopped 2, kept 1/);
});

test("session reaper: a leaked process with no CPU across a six-hour observation is stopped, and one seen for less or that used CPU is kept", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["200 active session-200.scope 700"]); // session 63047 is gone from logind
  const pipeline = (dockerTicks: number) => {
    proc(fx, { pid: 453564, ppid: 1, cgroup: "session-63047.scope", comm: "bash", exe: "/usr/bin/bash", cwd: "/home/u", ticks: 0, start: 231434062 });
    proc(fx, { pid: 453625, ppid: 453564, cgroup: "session-63047.scope", comm: "docker", exe: "/usr/bin/docker", cwd: "/home/u", ticks: dockerTicks, start: 231434073 });
    // tail's output reaches nobody, but its root is not stopped yet, so that alone never stops it
    proc(fx, { pid: 453626, ppid: 453564, cgroup: "session-63047.scope", comm: "tail", exe: "/usr/bin/tail", cwd: "/home/u", ticks: 189, start: 231434073, fds: { 1: "pipe:[1048010155]" } });
  };
  pipeline(18189);
  const first = run(fx);
  assert.equal(first.status, 0, first.out);
  assert.match(first.out, /KEEP pid=453564 comm=bash .*re-parented to PID 1, first observation \(window 6h\)/);
  assert.equal(readFileSync(join(fx.state, "observations"), "utf8").trim().split("\n").length, 3);

  pipeline(18190); // docker used CPU; bash and tail did not
  const early = run(fx, { RMD_REAPER_NOW: String(T0 + 6 * HOUR - 60) });
  assert.equal(early.status, 0, early.out);
  assert.match(early.out, /KEEP pid=453564 comm=bash .*no CPU since an observation 5h 59m ago/);
  assert.match(early.out, /KEEP pid=453625 comm=docker .*used CPU since the last observation/);
  assert.deepEqual(calls(fx), [], "under six hours nothing is stopped");

  const late = run(fx, { RMD_REAPER_NOW: String(T0 + 6 * HOUR) });
  assert.equal(late.status, 0, late.out);
  assert.match(late.out, /STOP pid=453564 comm=bash .*no CPU for 6h 0m \(window 6h\)/);
  assert.match(late.out, /STOP pid=453626 comm=tail .*descends from re-parented pid 453564, no CPU for 6h 0m/);
  assert.match(late.out, /KEEP pid=453625 comm=docker .*no CPU since an observation 1m ago/);
  assert.deepEqual(calls(fx), ["TERM 453564", "TERM 453626"]);
});

test("session reaper: the kernel's last-on-CPU record stops a process idle six hours on the first pass", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["200 active session-200.scope 700"]);
  const now = 3_249_468_570;
  schedNow(fx, now);
  proc(fx, { pid: 453564, ppid: 1, cgroup: "session-63047.scope", comm: "bash", exe: "/usr/bin/bash", cwd: "/home/u", ticks: 0, lastRanMs: [2_314_355_599] });
  // docker: one of its threads ran 337 ms ago, so the whole process is busy
  proc(fx, { pid: 453625, ppid: 453564, cgroup: "session-63047.scope", comm: "docker", exe: "/usr/bin/docker", cwd: "/home/u", ticks: 18189, lastRanMs: [now - 40 * HOUR * 1000, now - 337] });
  proc(fx, { pid: 453626, ppid: 453564, cgroup: "session-63047.scope", comm: "tail", exe: "/usr/bin/tail", cwd: "/home/u", ticks: 189, lastRanMs: [now - 6 * HOUR * 1000 + 1000] });
  const r = run(fx);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /STOP pid=453564 comm=bash .*not on a CPU for 10d 19h by the kernel's scheduler record \(window 6h\)/);
  assert.match(r.out, /KEEP pid=453625 comm=docker .*first observation, last on a CPU 0m ago/);
  assert.match(r.out, /KEEP pid=453626 comm=tail .*last on a CPU 5h 59m ago/);
  assert.deepEqual(calls(fx), ["TERM 453564"]);
});

/** The measured 2026-10-23 shape: an idle bash re-parented to PID 1 in a gone session, with a busy
 *  `docker logs -f` piping into `tail`, whose stdout is the same pipe as bash's and read by no one. */
function loggerPipeline(fx: Fx) {
  const now = 3_249_468_570;
  schedNow(fx, now);
  const scope = "session-63047.scope";
  proc(fx, { pid: 453564, ppid: 1, cgroup: scope, comm: "bash", exe: "/usr/bin/bash", cwd: "/home/u", lastRanMs: [2_314_355_599], fds: { 1: "pipe:[1048010155]" } });
  proc(fx, { pid: 453625, ppid: 453564, cgroup: scope, comm: "docker", exe: "/usr/bin/docker", cwd: "/home/u", ticks: 18189, lastRanMs: [now - 337], fds: { 1: "pipe:[1048010200]" } });
  proc(fx, { pid: 453626, ppid: 453564, cgroup: scope, comm: "tail", exe: "/usr/bin/tail", cwd: "/home/u", ticks: 189, lastRanMs: [now - 337], fds: { 0: "pipe:[1048010200]", 1: "pipe:[1048010155]" } });
  return { now, scope };
}

test("session reaper: a busy pipeline under a stopped re-parented root follows it when its output reaches nobody outside the subtree", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["200 active session-200.scope 700"]);
  const { now, scope } = loggerPipeline(fx);
  proc(fx, { pid: 453630, ppid: 453564, cgroup: scope, comm: "sleep", exe: "/usr/bin/sleep", cwd: "/home/u", lastRanMs: [now - 5], fds: { 1: "/home/u/watch.log (deleted)" } });
  proc(fx, { pid: 453631, ppid: 453564, cgroup: scope, comm: "watch", exe: "/usr/bin/watch", cwd: "/home/u", lastRanMs: [now - 5], fds: { 1: "/dev/pts/987654" } });
  const r = run(fx);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /STOP pid=453564 comm=bash .*not on a CPU for 10d 19h/);
  assert.match(r.out, /STOP pid=453625 comm=docker .*descends from re-parented pid 453564, its stdout pipe:\[1048010200\] has no holder outside the subtree of stopped pid 453564/);
  assert.match(r.out, /STOP pid=453626 comm=tail .*its stdout pipe:\[1048010155\] has no holder outside the subtree of stopped pid 453564/);
  assert.match(r.out, /STOP pid=453630 .*its stdout is a deleted file/);
  assert.match(r.out, /STOP pid=453631 .*its stdout tty \/dev\/pts\/987654 no longer exists/);
  assert.deepEqual(calls(fx), ["TERM 453564", "TERM 453625", "TERM 453626", "TERM 453630", "TERM 453631"]);
});

test("session reaper: a descendant whose output an outside process reads, or that writes to an existing file, is kept when its root stops", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["200 active session-200.scope 700"]);
  const { now, scope } = loggerPipeline(fx);
  // an operator's shell in the live session reads the pipeline's output
  proc(fx, { pid: 960, ppid: 700, cgroup: LIVE_SCOPE, comm: "bash", exe: "/usr/bin/bash", cwd: "/home/u", fds: { 0: "pipe:[1048010155]" } });
  const log = join(fx.root, "watcher.out");
  writeFileSync(log, "");
  proc(fx, { pid: 453632, ppid: 453564, cgroup: scope, comm: "node", exe: "/usr/bin/node", cwd: "/home/u", lastRanMs: [now - 5], fds: { 1: log } });
  const r = run(fx);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /KEEP pid=453626 comm=tail .*its root 453564 stops, but its stdout pipe:\[1048010155\] is held by pid 960 outside the subtree/);
  assert.match(r.out, new RegExp(`KEEP pid=453632 comm=node .*its root 453564 stops, but its stdout is ${log}`));
  assert.deepEqual(calls(fx), ["TERM 453564", "TERM 453625"], "docker's own pipe still reaches only tail, inside the subtree");
});

test("session reaper: a process in a live session is kept even with a deleted cwd and PID 1 as its parent", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["200 active session-200.scope 700", "201 active session-201.scope 7777"]);
  proc(fx, { pid: 900, ppid: 1, cgroup: LIVE_SCOPE, comm: "node", exe: "/usr/bin/node", cwd: "/tmp/gone (deleted)" });
  // Positive control: session 201 says active, but its leader 7777 is dead, so its leak is stopped.
  proc(fx, { pid: 901, ppid: 1, cgroup: "session-201.scope", comm: "node", exe: "/usr/bin/node", cwd: "/tmp/gone (deleted)" });
  const r = run(fx);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /KEEP pid=900 comm=node exe=\/usr\/bin\/node scope=session-200\.scope: session 200 is active with leader 700 alive/);
  assert.match(r.out, /STOP pid=901 .*session 201 leader 7777 is dead, re-parented to PID 1, cwd deleted/);
  assert.deepEqual(calls(fx), ["TERM 901"]);
});

test("session reaper: processes outside session scopes are never read, whatever their cwd", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["200 active session-200.scope 700"]);
  const outside = [
    [920, "/user.slice/user-1000.slice/run-r3f9a.scope"],
    [921, "/system.slice/docker-0123abcd.scope"],
    [922, "/user.slice/user-1000.slice/user@1000.service/app.slice/x.service"],
    [923, "/system.slice/cron.service"],
  ] as const;
  for (const [pid, cgroup] of outside) proc(fx, { pid, ppid: 1, cgroup, comm: "node", exe: "/usr/bin/node", cwd: "/tmp/gone (deleted)" });
  const r = run(fx);
  assert.equal(r.status, 0, r.out);
  for (const [pid] of outside) assert.doesNotMatch(r.out, new RegExp(`pid=${pid} `), `pid ${pid} is outside every session scope`);
  assert.deepEqual(calls(fx), []);
  assert.match(r.out, /processes stopped 0, kept 1/, "only the live sshd leader was looked at");
});

test("session reaper: sshd, systemd and logind are kept even in a closed session", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["200 active session-200.scope 700"]);
  const kept = [
    [930, "sshd-session", "/usr/sbin/sshd"],
    [931, "systemd", "/usr/lib/systemd/systemd"],
    [932, "(sd-pam)", "/usr/lib/systemd/systemd"],
    [933, "systemd-logind", "/usr/lib/systemd/systemd-logind"],
    [934, "MainThread", "/usr/sbin/sshd"], // caught by its exe alone
    [935, "sshd", "/opt/vendor/bin/daemon"], // caught by its comm alone
  ] as const;
  for (const [pid, comm, exe] of kept) proc(fx, { pid, ppid: 1, cgroup: "session-300.scope", comm, exe, cwd: "/tmp/gone (deleted)" });
  const r = run(fx);
  assert.equal(r.status, 0, r.out);
  for (const [pid] of kept) assert.match(r.out, new RegExp(`KEEP pid=${pid} .* is never stopped`));
  assert.deepEqual(calls(fx), []);
});

test("session reaper: a detached terminal multiplexer and everything under it are kept in a closed session", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["200 active session-200.scope 700", "310 closing session-310.scope 6100"]);
  scopes(fx, [`${LIVE_SCOPE} loaded active 3`, "session-310.scope loaded active 2"]);
  proc(fx, { pid: 940, ppid: 1, cgroup: "session-310.scope", comm: "tmux: server", exe: "/usr/bin/tmux", cwd: "/home/u" });
  proc(fx, { pid: 941, ppid: 940, cgroup: "session-310.scope", comm: "bash", exe: "/usr/bin/bash", cwd: "/home/u/old-worktree (deleted)" });
  const r = run(fx);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /KEEP pid=940 comm=tmux:_server .*under terminal multiplexer tmux:_server\(940\)/);
  assert.match(r.out, /KEEP pid=941 comm=bash .*under terminal multiplexer tmux:_server\(940\)/);
  assert.deepEqual(calls(fx), []);
});

test("session reaper: a process whose chain does not reach a re-parented root is kept", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["200 active session-200.scope 700"]);
  // its parent lives outside the scope and is not PID 1
  proc(fx, { pid: 949, ppid: 1, cgroup: "/system.slice/some.service", comm: "agent", exe: "/usr/bin/agent", cwd: "/" });
  proc(fx, { pid: 950, ppid: 949, cgroup: "session-301.scope", comm: "node", exe: "/usr/bin/node", cwd: "/tmp/gone (deleted)" });
  const r = run(fx);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /KEEP pid=950 .*its chain in session-301\.scope does not reach a process re-parented to PID 1/);
  assert.deepEqual(calls(fx), []);
});

test("session reaper: DRY_RUN logs every stop and the restart but signals, restarts and writes nothing", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["101 closing session-101.scope 5001", "200 active session-200.scope 700"]);
  proc(fx, { pid: 613359, ppid: 1, cgroup: "session-77679.scope", comm: "MainThread", exe: "/usr/bin/node", cwd: "/tmp/rmd-reader-runtime-a (deleted)" });
  const r = run(fx, { DRY_RUN: "1" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /STOP pid=613359 .*cwd deleted \(dry run: not signalled\)/);
  assert.match(r.out, /RESTART systemd-logind\.service: 1 proven orphan session\(s\) \(dry run: not restarted\)/);
  assert.match(r.out, /rmd-session-reaper: sessions 2 \(closing 1, orphans 1\); logind restart skipped \(dry run\); processes stopped 1, kept 1/);
  assert.deepEqual(calls(fx), [], "no signal and no restart");
  assert.equal(existsSync(join(fx.proc, "613359")), true);
  assert.equal(existsSync(fx.state), false, "no state directory, no lock, no observations");
});

test("session reaper: a dry run fed on stdin with no repo files reaches its summary line", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["101 closing session-101.scope 5001", "102 closing session-102.scope 5002", "200 active session-200.scope 700"]);
  proc(fx, { pid: 613359, ppid: 1, cgroup: "session-77679.scope", comm: "MainThread", exe: "/usr/bin/node", cwd: "/tmp/rmd-reader-runtime-a (deleted)" });
  proc(fx, { pid: 453564, ppid: 1, cgroup: "session-63047.scope", comm: "bash", exe: "/usr/bin/bash", cwd: "/home/u" });
  writeFileSync(join(fx.root, "journal.txt"), `${T0 - 3 * 86400}.804042 host systemd-logind[543]: Removed session 86021.\n`);
  const r = run(fx, { DRY_RUN: "1" }, true);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /STOP pid=613359 /);
  assert.match(r.out, /rmd-session-reaper: sessions 3 \(closing 2, orphans 2\); logind restart skipped \(dry run\); processes stopped 1, kept 2; last Removed session 3d 0h ago$/m);
  assert.deepEqual(calls(fx), []);
});

test("session reaper: a logind restart that does not drop the session count exits non-zero with REFUSE", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["101 closing session-101.scope 5001", "200 active session-200.scope 700"]);
  const r = run(fx); // no sessions-after.tsv: the restarted logind still lists the orphan
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /REFUSE systemd-logind\.service: restarted for 1 proven orphan\(s\), but sessions 2 -> 2 did not drop/);
  assert.deepEqual(calls(fx), ["restart systemd-logind.service"]);
});

test("session reaper: a logind that is not active after its restart exits non-zero with REFUSE", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["101 closing session-101.scope 5001", "200 active session-200.scope 700"]);
  sessions(fx, ["200 active session-200.scope 700"], "sessions-after.tsv");
  writeFileSync(join(fx.root, "logind-stays-down"), "");
  const r = run(fx);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /REFUSE systemd-logind\.service: restart for 1 proven orphan\(s\) left it failed/);
});

test("session reaper: a non-root pass refuses before it reads or changes anything", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["101 closing session-101.scope 5001"]);
  const r = run(fx, { RMD_REAPER_UID: "1000" });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /REFUSE pass: not root \(uid 1000\)/);
  assert.deepEqual(calls(fx), []);
  assert.equal(existsSync(fx.state), false);
});

test("session reaper: every pass logs how long ago logind last removed a session", (t) => {
  const fx = fixture(t);
  liveHost(fx);
  sessions(fx, ["200 active session-200.scope 700"]);
  writeFileSync(join(fx.root, "journal.txt"), `${T0 - 3 * 86400 - 2 * HOUR}.804042 host systemd-logind[543]: Removed session 86021.\n`);
  const r = run(fx);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /rmd-session-reaper: logind last logged 'Removed session' 3d 2h ago/);
  assert.match(r.out, /last Removed session 3d 2h ago$/m);
});
