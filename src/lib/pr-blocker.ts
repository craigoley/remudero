import { fixedClock } from "./clock.js";

export const PR_BLOCKERS = [
  "awaiting-ci", "own-red", "base-red", "awaiting-review", "review-failed", "awaiting-arm",
  "armed-idle", "conflict", "strikes-exhausted", "escalated", "stale-reviewer-withheld",
  "plan-proof-unrunnable", "held-draft", "operator-hold", "other",
] as const;
export type PrBlocker = typeof PR_BLOCKERS[number];

export const PR_BLOCKER_OWNERS = {
  "awaiting-ci": "ci", "own-red": "fix-lane", "base-red": "main-health",
  "awaiting-review": "review-lane", "review-failed": "fix-lane", "awaiting-arm": "arm",
  "armed-idle": "armed-idle-merge", "conflict": "conflict-rebase",
  "strikes-exhausted": "strike-ladder", "escalated": "NONE",
  "stale-reviewer-withheld": "deploy-freshness", "plan-proof-unrunnable": "plan-repair",
  "held-draft": "ready-draft", "operator-hold": "operator", "other": "NONE",
} as const satisfies Record<PrBlocker, string>;

export interface BlockerFacts {
  baseRedStandDown?: boolean;
  baseCaused?: boolean;
  reviewerCodeStaleThisPass?: boolean;
  reviewerEvidenceUnreadable?: boolean;
  mergeable?: boolean;
  autoMergeArmed?: boolean;
  planProofUnrunnable?: boolean;
  strikesExhausted?: boolean;
  ownRed?: boolean;
  /** A green, reviewed PR an operator merge hold stands over (W1-T1000002): it is waiting on a person, not on arming. */
  operatorHold?: boolean;
  /** A fix dispatch the backstop holds at this head after escalating: no lane can move it, so it is
   *  escalated — never the `conflict-rebase` or `fix-lane` owner that is not going to act (#10551). */
  dispatchHeld?: boolean;
}

export function finalBlocker(ruleBlocker: PrBlocker, facts: BlockerFacts): PrBlocker {
  if (facts.baseRedStandDown || facts.baseCaused) return "base-red";
  if (facts.reviewerCodeStaleThisPass) return "stale-reviewer-withheld";
  if (facts.reviewerEvidenceUnreadable) return "other";
  if (facts.planProofUnrunnable) return "plan-proof-unrunnable";
  if (facts.strikesExhausted) return "strikes-exhausted";
  if (facts.dispatchHeld) return "escalated";
  if (facts.ownRed) return "own-red";
  if (facts.mergeable && facts.operatorHold) return "operator-hold";
  if (facts.mergeable) return facts.autoMergeArmed ? "armed-idle" : "awaiting-arm";
  return ruleBlocker;
}

export interface PriorBlocker {
  blocker: PrBlocker;
  since?: string;
  sinceSource?: "first-seen";
}

export function priorBlockersFromLedger(lines: readonly Record<string, unknown>[]): Map<number, PriorBlocker> {
  const byPr = new Map<number, PriorBlocker>();
  for (const row of lines) {
    if (row.step !== "sweep.disposed" || typeof row.pr_number !== "number" ||
        !PR_BLOCKERS.includes(row.blocker as PrBlocker)) continue;
    const since = typeof row.blocker_since === "string" && Number.isFinite(Date.parse(row.blocker_since))
      ? row.blocker_since : undefined;
    byPr.set(row.pr_number, {
      blocker: row.blocker as PrBlocker, since,
      ...(row.blocker_since_source === "first-seen" ? { sinceSource: "first-seen" } : {}),
    });
  }
  return byPr;
}

export function blockerFields(blocker: PrBlocker, prior: PriorBlocker | undefined, now: number,
  planRepairCapable = false) {
  const continues = prior?.blocker === blocker && prior.since !== undefined;
  const since = continues ? prior.since! : fixedClock(now).iso();
  const source = continues ? prior.sinceSource : prior?.since === undefined ? "first-seen" : undefined;
  return {
    blocker,
    blocker_owner: blocker === "plan-proof-unrunnable" && !planRepairCapable ? "NONE" : PR_BLOCKER_OWNERS[blocker],
    blocker_since: since,
    blocker_age_ms: Math.max(0, now - Date.parse(since)),
    ...(source ? { blocker_since_source: source } : {}),
  };
}

/** W1-T5690 — the clock every blocker answers to. A blocker older than this takes the next rung. */
export const BLOCKER_SLO_MS = 45 * 60_000;
export const SLO_RUNGS = ["refresh", "rebuild", "digest"] as const;
export type SloRung = typeof SLO_RUNGS[number];
/** BACKSTOP: the ladder's lifetime rebuild cap (strike-ladder.ts `rebuildsSoFar < 2`), restated for
 *  the SLO. It fires only after two rebuilds have already failed; the per-UTC-day cap is the gate. */
export const MAX_SLO_REBUILDS = 2;
const MS_PER_UTC_DAY = 86_400_000;

/** The blockers a blocked-ambiguous source can carry. Each has the SLO as its deadline. */
export const SLO_CLIMBING_BLOCKERS: readonly PrBlocker[] = [
  "awaiting-ci", "strikes-exhausted", "escalated", "conflict", "plan-proof-unrunnable", "other",
];

/** `no-op-hold` is `strikes-exhausted` with the repeated-refusal reason: another fix round adds no
 *  information, so the climb starts at `rebuild`. `ladder-hold` is a `decideStrikeLadderRung` hold. */
export type SloReasonClass = "no-op-hold" | "ladder-hold" | "other";

export interface SloRungTaken {
  rung: SloRung;
  atMs: number;
  /** True when the rung was already taken at the head (refresh: main tip) this decision is about. */
  atThisHead: boolean;
}

export interface SloRungInput {
  blocker: PrBlocker;
  owner: string;
  reasonClass: SloReasonClass;
  blockerAgeMs: number;
  /** Every rung row for the task/PR, across heads; the rebuild caps read all of it. */
  rungHistory: readonly SloRungTaken[];
  nowMs: number;
  /** Rungs the caller cannot take right now (e.g. refresh with main unreadable). Never digest. */
  unavailable?: readonly SloRung[];
}

export interface SloRungDecision {
  rung: SloRung | "none";
  reason: string;
  deadlineMs: number;
}

export const utcDayOf = (ms: number): number => Math.floor(ms / MS_PER_UTC_DAY);

/** Pure: does this blocker, at this age, take a rung? Under the SLO nothing; over it, the next of
 *  refresh -> rebuild -> digest not already taken at this head. Rebuild is skipped past the lifetime
 *  cap and when one already ran for the task this UTC day. */
export function decideSloRung(input: SloRungInput): SloRungDecision {
  const deadlineMs = BLOCKER_SLO_MS;
  const none = (reason: string): SloRungDecision => ({ rung: "none", reason, deadlineMs });
  if (!SLO_CLIMBING_BLOCKERS.includes(input.blocker) && input.owner !== "NONE") {
    return none(`blocker ${input.blocker} is owned by ${input.owner}; the owner's lane acts`);
  }
  if (!Number.isFinite(input.blockerAgeMs) || input.blockerAgeMs < deadlineMs) {
    return none(`blocker ${input.blocker} is inside its ${deadlineMs / 60_000} minute SLO`);
  }
  const taken = new Set(input.rungHistory.filter(h => h.atThisHead).map(h => h.rung));
  const unavailable = new Set(input.unavailable ?? []);
  const rebuilds = input.rungHistory.filter(h => h.rung === "rebuild");
  const rebuildRefusal = rebuilds.length >= MAX_SLO_REBUILDS
    ? `lifetime cap of ${MAX_SLO_REBUILDS} rebuilds reached`
    : rebuilds.some(h => utcDayOf(h.atMs) === utcDayOf(input.nowMs))
      ? "a rebuild already ran for this task today (UTC); one per task per day" : undefined;
  const start = input.reasonClass === "no-op-hold" ? SLO_RUNGS.indexOf("rebuild") : 0;
  const skipped: string[] = [];
  for (const rung of SLO_RUNGS.slice(start)) {
    if (taken.has(rung)) { skipped.push(`${rung} already taken at this head`); continue; }
    if (unavailable.has(rung)) { skipped.push(`${rung} unavailable`); continue; }
    if (rung === "rebuild" && rebuildRefusal) { skipped.push(`rebuild refused: ${rebuildRefusal}`); continue; }
    const age = Math.floor(input.blockerAgeMs / 60_000);
    return {
      rung, deadlineMs,
      reason: `${input.blocker} for ${age} minutes (SLO ${deadlineMs / 60_000})` +
        `${input.reasonClass === "no-op-hold" ? "; a no-op hold enters at rebuild" : ""}` +
        `${skipped.length ? `; ${skipped.join("; ")}` : ""}`,
    };
  }
  return none(`every rung already taken or refused: ${skipped.join("; ")}`);
}
