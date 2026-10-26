/**
 * lib/inbox-owner.ts (W1-T4086) — who must act on an inbox item: the operator, or the fleet.
 *
 * On 2026-09-22 the live registry held 674 proposals and about 54 needed a person: 53
 * `verify-human` (a judge says the task still needs someone) and one `ruling`. The other 620 were
 * findings the fleet produced about itself — adoption debt, proof debt, follow-up harvests, skill
 * drafts, CodeQL debt, rule efficacy, feedback dockets, and verify-human tasks a judge already
 * cleared for automation — and `GET /v1/inbox` showed every one of them as the operator's to
 * approve. This answers the question the route never asked.
 *
 * An UNKNOWN kind is the operator's: a new producer is seen by a person before anything automates
 * it, never silently moved out of sight.
 */

/** Kinds whose fix is fleet work — the proposal is a finding the fleet made about itself. */
const FLEET_KINDS: ReadonlySet<string> = new Set([
  "adoption",
  "followup",
  "proof-debt",
  "skill-draft",
  "codeql-quality",
  "rule-efficacy",
  "verify-human-automate",
]);

/** A proposal id's kind: the text before its first `:`. Feedback-docket ids (`FD-<date>-<slug>`)
 *  carry no colon, so they are named by their `FD-` prefix instead. */
export function inboxKind(proposalId: string): string {
  if (/^FD-\d{4}-\d{2}-\d{2}-/.test(proposalId)) return "feedback-docket";
  const colon = proposalId.indexOf(":");
  return colon === -1 ? proposalId : proposalId.slice(0, colon);
}

/** Source facts, not a display id alone, can establish that a finding is information. */
export interface InboxOwnershipEvidence {
  id: string;
  summary?: unknown;
  originatingItemId?: unknown;
  trigger?: unknown;
  reframeHistory?: unknown;
  requiresReview?: unknown;
}

/** W1-T10431: only the producer's exact PR-age observation is informational. Missing,
 * ambiguous or human-directed evidence remains an ask. This is NOT execution permission. */
export function isAgeOnlyInboxInformation(proposal: InboxOwnershipEvidence): boolean {
  if (proposal.trigger !== undefined ||
      (proposal.requiresReview !== undefined && proposal.requiresReview !== false) ||
      (proposal.reframeHistory !== undefined && (!Array.isArray(proposal.reframeHistory) || proposal.reframeHistory.length !== 0))) return false;
  const identity = /^board-review:stale:(PR-[1-9]\d*|#[1-9]\d*)$/.exec(proposal.id);
  const referent = identity?.[1];
  if (!referent || identity?.[0] !== proposal.id || proposal.originatingItemId !== referent || typeof proposal.summary !== "string") return false;
  const observation = /^board-review: (PR-[1-9]\d*|#[1-9]\d*) has sat open ((?:0|[1-9]\d*)\.\d)h, past the ((?:0|[1-9]\d*)(?:\.\d+)?)h depth threshold$/.exec(proposal.summary);
  if (!observation || observation[0] !== proposal.summary || observation[1] !== referent) return false;
  const age = Number(observation[2]), threshold = Number(observation[3]);
  return Number.isFinite(age) && Number.isFinite(threshold) && threshold > 0 && age >= threshold;
}

export function inboxOwner(proposal: InboxOwnershipEvidence): "operator" | "fleet" {
  const kind = inboxKind(proposal.id);
  return kind === "feedback-docket" || FLEET_KINDS.has(kind) || isAgeOnlyInboxInformation(proposal) ? "fleet" : "operator";
}

/** Display ownership never enlarges the fleet's existing executable population. */
export function fleetExecutionEligible(proposal: InboxOwnershipEvidence): boolean {
  const kind = inboxKind(proposal.id);
  return kind === "feedback-docket" || FLEET_KINDS.has(kind);
}

type OwnershipThreadMessage = { role: string; seq: number; extra?: { question?: boolean; event?: unknown } };

/** Stored sequence, not a backfilled event's timestamp, establishes whether a question was answered. */
export function hasUnansweredInboxQuestion(messages: readonly OwnershipThreadMessage[]): boolean {
  const reply = messages.filter(m => m.role === "reply" && m.extra?.event === undefined)
    .reduce((seq, m) => Math.max(seq, m.seq), 0);
  return messages.some(m => m.role === "escalation" && m.extra?.event === undefined && m.extra?.question === true && m.seq > reply);
}

/** Called only with the producer's already captured, readable thread evidence. No I/O or action authority. */
export function captureInboxOwner(proposal: InboxOwnershipEvidence, messages: readonly OwnershipThreadMessage[], requiresReview: boolean): "operator" | "fleet" {
  if (requiresReview || isAgeOnlyInboxInformation(proposal) && hasUnansweredInboxQuestion(messages)) return "operator";
  return inboxOwner(proposal);
}

/** A missing capture cannot move an age finding out of the human lane. Unknown kinds never inherit fleet ownership. */
export function classifiedInboxOwner(proposal: InboxOwnershipEvidence, classification: { displayOwner?: "operator" | "fleet"; retirement?: { state?: string }; requiresReview?: boolean }): "operator" | "fleet" {
  if (classification.requiresReview || classification.retirement?.state === "restored_for_review" || classification.displayOwner === "operator") return "operator";
  if (classification.displayOwner === "fleet" && (fleetExecutionEligible(proposal) || isAgeOnlyInboxInformation(proposal))) return "fleet";
  return inboxOwner({ id: proposal.id });
}

// ── WHO SENT AN INBOX ITEM, AND WHEN (W1-T8825) ───────────────────────────────────────────────
//
// The served inbox named every item by its proposal id and carried no time, so a console could not
// draw a From column, a received time or a thread per sender. Every instant here is a STORED one —
// a ruling's judged_at, the first time the inbox classified the id, a thread message, a ledger row —
// never "now": the inbox view carries no clock, so an idle inbox keeps its ETags.

/** The sender a console shows beside an item, and the key it groups a sender's items into one thread by. */
export interface InboxSender {
  from: { kind: string; name: string };
  /** RFC 3339 UTC; null only when neither a ruling time nor a first-seen record exists. */
  receivedAt: string | null;
  /** RFC 3339 UTC, never earlier than receivedAt; moves only when the item does. */
  lastActivityAt: string | null;
  groupKey: string;
}

/** The fixed display table for a producer id (`from.kind`). */
const SENDER_NAMES: Readonly<Record<string, string>> = {
  "ci-friction": "CI-friction gardener",
  "fix-lane": "Fix-lane gardener",
  "flow-blocker": "Flow-blocker gardener",
  flow: "Flow gardener",
  "flow-remedy": "Flow-remedy gardener",
  "selector-shadow": "Selector-shadow gardener",
  "hot-file": "Hot-file gardener",
  "host-resource": "Host-resource gardener",
  "evidence-coverage": "Evidence-coverage gardener",
  plan: "Plan gardener",
  gate: "Gate gardener",
  test: "Test gardener",
  config: "Config gardener",
  export: "Export gardener",
  backlog: "Backlog gardener",
  scout: "Scout gardener",
  overseer: "Overseer",
  operator: "Operator",
  "machine-judge": "Machine-filing judge",
  "verify-human": "Verify-human judge",
  "verify-human-automate": "Verify-human judge (automation)",
  "guard-retirement": "Guard review",
  retro: "Retro",
  "board-review": "Board review",
  adoption: "Adoption audit",
  followup: "Follow-up harvest",
  "proof-debt": "Proof-debt audit",
  "skill-draft": "Skill workshop",
  "codeql-quality": "CodeQL quality audit",
  "rule-efficacy": "Rule-efficacy audit",
  "feedback-docket": "Feedback docket",
};

/** A producer id's display name; an unknown kind is named by itself with its first letter capitalised, never by a proposal id. */
export function inboxSenderName(kind: string): string {
  return SENDER_NAMES[kind] ?? (kind.length === 0 ? "Unknown" : kind.charAt(0).toUpperCase() + kind.slice(1));
}

/** The producer of an item: a machine-judge item's filer family when the record names one, else its id's kind. */
export function inboxSenderKind(proposalId: string, filerFamily?: string): string {
  const kind = inboxKind(proposalId);
  // An id with no `:` (and not a feedback docket) is its own "kind": never show it as a sender.
  if (kind === proposalId && !proposalId.includes(":")) return "proposal";
  return kind === "machine-judge" && filerFamily !== undefined && filerFamily !== "" ? filerFamily : kind;
}

/** The latest of the given RFC 3339 instants (unparseable and absent ones ignored), as the instant's own text; null when none. */
export function latestInstant(instants: ReadonlyArray<string | null | undefined>): string | null {
  let best: { ms: number; text: string } | undefined;
  for (const text of instants) {
    if (typeof text !== "string") continue;
    const ms = Date.parse(text);
    if (Number.isFinite(ms) && (best === undefined || ms > best.ms)) best = { ms, text };
  }
  return best?.text ?? null;
}

/** An item's sender stamp from the stored instants alone. */
export function inboxSender(proposalId: string, evidence: { family?: string; receivedAt?: string | null; activity?: ReadonlyArray<string | null | undefined> }): InboxSender {
  const kind = inboxSenderKind(proposalId, evidence.family);
  const receivedAt = latestInstant([evidence.receivedAt]);
  return {
    from: { kind, name: inboxSenderName(kind) },
    receivedAt,
    lastActivityAt: latestInstant([receivedAt, ...(evidence.activity ?? [])]),
    groupKey: kind,
  };
}
