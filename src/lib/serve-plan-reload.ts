/**
 * W1-T4481 — serve reloads its plan in place instead of restarting for a plan-only merge.
 *
 * serveCommand read the plan once and kept it in `BoardDeps.plan` for the process's life, so
 * W1-T4463 had to keep plan/ restart-relevant: 57 of 139 merges in 24 h were plan-only, and each
 * restart emptied every in-memory cache. This reads the plan from COMMITTED OBJECTS at the sha the
 * restart diff was taken against and installs it with one assignment.
 */
import { execFile } from "node:child_process";
import { isMainThread, parentPort, threadId, Worker, workerData } from "node:worker_threads";
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

export type PlanRead = { plan: Plan; quarantined: QuarantinedTask[]; gitMs?: number; parseMs?: number; threadId?: number };

const PLAN_RELOAD_WORKER_KIND = "remudero-serve-plan-reload" as const;

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
export async function readServePlanAtRef(repoDir: string, ref: string, clock: Clock = systemClock): Promise<PlanRead> {
  const startedAt = clock.now();
  const blobs = await readServePlanBlobs(repoDir, ref);
  const parsedAt = clock.now();
  const read = mergePlanBlobsQuarantiningDuplicates(blobs);
  return { ...read, gitMs: parsedAt - startedAt, parseMs: clock.now() - parsedAt, threadId };
}

async function readServePlanBlobs(repoDir: string, ref: string): Promise<Array<{ label: string; text: string }>> {
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
  return blobs;
}

type ReloadMessage = { ok: true; read: PlanRead } | { ok: false; reason: string };

/** The worker branch's body, named so the parent can cover it: coverage instruments the parent thread only. */
export async function serveOnePlanReload(
  input: { repoDir: string; ref: string },
  port: { postMessage(value: ReloadMessage): void } | null,
): Promise<void> {
  try {
    port?.postMessage({ ok: true, read: await readServePlanAtRef(input.repoDir, input.ref) });
  } catch (err) {
    port?.postMessage({ ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

if (!isMainThread && (workerData as { kind?: unknown } | undefined)?.kind === PLAN_RELOAD_WORKER_KIND) void serveOnePlanReload(workerData, parentPort);

const workerFailures = new WeakSet<Error>();

export const isPlanReloadWorkerFailure = (err: unknown): boolean => err instanceof Error && workerFailures.has(err);

function workerFailure(reason: string): Error {
  const failure = new Error(reason);
  workerFailures.add(failure);
  return failure;
}

/** {@link readServePlanAtRef} on a one-shot worker thread: git is async already, and the parse over
 *  every task no longer holds serve's event loop. A worker that answers `ok: false` rejects as a failed
 *  read; one that cannot start or dies first rejects with an error {@link isPlanReloadWorkerFailure} recognises. */
export function readServePlanOffLoop(repoDir: string, ref: string, workerUrl: URL = new URL(import.meta.url)): Promise<PlanRead> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl, { workerData: { kind: PLAN_RELOAD_WORKER_KIND, repoDir, ref }, execArgv: process.execArgv });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      reject(workerFailure(reason));
      return;
    }
    worker.once("message", (message: ReloadMessage) => {
      void worker.terminate();
      if (message.ok) resolve(message.read);
      else reject(new Error(message.reason));
    });
    worker.once("error", (err) => reject(workerFailure(err.message)));
    worker.once("exit", (code) => reject(workerFailure(`serve plan reload worker exited with code ${code}`)));
  });
}

/** The default read: off the loop, and inline when the worker itself could not do the job. */
async function readServePlanPreferringWorker(repoDir: string, ref: string, options: ServePlanReloadOptions): Promise<PlanRead> {
  try {
    return await (options.offLoop ?? readServePlanOffLoop)(repoDir, ref);
  } catch (err) {
    if (!isPlanReloadWorkerFailure(err)) throw err;
    options.log?.("serve.plan_reload_worker_failed", { ref, reason: (err as Error).message });
    return readServePlanAtRef(repoDir, ref);
  }
}

/** Seams for a hermetic test. */
export interface ServePlanReloadOptions {
  read?: (repoDir: string, ref: string) => Promise<PlanRead>;
  offLoop?: (repoDir: string, ref: string) => Promise<PlanRead>;
  clock?: Clock;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** Told of each installed plan, so serve's worker threads load the same commit (E43). */
  onReloaded?: (ref: string, read: PlanRead) => void;
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
    read = await (options.read ?? ((dir, at) => readServePlanPreferringWorker(dir, at, options)))(repoDir, ref);
  } catch (err) {
    log("serve.plan_reload_failed", { ref, reason: err instanceof Error ? err.message : String(err) });
    return false;
  }
  if (read.quarantined.length > 0) {
    log("serve.plan_quarantined", { ref, ids: read.quarantined.map((q) => q.id), files: read.quarantined.flatMap((q) => q.files) });
  }
  board.plan = read.plan;
  options.onReloaded?.(ref, read);
  log("serve.plan_reloaded", { ref, tasks: read.plan.tasks.length, elapsedMs: clock.now() - startedAt, gitMs: read.gitMs, parseMs: read.parseMs });
  return true;
}
