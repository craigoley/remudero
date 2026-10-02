/**
 * One parsed plan per file identity for every reader in a thread (E37). Serve's views worker held a parse of core's
 * plan per view (now, task, repositories) and its slow lane one per pass; each parse is tens of MB. The readers keep
 * their own change keys and ask here when one moves; this answers from the held parse while no plan file has changed.
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { BroadcastChannel, isMainThread, threadId } from "node:worker_threads";
import { loadPlan, loadPlanQuarantiningDuplicates, type Plan, type QuarantinedTask } from "./plan.js";
import { readServePlanAtRef } from "./serve-plan-reload.js";

type PlanLoad = { plan: Plan; quarantined: QuarantinedTask[] };

/** The commit serve's main thread loaded a plan path from (E43): a generation's working tree never moves, so its
 *  workers follow this instead of their file identity, and answer exactly what the main thread answers. */
export type PlanPin = { path: string; repoDir: string; ref: string };
type PinMessage =
  | { type: "pin"; pin: PlanPin }
  | { type: "ask" }
  | { type: "adopted"; pin: PlanPin; threadId: number; tasks: number; gitMs?: number; parseMs?: number }
  | { type: "adopt_failed"; pin: PlanPin; threadId: number; reason: string };
type PinLog = (step: string, extra?: Record<string, unknown>) => void;

export const PLAN_PIN_ADOPTED_STEP = "serve.plan_pin_adopted";
export const PLAN_PIN_ADOPT_FAILED_STEP = "serve.plan_pin_adopt_failed";

const held = new Map<string, { identity: string; load: PlanLoad; pinned?: true }>();
const published = new Map<string, PlanPin>();
let pinLog: PinLog | undefined;
let adopting: Promise<void> = Promise.resolve();
const pinIdentity = (pin: PlanPin): string => `ref:${pin.repoDir}@${pin.ref}`;
const channel = new BroadcastChannel("remudero-thread-plan-pin");
channel.unref();
const post = (message: PinMessage): void => channel.postMessage(message);

function adopt(pin: PlanPin): Promise<void> {
  adopting = adopting.then(async () => {
    const identity = pinIdentity(pin);
    if (held.get(pin.path)?.identity === identity) return;
    try {
      const read = await readServePlanAtRef(pin.repoDir, pin.ref);
      held.set(pin.path, { identity, load: { plan: read.plan, quarantined: read.quarantined }, pinned: true });
      post({ type: "adopted", pin, threadId, tasks: read.plan.tasks.length, gitMs: read.gitMs, parseMs: read.parseMs });
    } catch (err) {
      post({ type: "adopt_failed", pin, threadId, reason: err instanceof Error ? err.message : String(err) });
    }
  });
  return adopting;
}

channel.onmessage = (event: unknown): void => {
  const message = (event as { data: PinMessage }).data;
  if (message.type === "pin") void adopt(message.pin);
  else if (message.type === "ask") for (const pin of published.values()) post({ type: "pin", pin });
  else if (message.type === "adopted") pinLog?.(PLAN_PIN_ADOPTED_STEP, { ...message.pin, threadId: message.threadId, tasks: message.tasks, gitMs: message.gitMs, parseMs: message.parseMs });
  else pinLog?.(PLAN_PIN_ADOPT_FAILED_STEP, { ...message.pin, threadId: message.threadId, reason: message.reason });
};
if (!isMainThread) post({ type: "ask" });

/** The main thread installs the plan it just loaded at `pin` and tells every thread to load that same commit;
 *  `log` receives one row per thread that adopts it, or fails to. */
export function publishThreadPlan(pin: PlanPin, load: PlanLoad, log?: PinLog): void {
  held.set(pin.path, { identity: pinIdentity(pin), load: { plan: load.plan, quarantined: load.quarantined }, pinned: true });
  published.set(pin.path, pin);
  if (log) pinLog = log;
  post({ type: "pin", pin });
}

/** The pinned commit a path answers from in this thread, or "" while it follows its files. Fold it into a change key. */
export function threadPlanPin(path: string): string {
  const hit = held.get(path);
  return hit?.pinned ? hit.identity : "";
}
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
  const hit = held.get(path);
  if (hit?.pinned) return hit.load;
  const identity = planFilesIdentity(path);
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
  return load.quarantined.length === 0 || held.get(path)?.pinned ? load.plan : loadPlan(path);
}

/** Replaces the thread's parser and forgets every held parse; returns the parser it replaced. A test seam. */
export function swapThreadPlanParser(next: (path: string) => PlanLoad): (path: string) => PlanLoad {
  const prior = parse;
  parse = next;
  held.clear();
  published.clear();
  return prior;
}
