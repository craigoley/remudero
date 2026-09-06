// lib/autonomy.ts — the QUANTITY half of the autonomy measurement (W1-T437), sibling to
// verdict-calibration.ts's CORRECTNESS join (W1-T424). Correctness machinery — decideAutoMergeArm,
// the arming ledger, strike counts, breaker gates — answers "was this merge safe"; this module
// answers what fraction of shipped changes needed zero human steering, and what the steered
// remainder cost. {@link zeroTouchMergeRate} is the pure core.

// TWO CORPORA, both injected, no I/O of its own: the merge record ({@link parseTrailerMerges},
// every commit whose body carries an anchored `Remudero-Task: <id>` trailer) and the ledger union
// ({@link mineAutonomyLedgerLines}, read via `resolveLedgerUnion` — archives plus the live file,
// never the live file alone; a missing or partial archive reports the window UNMEASURED rather
// than an undercount from whatever the live file alone held).

// INVARIANT: a merge is zero-touch only when none of classifyRow's six touch signals fire, and
// every firing signal is named on its row — never just the first found.
// INVARIANT: every row is also split by verdict class (full-pass/partial-pass/keyword-floor/
// degraded-arm/unclassified) and by repo ({@link RepoOutcome}; below {@link
// MIN_REPO_POPULATION_FLOOR} rows the rate is refused, never a naked zero).

// NOT IN SCOPE: changing decideAutoMergeArm or any arming policy (a reviewed diff to
// lib/review.ts); verdict-calibration.ts's own correctness measurement; alerting or thresholds.

// FALSIFIER: test/autonomy-ratchet.test.ts and the windowed-union / per-repo sibling suites.
// Why: the corpus derivation, the per-repo split's design argument and every measured incident
// behind these invariants are archived in docs/forensics/autonomy.md#module-header.

import { resolveLedgerUnion, type LedgerGrepFsDeps, type LedgerUnionOptions, type LedgerUnionResult } from "./ledger-grep.js";
import { parseGitEventDump, type GitCommitEvent, type VerdictClass } from "./verdict-calibration.js";

export type { VerdictClass };

/**
 * This module's own fourth verdict-class bucket, added to {@link VerdictClass}: `"partial-pass"` —
 * some but not all executable criteria observed (`partially_executed: true` on `review.posted`).
 * Kept local to autonomy.ts, since this module's quantity report and verdict-calibration.ts's
 * correctness report are deliberately separate measurements.
 * Why: docs/forensics/autonomy.md#autonomyverdictclass (W1-T1020).
 */
export type AutonomyVerdictClass = VerdictClass | "partial-pass";

// ── The merge corpus (the "merge record") ───────────────────────────────────────────────────

/** One trailer-bearing merge, mined from the git log dump. */
export interface MergeRecord {
  taskId: string;
  sha: string;
  /** Committer date, ISO 8601 — the same field {@link GitCommitEvent} carries. */
  ts: string;
}

// Anchored exactly like findMergedByTrailer's own trailer shape: one line, no prefix or suffix.
// Why: docs/forensics/autonomy.md#trailer_re (measured over 1,169+ merged PR bodies).
const TRAILER_RE = /^Remudero-Task:\s*(\S+)\s*$/m;

/** Every trailer-bearing commit in a `parseGitEventDump`-shaped dump — the merge-record half of
 *  this module's two corpora. A commit with no `Remudero-Task:` trailer is silently excluded. */
export function parseTrailerMerges(gitDump: string): MergeRecord[] {
  const merges: MergeRecord[] = [];
  for (const c of parseGitEventDump(gitDump)) {
    const m = TRAILER_RE.exec(c.body);
    if (!m) continue;
    merges.push({ taskId: m[1], sha: c.sha, ts: c.ts });
  }
  return merges;
}

// ── The ledger side ──────────────────────────────────────────────────────────────────────────

/** Every ledger step this module reads, in one `resolveLedgerUnion` pass — same single-read
 *  discipline as `mineVerdictRows`. */
const LEDGER_STEP_PATTERN =
  /"step":"(?:automerge\.armed|automerge\.capped_override_granted|review\.posted|fix\.resolved|fix\.exhausted|fix\.stood_down|ratify\.reframed|panel\.operator_note_added)"/;

function parseLedgerJson(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface AutonomyLedgerMining {
  /** Always set — `ledger.ok === false` is the missing-archive case reported as UNMEASURED. */
  ledger: LedgerUnionResult;
  /** Every matched line, grouped by `task_id`. Empty when `!ledger.ok`. */
  linesByTaskId: ReadonlyMap<string, Record<string, unknown>[]>;
}

/**
 * Mines every touch-relevant ledger line under `stateDir`, over the ledger union — never the live
 * file alone; see the module doc. Pure apart from the injected fs. `opts.since` skips rotations
 * stamped before an instant without opening them; omitted, this reads the same unwindowed union.
 * Why: docs/forensics/autonomy.md#mineautonomyledgerlines (W1-T2484).
 */
export function mineAutonomyLedgerLines(
  stateDir: string,
  fsDeps?: LedgerGrepFsDeps,
  opts: LedgerUnionOptions = {},
): AutonomyLedgerMining {
  const ledger = resolveLedgerUnion(stateDir, LEDGER_STEP_PATTERN, fsDeps, opts);
  if (!ledger.ok) return { ledger, linesByTaskId: new Map() };

  const byTask = new Map<string, Record<string, unknown>[]>();
  for (const raw of ledger.matches) {
    const line = parseLedgerJson(raw);
    if (!line) continue;
    const taskId = typeof line.task_id === "string" ? line.task_id : undefined;
    if (!taskId) continue;
    const arr = byTask.get(taskId);
    if (arr) arr.push(line);
    else byTask.set(taskId, [line]);
  }
  return { ledger, linesByTaskId: byTask };
}

// ── The report ───────────────────────────────────────────────────────────────────────────────

/** One merge, classified. `touches` names EVERY firing touch signal — never just the first —
 *  and is empty exactly when `zeroTouch` is true. */
export interface MergeTouchRow {
  taskId: string;
  sha: string;
  ts: string;
  verdictClass: AutonomyVerdictClass | null;
  zeroTouch: boolean;
  touches: string[];
}

/** Per verdict-class outcome; `"unclassified"` is its own bucket for an unrecoverable class, never guessed. */
export interface ZeroTouchClassOutcome {
  verdictClass: AutonomyVerdictClass | "unclassified";
  total: number;
  zeroTouchCount: number;
  /** `null` when `total === 0` — an empty class prints a count, never a false 0% or 100%. */
  zeroTouchRate: number | null;
}

export interface ZeroTouchMergeRateReport {
  /** `"unmeasured"` when the ledger union could not be read; every other field is a zeroed
   *  placeholder in that state and `reason` is always set. */
  status: "measured" | "unmeasured";
  reason?: string;
  windowDescription: string;
  archiveCount: number;
  liveFileRead: boolean;
  totalMerges: number;
  zeroTouchCount: number;
  touchedCount: number;
  /** `null` when `totalMerges === 0`. */
  zeroTouchRate: number | null;
  rows: MergeTouchRow[];
  classes: ZeroTouchClassOutcome[];
  /** The same rows split by repo instead of verdict class (W1-T2492); with one repo attributed
   *  to every merge, equals the top-level fields exactly. Why: docs/forensics/autonomy.md#module-header. */
  repos: RepoOutcome[];
  /** The current arming posture, printed beside the measured rate; proposes no change to it. */
  armingPosture: string;
}

/** Describes what `decideAutoMergeArm` (lib/review.ts) does today; printed alongside the
 *  measured rate. Moving this policy is a reviewed diff to that function, never a side effect of
 *  reading this report. */
export const CURRENT_ARMING_POSTURE =
  "decideAutoMergeArm arms unconditionally on a full-PASS verdict; also arms — naming the partial " +
  "shape in its reason, never asserting a full PASS — on a PARTIAL-PASS verdict (some but not all " +
  "executable criteria observed, partially_executed) rather than refusing; a CAPPED (zero-proof) " +
  "verdict arms only for a structurally plan-only PR or an explicit, ledgered operator override " +
  "(automerge.capped_override_granted) — otherwise it refuses. This report measures against " +
  "that posture; it changes nothing about it.";

const CLASS_ORDER: readonly (AutonomyVerdictClass | "unclassified")[] = [
  "full-pass",
  "partial-pass",
  "keyword-floor",
  "degraded-arm",
  "unclassified",
];

// ── The per-repo split (W1-T2492) ───────────────────────────────────────────────────────────

/** Sentinel for a `taskId` a supplied `repoOf` could not place — its own row, never dropped. */
export const UNATTRIBUTABLE_REPO = "(unattributable)";

/** Below this many merges, a repo's rate is refused (the count still prints) — this module's
 *  own floor, never imported from verdict-calibration.ts's, since the two measure different
 *  populations. Why: docs/forensics/autonomy.md#min_repo_population_floor. */
export const MIN_REPO_POPULATION_FLOOR = 5;

/** One repo's slice of the rate; `total` is always named, even at 0 or below the floor. */
export interface RepoOutcome {
  repo: string;
  total: number;
  zeroTouchCount: number;
  /** `null` exactly when `rateRefusedReason` is set. */
  zeroTouchRate: number | null;
  /** `"zero-merges"`: nothing merged. `"below-population-floor"`: too little to support a rate.
   *  `"corpus-unmeasured"`: the ledger union was unreadable — `total` still counts, but which
   *  merges were zero-touch could not be determined. */
  rateRefusedReason?: "zero-merges" | "below-population-floor" | "corpus-unmeasured";
}

/** Unattributable sorts last; everything else alphabetically, for a stable, reviewable order. */
function sortRepoKeys(repos: readonly string[]): string[] {
  return [...repos].sort((a, b) => {
    if (a === UNATTRIBUTABLE_REPO) return b === UNATTRIBUTABLE_REPO ? 0 : 1;
    if (b === UNATTRIBUTABLE_REPO) return -1;
    return a.localeCompare(b);
  });
}

function repoOutcomesUnmeasured(
  merges: readonly MergeRecord[],
  repoOf: (taskId: string) => string | undefined,
  knownRepos: readonly string[],
): RepoOutcome[] {
  const totals = new Map<string, number>(knownRepos.map((r) => [r, 0]));
  for (const m of merges) {
    const repo = repoOf(m.taskId) ?? UNATTRIBUTABLE_REPO;
    totals.set(repo, (totals.get(repo) ?? 0) + 1);
  }
  return sortRepoKeys([...totals.keys()]).map((repo) => ({
    repo,
    total: totals.get(repo)!,
    zeroTouchCount: 0,
    zeroTouchRate: null,
    rateRefusedReason: "corpus-unmeasured",
  }));
}

function repoOutcomesMeasured(
  rows: readonly MergeTouchRow[],
  repoOf: (taskId: string) => string | undefined,
  knownRepos: readonly string[],
  minPopulationFloor: number,
): RepoOutcome[] {
  const buckets = new Map<string, { total: number; zeroTouch: number }>(knownRepos.map((r) => [r, { total: 0, zeroTouch: 0 }]));
  for (const row of rows) {
    const repo = repoOf(row.taskId) ?? UNATTRIBUTABLE_REPO;
    let b = buckets.get(repo);
    if (!b) {
      b = { total: 0, zeroTouch: 0 };
      buckets.set(repo, b);
    }
    b.total += 1;
    if (row.zeroTouch) b.zeroTouch += 1;
  }
  return sortRepoKeys([...buckets.keys()]).map((repo) => {
    const b = buckets.get(repo)!;
    if (b.total === 0) {
      return { repo, total: 0, zeroTouchCount: 0, zeroTouchRate: null, rateRefusedReason: "zero-merges" };
    }
    if (b.total < minPopulationFloor) {
      return { repo, total: b.total, zeroTouchCount: b.zeroTouch, zeroTouchRate: null, rateRefusedReason: "below-population-floor" };
    }
    return { repo, total: b.total, zeroTouchCount: b.zeroTouch, zeroTouchRate: b.zeroTouch / b.total };
  });
}

function verdictClassOf(lines: readonly Record<string, unknown>[]): AutonomyVerdictClass | null {
  const posted = [...lines].reverse().find((l) => l.step === "review.posted");
  if (!posted) return null;
  if (posted.capped === true) return "degraded-arm";
  if (posted.floor_degraded === true) return "keyword-floor";
  // Checked before the catch-all, so a partially-executed row is never mistaken for full-pass.
  if (posted.partially_executed === true) return "partial-pass";
  return "full-pass";
}

function strikeCount(lines: readonly Record<string, unknown>[]): number {
  let max = 0;
  for (const l of lines) {
    if (l.step !== "fix.resolved" && l.step !== "fix.exhausted") continue;
    const n = typeof l.strikes === "number" ? l.strikes : 0;
    if (n > max) max = n;
  }
  return max;
}

/** Zero-touch means none of six signals fired: not auto-armed, a fix-rung strike, a reframe, an
 *  operator note, a capped override, or fix-rung human evidence — each named on the row it fires
 *  for. Why: docs/forensics/autonomy.md#module-header. */
function classifyRow(taskId: string, sha: string, ts: string, lines: readonly Record<string, unknown>[]): MergeTouchRow {
  const touches: string[] = [];

  const armed = lines.some((l) => l.step === "automerge.armed");
  if (!armed) {
    touches.push("merged without an automerge.armed ledger line — not auto-armed");
  }

  const strikes = strikeCount(lines);
  if (strikes > 0) {
    touches.push(`${strikes} fix-rung strike${strikes === 1 ? "" : "s"} spent`);
  }

  const reframeCount = lines.filter((l) => l.step === "ratify.reframed").length;
  if (reframeCount > 0) {
    touches.push(`reframed ${reframeCount} time${reframeCount === 1 ? "" : "s"} before merge`);
  }

  const operatorNoteCount = lines.filter((l) => l.step === "panel.operator_note_added").length;
  if (operatorNoteCount > 0) {
    touches.push(`operator note added (${operatorNoteCount})`);
  }

  const cappedOverride = lines.find((l) => l.step === "automerge.capped_override_granted");
  if (cappedOverride) {
    const by = typeof cappedOverride.by === "string" ? cappedOverride.by : "an operator";
    touches.push(`capped override granted by ${by}`);
  }

  const humanEvidenceCount = lines.filter((l) => l.step === "fix.stood_down" && typeof l.issue_url === "string").length;
  if (humanEvidenceCount > 0) {
    touches.push(`fix rung stood down for human evidence (${humanEvidenceCount})`);
  }

  return { taskId, sha, ts, verdictClass: verdictClassOf(lines), zeroTouch: touches.length === 0, touches };
}

/**
 * Entry export — the name is load-bearing (see the module doc and the acceptance grep). Pure over
 * its two supplied corpora, `merges` and `ledgerMining`; no I/O of its own.
 * FALSIFIER: a mixed window reports the rate with the touched merge's touch named; an unreadable
 * ledger union reports UNMEASURED, never a rate computed from the live file alone.
 * Why: docs/forensics/autonomy.md#zerotouchmergerate.
 */
export function zeroTouchMergeRate(
  merges: readonly MergeRecord[],
  ledgerMining: AutonomyLedgerMining,
  opts: {
    windowDescription?: string;
    /** Attributes a `taskId` to its repo; absent/undefined lands the merge in
     *  {@link UNATTRIBUTABLE_REPO}. Omitted entirely, every merge is unattributable. */
    repoOf?: (taskId: string) => string | undefined;
    /** Repos to report even at zero merges — an onboarded-but-idle repo is a finding, not an
     *  absent row. Omitted, only repos that appear in the corpus are reported. */
    knownRepos?: readonly string[];
    /** Overrides {@link MIN_REPO_POPULATION_FLOOR} — test-only in practice. */
    minRepoPopulationFloor?: number;
  } = {},
): ZeroTouchMergeRateReport {
  const windowDescription = opts.windowDescription ?? `${merges.length} trailer-bearing merge(s) read from git history`;
  const repoOf = opts.repoOf ?? ((): undefined => undefined);
  const knownRepos = opts.knownRepos ?? [];
  const minRepoPopulationFloor = opts.minRepoPopulationFloor ?? MIN_REPO_POPULATION_FLOOR;
  const { ledger, linesByTaskId } = ledgerMining;

  if (!ledger.ok) {
    return {
      status: "unmeasured",
      // NAME THE ARM THAT ACTUALLY FIRED. W1-T444 widened `resolveLedgerUnion`'s `ok` to false on
      // PARTIAL coverage too — a rotation found on disk and unreadable — so a hardcoded
      // "zero archive files" reason would send a reader hunting for missing files that are all
      // present. Same defect class as a ledger row carrying the reason of a different decision.
      reason:
        ledger.unread.length > 0
          ? `${ledger.unread.length} of ${ledger.archiveCount} ledger rotation(s) under ${ledger.stateDir} ` +
            `could not be read (${ledger.unread.join(", ")}) — coverage is PARTIAL, so this window is ` +
            "UNMEASURED rather than a rate over the rotations that happened to open"
          : `zero ledger archive files matched under ${ledger.stateDir} — a live-file-only rate would be an ` +
            "undercount (see lib/ledger-grep.ts's resolveLedgerUnion); this window is UNMEASURED, not a rate " +
            "over the live file alone",
      windowDescription,
      archiveCount: ledger.archiveCount,
      liveFileRead: ledger.liveFileRead,
      totalMerges: merges.length,
      zeroTouchCount: 0,
      touchedCount: 0,
      zeroTouchRate: null,
      rows: [],
      classes: CLASS_ORDER.map((verdictClass) => ({ verdictClass, total: 0, zeroTouchCount: 0, zeroTouchRate: null })),
      repos: repoOutcomesUnmeasured(merges, repoOf, knownRepos),
      armingPosture: CURRENT_ARMING_POSTURE,
    };
  }

  const rows = merges.map((m) => classifyRow(m.taskId, m.sha, m.ts, linesByTaskId.get(m.taskId) ?? []));

  const zeroTouchCount = rows.filter((r) => r.zeroTouch).length;
  const totalMerges = rows.length;

  const buckets = new Map<AutonomyVerdictClass | "unclassified", { total: number; zeroTouch: number }>(
    CLASS_ORDER.map((c) => [c, { total: 0, zeroTouch: 0 }]),
  );
  for (const row of rows) {
    const key = row.verdictClass ?? "unclassified";
    const b = buckets.get(key)!;
    b.total += 1;
    if (row.zeroTouch) b.zeroTouch += 1;
  }
  const classes: ZeroTouchClassOutcome[] = CLASS_ORDER.map((verdictClass) => {
    const b = buckets.get(verdictClass)!;
    return {
      verdictClass,
      total: b.total,
      zeroTouchCount: b.zeroTouch,
      zeroTouchRate: b.total === 0 ? null : b.zeroTouch / b.total,
    };
  });

  return {
    status: "measured",
    windowDescription,
    archiveCount: ledger.archiveCount,
    liveFileRead: ledger.liveFileRead,
    totalMerges,
    zeroTouchCount,
    touchedCount: totalMerges - zeroTouchCount,
    zeroTouchRate: totalMerges === 0 ? null : zeroTouchCount / totalMerges,
    rows,
    classes,
    repos: repoOutcomesMeasured(rows, repoOf, knownRepos, minRepoPopulationFloor),
    armingPosture: CURRENT_ARMING_POSTURE,
  };
}
