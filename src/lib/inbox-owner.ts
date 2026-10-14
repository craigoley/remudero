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

export function inboxOwner(proposal: { id: string }): "operator" | "fleet" {
  const kind = inboxKind(proposal.id);
  return kind === "feedback-docket" || FLEET_KINDS.has(kind) ? "fleet" : "operator";
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
