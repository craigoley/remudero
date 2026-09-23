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
