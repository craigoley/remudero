import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { readDiskFreeBytes, readDiskTotalBytes, deriveLastPoll } from "./daemon-health.js";
import { pauseFilePath } from "./fleet-control.js";

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
    judgeLaneLessWorkers(inputs.oldestWorkerEtimeS, inputs.workerCount),
    judgeStaleGitLocks(inputs.gitLocks),
    judgeCheckoutDepth(inputs.checkoutDepth),
    judgeWorktreeBases(inputs.worktreeBases ?? []),
    judgeDiskHeadroom(inputs.diskFreeBytes, inputs.diskTotalBytes),
    judgeMemory(inputs.mem.availableBytes, inputs.mem.totalBytes, inputs.mem.swapTotalBytes),
    judgeNodeVersionPin(inputs.runningNodeVersion, inputs.nvmrcVersion),
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
