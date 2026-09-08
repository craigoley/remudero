/**
 * One daemon-lifetime repository-maintenance controller.
 *
 * This module deliberately uses Git's maintenance tasks and never removes gc.log itself. The
 * caller supplies the already-observed active-lane count, so registered but idle worktrees are
 * not confused with live work. Unreadable evidence always defers.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { EventEmitter } from "node:events";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { PassThrough } from "node:stream";

import { fixedClock, systemClock, type Clock } from "./clock.js";
import {
  spawnDetachedGroup,
  teardownProcessGroup,
  type ContainedSpawnOptions,
  type ContainedProcess,
} from "./worker-containment.js";

export type RepositoryMaintenanceVerdict =
  | "healthy"
  | "incremental-due"
  | "full-gc-due"
  | "deferred"
  | "escalate";

<<<<<<< HEAD
export interface ObjectReapDeps {
  /** Registered worktrees for the repo. Non-empty REFUSES. */
  listWorktrees?: (repoDir: string) => readonly string[];
  /** Inflight lock files. Non-empty REFUSES. */
  listInflightLocks?: () => readonly string[];
  /** Open-handle count under `.git`. Non-zero REFUSES; unreadable must return >0 (fail closed). */
  openFileCount?: (dir: string) => number;
  /** Loose object count. */
  looseObjectCount?: (repoDir: string) => number;
  /** Runs the prune. Injected so a test can assert the ARGV, which is where the expiry lives. */
  runPrune?: (repoDir: string, args: readonly string[]) => void;
  /** SURVEY MODE. Every check the armed path runs still runs; nothing is spawned and nothing is
   *  removed. ONE PREDICATE, TWO OUTCOMES — a survey that reached different probes would report a
   *  decision nobody will ever make, which is the whole point of reading dispositions first. */
  dryRun?: boolean;
  /** Counts what a prune WOULD remove, for the survey. An ESTIMATE AT SURVEY TIME: the armed pass
   *  runs later, against a repo that has moved. */
  countPrunable?: (repoDir: string, args: readonly string[]) => number;
}

export interface ObjectReapResult {
  /** Objects removed, or 0 when refused OR surveying. */
  pruned: number;
  /** SURVEY ONLY: what a prune would have removed. Undefined on an armed pass. An estimate. */
  wouldPrune?: number;
  /** Present iff nothing was pruned. Names the cause in the operator's own vocabulary. */
  refusedBecause?: string;
  looseBefore: number;
=======
export interface RepositorySurvey {
  readable: boolean;
  detail?: string;
  looseCount?: number;
  looseBytes?: number;
  packCount?: number;
  gcLogPresent?: boolean;
  gcLogDetail?: string;
  activeLaneCount: number;
  diskVerdict: string;
}

export interface RepositoryMaintenanceState {
  lastAttemptIso?: string;
  lastSuccessIso?: string;
  nextEligibleIso?: string;
  /** Set once when the durable failure episode crosses the escalation threshold. */
  escalationRecordedIso?: string;
  consecutiveFailures: number;
>>>>>>> de8c8a6ed (feat(maintenance): automate Git object hygiene)
}

export interface RepositoryMaintenancePolicy {
  incrementalIntervalMs: number;
  timeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  escalationThreshold: number;
}

export const DEFAULT_REPOSITORY_MAINTENANCE_POLICY: RepositoryMaintenancePolicy = Object.freeze({
  incrementalIntervalMs: 24 * 60 * 60 * 1_000,
  timeoutMs: 10 * 60 * 1_000,
  retryBaseMs: 60 * 60 * 1_000,
  retryMaxMs: 8 * 60 * 60 * 1_000,
  escalationThreshold: 3,
});

export interface RepositoryMaintenanceDecision {
  verdict: RepositoryMaintenanceVerdict;
  reason: string;
  nextEligibleIso?: string;
}

export interface RepositoryMaintenanceInput {
  repoDir: string;
  survey: RepositorySurvey;
  readPostSurvey?: () => RepositorySurvey;
  state: RepositoryMaintenanceState;
  policy: RepositoryMaintenancePolicy;
}

type SpawnedChild = EventEmitter & {
  stdin?: PassThrough;
  stdout?: PassThrough;
  stderr?: PassThrough;
};

export interface RepositoryMaintenanceDeps {
  clock?: Clock;
  jitter?: () => number;
  /** Injection seam for proving the maintenance child receives no provider credentials. */
  env?: NodeJS.ProcessEnv;
  spawn?: (
    options: ContainedSpawnOptions,
    onStderr?: (chunk: string) => void,
    onSpawnError?: (err: NodeJS.ErrnoException) => void,
  ) => ContainedProcess;
  teardown?: (pgid: number) => void;
  log?: (step: string, fields: Record<string, unknown>) => void;
}

export interface RepositoryMaintenanceResult {
  decision: RepositoryMaintenanceDecision;
  state: RepositoryMaintenanceState;
  outcome?: "succeeded" | "failed";
  postSurvey?: RepositorySurvey;
  exitCode?: number | null;
}

export interface RepositoryMaintenanceStatus {
  verdict: "never-run" | "healthy" | "due" | "backoff" | "retry-due" | "escalate";
  lastAttemptIso?: string;
  lastSuccessIso?: string;
  nextEligibleIso?: string;
  consecutiveFailures: number;
  retryPending: boolean;
}

export type RepositoryMaintenanceCadenceResult =
  | { kind: "not-due"; status: RepositoryMaintenanceStatus }
  | { kind: "deferred"; reason: string }
  | { kind: "ran"; result: RepositoryMaintenanceResult; status: RepositoryMaintenanceStatus };

export type RepositoryMaintenanceStateRead =
  | { kind: "absent"; state: RepositoryMaintenanceState }
  | { kind: "readable"; state: RepositoryMaintenanceState }
  | { kind: "corrupt"; reason: string };

export const EMPTY_REPOSITORY_MAINTENANCE_STATE: RepositoryMaintenanceState = {
  consecutiveFailures: 0,
};

export function readRepositoryMaintenanceState(path: string): RepositoryMaintenanceStateRead {
  if (!existsSync(path)) return { kind: "absent", state: { ...EMPTY_REPOSITORY_MAINTENANCE_STATE } };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RepositoryMaintenanceState>;
    if (
      typeof raw !== "object" ||
      raw === null ||
      !Number.isInteger(raw.consecutiveFailures) ||
      Number(raw.consecutiveFailures) < 0
    ) {
      return { kind: "corrupt", reason: "state must carry a non-negative integer consecutiveFailures" };
    }
    for (const key of ["lastAttemptIso", "lastSuccessIso", "nextEligibleIso", "escalationRecordedIso"] as const) {
      if (raw[key] !== undefined && parsedIso(raw[key]) === undefined) {
        return { kind: "corrupt", reason: key + " must be an ISO timestamp when present" };
      }
    }
    return {
      kind: "readable",
      state: {
        consecutiveFailures: Number(raw.consecutiveFailures),
        lastAttemptIso: raw.lastAttemptIso,
        lastSuccessIso: raw.lastSuccessIso,
        nextEligibleIso: raw.nextEligibleIso,
        escalationRecordedIso: raw.escalationRecordedIso,
      },
    };
  } catch (error) {
    return { kind: "corrupt", reason: String((error as Error)?.message ?? error) };
  }
}

export function writeRepositoryMaintenanceState(path: string, state: RepositoryMaintenanceState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = path + ".tmp-" + process.pid;
  writeFileSync(tempPath, JSON.stringify(state) + "\n", { mode: 0o600 });
  renameSync(tempPath, path);
}

<<<<<<< HEAD
/** Loose (unpacked) object count from `git count-objects -v`. Unreadable reads as 0, which only
 *  ever causes a SKIP (below the floor), never a prune — the safe direction for this input. */
export function defaultLooseObjectCount(repoDir: string): number {
  try {
    const out = execFileSync("git", ["-C", repoDir, "count-objects", "-v"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /^count: (\d+)$/m.exec(out);
    return m ? Number(m[1]) : 0;
  } catch {
    // Unreadable reads as 0, and 0 is BELOW the floor, so an unreadable count can only ever cause
    // a SKIP — never a prune. That is the safe direction for this input, unlike the probes above,
    // where unreadable must read as "held".
    return 0;
  }
=======
export function repositoryMaintenanceStatePath(stateDir: string): string {
  return join(stateDir, "repository-maintenance.json");
>>>>>>> de8c8a6ed (feat(maintenance): automate Git object hygiene)
}

/**
 * Read only Git's existing failure signal, without starting Git or taking an object census. The
 * daemon uses this on otherwise-ineligible idle ticks so a new gc.log can advance recovery without
 * turning every poll into `git count-objects`. Both ordinary repositories and linked worktrees are
 * understood; an unreadable `.git` indirection is `undefined`, never fabricated absence.
 */
export function readGcLogPresent(repoDir: string): boolean | undefined {
  const dotGit = join(repoDir, ".git");
  if (existsSync(join(dotGit, "gc.log"))) return true;
  try {
    const pointer = readFileSync(dotGit, "utf8").trim().match(/^gitdir:\s*(.+)$/i)?.[1];
    if (!pointer) return existsSync(dotGit) ? false : undefined;
    const gitDir = isAbsolute(pointer) ? pointer : resolve(repoDir, pointer);
    return existsSync(join(gitDir, "gc.log"));
  } catch {
    // A normal repository has a .git directory, which readFile rejects. Its already-checked
    // gc.log absence is therefore a readable false rather than an unknown.
    return existsSync(dotGit) ? false : undefined;
  }
}

<<<<<<< HEAD
/**
 * Reclaim unreachable objects, or refuse with a named cause.
 *
 * ORDER IS LOAD-BEARING: `.git/gc.log` is removed ONLY on a pass that is about to prune. Removing
 * it on a refused pass would re-arm git's UNSUPERVISED automatic cleanup, which is precisely what
 * the operator's standing rule exists to prevent — the opposite of this function's purpose.
 */
/** How many objects `git prune -n` would remove. Unreadable reads as 0 — a survey that cannot
 *  measure reports nothing, and reporting nothing is never mistaken for authorising something. */
export function defaultCountPrunable(repoDir: string, args: readonly string[]): number {
  try {
    const out = execFileSync("git", ["-C", repoDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    // A survey that cannot measure reports nothing. Reporting nothing is never mistaken for
    // authorising something: this value is ledgered, never compared against a threshold.
    return 0;
  }
}

export function reapGitObjects(
  repoDir: string,
  inflightDir: string,
  deps: ObjectReapDeps = {},
): ObjectReapResult {
  const looseBefore = (deps.looseObjectCount ?? defaultLooseObjectCount)(repoDir);
  if (looseBefore < LOOSE_OBJECT_FLOOR) {
    return { pruned: 0, looseBefore, refusedBecause: `only ${looseBefore} loose object(s), below the ${LOOSE_OBJECT_FLOOR} floor` };
  }
  const refusal = objectReapRefusal(repoDir, inflightDir, deps);
  if (refusal !== undefined) return { pruned: 0, looseBefore, refusedBecause: refusal };

  // SURVEY: past every refusal above, so the disposition reported is the decision the armed path
  // would have made. Returns BEFORE gc.log is touched and before anything is spawned.
  if (deps.dryRun === true) {
    const count = deps.countPrunable ?? defaultCountPrunable;
    return { pruned: 0, wouldPrune: count(repoDir, ["prune", "-n", `--expire=${OBJECT_PRUNE_EXPIRY}`]), looseBefore };
  }
  // Only now, with the prune committed to, does the auto-gc suppressor come off.
=======
export function surveyRepository(
  repoDir: string,
  activeLaneCount: number,
  diskVerdict: string,
  deps: {
    exec?: typeof execFileSync;
    exists?: typeof existsSync;
    read?: typeof readFileSync;
  } = {},
): RepositorySurvey {
  const exec = deps.exec ?? execFileSync;
  const exists = deps.exists ?? existsSync;
  const read = deps.read ?? readFileSync;
>>>>>>> de8c8a6ed (feat(maintenance): automate Git object hygiene)
  try {
    const raw = String(exec("git", ["-C", repoDir, "count-objects", "-v"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
    const fields = new Map(
      raw
        .split(/\r?\n/)
        .map((line) => line.match(/^([^:]+):\s*(\d+)$/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map((match) => [match[1]!, Number(match[2])]),
    );
    const gitDir = String(exec("git", ["-C", repoDir, "rev-parse", "--absolute-git-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })).trim();
    const gcLogPath = join(gitDir, "gc.log");
    const gcLogPresent = exists(gcLogPath);
    let gcLogDetail: string | undefined;
    if (gcLogPresent) {
      try {
        gcLogDetail = String(read(gcLogPath, "utf8")).split(/\r?\n/, 1)[0];
      } catch (error) {
        return {
          readable: false,
          detail: `gc.log unreadable: ${String((error as Error)?.message ?? error)}`,
          activeLaneCount,
          diskVerdict,
        };
      }
    }
    return {
      readable: fields.has("count") && fields.has("size") && fields.has("packs"),
      looseCount: fields.get("count"),
      looseBytes: fields.get("size") === undefined ? undefined : fields.get("size")! * 1024,
      packCount: fields.get("packs"),
      gcLogPresent,
      gcLogDetail,
      activeLaneCount,
      diskVerdict,
    };
  } catch (error) {
    return {
      readable: false,
      detail: `Git object survey failed: ${String((error as Error)?.message ?? error)}`,
      activeLaneCount,
      diskVerdict,
    };
  }
}

function parsedIso(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function atOrAfter(nowMs: number, iso: string | undefined): boolean {
  const parsed = parsedIso(iso);
  return parsed === undefined || nowMs >= parsed;
}

export function decideRepositoryMaintenance(input: {
  survey: RepositorySurvey;
  state: RepositoryMaintenanceState;
  policy: RepositoryMaintenancePolicy;
  now: Date;
}): RepositoryMaintenanceDecision {
  const { survey, state, policy } = input;
  const nowMs = input.now.getTime();

  if (!survey.readable) {
    return { verdict: "deferred", reason: "repository survey unreadable", nextEligibleIso: state.nextEligibleIso };
  }
  if (!atOrAfter(nowMs, state.nextEligibleIso)) {
    return {
      verdict: "deferred",
      reason: "maintenance backoff or cadence has not elapsed",
      nextEligibleIso: state.nextEligibleIso,
    };
  }
  if (survey.diskVerdict !== "OK") {
    return { verdict: "deferred", reason: "disk state is not healthy enough for repository maintenance", nextEligibleIso: state.nextEligibleIso };
  }

  if (survey.gcLogPresent) {
    if (survey.activeLaneCount > 0) {
      return {
        verdict: "deferred",
        reason: "full GC requires zero active RMD lanes",
        nextEligibleIso: state.nextEligibleIso,
      };
    }
    if (state.consecutiveFailures >= policy.escalationThreshold) {
      return {
        verdict: "escalate",
        reason: "repository maintenance retry threshold reached",
        nextEligibleIso: state.nextEligibleIso,
      };
    }
    return { verdict: "full-gc-due", reason: "Git gc.log records a failed automatic GC" };
  }

  const lastSuccessMs = parsedIso(state.lastSuccessIso);
  const nextIncrementalMs =
    lastSuccessMs === undefined ? undefined : lastSuccessMs + policy.incrementalIntervalMs;
  if (nextIncrementalMs === undefined || nowMs >= nextIncrementalMs) {
    return { verdict: "incremental-due", reason: lastSuccessMs === undefined ? "no prior success recorded" : "incremental cadence elapsed" };
  }
  return {
    verdict: "healthy",
    reason: "incremental cadence has not elapsed",
    nextEligibleIso: fixedClock(nextIncrementalMs).iso(),
  };
}

export function projectRepositoryMaintenanceStatus(
  state: RepositoryMaintenanceState,
  policy: RepositoryMaintenancePolicy,
  nowMs: number = systemClock.now(),
): RepositoryMaintenanceStatus {
  const nextEligibleMs = parsedIso(state.nextEligibleIso);
  const retryPending = state.consecutiveFailures > 0 && state.consecutiveFailures < policy.escalationThreshold;
  let verdict: RepositoryMaintenanceStatus["verdict"];
  if (state.consecutiveFailures >= policy.escalationThreshold) verdict = "escalate";
  else if (state.consecutiveFailures > 0 && nextEligibleMs !== undefined && nowMs < nextEligibleMs) verdict = "backoff";
  else if (state.consecutiveFailures > 0) verdict = "retry-due";
  else if (!state.lastSuccessIso) verdict = "never-run";
  else if (nextEligibleMs === undefined || nowMs >= nextEligibleMs) verdict = "due";
  else verdict = "healthy";
  return {
    verdict,
    lastAttemptIso: state.lastAttemptIso,
    lastSuccessIso: state.lastSuccessIso,
    nextEligibleIso: state.nextEligibleIso,
    consecutiveFailures: state.consecutiveFailures,
    retryPending,
  };
}

function maintenanceArgs(verdict: "incremental-due" | "full-gc-due"): string[] {
  return verdict === "full-gc-due"
    ? ["maintenance", "run", "--task=gc"]
    : ["maintenance", "run", "--task=commit-graph", "--task=loose-objects", "--task=incremental-repack"];
}

/** Git maintenance needs process location and repository identity, never provider credentials. */
function maintenanceEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const keep = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"];
  const configCount = Number.parseInt(source.GIT_CONFIG_COUNT ?? "", 10);
  if (Number.isInteger(configCount) && configCount >= 0 && configCount <= 16) {
    keep.push("GIT_CONFIG_COUNT");
    for (let index = 0; index < configCount; index++) {
      keep.push(`GIT_CONFIG_KEY_${index}`, `GIT_CONFIG_VALUE_${index}`);
    }
  }
  return Object.fromEntries(keep.map((key) => [key, source[key]]).filter(([, value]) => value !== undefined));
}

async function waitForExit(
  process: SpawnedChild,
  pgid: number,
  timeoutMs: number,
  teardown: (pgid: number) => void,
): Promise<{ code: number | null; timedOut: boolean }> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut });
    };
    process.once("exit", (code: number | null) => finish(code, false));
    process.once("error", () => finish(null, false));
    const timer = setTimeout(() => {
      teardown(pgid);
      finish(null, true);
    }, timeoutMs);
    timer.unref?.();
  });
}

export async function runRepositoryMaintenanceController(
  input: RepositoryMaintenanceInput,
  deps: RepositoryMaintenanceDeps = {},
): Promise<RepositoryMaintenanceResult> {
  const clock = deps.clock ?? systemClock;
  const now = clock.date();
  const decision = decideRepositoryMaintenance({
    survey: input.survey,
    state: input.state,
    policy: input.policy,
    now,
  });
  const log = deps.log ?? (() => {});
  if (decision.verdict === "deferred" || decision.verdict === "healthy") {
    log("repository.maintenance.deferred", {
      verdict: decision.verdict,
      reason: decision.reason,
      next_eligible_iso: decision.nextEligibleIso,
      active_lane_count: input.survey.activeLaneCount,
      gc_log_present: input.survey.gcLogPresent,
    });
    return { decision, state: { ...input.state } };
  }
  if (decision.verdict === "escalate") {
    if (!input.state.escalationRecordedIso) {
      log("repository.maintenance.escalate", {
        reason: decision.reason,
        consecutive_failures: input.state.consecutiveFailures,
        next_eligible_iso: decision.nextEligibleIso,
        active_lane_count: input.survey.activeLaneCount,
        gc_log_present: input.survey.gcLogPresent,
      });
    }
    return {
      decision,
      state: {
        ...input.state,
        escalationRecordedIso: input.state.escalationRecordedIso ?? now.toISOString(),
      },
    };
  }

  const args = maintenanceArgs(decision.verdict);
  const startedMs = now.getTime();
  const stderr: string[] = [];
  const spawn = deps.spawn ?? spawnDetachedGroup;
  const teardown = deps.teardown ?? ((pgid: number) => void teardownProcessGroup(pgid));
  log("repository.maintenance.start", {
    kind: decision.verdict === "full-gc-due" ? "gc" : "incremental",
    args,
    active_lane_count: input.survey.activeLaneCount,
    loose_count_before: input.survey.looseCount,
    loose_bytes_before: input.survey.looseBytes,
    gc_log_before: input.survey.gcLogPresent,
  });

  let exitCode: number | null = null;
  let timedOut = false;
  try {
    const contained = spawn(
      { command: "git", args, cwd: input.repoDir, env: maintenanceEnv(deps.env) },
      (chunk) => {
        if (stderr.join("").length < 4_096) stderr.push(chunk.slice(0, 4_096));
      },
    );
    const exited = await waitForExit(
      contained.process as unknown as SpawnedChild,
      contained.pid,
      input.policy.timeoutMs,
      teardown,
    );
    exitCode = exited.code;
    timedOut = exited.timedOut;
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    stderr.push(reason);
  }

  let postSurvey: RepositorySurvey | undefined;
  try {
    postSurvey = input.readPostSurvey?.();
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    stderr.push(`post-maintenance survey failed: ${reason}`);
    postSurvey = undefined;
  }
  const finishedAt = clock.date();
  const postVerified =
    postSurvey?.readable === true &&
    (decision.verdict !== "full-gc-due" || postSurvey.gcLogPresent === false);
  const succeeded = exitCode === 0 && !timedOut && postVerified;
  if (succeeded) {
    const nextEligibleIso = fixedClock(finishedAt.getTime() + input.policy.incrementalIntervalMs).iso();
    const nextState: RepositoryMaintenanceState = {
      lastAttemptIso: finishedAt.toISOString(),
      lastSuccessIso: finishedAt.toISOString(),
      nextEligibleIso,
      consecutiveFailures: 0,
    };
    log("repository.maintenance.complete", {
      duration_ms: Math.max(0, finishedAt.getTime() - startedMs),
      loose_count_before: input.survey.looseCount,
      loose_count_after: postSurvey?.looseCount,
      loose_bytes_before: input.survey.looseBytes,
      loose_bytes_after: postSurvey?.looseBytes,
      gc_log_after: postSurvey?.gcLogPresent,
      next_eligible_iso: nextEligibleIso,
    });
    return { decision, state: nextState, outcome: "succeeded", postSurvey, exitCode };
  }

  const consecutiveFailures = input.state.consecutiveFailures + 1;
  const rawBackoff = input.policy.retryBaseMs * 2 ** Math.max(0, consecutiveFailures - 1);
  const boundedBackoff = Math.min(input.policy.retryMaxMs, rawBackoff);
  const jitterRatio = Math.max(0, Math.min(1, (deps.jitter ?? Math.random)()));
  const jitterMs = Math.floor(boundedBackoff * 0.1 * jitterRatio);
  const nextEligibleIso = fixedClock(finishedAt.getTime() + boundedBackoff + jitterMs).iso();
  const nextState: RepositoryMaintenanceState = {
    ...input.state,
    lastAttemptIso: finishedAt.toISOString(),
    nextEligibleIso,
    consecutiveFailures,
  };
  log("repository.maintenance.failed", {
    kind: decision.verdict === "full-gc-due" ? "gc" : "incremental",
    duration_ms: Math.max(0, finishedAt.getTime() - startedMs),
    exit_code: exitCode,
    timed_out: timedOut,
    post_survey_readable: postSurvey?.readable === true,
    loose_count_before: input.survey.looseCount,
    loose_count_after: postSurvey?.looseCount,
    loose_bytes_before: input.survey.looseBytes,
    loose_bytes_after: postSurvey?.looseBytes,
    gc_log_after: postSurvey?.gcLogPresent,
    consecutive_failures: consecutiveFailures,
    next_eligible_iso: nextEligibleIso,
    stderr_excerpt: stderr.join("").slice(0, 4_096),
  });
  return { decision, state: nextState, outcome: "failed", postSurvey, exitCode };
}

/**
 * Durable, cheap-first cadence wrapper. Reading the small state file and gc.log signal is the hot
 * path. The object census and maintenance child exist only when the cadence is due, a failed-GC
 * marker appears, or a prior failure's backoff expires.
 */
export async function runRepositoryMaintenanceCadence(
  input: {
    repoDir: string;
    statePath: string;
    activeLaneCount: number;
    /** Resolved only after the durable cadence gate says a repository survey is due. */
    diskVerdict: string | (() => string);
    policy: RepositoryMaintenancePolicy;
  },
  deps: {
    clock?: Clock;
    readState?: (path: string) => RepositoryMaintenanceStateRead;
    writeState?: (path: string, state: RepositoryMaintenanceState) => void;
    gcLogPresent?: (repoDir: string) => boolean | undefined;
    survey?: (repoDir: string, activeLaneCount: number, diskVerdict: string) => RepositorySurvey;
    runController?: typeof runRepositoryMaintenanceController;
    log?: (step: string, fields: Record<string, unknown>) => void;
  } = {},
): Promise<RepositoryMaintenanceCadenceResult> {
  const clock = deps.clock ?? systemClock;
  const now = clock.date();
  const log = deps.log ?? (() => {});
  const stateRead = (deps.readState ?? readRepositoryMaintenanceState)(input.statePath);
  if (stateRead.kind === "corrupt") {
    log("repository.maintenance.deferred", {
      reason: "durable maintenance state is unreadable",
      detail: stateRead.reason,
    });
    return { kind: "deferred", reason: stateRead.reason };
  }

  const state = stateRead.state;
  const nextEligibleMs = parsedIso(state.nextEligibleIso);
  const backoffHeld =
    state.consecutiveFailures > 0 && nextEligibleMs !== undefined && now.getTime() < nextEligibleMs;
  if (backoffHeld || state.escalationRecordedIso) {
    return { kind: "not-due", status: projectRepositoryMaintenanceStatus(state, input.policy, now.getTime()) };
  }

  const gcLogPresent = (deps.gcLogPresent ?? readGcLogPresent)(input.repoDir);
  if (nextEligibleMs !== undefined && now.getTime() < nextEligibleMs && gcLogPresent !== true) {
    return { kind: "not-due", status: projectRepositoryMaintenanceStatus(state, input.policy, now.getTime()) };
  }
  if (gcLogPresent === true && input.activeLaneCount > 0) {
    const reason = "full GC requires zero active RMD lanes";
    log("repository.maintenance.deferred", {
      reason,
      active_lane_count: input.activeLaneCount,
      gc_log_present: true,
    });
    return { kind: "deferred", reason };
  }

  let diskVerdict: string;
  try {
    diskVerdict = typeof input.diskVerdict === "function" ? input.diskVerdict() : input.diskVerdict;
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    log("repository.maintenance.deferred", {
      reason: "disk headroom survey failed",
      detail: reason,
    });
    return { kind: "deferred", reason };
  }
  const readSurvey = (): RepositorySurvey =>
    (deps.survey ?? surveyRepository)(input.repoDir, input.activeLaneCount, diskVerdict);
  const survey = readSurvey();
  const runController = deps.runController ?? runRepositoryMaintenanceController;
  const result = await runController(
    {
      repoDir: input.repoDir,
      survey,
      readPostSurvey: readSurvey,
      state,
      policy: input.policy,
    },
    { clock, log },
  );
  (deps.writeState ?? writeRepositoryMaintenanceState)(input.statePath, result.state);
  return {
    kind: "ran",
    result,
    status: projectRepositoryMaintenanceStatus(result.state, input.policy, now.getTime()),
  };
}
