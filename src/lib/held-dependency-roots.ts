/**
 * lib/held-dependency-roots.ts — the dependency roots that can never dispatch on their own (W1-T4192).
 *
 * An `unmet-deps` task clears itself once its dependency merges, which is true only while that
 * dependency can be built. When the walk down a task's unmet dependencies ends at a `verify:` gate no
 * operator has released, or at a `blocked` record with no retirement ruling, nothing the fleet does
 * will ever move the chain: one person's decision on that root would release every task behind it.
 * The starvation census cannot say so, because it only fires when nothing at all is dispatchable.
 */
import { unmetDependencies, type MergedResolver, type Plan, type Task } from "./plan.js";

export interface HeldDependencyRoot {
  rootId: string;
  /** Why the root needs a person: a `verify:` gate not yet released, or `blocked` with no retirement. */
  hold: "verify-not-auto" | "blocked";
  /** Every unmerged, unblocked task whose unmet-dependency walk reaches this root, sorted by id. */
  stalled: string[];
}

function holdOf(t: Task, releasedIds: ReadonlySet<string>): HeldDependencyRoot["hold"] | undefined {
  if (t.status === "blocked" && t.retirement === undefined) return "blocked";
  if (t.verify !== "auto" && !releasedIds.has(t.id)) return "verify-not-auto";
  return undefined;
}

/** Held roots, most-stalled first, then by id. A root reached only through runnable work is not held. */
export function heldDependencyRoots(
  plan: Plan,
  isMerged: (taskId: string) => boolean,
  releasedIds: ReadonlySet<string> = new Set(),
): HeldDependencyRoot[] {
  const merged: MergedResolver = (task) => isMerged(task.id);
  const byRoot = new Map<string, { hold: HeldDependencyRoot["hold"]; stalled: Set<string> }>();
  for (const t of plan.tasks) {
    if (isMerged(t.id) || t.status === "blocked" || t.retirement !== undefined) continue;
    const seen = new Set<string>();
    const pending = unmetDependencies(plan, t, merged);
    while (pending.length > 0) {
      const id = pending.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const dep = plan.byId.get(id);
      if (!dep) continue;
      const hold = holdOf(dep, releasedIds);
      if (hold) {
        const entry = byRoot.get(id) ?? { hold, stalled: new Set<string>() };
        entry.stalled.add(t.id);
        byRoot.set(id, entry);
        continue;
      }
      pending.push(...unmetDependencies(plan, dep, merged));
    }
  }
  return [...byRoot.entries()]
    .map(([rootId, e]) => ({ rootId, hold: e.hold, stalled: [...e.stalled].sort() }))
    .sort((a, b) => b.stalled.length - a.stalled.length || (a.rootId < b.rootId ? -1 : a.rootId > b.rootId ? 1 : 0));
}
