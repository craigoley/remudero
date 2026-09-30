/**
 * W1-T4481 — serve reloads its plan in place instead of restarting for a plan-only merge.
 *
 * serveCommand read the plan once and kept it in `BoardDeps.plan` for the process's life, so
 * W1-T4463 had to keep plan/ restart-relevant: 57 of 139 merges in 24 h were plan-only, and each
 * restart emptied every in-memory cache. This reads the plan from COMMITTED OBJECTS at the sha the
 * restart diff was taken against and installs it with one assignment.
 */
import { execFile } from "node:child_process";
import { systemClock, type Clock } from "./clock.js";
import { mergePlanBlobsQuarantiningDuplicates, readBlobsAtRef, type Plan, type QuarantinedTask } from "./plan.js";
import { resolveRepoLayout } from "./repo-layout.js";

const HOUSE_LAYOUT = resolveRepoLayout("", () => undefined);
const PLAN_MONOLITH = `${HOUSE_LAYOUT.planDir}/tasks.yaml`;
const PLAN_SHARD_DIR = `${HOUSE_LAYOUT.planDir}/tasks.d/`;

/** The plan/ paths serve re-reads through {@link reloadServePlan}. Every other plan/ path stays
 *  restart-relevant: plan/policy.yaml is read once at boot (githubEventWakePolicy). Add a path here
 *  only after showing serve reads it per request, and name that reader beside the entry. */
export const SERVE_PLAN_RELOADABLE_PATHS: readonly string[] = [PLAN_MONOLITH, PLAN_SHARD_DIR];

export function isReloadablePlanPath(raw: string): boolean {
  const path = raw.trim();
  return SERVE_PLAN_RELOADABLE_PATHS.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}

/** Did the advance change anything {@link reloadServePlan} would pick up? */
export function touchesReloadablePlan(changedPaths: readonly string[] | undefined): boolean {
  return (changedPaths ?? []).some(isReloadablePlanPath);
}

/** BACKSTOP: fires only on a hung git; it bounds one reload attempt. */
export const PLAN_RELOAD_TIMEOUT_MS = 30_000;

export type PlanRead = { plan: Plan; quarantined: QuarantinedTask[] };

function gitAsync(repoDir: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-C", repoDir, ...args],
      { encoding: "utf8", maxBuffer: 1 << 26, timeout: PLAN_RELOAD_TIMEOUT_MS },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

/** The plan AT `ref`, from committed objects and never the working tree: the blob for the monolith,
 *  one `ls-tree`, ONE `cat-file --batch` for the shards. Async, so serve's event loop never waits on
 *  git. A duplicated id and its dependents are quarantined and returned; every other error throws. */
export async function readServePlanAtRef(repoDir: string, ref: string): Promise<PlanRead> {
  const blobs: Array<{ label: string; text: string }> = [
    { label: `${ref}:${PLAN_MONOLITH}`, text: await gitAsync(repoDir, ["show", `${ref}:${PLAN_MONOLITH}`]) },
  ];
  const listing = await gitAsync(repoDir, ["ls-tree", "--name-only", ref, PLAN_SHARD_DIR]);
  const shardPaths = listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && (line.endsWith(".yaml") || line.endsWith(".yml")))
    .sort();
  if (shardPaths.length > 0) {
    const raw = await gitAsync(repoDir, ["cat-file", "--batch"], shardPaths.map((p) => `${ref}:${p}`).join("\n") + "\n");
    const texts = readBlobsAtRef(() => raw, ref, shardPaths);
    shardPaths.forEach((path, i) => blobs.push({ label: `${ref}:${path}`, text: texts[i]! }));
  }
  return mergePlanBlobsQuarantiningDuplicates(blobs);
}

/** Seams for a hermetic test. */
export interface ServePlanReloadOptions {
  read?: (repoDir: string, ref: string) => Promise<PlanRead>;
  clock?: Clock;
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

/**
 * Read the plan at `ref` and install it on `board` with ONE assignment, so a request sees the old
 * plan or the new one, never a mix. A failed read (git, parse or validation) keeps the old plan
 * serving, ledgers `serve.plan_reload_failed` and resolves false — the caller retries at its next
 * check and never turns it into a restart, because a restarted serve would read the same bad plan.
 */
export async function reloadServePlan(
  board: { plan: Plan },
  repoDir: string,
  ref: string,
  options: ServePlanReloadOptions = {},
): Promise<boolean> {
  const clock = options.clock ?? systemClock;
  const log = options.log ?? (() => {});
  const startedAt = clock.now();
  let read: PlanRead;
  try {
    read = await (options.read ?? readServePlanAtRef)(repoDir, ref);
  } catch (err) {
    log("serve.plan_reload_failed", { ref, reason: err instanceof Error ? err.message : String(err) });
    return false;
  }
  if (read.quarantined.length > 0) {
    log("serve.plan_quarantined", { ref, ids: read.quarantined.map((q) => q.id), files: read.quarantined.flatMap((q) => q.files) });
  }
  board.plan = read.plan;
  log("serve.plan_reloaded", { ref, tasks: read.plan.tasks.length, elapsedMs: clock.now() - startedAt });
  return true;
}
