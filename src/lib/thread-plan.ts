/**
 * One parsed plan per file identity for every reader in a thread (E37). Serve's views worker held a parse of core's
 * plan per view (now, task, repositories) and its slow lane one per pass; each parse is tens of MB. The readers keep
 * their own change keys and ask here when one moves; this answers from the held parse while no plan file has changed.
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadPlan, loadPlanQuarantiningDuplicates, type Plan, type QuarantinedTask } from "./plan.js";

type PlanLoad = { plan: Plan; quarantined: QuarantinedTask[] };

const held = new Map<string, { identity: string; load: PlanLoad }>();
let parse: (path: string) => PlanLoad = (path) => loadPlanQuarantiningDuplicates(path);

function statIdentity(path: string): string {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    // deliberate: an absent file is an identity of its own; the parse reports it with its reason.
    return "-";
  }
}

/** The monolith's and every shard's inode, mtime and size: an edit in place moves it, not only an added shard. */
export function planFilesIdentity(path: string): string {
  const shardDir = join(dirname(path), "tasks.d");
  let shards: string[];
  try {
    shards = readdirSync(shardDir).sort();
  } catch {
    // deliberate: a plan without tasks.d is the unsharded case, as loadPlan reads it.
    shards = [];
  }
  return [statIdentity(path), ...shards.map((name) => `${name}=${statIdentity(join(shardDir, name))}`)].join("\n");
}

/** What `loadPlanQuarantiningDuplicates(path)` answers, parsed once per identity. Read-only to every caller. */
export function threadPlanLoad(path: string): PlanLoad {
  const identity = planFilesIdentity(path);
  const hit = held.get(path);
  if (hit?.identity === identity) return hit.load;
  const load = parse(path);
  held.set(path, { identity, load });
  return load;
}

/** What `loadPlanQuarantiningDuplicates(path).plan` answers. */
export function threadPlan(path: string): Plan {
  return threadPlanLoad(path).plan;
}

/** What `loadPlan(path)` answers: the shared parse when it quarantined nothing, else loadPlan's own refusal. */
export function threadStrictPlan(path: string): Plan {
  let load: PlanLoad;
  try {
    load = threadPlanLoad(path);
  } catch {
    // deliberate: the strict read below throws its own error, which callers already report.
    return loadPlan(path);
  }
  return load.quarantined.length === 0 ? load.plan : loadPlan(path);
}

/** Replaces the thread's parser and forgets every held parse; returns the parser it replaced. A test seam. */
export function swapThreadPlanParser(next: (path: string) => PlanLoad): (path: string) => PlanLoad {
  const prior = parse;
  parse = next;
  held.clear();
  return prior;
}
