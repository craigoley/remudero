/** The status board's plan/ledger projection runs here, never in serve's request loop. */
import { MessageChannel, Worker, isMainThread, parentPort, receiveMessageOnPort, workerData, type MessagePort } from "node:worker_threads";
import { statSync } from "node:fs";
import { createBoardSnapshotCache, type BoardSnapshot, type BoardSnapshotCache, type BoardSnapshotSource, type BoardSnapshotState } from "./board.js";
import { readInflightLock } from "./inflight-lock.js";
import { loadPlan } from "./plan.js";
import type { BoardDeps, GitHub } from "./status.js";

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
type FactRequest = { kind: "fact"; method: string; args: unknown[] };
type FactReply = { ok: true; value: unknown } | { ok: false; error: string };
type ProjectionMessage =
  | { kind: "snapshot"; snapshot: BoardSnapshot }
  | { kind: "failure"; reason: string };

function projectionGithub(input: WorkerInput): GitHub {
  const signal = new Int32Array(input.signal);
  const call = (method: string, args: unknown[] = []): unknown => {
    Atomics.store(signal, 0, 0);
    parentPort!.postMessage({ kind: "fact", method, args } satisfies FactRequest);
    if (Atomics.wait(signal, 0, 0, FACT_REPLY_BOUND_MS) === "timed-out") {
      throw new Error(`board GitHub fact ${method} timed out`);
    }
    const reply = receiveMessageOnPort(input.replyPort)?.message as FactReply | undefined;
    if (!reply) throw new Error(`board GitHub fact ${method} had no reply`);
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
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

function runBoardWorker(input: WorkerInput): void {
  const github = projectionGithub(input);
  let plan: ReturnType<typeof loadPlan> | undefined;
  const cache = createBoardSnapshotCache();
  let busy = false;
  const tick = (): void => {
    if (busy) return;
    busy = true;
    try {
      if (input.delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, input.delayMs);
      plan ??= loadPlan(input.planPath);
      const deps: BoardDeps = {
        plan,
        ledgerPath: input.ledgerPath,
        github,
        inflightHolder: (taskId) => readInflightLock(input.inflightDir, taskId),
      };
      parentPort!.postMessage({ kind: "snapshot", snapshot: computeWorkerBoardSnapshot(deps, cache) } satisfies ProjectionMessage);
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
  options: { intervalMs?: number; delayMs?: number; staleMs?: number; workerUrl?: URL } = {},
): BoardProjectionWorker {
  const buildStartedAt = new Date().toISOString();
  let state: BoardSnapshotState = { state: "unavailable", buildStartedAt, checkedAt: buildStartedAt, reason: "not_ready" };
  let thread: Worker | undefined;
  let replyPort: MessagePort | undefined;
  let stopped = false;
  let mergedLookup: ((taskId: string) => ReturnType<GitHub["findMergedByTrailer"]>) | null = null;
  const unavailable = (reason: string): void => {
    state = { state: "unavailable", buildStartedAt, checkedAt: new Date().toISOString(), reason };
  };
  const handle: BoardProjectionWorker = {
    current() {
      if (state.state === "ready" && Date.now() - Date.parse(state.snapshot.generated_at) > (options.staleMs ?? BOARD_PROJECTION_STALE_MS)) {
        return { state: "unavailable", buildStartedAt, checkedAt: new Date().toISOString(), reason: "projection_stale" };
      }
      return state.state === "unavailable" ? { ...state, checkedAt: new Date().toISOString() } : state;
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
            reply = { ok: true, value };
          } catch (error) {
            reply = { ok: false, error: String((error as Error)?.message ?? error) };
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
