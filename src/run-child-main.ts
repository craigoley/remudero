// src/run-child-main.ts — W1-T9082. Decision record: docs/adr/0007-build-runs-outlive-the-daemon.md (A.1, A.9).
//
// The run child's entry (`CHILD_ENTRIES` name `run-child`). `--probe` (W1-T9082) is the shadow probe a daemon starts beside an
// in-process run (src/lib/run-child.ts): it reads the spec, loads what a run loads, reads the plan snapshot the spec names,
// writes its status through the run-child contract and exits, never touching a task.
// Without `--probe` (W1-T9085) it RUNS the task: `runTask` with the spec's options and the plan snapshot as its plan, under the
// spec's reservation, as the actor `run_child`. It awaits the run's fire-and-forget work (the paired trials) before its terminal
// status, and SIGTERM aborts the run through the AbortController the worker spawns chain (ADR 0007 A.7).
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

import { collectAtAgentWait, type AgentWaitHeap } from "./lib/agent-wait-heap.js";
import { runsBundled } from "./lib/child-entry-argv.js";
import { startInstallationTokenRefresh } from "./lib/github-app.js";
import { markRunChildProcessActor } from "./lib/ledger.js";
import type { Plan, Task } from "./lib/plan.js";
import { DETACHED_WORK_CAPABILITY, HOSTED_DETACHED_WORK_KINDS, readWorkSpec, type DetachedWorkKind, type DetachedWorkSpec } from "./lib/run-child.js";
import { withRunChildReservation } from "./lib/run-child-reservation.js";
import type { RunResult } from "./lib/run-result.js";
import {
  RUN_CHILD_DIR_ENV, RUN_CHILD_SOCKET_ENV, startRunChildGitCredentialSocket, type CredentialHelperSocketHandle,
} from "./lib/secret-boundary.js";
import {
  RUN_CHILD_SCHEMA, childIdentity, contractMismatchFailure, readSpec, realRunChildProbe, toRunChildFailure, writeStatus,
  type RunChildFailure, type RunChildProbe, type RunChildStatus,
} from "./lib/run-child-contract.js";

/** What a probe's status carries beyond the contract's fields. The contract reader ignores them (a newer minor's fields
 *  are ignored by design); the daemon reads them from the raw file. */
export interface ProbeStatusExtras {
  probe: true;
  loadMs?: number;
  planTasks?: number;
  maxRssBytes?: number;
  work?: DetachedWorkSpec;
}

/** The slice of `runTask` this entry drives; the real one is loaded from the run path, a test injects its own. */
export type RunChildRunTask = (taskId: string, options: Record<string, unknown>) => Promise<RunResult>;

/** W1-T9114: the slice of `runDetachedWork` this entry drives for a spec that carries `work` (the run path exports the real one). */
export type RunChildDetachedWork = (
  work: DetachedWorkSpec,
  /** `onPhase` writes the work's own phase (a fix's admission, worker or CI wait) to the owned `status.json`, the adoption identity's file. */
  ctx: { runId: string; taskId: string; onPhase?: (phase: string) => void },
) => Promise<RunResult>;

/** The signals this entry listens on; the default is the process itself. */
export interface RunChildSignalSource {
  on(signal: "SIGTERM", handler: () => void): unknown;
  off(signal: "SIGTERM", handler: () => void): unknown;
}

/** How often a running child rewrites its status, so `heartbeatAt` moves while the run does. */
export const RUN_CHILD_HEARTBEAT_MS = 15_000;

export interface RunChildMainPorts {
  /** The run to execute; the default is the `runTask` the loaded run path exports. */
  runTask?: RunChildRunTask;
  /** W1-T9114: the detached work to execute for a spec that carries `work`; the default is the loaded run path's `runDetachedWork`. */
  runDetachedWork?: RunChildDetachedWork;
  signals?: RunChildSignalSource;
  heartbeatMs?: number;
  /** Loads the modules a run loads. The default imports the run path's entry module, whose static graph is that set. */
  loadRunPath?: () => Promise<unknown>;
  clock?: () => number;
  probe?: RunChildProbe;
  maxRssBytes?: () => number;
  stderr?: (text: string) => void;
  stdout?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  tokenRefresh?: Omit<Parameters<typeof startInstallationTokenRefresh>[0], "env" | "log">;
  startCredentialSocket?: typeof startRunChildGitCredentialSocket;
  /** The collection at the start of each agent wait; the default is src/lib/agent-wait-heap.ts's. */
  atAgentWait?: () => Promise<AgentWaitHeap>;
}

const defaultLoadRunPath = (): Promise<unknown> => import("./run-task.js");

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : undefined;
}

/** The plan snapshot's task count, or why it cannot be read. The daemon writes `{ schema, tasks }` (run-child.ts). */
function readPlanSnapshot(path: string): { tasks: number; list: Task[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { error: `plan snapshot ${path} unreadable: ${(error as Error).message}` };
  }
  const tasks = (parsed as { tasks?: unknown } | null)?.tasks;
  return Array.isArray(tasks) ? { tasks: tasks.length, list: tasks as Task[] } : { error: `plan snapshot ${path} holds no tasks array` };
}

type PlanSnapshotSeam = (o: { allowStale?: boolean }) => { plan: Plan; staleDispatch: boolean };

/**
 * The run's plan-snapshot seam, holding the parsed snapshot only until runTask takes it. This entry lives as long as the
 * run, so a plan it kept would outlive runTask's release of it before the first agent wait. A later ask reads the file
 * again. The parse happens in this function, so no local of the long-lived caller ever holds the task list.
 */
export function planSnapshotHandOver(path: string): { planSnapshot: PlanSnapshotSeam } | { error: string } {
  const first = readPlanSnapshot(path);
  if ("error" in first) return first;
  let handOver: Task[] | undefined = first.list;
  return {
    planSnapshot: () => {
      let list = handOver;
      handOver = undefined;
      if (list === undefined) {
        const reread = readPlanSnapshot(path);
        if ("error" in reread) throw new Error(reread.error);
        list = reread.list;
      }
      return { plan: { tasks: list, byId: new Map(list.map((task) => [task.id, task])) }, staleDispatch: false };
    },
  };
}

/** Runs the verb; resolves to the process exit code. NEVER rejects: every failure is written to the status first. */
export async function runChildMain(argv: readonly string[], deps: RunChildMainPorts = {}): Promise<number> {
  const stderr = deps.stderr ?? ((text: string) => void process.stderr.write(text));
  if (argv.includes("--detached-work-capability")) {
    const kind = argValue(argv, "--detached-work-capability");
    if (!HOSTED_DETACHED_WORK_KINDS.has(kind as DetachedWorkKind)) return 2;
    (deps.stdout ?? ((text: string) => void process.stdout.write(text)))(`${DETACHED_WORK_CAPABILITY}:${kind}\n`);
    return 0;
  }
  const dir = argValue(argv, "--run-dir");
  if (dir === undefined) {
    stderr("run-child: --run-dir <dir> is required\n");
    return 2;
  }
  const probeMode = argv.includes("--probe");
  const clock = deps.clock ?? Date.now;
  const runId = basename(dir);
  const identity = childIdentity(process.pid, deps.probe) ?? {
    pid: process.pid, startTicks: "unknown", containerGeneration: (deps.probe ?? realRunChildProbe).generation(),
  };
  let engineSha = "unknown";
  let refresh: ReturnType<typeof startInstallationTokenRefresh> | undefined;
  let socket: CredentialHelperSocketHandle | undefined;
  const previousDir = process.env[RUN_CHILD_DIR_ENV];
  const previousSocket = process.env[RUN_CHILD_SOCKET_ENV];
  let credentialsEntered = false;
  let credentialFailure: RunChildFailure | undefined;
  // A SIGTERM is an abort. It is heard from the first moment, so one that lands during credentials or load still ends as `aborted`.
  const abort = new AbortController();
  const signals: RunChildSignalSource = deps.signals ?? process;
  const onTerm = (): void => abort.abort();
  if (!probeMode) signals.on("SIGTERM", onTerm);
  let restoreActor: (() => void) | undefined;
  const cleanup = async (): Promise<void> => {
    try {
      try { refresh?.stop?.(); }
      finally {
        const closing = socket;
        socket = undefined;
        await closing?.close();
      }
    } catch (error) {
      credentialFailure = { class: "spawn_infra_blocked", reasonClass: "spawn_infra_blocked", message: `credential cleanup failed: ${String(error)}` };
      throw error;
    }
  };
  const status = (
    state: RunChildStatus["state"], phase: string, extras: Partial<ProbeStatusExtras>, failure?: RunChildFailure, result?: RunResult,
  ): void => {
    const next: RunChildStatus = {
      schema: RUN_CHILD_SCHEMA, runId, identity, engineSha, entryKind: runsBundled() ? "bundle" : "tsx",
      phase, heartbeatAt: clock(), state, ...(failure ? { failure } : {}), ...(result ? { result } : {}),
    };
    writeStatus(dir, (probeMode ? { ...next, probe: true, ...extras } : next) as RunChildStatus);
  };
  /** The run verb: load the run path, run the task under the spec's reservation, await its background work, write the terminal status. */
  const runTaskInChild = async (): Promise<number> => {
    const spec = readSpec(dir);
    if (!spec.ok) throw new Error(`spec unreadable after it was read: ${spec.detail}`);
    const options = spec.value.options;
    // W1-T9114: a spec carrying `work` is detached work (a review), never a build run: it is hosted by `runDetachedWork`, reads no plan.
    const work = readWorkSpec(dir);
    if (work === "malformed") {
      await cleanup();
      status("failed", "spec", {}, contractMismatchFailure("spec names detached work this entry cannot read"));
      return 1;
    }
    let planSnapshot: PlanSnapshotSeam | undefined;
    if (work === undefined && !options.skipGitSync) {
      const handOver = planSnapshotHandOver(spec.value.planSnapshotPath);
      if ("error" in handOver) {
        await cleanup();
        status("failed", "plan", {}, { class: "unknown", reasonClass: "plan_snapshot_unreadable", message: handOver.error });
        return 1;
      }
      planSnapshot = handOver.planSnapshot;
    }
    status("starting", "load", {});
    const loaded = await (deps.loadRunPath ?? defaultLoadRunPath)() as { runTask?: RunChildRunTask; runDetachedWork?: RunChildDetachedWork } | undefined;
    const runTask = deps.runTask ?? loaded?.runTask;
    const detachedWork = deps.runDetachedWork ?? loaded?.runDetachedWork;
    if (work !== undefined ? detachedWork === undefined : runTask === undefined) {
      throw new Error(work !== undefined ? "the loaded run path exports no runDetachedWork" : "the loaded run path exports no runTask");
    }
    restoreActor = markRunChildProcessActor();
    const background: Promise<unknown>[] = [];
    let phase = work !== undefined ? work.kind : "run";
    const beat = setInterval(() => status("running", phase, {}), deps.heartbeatMs ?? RUN_CHILD_HEARTBEAT_MS);
    beat.unref();
    let outcome: { result: RunResult } | { error: unknown };
    try {
      status("running", phase, {});
      const aborted = (): { error: unknown } => ({ error: Object.assign(new Error("aborted before the run finished"), { name: "AbortError" }) });
      if (work !== undefined && detachedWork !== undefined && !abort.signal.aborted) {
        // Detached work has no safe point to stop at: a SIGTERM ends it as `aborted` at once, and the process exit takes the work with it.
        const stopped = new Promise<{ error: unknown }>((resolve) => { abort.signal.addEventListener("abort", () => resolve(aborted()), { once: true }); });
        outcome = await Promise.race([
          withRunChildReservation(spec.value, () => detachedWork(work, { runId, taskId: spec.value.taskId, onPhase: (next) => {
            phase = `${work.kind}:${next}`;
            status("running", phase, {});
          } })).then(
            (result): { result: RunResult } => ({ result }), (error: unknown): { error: unknown } => ({ error })),
          stopped,
        ]);
      } else outcome = abort.signal.aborted || runTask === undefined
        ? { error: Object.assign(new Error("aborted before the run started"), { name: "AbortError" }) }
        : { result: await withRunChildReservation(spec.value, () => runTask(spec.value.taskId, {
          ...(options.planPath !== undefined ? { planPath: options.planPath } : {}),
          ...(options.owner !== undefined ? { owner: options.owner } : {}),
          ...(options.allowStale !== undefined ? { allowStale: options.allowStale } : {}),
          ...(options.skipGitSync !== undefined ? { skipGitSync: options.skipGitSync } : {}),
          ...(options.handOffAtPrOpen !== undefined ? { handOffAtPrOpen: options.handOffAtPrOpen } : {}),
          ...(options.pairedTrialHost !== undefined ? { pairedTrialHost: options.pairedTrialHost } : {}),
          ...(planSnapshot ? { planSnapshot } : {}),
          atAgentWait: deps.atAgentWait ?? (() => collectAtAgentWait()),
          abortSignal: abort.signal,
          onBackgroundWork: (pending: Promise<unknown>) => { background.push(pending); },
        })) };
    } catch (error) {
      outcome = { error }; // Carried, not erased: it is rethrown as the run's failure, or recorded as the abort that caused it, below.
    } finally {
      clearInterval(beat);
    }
    // The paired trials outlive runTask's return, so a child that exited on it would cut them off. An abort does not wait for them.
    if (!abort.signal.aborted) await Promise.allSettled(background);
    await cleanup();
    if ("result" in outcome) {
      status("done", "done", {}, undefined, outcome.result);
      return 0;
    }
    if (abort.signal.aborted) {
      status("aborted", "aborted", {}, { ...toRunChildFailure(outcome.error), class: "aborted", reasonClass: "aborted" });
      return 3;
    }
    throw outcome.error;
  };
  try {
    const spec = readSpec(dir);
    if (!spec.ok) {
      status("failed", "spec", {}, contractMismatchFailure(`${spec.reason}: ${spec.detail}`));
      return 1;
    }
    if (spec.value.runId !== runId) {
      status("failed", "spec", {}, contractMismatchFailure(`spec names run ${spec.value.runId}, the directory is ${runId}`));
      return 1;
    }
    engineSha = spec.value.engine.sha;
    status("starting", "credentials", {});
    credentialsEntered = true;
    process.env[RUN_CHILD_DIR_ENV] = dir;
    delete process.env[RUN_CHILD_SOCKET_ENV];
    try {
      refresh = startInstallationTokenRefresh({ ...deps.tokenRefresh, env: deps.env, log: () => {} });
      if (refresh.armed) {
        const minted = await refresh.firstResult;
        if (minted === undefined || minted.ok === false) throw new Error("run child's first installation token mint failed");
        // This entry also hosts the socket thread; it is already bundled in the pinned engine tree.
        socket = await (deps.startCredentialSocket ?? startRunChildGitCredentialSocket)({
          runDir: dir, log: () => {},
          ...(runsBundled() ? { threadUrl: new URL("../dist/child-entries/run-child.mjs", import.meta.url) } : {}),
        });
        process.env[RUN_CHILD_SOCKET_ENV] = socket.socketPath;
      }
    } catch (error) {
      await cleanup();
      status("failed", "credentials", {}, { class: "spawn_infra_blocked", reasonClass: "spawn_infra_blocked", message: `credential startup failed: ${String(error)}` });
      return 1;
    }
    if (!probeMode) return await runTaskInChild();
    status("starting", "load", {});
    const loadStart = clock();
    const loaded = await (deps.loadRunPath ?? defaultLoadRunPath)() as { runDetachedWork?: RunChildDetachedWork } | undefined;
    const loadMs = clock() - loadStart;
    const work = readWorkSpec(dir);
    if (work === "malformed" || (work !== undefined && typeof (deps.runDetachedWork ?? loaded?.runDetachedWork) !== "function")) {
      await cleanup();
      status("failed", "spec", { loadMs }, contractMismatchFailure("probe cannot host its detached work envelope"));
      return 1;
    }
    if (work !== undefined) {
      await cleanup();
      status("done", "done", { loadMs, work, maxRssBytes: (deps.maxRssBytes ?? (() => process.resourceUsage().maxRSS * 1024))() });
      return 0;
    }
    const snapshot = readPlanSnapshot(spec.value.planSnapshotPath);
    const maxRssBytes = (deps.maxRssBytes ?? (() => process.resourceUsage().maxRSS * 1024))();
    if ("error" in snapshot) {
      await cleanup();
      status("failed", "plan", { loadMs, maxRssBytes }, { class: "unknown", reasonClass: "plan_snapshot_unreadable", message: snapshot.error });
      return 1;
    }
    await cleanup();
    status("done", "done", { loadMs, planTasks: snapshot.tasks, maxRssBytes });
    return 0;
  } catch (error) {
    try { await cleanup(); }
    catch (closeError) {
      stderr(`run-child: credential cleanup failed: ${String(closeError)}\n`);
    }
    const failure = credentialFailure ?? toRunChildFailure(error);
    try {
      status("failed", probeMode ? "probe" : "run", {}, failure);
    } catch (writeError) {
      stderr(`run-child: could not write the failed status: ${(writeError as Error).message}\n`);
    }
    stderr(`run-child: ${probeMode ? "probe" : "run"} failed: ${(error as Error)?.stack ?? String(error)}\n`);
    return 1;
  } finally {
    if (!probeMode) {
      signals.off("SIGTERM", onTerm);
      restoreActor?.();
    }
    if (credentialsEntered) {
      if (previousDir === undefined) delete process.env[RUN_CHILD_DIR_ENV];
      else process.env[RUN_CHILD_DIR_ENV] = previousDir;
      if (previousSocket === undefined) delete process.env[RUN_CHILD_SOCKET_ENV];
      else process.env[RUN_CHILD_SOCKET_ENV] = previousSocket;
    }
  }
}

// diff-cov: process-boundary - direct CLI guard; imported tests cover `runChildMain()`, while this wrapper only exits.
if (isMainThread && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runChildMain(process.argv.slice(2)).then((code) => process.exit(code));
}
