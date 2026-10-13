/**
 * lib/escalation-triage.ts — who decides whether an escalation needs the operator (W1-T8868).
 *
 * The residual escalation judge ({@link import("./escalate.js").judgeEscalation}) can only say
 * deliver | demote, and only the fix-rung producers ever ask it. This module is the wider question,
 * answered for EVERY escalation at the one funnel (`escalate.ts`): is it
 *   - `auto_resolve` — a reversible executor from a CLOSED set can act on it, or
 *   - `digest`       — the operator rarely acts on this class (escalation-precision.ts's tier), or
 *   - `deliver`      — it needs the operator.
 *
 * DETERMINISTIC RULES DECIDE FIRST. The model judge only ever sees the REMAINDER, and only chooses
 * between `digest` and `deliver` — it can never select an action, because the only value it can
 * hand {@link triageEscalation} is an {@link EscalationJudgeVerdict} (`deliver | demote`), which is
 * mapped onto `digest | deliver` and is ignored entirely once a rule has decided.
 *
 * THE POLARITY is the judge's own: when in doubt, DELIVER. MANUAL and HARD_STOP are operator-owned
 * by definition and are never auto-resolved and never digested; an unreadable input, a thrown rule
 * or a failed executor all land on `deliver`.
 *
 * This file is PURE (no I/O, no ledger): `escalate.ts` supplies the evidence, acts on the outcome,
 * and ledgers it. SHADOW MODE (the shipped default) ledgers the would-be outcome and still delivers.
 */

import type { EscalationSignalTier } from "./escalation-precision.js";

/** The CLOSED set of reversible executors an auto-resolve may name. No fifth value, no free text. */
export const TRIAGE_ACTIONS = ["feedback_reply", "plan_amendment_pr", "rekick_once", "apply_default"] as const;
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

/** `shadow` ledgers the would-be outcome and still delivers; `act` follows the outcome. */
export type EscalationTriageMode = "shadow" | "act";

/** The structural slice of an escalation triage reads. Declared here (not imported from escalate.ts)
 *  so this module stays dependency-free; `Escalation` satisfies it. */
export interface TriageSubject {
  readonly class: "BLOCKED" | "MANUAL" | "HARD_STOP" | "GRILL";
  readonly taskId: string;
  readonly summary: string;
  readonly detail: string;
  readonly recommendation: string;
}

/** The model judge's verdict, as `escalate.ts` already types it. Only its `decision` is read. */
export interface TriageModelVerdict {
  readonly decision: "demote" | "deliver";
  readonly reason: string;
}

/** What the caller knows that the escalation text does not. Every field is optional: an absent field
 *  means that rule does not fire, never that it fires by default. */
export interface TriageEvidence {
  /** escalation-precision's tier for this class (`issue` = the operator usually acts). */
  readonly classTier?: EscalationSignalTier;
  /** `shouldApplyDefault` said yes for this question (seen, and its adaptive window has passed). */
  readonly defaultApplies?: boolean;
  /** The failure behind a block is NEW since the last strike, and this head/contract revision has
   *  been re-kicked `priorRekicks` times already. */
  readonly rekick?: { readonly newFailureSinceLastStrike: boolean; readonly priorRekicks: number };
}

export type TriageOutcome =
  | { readonly kind: "auto_resolve"; readonly action: TriageAction; readonly reason: string; readonly decidedBy: "rule" }
  | { readonly kind: "digest"; readonly reason: string; readonly decidedBy: "rule" | "model" }
  | { readonly kind: "deliver"; readonly reason: string; readonly decidedBy: "rule" | "model" | "default" };

/** Classes that always reach the operator: never auto-resolved, never digested. */
const OPERATOR_OWNED: ReadonlySet<string> = new Set(["MANUAL", "HARD_STOP"]);

/** A triage GRILL whose `ALREADY_DECIDED` citation did not resolve and whose recommendation is to
 *  file the request as a task — the one grill whose answer is already computed (triage.ts's
 *  `unresolvedCitationGrill`). */
function isUnresolvedCitationGrill(e: TriageSubject): boolean {
  return (
    e.class === "GRILL" &&
    e.recommendation === "file-as-task" &&
    e.detail.includes("ALREADY_DECIDED was claimed but") &&
    /\bfeedback#\S+/.test(e.summary)
  );
}

/** A stale-proof refusal (pr-open.ts): a filed proof already passes at the merge base and the
 *  recommendation is a plan-only proof amendment. */
function isStaleProofRefusal(e: TriageSubject): boolean {
  return (
    e.class === "BLOCKED" &&
    e.recommendation === "amend-proof" &&
    e.summary.includes("a filed proof already passes at the merge base")
  );
}

/** The deterministic rules, first match wins. Returns undefined for the REMAINDER. */
function ruleOutcome(e: TriageSubject, evidence: TriageEvidence): TriageOutcome | undefined {
  if (isUnresolvedCitationGrill(e)) {
    return {
      kind: "auto_resolve",
      action: "feedback_reply",
      decidedBy: "rule",
      reason: "the ALREADY_DECIDED citation did not resolve and the recommendation is file-as-task",
    };
  }
  if (isStaleProofRefusal(e)) {
    return {
      kind: "auto_resolve",
      action: "plan_amendment_pr",
      decidedBy: "rule",
      reason: "a stale-proof refusal whose recommendation is a plan-only proof amendment",
    };
  }
  if (evidence.rekick && evidence.rekick.newFailureSinceLastStrike && evidence.rekick.priorRekicks === 0) {
    return {
      kind: "auto_resolve",
      action: "rekick_once",
      decidedBy: "rule",
      reason: "the failure is new since the last strike and this head has not been re-kicked",
    };
  }
  if (evidence.defaultApplies === true) {
    return {
      kind: "auto_resolve",
      action: "apply_default",
      decidedBy: "rule",
      reason: "a question with a recommendation, seen and past its adaptive window",
    };
  }
  if (evidence.classTier === "digest" || evidence.classTier === "board") {
    return {
      kind: "digest",
      decidedBy: "rule",
      reason: `the precision tier for ${e.class} is ${evidence.classTier}: the operator rarely acts on this class`,
    };
  }
  return undefined;
}

/**
 * Triage ONE escalation. Total: it never throws; any failure is a `deliver`.
 *
 * Order: operator-owned classes → deterministic rules → the model's verdict (remainder only) →
 * `deliver`. With no `modelVerdict` the remainder is `deliver` with `decidedBy: "default"`, which is
 * how a caller learns the model is worth asking.
 */
export function triageEscalation(
  e: TriageSubject,
  evidence: TriageEvidence = {},
  modelVerdict?: TriageModelVerdict,
): TriageOutcome {
  try {
    if (OPERATOR_OWNED.has(e.class)) {
      return { kind: "deliver", decidedBy: "rule", reason: `${e.class} is operator-owned by rule` };
    }
    const byRule = ruleOutcome(e, evidence);
    if (byRule) return byRule;
    if (modelVerdict?.decision === "demote") {
      return { kind: "digest", decidedBy: "model", reason: modelVerdict.reason };
    }
    if (modelVerdict?.decision === "deliver") {
      return { kind: "deliver", decidedBy: "model", reason: modelVerdict.reason };
    }
    return { kind: "deliver", decidedBy: "default", reason: "no rule applied and no model verdict" };
  } catch (err) {
    return {
      kind: "deliver",
      decidedBy: "default",
      reason: `triage failed (${err instanceof Error ? err.message : String(err)}) — delivering`,
    };
  }
}

/** The model is worth asking only when no rule decided and the class is not operator-owned. */
export function triageNeedsModel(e: TriageSubject, evidence: TriageEvidence = {}): boolean {
  const first = triageEscalation(e, evidence);
  return first.kind === "deliver" && first.decidedBy === "default";
}

// ── Policy (plan/policy.yaml `escalationTriage:`) ──────────────────────────────────────────

/** BACKSTOP: at most this many auto-resolves per pass — the design guardrail; the parser clamps any policy value to it. */
export const DEFAULT_MAX_AUTO_RESOLVES_PER_PASS = 5;

export interface EscalationTriagePolicy {
  readonly mode: EscalationTriageMode;
  readonly maxAutoResolvesPerPass: number;
}

export const DEFAULT_ESCALATION_TRIAGE_POLICY: EscalationTriagePolicy = {
  mode: "shadow",
  maxAutoResolvesPerPass: DEFAULT_MAX_AUTO_RESOLVES_PER_PASS,
};

/** Parse an already-yaml-parsed `plan/policy.yaml` mapping's OPTIONAL `escalationTriage:` block. Pure.
 *  Absent → shadow. A present block that is unreadable also yields shadow (never `act` by accident). */
export function parseEscalationTriagePolicy(root: unknown): EscalationTriagePolicy {
  const block = (root as { escalationTriage?: unknown } | null | undefined)?.escalationTriage;
  if (block === null || typeof block !== "object") return DEFAULT_ESCALATION_TRIAGE_POLICY;
  const { mode, maxAutoResolvesPerPass } = block as Record<string, unknown>;
  const cap =
    typeof maxAutoResolvesPerPass === "number" && Number.isInteger(maxAutoResolvesPerPass) && maxAutoResolvesPerPass >= 0
      ? Math.min(maxAutoResolvesPerPass, DEFAULT_MAX_AUTO_RESOLVES_PER_PASS)
      : DEFAULT_MAX_AUTO_RESOLVES_PER_PASS;
  return { mode: mode === "act" ? "act" : "shadow", maxAutoResolvesPerPass: cap };
}

/** One pass's auto-resolve allowance. Mutable by design: a pass shares ONE of these. */
export interface TriagePass {
  readonly max: number;
  used: number;
}

export function newTriagePass(max: number = DEFAULT_MAX_AUTO_RESOLVES_PER_PASS): TriagePass {
  return { max, used: 0 };
}

/** Take one auto-resolve from the pass; false once the cap is spent. */
export function takeAutoResolve(pass: TriagePass): boolean {
  if (pass.used >= pass.max) return false;
  pass.used += 1;
  return true;
}
