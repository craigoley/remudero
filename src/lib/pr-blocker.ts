import { fixedClock } from "./clock.js";

export const PR_BLOCKERS = [
  "awaiting-ci", "own-red", "base-red", "awaiting-review", "review-failed", "awaiting-arm",
  "armed-idle", "conflict", "strikes-exhausted", "escalated", "stale-reviewer-withheld",
  "plan-proof-unrunnable", "held-draft", "other",
] as const;
export type PrBlocker = typeof PR_BLOCKERS[number];

export const PR_BLOCKER_OWNERS = {
  "awaiting-ci": "ci", "own-red": "fix-lane", "base-red": "main-health",
  "awaiting-review": "review-lane", "review-failed": "fix-lane", "awaiting-arm": "arm",
  "armed-idle": "armed-idle-merge", "conflict": "conflict-rebase",
  "strikes-exhausted": "strike-ladder", "escalated": "NONE",
  "stale-reviewer-withheld": "deploy-freshness", "plan-proof-unrunnable": "plan-repair",
  "held-draft": "ready-draft", "other": "NONE",
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
}

export function finalBlocker(ruleBlocker: PrBlocker, facts: BlockerFacts): PrBlocker {
  if (facts.baseRedStandDown || facts.baseCaused) return "base-red";
  if (facts.reviewerCodeStaleThisPass) return "stale-reviewer-withheld";
  if (facts.reviewerEvidenceUnreadable) return "other";
  if (facts.planProofUnrunnable) return "plan-proof-unrunnable";
  if (facts.strikesExhausted) return "strikes-exhausted";
  if (facts.ownRed) return "own-red";
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
