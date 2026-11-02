/**
 * lib/stage-stall-identity.ts — W1-T11031's stalled-stage identity, the ONE reader both the sweep's
 * dedup (lib/sweep.ts) and the issue-revalidation garden's stage-stall rule use, so the two can never
 * disagree about which open issues report the same PR and blocker. A leaf: it imports nothing.
 */

/** `PR stage stalled: #<n> <url> — <blocker>`, read from a title or the unabridged reason, its age,
 *  episode start and diagnosis dropped. */
export function stalledStageEscalationIdentity(text: string): string | undefined {
  return /(PR stage stalled: #\d+ \S+ — [a-z-]+)(?=;| for \d+ minutes \(|$)/.exec(text)?.[1];
}

/** The stalled-stage identity an OPEN issue carries: its title's, or its body's when the title was
 *  clipped (`…`). */
export function stalledStageIssueIdentity(issue: { title?: string; body?: string }): string | undefined {
  const text = issue.title?.endsWith("…") ? issue.body : issue.title;
  return stalledStageEscalationIdentity(text ?? "");
}
