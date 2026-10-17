import type { BoardReferentRead, BoardReferentState } from "./inbox.js";
import type { PrRef, StatusProjection } from "./status.js";

/** The current repository projection already observed these PRs and escalations. Never perform
 * another lookup, or treat a missing, contradictory or unobservable reference as resolved. */
export function inboxBoardReferents(projection: ReadonlyMap<string, StatusProjection>, openPrs: readonly Pick<PrRef, "number" | "state">[] = []): Extract<BoardReferentRead, { kind: "ok" }> {
  const states = new Map<string, BoardReferentState>();
  const unreadable = new Set<string>();
  for (const row of projection.values()) {
    if (!Number.isSafeInteger(row.prNumber) || row.prNumber! < 1) continue;
    const key = `#${row.prNumber}`;
    const status = row.prState === "OPEN" ? "open" : row.prState === "MERGED" ? "merged" : row.prState === "CLOSED" ? "dead" : undefined;
    if (!status || row.indeterminate || row.githubUnobservableSince || status === "open" && row.escalationUnverified) {
      unreadable.add(key); continue;
    }
    const next = { status, unhandledEscalations: row.needsHuman ? 1 : 0 };
    const prior = states.get(key);
    if (prior && prior.status !== next.status) unreadable.add(key);
    // Any verified open escalation keeps this PR's escalation proposal live.
    states.set(key, { status, unhandledEscalations: Math.max(prior?.unhandledEscalations ?? 0, next.unhandledEscalations) });
  }
  for (const pr of openPrs) {
    if (!Number.isSafeInteger(pr.number) || pr.number < 1) continue;
    const key = `#${pr.number}`;
    const prior = states.get(key);
    if (pr.state !== "OPEN" || prior && prior.status !== "open") { unreadable.add(key); continue; }
    // The open batch observed status, not escalation absence. Preserve stronger task evidence.
    if (!prior) states.set(key, { status: "open" });
  }
  for (const key of unreadable) states.delete(key);
  return { kind: "ok", states };
}
