// src/lib/run-child.ts — W1-T9082. Decision record: docs/adr/0007-build-runs-outlive-the-daemon.md (A.8, A.9, C).
//
// The daemon's side of the run-child SHADOW. Under `sweep.runChild.mode: shadow` each dispatched run also starts one PROBE child
// beside the in-process run. The probe runs `src/run-child-main.ts --probe` from the newest current ENGINE TREE, under a
// reservation of the class `run-child-probe`, reads the plan snapshot the daemon admitted the task against, round-trips the
// run-child contract, and the daemon ledgers `run_child.shadow`: what the child cost (load time, tree peak), which entry kind
// it ran as and why. Nothing here touches the run. A probe that fails ledgers why, and `startRunChildProbe` never rejects.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { childEntrySpawnedRow, CHILD_ENTRY_SPAWNED_STEP, engineChildEntryArgv, type EngineChildLaunch } from "./child-entry-argv.js";
import { type EngineRef, listEngines, newestCurrentEngine, type NewestEngineOptions } from "./engine-tree.js";
import { defaultInstance } from "./host-memory-ledger.js";
import {
  createTreePeakSampler, openLearnedReservation, type LearnedReservation, type TreePeakSampler,
} from "./host-memory-learning.js";
import { writeAtomic } from "./fs-race-safe.js";
import { loadRunChildMode, runChildEffectiveMode, type RunChildMode } from "./policy.js";
import {
  RUN_CHILD_SCHEMA, isTerminalState, readSpec, readStatus, runDir, writeSpec,
  type RunChildEntryKind, type RunChildFailureClass, type RunChildSpecOptions,
} from "./run-child-contract.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";

export const RUN_CHILD_SHADOW_STEP = "run_child.shadow";
export const RUN_CHILD_SHADOW_SKIPPED_STEP = "run_child.shadow_skipped";
export const PLAN_SNAPSHOTS_DIR = "plan-snapshots";
/** The entry the probe runs: `CHILD_ENTRIES` name and source (scripts/build-child-entries.mjs). */
export const RUN_CHILD_ENTRY = { name: "run-child", source: "src/run-child-main.ts" } as const;
/** BACKSTOP on how long a probe may run before it is killed: the load is seconds, so only a wedged child reaches this. */
export const PROBE_TIMEOUT_MS = 180_000;
/** BACKSTOP on how long a probe waits for the run it shadows to read its plan: a run refused before that never will. */
export const PROBE_PLAN_WAIT_MS = 60_000;
/** How often the probe's tree is sampled while it runs. A probe lives seconds and the sampler's own cadence is 15 s. */
export const PROBE_SAMPLE_MS = 250;
/** Terminal probe run directories kept for inspection; older ones are removed. */
export const PROBE_RUN_DIRS_KEPT = 16;
/** BACKSTOP on the stderr tail a probe row carries. */
const STDERR_TAIL_BYTES = 4_096;

type Log = (step: string, extra?: Record<string, unknown>) => void;

/** What the probe needs of the plan the run was admitted against: the tasks, serialized. */
export interface AdmittedPlan {
  plan: { tasks: readonly unknown[] };
}

/** A promise for the plan a run reads, resolved by the run's own sync. */
export interface AdmittedPlanSlot {
  promise: Promise<AdmittedPlan | undefined>;
  /** Offered by the run's plan-snapshot seam; the first offer wins. */
  offer(synced: AdmittedPlan | Promise<AdmittedPlan>): void;
}

export function createAdmittedPlanSlot(): AdmittedPlanSlot {
  let settle: (plan: AdmittedPlan | undefined) => void = () => {};
  const promise = new Promise<AdmittedPlan | undefined>((resolve) => { settle = resolve; });
  return {
    promise,
    offer(synced) {
      // A sync that rejects is the run's to report; the probe just has no plan to read.
      Promise.resolve(synced).then(settle, () => settle(undefined));
    },
  };
}

// ── the plan snapshot: one file per plan sha ─────────────────────────────────────────────────

export const planSnapshotsDir = (stateRoot: string): string => join(stateRoot, PLAN_SNAPSHOTS_DIR);

/** The sha a plan snapshot is keyed by: the hash of the serialized tasks, so an unchanged plan reuses its file. */
export function planSha(tasks: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(tasks)).digest("hex");
}

/** Writes `<state>/plan-snapshots/<planSha>.json` once per plan sha and returns its path. An existing file is reused. */
export function writePlanSnapshot(stateRoot: string, tasks: readonly unknown[]): { path: string; sha: string; reused: boolean } {
  const sha = planSha(tasks);
  const path = join(planSnapshotsDir(stateRoot), `${sha}.json`);
  if (existsSync(path)) return { path, sha, reused: true };
  writeAtomic(path, `${JSON.stringify({ schema: 1, planSha: sha, tasks })}\n`);
  return { path, sha, reused: false };
}

/**
 * Removes the plan snapshots no non-terminal run directory names, except the newest. A run directory whose status cannot be
 * read counts as non-terminal: a snapshot it may still need is kept. Returns the files removed.
 */
export function prunePlanSnapshots(stateRoot: string): string[] {
  const dir = planSnapshotsDir(stateRoot);
  const files = readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => ({ name, path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }));
  if (files.length === 0) return [];
  const named = new Set<string>();
  const runs = join(stateRoot, "runs");
  for (const entry of existsSync(runs) ? readdirSync(runs, { withFileTypes: true }) : []) {
    if (!entry.isDirectory()) continue;
    const status = readStatus(join(runs, entry.name));
    if (status.ok && isTerminalState(status.value.state)) continue;
    const spec = readSpec(join(runs, entry.name));
    if (spec.ok) named.add(spec.value.planSnapshotPath);
  }
  const newest = files.reduce((a, b) => (b.at > a.at ? b : a));
  const removed: string[] = [];
  for (const file of files) {
    if (file.path === newest.path || named.has(file.path)) continue;
    rmSync(file.path, { force: true });
    removed.push(file.path);
  }
  return removed;
}

/** Removes terminal probe run directories beyond the newest `keep`. Only `probe-*` directories are ever touched. */
export function pruneProbeRunDirs(stateRoot: string, keep = PROBE_RUN_DIRS_KEPT): string[] {
  const runs = join(stateRoot, "runs");
  if (!existsSync(runs)) return [];
  const probes = readdirSync(runs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("probe-"))
    .map((entry) => ({ path: join(runs, entry.name), at: statSync(join(runs, entry.name)).mtimeMs }))
    .filter((probe) => {
      const status = readStatus(probe.path);
      return status.ok && isTerminalState(status.value.state);
    })
    .sort((a, b) => b.at - a.at);
  const removed: string[] = [];
  for (const probe of probes.slice(keep)) {
    rmSync(probe.path, { recursive: true, force: true });
    removed.push(probe.path);
  }
  return removed;
}

// ── the probe ────────────────────────────────────────────────────────────────────────────────

export interface RunChildProbeInput {
  taskId: string;
  /** The `<root>/state` directory: engines, runs and plan snapshots live under it. */
  stateRoot: string;
  /** The managed checkout the engine trees are cut from. */
  repoDir: string;
  /** The instance root a reservation is written under. */
  root: string;
  /** The plan the run was admitted against, once the run has read it. */
  plan: Promise<AdmittedPlan | undefined>;
  /** The serializable `runTask` options the daemon passes the run. */
  options: RunChildSpecOptions;
  log: Log;
}

export interface RunChildProbeSeams {
  /** `sweep.runChild.mode`; the default reads this installation's policy.yaml. */
  readMode?: () => RunChildMode;
  /** main's tip, for `newestCurrentEngine`. */
  mainSha?: (repoDir: string) => Promise<string>;
  engine?: Pick<NewestEngineOptions, "git" | "isCurrent">;
  /** The launch argv for the probe; the default resolves a bundle in the engine tree, else tsx from it. */
  launch?: (engine: EngineRef, args: readonly string[], log: Log) => EngineChildLaunch;
  spawn?: (command: string, args: readonly string[], options: { cwd: string }) => ChildProcess;
  sampler?: TreePeakSampler;
  reserve?: (entryKind: RunChildEntryKind, sampler: TreePeakSampler) => LearnedReservation;
  clock?: () => number;
  timeoutMs?: number;
  planWaitMs?: number;
  sampleMs?: number;
}

export type RunChildProbeOutcome =
  | { started: false; reason: string }
  | { started: true; row: Record<string, unknown> };

const reasonOf = (error: unknown): string => String((error as Error)?.message ?? error).slice(0, 400);

function sanitiseId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Waits for `promise`, or `undefined` after `ms` — a plan that never arrives must not hold the probe. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

interface ChildEnd {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  spawnError?: string;
  timedOut: boolean;
}

/** Runs the probe to its end, sampling its tree while it lives. Resolves; never rejects. */
function runProbe(
  child: ChildProcess, sampler: TreePeakSampler, timeoutMs: number, sampleMs: number,
): Promise<ChildEnd> {
  return new Promise((resolve) => {
    let stderr = "";
    let timedOut = false;
    let done = false;
    const finish = (end: Omit<ChildEnd, "stderr" | "timedOut">): void => {
      if (done) return;
      done = true;
      clearInterval(sampling);
      clearTimeout(killer);
      resolve({ ...end, stderr: stderr.slice(-STDERR_TAIL_BYTES), timedOut });
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES * 2); });
    const sampling = setInterval(() => sampler.sampleNow(), sampleMs);
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => finish({ code: null, signal: null, spawnError: reasonOf(error) }));
    child.once("exit", (code, signal) => finish({ code, signal }));
  });
}

const failureClassOf = (value: unknown): RunChildFailureClass | "ok" => (value === "ok" ? "ok" : (value as RunChildFailureClass));

/**
 * Starts one probe child beside a run, waits for it, and ledgers `run_child.shadow`. NEVER rejects and never touches the run:
 * a caller starts it with `void` and the run goes on. `off` starts nothing and writes nothing; `on` and `auto` run as `shadow`
 * until their tasks land, and the row says so.
 */
export async function startRunChildProbe(input: RunChildProbeInput, seams: RunChildProbeSeams = {}): Promise<RunChildProbeOutcome> {
  const log: Log = (step, extra) => {
    try {
      input.log(step, extra);
    } catch (error) {
      void error; // The ledger is the only place a probe reports to; a failing one leaves nothing else to tell.
    }
  };
  const skip = (reason: string): RunChildProbeOutcome => {
    log(RUN_CHILD_SHADOW_SKIPPED_STEP, { task_id: input.taskId, reason });
    return { started: false, reason };
  };
  const clock = seams.clock ?? Date.now;
  let mode: RunChildMode;
  try {
    mode = (seams.readMode ?? (() => loadRunChildMode()))();
  } catch (error) {
    return skip(`sweep.runChild.mode unreadable: ${reasonOf(error)}`);
  }
  const effective = runChildEffectiveMode(mode);
  if (effective.mode === "off") return { started: false, reason: "mode off" };
  let reservation: LearnedReservation | undefined;
  const runId = `probe-${sanitiseId(input.taskId)}-${clock()}-${randomBytes(2).toString("hex")}`;
  try {
    if (listEngines(input.stateRoot).length === 0) return skip("no engine tree has been built yet");
    const mainSha = (await (seams.mainSha ?? ((dir) => hostWorktreeGitAsync(dir, ["rev-parse", "HEAD"])))(input.repoDir)).trim();
    const engine = await newestCurrentEngine(input.stateRoot, mainSha, { repoDir: input.repoDir, log, ...seams.engine });
    if (!engine) return skip("no current engine tree for main");
    const admitted = await within(input.plan, seams.planWaitMs ?? PROBE_PLAN_WAIT_MS);
    if (!admitted) return skip("the run never read its plan");
    const snapshot = writePlanSnapshot(input.stateRoot, admitted.plan.tasks);

    const dir = runDir(input.stateRoot, runId);
    mkdirSync(dir, { recursive: true });
    const launch = (seams.launch ?? ((tree, args) => engineChildEntryArgv(tree.root, RUN_CHILD_ENTRY.name, RUN_CHILD_ENTRY.source, args, undefined, { log })))(
      engine, ["--run-dir", dir, "--probe"], log,
    );
    log(CHILD_ENTRY_SPAWNED_STEP, childEntrySpawnedRow(RUN_CHILD_ENTRY.name, "--probe", launch));
    let peakMib: number | undefined;
    const base = seams.sampler ?? createTreePeakSampler();
    const sampler: TreePeakSampler = { ...base, finish: (id) => { peakMib = base.finish(id); return peakMib; } };
    reservation = (seams.reserve ?? ((entryKind, s) => openLearnedReservation(
      { workerClass: "run-child-probe", root: input.root, entryKind }, { sampler: s },
    )))(launch.kind, sampler);
    writeSpec(dir, {
      schema: RUN_CHILD_SCHEMA, taskId: input.taskId, runId, instance: defaultInstance(input.root).name,
      engine: { sourceHash: engine.sourceHash, sha: engine.sha }, planSnapshotPath: snapshot.path,
      reservationId: reservation.id ?? "", options: input.options,
    });
    const child = (seams.spawn ?? ((command, args, options) => nodeSpawn(command, [...args], { cwd: options.cwd, stdio: ["ignore", "ignore", "pipe"] })))(
      process.execPath, launch.argv, { cwd: launch.cwd },
    );
    if (child.pid !== undefined) reservation.bindRoot(child.pid);
    const ended = await runProbe(child, sampler, seams.timeoutMs ?? PROBE_TIMEOUT_MS, seams.sampleMs ?? PROBE_SAMPLE_MS);
    reservation.releaseOccupancy();
    reservation = undefined;
    const row = settleRow({ taskId: input.taskId, runId, dir, engine, launch, ended, peakMib, mode, effective });
    log(RUN_CHILD_SHADOW_STEP, row);
    try {
      prunePlanSnapshots(input.stateRoot);
      pruneProbeRunDirs(input.stateRoot);
    } catch (error) {
      log(RUN_CHILD_SHADOW_SKIPPED_STEP, { task_id: input.taskId, reason: `pruning failed: ${reasonOf(error)}` });
    }
    return { started: true, row };
  } catch (error) {
    try {
      reservation?.releaseOccupancy();
    } catch (releaseError) {
      void releaseError; // Best effort: the original failure is the one to report.
    }
    const row = { run_id: runId, task_id: input.taskId, contract: "unknown" satisfies RunChildFailureClass, error: reasonOf(error), mode, behaves_as: effective.mode };
    log(RUN_CHILD_SHADOW_STEP, row);
    return { started: true, row };
  }
}

function settleRow(a: {
  taskId: string; runId: string; dir: string; engine: EngineRef; launch: EngineChildLaunch; ended: ChildEnd;
  peakMib: number | undefined; mode: RunChildMode; effective: { mode: string; fellBack: boolean };
}): Record<string, unknown> {
  const status = readStatus(a.dir);
  let raw: { loadMs?: unknown; maxRssBytes?: unknown; planTasks?: unknown } = {};
  try {
    raw = JSON.parse(readFileSync(join(a.dir, "status.json"), "utf8")) as typeof raw;
  } catch (error) {
    void error; // Unreadable status: `contract` below says so; there is no load time to read.
  }
  let contract: RunChildFailureClass | "ok";
  let error: string | undefined;
  if (a.ended.spawnError !== undefined) {
    contract = "unknown";
    error = `spawn failed: ${a.ended.spawnError}`;
  } else if (!status.ok) {
    contract = status.reason === "contract_mismatch" ? "contract_mismatch" : "unknown";
    error = `status ${status.reason}: ${status.detail}`;
  } else if (status.value.state === "failed" || status.value.state === "aborted") {
    contract = failureClassOf(status.value.failure?.class ?? "unknown");
    error = status.value.failure?.message;
  } else if (status.value.state !== "done" || a.ended.code !== 0) {
    contract = "unknown";
    error = `probe ended in state ${status.value.state}, exit ${a.ended.code ?? a.ended.signal}`;
  } else {
    contract = "ok";
  }
  if (a.ended.timedOut) error = `probe timed out${error ? `: ${error}` : ""}`;
  const peakBytes = a.peakMib === undefined ? null : Math.round(a.peakMib * 1024 * 1024);
  return {
    run_id: a.runId,
    task_id: a.taskId,
    engine_sha: a.engine.sha,
    entry_kind: a.launch.kind,
    entry_reason: a.launch.reason,
    load_ms: typeof raw.loadMs === "number" ? raw.loadMs : null,
    tree_peak_bytes: peakBytes,
    child_max_rss_bytes: typeof raw.maxRssBytes === "number" ? raw.maxRssBytes : null,
    plan_tasks: typeof raw.planTasks === "number" ? raw.planTasks : null,
    exit_code: a.ended.code,
    contract,
    mode: a.mode,
    behaves_as: a.effective.mode,
    ...(a.effective.fellBack ? { mode_note: `sweep.runChild.mode ${a.mode} is not implemented yet; it behaves as shadow` } : {}),
    ...(error !== undefined ? { error: error.slice(0, 400) } : {}),
    ...(a.ended.stderr && contract !== "ok" ? { stderr_tail: a.ended.stderr } : {}),
  };
}
