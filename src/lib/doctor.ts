import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { readDiskFreeBytes, deriveLastPoll } from "./daemon-health.js";
import { pauseFilePath } from "./fleet-control.js";

/**
 * W1-T1047 — `rmd doctor`: ONE local, read-only command that answers "is the fleet healthy" and
 * returns an exit code that means something.
 *
 * THREE CONSTRAINTS, EACH FROM A MEASURED FAILURE, EACH A REFUSAL RATHER THAN A PREFERENCE:
 *  - CLI-SIDE, NOT CONSOLE. `remudero-serve` was `Exited (137)` for over a day by operator
 *    decision. A check living behind `buildDaemonHealthRoute` is useless when the web service is
 *    the thing that broke.
 *  - NO NETWORK. The shared API budget was exhausted ten times in two days and the operator was
 *    locked out of his own repository for ninety minutes. A check that calls GitHub fails on
 *    exactly the condition it exists to report. Every reader below touches the ledger, `state/`,
 *    `plan/`, `/proc` or `ps` — nothing calls `gh`.
 *  - NO HEALTHY DAEMON REQUIRED. Nothing here awaits a tick, takes a lock, or writes a byte. A
 *    DOWN DAEMON IS NOT AN ERROR CONDITION, IT IS THE DIAGNOSIS: no process, no recent ledger row
 *    and no lock is a complete, printable answer, and the exit code says FAIL without the command
 *    itself failing.
 *
 * READ-ONLY, AND `--fix` IS REFUSED RATHER THAN UNIMPLEMENTED. Every repair path already has an
 * owner — #2251 for the container recycle, W1-T1036 for the git lock, W1-T978 for `drain.lock` —
 * and a SECOND ACTOR MUTATING STATE A LIVE DAEMON DEPENDS ON is the hazard this repo has already
 * measured. {@link doctorCommand} rejects the flag by name and says who owns the repair.
 *
 * WHY THE DECIDERS ARE PURE AND SEPARATE FROM THE READERS. Every `judge*` function below takes
 * already-measured numbers and returns a verdict; every reader does I/O and no judging. That split
 * is not tidiness — a refusal arm reachable only through a real `/proc` read or a real `ps` call is
 * a line no test can cover, and `diff-coverage` blocks a diff whose added lines have no covering
 * test. Each arm is therefore reachable by calling one pure function with one set of numbers, and
 * each has a paired positive control in `test/doctor.test.ts`.
 */

export type Verdict = "OK" | "WARN" | "FAIL";

/**
 * One check's result. `measured` and `threshold` are BOTH required and both human-readable,
 * because the output contract is that no check ever prints a bare verdict — the same discipline
 * `boundDerivation` already applies to the queue-head stall bound. A verdict with no number beside
 * it is what makes a health command cry wolf.
 */
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

/**
 * 0 / 1 / 2 by worst verdict. DELIBERATELY DISTINCT FROM `statusCommand`'s bad-argument 2: a
 * doctor arg error exits 64 (`EX_USAGE`), so a cron reading exit 2 always means "a check FAILED"
 * and never "you typed the flag wrong".
 */
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

/**
 * LEDGER FRESHNESS — the single best liveness signal, and the reason is structural: `docker logs`
 * narrates ACTIONS and goes silent between them, so a quiet log is ambiguous. FAIL past the bound
 * rather than WARN, because a stale ledger is the daemon being gone.
 *
 * W1-T1274 — "`daemon.`-prefixed rows do not stop while the daemon lives" WAS ASSERTED HERE AND
 * WAS FALSE: MEASURED, the prefix went silent for 102.5 minutes on 2026-08-23 while the daemon
 * stayed alive and productive across the gap, because the only RECURRING `daemon.`-prefixed
 * emitter (`daemon.alive`, a ticker) only runs inside three windows (retro, full sweep, dispatch
 * settling) — every stretch of the loop outside those three wrote nothing with this prefix at
 * all. What makes the sentence true now is `daemon.ts`'s `runDaemon` loop: it writes an
 * UNCONDITIONAL `daemon.tick` row as the literal first statement of every iteration, on every
 * path (idle, paused, dispatching, sweeping, or returning early at this very check) — so the
 * corpus below (still every `daemon.`-prefixed row, never narrowed to `daemon.tick` alone or to a
 * `run_id`, per rationale (7)/(8)) is never silent for longer than about one poll interval while
 * the loop is turning, regardless of which ticker window happens to be open.
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

/**
 * DISK HEADROOM. The thresholds are the measured incident, not round numbers: this host reached
 * 55MiB free with a live daemon on it, and at that point ordinary commands failed to write their
 * own stdout. FAIL is set an order of magnitude above where that happened so the warning arrives
 * with time to act, and WARN above that again.
 */
export const DISK_FAIL_BYTES = 512 * 1024 * 1024;
export const DISK_WARN_BYTES = 2 * 1024 * 1024 * 1024;

export function judgeDiskHeadroom(freeBytes: number | undefined): Check {
  const threshold = `WARN < ${humanBytes(DISK_WARN_BYTES)}, FAIL < ${humanBytes(DISK_FAIL_BYTES)}`;
  if (freeBytes === undefined) {
    return { name: "disk-headroom", verdict: "WARN", measured: "unreadable", threshold };
  }
  const verdict: Verdict = freeBytes < DISK_FAIL_BYTES ? "FAIL" : freeBytes < DISK_WARN_BYTES ? "WARN" : "OK";
  return { name: "disk-headroom", verdict, measured: humanBytes(freeBytes), threshold };
}

/**
 * MEMORY AND SWAP — the one genuinely new reader in the list, and it reads `/proc/meminfo`,
 * NEVER THE CGROUP LIMIT. This container is unlimited, so `memory.max` reads the literal string
 * `max` and would report unbounded headroom on a host that had already frozen. The measured freeze
 * was ~4% available with ZERO swap, and because a reclaim livelock never arms the OOM killer,
 * nothing was logged and no other signal existed — which is why swap being absent is part of the
 * judgement rather than a footnote.
 */
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

/**
 * ELIGIBLE POOL VERSUS DISPATCH AGE. The bound is NOT a guessed round figure — it comes from this
 * host's own observed dispatch cadence, and the caller passes both it and the derivation string so
 * the printed threshold explains itself. A non-empty eligible pool sitting past that bound is the
 * shape that renders identically to a healthy queue in `rmd status`, which is the defect.
 */
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

/**
 * W1-T1209 — REPAIR-RUNG STALL. `fix.dispatch` read ZERO for twenty-one hours on 2026-08-22 while
 * the sweep kept disposing open pull requests `blocked-fixable` every pass — ten dispatches threw,
 * `dispatchFix` swallowed its own throw and recorded `acted: true`, and that seeded the fix-rung
 * dedup gate that then stood down every retry. Nothing anywhere said the repair rung was down; a
 * human found it by reading the board.
 *
 * THE FAULT IS A CONJUNCTION, EXACTLY LIKE {@link judgeDispatchStall}, AND FOR THE SAME REASON: a
 * gap in `fix.dispatch` only means something when the sweep chose `blocked-fixable` in the SAME
 * window. An empty repair queue is the healthy state, and an arm that cries wolf on a quiet board
 * trains the operator to ignore the one instrument that would have caught the real outage.
 *
 * THE BOUND IS A CALLER-SUPPLIED, DERIVED NUMBER — NEVER A CONSTANT HERE. Exactly like
 * `judgeDispatchStall`, this function never guesses a ceiling; it prints whatever bound and
 * derivation string the caller measured from this host's own `fix.dispatch` cadence, which is the
 * constraint design note (ii) of this task states as a refusal, not a preference (see W1-T1099's
 * sibling arm, whose printed threshold once disagreed with its own predicate).
 *
 * REPORT ONLY. This arm dispatches nothing, clears no gate and escalates nothing — the contention
 * (W1-T1129), the swallow (W1-T1127) and the light-hook suppression are each separately owned.
 */
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

/**
 * DISPATCH LIVENESS — a READER for a field that is emitted and read by nothing. `daemon.alive`
 * carries `phase`, and a window with no `dispatch` phase among it — WHATEVER the other phases
 * are, not only a hardcoded `sweep` — is a daemon that is awake but never dispatching. WARN, not
 * FAIL: a genuinely empty queue produces the same shape, so this is a prompt to look, not a
 * verdict on its own. CALLERS MUST PASS ONLY THE CURRENT RUN'S PHASES (see
 * {@link readCurrentRunAlivePhases}) — this function trusts its input and does not itself filter
 * by `run_id` (W1-T1099).
 *
 * ZERO ROWS IS NOT THE SAME AS "TOO FEW TO JUDGE": a live daemon that has entered no rung this
 * run writes no `daemon.alive` row at all (the ticker wraps a rung's body, not the tick), so an
 * empty window means the arm has no evidence either way and must say so — OK would be a
 * false-green one level below the run-boundary defect this task also fixes (W1-T1099 design iii).
 */
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

/**
 * W1-T1236 — SWEEP LIVENESS. `sweep.pass` (`src/lib/sweep.ts`, "PER-PASS HEARTBEAT, WRITTEN
 * BEFORE THE LOOP") is written before `runSweep`'s per-PR loop runs, exactly so a pass that throws
 * mid-loop still leaves a row — and nothing read it. `sweep.pass` appeared nowhere in this file,
 * `ledger.ts`, `status.ts`, `status-board.ts` or `ops.ts` before this arm; every plan reference to
 * it is a human reading the ledger by hand, which is precisely the discovery latency this closes.
 * The measured incident is `sweep.ts`'s own doc comment: a 23.5-minute gap in `sweep.summary` on
 * 2026-08-05 that CONTAINS four `sweep.disposed` rows — passes were starting and dying mid-loop,
 * and PR #1348 opened and closed entirely inside the blind window.
 *
 * TWO FAULTS, ONE ARM, BOTH DERIVED OFF ROWS THAT ALREADY EXIST — never a new emit, a pass id, or
 * a correlation between rows (that would drag in `sweep.ts`, which is W1-T1238's file):
 *  (a) PASSES NOT STARTING — the newest `sweep.pass` is older than a bound DERIVED from this
 *      host's own observed `sweep.pass` cadence, exactly like {@link judgeDispatchStall}'s
 *      `boundDerivation`: never a guessed round figure.
 *  (b) PASSES STARTING AND NOT FINISHING, the case the row was positioned for — the newest
 *      `sweep.pass` has no `sweep.summary` AT OR AFTER its own timestamp, paired BY TIME ORDER.
 *
 * ZERO ROWS IS WARN, NEVER OK AND NEVER FAIL — {@link judgeDispatchStarvation}'s own precedent
 * verbatim: a fleet that has never swept, a freshly-rotated ledger, and a sweep blind for longer
 * than the retention window all present as zero `sweep.pass` rows, and a false-green OK here
 * reproduces the exact 2026-08-05 window nobody noticed. THE STALE-BOUND AND NO-SUMMARY FAULTS ARE
 * ALSO WARN, NEVER FAIL, on W1-T1209's own reasoning: doctor OBSERVES, and any automatic
 * remediation of a blind sweep is a separate decision this arm does not make.
 *
 * THE BOUNDARY MARKER IS WHAT MAKES W1-T1237 POSSIBLE. {@link SWEEP_LIVENESS_STEPS} names every
 * ledger step this arm reads in ONE exported Set, read through `.has(step)` in {@link
 * readSweepPassSummaryTimestamps} rather than two loose string comparisons — mirroring `board.ts`'s
 * `OPERATOR_ACTION_STEPS` for the identical reason `test/ledger-render-retention.test.ts` records:
 * a blanket `.step ===` scan of this file would sweep up every unrelated step it already compares
 * (`daemon.alive`, `fix.dispatch`, ...) and demand retention for all of them.
 */
export const SWEEP_LIVENESS_STEPS: ReadonlySet<string> = new Set(["sweep.pass", "sweep.summary"]);

/** How much this arm multiplies the longest OBSERVED gap between `sweep.pass` rows by to derive
 *  its staleness bound — the identical multiplier and reasoning `status-board.ts`'s
 *  `QUEUE_HEAD_STALL_MULTIPLIER` already applies to `run.start` dispatch cadence. Re-derived here
 *  rather than imported: that constant keys on a different step, and this task's design confines
 *  every new input to a fold over `doctor.ts`'s own already-injected `ledgerLines`. */
export const SWEEP_STALL_MULTIPLIER = 3;

/**
 * `sweep.pass`/`sweep.summary` timestamps (parsed ms, oldest-order not required), read through
 * {@link SWEEP_LIVENESS_STEPS} — the ONLY place in this file either string literal appears. A line
 * with no parseable `ts` is skipped rather than corrupting the derived cadence, the same
 * discipline `status-board.ts`'s `deriveDispatchCadence` already applies to `run.start`.
 */
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

/**
 * REPORT ONLY, exactly like every sibling arm above: this function returns a {@link Check} and
 * nothing else — no dispatch, no gate clear, no restart. Calling it twice with the same inputs
 * yields a byte-identical result, the same purity-as-proof-of-no-action shape {@link
 * judgeRepairStall}'s own test relies on.
 */
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
    // every sweep.pass at the same instant leaves no gap to learn a cadence from — fall through
    // with boundMs left undefined rather than fabricate a zero bound.
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

  // PAIRED BY TIME ORDER, NOT A CORRELATION ID (design note (2b)): the newest pass is "finished"
  // once ANY sweep.summary lands at or after it — adding a pass id would change sweep.ts's own
  // emit, which is W1-T1238's file and a different concern.
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

/**
 * LOCK VERSUS PROCESS DIVERGENCE. An inflight lock whose pid is gone is a run that died without
 * releasing. WARN and report only — W1-T978 owns `drain.lock` reclamation and #2251 owns the
 * recycle; doctor names the divergence and stops.
 */
export function judgeLockDivergence(totalLocks: number, deadLocks: readonly string[], unreadableReason?: string): Check {
  // AN UNREADABLE DIR IS NOT AN EMPTY ONE, and conflating them is a FAIL-OPEN in a health check:
  // a permissions fault that HIDES every lock would otherwise read as "0 locks, all healthy". An
  // absent dir genuinely is zero locks (a fleet that has never dispatched), so only that case is
  // silently fine; anything else reports that lock state is UNKNOWN.
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

/**
 * Classify a filesystem read failure into "genuinely absent" versus "could not be read".
 *
 * EXTRACTED AND PURE so both arms are reachable from a test without arranging a real EACCES. This
 * is the same class of defect a sibling task found today: `spawnSync` returns `status: null` on a
 * signalled child and the classifier read it as success. The shape here is a `catch` that cannot
 * tell ENOENT from EPERM and answers "nothing there" to both.
 */
export function classifyReadFailure(e: unknown): { absent: boolean; reason: string } {
  const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "";
  if (code === "ENOENT") return { absent: true, reason: "ENOENT" };
  return { absent: false, reason: code || String((e as Error)?.message ?? e) };
}

/**
 * LANE-LESS WORKERS. The threshold is #2251's `HUNG_WORKER_AGE_S`, REUSED rather than re-derived
 * and deliberately NOT lowered — that PR states its own derivation and this task must not
 * second-guess it. Reuse here means reusing the number and its reasoning; the matcher itself lives
 * in shell, which is a cost named up front rather than discovered.
 */
export const HUNG_WORKER_AGE_S = 7200;

export function judgeLaneLessWorkers(oldestEtimeS: number | undefined, count: number): Check {
  const threshold = `<= ${humanMs(HUNG_WORKER_AGE_S * 1000)} (#2251 HUNG_WORKER_AGE_S, reused not re-derived)`;
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

/**
 * STALE GIT LOCKS — REPORT ONLY. W1-T1036 (#2235) owns the reclamation entirely; this prints the
 * lock and its age and stops there, which is the whole of its mandate.
 */
export function judgeStaleGitLocks(locks: ReadonlyArray<{ path: string; ageMs: number }>): Check {
  return {
    name: "git-locks",
    verdict: locks.length > 0 ? "WARN" : "OK",
    measured: locks.length === 0 ? "none" : locks.map((l) => `${l.path} (${humanMs(l.ageMs)})`).join(", "),
    threshold: "no index.lock present",
    ...(locks.length > 0 ? { detail: "W1-T1036 owns reclamation — doctor reports and stops" } : {}),
  };
}

/**
 * CHECKOUT DEPTH (W1-T2332). A shallow canonical checkout breaks every history read SILENTLY —
 * `git log -S`, `--follow`, merge-base checks all stay plausible while computed over a fraction
 * of the corpus (`docs/operator-guide.md`'s own measurement: a 120-commit clone answered ZERO
 * deletions for a file deleted before its horizon, with the "does this query return rows" control
 * passing loudly). The only prior detector in the fleet was `defaultMergeEvidenceLog` /
 * `defaultVerdictCalibrationGitLog` REFUSING BY NAME — an earned, correct guard that only speaks
 * when a linter that happens to need history runs. This arm asks the question when nobody needed
 * an answer.
 *
 * REPORT ONLY, LIKE `git-locks` ABOVE. `git fetch --unshallow` is the remedy this arm NAMES,
 * never runs — an automatic unshallow at boot is exactly the second-actor-mutating-state hazard
 * `rmd doctor --fix` is refused by name over.
 *
 * shallow ⇒ FAIL, naming the reachable commit count and the remedy command. FAIL rather than WARN
 * is deliberate: the fault is invisible by construction and the remedy is one command.
 * unreadable (no git, not a repository, a throw — the caller passes `undefined`) ⇒ WARN
 * "unreadable", NEVER OK: a read that FAILED reporting as a read that SAID NO is the class
 * W1-T472 design (v) names and this repo has now measured eight times.
 * full ⇒ OK, still naming the commit count so the horizon is legible even when it is fine — the
 * operator-guide's own prescription, applied where a reader already looks.
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

/**
 * PAUSE HELD WHILE DISPATCH CONTINUES. Earned on 2026-08-20: the operator held a pause for
 * fourteen minutes with no acknowledgement and reasonably concluded the control was dead. The
 * underlying tick defect is filed as W1-T1065 (#2298) and is CITED, NOT FIXED here — doctor
 * reports "PAUSED, N minutes, last dispatch M minutes ago" and nothing more, because a health
 * command that repairs the control it is diagnosing is the second-actor hazard again.
 */
export function judgePauseHonoured(pauseAgeMs: number | undefined, lastDispatchAgeMs: number | undefined): Check {
  const threshold = "no dispatch newer than the pause";
  if (pauseAgeMs === undefined) {
    return { name: "pause-honoured", verdict: "OK", measured: "not paused", threshold };
  }
  const measured = `PAUSED ${humanMs(pauseAgeMs)}, last dispatch ${lastDispatchAgeMs === undefined ? "never" : `${humanMs(lastDispatchAgeMs)} ago`}`;
  // A dispatch NEWER than the pause means the pause was not honoured: its age exceeds the
  // dispatch's, so the dispatch happened after the flag went down.
  const ignored = lastDispatchAgeMs !== undefined && lastDispatchAgeMs < pauseAgeMs;
  return {
    name: "pause-honoured",
    verdict: ignored ? "FAIL" : "OK",
    measured,
    threshold,
    ...(ignored ? { detail: "dispatch continued after the pause was requested — W1-T1065 (#2298) files the tick defect; doctor only reports" } : {}),
  };
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
 * Newest `daemon.`-prefixed row age, via the already-exported {@link deriveLastPoll}. Since
 * W1-T1274, `runDaemon`'s loop (`daemon.ts`) writes an unconditional `daemon.tick` row into this
 * SAME prefix on every iteration, so the age this returns no longer depends on which of the three
 * `daemon.alive` ticker windows (retro/full-sweep/dispatch-settling) happens to be open.
 */
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

/**
 * The `run_id` of the newest `daemon.`-prefixed ledger line, by parsed `ts` — the SAME
 * winning-row rule {@link deriveLastPoll} already applies for ledger freshness, re-applied here
 * only to read that row's `run_id` rather than its `ts`. Every `daemon.`-prefixed line already
 * carries `run_id`, so no new ledger FIELD is needed here — but W1-T1274 DOES add a new emitter
 * (`daemon.tick`, into this same `daemon.`-prefixed corpus, `daemon.ts`), and deliberately moves
 * this function's predicate in lockstep with {@link readLedgerAgeMs}'s: both stay keyed on the
 * full `daemon.`-prefix (never narrowed to `daemon.tick` alone, never widened to a bare `run_id` —
 * W1-T1274 rationale (7)/(8)), so the two checks can never disagree about which run is current.
 */
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

/**
 * `daemon.alive` phases belonging ONLY to the current daemon run, oldest→newest —
 * {@link readAlivePhases}'s rows filtered to {@link newestDaemonRunId}. A replaced run's rows
 * (a daemon that stopped cleanly and was superseded) are never read as if they belonged to the
 * run that is live now — that was the second defect W1-T1099 fixes: judging a dead run's phases
 * as the fleet's current liveness.
 */
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

export { readDiskFreeBytes };

// ── composition, rendering, and the verb ──────────────────────────────────────────────────────

export interface DoctorReport {
  checks: Check[];
  worst: Verdict;
  exitCode: number;
  text: string;
}

/**
 * ONE SUMMARY LINE FIRST, short enough for a cron subject or a phone screen — the operator's most
 * common question all day was simply whether it was running, and a wall of sections does not
 * answer that on a phone. Every check line then prints its measured value BESIDE its threshold.
 */
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
  candidateCount: number;
  dispatchSinceMs?: number;
  dispatchBoundMs?: number;
  dispatchBoundDerivation?: string;
  /** W1-T1209 — repair-rung stall. Candidates disposed `blocked-fixable` in the derived window;
   *  defaults to 0 (no evidence of a fault) for callers that do not yet supply a real count, which
   *  is the fail-closed-toward-quiet direction design note (iii) requires: an arm that cannot see
   *  the disposals must never invent a FAIL. */
  repairDisposedCount?: number;
  repairDispatchSinceMs?: number;
  repairDispatchBoundMs?: number;
  repairDispatchBoundDerivation?: string;
  mem: MemInfo;
  diskFreeBytes?: number;
  pauseAgeMs?: number;
  totalLocks: number;
  deadLocks: readonly string[];
  locksUnreadableReason?: string;
  gitLocks: ReadonlyArray<{ path: string; ageMs: number }>;
  workerCount: number;
  oldestWorkerEtimeS?: number;
  /** W1-T2332 — the canonical checkout's history horizon, measured by the caller (this module
   *  never touches the filesystem, per the file header). `undefined` means the read failed —
   *  `judgeCheckoutDepth` reports that as unreadable, never as a healthy full checkout. */
  checkoutDepth?: { shallow: boolean; commitCount: number };
}

/**
 * Assemble every check from already-measured inputs. PURE — no I/O — so the whole check list,
 * every verdict combination and the exit-code mapping are testable without a filesystem, a
 * `/proc`, a `ps`, or a daemon.
 */
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
    judgeLaneLessWorkers(inputs.oldestWorkerEtimeS, inputs.workerCount),
    judgeStaleGitLocks(inputs.gitLocks),
    judgeCheckoutDepth(inputs.checkoutDepth),
    judgeDiskHeadroom(inputs.diskFreeBytes),
    judgeMemory(inputs.mem.availableBytes, inputs.mem.totalBytes, inputs.mem.swapTotalBytes),
  ];
  const worst = worstVerdict(checks);
  return { checks, worst, exitCode: exitCodeFor(worst), text: renderDoctor(checks) };
}

/**
 * `--fix` IS REFUSED BY NAME, not silently unrecognised, and the refusal says WHO owns each repair
 * so the operator is pointed somewhere rather than stopped. Returns the message, or undefined when
 * the args are acceptable.
 */
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
