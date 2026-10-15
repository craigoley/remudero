#!/usr/bin/env node
// run-with-deadline.mjs — run one command, and end its whole process group at an absolute deadline (W1-T9556).
//
//   node scripts/run-with-deadline.mjs <deadlineEpochMs> <killGraceMs> [--kernel-timeout <timeoutBin>] -- <file> [args...]
//
// WHY A SEPARATE PROCESS: the pre-open fast gate's backstop used to be execFile's `timeout`, a timer on the
// daemon's own event loop. While that loop is blocked (a sync spawn, a sync ledger read) the timer cannot fire,
// so on 2026-10-14 two gates ran 1,792 s and 2,028 s against a 900 s backstop. This runner arms the deadline on
// ITS OWN loop, which does nothing else, so a frozen parent cannot hold it.
//
// The command is spawned as a process-group leader, and the deadline kills the GROUP (SIGTERM, then SIGKILL once
// `killGraceMs` has passed with any member still alive), so the gate's `node --test` grandchildren end with it.
// With `--kernel-timeout`, the command is wrapped in coreutils `timeout -k`, armed for the same deadline: a second
// enforcer that needs no node loop at all, and which also signals its whole group.
//
// Exit status: the command's own (128 + signal number when a signal ended it), or DEADLINE_EXIT_CODE once the
// deadline has passed, with a DEADLINE_MARKER line on stderr naming which enforcer ended it. Plain node, no tsx:
// it must start fast and depend on nothing.
import { spawn } from "node:child_process";
import { constants } from "node:os";

import { isMainModule } from "./lib/argv.mjs";

// Both mirrored by src/lib/preopen-gate.ts (`GATE_DEADLINE_EXIT_CODE`, `GATE_DEADLINE_MARKER`), which reads them.
/** The status a deadline kill exits with — the same one coreutils `timeout` uses, so both enforcers read alike. */
const DEADLINE_EXIT_CODE = 124;
/** The stderr line the parent reads to name the enforcer: `<marker> enforced_by=<runner|timeout>`. */
const DEADLINE_MARKER = "rmd-deadline-exceeded";

/** The argv to spawn for `command` under the optional coreutils `timeout`, armed for `remainingMs` from now. */
function deadlineArgv(command, remainingMs, killGraceMs, timeoutBin) {
  if (!timeoutBin) return command;
  const seconds = (ms) => `${(Math.max(ms, 1) / 1000).toFixed(3)}s`;
  return [timeoutBin, "-k", seconds(killGraceMs), seconds(remainingMs), ...command];
}

/** Parse this script's argv; `undefined` when it is malformed. */
function parseArgs(argv) {
  const sep = argv.indexOf("--");
  if (sep < 2) return undefined;
  const [deadlineRaw, graceRaw, ...opts] = argv.slice(0, sep);
  const command = argv.slice(sep + 1);
  const deadline = Number(deadlineRaw);
  const killGraceMs = Number(graceRaw);
  if (!Number.isFinite(deadline) || !Number.isFinite(killGraceMs) || command.length === 0) return undefined;
  let timeoutBin;
  if (opts.length === 2 && opts[0] === "--kernel-timeout") timeoutBin = opts[1];
  else if (opts.length !== 0) return undefined;
  return { deadline, killGraceMs, timeoutBin, command };
}

/**
 * Signal every member of group `pgid`; `false` once no live member is left. ESRCH means the group is empty; EPERM
 * (every member is this user's, so it is never a real permission refusal) is macOS's answer for a group holding
 * only zombies, which are dead too.
 */
export function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if (error && (error.code === "ESRCH" || error.code === "EPERM")) return false;
    throw error;
  }
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    process.stderr.write("usage: run-with-deadline.mjs <deadlineEpochMs> <killGraceMs> [--kernel-timeout <bin>] -- <file> [args...]\n");
    process.exit(2);
  }
  const { deadline, killGraceMs, timeoutBin, command } = parsed;
  const argv = deadlineArgv(command, deadline - Date.now(), killGraceMs, timeoutBin);
  const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", detached: true });
  let firedBy;
  let reaping = false;

  const finish = (code) => {
    if (firedBy) process.stderr.write(`${DEADLINE_MARKER} enforced_by=${firedBy} deadline=${new Date(deadline).toISOString()} pgid=${child.pid}\n`);
    process.exit(code);
  };

  // Wait for the whole group to leave, then exit with `code`. Once the grace is spent the group is SIGKILLed and
  // the runner exits: a member Linux still lists (an unreaped zombie) never holds it past that.
  const reapGroup = (code) => {
    if (reaping) return;
    reaping = true;
    const graceEnds = Date.now() + killGraceMs;
    const poll = () => {
      if (!signalGroup(child.pid, 0)) return finish(code);
      if (Date.now() >= graceEnds) {
        signalGroup(child.pid, "SIGKILL");
        return finish(code);
      }
      setTimeout(poll, 50);
    };
    poll();
  };

  const fire = () => {
    firedBy = firedBy ?? "runner";
    signalGroup(child.pid, "SIGTERM");
    reapGroup(DEADLINE_EXIT_CODE);
  };
  const timer = setTimeout(fire, Math.max(0, deadline - Date.now()));

  // A runner told to stop (the parent's own last-line timeout) takes the group with it.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      clearTimeout(timer);
      signalGroup(child.pid, "SIGTERM");
      reapGroup(128 + constants.signals[signal]);
    });
  }

  child.on("error", (error) => {
    process.stderr.write(`run-with-deadline: could not start ${argv[0]}: ${error.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    if (reaping) return;
    if (Date.now() >= deadline) {
      // The command outlived its deadline: the kernel-side `timeout` ended it before this loop's timer ran.
      firedBy = firedBy ?? (timeoutBin ? "timeout" : "runner");
      signalGroup(child.pid, "SIGTERM");
      return reapGroup(DEADLINE_EXIT_CODE);
    }
    finish(code ?? 128 + (constants.signals[signal] ?? 0));
  });
}

if (isMainModule(import.meta.url)) main();
