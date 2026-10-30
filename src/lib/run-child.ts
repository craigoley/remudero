// src/lib/run-child.ts — W1-T9082. Decision record: docs/adr/0007-build-runs-outlive-the-daemon.md (A.8, A.9, C).
//
// The daemon's side of the run-child SHADOW. Under `sweep.runChild.mode: shadow` each dispatched run also starts one PROBE child
// beside the in-process run. The probe runs `src/run-child-main.ts --probe` from the newest current ENGINE TREE, under a
// reservation of the class `run-child-probe`, reads the plan snapshot the daemon admitted the task against, round-trips the
// run-child contract, and the daemon ledgers `run_child.shadow`: what the child cost (load time, tree peak), which entry kind
// it ran as and why. Nothing here touches the run. A probe that fails ledgers why, and `startRunChildProbe` never rejects.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, truncateSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";

import { childEntrySpawnedRow, CHILD_ENTRY_SPAWNED_STEP, engineChildEntryArgv, type EngineChildLaunch } from "./child-entry-argv.js";
import { childHeapPolicyArgs } from "./daemon-memory-policy.js";
import { type EngineRef, listEngines, newestCurrentEngine, type NewestEngineOptions } from "./engine-tree.js";
import { defaultInstance, type HostMemoryLedgerOptions } from "./host-memory-ledger.js";
import {
  createTreePeakSampler, openLearnedReservation, type LearnedReservation, type PeakStoreOptions, type TreePeakSampler,
} from "./host-memory-learning.js";
import { writeAtomic } from "./fs-race-safe.js";
import { loadRunChildMode, runChildEffectiveMode, type RunChildMode } from "./policy.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { pauseDetail, stopDetail } from "./fleet-control.js";
import { classifyRunChildLoss, decideRunChildMode, RUN_CHILD_ADOPTION_PASS_STEP, type RunChildModeEvidence } from "./run-child-mode.js";
import {
  RUN_CHILD_SCHEMA, classifyRunDir, fromRunChildFailure, isTerminalState, readSpec, readStatus, runDir, writeSpec,
  type RunChildEntryKind, type RunChildFailureClass, type RunChildProbe, type RunChildSpecOptions, type RunChildStatus,
} from "./run-child-contract.js";
import { waitingStarts } from "./host-memory-admission.js";
import { copySelectedRegistryIntent, qualifySelectedRegistryIntent } from "./selected-registry-consumers.js";
import { adoptRunChildReservation, reserveRunChild } from "./run-child-reservation.js";
import type { RunResult } from "./run-result.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";
import { killProcessGroup } from "./worker-containment.js";

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

/** The run's plan-snapshot seam, handing each plan it reads to the probe's slot on the way past. The run gets exactly what `sync` returned
 *  or threw: the tap changes neither. */
export function tapPlanSnapshot<O, R extends AdmittedPlan | Promise<AdmittedPlan>>(slot: AdmittedPlanSlot, sync: (options: O) => R): (options: O) => R {
  return (options) => {
    const synced = sync(options);
    slot.offer(synced);
    return synced;
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
  if (!existsSync(dir)) return [];
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
  return pruneTerminalRunDirs(stateRoot, "probe-", keep);
}

/** Removes terminal run directories named `<prefix>*` beyond the newest `keep`. A directory whose status is not terminal is never touched. */
export function pruneTerminalRunDirs(stateRoot: string, prefix: string, keep: number): string[] {
  const runs = join(stateRoot, "runs");
  if (!existsSync(runs)) return [];
  const probes = readdirSync(runs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
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

export interface RunChildProbePorts {
  /** `sweep.runChild.mode`; the default reads this installation's policy.yaml. */
  readMode?: () => RunChildMode;
  /** main's tip, for `newestCurrentEngine`; default {@link mainTipSha}. */
  mainSha?: (repoDir: string) => Promise<string>;
  engine?: Pick<NewestEngineOptions, "git" | "isCurrent">;
  /** The launch argv for the probe; the default resolves a bundle in the engine tree, else tsx from it. */
  launch?: (engine: EngineRef, args: readonly string[], log: Log) => EngineChildLaunch;
  spawn?: (command: string, args: readonly string[], options: { cwd: string }) => ChildProcess;
  sampler?: TreePeakSampler;
  reserve?: (entryKind: RunChildEntryKind, sampler: TreePeakSampler) => LearnedReservation;
  /** Where the default reservation writes its ledger entry and learns its peak; by default the host-wide locations. */
  ledger?: HostMemoryLedgerOptions;
  store?: PeakStoreOptions;
  clock?: () => number;
  timeoutMs?: number;
  planWaitMs?: number;
  sampleMs?: number;
}

export type RunChildProbeOutcome =
  | { started: false; reason: string }
  | { started: true; row: Record<string, unknown> };

const reasonOf = (error: unknown): string => String((error as Error)?.message ?? error).slice(0, 400);

/**
 * W1-T9906: main's tip as last fetched into `repoDir`, the commit a run child's engine must be reachable from. Never the
 * checkout's HEAD: that moves only at a restart, and every engine is cut at a run worktree's origin/main.
 */
export async function mainTipSha(repoDir: string): Promise<string> {
  try {
    return (await hostWorktreeGitAsync(repoDir, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"])).trim();
  } catch (error) {
    throw new Error(`origin/main tip unreadable: ${reasonOf(error)}`);
  }
}

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
export async function startRunChildProbe(input: RunChildProbeInput, seams: RunChildProbePorts = {}): Promise<RunChildProbeOutcome> {
  const options = { ...input.options };
  if (options.selectedRegistryIntent !== undefined) options.selectedRegistryIntent = copySelectedRegistryIntent(options.selectedRegistryIntent);
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
  options.selectedRegistryIntent = await qualifySelectedRegistryIntent(options.selectedRegistryIntent);
  let reservation: LearnedReservation | undefined;
  const runId = `probe-${sanitiseId(input.taskId)}-${clock()}-${randomBytes(2).toString("hex")}`;
  try {
    if (listEngines(input.stateRoot).length === 0) return skip("no engine tree has been built yet");
    let mainSha: string;
    try {
      mainSha = (await (seams.mainSha ?? mainTipSha)(input.repoDir)).trim();
    } catch (error) {
      // Not erased: the skip row carries the reason. A tip that cannot be read is never answered with HEAD.
      return skip(reasonOf(error));
    }
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
      { workerClass: "run-child-probe", root: input.root, entryKind },
      { sampler: s, ...(seams.ledger ? { ledger: seams.ledger } : {}), ...(seams.store ? { store: seams.store } : {}) },
    )))(launch.kind, sampler);
    writeSpec(dir, {
      schema: RUN_CHILD_SCHEMA, taskId: input.taskId, runId, instance: defaultInstance(input.root).name,
      engine: { sourceHash: engine.sourceHash, sha: engine.sha }, planSnapshotPath: snapshot.path,
      reservationId: reservation.id ?? "", options,
    });
    const child = (seams.spawn ?? ((command, args, options) => nodeSpawn(command, [...args], { cwd: options.cwd, stdio: ["ignore", "ignore", "pipe"] })))(
      process.execPath, launch.argv, { cwd: launch.cwd },
    );
    if (child.pid !== undefined) reservation.bindRoot(child.pid);
    const ended = await runProbe(child, sampler, seams.timeoutMs ?? PROBE_TIMEOUT_MS, seams.sampleMs ?? PROBE_SAMPLE_MS);
    const estimateMib = reservation.estimateMib;
    reservation.releaseOccupancy();
    reservation = undefined;
    const row = settleRow({ taskId: input.taskId, runId, dir, engine, launch, ended, peakMib, estimateMib, mode, effective });
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
  peakMib: number | undefined; estimateMib: number | undefined; mode: RunChildMode; effective: { mode: string; fellBack: boolean };
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
    // W1-T9087: the class estimate the probe was admitted under, so `auto` can ask whether the peak fit it.
    class_estimate_bytes: typeof a.estimateMib === "number" && Number.isFinite(a.estimateMib) ? Math.round(a.estimateMib * 1024 * 1024) : null,
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

// ── the run child (W1-T9085, ADR 0007 A.1-A.4 and A.7) ──────────────────────────────────────────
// Under `sweep.runChild.mode: on` the daemon's `runOne` starts a detached child that runs `runTask` (src/run-child-main.ts) and
// settles from the files the child writes, never from a pipe. A child that cannot be started returns `started: false` with the
// reason, and the caller runs the task in-process exactly as before: `on` never costs a lane its run.

export const RUN_CHILD_SPAWNED_STEP = "run_child.spawned";
export const RUN_CHILD_FALLBACK_STEP = "run_child.fallback";
export const RUN_CHILD_LOST_STEP = "run_child.lost";
export const RUN_CHILD_ABORT_STEP = "run_child.abort";
export const RUN_CHILD_ADMISSION_WAITING_STEP = "run_child.admission_waiting";
export const RUN_CHILD_SPAWN_ABANDONED_STEP = "run_child.spawn_abandoned";
/** W1-T10000: one file per task whose admission wait a restart abandoned, carrying when that wait began. */
export const RUN_CHILD_ADMISSION_WAITS_DIR = "run-child-admission-waits";
export const RUN_CHILD_STDERR_FILE = "stderr.log";
/** BACKSTOP on a child's stderr.log: past it the daemon truncates the file, and the child's descriptor (O_APPEND) goes on writing. */
export const RUN_CHILD_STDERR_MAX_BYTES = 1024 * 1024;
/** How often the daemon re-reads a child's status when `fs.watch` says nothing: the fallback of ADR 0007 A.5. */
export const RUN_CHILD_POLL_MS = 2_000;
/** How often an abort re-reads the child's state. */
export const RUN_CHILD_ABORT_POLL_MS = 250;
/** Terminal run directories kept for inspection; older ones are removed. */
export const RUN_CHILD_RUN_DIRS_KEPT = 64;

/** `args` with `abort` chained into its own `signal`, so either one ends the worker's query. No `abort` returns `args` itself. */
export function chainAbortSignal<T extends { signal?: AbortSignal }>(args: T, abort: AbortSignal | undefined): T {
  if (abort === undefined) return args;
  return { ...args, signal: args.signal === undefined ? abort : AbortSignal.any([args.signal, abort]) };
}

/**
 * Whether a run starts a child: `sweep.runChild.mode` is `on`, or it is `auto` and {@link decideRunChildMode} answers `on` over
 * `evidence` (W1-T9087; no evidence reads as shadow). An unreadable policy is `on: false` WITH its reason: the run stays in-process.
 */
export function runChildModeIsOn(
  read: () => RunChildMode = () => loadRunChildMode(), evidence?: () => RunChildModeEvidence,
): { on: boolean; unreadable?: string } {
  try {
    const mode = read();
    if (mode === "auto") return { on: evidence !== undefined && decideRunChildMode(evidence()).to === "on" };
    return { on: mode === "on" };
  } catch (error) {
    return { on: false, unreadable: reasonOf(error) };
  }
}

/** The last `bytes` of `path`; empty when the file cannot be read (a child that never wrote has nothing to tell). */
export function readFileTail(path: string, bytes = STDERR_TAIL_BYTES): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch (error) {
    void error; // No stderr.log, or it vanished with its directory: there is no tail to report.
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Truncates `path` once it passes `max`. Returns whether it did. */
export function boundStderrLog(path: string, max = RUN_CHILD_STDERR_MAX_BYTES): boolean {
  try {
    if (statSync(path).size <= max) return false;
    truncateSync(path, 0);
    return true;
  } catch (error) {
    void error; // The file is gone with its directory; nothing to bound.
    return false;
  }
}

export interface SpawnRunChildInput {
  taskId: string;
  /** The reservation lane; the default is `implement`. */
  lane?: string;
  stateRoot: string;
  repoDir: string;
  root: string;
  /** The plan the run is admitted against: the daemon's coalesced sync. A rejection falls the run back to in-process. */
  plan: () => Promise<AdmittedPlan>;
  options: RunChildSpecOptions;
  log: Log;
  /** Aborting it aborts the child (as {@link abortRunChild}). */
  signal?: AbortSignal;
  /** W1-T10000: told once the engine is chosen and the run waits for its reservation, before any child exists. */
  onPending?: (pending: RunChildPending) => void;
}

/** A run waiting for its child's memory admission. `abort` abandons the wait; it resolves once the wait has ended. */
export interface RunChildPending {
  runId: string;
  abort: () => Promise<void>;
}

export interface SpawnRunChildPorts {
  mainSha?: (repoDir: string) => Promise<string>;
  engine?: Pick<NewestEngineOptions, "git" | "isCurrent">;
  launch?: (engine: EngineRef, args: readonly string[], log: Log) => EngineChildLaunch;
  spawn?: (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; stderrFd: number }) => ChildProcess;
  /** Admission and the reservation, in the daemon, before the spawn. The default is {@link reserveRunChild}. */
  reserve?: (entryKind: RunChildEntryKind, runId: string, admission: { signal: AbortSignal; sinceMs?: number }) => Promise<LearnedReservation>;
  /** W1-T10001: the fleet STOP/PAUSE hold, read again once the reservation admits and before the spawn. Default: the local flag files under `input.root`. */
  workerAdmissionHold?: () => { control: "STOP" | "PAUSE"; detail: string } | undefined;
  probe?: RunChildProbe;
  env?: NodeJS.ProcessEnv;
  clock?: () => number;
  pollMs?: number;
  /** `false` leaves the poll as the only reader of the status file. */
  watch?: boolean;
  abort?: Omit<AbortRunChildPorts, "knownPid" | "probe" | "log">;
}

export interface RunChildHandle {
  started: true;
  runId: string;
  dir: string;
  pid: number;
  /** Resolves the child's `RunResult`; rejects with the error the settle loop classifies, or with a lost run. */
  settled: Promise<RunResult>;
  abort(): Promise<AbortRunChildOutcome>;
  /** Receipt only after the daemon processes the outcome; an unwatched child is replayed at the next boot. */
  acknowledge?: (outcome: PromiseSettledResult<RunResult>) => void;
  /** Stop local observation without signalling the child or releasing its reservation. */
  detach?: () => void;
}

/** W1-T10001: a run child gone with a non-terminal status. `loss` is what {@link classifyRunChildLoss} names from the detail and stderr the `run_child.lost` row carries. */
export class RunChildLostError extends RmdError {
  readonly loss: ReturnType<typeof classifyRunChildLoss>;
  constructor(message: string, loss: ReturnType<typeof classifyRunChildLoss>) {
    super("child_process", GENERIC_EXIT_CODE, message, { loss });
    this.name = "RunChildLostError";
    this.loss = loss;
  }
}

/** W1-T10001: the outside kills a lane survives. An OOM kill or a container stop took the child, not the contract; any other loss keeps the crashed-run path. */
export function runChildOutsideKill(err: unknown): "oom_kill" | "container_stop" | undefined {
  if (!(err instanceof RunChildLostError)) return undefined;
  return err.loss === "oom_kill" || err.loss === "container_stop" ? err.loss : undefined;
}

/** W1-T10001: a reservation admitted under a fleet hold released itself and spawned no child. */
export const RUN_CHILD_SPAWN_WITHHELD_STEP = "run_child.spawn_withheld";

/** W1-T10000: the wait for admission was abandoned. No claim was taken and no spec written, so nothing may run in-process. */
export interface RunChildAbandoned {
  started: false;
  abandoned: true;
  reason: "admission-abandoned";
  runId: string;
  waitedMs: number;
}

export type RunChildLaunch = { started: false; reason: string; abandoned?: undefined } | RunChildAbandoned | RunChildHandle;

function admissionWaitPath(stateRoot: string, taskId: string): string {
  return join(stateRoot, RUN_CHILD_ADMISSION_WAITS_DIR, `${sanitiseId(taskId)}.json`);
}

/** When the abandoned admission wait for `taskId` began, carried across a restart; `undefined` when none was carried. */
export function readCarriedAdmissionWait(stateRoot: string, taskId: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(admissionWaitPath(stateRoot, taskId), "utf8");
  } catch (error) {
    void error; // ENOENT is the usual answer: no wait was abandoned for this task.
    return undefined;
  }
  try {
    const sinceMs = (JSON.parse(raw) as { sinceMs?: unknown }).sinceMs;
    return typeof sinceMs === "number" && Number.isFinite(sinceMs) ? sinceMs : undefined;
  } catch (error) {
    void error; // A torn file carries no position; the run queues from now, as it did before W1-T10000.
    return undefined;
  }
}

/** W1-T10000: the reservation wait. The caller is told the run is pending, and its abort abandons the wait. */
async function reserveWhilePending(
  input: SpawnRunChildInput, ports: SpawnRunChildPorts, entryKind: RunChildEntryKind, runId: string, clock: () => number, log: Log,
): Promise<{ held: LearnedReservation } | RunChildAbandoned> {
  const pending = new AbortController();
  const signal = pending.signal;
  const waitPath = admissionWaitPath(input.stateRoot, input.taskId);
  const carried = readCarriedAdmissionWait(input.stateRoot, input.taskId);
  const enteredMs = clock();
  const sinceMs = Math.min(enteredMs, carried ?? enteredMs);
  const carriedRow = carried === undefined ? {} : { carried_ms: enteredMs - sinceMs };
  const abandon = (): RunChildAbandoned => {
    const waitedMs = Math.max(0, clock() - sinceMs);
    let carryError: string | undefined;
    try {
      writeAtomic(waitPath, JSON.stringify({ taskId: input.taskId, runId, sinceMs }));
    } catch (error) {
      carryError = reasonOf(error); // ledgered on the abandoned row: the next spawn then queues from its own start
    }
    log(RUN_CHILD_SPAWN_ABANDONED_STEP, { task_id: input.taskId, run_id: runId, waited_ms: waitedMs, ...carriedRow,
      ...(carryError === undefined ? {} : { carry_error: carryError }) });
    return { started: false, abandoned: true, reason: "admission-abandoned", runId, waitedMs };
  };
  let ended!: () => void;
  const settled = new Promise<void>((resolve) => { ended = resolve; });
  log(RUN_CHILD_ADMISSION_WAITING_STEP, { task_id: input.taskId, run_id: runId, queue_length: waitingStarts().length, ...carriedRow });
  try {
    input.onPending?.({ runId, abort: () => { pending.abort(); return settled; } });
    const reservation = await (ports.reserve ?? ((kind, id, admission) => reserveRunChild(
      { lane: input.lane ?? "implement", root: input.root, runId: id, taskId: input.taskId, entryKind: kind, ...admission },
    )))(entryKind, runId, { signal, ...(carried === undefined ? {} : { sinceMs }) });
    if (!signal.aborted) return { held: reservation };
    reservation.releaseOccupancy();
    return abandon();
  } catch (error) {
    if (signal.aborted) return abandon();
    throw error;
  } finally {
    ended();
  }
}

const defaultRunChildSpawn: NonNullable<SpawnRunChildPorts["spawn"]> = (command, args, options) =>
  nodeSpawn(command, [...args], { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "ignore", options.stderrFd] });

/**
 * Starts the run child for `input.taskId` and returns the handle its result settles through. Admission and the reservation happen
 * here, in the daemon, and the reservation is bound to the child's pid; the child is a process-group leader and `unref`'d.
 * NEVER rejects: a child that cannot be started returns `started: false` and ledgers `run_child.fallback`.
 */
export async function spawnRunChild(input: SpawnRunChildInput, ports: SpawnRunChildPorts = {}): Promise<RunChildLaunch> {
  const options = { ...input.options };
  if (options.selectedRegistryIntent !== undefined) options.selectedRegistryIntent = copySelectedRegistryIntent(options.selectedRegistryIntent);
  const clock = ports.clock ?? Date.now;
  const log: Log = (step, extra) => {
    try {
      input.log(step, extra);
    } catch (error) {
      void error; // The ledger is the only place a child reports to; a failing one leaves nothing else to tell.
    }
  };
  const runId = `run-${sanitiseId(input.taskId)}-${clock()}-${randomBytes(2).toString("hex")}`;
  const unavailable = (reason: string): RunChildLaunch => {
    log(RUN_CHILD_FALLBACK_STEP, { task_id: input.taskId, run_id: runId, reason });
    return { started: false, reason };
  };
  let reservation: LearnedReservation | undefined;
  let stderrFd: number | undefined;
  let child: ChildProcess;
  let dir: string;
  let launch: EngineChildLaunch;
  let engineSha = "";
  const nodeArgs = childHeapPolicyArgs();
  try {
    options.selectedRegistryIntent = await qualifySelectedRegistryIntent(options.selectedRegistryIntent);
    if (listEngines(input.stateRoot).length === 0) return unavailable("no engine tree has been built yet");
    const mainSha = (await (ports.mainSha ?? mainTipSha)(input.repoDir)).trim();
    const engine = await newestCurrentEngine(input.stateRoot, mainSha, { repoDir: input.repoDir, log, ...ports.engine });
    if (!engine) return unavailable("no current engine tree for main");
    engineSha = engine.sha;
    const admitted = await input.plan();
    dir = runDir(input.stateRoot, runId);
    launch = (ports.launch ?? ((tree, args) => engineChildEntryArgv(tree.root, RUN_CHILD_ENTRY.name, RUN_CHILD_ENTRY.source, args, undefined, { log })))(
      engine, ["--run-dir", dir], log,
    );
    log(CHILD_ENTRY_SPAWNED_STEP, childEntrySpawnedRow(RUN_CHILD_ENTRY.name, "run", launch));
    const waited = await reserveWhilePending(input, ports, launch.kind, runId, clock, log);
    if (!("held" in waited)) return waited;
    reservation = waited.held;
    // W1-T10001: the wait can outlast a PAUSE that began meanwhile; no child starts past it. It takes the abandoned path:
    // no claim, no run directory, no run.start, no strike, and never in-process under the hold.
    const hold = (ports.workerAdmissionHold ?? (() => {
      const stop = stopDetail(input.root);
      if (stop !== undefined) return { control: "STOP" as const, detail: stop };
      const pause = pauseDetail(input.root);
      return pause === undefined ? undefined : { control: "PAUSE" as const, detail: pause };
    }))();
    if (hold) {
      reservation.releaseOccupancy();
      reservation = undefined;
      log(RUN_CHILD_SPAWN_WITHHELD_STEP, { task_id: input.taskId, run_id: runId, hold: `fleet ${hold.control} hold: ${hold.detail}` });
      return { started: false, abandoned: true, reason: "admission-abandoned", runId, waitedMs: 0 };
    }
    // A held reservation spends any carried wait; a state root that refuses the removal fails the spawn like writeSpec would.
    rmSync(admissionWaitPath(input.stateRoot, input.taskId), { force: true });
    // Only now, with the reservation held: a waiting run leaves no spec-less directory behind (W1-T10000).
    mkdirSync(dir, { recursive: true });
    // The snapshot and the spec are written back to back, so a prune between them cannot take a snapshot a spec is about to name.
    const snapshot = writePlanSnapshot(input.stateRoot, admitted.plan.tasks);
    writeSpec(dir, {
      schema: RUN_CHILD_SCHEMA, taskId: input.taskId, runId, instance: defaultInstance(input.root).name,
      engine: { sourceHash: engine.sourceHash, sha: engine.sha }, planSnapshotPath: snapshot.path,
      reservationId: reservation.id ?? "", options,
    });
    stderrFd = openSync(join(dir, RUN_CHILD_STDERR_FILE), "a");
    // The daemon's growth percent rides the child's command line: NODE_OPTIONS refuses it (daemon-memory-policy.ts).
    child = (ports.spawn ?? defaultRunChildSpawn)(process.execPath, [...nodeArgs, ...launch.argv], {
      cwd: launch.cwd, env: { ...(ports.env ?? process.env) }, stderrFd,
    });
    if (child.pid === undefined) throw new Error("the run child has no pid (spawn failed)");
    reservation.bindRoot(child.pid);
  } catch (error) {
    try {
      reservation?.releaseOccupancy();
    } catch (releaseError) {
      void releaseError; // Best effort: the original failure is the one to report.
    }
    return unavailable(`the run child could not be started: ${reasonOf(error)}`);
  } finally {
    if (stderrFd !== undefined) closeSync(stderrFd);
  }
  child.unref();
  const pid = child.pid as number;
  let exited = false;
  child.once("exit", () => { exited = true; });
  const held = reservation as LearnedReservation;
  const abortPorts: AbortRunChildPorts = {
    ...ports.abort, knownPid: () => (exited ? undefined : pid), probe: ports.probe, log, clock: ports.abort?.clock ?? clock,
  };
  const abort = (): Promise<AbortRunChildOutcome> => abortRunChild(dir, abortPorts);
  log(RUN_CHILD_SPAWNED_STEP, {
    task_id: input.taskId, run_id: runId, child_pid: pid, entry_kind: launch.kind, entry_reason: launch.reason, engine_sha: engineSha,
    node_args: nodeArgs,
  });
  const onAbort = (): void => {
    abort().catch((error: unknown) => log(RUN_CHILD_ABORT_STEP, { task_id: input.taskId, run_id: runId, error: reasonOf(error) }));
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  let detach: (() => void) | undefined;
  const settled = awaitRunChild({
    taskId: input.taskId, runId, dir, child, probe: ports.probe, pollMs: ports.pollMs ?? RUN_CHILD_POLL_MS, watch: ports.watch !== false, log,
    onWatch: (stop) => { detach = stop; },
    onEnd: () => {
      input.signal?.removeEventListener("abort", onAbort);
      try {
        held.releaseOccupancy();
        prunePlanSnapshots(input.stateRoot);
        pruneTerminalRunDirs(input.stateRoot, "run-", RUN_CHILD_RUN_DIRS_KEPT);
      } catch (error) {
        log(RUN_CHILD_FALLBACK_STEP, { task_id: input.taskId, run_id: runId, reason: `settle cleanup failed: ${reasonOf(error)}` });
      }
    },
  });
  return { started: true, runId, dir, pid, settled, abort, acknowledge: settlementReceipt(input.taskId, runId, log),
    detach: () => { input.signal?.removeEventListener("abort", onAbort); detach?.(); } };
}

interface AwaitRunChild {
  taskId: string;
  runId: string;
  dir: string;
  child?: ChildProcess;
  probe?: RunChildProbe;
  pollMs: number;
  watch: boolean;
  log: Log;
  onEnd: () => void;
  onWatch?: (stop: () => void) => void;
}

/**
 * The daemon's `runOne` promise for one child: it settles from `status.json` (an `fs.watch` with a poll fallback) and from the
 * child's exit. A terminal `done` resolves its result; `failed` and `aborted` reject with the error the settle loop classifies
 * (`fromRunChildFailure`); a child gone with a non-terminal status is LOST: `run_child.lost` with its stderr tail, then a rejection,
 * the path a crashed in-process run takes. Timers and the watcher are `unref`'d, so they never hold the daemon open.
 */
function awaitRunChild(a: AwaitRunChild): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    let done = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let watcher: FSWatcher | undefined;
    const stderrPath = join(a.dir, RUN_CHILD_STDERR_FILE);
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      clearInterval(timer);
      watcher?.close();
      a.onEnd();
      settle();
    };
    const lost = (detail: string): void => finish(() => {
      a.log(RUN_CHILD_LOST_STEP, {
        task_id: a.taskId, run_id: a.runId, detail, exit_code: exit?.code ?? null, exit_signal: exit?.signal ?? null,
        stderr_tail: readFileTail(stderrPath),
      });
      reject(new RunChildLostError(`run child ${a.runId} lost: ${detail}`, classifyRunChildLoss({ detail, stderr_tail: readFileTail(stderrPath) })));
    });
    const settleTerminal = (status: RunChildStatus): void => {
      if (status.state === "done") {
        if (status.result) finish(() => resolve(status.result as RunResult));
        else lost("the child reported done without a result");
        return;
      }
      const settlement = fromRunChildFailure(status.failure ?? {
        class: status.state === "aborted" ? "aborted" : "unknown", reasonClass: status.state,
        message: `the run child ended ${status.state} without a failure`,
      });
      if (settlement.kind === "error") finish(() => reject(settlement.error));
      else lost(settlement.detail);
    };
    const check = (): void => {
      if (done) return;
      boundStderrLog(stderrPath);
      const read = readStatus(a.dir);
      if (read.ok && isTerminalState(read.value.state)) return settleTerminal(read.value);
      if (exit !== undefined) {
        return lost(`the child exited (${exit.code ?? exit.signal}) in state ${read.ok ? read.value.state : `unreadable: ${read.detail}`}`);
      }
      const classified = classifyRunDir(a.dir, a.probe);
      if (classified.kind === "lost" || classified.kind === "dead") {
        // The status was read BEFORE the pid probe: a child that wrote `done` and exited in between reads as gone. Re-read first.
        const settledSince = readStatus(a.dir);
        if (settledSince.ok && isTerminalState(settledSince.value.state)) return settleTerminal(settledSince.value);
        lost(classified.detail ?? classified.kind);
      }
    };
    a.child?.once("exit", (code, signal) => { exit = { code, signal }; check(); });
    a.child?.once("error", (error) => {
      exit = { code: null, signal: null };
      lost(`spawn error: ${reasonOf(error)}`);
    });
    const timer = setInterval(check, a.pollMs);
    timer.unref();
    if (a.watch) {
      try {
        watcher = fsWatch(a.dir, () => check());
        watcher.unref();
        watcher.on("error", () => {}); // The poll above is the fallback; a watcher that errors is simply not a reader.
      } catch (error) {
        void error; // No watch support here: the poll above is the only reader, which is what it is for.
      }
    }
    a.onWatch?.(() => { done = true; clearInterval(timer); watcher?.close(); });
    check();
  });
}

export interface AbortRunChildPorts {
  /** The pid the caller started and has not seen exit; absent, the pid comes from a LIVE status (identity proven, never a bare pid). */
  knownPid?: () => number | undefined;
  /** Signals the process GROUP of `pgid`. The default is the worker containment's `killProcessGroup`. */
  kill?: (pgid: number, signal: NodeJS.Signals) => void;
  /** The run's learned teardown time (the yield-cost history). Absent, the abort waits for the status or the loss: no fixed timeout. */
  teardownMs?: () => number | undefined;
  wait?: (ms: number) => Promise<void>;
  clock?: () => number;
  pollMs?: number;
  probe?: RunChildProbe;
  log?: Log;
}

export type AbortRunChildOutcome =
  | { signalled: false; reason: string }
  | { signalled: true; ended: "terminal" | "lost"; killed: boolean };

/**
 * ADR 0007 A.7: SIGTERM to the child's process group. The child's handler stops at its next safe point, writes `aborted` and exits.
 * SIGKILL to the group follows only once the run's learned teardown time has passed without a terminal status; with no history it
 * never kills, and waits for the status or the loss. Resolves once the child has ended.
 */
export async function abortRunChild(dir: string, ports: AbortRunChildPorts = {}): Promise<AbortRunChildOutcome> {
  const kill = ports.kill ?? killProcessGroup;
  const clock = ports.clock ?? Date.now;
  const wait = ports.wait ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  let pid = ports.knownPid?.();
  if (pid === undefined) {
    const classified = classifyRunDir(dir, ports.probe);
    if (classified.kind !== "live" || !classified.status) {
      return { signalled: false, reason: `the run directory is ${classified.kind}${classified.detail ? `: ${classified.detail}` : ""}` };
    }
    pid = classified.status.identity.pid;
  }
  const live = (): boolean => (ports.knownPid ? ports.knownPid() !== undefined : classifyRunDir(dir, ports.probe).kind === "live");
  const budgetMs = ports.teardownMs?.();
  kill(pid, "SIGTERM");
  const startedAt = clock(); // the teardown allowance runs from the signal, never from before it
  ports.log?.(RUN_CHILD_ABORT_STEP, { run_id: basename(dir), child_pid: pid, signal: "SIGTERM", teardown_ms: budgetMs ?? null });
  let killed = false;
  for (;;) {
    const status = readStatus(dir);
    if (status.ok && isTerminalState(status.value.state)) return { signalled: true, ended: "terminal", killed };
    if (!live()) return { signalled: true, ended: "lost", killed };
    if (!killed && budgetMs !== undefined && clock() - startedAt >= budgetMs) {
      kill(pid, "SIGKILL");
      killed = true;
      ports.log?.(RUN_CHILD_ABORT_STEP, { run_id: basename(dir), child_pid: pid, signal: "SIGKILL", waited_ms: clock() - startedAt });
    }
    await wait(ports.pollMs ?? RUN_CHILD_ABORT_POLL_MS);
  }
}

export interface AdoptedRunChild extends RunChildHandle {
  taskId: string;
}

function settlementReceipt(taskId: string, runId: string, log: Log): NonNullable<RunChildHandle["acknowledge"]> {
  let acknowledged = false;
  return (outcome) => {
    if (acknowledged) return;
    log("run_child.settled", { task_id: taskId, run_id: runId, outcome: outcome.status,
      ...(outcome.status === "fulfilled" ? { verdict: outcome.value.verdict } : {
        reason: reasonOf(outcome.reason), ...(outcome.reason instanceof RunChildLostError ? { loss: outcome.reason.loss } : {}),
      }) });
    acknowledged = true;
  };
}

/** Reattach this instance's unfinished runs before boot sweeps can mistake their workers for orphans. */
export function adoptRunChildren(input: {
  stateRoot: string; instance: string; log: Log; settledRunIds: ReadonlySet<string>;
}, ports: { probe?: RunChildProbe; pollMs?: number; watch?: boolean; clock?: () => number;
  reserve?: typeof adoptRunChildReservation } = {}): AdoptedRunChild[] {
  const root = join(input.stateRoot, "runs");
  // W1-T9087: every pass ledgers what it saw, so `auto` can tell a boot that adopted every live child from one that never looked.
  const pass = { live: 0, adopted: 0, unreadable: 0, misidentified: 0 };
  const adopted: AdoptedRunChild[] = [];
  for (const entry of existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || entry.name.startsWith("probe-") || input.settledRunIds.has(entry.name)) continue;
    const dir = join(root, entry.name);
    const spec = readSpec(dir);
    if (!spec.ok || spec.value.instance !== input.instance) continue;
    if (spec.value.runId !== entry.name) {
      // A LIVE process under a directory whose spec names another run is a misidentified child; a dead one is only debris.
      if (classifyRunDir(dir, ports.probe).kind === "live") {
        pass.live += 1;
        pass.misidentified += 1;
        input.log("run_child.adoption_misidentified", { run_id: entry.name, spec_run_id: spec.value.runId, task_id: spec.value.taskId });
      }
      continue;
    }
    const classified = classifyRunDir(dir, ports.probe);
    const { taskId, runId } = spec.value;
    const pid = classified.status?.identity.pid ?? 0;
    if (classified.kind === "unreadable") {
      pass.unreadable += 1;
      input.log("run_child.adoption_unreadable", { task_id: taskId, run_id: runId, reason: classified.detail });
      continue;
    }
    const reservation = classified.kind === "live"
      ? (ports.reserve ?? adoptRunChildReservation)(dir, { ledger: { root: join(input.stateRoot, "..") } }, ports.probe) : undefined;
    if (classified.kind === "live") {
      pass.live += 1;
      pass.adopted += 1;
      input.log("run_child.adopted", {
        task_id: taskId, run_id: runId, pid, engine_sha: classified.status!.engineSha,
        age_ms: Math.max(0, (ports.clock ?? Date.now)() - statSync(dir).birthtimeMs),
      });
    }
    let detach: (() => void) | undefined;
    const settled = awaitRunChild({
      taskId, runId, dir, probe: ports.probe, pollMs: ports.pollMs ?? RUN_CHILD_POLL_MS,
      watch: ports.watch !== false, log: input.log, onWatch: (stop) => { detach = stop; }, onEnd: () => { reservation?.releaseOccupancy(); },
    });
    // Boot does more work before the pool attaches its handlers; retain the rejection on the handle.
    void settled.catch((error: unknown) => { void error; /* The pool owns and classifies this rejection. */ });
    adopted.push({ started: true, taskId, runId, dir, pid, settled, acknowledge: settlementReceipt(taskId, runId, input.log), detach: () => detach?.(), abort: () => abortRunChild(dir, { probe: ports.probe, log: input.log }) });
  }
  input.log(RUN_CHILD_ADOPTION_PASS_STEP, pass);
  return adopted;
}
