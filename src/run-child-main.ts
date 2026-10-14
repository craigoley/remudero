// src/run-child-main.ts — W1-T9082. Decision record: docs/adr/0007-build-runs-outlive-the-daemon.md (A.1, A.9).
//
// The run child's entry (`CHILD_ENTRIES` name `run-child`). Only `--probe` is implemented: the shadow probe a daemon starts
// beside an in-process run (src/lib/run-child.ts). It reads the spec the daemon wrote, loads what a run loads, reads the
// plan snapshot the spec names, writes its status through the run-child contract and exits. It never touches a task.
// The verb that runs a task arrives with the spawn task; until then it refuses, loudly, rather than pretend.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { runsBundled } from "./lib/child-entry-argv.js";
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
}

export interface RunChildMainPorts {
  /** Loads the modules a run loads. The default imports the run path's entry module, whose static graph is that set. */
  loadRunPath?: () => Promise<unknown>;
  clock?: () => number;
  probe?: RunChildProbe;
  maxRssBytes?: () => number;
  stderr?: (text: string) => void;
}

const defaultLoadRunPath = (): Promise<unknown> => import("./run-task.js");

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : undefined;
}

/** The plan snapshot's task count, or why it cannot be read. The daemon writes `{ schema, tasks }` (run-child.ts). */
function readPlanSnapshot(path: string): { tasks: number } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { error: `plan snapshot ${path} unreadable: ${(error as Error).message}` };
  }
  const tasks = (parsed as { tasks?: unknown } | null)?.tasks;
  return Array.isArray(tasks) ? { tasks: tasks.length } : { error: `plan snapshot ${path} holds no tasks array` };
}

/** Runs the verb; resolves to the process exit code. NEVER rejects: every failure is written to the status first. */
export async function runChildMain(argv: readonly string[], deps: RunChildMainPorts = {}): Promise<number> {
  const stderr = deps.stderr ?? ((text: string) => void process.stderr.write(text));
  const dir = argValue(argv, "--run-dir");
  if (dir === undefined) {
    stderr("run-child: --run-dir <dir> is required\n");
    return 2;
  }
  if (!argv.includes("--probe")) {
    stderr("run-child: only --probe is implemented; running a task as a child arrives with the spawn task (W1-T9082)\n");
    return 2;
  }
  const clock = deps.clock ?? Date.now;
  const runId = basename(dir);
  const identity = childIdentity(process.pid, deps.probe) ?? {
    pid: process.pid, startTicks: "unknown", containerGeneration: (deps.probe ?? realRunChildProbe).generation(),
  };
  let engineSha = "unknown";
  const status = (state: RunChildStatus["state"], phase: string, extras: Partial<ProbeStatusExtras>, failure?: RunChildFailure): void => {
    const next: RunChildStatus = {
      schema: RUN_CHILD_SCHEMA, runId, identity, engineSha, entryKind: runsBundled() ? "bundle" : "tsx",
      phase, heartbeatAt: clock(), state, ...(failure ? { failure } : {}),
    };
    writeStatus(dir, { ...next, probe: true, ...extras } as RunChildStatus);
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
    status("starting", "load", {});
    const loadStart = clock();
    await (deps.loadRunPath ?? defaultLoadRunPath)();
    const loadMs = clock() - loadStart;
    const snapshot = readPlanSnapshot(spec.value.planSnapshotPath);
    const maxRssBytes = (deps.maxRssBytes ?? (() => process.resourceUsage().maxRSS * 1024))();
    if ("error" in snapshot) {
      status("failed", "plan", { loadMs, maxRssBytes }, { class: "unknown", reasonClass: "plan_snapshot_unreadable", message: snapshot.error });
      return 1;
    }
    status("done", "done", { loadMs, planTasks: snapshot.tasks, maxRssBytes });
    return 0;
  } catch (error) {
    try {
      status("failed", "probe", {}, toRunChildFailure(error));
    } catch (writeError) {
      stderr(`run-child: could not write the failed status: ${(writeError as Error).message}\n`);
    }
    stderr(`run-child: probe failed: ${(error as Error)?.stack ?? String(error)}\n`);
    return 1;
  }
}

// diff-cov: process-boundary - direct CLI guard; imported tests cover `runChildMain()`, while this wrapper only exits.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runChildMain(process.argv.slice(2)).then((code) => process.exit(code));
}
