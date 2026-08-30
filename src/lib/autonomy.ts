// lib/autonomy.ts — THE QUANTITY HALF (W1-T437), sibling to lib/verdict-calibration.ts's
// CORRECTNESS join (W1-T424).
//
// THE GAP THIS CLOSES. `decideAutoMergeArm` and the arming ledger, strike counts and breaker
// gates are all CORRECTNESS machinery — they answer "was this merge safe". Nothing answers the
// QUANTITY question Warp's factory framing puts first: what fraction of shipped changes went
// out with ZERO human steering, and what did the steered remainder cost. This module is that
// number: {@link zeroTouchMergeRate}, pure over an injected merge corpus and ledger union.
//
// THE CORPUS: every commit on the target ref whose body carries an anchored
// `Remudero-Task: <id>` trailer (this repo's own PR-body convention — see
// `findMergedByTrailer`'s measured anchor `^Remudero-Task: <id>$`), read from the SAME git-log
// dump shape `defaultVerdictCalibrationGitLog` (run-task.ts) already produces —
// {@link parseTrailerMerges} runs over `lib/verdict-calibration.ts`'s `parseGitEventDump`
// output, so this module adds no new git plumbing.
//
// THE TOUCH SIGNALS, each named on the row it fires for (never collapsed into a bare boolean):
//   - not auto-armed: no `automerge.armed` ledger line for the task at all — the merge shipped
//     by some path {@link import("./review.js").decideAutoMergeArm} never blessed.
//   - fix-rung strikes: a `fix.resolved` or `fix.exhausted` line naming `strikes > 0` — a worker
//     needed at least one automated repair round. (Strikes are dispatched fix WORKERS, not a
//     human hand — but design note (i) counts them as a touch because a strike-bearing merge
//     needed MORE than the first pass, which is exactly the "cost" half of the dial; see the
//     module's own falsifier test for why this reads correctly against "zero human steering":
//     a strike is machine-only, but it is not zero-cost, and the rate this module reports is
//     framed as ZERO-TOUCH, not zero-strike — see {@link MergeTouchRow.touches}' wording.)
//   - reframe: a `ratify.reframed` line for the task — an operator sent the proposal back for
//     rework before it shipped.
//   - operator note: a `panel.operator_note_added` line for the task — an operator hand-authored
//     guidance into this task's run.
//   - capped override: an `automerge.capped_override_granted` line for the task — an operator
//     explicitly approved arming a CAPPED (zero-proof) verdict.
//   - fix-rung human evidence: a `fix.stood_down` line carrying `issue_url` — the fix rung
//     detected a foreign (human) push mid-strike and stood down rather than clobbering it.
//
// A row with NONE of the above is zero-touch. A row with any of them is human-touched, and
// EVERY firing touch is named on it — never just the first one found (design (iv)'s falsifier:
// "deleting the touch attribution fails this").
//
// THE ZGROUP-UNION LESSON, STRUCTURAL: {@link mineAutonomyLedgerLines} reads the ledger through
// `lib/ledger-grep.ts`'s `resolveLedgerUnion` — archives + live file, never the live file alone.
// When zero archive files are found, {@link zeroTouchMergeRate} reports the WHOLE window
// UNMEASURED, naming the missing-archive reason, rather than silently computing a rate over
// whatever the live file alone happened to hold — the same undercount `resolveLedgerUnion`'s own
// module doc measured at 3.1x.
//
// SPLIT BY VERDICT CLASS (design (ii)): every row is also classified `full-pass` /
// `keyword-floor` / `degraded-arm` (or `null` when no `review.posted` line for the task could be
// found), reusing lib/verdict-calibration.ts's exact three-way vocabulary — the class split is
// what makes the number actionable, because it says where the next ratchet notch is safe: a
// zero-touch rate over full-PASS proof-executed merges is a different trust signal than one over
// capped/override merges.
//
// THE RATCHET IS AN OPERATOR ACT, NOT THIS MODULE'S: {@link CURRENT_ARMING_POSTURE} is a fixed
// description of what `decideAutoMergeArm` does TODAY, printed alongside the measured rate so a
// reader can see posture and evidence side by side — this module changes no policy, writes no
// policy file, and proposes no threshold.
//
// NOT IN SCOPE: changing decideAutoMergeArm or any arming policy; W1-T424's revert-join
// correctness measurement (that is the quality of what shipped; this is the quantity that
// shipped untouched); alerting or thresholds on the rate.

import { resolveLedgerUnion, type LedgerGrepFsDeps, type LedgerUnionOptions, type LedgerUnionResult } from "./ledger-grep.js";
import { parseGitEventDump, type GitCommitEvent, type VerdictClass } from "./verdict-calibration.js";

export type { VerdictClass };

/**
 * W1-T1020: this module's OWN extension of `verdict-calibration.ts`'s three-way
 * {@link VerdictClass} vocabulary with a fourth bucket — `"partial-pass"`, a row whose
 * `review.posted` line carries `partially_executed: true` (SOME but not ALL executable
 * criteria observed). Local to autonomy.ts, never added to `verdict-calibration.ts` itself:
 * that module's own correctness-join corpus and this module's quantity report are deliberately
 * separate measurements (see this module's header doc), and widening the shared three-way type
 * would ripple into verdict-calibration.ts's report shape for no reason this task asked for.
 * Before this, a partially-executed row fell through `verdictClassOf`'s `capped`/`floor_degraded`
 * checks into the catch-all `"full-pass"` return — indistinguishable from a review that actually
 * observed every executable criterion.
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

/** Anchored exactly like `findMergedByTrailer`'s own measured form (`^Remudero-Task: <id>$`,
 *  one trailer line, no prefix/suffix noise) — MEASURED over 1,169+ merged PR bodies elsewhere
 *  in this repo's own history as the trailer's real shape. */
const TRAILER_RE = /^Remudero-Task:\s*(\S+)\s*$/m;

/**
 * Extract every trailer-bearing commit from a `parseGitEventDump`-shaped dump — the "merge
 * record" half of this module's two corpora. A commit with no `Remudero-Task:` trailer line in
 * its body is silently excluded (it is not a trailer-bearing merge, not a malformed one).
 */
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

/** Every ledger step this module reads, matched in ONE `resolveLedgerUnion` pass (the same
 *  single-read discipline `mineVerdictRows` uses for its own two steps). */
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
  /** ALWAYS set — unlike a "nothing to look for" skip, this module always attempts the read;
   *  `ledger.ok === false` is exactly the missing-archive case this module's UNMEASURED verdict
   *  reports honestly. */
  ledger: LedgerUnionResult;
  /** Every matched line, grouped by `task_id`. Empty when `!ledger.ok`. */
  linesByTaskId: ReadonlyMap<string, Record<string, unknown>[]>;
}

/**
 * Mine every touch-relevant ledger line under `stateDir`, over the ledger UNION (never the live
 * file alone — see the module doc). Pure apart from the injected fs.
 *
 * `opts.since` (W1-T2484) is this module's proof of `resolveLedgerUnion`'s new window parameter:
 * a caller who only wants merges from some instant onward can pass it straight through, and any
 * rotation stamped before it is skipped WITHOUT being opened (see `LedgerUnionOptions.since` and
 * `ledger-grep.ts`'s module doc for why that skip cannot drop a matching row). OMITTED, this
 * reads the same unwindowed union it always has — the eight other `resolveLedgerUnion` callers
 * are deliberately left unconverted (see this repo's W1-T2484 plan record) and stay correct
 * exactly because the parameter is optional.
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

/** Per verdict-class outcome — `verdictClass` is `"unclassified"` for rows whose
 *  `review.posted` line could not be recovered, kept as its OWN bucket rather than folded into
 *  any of the four real classes (a guess would misreport which class the ratchet is safe to
 *  move). */
export interface ZeroTouchClassOutcome {
  verdictClass: AutonomyVerdictClass | "unclassified";
  total: number;
  zeroTouchCount: number;
  /** `null` when `total === 0` — an empty class prints a count, never a false 0% or 100%. */
  zeroTouchRate: number | null;
}

export interface ZeroTouchMergeRateReport {
  /** `"unmeasured"` when the ledger union could not be read (zero archive files) — see the
   *  module doc's zgrep-union lesson. Every other field is a zeroed/empty placeholder in that
   *  state; `reason` is always set. */
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
  /** Design (iii): the rendering names the current arming posture beside the measured rate —
   *  this module proposes no change to it. */
  armingPosture: string;
}

/** Printed verbatim alongside the rate (design (iii)) — describes what `decideAutoMergeArm`
 *  (lib/review.ts) does TODAY. Moving this policy is a reviewed diff to that function, never a
 *  side effect of reading this report. */
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

function verdictClassOf(lines: readonly Record<string, unknown>[]): AutonomyVerdictClass | null {
  const posted = [...lines].reverse().find((l) => l.step === "review.posted");
  if (!posted) return null;
  if (posted.capped === true) return "degraded-arm";
  if (posted.floor_degraded === true) return "keyword-floor";
  // W1-T1020: SOME but not ALL executable criteria observed — checked before the catch-all so a
  // partially-executed row is never indistinguishable from a fully-observed full-pass.
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
 * ENTRY EXPORT (the name is load-bearing — see the module doc and the acceptance grep). PURE
 * over its two supplied corpora: `merges` (from {@link parseTrailerMerges}) and
 * `ledgerMining` (from {@link mineAutonomyLedgerLines}) — no I/O of its own.
 *
 * FALSIFIER-shaped by construction (design (iv)): a window with one auto-armed strike-free merge
 * and one reframed merge reports 50% with the reframed merge's touch NAMED; a window whose
 * ledger union could not be read (`ledgerMining.ledger.ok === false`) reports UNMEASURED with
 * the missing-archive reason, never a rate computed from the live file alone.
 */
export function zeroTouchMergeRate(
  merges: readonly MergeRecord[],
  ledgerMining: AutonomyLedgerMining,
  opts: { windowDescription?: string } = {},
): ZeroTouchMergeRateReport {
  const windowDescription = opts.windowDescription ?? `${merges.length} trailer-bearing merge(s) read from git history`;
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
    armingPosture: CURRENT_ARMING_POSTURE,
  };
}
