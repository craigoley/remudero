import type { BoardReferentRead, BoardReferentState } from "./inbox.js";
import { taskIdFromRunBranch, type PrRef, type StatusProjection } from "./status.js";

/** The current repository projection already observed these PRs and escalations. Never perform
 * another lookup, or treat a missing, contradictory or unobservable reference as resolved. */
export function inboxBoardReferents(projection: ReadonlyMap<string, StatusProjection>, openPrs: readonly Pick<PrRef, "number" | "state" | "headRefName" | "body">[] = []): Extract<BoardReferentRead, { kind: "ok" }> {
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
    if (prior || unreadable.has(key)) continue;
    // W1-T13957: a PR the projection names on no row of its own takes its escalation count from its OWN
    // task's row, when exactly one task owns it unambiguously and that row is observable.
    const own = ownTaskRow(projection, pr);
    // The open batch observed status, not escalation absence. Preserve stronger task evidence.
    states.set(key, own ? { status: "open", unhandledEscalations: own.needsHuman ? 1 : 0 } : { status: "open" });
  }
  for (const key of unreadable) states.delete(key);
  return { kind: "ok", states };
}

/**
 * Every task a PR claims: its run-branch id (status.ts taskIdFromRunBranch, the one named extractor) and each
 * anchored `Remudero-Task:` trailer, matched as review.ts extractTaskTrailerId matches it (any whitespace, any
 * id shape). All trailers count, not only the last, so a trailer that disagrees with the branch is a conflict.
 * `undefined` when the body was not read: an unseen trailer may name another task, so ownership is unknown.
 */
function ownTaskIds(pr: Pick<PrRef, "headRefName" | "body">): Set<string> | undefined {
  if (pr.body === undefined) return undefined;
  const ids = new Set<string>();
  const head = taskIdFromRunBranch(pr.headRefName);
  if (head) ids.add(head);
  for (const match of pr.body.matchAll(/^Remudero-Task:\s*(\S+)\s*$/gm)) ids.add(match[1]);
  return ids;
}

/**
 * The single projection row for the PR's own task, or undefined. A row that names a DIFFERENT PR, has
 * merged, or cannot be observed is not this open PR's evidence, so the escalation stays unverified (W1-T130).
 */
function ownTaskRow(projection: ReadonlyMap<string, StatusProjection>, pr: Pick<PrRef, "number" | "headRefName" | "body">): StatusProjection | undefined {
  const ids = ownTaskIds(pr);
  if (ids?.size !== 1) return undefined;
  const [taskId] = ids;
  const rows = [...projection.values()].filter((row) => row.taskId === taskId);
  if (rows.length !== 1) return undefined;
  const [row] = rows;
  if (row.prNumber !== undefined && row.prNumber !== pr.number) return undefined;
  if (row.merged || row.indeterminate || row.githubUnobservableSince || row.escalationUnverified) return undefined;
  return row;
}
