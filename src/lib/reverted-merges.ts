/**
 * W1-T14302: which squash merges a later commit on main reverted.
 *
 * PURE. The caller walks main's history once (status.ts, the same `git log` the commit trailer
 * index reads) and hands the records here, newest first, exactly as `git log` prints them.
 *
 * Only a positive record takes credit back: a commit on the walk whose body says
 * "This reverts commit <sha>", where <sha> names a commit on the same walk. A name that is not on
 * the walk is ignored, so a branch commit inside a squash merge never counts.
 */

/** One commit of a main history walk. `taskId` is the commit's own Remudero-Task trailer, when it has one. */
export interface MainHistoryRecord {
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
  readonly taskId?: string;
}

/** A squash merge that a later commit on main reverted, and the facts a restoration check needs. */
export interface RevertedMerge {
  /** The first commit on main that reverted the merge and is still standing. */
  readonly revertSha: string;
  /** The pull request of that revert, from its own squash subject. */
  readonly revertPr?: number;
  /** Every standing revert's pull request, so a restoration may name either of two twin reverts. */
  readonly revertPrs: readonly number[];
  /** Remudero-Task ids of the commits newer than the first standing revert. */
  readonly laterTaskIds: readonly string[];
}

/** A squash merge's own PR number, off the `(#N)` suffix in the subject. */
export function prNumberFromSquashSubject(subject: string): number | undefined {
  const m = /\(#(\d+)\)\s*$/.exec(subject);
  return m ? Number(m[1]) : undefined;
}

const REVERT_LINE = /^This reverts commit ([0-9a-f]{7,40})\b/gim;

/** The commits a body names as reverted, each resolved by unique prefix among the walk. */
function revertTargets(body: string, resolve: (prefix: string) => number | undefined): number[] {
  const out: number[] = [];
  for (const match of body.matchAll(REVERT_LINE)) {
    const target = resolve(match[1]!.toLowerCase());
    if (target !== undefined && !out.includes(target)) out.push(target);
  }
  return out;
}

/** Map each reverted squash merge's PR number to its standing revert. Two reverts of one commit count once; a
 *  revert of either of them cancels the revert. */
export function revertedMergesFromLog(records: readonly MainHistoryRecord[]): Map<number, RevertedMerge> {
  const shas = records.map((r) => r.sha.trim().toLowerCase());
  const resolve = (prefix: string): number | undefined => {
    let found: number | undefined;
    for (let i = 0; i < shas.length; i++) {
      if (!shas[i]!.startsWith(prefix)) continue;
      if (found !== undefined) return undefined; // an ambiguous prefix names no one commit
      found = i;
    }
    return found;
  };
  // Walk oldest to newest, so a revert is seen before any revert of it.
  const standing = new Map<number, number[]>(); // reverted record -> its standing reverts, oldest first
  const reverterOf = new Map<number, number>(); // revert record -> the record it reverts
  for (let i = records.length - 1; i >= 0; i--) {
    for (const target of revertTargets(records[i]!.body, resolve)) {
      if (target <= i) continue; // a revert can only name an older commit
      const undone = reverterOf.get(target);
      if (undone !== undefined && standing.get(undone)?.includes(target)) {
        // Twin reverts are one revert, so undoing either one gives the credit back.
        for (const r of standing.get(undone)!) reverterOf.delete(r);
        standing.delete(undone);
        continue;
      }
      standing.set(target, [...(standing.get(target) ?? []), i]);
      reverterOf.set(i, target);
    }
  }
  const out = new Map<number, RevertedMerge>();
  for (const [target, reverts] of standing) {
    const pr = prNumberFromSquashSubject(records[target]!.subject);
    if (pr === undefined || out.has(pr)) continue;
    const first = reverts[0]!;
    const revertPrs = reverts.map((r) => prNumberFromSquashSubject(records[r]!.subject)).filter((n): n is number => n !== undefined);
    const laterTaskIds: string[] = [];
    for (let j = 0; j < first; j++) {
      const id = records[j]!.taskId;
      if (id !== undefined && !laterTaskIds.includes(id)) laterTaskIds.push(id);
    }
    const revertPr = prNumberFromSquashSubject(records[first]!.subject);
    out.set(pr, { revertSha: shas[first]!, ...(revertPr === undefined ? {} : { revertPr }), revertPrs, laterTaskIds });
  }
  return out;
}

/** Whether a later task restored the reverted work: its own trailer is on main after the revert, its shard lists
 *  the reverted task in plan_refs, and its shard names a revert's pull request as #<n> or PR-<n>. */
export function revertRestored(
  revert: RevertedMerge,
  revertedTaskId: string,
  shardOf: (taskId: string) => { plan_refs?: readonly string[] } | undefined,
): boolean {
  if (revert.revertPrs.length === 0) return false;
  const names = new RegExp(`(?:#|PR-)(?:${revert.revertPrs.join("|")})(?![0-9])`);
  return revert.laterTaskIds.some((id) => {
    const shard = shardOf(id);
    return shard !== undefined && (shard.plan_refs ?? []).includes(revertedTaskId) && names.test(JSON.stringify(shard));
  });
}
