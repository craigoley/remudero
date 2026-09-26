/**
 * The console's heavy local projection work on a worker thread, so serve's one event loop only swaps in
 * the finished result. Today that is the feedback inbox's reads: every `plan/feedback/*.yaml` entry and a
 * fresh plan parse (~0.8 s on the host's 268 entries and 2,320 tasks). The worker returns the entries and
 * each entry's filed task ids; GitHub facts stay on the main thread's in-memory merged index, so this
 * adds no GitHub calls. THIS FILE IS LOADED TWICE, `isMainThread`/`workerData` gating the worker branch,
 * the same pattern as status.ts's prewarm walk and repo-dashboard-route.ts. One persistent worker serves
 * every request; a worker that cannot start or dies is an outcome with its reason, and the caller then
 * builds the same projection synchronously.
 */
import { isMainThread, parentPort, threadId, Worker, workerData } from "node:worker_threads";
import { listFeedback, type FeedbackEntry } from "./feedback.js";
import { loadPlan } from "./plan.js";
import { feedbackOriginTag, type DischargeGithub } from "./trace.js";

const CONSOLE_PROJECTION_WORKER_KIND = "remudero-console-projection" as const;

export interface FeedbackProjectionInput {
  root: string;
  planPath: string;
}

export type FeedbackProjectionOutcome =
  | {
      ok: true;
      entries: FeedbackEntry[];
      /** Each entry id with the ids of the plan tasks whose `origin` names it; absent when the plan was unreadable. */
      filedTasks?: Array<[string, string[]]>;
      planError?: string;
      /** The thread that computed it, so a caller (and a test) can tell off-thread from inline. */
      threadId: number;
    }
  | { ok: false; reason: string };

/** The projection itself, run wherever it is called from: the worker thread, or inline as the fallback. */
export function computeFeedbackProjectionSync(input: FeedbackProjectionInput): FeedbackProjectionOutcome {
  const entries = listFeedback(input.root, {});
  try {
    const plan = loadPlan(input.planPath);
    const byOrigin = new Map<string, string[]>();
    for (const task of plan.tasks) {
      if (!task.origin) continue;
      const ids = byOrigin.get(task.origin) ?? [];
      ids.push(task.id);
      byOrigin.set(task.origin, ids);
    }
    const filedTasks = entries.map((e): [string, string[]] => [e.id, byOrigin.get(feedbackOriginTag(e.id)) ?? []]);
    return { ok: true, entries, filedTasks, threadId };
  } catch (error) {
    return { ok: true, entries, planError: String((error as Error)?.message ?? error), threadId };
  }
}

interface WorkerRequest {
  id: number;
  input: FeedbackProjectionInput;
}

/** The worker branch's body, named so the parent can cover it: coverage instruments the parent thread only. */
export function serveConsoleProjections(port: { on(event: "message", run: (msg: WorkerRequest) => void): unknown; postMessage(value: unknown): void } | null): void {
  port?.on("message", (msg) => {
    let outcome: FeedbackProjectionOutcome;
    try {
      outcome = computeFeedbackProjectionSync(msg.input);
    } catch (error) {
      outcome = { ok: false, reason: `feedback projection failed: ${String((error as Error)?.message ?? error)}` };
    }
    port.postMessage({ id: msg.id, outcome });
  });
}

if (!isMainThread && (workerData as { kind?: unknown } | undefined)?.kind === CONSOLE_PROJECTION_WORKER_KIND) serveConsoleProjections(parentPort);

export interface ConsoleProjectionWorker {
  feedback(input: FeedbackProjectionInput): Promise<FeedbackProjectionOutcome>;
  stop(): void;
}

/** One persistent worker, spawned on first use and respawned after it dies; every pending request settles exactly once. */
export function startConsoleProjectionWorker(options: { workerUrl?: URL } = {}): ConsoleProjectionWorker {
  let worker: Worker | undefined;
  let nextId = 1;
  const pending = new Map<number, (outcome: FeedbackProjectionOutcome) => void>();

  const failAll = (from: Worker | undefined, reason: string): void => {
    if (from !== worker) return;
    for (const settle of pending.values()) settle({ ok: false, reason });
    pending.clear();
    worker = undefined;
  };
  // Held (ref'd) only while a request is outstanding, so an idle worker never keeps a process alive.
  const track = (): void => void (pending.size > 0 ? worker?.ref() : worker?.unref());

  const ensure = (): Worker => {
    if (worker) return worker;
    const spawned = new Worker(options.workerUrl ?? new URL(import.meta.url), {
      workerData: { kind: CONSOLE_PROJECTION_WORKER_KIND },
      execArgv: process.execArgv,
    });
    spawned.on("message", (msg: { id: number; outcome: FeedbackProjectionOutcome }) => {
      const settle = pending.get(msg.id);
      pending.delete(msg.id);
      track();
      settle?.(msg.outcome);
    });
    spawned.on("error", (error) => failAll(spawned, `console projection worker failed: ${String(error?.message ?? error)}`));
    spawned.on("exit", (code) => failAll(spawned, `console projection worker exited with code ${code}`));
    spawned.unref();
    worker = spawned;
    return spawned;
  };

  return {
    feedback: (input) =>
      new Promise((resolve) => {
        let target: Worker;
        try {
          target = ensure();
        } catch (error) {
          resolve({ ok: false, reason: `console projection worker could not start: ${String((error as Error)?.message ?? error)}` });
          return;
        }
        const id = nextId++;
        pending.set(id, resolve);
        track();
        target.postMessage({ id, input } satisfies WorkerRequest);
      }),
    stop: () => {
      const running = worker;
      failAll(running, "console projection worker stopped");
      void running?.terminate();
    },
  };
}

/**
 * The batched gateway's per-call `findMergedByTrailer` regex-scans every merged PR body, so a feedback
 * read's ~108 discharge lookups rescanned the whole merged set each time. When the gateway can hand
 * over its merged set, both rungs answer from maps built once, with the same results.
 */
export function indexedDischargeGithub(
  github: DischargeGithub & {
    mergedTrailerLookup?(): ((taskId: string) => { state: string } | null) | null;
    listMergedHeadBranches?(): Array<{ state: string; headRefName?: string }> | null;
  },
): DischargeGithub {
  const trailer = github.mergedTrailerLookup?.();
  const heads = github.listMergedHeadBranches?.();
  if (!trailer || !heads) return github;
  const byTask = new Map<string, Array<{ state: string; headRefName?: string }>>();
  for (const pr of heads) {
    const taskId = /^run-(.+)-\d+$/.exec(pr.headRefName ?? "")?.[1];
    if (taskId !== undefined) byTask.set(taskId, [...(byTask.get(taskId) ?? []), pr]);
  }
  return {
    findMergedByTrailer: (taskId) => trailer(taskId),
    findMergedByHeadBranch: (taskId) => byTask.get(taskId) ?? [],
    readFailed: () => github.readFailed?.() === true,
    readTruncated: () => github.readTruncated?.() === true,
  };
}
