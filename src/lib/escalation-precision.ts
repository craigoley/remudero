/**
 * lib/escalation-precision.ts — per-class "did a human actually act on this?" precision (W1-T4677).
 *
 * OBSERVED 2026-09-26..28: 64 false "main is red" escalations fired on #7296, and #7561 alone
 * produced five needs-human issues, every one dismissed by closing the GitHub issue, which
 * `panel.escalation_marked_handled` recorded as nothing but an `issue_url` (panel-actions.ts). With
 * no disposition, no reader can ever learn a class is mostly noise, so the same false alarm keeps
 * paging at the same rate forever.
 *
 * This module owns TWO things: (1) the closed set of dispositions a mark-handled action now MUST
 * choose between (panel-actions.ts's `buildEscalationMarkHandledRoute` validates against it), and
 * (2) the pure arithmetic turning a class's disposed history into an acted-on PRECISION and, from
 * that, the SIGNAL TIER (issue -> digest -> board) its escalations currently deserve. Both are
 * computed fresh off the ledger every call — no persisted "current tier" row, so there is no
 * separate memory for either to drift from.
 *
 * MANUAL and HARD_STOP (escalate.ts's EscalationClass) never demote: a human is required there BY
 * DEFINITION, so a low acted-on rate is evidence the *situation* is rare, not that the *signal* is
 * noisy. Demoting either would quiet the one class this loop is built to never resolve alone.
 *
 * Why: docs/forensics/escalation-precision.md; this task's own rationale/design.
 */

/** The closed set of outcomes a human recording `mark-handled` now MUST choose between — no fifth
 *  value, no free-text substitute. `"acted"` is the only one that counts as a hit for
 *  {@link escalationClassPrecision}; the other three are the operator's own record that the
 *  escalation was noise (false_positive/duplicate) or not yet due (snoozed_until), each a DIFFERENT
 *  shape of "not acted on" a single boolean would collapse. */
export const ESCALATION_DISPOSITIONS = ["acted", "false_positive", "duplicate", "snoozed_until"] as const;
export type EscalationDisposition = (typeof ESCALATION_DISPOSITIONS)[number];

/** Classes a low acted-on precision must never demote — see module doc. Deliberately its OWN closed
 *  set (not imported off `escalate.ts`'s `EscalationClass` type, which is compile-time only and
 *  carries no runtime array) so this module's reasoning for exactly these two stays next to the set
 *  itself rather than split across two files. */
export const NEVER_DEMOTE_CLASSES: ReadonlySet<string> = new Set(["MANUAL", "HARD_STOP"]);

/** Loudest first. A demoted class steps down exactly one tier per {@link escalationClassTier} call
 *  — never straight from `issue` to `board` — because the tier is recomputed fresh off the whole
 *  disposed history each time, so "one step" here means "one step given the CURRENT precision", not
 *  a ratchet that remembers yesterday's tier. */
export const ESCALATION_SIGNAL_TIERS = ["issue", "digest", "board"] as const;
export type EscalationSignalTier = (typeof ESCALATION_SIGNAL_TIERS)[number];

/** Below this acted-on fraction, a class's issues are mostly noise — MEASURED against the incident
 *  this task's rationale cites: #7296's 64 false escalations and #7561's five-issues-for-one-PR both
 *  round to an acted-on precision near zero, nowhere near this line. */
export const LOW_PRECISION_THRESHOLD = 0.34;

/** Below THIS (higher) fraction but at/above {@link LOW_PRECISION_THRESHOLD}, a class is trending
 *  noisy but not yet noise-dominant — the `digest` middle tier, a one-line-per-retro summary rather
 *  than silence or a fresh issue apiece. */
export const HIGH_PRECISION_THRESHOLD = 0.6;

/** Fewer disposed escalations than this and a class's precision is a coin flip, not a signal — it
 *  stays at `issue` (the loudest, safest default) rather than demoting off a handful of samples. */
export const MIN_SAMPLE_FOR_DEMOTION = 5;

/** One class's acted-on precision over a ledger read, with its own sample size so a caller can tell
 *  "we have no evidence yet" (`precision: null`) from "we have evidence and it is exactly zero". */
export interface ClassPrecision {
  class: string;
  /** Disposed `panel.escalation_marked_handled` rows recorded for this class — the denominator. An
   *  issue a human closed on GitHub directly, bypassing mark-handled, carries no disposition and so
   *  is invisible here: 'unrecorded' means "we do not know", never "false positive". */
  sampleSize: number;
  actedCount: number;
  precision: number | null;
}

interface LedgerLineLike {
  step?: unknown;
  class?: unknown;
  disposition?: unknown;
}

function isMarkedHandledRow(line: LedgerLineLike, escalationClass: string): boolean {
  return line.step === "panel.escalation_marked_handled" && line.class === escalationClass && typeof line.disposition === "string";
}

/**
 * Acted-on precision for ONE escalation class over the given ledger lines: `acted` rows over every
 * disposed row for that class (any of the four {@link ESCALATION_DISPOSITIONS}). `precision` is
 * `null`, never `NaN` or `0`, when nothing has been disposed yet — a genuinely different answer from
 * "disposed, and every one of them was noise".
 */
export function escalationClassPrecision(lines: ReadonlyArray<Record<string, unknown>>, escalationClass: string): ClassPrecision {
  let sampleSize = 0;
  let actedCount = 0;
  for (const line of lines) {
    if (!isMarkedHandledRow(line, escalationClass)) continue;
    sampleSize += 1;
    if (line.disposition === "acted") actedCount += 1;
  }
  return { class: escalationClass, sampleSize, actedCount, precision: sampleSize === 0 ? null : actedCount / sampleSize };
}

/** Every class named by a disposed `panel.escalation_marked_handled` row in the ledger, sorted — the
 *  retro's own iteration set, so a demoted class earns its way back the same way it earned its way
 *  down (by the ledger's evidence), never off a hardcoded list this module would otherwise drift
 *  from `escalate.ts`'s `EscalationClass` union. */
export function escalationClassesInLedger(lines: ReadonlyArray<Record<string, unknown>>): string[] {
  const classes = new Set<string>();
  for (const line of lines) {
    if (line.step === "panel.escalation_marked_handled" && typeof line.class === "string" && typeof line.disposition === "string") {
      classes.add(line.class);
    }
  }
  return [...classes].sort();
}

/**
 * The signal tier `escalationClass`'s escalations currently deserve, computed fresh from
 * `precision` (design point iii): `issue` (unchanged default — insufficient evidence, or a
 * never-demote class), `digest` (a per-retro summary line, no fresh issue), or `board` (a board
 * signal only, no issue and no digest line). MANUAL and HARD_STOP always answer `issue` regardless
 * of precision — see module doc.
 */
export function escalationClassTier(escalationClass: string, precision: ClassPrecision): EscalationSignalTier {
  if (NEVER_DEMOTE_CLASSES.has(escalationClass)) return "issue";
  if (precision.precision === null || precision.sampleSize < MIN_SAMPLE_FOR_DEMOTION) return "issue";
  if (precision.precision < LOW_PRECISION_THRESHOLD) return "board";
  if (precision.precision < HIGH_PRECISION_THRESHOLD) return "digest";
  return "issue";
}

/** One class's full signal: its precision AND the tier that precision earns it — the shape a retro
 *  pass (or, today, {@link import("./panel-actions.js").buildEscalationMarkHandledRoute}) reads to
 *  decide whether THIS class still opens an issue at all. */
export interface EscalationClassSignal {
  class: string;
  precision: ClassPrecision;
  tier: EscalationSignalTier;
}

/** One class's signal, in a single call — `escalationClassPrecision` followed by
 *  `escalationClassTier`, since every caller so far wants both together. */
export function escalationClassSignal(lines: ReadonlyArray<Record<string, unknown>>, escalationClass: string): EscalationClassSignal {
  const precision = escalationClassPrecision(lines, escalationClass);
  return { class: escalationClass, precision, tier: escalationClassTier(escalationClass, precision) };
}

/** Every disposed class's signal, sorted by class name — the whole-ledger pass a retro run (design
 *  point ii/iii) walks each cycle to decide which classes currently earn a demotion. */
export function escalationClassSignals(lines: ReadonlyArray<Record<string, unknown>>): EscalationClassSignal[] {
  return escalationClassesInLedger(lines).map((escalationClass) => escalationClassSignal(lines, escalationClass));
}
