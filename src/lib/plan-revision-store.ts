import { PlanBlobCache, mergePlanBlobs, mergePlanBlobsQuarantiningDuplicates, type Plan, type QuarantinedTask } from "./plan.js";
import { freezeReadGeneration } from "./read-plane.js";

/** W1-T9763: `key` names the parsed identity; the primary uses `<tasks.yaml blob>:<tasks.d tree>`. */
export interface PlanRevision {
  key: string;
  commit: string;
  repoDir: string;
  relPath: string;
}

export type RevisionLoad = { plan: Plan; quarantined: QuarantinedTask[] };

/** One parsed {@link Plan} per {@link PlanRevision}; `adopt` reuses each unchanged blob's tasks. */
export interface PlanRevisionStore {
  get(key: string): RevisionLoad | undefined;
  adopt(revision: PlanRevision, blobs: Array<{ label: string; text: string }>): RevisionLoad;
  revisionOf(plan: Plan): PlanRevision | undefined;
  counts(): { parsed: number; reused: number; held: number; retained: number };
}

/** A plan is frozen, so a reader that mutates it throws instead of changing every reader's plan, and held weakly, so
 *  one no reader holds is released; `retainLatest` keeps the newest for a reader holding nothing between requests. */
export function createPlanRevisionStore(opts: { retainLatest?: boolean; strict?: boolean } = {}): PlanRevisionStore {
  const blobCache = new PlanBlobCache();
  const held = new Map<string, WeakRef<Plan>>();
  const meta = new WeakMap<Plan, { revision: PlanRevision; quarantined: QuarantinedTask[] }>();
  const released = new FinalizationRegistry<string>((key) => {
    if (held.get(key)?.deref() === undefined) held.delete(key);
  });
  let latest: Plan | undefined;
  let parsed = 0;
  let reused = 0;
  const lookup = (key: string): RevisionLoad | undefined => {
    const plan = held.get(key)?.deref();
    const known = plan && meta.get(plan);
    return plan && known ? { plan, quarantined: known.quarantined } : undefined;
  };
  const hit = (key: string): RevisionLoad | undefined => {
    const load = lookup(key);
    if (load) reused++;
    return load;
  };
  return {
    get: hit,
    adopt: (revision, blobs) => {
      const already = hit(revision.key);
      if (already) return already;
      const read = opts.strict
        ? { plan: mergePlanBlobs(blobs), quarantined: [] }
        : mergePlanBlobsQuarantiningDuplicates(blobs, blobCache);
      parsed++;
      freezeReadGeneration(read.plan);
      held.set(revision.key, new WeakRef(read.plan));
      meta.set(read.plan, { revision, quarantined: read.quarantined });
      released.register(read.plan, revision.key);
      if (opts.retainLatest) latest = read.plan;
      return { plan: read.plan, quarantined: read.quarantined };
    },
    revisionOf: (plan) => meta.get(plan)?.revision,
    counts: () => ({ parsed, reused, held: held.size, retained: latest ? 1 : 0 }),
  };
}
