import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { readDiskFreeBytes, readDiskTotalBytes, deriveLastPoll } from "./daemon-health.js";
import { pauseFilePath } from "./fleet-control.js";
import { execFileSync } from "node:child_process";

// Why: the day-long outage and ninety-minute API lockout behind these constraints — docs/forensics/doctor.md#module-header.
/**
 * `rmd doctor` (W1-T1047): one local, read-only command answering whether the fleet is healthy,
 * with an exit code that means something. Three refusals, each earned by a measured failure:
 * CLI-side, not console; no network (every reader touches the ledger, `state/`, `plan/`, `/proc`
 * or `ps`, never `gh`); and no healthy daemon required. `--fix` is refused by name: every repair
 * path already has an owner (#2251, W1-T1036, W1-T978). Every `judge*` function is pure.
 * FALSIFIER: test/doctor.test.ts, test/doctor-node-pin.test.ts.
 */

export type Verdict = "OK" | "WARN" | "FAIL";

/** One check's result. `measured` and `threshold` are both required — no check may ever print a
 *  bare verdict, which is what makes a health command cry wolf. */
export interface Check {
  name: string;
  verdict: Verdict;
  measured: string;
  threshold: string;
  detail?: string;
}

const ORDER: Record<Verdict, number> = { OK: 0, WARN: 1, FAIL: 2 };

/** The worst verdict across every check — the summary line and the exit code both derive from
 *  THIS, so they cannot disagree. An empty list is OK: nothing measured, nothing wrong. */
export function worstVerdict(checks: readonly Check[]): Verdict {
  let worst: Verdict = "OK";
  for (const c of checks) if (ORDER[c.verdict] > ORDER[worst]) worst = c.verdict;
  return worst;
}

/** Doctor's own bad-argument exit code, distinct from `statusCommand`'s 2: exit 2 then always
 *  means "a check FAILED", never "you typed the flag wrong". */
export const DOCTOR_USAGE_EXIT = 64;

export function exitCodeFor(worst: Verdict): number {
  return worst === "FAIL" ? 2 : worst === "WARN" ? 1 : 0;
}

// ── pure deciders ─────────────────────────────────────────────────────────────────────────────

/** Bytes → a short human figure. Kept here so `measured` and `threshold` are formatted the same
 *  way and a reader can compare them at a glance. */
export function humanBytes(n: number): string {
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)}${u[i]}`;
}

export function humanMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

// Why: the W1-T1274 measurement behind this check's corpus — docs/forensics/doctor.md#judgeledgerfreshness.
/**
 * Ledger freshness — the single best liveness signal, because `docker logs` narrates actions and
 * goes silent between them. FAILs past the bound rather than WARNs, since a stale ledger means
 * the daemon is gone.
 * INVARIANT: the corpus is every `daemon.`-prefixed row, never narrowed to `daemon.tick` alone or
 * one `run_id` (W1-T1274 rationale (7)/(8)) — `daemon.ts`'s loop writes `daemon.tick` on every
 * iteration, so this is never silent for longer than one poll interval while the loop turns.
 * FALSIFIER: test/doctor.test.ts.
 */
export function judgeLedgerFreshness(ageMs: number | undefined, boundMs: number): Check {
  const threshold = `<= ${humanMs(boundMs)}`;
  if (ageMs === undefined) {
    return {
      name: "ledger-freshness",
      verdict: "FAIL",
      measured: "no daemon row found",
      threshold,
      detail:
        "no `daemon.`-prefixed ledger row at all — ordinarily the loop writes a `daemon.tick` row every " +
        "iteration on top of its boot-time and ticker rows, so this means the daemon has not run, or the " +
        "ledger path is wrong",
    };
  }
  return {
    name: "ledger-freshness",
    verdict: ageMs > boundMs ? "FAIL" : "OK",
    measured: humanMs(ageMs),
    threshold,
  };
}

// Why: the 55MiB incident these thresholds are sized against — docs/forensics/doctor.md#judgediskheadroom.
/** Disk headroom thresholds, sized off a measured incident rather than round numbers: this host
 *  once reached 55MiB free with a live daemon on it and ordinary commands failed to write their
 *  own stdout. FAIL sits an order of magnitude above that point, WARN an order above FAIL. */
export const DISK_FAIL_BYTES = 512 * 1024 * 1024;
export const DISK_WARN_BYTES = 2 * 1024 * 1024 * 1024;

/** The absolute floors above are a FLOOR, not the whole judgement. They were sized off one
 *  container's 55MiB incident so the warning would "arrive with time to act"
 *  (docs/forensics/doctor.md#judgeDiskHeadroom) — and on a small volume they do. On a large one
 *  they cannot: MEASURED 2026-09-06 on this fleet's Mac host, a 228GiB volume at 96% full with
 *  9.4GiB free read OK, because 2GiB is 0.9% of it. There is no warning BAND at that size — the
 *  check only leaves OK once the volume is 99.1% full, by which point a single `npm ci` has
 *  already failed. That host has filled to 100% four times in four months.
 *
 *  So headroom is judged proportionally TOO, and the stricter of the two wins. judgeMemory in this
 *  same file already reads fractions for exactly this reason; disk was the outlier. Deliberately
 *  gentler than memory's 20/10 — a disk fills over days, not milliseconds, so a narrower band
 *  still leaves time to act without crying wolf. */
export const DISK_WARN_FRACTION = 0.1;
export const DISK_FAIL_FRACTION = 0.05;

export function judgeDiskHeadroom(freeBytes: number | undefined, totalBytes?: number): Check {
  // `undefined` total ⇒ the absolute floors alone, byte-identical to the pre-proportional
  // behaviour: an unreadable denominator must SKIP the proportional arm, never fabricate one.
  const warnAt = Math.max(DISK_WARN_BYTES, (totalBytes ?? 0) * DISK_WARN_FRACTION);
  const failAt = Math.max(DISK_FAIL_BYTES, (totalBytes ?? 0) * DISK_FAIL_FRACTION);
  const threshold =
    totalBytes === undefined
      ? `WARN < ${humanBytes(DISK_WARN_BYTES)}, FAIL < ${humanBytes(DISK_FAIL_BYTES)}`
      : `WARN < ${humanBytes(warnAt)} (max of ${humanBytes(DISK_WARN_BYTES)} and ${Math.round(DISK_WARN_FRACTION * 100)}% of ${humanBytes(totalBytes)}), ` +
        `FAIL < ${humanBytes(failAt)}`;
  if (freeBytes === undefined) {
    return { name: "disk-headroom", verdict: "WARN", measured: "unreadable", threshold };
  }
  const verdict: Verdict = freeBytes < failAt ? "FAIL" : freeBytes < warnAt ? "WARN" : "OK";
  const measured =
    totalBytes === undefined || totalBytes <= 0
      ? humanBytes(freeBytes)
      : `${humanBytes(freeBytes)} (${((freeBytes / totalBytes) * 100).toFixed(1)}% of ${humanBytes(totalBytes)})`;
  return { name: "disk-headroom", verdict, measured, threshold };
}

// Why: the measured ~4%-available freeze with no OOM signal — docs/forensics/doctor.md#judgememory.
/** Memory and swap, read from `/proc/meminfo` rather than the cgroup limit (this container's
 *  `memory.max` reads the literal string `max`). A measured freeze at ~4% available with zero
 *  swap logged nothing — a reclaim livelock never arms the OOM killer — so absent swap is part of
 *  the judgement, not a footnote. FALSIFIER: test/doctor.test.ts. */
export const MEM_FAIL_FRACTION = 0.1;
export const MEM_WARN_FRACTION = 0.2;

export function judgeMemory(availableBytes: number | undefined, totalBytes: number | undefined, swapTotalBytes: number | undefined): Check {
  const threshold = `WARN < ${Math.round(MEM_WARN_FRACTION * 100)}% available, FAIL < ${Math.round(MEM_FAIL_FRACTION * 100)}%`;
  if (availableBytes === undefined || totalBytes === undefined || totalBytes <= 0) {
    return { name: "memory", verdict: "WARN", measured: "unreadable", threshold, detail: "/proc/meminfo did not yield MemAvailable and MemTotal" };
  }
  const frac = availableBytes / totalBytes;
  const pct = `${(frac * 100).toFixed(1)}%`;
  const swapNote = swapTotalBytes === 0 ? " with NO swap — a reclaim livelock here never arms the OOM killer and logs nothing" : "";
  const verdict: Verdict = frac < MEM_FAIL_FRACTION ? "FAIL" : frac < MEM_WARN_FRACTION ? "WARN" : "OK";
  return {
    name: "memory",
    verdict,
    measured: `${humanBytes(availableBytes)} of ${humanBytes(totalBytes)} (${pct})`,
    threshold,
    ...(verdict === "OK" ? {} : { detail: `available headroom is ${pct}${swapNote}` }),
  };
}

// Why: why the bound is caller-derived rather than a constant — docs/forensics/doctor.md#judgedispatchstall.
/** Eligible pool versus dispatch age. The bound is never a guessed round figure — the caller
 *  passes this host's own observed dispatch cadence plus a derivation string, so the printed
 *  threshold explains itself. A non-empty pool sitting past that bound renders identically to a
 *  healthy queue in `rmd status`, which is the defect this catches. */
export function judgeDispatchStall(candidateCount: number, sinceMs: number | undefined, boundMs: number | undefined, boundDerivation?: string): Check {
  const threshold = boundMs === undefined ? "no observed cadence yet" : `<= ${humanMs(boundMs)}${boundDerivation ? ` (${boundDerivation})` : ""}`;
  if (candidateCount === 0) {
    return { name: "dispatch-stall", verdict: "OK", measured: "0 eligible candidate(s)", threshold };
  }
  if (sinceMs === undefined || boundMs === undefined) {
    return { name: "dispatch-stall", verdict: "WARN", measured: `${candidateCount} eligible, dispatch age unknown`, threshold };
  }
  return {
    name: "dispatch-stall",
    verdict: sinceMs > boundMs ? "FAIL" : "OK",
    measured: `${candidateCount} eligible, nothing dispatched in ${humanMs(sinceMs)}`,
    threshold,
  };
}

// Why: the twenty-one-hour W1-T1209 outage this arm exists to surface — docs/forensics/doctor.md#judgerepairstall.
/** Repair-rung stall (W1-T1209): `fix.dispatch` can go quiet while the sweep keeps disposing
 *  `blocked-fixable`, with nothing else saying so. INVARIANT: a conjunction, like
 *  {@link judgeDispatchStall} — an empty repair queue must stay healthy, and the bound is
 *  caller-derived. Report only — dispatches, clears, or escalates nothing.
 *  FALSIFIER: test/doctor.test.ts. */
export function judgeRepairStall(disposedBlockedFixableCount: number, sinceMs: number | undefined, boundMs: number | undefined, boundDerivation?: string): Check {
  const threshold = boundMs === undefined ? "no observed cadence yet" : `<= ${humanMs(boundMs)}${boundDerivation ? ` (${boundDerivation})` : ""}`;
  if (disposedBlockedFixableCount === 0) {
    return { name: "repair-stall", verdict: "OK", measured: "0 blocked-fixable disposal(s) in window", threshold };
  }
  if (sinceMs === undefined || boundMs === undefined) {
    return {
      name: "repair-stall",
      verdict: "WARN",
      measured: `${disposedBlockedFixableCount} disposed blocked-fixable, fix.dispatch age unknown`,
      threshold,
    };
  }
  return {
    name: "repair-stall",
    verdict: sinceMs > boundMs ? "FAIL" : "OK",
    measured: `${disposedBlockedFixableCount} disposed blocked-fixable, nothing dispatched in ${humanMs(sinceMs)}`,
    threshold,
    ...(sinceMs > boundMs
      ? { detail: "W1-T1129 owns the lock contention, W1-T1127 owns the dedup gate that swallowed it — doctor only reports" }
      : {}),
  };
}

// Why: why zero rows and "too few to judge" must not collapse to one verdict — docs/forensics/doctor.md#judgedispatchstarvation.
/** Dispatch liveness, from `daemon.alive`'s `phase` field: a recent window with no `dispatch`
 *  phase is a daemon awake but never dispatching, WARN never FAIL. INVARIANT: callers pass only
 *  the current run's phases ({@link readCurrentRunAlivePhases}, W1-T1099); zero rows is WARN
 *  "liveness UNKNOWN", never OK. FALSIFIER: test/doctor.test.ts. */
export const STARVATION_MIN_ROWS = 3;

export function judgeDispatchStarvation(phases: readonly string[]): Check {
  const threshold = `some dispatch phase within the last ${STARVATION_MIN_ROWS} alive row(s)`;
  if (phases.length === 0) {
    return {
      name: "dispatch-liveness",
      verdict: "WARN",
      measured: "0 alive row(s) for the current run — liveness UNKNOWN",
      threshold,
      detail: "no daemon.alive row exists for this run yet — a daemon that never enters a rung writes none at all, so this is not evidence of health; check dispatch-stall and the daemon process directly",
    };
  }
  if (phases.length < STARVATION_MIN_ROWS) {
    return { name: "dispatch-liveness", verdict: "OK", measured: `${phases.length} alive row(s) — too few to judge`, threshold };
  }
  const recent = phases.slice(-STARVATION_MIN_ROWS);
  const starved = !recent.includes("dispatch");
  return {
    name: "dispatch-liveness",
    verdict: starved ? "WARN" : "OK",
    measured: `last ${recent.length} phase(s): ${recent.join(", ")}`,
    threshold,
    ...(starved ? { detail: "awake but never dispatching — an empty queue looks the same, so confirm against dispatch-stall" } : {}),
  };
}

// Why: the 2026-08-05 blind-sweep incident this arm exists to surface — docs/forensics/doctor.md#sweep_liveness_steps.
/** Sweep liveness (W1-T1236): `sweep.pass` is written before `runSweep`'s per-PR loop so a pass
 *  that throws mid-loop still leaves a row — a measured 23.5-minute blind window on 2026-08-05
 *  held four dispositions and a whole PR lifecycle unseen. INVARIANT: two faults off rows that
 *  already exist — passes not starting (past a caller-derived bound, like
 *  {@link judgeDispatchStall}) and passes not finishing (no `sweep.summary` at or after the
 *  newest pass). Zero rows is WARN, never OK or FAIL, on {@link judgeDispatchStarvation}'s
 *  precedent. This Set names every step read, so no blanket `.step ===` scan elsewhere sweeps in
 *  unrelated ones. FALSIFIER: test/ledger-render-retention.test.ts. */
export const SWEEP_LIVENESS_STEPS: ReadonlySet<string> = new Set(["sweep.pass", "sweep.summary"]);

/** Multiplier on the longest observed gap between `sweep.pass` rows, deriving the staleness
 *  bound — re-derived rather than imported from `status-board.ts`'s `QUEUE_HEAD_STALL_MULTIPLIER`
 *  because this file folds only over its own `ledgerLines`. */
export const SWEEP_STALL_MULTIPLIER = 3;

/** `sweep.pass`/`sweep.summary` timestamps (parsed ms, oldest-order not required), read through
 *  {@link SWEEP_LIVENESS_STEPS}. A line with no parseable `ts` is skipped rather than corrupting
 *  the derived cadence. */
export function readSweepPassSummaryTimestamps(lines: ReadonlyArray<Record<string, unknown>>): { passesMs: number[]; summariesMs: number[] } {
  const passesMs: number[] = [];
  const summariesMs: number[] = [];
  for (const line of lines) {
    const step = typeof line.step === "string" ? line.step : undefined;
    if (!step || !SWEEP_LIVENESS_STEPS.has(step)) continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts !== undefined ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed)) continue;
    (step === "sweep.pass" ? passesMs : summariesMs).push(parsed);
  }
  return { passesMs, summariesMs };
}

/** REPORT ONLY, like every sibling arm above: returns a {@link Check} and nothing else — no
 *  dispatch, no gate clear, no restart. Pure, so calling it twice with the same inputs is
 *  byte-identical, the same proof-of-no-action shape {@link judgeRepairStall}'s test relies on. */
export function judgeSweepLiveness(passesMs: readonly number[], summariesMs: readonly number[], nowMs: number): Check {
  const name = "sweep-liveness";
  if (passesMs.length === 0) {
    return {
      name,
      verdict: "WARN",
      measured: "0 sweep.pass row(s) in window — liveness UNKNOWN",
      threshold: "a recent sweep.pass, followed by its own sweep.summary",
      detail:
        "no sweep.pass row exists yet — a fleet that has never swept, a freshly-rotated ledger and a sweep blind " +
        "longer than retention all look identical here; this is not evidence of health, check the daemon process directly",
    };
  }

  const sorted = [...passesMs].sort((a, b) => a - b);
  const newestPass = sorted[sorted.length - 1]!;
  const ageMs = Math.max(0, nowMs - newestPass);

  let boundMs: number | undefined;
  let boundDerivation: string | undefined;
  if (sorted.length >= 2) {
    let maxGapMs = 0;
    for (let i = 1; i < sorted.length; i++) maxGapMs = Math.max(maxGapMs, sorted[i]! - sorted[i - 1]!);
    // Same-instant rows leave no gap to learn a cadence from: leave boundMs undefined rather
    // than fabricate a zero bound.
    if (maxGapMs > 0) {
      boundMs = maxGapMs * SWEEP_STALL_MULTIPLIER;
      boundDerivation = `${SWEEP_STALL_MULTIPLIER}x the longest observed gap between sweep.pass rows on this host (${humanMs(maxGapMs)} over ${sorted.length} rows)`;
    }
  }
  const threshold = `${boundMs === undefined ? "no observed cadence yet" : `<= ${humanMs(boundMs)}${boundDerivation ? ` (${boundDerivation})` : ""}`}, followed by its own sweep.summary`;

  if (boundMs !== undefined && ageMs > boundMs) {
    return {
      name,
      verdict: "WARN",
      measured: `newest sweep.pass ${humanMs(ageMs)} ago`,
      threshold,
      detail: "passes have stopped starting on this host's own observed cadence — doctor only reports",
    };
  }

  // Paired by time order, not a correlation id: the newest pass is "finished" once any
  // sweep.summary lands at or after it — a pass id would change sweep.ts's own emit (W1-T1238).
  const finishedByOwnSummary = summariesMs.some((s) => s >= newestPass);
  if (!finishedByOwnSummary) {
    return {
      name,
      verdict: "WARN",
      measured: `newest sweep.pass has no sweep.summary at or after it (${humanMs(ageMs)} ago) — the pass may have died mid-loop`,
      threshold,
      detail: "sweep.pass is written BEFORE the loop for exactly this: a pass that dies mid-way still leaves this row",
    };
  }

  return {
    name,
    verdict: "OK",
    measured: `newest sweep.pass ${humanMs(ageMs)} ago, finished by its own sweep.summary`,
    threshold,
  };
}

/** Lock versus process divergence: an inflight lock whose pid is gone is a run that died without
 *  releasing. WARN and report only — W1-T978 owns `drain.lock` reclamation, #2251 the recycle. */
export function judgeLockDivergence(totalLocks: number, deadLocks: readonly string[], unreadableReason?: string): Check {
  // An unreadable dir is not an empty one — conflating them is a fail-open, so only a genuinely
  // absent dir is zero locks; anything else reports lock state as UNKNOWN.
  if (unreadableReason !== undefined) {
    return {
      name: "lock-vs-process",
      verdict: "WARN",
      measured: `lock state UNKNOWN — ${unreadableReason}`,
      threshold: "every inflight lock has a live pid",
      detail: "an unreadable inflight dir hides locks rather than proving there are none — do not read this as healthy",
    };
  }
  return {
    name: "lock-vs-process",
    verdict: deadLocks.length > 0 ? "WARN" : "OK",
    measured: `${totalLocks} lock(s), ${deadLocks.length} with no live pid`,
    threshold: "every inflight lock has a live pid",
    ...(deadLocks.length > 0 ? { detail: `stale: ${deadLocks.join(", ")} — W1-T978 owns reclamation, doctor only reports` } : {}),
  };
}

/** Classify a filesystem read failure into "genuinely absent" versus "could not be read" —
 *  extracted and pure so both arms are reachable from a test without a real EACCES. */
export function classifyReadFailure(e: unknown): { absent: boolean; reason: string } {
  const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "";
  if (code === "ENOENT") return { absent: true, reason: "ENOENT" };
  return { absent: false, reason: code || String((e as Error)?.message ?? e) };
}

/** Lane-less workers, against #2251's `HUNG_WORKER_AGE_S` reused rather than re-derived — that
 *  PR states its own derivation. */
export const HUNG_WORKER_AGE_S = 7200;

/**
 * The live worker process table, read the same injected way every other doctor input is.
 *
 * WHY THIS EXISTS (W1-T3628). `buildDoctorReport`'s only caller passed `workerCount: 0` as a
 * LITERAL and never assigned `oldestWorkerEtimeS` at all, so {@link judgeLaneLessWorkers} always
 * took its `count === 0` branch and HUNG_WORKER_AGE_S was compared against nothing. The judge was
 * exported, correct and well unit-tested the whole time; the defect was the one line feeding it,
 * which is precisely the seam a pure-function test cannot reach.
 *
 * WHAT COUNTS AS A WORKER, and why it is a NARROW list. `claude` is the worker binary the adapter
 * spawns, and `npm ci` is the worktree install a lane runs before it; those are the two shapes the
 * 2026-09-16 outage actually held for 80 minutes. Anything broader would sweep in the daemon's own
 * long-lived `node` and report a permanently wedged host.
 *
 * `undefined` means the table COULD NOT BE READ, which the judge renders as UNKNOWN rather than as
 * zero — a failed read must never look like a healthy host.
 */
export interface WorkerProcess {
  pid: number;
  /** Parent pid. A worker whose parent is gone has been reparented to init — the ORPHAN test the
   *  reaper uses (W1-T3629), because age alone is evidence of duration and not of death. */
  ppid: number;
  etimeS: number;
  args: string;
}

export interface WorkerProcessReading {
  count: number;
  oldestEtimeS?: number;
  /** The processes themselves, so a reaper acts on the SAME reading the doctor judges (W1-T3629). */
  processes: WorkerProcess[];
}

/**
 * A DISPATCHED WORKER, not any `claude` on the box. The daemon spawns workers with
 * `--output-format stream-json`; an operator's interactive session never does. Matching `claude`
 * alone counted THIS developer's own session as a hung worker — measured while writing this, a
 * live reading returned `oldest 11.5 days`, which was the editor running the change.
 *
 * `npm ci` is the worktree install a lane runs before its worker, and is the shape that actually
 * sat for 80 minutes during the 2026-09-16 outage.
 */
export interface WorkerPattern {
  /** Basename of argv[0]. Matched EXACTLY, never as a substring of the whole command line. */
  readonly exe: string;
  /** Flags that must also appear, to separate a dispatched worker from an interactive one. */
  readonly needs: readonly string[];
}

/**
 * A DISPATCHED WORKER, matched on its EXECUTABLE rather than anywhere in its command line.
 *
 * TWO FALSE POSITIVES WERE MEASURED WHILE WRITING THIS, and the second is why this anchors on
 * argv[0]:
 *
 *   1. Matching `claude` anywhere counted the OPERATOR'S OWN interactive session — a live reading
 *      returned `oldest 11.5 days`, which was the editor running this change.
 *   2. Matching `--output-format stream-json` anywhere then counted a SHELL COMMAND that merely
 *      CONTAINED that text: this file was being edited by a `zsh -c` whose argv quoted the flag,
 *      and the reading picked up the shell itself.
 *
 * The second one is the dangerous shape. For a counter it is an over-count; for W1-T3629's reaper
 * it would mean sending a signal to an operator's shell. So the executable's BASENAME must match
 * exactly, and the flags are an additional condition rather than the whole test.
 */
export const WORKER_PROCESS_PATTERNS: readonly WorkerPattern[] = [
  { exe: "claude", needs: ["--output-format stream-json"] },
  { exe: "npm", needs: ["ci"] },
];

/** argv[0]'s basename, or "" when the line has no command — never a substring search. */
export function commandBasename(args: string): string {
  const first = args.trim().split(/\s+/)[0] ?? "";
  return first.split("/").pop() ?? "";
}

export function matchesWorkerPattern(args: string): boolean {
  const exe = commandBasename(args);
  return WORKER_PROCESS_PATTERNS.some((p) => p.exe === exe && p.needs.every((n) => args.includes(n)));
}

export function parseEtime(field: string): number | undefined {
  const raw = field.trim();
  if (/^\d+$/.test(raw)) return Number(raw); // procps `etimes`
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(raw); // BSD `etime`
  if (!m) return undefined;
  const [, d, h, mm, ss] = m;
  return Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(mm) * 60 + Number(ss);
}

export function parseWorkerProcesses(psOutput: string): WorkerProcessReading {
  const processes: WorkerProcess[] = [];
  let oldest: number | undefined;
  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const etime = parseEtime(match[3] ?? "");
    const args = match[4] ?? "";
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || etime === undefined) continue;
    if (!matchesWorkerPattern(args)) continue;
    processes.push({ pid, ppid, etimeS: etime, args });
    if (oldest === undefined || etime > oldest) oldest = etime;
  }
  const count = processes.length;
  return oldest === undefined ? { count, processes } : { count, oldestEtimeS: oldest, processes };
}

/** The one shape `defaultPs` needs from `execFileSync` — narrow enough that a test can inject a
 *  fake and record exactly what it was called with, without stubbing `node:child_process` itself. */
export type PsSpawn = (cmd: string, args: string[]) => string;

/** The real spawn, with the fixed options `defaultPs`'s two dialect attempts both need. Extracted
 *  so the injection point below is the bare command/args pair a test can assert on. */
function realPsSpawn(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

/** procps first, BSD second. A keyword error is not a read failure — only BOTH failing is.
 *  `spawn` is injectable (defaulted to the real one) so the BSD-fallback branch and the exact
 *  two attempted commands are assertable from a test, not just exercised by the live host's own
 *  `ps` dialect (W1-T3628 coverage-ratchet: an external-tool spawn cannot be process-boundary
 *  exempted — it must be covered by injecting the boundary itself). */
export function defaultPs(spawn: PsSpawn = realPsSpawn): string {
  try {
    return spawn("ps", ["-eo", "pid=,ppid=,etimes=,args="]);
  } catch {
    // BSD `ps` rejects the procps `etimes=` keyword outright rather than returning empty output,
    // so this falls back to `etime=`, its own dialect. A REAL read failure (no `ps` binary at
    // all, EACCES, etc.) surfaces from THIS second call instead -- into readWorkerProcesses's own
    // catch below, never swallowed here.
    return spawn("ps", ["-eo", "pid=,ppid=,etime=,args="]);
  }
}

export function readWorkerProcesses(
  run: () => string = defaultPs,
): WorkerProcessReading | { unreadableReason: string } {
  try {
    return parseWorkerProcesses(run());
  } catch (error) {
    // Neither `ps` dialect could run (missing binary, EACCES, ...) -- classifyReadFailure gives
    // the same reason vocabulary judgeCheckoutDepth and judgeLockDivergence already read, carried
    // in `unreadableReason` for judgeLaneLessWorkers to render as UNKNOWN rather than a healthy
    // zero (W1-T3628 design note above).
    return { unreadableReason: classifyReadFailure(error).reason };
  }
}

export function judgeLaneLessWorkers(
  oldestEtimeS: number | undefined,
  count: number,
  unreadableReason?: string,
): Check {
  const threshold = `<= ${humanMs(HUNG_WORKER_AGE_S * 1000)} (#2251 HUNG_WORKER_AGE_S, reused not re-derived)`;
  // AN UNREADABLE PROCESS TABLE IS NOT AN EMPTY ONE (W1-T3628). Before this arm had a third state
  // the only caller passed a literal 0, so every host read as "0 worker process(es)" -- including
  // one carrying two `npm ci` stuck 80 minutes. A read that failed must say so, never borrow the
  // healthy answer, exactly as judgeCheckoutDepth's "unreadable" arm does.
  if (unreadableReason !== undefined) {
    return {
      name: "lane-less-workers",
      verdict: "WARN",
      measured: `worker count UNKNOWN — ${unreadableReason}`,
      threshold,
      detail: "the process table could not be read — do not read this as a host with no workers",
    };
  }
  if (count === 0 || oldestEtimeS === undefined) {
    return { name: "lane-less-workers", verdict: "OK", measured: "0 worker process(es)", threshold };
  }
  return {
    name: "lane-less-workers",
    verdict: oldestEtimeS > HUNG_WORKER_AGE_S ? "WARN" : "OK",
    measured: `${count} worker(s), oldest ${humanMs(oldestEtimeS * 1000)}`,
    threshold,
  };
}

/** Stale git locks, report only — W1-T1036 (#2235) owns reclamation; this prints the lock and
 *  its age and stops there. */
export function judgeStaleGitLocks(locks: ReadonlyArray<{ path: string; ageMs: number }>): Check {
  return {
    name: "git-locks",
    verdict: locks.length > 0 ? "WARN" : "OK",
    measured: locks.length === 0 ? "none" : locks.map((l) => `${l.path} (${humanMs(l.ageMs)})`).join(", "),
    threshold: "no index.lock present",
    ...(locks.length > 0 ? { detail: "W1-T1036 owns reclamation — doctor reports and stops" } : {}),
  };
}

// Why: the docs/operator-guide.md measurement behind this arm — docs/forensics/doctor.md#judgecheckoutdepth.
/**
 * Checkout depth (W1-T2332): a shallow clone breaks every history read silently — `git log -S`,
 * `--follow` and merge-base checks stay plausible over a fraction of the corpus. Report only,
 * like `git-locks` above — `git fetch --unshallow` is the remedy this arm names, never runs.
 * INVARIANT: shallow is FAIL (invisible by construction, one-command remedy); unreadable is WARN
 * "unreadable", never OK (W1-T472 design (v)); full is OK, still naming the commit count.
 * FALSIFIER: test/doctor.test.ts.
 */
export function judgeCheckoutDepth(depth: { shallow: boolean; commitCount: number } | undefined): Check {
  const threshold = "full history (not a shallow clone)";
  if (depth === undefined) {
    return {
      name: "checkout-depth",
      verdict: "WARN",
      measured: "unreadable",
      threshold,
      detail: "the depth read failed — do not read this as a full checkout",
    };
  }
  if (depth.shallow) {
    return {
      name: "checkout-depth",
      verdict: "FAIL",
      measured: `shallow, ${depth.commitCount} commit(s) reachable`,
      threshold,
      detail: "remedy: git fetch --unshallow — doctor reports and stops, nothing here unshallows anything",
    };
  }
  return {
    name: "checkout-depth",
    verdict: "OK",
    measured: `${depth.commitCount} commit(s) reachable`,
    threshold,
  };
}

// Why: the incident that named this record — docs/forensics/doctor.md#worktreebasestate.
/**
 * W1-T2627: `recordWorktreeBase` (worker.ts) writes `<worktree>.base` on every `worktreeAdd` and
 * had zero readers until this arm.
 * INVARIANT: four states, only one a finding — `at-base`/`own-commits` are ordinary; `unrelated`
 * (HEAD does not descend from its base) is the only one worth a look; `base-unknown` (no record,
 * an unreadable HEAD, or a failed ancestry read) must never promote to `unrelated` — the fail-safe
 * direction this repo has fixed twice already (W1-T119, W1-T130).
 * FALSIFIER: test/doctor.test.ts.
 */
export type WorktreeBaseState = "at-base" | "own-commits" | "unrelated" | "base-unknown";

/** Pure: the ancestry read is an injected seam (`isAncestor`) so this classifier is testable
 *  without a real git repository. `isAncestor` returning `undefined` resolves to `base-unknown`,
 *  the same fail-safe direction as an absent `base` or unreadable `head`. */
export function classifyWorktreeBase(
  base: string | null,
  head: string | undefined,
  isAncestor: (base: string, head: string) => boolean | undefined,
): WorktreeBaseState {
  if (base === null || head === undefined) return "base-unknown";
  if (base === head) return "at-base";
  const ancestor = isAncestor(base, head);
  if (ancestor === undefined) return "base-unknown";
  return ancestor ? "own-commits" : "unrelated";
}

/** One live run's already-classified worktree-base reading. `taskId` is the id the run's branch
 *  claims (via {@link taskIdFromRunBranch}, never the lock-file task id), so a mismatch is
 *  legible instead of silently reconciled. */
export interface WorktreeBaseRow {
  runId: string;
  taskId: string | undefined;
  state: WorktreeBaseState;
}

/** One line per live run, naming the branch-claimed task id beside its head classification.
 *  Report only — nothing here reaps, moves or refuses a worktree. `unrelated` is the only state
 *  that moves the verdict, WARN never FAIL (this observes; it does not escalate to
 *  {@link judgeLedgerFreshness}'s daemon-is-down severity). FALSIFIER: test/doctor.test.ts. */
export function judgeWorktreeBases(rows: readonly WorktreeBaseRow[]): Check {
  const name = "worktree-base";
  const threshold = "HEAD is at-base or descends from its recorded base (own-commits)";
  if (rows.length === 0) {
    return { name, verdict: "OK", measured: "0 live worktree(s)", threshold };
  }
  const unrelated = rows.filter((r) => r.state === "unrelated");
  const measured = rows.map((r) => `${r.runId} (${r.taskId ?? "unknown task"}): ${r.state}`).join(", ");
  return {
    name,
    verdict: unrelated.length > 0 ? "WARN" : "OK",
    measured,
    threshold,
    ...(unrelated.length > 0
      ? {
          detail: `HEAD does not descend from its recorded base: ${unrelated.map((r) => r.runId).join(", ")} — report only, nothing here reaps, moves or refuses a worktree`,
        }
      : {}),
  };
}

// Why: the fourteen-minute unacknowledged pause this arm was earned by — docs/forensics/doctor.md#judgepausehonoured.
/** Pause held while dispatch continues. The tick defect is filed as W1-T1065 (#2298) and cited,
 *  not fixed, here — a health command repairing the control it diagnoses is the hazard again. */
export function judgePauseHonoured(pauseAgeMs: number | undefined, lastDispatchAgeMs: number | undefined): Check {
  const threshold = "no dispatch newer than the pause";
  if (pauseAgeMs === undefined) {
    return { name: "pause-honoured", verdict: "OK", measured: "not paused", threshold };
  }
  const measured = `PAUSED ${humanMs(pauseAgeMs)}, last dispatch ${lastDispatchAgeMs === undefined ? "never" : `${humanMs(lastDispatchAgeMs)} ago`}`;
  // A dispatch newer than the pause means the pause was not honoured.
  const ignored = lastDispatchAgeMs !== undefined && lastDispatchAgeMs < pauseAgeMs;
  return {
    name: "pause-honoured",
    verdict: ignored ? "FAIL" : "OK",
    measured,
    threshold,
    ...(ignored ? { detail: "dispatch continued after the pause was requested — W1-T1065 (#2298) files the tick defect; doctor only reports" } : {}),
  };
}

// Why: the f7ceb86 measurement behind this arm — docs/forensics/doctor.md#judgenodeversionpin.
/**
 * Node version pin (R-49, docs/audits/recon-2026-09-05.md): `.nvmrc` pins an exact version, but
 * `npm ci` only warns (EBADENGINE) on a mismatch and lets a stale install through.
 * INVARIANT: WARN, never FAIL — a one-patch drift is not {@link judgeLedgerFreshness}'s
 * daemon-is-down severity. An unreadable `.nvmrc` is WARN "unreadable", never OK.
 * FALSIFIER: test/doctor-node-pin.test.ts.
 */
export function judgeNodeVersionPin(runningVersion: string, pinnedVersion: string | undefined): Check {
  const name = "node-version-pin";
  const threshold = "node version matches .nvmrc";
  const bare = (v: string) => v.replace(/^v/, "").trim();
  const running = bare(runningVersion);
  if (pinnedVersion === undefined) {
    return {
      name,
      verdict: "WARN",
      measured: `running ${running}, .nvmrc unreadable`,
      threshold,
      detail: "the .nvmrc read failed — do not read this as a match",
    };
  }
  const pinned = bare(pinnedVersion);
  if (running !== pinned) {
    return {
      name,
      verdict: "WARN",
      measured: `running ${running}, .nvmrc pins ${pinned}`,
      threshold,
      detail:
        "this host is running a node version .nvmrc does not declare — npm ci only warns (EBADENGINE) on this, " +
        "it never refuses; see .nvmrc",
    };
  }
  return { name, verdict: "OK", measured: `running ${running}, matches .nvmrc`, threshold };
}

// ── readers (I/O only, no judging) ────────────────────────────────────────────────────────────

export interface MemInfo {
  availableBytes?: number;
  totalBytes?: number;
  swapTotalBytes?: number;
}

/**
 * Parse `/proc/meminfo`. Values there are in kB regardless of the unit column, which is why the
 * multiplier is fixed rather than parsed. Returns an empty object on any failure — an unreadable
 * meminfo is a WARN from {@link judgeMemory}, never a crash.
 */
export function parseMemInfo(text: string): MemInfo {
  const read = (key: string): number | undefined => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return m ? Number(m[1]) * 1024 : undefined;
  };
  return { availableBytes: read("MemAvailable"), totalBytes: read("MemTotal"), swapTotalBytes: read("SwapTotal") };
}

export function readMemInfo(readText: (p: string) => string = (p) => readFileSync(p, "utf8")): MemInfo {
  try {
    return parseMemInfo(readText("/proc/meminfo"));
  } catch {
    return {};
  }
}

/**
 * `.nvmrc`'s declared pin, trimmed — `undefined` on any read failure (missing file, unreadable),
 * exactly {@link readMemInfo}'s own catch-to-undefined discipline. `readText` is injectable so
 * {@link judgeNodeVersionPin} is testable with no real filesystem, the same shape as every other
 * reader in this file.
 */
export function readNvmrcVersion(pkgRoot: string, readText: (p: string) => string = (p) => readFileSync(p, "utf8")): string | undefined {
  try {
    return readText(join(pkgRoot, ".nvmrc")).trim();
  } catch {
    // An absent or unreadable .nvmrc is not a mismatch -- judgeNodeVersionPin's own `undefined`
    // branch reports this as "unreadable", never as a healthy match (W1-T472 design (v)).
    return undefined;
  }
}

/** Newest `daemon.`-prefixed row age, via {@link deriveLastPoll}. Since W1-T1274, `runDaemon`'s
 *  loop writes `daemon.tick` into this prefix every iteration, so the age no longer depends on
 *  which ticker window happens to be open. */
export function readLedgerAgeMs(lines: ReadonlyArray<Record<string, unknown>>, nowMs: number): { ageMs?: number; boundMs: number } {
  const poll = deriveLastPoll(lines);
  const parsed = poll.lastPollTs ? Date.parse(poll.lastPollTs) : NaN;
  // Two missed polls is the bound: one missed poll is ordinary jitter, two is a pattern.
  const boundMs = poll.pollIntervalMs * 2;
  return { ...(Number.isFinite(parsed) ? { ageMs: Math.max(0, nowMs - parsed) } : {}), boundMs };
}

/** `daemon.alive` phases, oldest→newest. A reader for a field nothing read before. */
export function readAlivePhases(lines: ReadonlyArray<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (l.step === "daemon.alive" && typeof l.phase === "string") out.push(l.phase);
  }
  return out;
}

/** The `run_id` of the newest `daemon.`-prefixed ledger line — the same winning-row rule
 *  {@link deriveLastPoll} applies for ledger freshness, kept on the full prefix so this and
 *  {@link readLedgerAgeMs} can never disagree on the current run. */
function newestDaemonRunId(lines: ReadonlyArray<Record<string, unknown>>): string | undefined {
  let bestId: string | undefined;
  let bestParsed = -Infinity;
  for (const line of lines) {
    const step = typeof line.step === "string" ? line.step : undefined;
    if (!step || !step.startsWith("daemon.")) continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed) || parsed < bestParsed) continue;
    bestParsed = parsed;
    bestId = typeof line.run_id === "string" ? line.run_id : undefined;
  }
  return bestId;
}

/** `daemon.alive` phases belonging only to the current daemon run, oldest→newest — filtered so a
 *  replaced run's rows (W1-T1099) are never read as the fleet's current liveness. */
export function readCurrentRunAlivePhases(lines: ReadonlyArray<Record<string, unknown>>): string[] {
  const currentRunId = newestDaemonRunId(lines);
  const out: string[] = [];
  for (const l of lines) {
    if (l.step === "daemon.alive" && typeof l.phase === "string" && l.run_id === currentRunId) out.push(l.phase);
  }
  return out;
}

/** Age of `state/PAUSE`, or undefined when the flag is absent. Never writes, never clears. */
export function readPauseAgeMs(root: string, nowMs: number, stat: (p: string) => { mtimeMs: number } = statSync): number | undefined {
  try {
    return Math.max(0, nowMs - stat(pauseFilePath(root)).mtimeMs);
  } catch {
    return undefined;
  }
}

/** `index.lock` files under the repo's git dir, with ages. Report-only input. */
export function readGitLocks(repoRoot: string, nowMs: number, deps: { readdir?: (p: string) => string[]; stat?: (p: string) => { mtimeMs: number } } = {}): Array<{ path: string; ageMs: number }> {
  const readdir = deps.readdir ?? ((p: string) => readdirSync(p));
  const stat = deps.stat ?? statSync;
  const out: Array<{ path: string; ageMs: number }> = [];
  try {
    for (const name of readdir(join(repoRoot, ".git"))) {
      if (name !== "index.lock") continue;
      const p = join(repoRoot, ".git", name);
      out.push({ path: p, ageMs: Math.max(0, nowMs - stat(p).mtimeMs) });
    }
  } catch {
    // An unreadable git dir is not a lock — report nothing rather than inventing a WARN.
  }
  return out;
}

export { readDiskFreeBytes, readDiskTotalBytes };

// ── composition, rendering, and the verb ──────────────────────────────────────────────────────

export interface DoctorReport {
  checks: Check[];
  worst: Verdict;
  exitCode: number;
  text: string;
}

/** One summary line first, short enough for a cron subject or a phone screen, then every check
 *  line prints its measured value beside its threshold. */
export function renderDoctor(checks: readonly Check[]): string {
  const worst = worstVerdict(checks);
  const fails = checks.filter((c) => c.verdict === "FAIL");
  const warns = checks.filter((c) => c.verdict === "WARN");
  const headline =
    worst === "OK"
      ? `rmd doctor: OK — ${checks.length} check(s) passed`
      : `rmd doctor: ${worst} — ${fails.length} fail, ${warns.length} warn: ${[...fails, ...warns].map((c) => c.name).join(", ")}`;
  const lines = [headline, ""];
  for (const c of checks) {
    lines.push(`  [${c.verdict.padEnd(4)}] ${c.name.padEnd(20)} measured: ${c.measured}   threshold: ${c.threshold}`);
    if (c.detail) lines.push(`           ${c.detail}`);
  }
  return lines.join("\n");
}

export interface DoctorInputs {
  nowMs: number;
  ledgerLines: ReadonlyArray<Record<string, unknown>>;
  captureSurfaceFires?: ReadonlyArray<Record<string, unknown>>;
  candidateCount: number;
  dispatchSinceMs?: number;
  dispatchBoundMs?: number;
  dispatchBoundDerivation?: string;
  /** W1-T1209 — candidates disposed `blocked-fixable` in the derived window; defaults to 0. */
  repairDisposedCount?: number;
  repairDispatchSinceMs?: number;
  repairDispatchBoundMs?: number;
  repairDispatchBoundDerivation?: string;
  mem: MemInfo;
  diskFreeBytes?: number;
  /** Total volume size, for the proportional arm of {@link judgeDiskHeadroom}. Absent ⇒ absolute floors only. */
  diskTotalBytes?: number;
  pauseAgeMs?: number;
  totalLocks: number;
  deadLocks: readonly string[];
  locksUnreadableReason?: string;
  gitLocks: ReadonlyArray<{ path: string; ageMs: number }>;
  workerCount: number;
  oldestWorkerEtimeS?: number;
  /** Set only when the process table could not be read — renders UNKNOWN, never zero (W1-T3628). */
  workersUnreadableReason?: string;
  /** W1-T2332 — the checkout's history horizon, measured by the caller. `undefined` means the
   *  read failed; `judgeCheckoutDepth` reports that as unreadable, never a healthy full checkout. */
  checkoutDepth?: { shallow: boolean; commitCount: number };
  /** W1-T2627 — one entry per live in-flight run, already classified by the caller. Defaults to
   *  `[]`, which {@link judgeWorktreeBases} reads as "0 live worktree(s)" — never a finding. */
  worktreeBases?: readonly WorktreeBaseRow[];
  /** R-49 — the running interpreter's own version, measured by the caller like `nowMs` above. */
  runningNodeVersion: string;
  /** R-49 — `.nvmrc`'s declared pin, via {@link readNvmrcVersion}. `undefined` means the read
   *  failed; {@link judgeNodeVersionPin} reports that as unreadable, never a healthy match. */
  nvmrcVersion?: string;
  /** W1-T3665 — every provider `provider-routing-status.ts` has a capacity reading for. Defaults
   *  to `[]`, which {@link judgeProviderCapacityReadable} reads as "no provider capacity read
   *  observed" — never a finding. */
  providerCapacity?: readonly ProviderCapacityReading[];
  /** W1-T3728: a configured cash fallback is useful only if its host credential is readable. */
  cashSpendability?: CashSpendabilityReading;
}

/** A capability reading, deliberately separate from a judgement outcome: fail-open judges retain
 * their safety contract even when the cash provider itself cannot spend. */
export interface CashSpendabilityReading {
  configured: boolean;
  keyPresent: boolean;
}

/** Report a configured-but-unspendable cash lane explicitly; never infer a key from a provider
 * setting, and never emit the key or its path. */
export function judgeCashSpendability(reading: CashSpendabilityReading | undefined): Check {
  const name = "cash-spendability";
  const threshold = "configured cash fallback requires a readable key";
  if (reading === undefined || reading.configured === false) {
    return { name, verdict: "OK", measured: "cash fallback is not configured", threshold };
  }
  if (!reading.keyPresent) {
    return {
      name,
      verdict: "FAIL",
      measured: "cash fallback configured but unspendable: key is absent",
      threshold,
      detail: "The provider capability is unavailable; semantic judges remain fail-open by their own contract.",
    };
  }
  return { name, verdict: "OK", measured: "cash fallback configured and spendable; key present", threshold };
}


// ── Capture-surface liveness (W1-T3348) ───────────────────────────────────────────────────────

/** The five surfaces `buildFeedbackDocket` names in every `counts_by_source`. Restated here
 *  rather than imported so this check keeps judging the surfaces the LEDGER actually reports even
 *  if the docket's own list moves — a rename there must show up as a surface this check stops
 *  seeing, not as a silent pass. */
const CAPTURE_SURFACES = ["reframe", "operator_feedback", "rejected_feedback", "question_answer", "operator_note"] as const;

/** Fires needed before "never fed" is a claim rather than a small sample. */
const CAPTURE_MIN_FIRES = 3;

type CaptureState = "fresh" | "stale" | "never";

/** PRIMARY CONTROL: the marker keeps enough weekly fires to judge, but never grows as a ledger. */
export const CAPTURE_SURFACE_FIRE_HISTORY_LIMIT = 12;

export interface CaptureSurfaceFireRecord extends Record<string, unknown> {
  ts: string;
  step: string;
  window: unknown;
  counts_by_source: Record<string, unknown>;
}

function isCaptureSurfaceFireRecord(v: unknown): v is CaptureSurfaceFireRecord {
  if (!v || typeof v !== "object") return false;
  const row = v as Record<string, unknown>;
  const counts = row.counts_by_source;
  return (
    typeof row.ts === "string" &&
    typeof row.step === "string" &&
    !!counts &&
    typeof counts === "object" &&
    !Array.isArray(counts)
  );
}

export function parseCaptureSurfaceFireHistory(marker: unknown): CaptureSurfaceFireRecord[] {
  if (!marker || typeof marker !== "object") return [];
  const fires = (marker as { recentFires?: unknown }).recentFires;
  if (!Array.isArray(fires)) return [];
  return fires.filter(isCaptureSurfaceFireRecord).slice(-CAPTURE_SURFACE_FIRE_HISTORY_LIMIT);
}

export function appendCaptureSurfaceFireHistory(marker: unknown, fire: CaptureSurfaceFireRecord): CaptureSurfaceFireRecord[] {
  return [...parseCaptureSurfaceFireHistory(marker), fire].slice(-CAPTURE_SURFACE_FIRE_HISTORY_LIMIT);
}

/**
 * W1-T3348 — does the feedback docket's INPUT still carry anything?
 *
 * `state/last-feedback-docket.json` proves only that the weekly rung FIRED. The rung fires whether
 * or not a human ever typed anything, so a cadence marker reads `fresh` over permanently-empty
 * surfaces forever. This judges the surfaces themselves, from the `counts_by_source` the docket
 * already emits on every empty fire — no new sensor, no new write.
 *
 * THREE STATES, NEVER TWO, mirroring `cadenceMarkerRows`' own discipline: `fresh` (carried an item
 * on the most recent fire), `stale` (carried one once, but not on the most recent fire) and
 * `never` (has never carried one). Reporting a never-fed channel as merely stale sends an operator
 * hunting a regression in a channel that has no history to regress from.
 *
 * IT REFUSES RATHER THAN RENDERS. The verdict rides `buildDoctorReport` into `exitCodeFor`, so a
 * dead capture surface makes `rmd doctor` exit non-zero. That is the whole point: a capture loop
 * that stops at reporting rebuilds the failure it is fixing.
 *
 * AND IT NEVER FIRES ON AN UNOBSERVED POPULATION. Below {@link CAPTURE_MIN_FIRES} observed fires
 * the check is OK and SAYS it has not yet judged — this repo's recurring defect is a bound that
 * binds on a healthy condition, and a fresh host has simply not run the rung enough times yet.
 */
export function judgeCaptureSurfaceLiveness(fireHistory: ReadonlyArray<Record<string, unknown>>): Check {
  const countsOf = (row: Record<string, unknown>): Record<string, unknown> | undefined => {
    const c = row.counts_by_source;
    return c && typeof c === "object" ? (c as Record<string, unknown>) : undefined;
  };
  const allFires = fireHistory
    .filter((l) => countsOf(l) !== undefined || l.step === "feedback_docket.empty" || l.step === "feedback_docket.published")
    .sort((a, b) => (String(a.ts ?? "") < String(b.ts ?? "") ? -1 : 1));
  // ONLY A FIRE THAT CARRIES `counts_by_source` CAN WITNESS SILENCE. `feedback_docket.published`
  // rows carry none, and a publish is positive evidence that SOME surface fed — so counting one
  // as a silent fire would let this check report a demonstrably live channel as `never`. MEASURED
  // on the daemon host: both publishes came from `rejected_feedback`, which an all-fires reading
  // called `never`. Unjudgeable fires are NAMED instead, never silently folded in either
  // direction. Giving `.published` its own counts is a separate concern, filed as follow-up.
  const fires = allFires.filter((f) => countsOf(f) !== undefined);
  const unjudgeable = allFires.length - fires.length;
  const unjudgeableNote =
    unjudgeable > 0
      ? ` ${unjudgeable} publish fire(s) carry no per-surface counts and cannot witness silence, so a surface that fed ONLY on those reads never here.`
      : "";
  const threshold = `every surface carries an item within ${CAPTURE_MIN_FIRES} counted docket fires`;

  if (fires.length < CAPTURE_MIN_FIRES) {
    return {
      name: "capture-surfaces",
      verdict: "OK",
      measured: `${fires.length} counted fire(s) of ${allFires.length} observed`,
      threshold,
      detail:
        `not yet judged — a "never fed" claim needs at least ${CAPTURE_MIN_FIRES} counted docket ` +
        `fires, and the retained history holds ${fires.length}. This is an unobserved population, not a ` +
        `healthy one.${unjudgeableNote}`,
    };
  }
  const fedAt = (row: Record<string, unknown>, surface: string): boolean => {
    const n = (countsOf(row) ?? {})[surface];
    return typeof n === "number" && n > 0;
  };

  const newest = fires[fires.length - 1]!;
  const states = new Map<string, CaptureState>();
  for (const surface of CAPTURE_SURFACES) {
    if (fedAt(newest, surface)) states.set(surface, "fresh");
    else if (fires.some((f) => fedAt(f, surface))) states.set(surface, "stale");
    else states.set(surface, "never");
  }

  const never = CAPTURE_SURFACES.filter((s) => states.get(s) === "never");
  const stale = CAPTURE_SURFACES.filter((s) => states.get(s) === "stale");
  const verdict: Verdict = never.length > 0 ? "FAIL" : stale.length > 0 ? "WARN" : "OK";
  // Every surface is NAMED with its own state. A bare count here would be the same vacuous
  // report this check exists to replace.
  const detail = CAPTURE_SURFACES.map((s) => `${s}: ${states.get(s)}`).join(", ");
  const consequence =
    never.length > 0
      ? ` — ${never.length} surface(s) have NEVER carried an item across ${fires.length} counted fires; that channel reaches the docket in name only.${unjudgeableNote}`
      : stale.length > 0
        ? " — every surface has carried something once, but some carried nothing on the most recent fire."
        : "";

  return {
    name: "capture-surfaces",
    verdict,
    measured: `${fires.length} counted fire(s) of ${allFires.length} observed; ${never.length} never, ${stale.length} stale`,
    threshold,
    detail: detail + consequence,
  };
}

// ── Provider capacity readability (W1-T3665) ──────────────────────────────────────────────────

/** One provider window, in the shape both `provider-routing-status.ts` and `account-usage.ts`
 *  already use — restated here, never imported, so this arm stays testable with no daemon, no
 *  credentials and no capacity probe of its own (the same discipline every `judge*` in this file
 *  keeps). */
export interface ProviderCapacityWindowReading {
  name: string;
  usedPercent: number;
  resetsAt?: string;
}

/** One provider's capacity reading, as doctor sees it. */
export interface ProviderCapacityReading {
  provider: string;
  readable: boolean;
  /** How long this provider has read `readable: false` with no intervening readable read, in ms,
   *  ending now. `undefined` means the duration itself is unmeasured — `rmd doctor` keeps no
   *  history of its own between runs — and is judged as WORSE than a known long duration, never
   *  better: a health check that stays quiet until it can prove how long a fault has run recreates
   *  the five days of silence this arm exists to end. */
  unreadableForMs?: number;
  windows: readonly ProviderCapacityWindowReading[];
  reason?: string;
}

/** PRIMARY CONTROL: how long a provider's capacity read may report unreadable before doctor
 *  alarms it, for a caller that DOES track the duration (`rmd doctor` itself does not — see
 *  {@link ProviderCapacityReading.unreadableForMs}, whose own missing-duration default is the
 *  actual backstop for doctor's own read). MEASURED (W1-T3665): codex's `auth.json` `id_token`
 *  expired about an hour after a 2026-09-11 refresh, and every capacity read returned
 *  `readable: false` for the next FIVE DAYS with nothing saying so — the fleet routed 100% of
 *  balanced work to Claude and Claude's weekly reached 44%. Bounded above one bad poll (a network
 *  blip the next poll clears on its own) and far below even one day. */
export const PROVIDER_CAPACITY_UNREADABLE_BOUND_MS = 15 * 60 * 1000; // 15 minutes

/** A window's usage, NAMED WITH ITS DIRECTION, never a bare percentage (W1-T3665): an operator
 *  reading `used_percent: 95` cold took it for 95% REMAINING and acted on that during the
 *  2026-09-16 incident. Every rendering of a provider window below states consumed, remaining,
 *  AND the reset together, so the same misreading cannot happen from this arm's own output. */
function formatCapacityWindow(w: ProviderCapacityWindowReading): string {
  const consumed = Math.max(0, Math.min(100, w.usedPercent));
  const remaining = Math.max(0, 100 - consumed);
  const reset = w.resetsAt ? `, resets ${w.resetsAt}` : ", reset unknown";
  return `${w.name}: ${consumed}% consumed, ${remaining}% remaining${reset}`;
}

/**
 * W1-T3665 — does the fleet's routing auction still see this provider's capacity? `rmd doctor` had
 * NO arm for this at all: codex's capacity reads returned `readable: false` for five straight days
 * while `codex login status` kept printing "Logged in", so the routing auction gave codex no
 * headroom and 100% of balanced work went to Claude — visible only in a daemon log line nobody
 * greps, never in `rmd doctor` or the fleet's heartbeat.
 *
 * REPORT ONLY, the same division every neighbouring arm in this file states: this names the
 * condition, re-authentication (the actual repair, an interactive device-auth flow) stays the
 * operator's.
 *
 * A READABLE provider never raises this arm, however tight its remaining headroom — that is
 * `worker-provider.ts`'s auction to judge, not doctor's; this arm discriminates on readability
 * alone.
 */
export function judgeProviderCapacityReadable(
  providers: readonly ProviderCapacityReading[],
  boundMs: number = PROVIDER_CAPACITY_UNREADABLE_BOUND_MS,
): Check {
  const name = "provider-capacity";
  const threshold = `readable, or unreadable no longer than ${humanMs(boundMs)} (an unmeasured duration counts as breached)`;
  if (providers.length === 0) {
    return { name, verdict: "OK", measured: "no provider capacity read observed", threshold };
  }
  const readings = providers.map((p) =>
    p.readable
      ? `${p.provider}: ${p.windows.length > 0 ? p.windows.map(formatCapacityWindow).join("; ") : "readable, no windows reported"}`
      : `${p.provider}: unreadable for ${p.unreadableForMs === undefined ? "an unmeasured duration" : humanMs(p.unreadableForMs)}${p.reason ? ` (${p.reason})` : ""}`,
  );
  const measured = readings.join(" | ");
  const breaches = providers.filter((p) => !p.readable && (p.unreadableForMs ?? Number.POSITIVE_INFINITY) >= boundMs);
  if (breaches.length === 0) {
    return { name, verdict: "OK", measured, threshold };
  }
  return {
    name,
    verdict: "FAIL",
    measured,
    threshold,
    detail:
      `${breaches.map((b) => b.provider).join(", ")} unreadable beyond ${humanMs(boundMs)} — the routing auction sees ` +
      `no headroom for ${breaches.length === 1 ? "it" : "them"} and silently shifts every balanced request to whichever ` +
      "provider still reads. Re-authentication is the operator's, same division as every neighbouring arm.",
  };
}

/** Assemble every check from already-measured inputs. Pure — no I/O — so the whole check list,
 *  every verdict combination and the exit-code mapping are testable with no filesystem or daemon. */
export function buildDoctorReport(inputs: DoctorInputs): DoctorReport {
  const ledger = readLedgerAgeMs(inputs.ledgerLines, inputs.nowMs);
  const lastDispatchAgeMs = inputs.dispatchSinceMs;
  const sweepRows = readSweepPassSummaryTimestamps(inputs.ledgerLines);
  const checks: Check[] = [
    judgeLedgerFreshness(ledger.ageMs, ledger.boundMs),
    judgeDispatchStall(inputs.candidateCount, inputs.dispatchSinceMs, inputs.dispatchBoundMs, inputs.dispatchBoundDerivation),
    judgeRepairStall(inputs.repairDisposedCount ?? 0, inputs.repairDispatchSinceMs, inputs.repairDispatchBoundMs, inputs.repairDispatchBoundDerivation),
    judgeDispatchStarvation(readCurrentRunAlivePhases(inputs.ledgerLines)),
    judgeSweepLiveness(sweepRows.passesMs, sweepRows.summariesMs, inputs.nowMs),
    judgePauseHonoured(inputs.pauseAgeMs, lastDispatchAgeMs),
    judgeLockDivergence(inputs.totalLocks, inputs.deadLocks, inputs.locksUnreadableReason),
    judgeLaneLessWorkers(inputs.oldestWorkerEtimeS, inputs.workerCount, inputs.workersUnreadableReason),
    judgeStaleGitLocks(inputs.gitLocks),
    judgeCheckoutDepth(inputs.checkoutDepth),
    judgeWorktreeBases(inputs.worktreeBases ?? []),
    judgeDiskHeadroom(inputs.diskFreeBytes, inputs.diskTotalBytes),
    judgeMemory(inputs.mem.availableBytes, inputs.mem.totalBytes, inputs.mem.swapTotalBytes),
    judgeNodeVersionPin(inputs.runningNodeVersion, inputs.nvmrcVersion),
    judgeCaptureSurfaceLiveness(inputs.captureSurfaceFires ?? inputs.ledgerLines),
    judgeProviderCapacityReadable(inputs.providerCapacity ?? []),
    judgeCashSpendability(inputs.cashSpendability),
  ];
  const worst = worstVerdict(checks);
  return { checks, worst, exitCode: exitCodeFor(worst), text: renderDoctor(checks) };
}

/** `--fix` is refused by name, not silently unrecognised, and the message says who owns each
 *  repair. Returns the message, or undefined when the args are acceptable. */
export function refuseUnsupportedArgs(rest: readonly string[]): string | undefined {
  if (rest.includes("--fix")) {
    return [
      "rmd doctor: --fix is refused. doctor is READ-ONLY by design.",
      "  Every repair path already has an owner: #2251 (container recycle), W1-T1036 (git index.lock), W1-T978 (drain.lock).",
      "  A second actor mutating state a live daemon depends on is the measured hazard this refusal exists for.",
    ].join("\n");
  }
  const known = new Set(["--json"]);
  const bad = rest.find((a) => a.startsWith("-") && !known.has(a));
  return bad ? `rmd doctor: unknown argument ${bad}\n  usage: rmd doctor [--json]` : undefined;
}
