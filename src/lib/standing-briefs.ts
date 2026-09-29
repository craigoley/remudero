import { createHash } from "node:crypto";
import { citation } from "./provenance.js";
import type { LearningEntry } from "./learnings.js";

/**
 * Standing briefs (W1-T4680): OBSERVED, learnings enter a prompt as flat lines under a char
 * budget and 34% of tasks overflow it (src/lib/knowledge-outcome.ts), losing whatever the ranker
 * cut. This module keeps ONE brief per learnings shard instead: every claim still cites its
 * `learnings#<id>`, but the brief is refreshed only when that shard's active facts actually
 * change, and a refresh edits claims IN PLACE BY ID, so a claim whose own fact did not change
 * keeps byte-identical wording even when a sibling entry in the same shard did (Hindsight's
 * mental models, engine/reflect/delta_ops.py: id-addressed edit operations, not a rewrite).
 * INVARIANT: {@link buildStandingBrief} only ever summarises `lifecycle === "active"` entries —
 * the same filter {@link selectLearnings} (learnings.ts) applies before a fact can reach a prompt.
 * FALSIFIER: test/each-learnings-shard-has-a-standing-brief.test.ts.
 */

/** One rendered claim inside a {@link StandingBrief}, addressed by its source entry's id. */
export interface StandingBriefClaim {
  /** The learning entry id this claim renders; matches the trailing `learnings#<id>` citation. */
  id: string;
  /** Content hash over the fields that determine `text`. Unchanged => `text` is reused verbatim
   *  on the next refresh, which is what keeps unrelated edits from drifting this claim's wording. */
  claimHash: string;
  /** The rendered claim line, e.g. `- <fact> [src: learnings#<id>]`. */
  text: string;
}

/** One shard's standing brief: a small, cited summary refreshed only when the shard changes. */
export interface StandingBrief {
  /** The shard filename this brief summarises, e.g. `architecture.yaml`. */
  shard: string;
  /** Content hash over every active entry's id+fact; a refresh recomputes and compares this. */
  shardHash: string;
  /** Refresh count: starts at 1 on first build, increments only when `shardHash` changes. */
  version: number;
  /** One claim per active entry in the shard, ordered by id. */
  claims: StandingBriefClaim[];
  /** The full brief text: one claim line per row, joined with newlines. "" when the shard has no
   *  active entries. */
  rendered: string;
}

function claimHashOf(entry: LearningEntry): string {
  return createHash("sha256").update(`${entry.id}\u0000${entry.fact}`).digest("hex");
}

function renderClaimLine(entry: LearningEntry): string {
  return `- ${entry.fact} ${citation(`learnings#${entry.id}`)}`;
}

function activeSortedById(entries: readonly LearningEntry[]): LearningEntry[] {
  return entries
    .filter((e) => e.lifecycle === "active")
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function shardHashOf(active: readonly LearningEntry[]): string {
  const h = createHash("sha256");
  for (const entry of active) h.update(`${entry.id}\u0000${entry.fact}\u0000`);
  return h.digest("hex");
}

/**
 * Build (or refresh) one shard's standing brief from its current active entries.
 *
 * REFRESH RULE: when `previous` is given for the SAME `shard` and its `shardHash` already equals
 * this call's, `previous` is returned UNCHANGED (same object, same `version`) — a brief is
 * refreshed only when its shard's facts actually change, never on every call.
 *
 * EDIT-IN-PLACE RULE: when the shard DID change, each claim is re-derived by id: an entry whose
 * own {@link claimHashOf} is unchanged reuses `previous`'s claim for that id verbatim (same
 * `text`, same `claimHash`); only a new id or a changed fact gets freshly rendered text. So one
 * entry's edit never rewrites a sibling claim's wording.
 */
export function buildStandingBrief(
  entries: readonly LearningEntry[],
  shard: string,
  previous?: StandingBrief,
): StandingBrief {
  const active = activeSortedById(entries);
  const shardHash = shardHashOf(active);
  if (previous && previous.shard === shard && previous.shardHash === shardHash) {
    return previous;
  }
  const previousById = new Map((previous?.shard === shard ? previous.claims : []).map((c) => [c.id, c] as const));
  const claims: StandingBriefClaim[] = active.map((entry) => {
    const claimHash = claimHashOf(entry);
    const prior = previousById.get(entry.id);
    if (prior && prior.claimHash === claimHash) return prior;
    return { id: entry.id, claimHash, text: renderClaimLine(entry) };
  });
  return {
    shard,
    shardHash,
    version: (previous?.shard === shard ? previous.version : 0) + 1,
    claims,
    rendered: claims.map((c) => c.text).join("\n"),
  };
}

/**
 * (iii) A brief that drops a cited fact fails its own check: every currently-active entry in
 * `entries` must have a claim in `brief`, and every claim's rendered `text` must cite its own id.
 * Returns the ids that fail either requirement; empty means the brief is complete.
 */
export function findMissingOrUncitedClaims(entries: readonly LearningEntry[], brief: StandingBrief): string[] {
  const active = activeSortedById(entries);
  const claimsById = new Map(brief.claims.map((c) => [c.id, c] as const));
  const bad = new Set<string>();
  for (const entry of active) {
    const claim = claimsById.get(entry.id);
    if (!claim || !claim.text.includes(citation(`learnings#${entry.id}`))) bad.add(entry.id);
  }
  return [...bad].sort();
}
