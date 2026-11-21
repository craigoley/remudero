/**
 * W1-T14087 — the orphan sweep reads every candidate's worker markers without one ps per process.
 *
 * `sweepOrphanWorkers` calls `readMarkers` for every candidate the host lists, and the daemon wires
 * `defaultReadMarkers`, which at base ran one synchronous `ps eww -o command= -p <pid>` per pid:
 * one fork of the daemon per process on the host, on the event loop. On Linux the markers are read
 * from `/proc/<pid>/environ` with no child; elsewhere one `ps eww -Ao pid=,command=` listing serves
 * the whole sweep.
 *
 * SEAMS. The fs seam is `defaultReadMarkers`'s trailing `platform` and `readEnviron` parameters. The spawn seam is
 * process-wide: `child_process.execFileSync` is replaced and `syncBuiltinESMExports()` pushes the
 * replacement into the module's named import, so a ps call is counted whether or not the code
 * under test knows about any seam. That is what lets this suite run against base's source and
 * count base's one-ps-per-candidate (criteria 1 and 2 go red there; criterion 3's parity holds).
 *
 * The Mac cannot read a real /proc: the Linux reader is driven through the fs seam here, and the
 * real-/proc test below runs only on Linux.
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as wc from "#src/lib/worker-containment.js";
import type { OrphanMarkers, OrphanSweepReport } from "#src/lib/worker-containment.js";

const SCOPE = `rmd-v1-${"a".repeat(32)}`;
const OTHER_SCOPE = `rmd-v1-${"b".repeat(32)}`;
const LISTING_ARGS = ["eww", "-Ao", "pid=,command="];

type Environ = "ours" | "EACCES" | "exited";
interface FakeProc { cmd: string; env: Array<[string, string]>; environ: Environ }

/** One host's processes. Each candidate stands for one verdict the sweep can reach. */
function hostProcs(): Map<number, FakeProc> {
  const base: Array<[string, string]> = [["PATH", "/usr/bin:/bin"], ["HOME", "/home/node"]];
  return new Map<number, FakeProc>([
    // A worker of this installation whose run ended: reaped.
    [101, { cmd: "claude --print", environ: "ours", env: [...base, [wc.RUN_ID_ENV, "run-ended"], [wc.TASK_ID_ENV, "W1-T1"], [wc.WORKER_SCOPE_ENV, SCOPE]] }],
    // A worker of another installation: scope_mismatch.
    [102, { cmd: "claude --print", environ: "ours", env: [...base, [wc.RUN_ID_ENV, "run-other"], [wc.TASK_ID_ENV, "W1-T2"], [wc.WORKER_SCOPE_ENV, OTHER_SCOPE]] }],
    // No markers at all: unattributable.
    [103, { cmd: "node server.js", environ: "ours", env: [...base] }],
    // Run and task, no scope: scope_missing.
    [104, { cmd: "bash -c make", environ: "ours", env: [...base, [wc.RUN_ID_ENV, "run-noscope"], [wc.TASK_ID_ENV, "W1-T4"]] }],
    // A worker of this installation whose run is still in flight: run_active.
    [105, { cmd: "claude --print", environ: "ours", env: [...base, [wc.RUN_ID_ENV, "run-live"], [wc.TASK_ID_ENV, "W1-T5"], [wc.WORKER_SCOPE_ENV, SCOPE]] }],
    // Another user's process carrying markers: its environment cannot be read, so unattributable.
    [106, { cmd: "claude --print", environ: "EACCES", env: [...base, [wc.RUN_ID_ENV, "run-ended"], [wc.TASK_ID_ENV, "W1-T6"], [wc.WORKER_SCOPE_ENV, SCOPE]] }],
    // Listed as a candidate, exited before its markers were read: unattributable.
    [107, { cmd: "sleep 1", environ: "exited", env: [...base, [wc.RUN_ID_ENV, "run-ended"], [wc.TASK_ID_ENV, "W1-T7"], [wc.WORKER_SCOPE_ENV, SCOPE]] }],
    // Near-miss names only (and a task id): unattributable, never read as a run id.
    [108, { cmd: "sh", environ: "ours", env: [...base, [`${wc.RUN_ID_ENV}_PREV`, "run-ended"], [`X${wc.RUN_ID_ENV}`, "run-ended"], [wc.TASK_ID_ENV, "W1-T8"], [wc.WORKER_SCOPE_ENV, SCOPE]] }],
  ]);
}

const CANDIDATE_PIDS = [101, 102, 103, 104, 105, 106, 107, 108];

/** What base's rules give over these environments (W1-T117/W1-T12753 sweep rules, unchanged). */
const EXPECTED_REPORT: OrphanSweepReport = {
  killed: [{ run_id: "run-ended", task_id: "W1-T1", worker_scope: SCOPE, pid: 101, cmdline: "claude --print" }],
  leftAlone: [
    { pid: 102, reason: "scope_mismatch", scope: OTHER_SCOPE },
    { pid: 103, reason: "unattributable" },
    { pid: 104, reason: "scope_missing" },
    { pid: 105, reason: "run_active", scope: SCOPE },
    { pid: 106, reason: "unattributable" },
    { pid: 107, reason: "unattributable" },
    { pid: 108, reason: "unattributable" },
  ],
};

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: fake`), { code });
}

/** What `ps eww` prints for `procs`: argv, then (only for a process we own) its environment. */
function fakePs(procs: Map<number, FakeProc>, opts: { listingFails?: boolean } = {}) {
  const column = (p: FakeProc) => (p.environ === "ours" ? `${p.cmd} ${p.env.map(([k, v]) => `${k}=${v}`).join(" ")}` : p.cmd);
  return (args: readonly string[]): string => {
    if (args.length === 5 && args[0] === "eww" && args[1] === "-o" && args[2] === "command=" && args[3] === "-p") {
      const proc = procs.get(Number(args[4]));
      if (!proc || proc.environ === "exited") throw Object.assign(new Error("ps: exit 1"), { status: 1 });
      return `${column(proc)}\n`;
    }
    if (JSON.stringify(args) === JSON.stringify(LISTING_ARGS)) {
      if (opts.listingFails) throw Object.assign(new Error("ps: listing failed"), { status: 1 });
      const lines = [...procs].filter(([, p]) => p.environ !== "exited").map(([pid, p]) => `${String(pid).padStart(5)} ${column(p)}`);
      return `${[...lines, "  999 /sbin/unrelated"].join("\n")}\n`;
    }
    throw new Error(`unexpected ps args: ${JSON.stringify(args)}`);
  };
}

/** The fs seam: a fake `/proc/<pid>/environ`, recording every path read. */
function fakeProc(procs: Map<number, FakeProc>, reads: string[], failAll?: string) {
  return (path: string): Buffer => {
    reads.push(path);
    if (failAll) throw errno(failAll);
    const proc = procs.get(Number(/^\/proc\/(\d+)\/environ$/.exec(path)?.[1]));
    if (!proc || proc.environ === "exited") throw errno("ENOENT");
    if (proc.environ === "EACCES") throw errno("EACCES");
    return Buffer.from(proc.env.map(([k, v]) => `${k}=${v}\0`).join(""), "utf8");
  };
}

/**
 * The spawn seam: every `execFileSync("ps", ...)` the module makes while `fn` runs goes to `ps`
 * (when given) or to the real ps, and is recorded either way. Anything else reaches the real one.
 * With `procs`, the liveness seam too: `process.kill(pid, 0)` answers from `procs` AT CALL TIME
 * (exited or absent: ESRCH; another user's: EPERM; ours: alive), and every other signal is real.
 */
function withPsRecorded<T>(
  ps: ((args: readonly string[]) => string) | undefined,
  fn: (calls: string[][]) => T,
  procs?: Map<number, FakeProc>,
): T {
  const real = childProcess.execFileSync;
  const realKill = process.kill;
  const calls: string[][] = [];
  const spy = (file: string, args?: readonly string[], options?: object) => {
    if (file === "ps") {
      calls.push([...(args ?? [])]);
      if (ps) return ps(args ?? []);
    }
    return (real as (f: string, a?: readonly string[], o?: object) => string | Buffer)(file, args, options);
  };
  (childProcess as { execFileSync: unknown }).execFileSync = spy;
  syncBuiltinESMExports();
  if (procs) {
    process.kill = ((pid: number, signal?: string | number) => {
      if (signal !== 0) return realKill.call(process, pid, signal);
      const proc = procs.get(pid);
      if (!proc || proc.environ === "exited") throw errno("ESRCH");
      if (proc.environ === "EACCES") throw errno("EPERM");
      return true;
    }) as typeof process.kill;
  }
  try {
    return fn(calls);
  } finally {
    (childProcess as { execFileSync: unknown }).execFileSync = real;
    syncBuiltinESMExports();
    process.kill = realKill;
  }
}

function sweepWith(readMarkers: (pid: number) => OrphanMarkers | undefined, pids = CANDIDATE_PIDS, procs = hostProcs()) {
  const killedPids: number[] = [];
  const ledger: unknown[] = [];
  const report = wc.sweepOrphanWorkers({
    expectedScope: SCOPE,
    listCandidates: () => pids.map((pid) => ({ pid, cmdline: procs.get(pid)?.cmd ?? "?" })),
    readMarkers,
    isRunActive: (runId) => runId === "run-live",
    kill: (pid) => killedPids.push(pid),
    ledger: (line) => ledger.push(line),
  });
  return { report, killedPids, ledger };
}

// ── Criterion 1: Linux reads /proc, no child ────────────────────────────────────────────────────

test("W1-T14087 criterion 1: on Linux a sweep over N candidates reads each one's markers from /proc/<pid>/environ and spawns no ps for markers", () => {
  const procs = hostProcs();
  const reads: string[] = [];
  const { report, calls } = withPsRecorded(fakePs(procs), (calls) => ({
    report: sweepWith((pid) => wc.defaultReadMarkers(pid, "linux", fakeProc(procs, reads))).report,
    calls,
  }), procs);
  assert.equal(calls.length, 0, `${calls.length} ps spawn(s) for ${CANDIDATE_PIDS.length} candidates: ${JSON.stringify(calls)}`);
  assert.deepEqual(reads, CANDIDATE_PIDS.map((pid) => `/proc/${pid}/environ`), "every candidate is read from /proc, once");
  assert.deepEqual(report, EXPECTED_REPORT);
});

test("W1-T14087 criterion 1: defaultReadMarkers on Linux returns a pid's run id, task id and worker scope from its environ with no child process", () => {
  const procs = hostProcs();
  const reads: string[] = [];
  const { markers, calls } = withPsRecorded(fakePs(procs), (calls) => ({
    markers: wc.defaultReadMarkers(101, "linux", fakeProc(procs, reads)),
    calls,
  }), procs);
  assert.equal(calls.length, 0, `a /proc read spawned ps: ${JSON.stringify(calls)}`);
  assert.deepEqual(reads, ["/proc/101/environ"]);
  assert.deepEqual(markers, { runId: "run-ended", taskId: "W1-T1", scope: SCOPE });
});

// ── Criterion 2: no /proc, one listing per sweep ────────────────────────────────────────────────

test("W1-T14087 criterion 2: where /proc is not available one sweep spawns ONE ps listing for all N candidates' markers", () => {
  const procs = hostProcs();
  const reads: string[] = [];
  const { report, calls } = withPsRecorded(fakePs(procs), (calls) => ({
    report: sweepWith((pid) => wc.defaultReadMarkers(pid, "darwin", fakeProc(procs, reads))).report,
    calls,
  }), procs);
  assert.deepEqual(calls, [LISTING_ARGS], `${calls.length} ps spawn(s) for ${CANDIDATE_PIDS.length} candidates`);
  assert.deepEqual(reads, [], "no /proc read off Linux");
  assert.deepEqual(report, EXPECTED_REPORT);
});

test("W1-T14087 criterion 2: a /proc read that fails for a reason other than the pid having exited falls back to the one listing", () => {
  const procs = hostProcs();
  const reads: string[] = [];
  const { report, calls } = withPsRecorded(fakePs(procs), (calls) => ({
    report: sweepWith((pid) => wc.defaultReadMarkers(pid, "linux", fakeProc(procs, reads, "EIO"))).report,
    calls,
  }), procs);
  assert.deepEqual(calls, [LISTING_ARGS], `${calls.length} ps spawn(s) for ${CANDIDATE_PIDS.length} unreadable environs`);
  assert.equal(reads.length, CANDIDATE_PIDS.length, "each candidate tried /proc first");
  assert.deepEqual(report, EXPECTED_REPORT);
});

test("W1-T14087 criterion 2: the listing belongs to one sweep and is never reused by the next", () => {
  const procs = hostProcs();
  const readMarkers = (pid: number) => wc.defaultReadMarkers(pid, "darwin");
  const { first, second, calls } = withPsRecorded((args) => fakePs(procs)(args), (calls) => {
    const first = sweepWith(readMarkers, CANDIDATE_PIDS, procs).report;
    // Between sweeps pid 107 is reused by a new worker of this installation whose run has ended.
    procs.set(107, { cmd: "claude --print", environ: "ours", env: [[wc.RUN_ID_ENV, "run-reused"], [wc.TASK_ID_ENV, "W1-T7b"], [wc.WORKER_SCOPE_ENV, SCOPE]] });
    const second = sweepWith(readMarkers, CANDIDATE_PIDS, procs).report;
    return { first, second, calls };
  }, procs);
  assert.deepEqual(calls, [LISTING_ARGS, LISTING_ARGS], "one listing per sweep, two sweeps");
  assert.deepEqual(first, EXPECTED_REPORT);
  assert.deepEqual(second.killed.map((k) => [k.pid, k.run_id]), [[101, "run-ended"], [107, "run-reused"]], "the second sweep read a fresh listing");
});

test("W1-T14087 criterion 2: a pid that exited between listing and read yields undefined exactly as at base", () => {
  const procs = hostProcs();
  const { inSweep, direct, calls } = withPsRecorded(fakePs(procs), (calls) => ({
    inSweep: sweepWith((pid) => wc.defaultReadMarkers(pid, "darwin"), [107]).report,
    direct: wc.defaultReadMarkers(107, "darwin"),
    calls,
  }), procs);
  assert.deepEqual(inSweep, { killed: [], leftAlone: [{ pid: 107, reason: "unattributable" }] });
  assert.equal(direct, undefined, "outside a sweep, the per-pid ps of an exited pid answers undefined as at base");
  assert.equal(calls.length, 2, `one listing for the sweep and one per-pid read outside it: ${JSON.stringify(calls)}`);
});

test("W1-T14087 criterion 2: a ps listing that fails is tried once per sweep, and every candidate reads unattributable", () => {
  const procs = hostProcs();
  const { report, calls } = withPsRecorded(fakePs(procs, { listingFails: true }), (calls) => ({
    report: sweepWith((pid) => wc.defaultReadMarkers(pid, "darwin")).report,
    calls,
  }), procs);
  assert.deepEqual(calls, [LISTING_ARGS], `${calls.length} ps spawn(s) after a failed listing`);
  assert.deepEqual(report, { killed: [], leftAlone: CANDIDATE_PIDS.map((pid) => ({ pid, reason: "unattributable" })) });
});

/**
 * Round 2, finding 1: the host changes AFTER the shared listing captured pid 101's row (a worker of
 * this installation whose run ended) and BEFORE its marker lookup. `then(procs)` is that change.
 * Returns the sweep over [101], base's per-pid read of 101 at the same moment, the listing the
 * sweep was served, and every ps call. Both ways to reach the listing are driven: no /proc
 * (darwin) and a Linux /proc read that fails for a reason other than the pid having exited.
 */
function sweepAfterListingChange(path: "darwin" | "linux-EIO", then: (procs: Map<number, FakeProc>) => void) {
  const procs = hostProcs();
  const host = fakePs(procs);
  const served: string[] = [];
  const ps = (args: readonly string[]) => {
    const out = host(args);
    if (JSON.stringify(args) === JSON.stringify(LISTING_ARGS)) {
      served.push(out);
      then(procs);
    }
    return out;
  };
  const read = (pid: number) =>
    path === "darwin" ? wc.defaultReadMarkers(pid, "darwin") : wc.defaultReadMarkers(pid, "linux", fakeProc(procs, [], "EIO"));
  return withPsRecorded(ps, (calls) => {
    const swept = sweepWith(read, [101], procs);
    const base = wc.defaultReadMarkers(101, "darwin");
    return { swept, base, served, calls };
  }, procs);
}

for (const path of ["darwin", "linux-EIO"] as const) {
  test(`W1-T14087 criterion 2: a pid that exits after the shared listing captured its row, before its marker lookup, yields undefined exactly as at base (${path})`, () => {
    const { swept, base, served, calls } = sweepAfterListingChange(path, (procs) => {
      procs.set(101, { ...procs.get(101)!, environ: "exited" });
    });
    assert.equal(served.length, 1, "control: the sweep was served one listing");
    assert.match(served[0], new RegExp(`^\\s*101 claude --print .*${wc.RUN_ID_ENV}=run-ended`, "m"), "control: the listing captured 101 alive, with its markers");
    assert.equal(base, undefined, "control: base's per-pid read of the exited pid answers undefined");
    assert.deepEqual(swept.report, { killed: [], leftAlone: [{ pid: 101, reason: "unattributable" }] });
    assert.deepEqual(swept.killedPids, [], "the exited pid is never signalled");
    assert.deepEqual(swept.ledger, [], "and never recorded as reaped");
    assert.deepEqual(calls[0], LISTING_ARGS, "still one listing for the sweep");
  });

  test(`W1-T14087 criterion 2: a pid reused after the shared listing by a process that is not ours is never reaped on the listed process's markers (${path})`, () => {
    const { swept, base, served } = sweepAfterListingChange(path, (procs) => {
      // 101 exits and its pid is taken by another user's process (its environment is not ours to read).
      procs.set(101, { cmd: "postgres: writer", environ: "EACCES", env: [["PATH", "/usr/bin"]] });
    });
    assert.match(served[0], new RegExp(`^\\s*101 claude --print .*${wc.RUN_ID_ENV}=run-ended`, "m"), "control: the listing captured the first 101 with its markers");
    assert.equal(base, undefined, "control: base's per-pid read sees the new process, which shows no environment");
    assert.deepEqual(swept.report, { killed: [], leftAlone: [{ pid: 101, reason: "unattributable" }] });
    assert.deepEqual(swept.killedPids, []);
    assert.deepEqual(swept.ledger, []);
  });
}

test("W1-T14087 criterion 2: a pid still alive and ours at its lookup keeps the listed markers (the probe is not a blanket refusal)", () => {
  const { swept, served } = sweepAfterListingChange("darwin", () => {});
  assert.equal(served.length, 1);
  assert.deepEqual(swept.report.killed.map((k) => [k.pid, k.run_id]), [[101, "run-ended"]]);
  assert.deepEqual(swept.killedPids, [101]);
});

// ── Criterion 3: invariant orphan-attribution-unchanged ─────────────────────────────────────────

test("W1-T14087 criterion 3: a pid that exits after the shared listing reaches base's verdict: unattributable, not reaped, no ledger line", () => {
  const { swept } = sweepAfterListingChange("darwin", (procs) => {
    procs.set(101, { ...procs.get(101)!, environ: "exited" });
  });
  // Base's sweep over the same moment: its per-pid read of the exited pid is undefined.
  const procs = hostProcs();
  procs.set(101, { ...procs.get(101)!, environ: "exited" });
  const base = withPsRecorded(fakePs(procs), () => {
    // Base's per-pid ps, read OUTSIDE a sweep (its code is unchanged there), then swept.
    const perPid = wc.defaultReadMarkers(101, "darwin");
    return sweepWith(() => perPid, [101], procs);
  }, procs);
  assert.deepEqual(base.report, { killed: [], leftAlone: [{ pid: 101, reason: "unattributable" }] }, "control: base's verdict");
  assert.deepEqual(swept.report, base.report);
  assert.deepEqual(swept.killedPids, base.killedPids);
  assert.deepEqual(swept.ledger, base.ledger);
});

test("W1-T14087 criterion 3: every candidate reaches the same verdict from the same markers on the /proc path, the one-listing path and base's per-pid ps path", () => {
  const procs = hostProcs();
  const outcomes = withPsRecorded(fakePs(procs), (calls) => {
    // Base's per-pid path, read OUTSIDE a sweep (its code is unchanged there), then swept.
    const perPid = new Map(CANDIDATE_PIDS.map((pid) => [pid, wc.defaultReadMarkers(pid, "darwin")]));
    const perPidCalls = calls.length;
    const base = sweepWith((pid) => perPid.get(pid));
    const proc = sweepWith((pid) => wc.defaultReadMarkers(pid, "linux", fakeProc(procs, [])));
    const listing = sweepWith((pid) => wc.defaultReadMarkers(pid, "darwin"));
    return { perPidCalls, base, proc, listing };
  }, procs);
  assert.equal(outcomes.perPidCalls, CANDIDATE_PIDS.length, "control: the base path really ran one ps per candidate");
  for (const [name, run] of [["base per-pid ps", outcomes.base], ["/proc", outcomes.proc], ["one listing", outcomes.listing]] as const) {
    assert.deepEqual(run.report, EXPECTED_REPORT, `${name}: the sweep's verdicts and report shape`);
    assert.deepEqual(run.killedPids, [101], `${name}: the reaping call`);
    assert.deepEqual(run.ledger, EXPECTED_REPORT.killed, `${name}: one ledger line per kill, the same line`);
  }
});

test("W1-T14087 criterion 3: a process whose environment cannot be read is unattributable, never assumed attributable", () => {
  for (const code of ["ENOENT", "ESRCH", "EACCES", "EPERM"]) {
    assert.equal(wc.readOrphanMarkersFromProc(101, () => { throw errno(code); }), undefined, `${code} answers undefined`);
  }
  assert.equal(wc.readOrphanMarkersFromProc(101, () => { throw errno("EIO"); }), "unreadable", "any other failure is named, not guessed");
  // A worker that would be reaped if its markers were assumed: its environ is EACCES and ps shows no environment.
  const procs = hostProcs();
  procs.set(101, { ...procs.get(101)!, environ: "EACCES" });
  const { killedPids, report } = withPsRecorded(fakePs(procs), () =>
    sweepWith((pid) => wc.defaultReadMarkers(pid, "linux", fakeProc(procs, [])), [101], procs));
  assert.deepEqual(killedPids, [], "never signalled");
  assert.deepEqual(report, { killed: [], leftAlone: [{ pid: 101, reason: "unattributable" }] });
});

test("W1-T14087 criterion 3: the /proc reader reads the same three names with the same values as the ps token parser", () => {
  const envs: Array<Array<[string, string]>> = [
    [[wc.RUN_ID_ENV, "r1"], [wc.TASK_ID_ENV, "t1"], [wc.WORKER_SCOPE_ENV, SCOPE]],
    [[wc.RUN_ID_ENV, "r2"], [wc.TASK_ID_ENV, "t2"]],
    [[`${wc.RUN_ID_ENV}_PREV`, "r3"], [`X${wc.TASK_ID_ENV}`, "t3"], [wc.TASK_ID_ENV, "t3"]],
    [[wc.RUN_ID_ENV, "first"], [wc.TASK_ID_ENV, "t4"], [wc.RUN_ID_ENV, "second"]],
    [[wc.RUN_ID_ENV, "has space"], [wc.TASK_ID_ENV, "t5"], [wc.WORKER_SCOPE_ENV, ""]],
    [[wc.RUN_ID_ENV, ""], [wc.TASK_ID_ENV, "t6"]],
    [["PATH", "/bin"]],
    // Round 2, finding 2: a name that repeats. Base's regex takes the FIRST match with a value
    // (`\S+` needs one character), so an empty or space-led entry is skipped, not kept.
    [[wc.RUN_ID_ENV, ""], [wc.TASK_ID_ENV, "t7"], [wc.RUN_ID_ENV, "r7"]],
    [[wc.RUN_ID_ENV, "r8"], [wc.TASK_ID_ENV, "t8"], [wc.RUN_ID_ENV, ""]],
    [[wc.RUN_ID_ENV, " r9-led-by-space"], [wc.TASK_ID_ENV, "t9"], [wc.RUN_ID_ENV, "r9"]],
    [[wc.RUN_ID_ENV, "r10"], [wc.TASK_ID_ENV, ""], [wc.WORKER_SCOPE_ENV, ""], [wc.TASK_ID_ENV, "t10"], [wc.WORKER_SCOPE_ENV, SCOPE]],
    [[wc.RUN_ID_ENV, "r11"], [wc.TASK_ID_ENV, "t11"], [wc.WORKER_SCOPE_ENV, SCOPE], [wc.WORKER_SCOPE_ENV, OTHER_SCOPE]],
  ];
  envs.forEach((env, i) => {
    const pid = 200 + i;
    const procs = new Map<number, FakeProc>([[pid, { cmd: "sh", environ: "ours", env }]]);
    const viaPs = withPsRecorded(fakePs(procs), () => wc.defaultReadMarkers(pid, "darwin"));
    const viaProc = wc.readOrphanMarkersFromProc(pid, fakeProc(procs, []));
    assert.deepEqual(viaProc, viaPs, `environment ${i}: ${JSON.stringify(env)}`);
  });
});

test("W1-T14087 criterion 3: a repeated marker name gives the sweep base's verdict on the /proc path, in both duplicate orders", () => {
  const env = (...entries: Array<[string, string]>): FakeProc => ({ cmd: "claude --print", environ: "ours", env: [["PATH", "/bin"], ...entries] });
  const procs = new Map<number, FakeProc>([
    // Empty first, then a value: base's regex skips the empty entry and reads run-dup-ended, so reaps.
    [301, env([wc.RUN_ID_ENV, ""], [wc.TASK_ID_ENV, "W1-T301"], [wc.WORKER_SCOPE_ENV, SCOPE], [wc.RUN_ID_ENV, "run-dup-ended"])],
    // A value first, then empty: the first value wins, and that run is live.
    [302, env([wc.RUN_ID_ENV, "run-live"], [wc.TASK_ID_ENV, "W1-T302"], [wc.WORKER_SCOPE_ENV, SCOPE], [wc.RUN_ID_ENV, ""])],
    // An empty scope, then another installation's: scope_mismatch, never scope_missing.
    [303, env([wc.RUN_ID_ENV, "run-x"], [wc.TASK_ID_ENV, "W1-T303"], [wc.WORKER_SCOPE_ENV, ""], [wc.WORKER_SCOPE_ENV, OTHER_SCOPE])],
  ]);
  const pids = [301, 302, 303];
  const expected: OrphanSweepReport = {
    killed: [{ run_id: "run-dup-ended", task_id: "W1-T301", worker_scope: SCOPE, pid: 301, cmdline: "claude --print" }],
    leftAlone: [{ pid: 302, reason: "run_active", scope: SCOPE }, { pid: 303, reason: "scope_mismatch", scope: OTHER_SCOPE }],
  };
  const { base, proc } = withPsRecorded(fakePs(procs), () => {
    const perPid = new Map(pids.map((pid) => [pid, wc.defaultReadMarkers(pid, "darwin")]));
    return {
      base: sweepWith((pid) => perPid.get(pid), pids, procs),
      proc: sweepWith((pid) => wc.defaultReadMarkers(pid, "linux", fakeProc(procs, [])), pids, procs),
    };
  }, procs);
  assert.deepEqual(base.report, expected, "control: base's per-pid ps verdicts over these environments");
  assert.deepEqual(proc.report, expected, "/proc: the same verdicts");
  assert.deepEqual(proc.killedPids, base.killedPids);
  assert.deepEqual(proc.ledger, base.ledger);
});

// ── The real defaults (no fs or spawn fake) ─────────────────────────────────────────────────────

async function markedChild(env: Record<string, string>) {
  const child = wc.spawnDetachedGroup({ command: "/bin/sh", args: ["-c", "sleep 300"], env: { PATH: process.env.PATH, ...env } });
  return child.pid;
}

function stop(pid: number): void {
  try {
    wc.killProcessGroup(pid);
  } catch (err) {
    // The group is this test's own; a failure to signal it is reported, never hidden.
    console.error(`could not stop test child ${pid}: ${String(err)}`);
  }
}

test("W1-T14087: a real sweep attributes a live marked child with the real reader (Linux: /proc, no ps; elsewhere: one real ps listing)", async () => {
  const runId = `run-real-14087-${process.pid}`;
  const marked = await markedChild({ [wc.RUN_ID_ENV]: runId, [wc.TASK_ID_ENV]: "W1-T14087", [wc.WORKER_SCOPE_ENV]: SCOPE });
  const unmarked = await markedChild({});
  try {
    const until = Date.now() + 30_000;
    while (wc.defaultReadMarkers(marked) === undefined && Date.now() < until) await delay(20);
    assert.deepEqual(wc.defaultReadMarkers(marked), { runId, taskId: "W1-T14087", scope: SCOPE }, "positive control: the child's markers are visible");
    const killed: number[] = [];
    const { report, calls } = withPsRecorded(undefined, (calls) => ({
      report: wc.sweepOrphanWorkers({
        expectedScope: SCOPE,
        listCandidates: () => [{ pid: marked, cmdline: "sh" }, { pid: unmarked, cmdline: "sh" }],
        readMarkers: wc.defaultReadMarkers,
        isRunActive: (id) => id === runId,
        kill: (pid) => killed.push(pid),
        ledger: () => {},
      }),
      calls,
    }));
    assert.deepEqual(report, { killed: [], leftAlone: [{ pid: marked, reason: "run_active", scope: SCOPE }, { pid: unmarked, reason: "unattributable" }] });
    assert.deepEqual(killed, []);
    assert.deepEqual(calls, process.platform === "linux" ? [] : [LISTING_ARGS], `real ps spawns on ${process.platform}`);
  } finally {
    stop(marked);
    stop(unmarked);
  }
});

test("W1-T14087: on Linux the default fs read reads a real child's markers from /proc", async (t) => {
  if (process.platform !== "linux") { t.skip("reads a real /proc; Linux only"); return; }
  const marked = await markedChild({ [wc.RUN_ID_ENV]: "run-proc-14087", [wc.TASK_ID_ENV]: "W1-T14087" });
  try {
    const until = Date.now() + 30_000;
    while (wc.readOrphanMarkersFromProc(marked) === undefined && Date.now() < until) await delay(20);
    assert.deepEqual(wc.readOrphanMarkersFromProc(marked), { runId: "run-proc-14087", taskId: "W1-T14087" });
  } finally {
    stop(marked);
  }
});

test("W1-T14087: where /proc does not exist the default fs read answers undefined, never attributable", (t) => {
  if (existsSync("/proc/self/environ")) { t.skip("this host has a /proc"); return; }
  assert.equal(wc.readOrphanMarkersFromProc(process.pid), undefined);
});
