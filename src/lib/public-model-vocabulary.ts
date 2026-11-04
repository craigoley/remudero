/**
 * lib/public-model-vocabulary.ts — W1-T10877: THE ONE PLACE AN INTERNAL NAME MEETS A PUBLIC ONE.
 *
 * The public model guidance (disclosure level B, model-guidance-contract-v1) names work only by a
 * closed list of categories and guardrails only by a closed list of classes. Internal lane names
 * and guardrail mechanisms never leave core: a reader maps them here, and an unmapped name reads
 * null, so a new lane or a new mechanism is never published by default.
 */

/** The contract's closed category list, in contract order. */
export const PUBLIC_CATEGORIES = ["repository-change", "code-review", "short-judgment", "summarization",
  "long-context-drafting", "diagnosis-triage"] as const;
export type PublicCategory = (typeof PUBLIC_CATEGORIES)[number];

/** The contract's closed guardrail-class list, in contract order. The first two are properties of every
 *  implementer route (independent review, acceptance checks) and never fire per call. */
export const PUBLIC_GUARDRAIL_CLASSES = ["independent-model-review", "executable-acceptance-checks",
  "schema-validated-output", "deterministic-sampling", "context-and-rate-fit", "output-cap-truncation-check",
  "bounded-retry-then-escalate", "served-model-verification", "strongest-model-for-high-risk",
  "per-lane-budget-cap"] as const;
export type PublicGuardrailClass = (typeof PUBLIC_GUARDRAIL_CLASSES)[number];

/** Every lane name the routing config (its mounts table) or a ledger row carries, mapped explicitly.
 *  null is a decision, not a gap: containment, isolation, smoke, planning and retro work is never published. */
const LANE_CATEGORIES: Readonly<Record<string, PublicCategory | null>> = {
  // Ledger lanes (worker.attempt `lane`, benchmark shape lane, fix rows).
  "run-task": "repository-change", daemon: "repository-change", implement: "repository-change",
  fix: "repository-change", "step-up": "repository-change",
  review: "code-review", reviewer: "code-review",
  "risk-judge": "short-judgment", "ci-judge": "short-judgment", "refresh-judge": "short-judgment",
  "verify-human-judge": "short-judgment", "escalation-judge": "short-judgment",
  "feedback-summary": "summarization", "escalation-summary": "summarization",
  "inbox-draft": "long-context-drafting",
  triage: "diagnosis-triage", diagnose: "diagnosis-triage",
  containment: null, isolation: null, "worker-smoke": null,
  // Routing-config rows with no public category.
  recon: null, manual: null, retro: null, architect: null, judge: null, "machine-filing-judge": null,
};

/** A mount row is spelled with `_` (inbox_draft) and a ledger lane with `-` (inbox-draft); both read one entry. */
function laneKey(lane: string): string {
  return lane.replaceAll("_", "-");
}

/** True only when the table names this lane, to a category or explicitly to null. */
export function laneMappedExplicitly(lane: string): boolean {
  return Object.hasOwn(LANE_CATEGORIES, laneKey(lane));
}

/** The public category of an internal lane; null when the lane is unpublished or unknown. */
export function publicCategoryOfLane(lane: string | null | undefined): PublicCategory | null {
  if (typeof lane !== "string" || !laneMappedExplicitly(lane)) return null;
  return LANE_CATEGORIES[laneKey(lane)] ?? null;
}

/** The internal guardrail signals a reader can observe firing; each is a mechanism, never published. */
export const GUARDRAIL_SIGNALS = ["format-refused", "draft-contract-dirty", "temperature-pin", "fit-refused",
  "per-minute-shortfall", "truncated-reply", "output-retention", "relint-used", "judge-retry", "fix-rounds-exhausted",
  "served-model-unnamed", "subscription-only-refusal", "budget-refusal"] as const;
export type GuardrailSignal = (typeof GUARDRAIL_SIGNALS)[number];

const SIGNAL_CLASSES: Readonly<Record<GuardrailSignal, PublicGuardrailClass>> = {
  "format-refused": "schema-validated-output", "draft-contract-dirty": "schema-validated-output",
  "temperature-pin": "deterministic-sampling",
  "fit-refused": "context-and-rate-fit", "per-minute-shortfall": "context-and-rate-fit",
  "truncated-reply": "output-cap-truncation-check", "output-retention": "output-cap-truncation-check",
  "relint-used": "bounded-retry-then-escalate", "judge-retry": "bounded-retry-then-escalate",
  "fix-rounds-exhausted": "bounded-retry-then-escalate",
  "served-model-unnamed": "served-model-verification",
  "subscription-only-refusal": "strongest-model-for-high-risk",
  "budget-refusal": "per-lane-budget-cap",
};

/** The public class of a guardrail signal; null for a signal this table does not name. */
export function publicGuardrailClassOf(signal: string): PublicGuardrailClass | null {
  return Object.hasOwn(SIGNAL_CLASSES, signal) ? SIGNAL_CLASSES[signal as GuardrailSignal] : null;
}
