/** The status board's plan/ledger projection runs here, never in serve's request loop. */
import { MessageChannel, Worker, isMainThread, parentPort, receiveMessageOnPort, workerData, type MessagePort } from "node:worker_threads";
import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createBoardSnapshotCache, type BoardSnapshot, type BoardSnapshotCache, type BoardSnapshotSource, type BoardSnapshotState } from "./board.js";
import { systemClock, type Clock } from "./clock.js";
import { readInflightLock } from "./inflight-lock.js";
import type { BoardDeps, GitHub } from "./status.js";
import { threadStrictPlan } from "./thread-plan.js";

const KIND = "remudero-board-projection";
export const BOARD_PROJECTION_INTERVAL_MS = 3_000;
export const BOARD_PROJECTION_STALE_MS = 30_000;
const FACT_REPLY_BOUND_MS = 5_000;

type WorkerInput = {
  kind: typeof KIND;
  planPath: string;
  ledgerPath: string;
  inflightDir: string;
  methods: string[];
  replyPort: MessagePort;
  signal: SharedArrayBuffer;
  intervalMs: number;
  delayMs: number;
};
type FactRequest = { kind: "fact"; id: number; method: string; args: unknown[] };
type FactReply = { id: number } & ({ ok: true; value: unknown } | { ok: false; error: string });
type ProjectionMessage =
  | { kind: "snapshot"; snapshot: BoardSnapshot }
  | { kind: "failure"; reason: string };

function projectionGithub(input: WorkerInput): GitHub {
  const signal = new Int32Array(input.signal);
  let nextId = 0;
  const call = (method: string, args: unknown[] = []): unknown => {
    const id = ++nextId;
    const deadline = performance.now() + FACT_REPLY_BOUND_MS;
    parentPort!.postMessage({ kind: "fact", id, method, args } satisfies FactRequest);
    for (;;) {
      // Arm before draining the port: a reply arriving between the drain and a later arm
      // would otherwise lose its wake. A timed-out fact may still reply after the next fact
      // starts, so only this request's id may satisfy the call.
      Atomics.store(signal, 0, 0);
      let queued;
      while ((queued = receiveMessageOnPort(input.replyPort))) {
        const reply = queued.message as FactReply;
        if (reply.id !== id) continue;
        if (!reply.ok) throw new Error(reply.error);
        return reply.value;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(`board GitHub fact ${method} timed out`);
      Atomics.wait(signal, 0, 0, remaining);
    }
  };
  const facade: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of input.methods) {
    if (method === "mergedTrailerLookup") {
      facade[method] = () => call("beginMergedTrailerLookup")
        ? (taskId: string) => call("lookupMergedTrailer", [taskId])
        : null;
    } else {
      facade[method] = (...args: unknown[]) => call(method, args);
    }
  }
  return facade as unknown as GitHub;
}

/** Also called in-process by a test: worker coverage is not collected in its parent. */
export function computeWorkerBoardSnapshot(deps: BoardDeps, cache: BoardSnapshotCache): BoardSnapshot {
  if (!statSync(deps.ledgerPath).isFile()) throw new Error("board ledger is not a file");
  return cache.get(deps);
}

/** One worker pass: the plan comes from the thread's parse held per file identity, so a filed or retired task reaches the board without a restart. */
export function boardWorkerPass(
  input: { planPath: string; ledgerPath: string; inflightDir: string },
  github: GitHub,
  cache: BoardSnapshotCache,
): BoardSnapshot {
  const deps: BoardDeps = {
    plan: threadStrictPlan(input.planPath),
    ledgerPath: input.ledgerPath,
    github,
    inflightHolder: (taskId) => readInflightLock(input.inflightDir, taskId),
  };
  return computeWorkerBoardSnapshot(deps, cache);
}

function runBoardWorker(input: WorkerInput): void {
  const github = projectionGithub(input);
  const cache = createBoardSnapshotCache();
  let busy = false;
  const tick = (): void => {
    if (busy) return;
    busy = true;
    try {
      if (input.delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, input.delayMs);
      parentPort!.postMessage({ kind: "snapshot", snapshot: boardWorkerPass(input, github, cache) } satisfies ProjectionMessage);
    } catch (error) {
      parentPort!.postMessage({ kind: "failure", reason: String((error as Error)?.message ?? error) } satisfies ProjectionMessage);
    } finally {
      busy = false;
    }
  };
  tick();
  setInterval(tick, input.intervalMs);
}

export interface BoardProjectionWorker extends BoardSnapshotSource {
  start(): void;
  stop(): void;
  isReady(): boolean;
}

export function createBoardProjectionWorker(
  github: GitHub,
  input: { planPath: string; ledgerPath: string; inflightDir: string },
  options: { intervalMs?: number; delayMs?: number; staleMs?: number; workerUrl?: URL; clock?: Clock } = {},
): BoardProjectionWorker {
  const clock = options.clock ?? systemClock;
  const buildStartedAt = clock.iso();
  let state: BoardSnapshotState = { state: "unavailable", buildStartedAt, checkedAt: buildStartedAt, reason: "not_ready" };
  let thread: Worker | undefined;
  let replyPort: MessagePort | undefined;
  let stopped = false;
  let mergedLookup: ((taskId: string) => ReturnType<GitHub["findMergedByTrailer"]>) | null = null;
  const unavailable = (reason: string): void => {
    state = { state: "unavailable", buildStartedAt, checkedAt: clock.iso(), reason };
  };
  const handle: BoardProjectionWorker = {
    current() {
      if (state.state === "ready" && clock.now() - Date.parse(state.snapshot.generated_at) > (options.staleMs ?? BOARD_PROJECTION_STALE_MS)) {
        return { state: "unavailable", buildStartedAt, checkedAt: clock.iso(), reason: "projection_stale" };
      }
      return state.state === "unavailable" ? { ...state, checkedAt: clock.iso() } : state;
    },
    isReady: () => handle.current().state === "ready",
    start() {
      if (stopped || thread) return;
      const { port1, port2 } = new MessageChannel();
      replyPort = port1;
      const signal = new SharedArrayBuffer(4);
      const data: WorkerInput = {
        kind: KIND,
        ...input,
        methods: Object.entries(github).filter(([, value]) => typeof value === "function").map(([name]) => name),
        replyPort: port2,
        signal,
        intervalMs: options.intervalMs ?? BOARD_PROJECTION_INTERVAL_MS,
        delayMs: options.delayMs ?? 0,
      };
      try {
        thread = new Worker(options.workerUrl ?? new URL(import.meta.url), { workerData: data, transferList: [port2], execArgv: process.execArgv });
      } catch (error) {
        // A spawn failure is not an absent projection: it is surfaced to the caller below with its
        // cause as the `worker_spawn_failed` reason, so the board falls back knowingly.
        port1.close();
        port2.close();
        unavailable(`worker_spawn_failed: ${String((error as Error)?.message ?? error)}`);
        return;
      }
      const wake = new Int32Array(signal);
      thread.on("message", (message: FactRequest | ProjectionMessage) => {
        if (stopped) return;
        if (message.kind === "fact") {
          let reply: FactReply;
          try {
            const value = message.method === "beginMergedTrailerLookup"
              ? (mergedLookup = github.mergedTrailerLookup?.() ?? null, mergedLookup !== null)
              : message.method === "lookupMergedTrailer"
                ? mergedLookup?.(String(message.args[0])) ?? null
                : (github[message.method as keyof GitHub] as (...args: unknown[]) => unknown).apply(github, message.args);
            reply = { id: message.id, ok: true, value };
          } catch (error) {
            reply = { id: message.id, ok: false, error: String((error as Error)?.message ?? error) };
          }
          replyPort?.postMessage(reply);
          Atomics.store(wake, 0, 1);
          Atomics.notify(wake, 0);
          return;
        }
        if (message.kind === "snapshot") state = { state: "ready", snapshot: message.snapshot };
        else unavailable(`worker_projection_failed: ${message.reason}`);
      });
      thread.once("error", (error) => unavailable(`worker_crashed: ${error.message}`));
      thread.once("exit", (code) => {
        if (!stopped) unavailable(`worker_exited: ${code}`);
        thread = undefined;
        replyPort?.close();
        replyPort = undefined;
      });
    },
    stop() {
      stopped = true;
      void thread?.terminate();
      replyPort?.close();
    },
  };
  return handle;
}

if (!isMainThread && (workerData as { kind?: string } | undefined)?.kind === KIND && parentPort) {
  runBoardWorker(workerData as WorkerInput);
}
