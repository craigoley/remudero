/**
 * Report CLI verbs extracted without behavior changes (W1-T2888; W1-T2260 move discipline).
 * `run-task.ts` re-exports the original names; these handlers never dispatch workers, hold
 * locks, or mutate the plan. Dependencies supply their reads and output.
 * Inject `usage`/`syntax`, never import the dispatcher-owned `COMMANDS`/`USAGE`: that would
 * recreate the lib -> run-task edge. CLI dispatch supplies them; library callers may omit
 * them for an empty appended listing. Historical extraction detail: W1-T2888 review record.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";
import { createBoardSnapshotCache } from "./board-snapshot-cache.js";
import {
  consoleAppUrl,
  enabledWorkerProviders,
  globalArtifactPath,
  globalLearningsHome,
  loadConfig,
  notifyRecipient,
  resolveHeadroomEnabled,
  type Config,
} from "./config.js";
import { flagValue, unknownArgError } from "./cli-args.js";
import { dispatchClaimRef } from "./dispatch-claim.js";
import { readSharedPause, realSharedPauseGitDeps } from "./fleet-control.js";
import { ledgerPathFor } from "./ledger-path.js";
import { resolveLedgerUnion } from "./ledger-grep.js";
import { meaningOfStep } from "./ledger-steps.js";
import { buildReceipt, resolveReceiptLedgerLines, type ReceiptLedgerRead } from "./receipt.js";
import { buildReplay, resolveReplayLedgerLines, type ReplayLedgerRead } from "./ledger-replay.js";
import {
  DAEMON_LABEL,
  DIGEST_LABEL,
  generateDigestLaunchdPlist,
  launchctlGuiTarget,
  launchdPlistPath,
  parseSupervisorStartInterval,
  SERVE_LABEL,
  SUPERVISOR_LABEL,
} from "./launchd.js";
import { classifyRollupSupersession, type RollupCheckEntry } from "./sweep.js";
import { resolveInstallRoot } from "./install-root.js";
import {
  buildStatusBoard,
  buildStatusBoardAsync,
  deriveDispatchCadence,
  deriveQueueHead,
  renderStatusBoardText,
  type LivenessSensor,
  type ServiceName,
} from "./status-board.js";
import {
  buildBatchedGithub,
  deriveStatus,
  GH_CALL_TIMEOUT_MS,
  readLedgerLines,
  taskIdFromRunBranch,
  type GitHub,
  type StatusProjection,
} from "./status.js";
import {
  DOCTOR_USAGE_EXIT,
  buildDoctorReport,
  classifyReadFailure,
  classifyWorktreeBase,
  parseCaptureSurfaceFireHistory,
  readDiskFreeBytes,
  readDiskTotalBytes,
  readGitLocks,
  readMemInfo,
  readWorkerProcesses,
  type WorkerProcessReading,
  readNvmrcVersion,
  readPauseAgeMs,
  refuseUnsupportedArgs,
  type MemInfo,
  type ProviderCapacityReading,
  type WorktreeBaseRow,
} from "./doctor.js";
import { OPENWEIGHT_API_KEY_ENV } from "./worker-provider.js";
import { readProviderRoutingStatus, type ProviderRoutingStatus } from "./provider-routing-status.js";
import { readInflightLock } from "./inflight-lock.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { sameHost } from "./host-identity.js";
import { loadPlan, type Plan } from "./plan.js";
import { buildDigest, buildMarkerAwareDigest, sendDigest, sendMarkerAwareDigest } from "./digest.js";
import { createLastSeenStore, hashToken, lastSeenPath } from "./last-seen.js";
import { imessageChannel, type NotifyChannel } from "./notify.js";
import { resolveServiceTokens } from "./serve.js";
import {
  buildExportBundle,
  loadLearningsCorpus,
  projectLearningsHome,
  renderExportBundle,
  verifyBundlePin,
} from "./learnings.js";
import { readFeedbackEntry, type FeedbackEntry } from "./feedback.js";
import { ghTraceGateway, renderTraceChain, traceForward, traceReverse } from "./trace.js";
import { extractTaskTrailerId } from "./review.js";
import { mapRestPr, singlePrRestArgs, type RestPullRow } from "./open-prs-rest.js";
import { createGhCallPacer, ghExecFile, ghJson, GH_RATE_LIMIT_BUCKET_UNKNOWN } from "./github-transport.js";
import { worktreesDir, readWorktreeBase } from "./worker.js";
import { hostWorktreeGit } from "./worktree-git.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { systemClock } from "./clock.js";
import { buildTaskCaseFile, readTaskCaseLedger, readTaskCaseLedgers, type CaseLedgerRead, type CasePrRead, type CasePrSnapshot, type TaskCaseFile } from "./task-case-file.js";
import type { Task } from "./plan.js";

/** Repository facts are resolved once by the CLI entrypoint and passed across this module
 * boundary. Keeping this seam optional preserves direct library use; its fallback is deliberately
 * lazy, so importing report commands never reads process.argv or executes git. */
export interface ReportRepoContext {
  repoRoot?: string;
  resolveOwnerRepo?: () => { owner: string; repo: string };
  /** CLI-owned task selection. Direct library callers may keep their supplied root. */
  resolveTaskPlan?: (id: string) => { ok: true; root: string; owner?: string } | { ok: false; error: string };
}

function reportRepoRoot(context: ReportRepoContext): string {
  return context.repoRoot ?? process.cwd();
}

function reportOwnerRepo(context: ReportRepoContext, root = reportRepoRoot(context)): { owner: string; repo: string } {
  if (context.resolveOwnerRepo) return context.resolveOwnerRepo();
  const url = execFileSync("git", ["-C", root, "config", "--get", "remote.origin.url"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const match = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) throw new Error("could not parse owner/repo from origin url");
  return { owner: match[1], repo: match[2] };
}

// launchd queries shared by status/up/down (W1-T2888). Keep subprocesses here:
// lib/launchd.ts "never shells out to launchctl" (launchd/serve-plist tests).

/** Missing pid means loaded but idle; {@link LaunchdServiceState.loaded} distinguishes absence.
 * Exported for report-commands.test.ts's unhealthy-arm census (W1-T2888). */
export const LAUNCHCTL_PID_RE = /"?pid"?\s*=\s*(\d+)/;

export interface LaunchdServiceState {
  /** True iff `launchctl print` finds the service at all (bootstrapped into the GUI domain). */
  loaded: boolean;
  /** The job's live pid, or `null` when loaded but not (yet) running. */
  pid: number | null;
}

/** Shared subprocess seam for every lifecycle helper, injectable without separate exec fakes. */
export function defaultLifecycleExec(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).toString();
}

/** Real UID; 0 on non-POSIX hosts without getuid (as in deployRunCommand). */
export function realUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

/** ENOENT means launchctl itself is absent; a nonzero exit is a sensed negative (W1-T2450). */
function isLaunchctlAbsent(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Shared up/down load check: non-bootstrapped labels become loaded:false.
 * These idempotent verbs deliberately drop `sensed`; status must retain it (W1-T2450).
 */
export function queryLaunchdService(
  label: string,
  uid: number,
  exec: (cmd: string, args: string[]) => string = defaultLifecycleExec,
): LaunchdServiceState {
  const { sensed: _sensed, ...state } = queryLaunchdServiceSensed(label, uid, exec);
  return state;
}

/** Status distinguishes an unavailable launchctl from an absent service (W1-T2450). */
export function queryLaunchdServiceSensed(
  label: string,
  uid: number,
  exec: (cmd: string, args: string[]) => string = defaultLifecycleExec,
): LaunchdServiceState & { sensed: boolean } {
  let out: string;
  try {
    out = exec("launchctl", ["print", launchctlGuiTarget(uid, label)]);
  } catch (e) {
    // `sensed` carries the distinction this catch would otherwise erase: false when `e` is the
    // ENOENT launchctl-itself-absent case (isLaunchctlAbsent), true for a real "not loaded" answer.
    return { loaded: false, pid: null, sensed: !isLaunchctlAbsent(e) };
  }
  const m = LAUNCHCTL_PID_RE.exec(out);
  return { loaded: true, pid: m ? Number(m[1]) : null, sensed: true };
}

/** launchctl list's PID/Status/Label: '-' means idle, Status is the last exit code (W1-T301).
 * Periodic jobs can be healthy without a pid. Absent/unparseable output stays unknown, never 0. */
export interface LaunchdListStatus {
  pid: number | null;
  lastExitCode: number | undefined;
}

// Exported (W1-T2888) solely so test/report-commands.test.ts can drive its unhealthy arm by
// identifier — negative-reachability-ratchet.test.ts's own census.
export const LAUNCHCTL_LIST_LINE_RE = /^(-|\d+)\s+(-?\d+)\s+(\S+)/;

export function queryLaunchdListStatus(
  label: string,
  exec: (cmd: string, args: string[]) => string = defaultLifecycleExec,
): LaunchdListStatus {
  const { sensed: _sensed, ...status } = queryLaunchdListStatusSensed(label, exec);
  return status;
}

/** Status retains the sensor bit, as in {@link queryLaunchdServiceSensed}. */
export function queryLaunchdListStatusSensed(
  label: string,
  exec: (cmd: string, args: string[]) => string = defaultLifecycleExec,
): LaunchdListStatus & { sensed: boolean } {
  let out: string;
  try {
    out = exec("launchctl", ["list", label]);
  } catch (e) {
    // Same distinction as queryLaunchdServiceSensed's own catch, carried in `sensed` rather than
    // erased: false only when launchctl itself could not run (isLaunchctlAbsent).
    return { pid: null, lastExitCode: undefined, sensed: !isLaunchctlAbsent(e) };
  }
  const line = out.split("\n").find((l) => LAUNCHCTL_LIST_LINE_RE.test(l.trim()));
  const m = line ? LAUNCHCTL_LIST_LINE_RE.exec(line.trim()) : null;
  if (!m) return { pid: null, lastExitCode: undefined, sensed: true };
  const pid = m[1] === "-" ? null : Number(m[1]);
  const lastExitCode = Number(m[2]);
  return { pid, lastExitCode: Number.isFinite(lastExitCode) ? lastExitCode : undefined, sensed: true };
}

export interface ProcessServiceState {
  running: boolean;
  pid: number | null;
  sensed: boolean;
  sensor?: LivenessSensor;
  reason?: string;
}

const SERVICE_PROCESS_VERB: Record<ServiceName, string> = {
  daemon: "daemon",
  serve: "serve",
  "deploy-supervisor": "deploy-run",
};

function processArgv(args: string): string[] {
  return args.trim().split(/[ \t]+/).filter((part) => part.length > 0);
}

function tokenBasename(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash === -1 ? token : token.slice(slash + 1);
}

function commandLineRunsService(args: string, service: ServiceName): boolean {
  const tokens = processArgv(args);
  const verb = SERVICE_PROCESS_VERB[service];
  const runTaskIndex = tokens.findIndex((token) => token === "src/run-task.ts" || token.endsWith("/src/run-task.ts"));
  if (runTaskIndex >= 0) return tokens[runTaskIndex + 1] === verb;
  const rmdIndex = tokens.findIndex((token) => tokenBasename(token) === "rmd");
  return rmdIndex >= 0 && tokens[rmdIndex + 1] === verb;
}

function parsePsProcess(line: string): { pid: number; args: string } | undefined {
  const m = /^\s*(\d+)\s+(.+)$/.exec(line);
  if (!m) return undefined;
  const pid = Number(m[1]);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return { pid, args: m[2] };
}

export function queryProcessServiceSensed(
  service: ServiceName,
  exec: (cmd: string, args: string[]) => string = defaultLifecycleExec,
): ProcessServiceState {
  let out: string;
  try {
    out = exec("ps", ["-eo", "pid=,args="]);
  } catch (error) {
    return { running: false, pid: null, sensed: false, reason: String((error as Error)?.message ?? error) };
  }
  for (const line of out.split("\n")) {
    const proc = parsePsProcess(line);
    if (!proc) continue;
    if (commandLineRunsService(proc.args, service)) {
      return { running: true, pid: proc.pid, sensed: true, sensor: "process-table" };
    }
  }
  return { running: false, pid: null, sensed: true, sensor: "process-table" };
}

// ── doctorCommand's own private readers ──────────────────────────────────────────────────────
//
// Every reader below is a pure function of injected inputs (or a self-contained filesystem/git
// read via node builtins + already-lib symbols) — moved alongside `doctorCommand`, the only
// caller EXCEPT `liveInflightRuns`, which several non-report commands in `run-task.ts` also call
// and now import back from here.

export interface LiveInflightRun {
  taskId: string;
  runId: string;
  pid: number;
}

/**
 * Every LIVE in-flight run right now — a direct read of `<root>/state/inflight/*.lock`
 * (inflight-lock.ts), the SAME per-task lock the drain/daemon path takes before dispatching a
 * task, so "in flight" here means exactly what it means everywhere else in the fleet — never a
 * second, looser definition.
 */
export function liveInflightRuns(
  inflightDir: string,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): LiveInflightRun[] {
  if (!existsSync(inflightDir)) return [];
  const out: LiveInflightRun[] = [];
  for (const entry of readdirSync(inflightDir)) {
    if (!entry.endsWith(".lock")) continue;
    const taskId = entry.slice(0, -".lock".length);
    const info = readInflightLock(inflightDir, taskId);
    if (info && isPidAlive(info.pid)) out.push({ taskId, runId: info.run_id, pid: info.pid });
  }
  return out;
}

/** A running container as docker reports it: the id to `exec` into and the hostname a lock records. */
export interface RunningContainer {
  id: string;
  hostname: string;
}

/** W1-T6261: a lock whose holder this process cannot judge — named, never counted as dead. */
export interface UnverifiableLock {
  taskId: string;
  host: string;
}

export interface JudgedInflightLocks {
  live: LiveInflightRun[];
  unverifiable: UnverifiableLock[];
}

export interface InflightLockProbes {
  /** This process's hostname. Defaults to `os.hostname()`. */
  hostname?: () => string;
  /** Host-namespace pid probe, for locks written by THIS host. */
  isPidAlive?: (pid: number) => boolean;
  /** Running containers (`docker ps` + `docker inspect`), or undefined when docker cannot be read. */
  listContainers?: () => RunningContainer[] | undefined;
  /** `/proc/<pid>` inside the container: true/false when answered, undefined when it could not be asked. */
  pidAliveInContainer?: (containerId: string, pid: number) => boolean | undefined;
}

function dockerOut(args: string[], runExecFileSync: typeof execFileSync = execFileSync): string {
  return runExecFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
}

/** The same probe deploy/recycle-container.sh uses (W1-T3611): running containers and their hostnames. */
export function defaultListContainers(runExecFileSync: typeof execFileSync = execFileSync): RunningContainer[] | undefined {
  try {
    const ids = dockerOut(["ps", "-q"], runExecFileSync).split("\n").map((l) => l.trim()).filter(Boolean);
    if (ids.length === 0) return [];
    const rows = dockerOut(["inspect", "-f", "{{.Id}} {{.Config.Hostname}}", ...ids], runExecFileSync);
    return rows
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length === 2 && p[0] !== "" && p[1] !== "")
      .map(([id, hostname]) => ({ id, hostname }));
  } catch {
    // docker absent, not permitted, or timed out: the container table is NOT OBSERVED, which the
    // caller reports as unverifiable — never as an empty table that would read every lock as dead.
    return undefined;
  }
}

export function defaultPidAliveInContainer(
  containerId: string,
  pid: number,
  runExecFileSync: typeof execFileSync = execFileSync,
): boolean | undefined {
  try {
    dockerOut(["exec", containerId, "sh", "-c", `[ -e /proc/${Math.trunc(pid)} ]`], runExecFileSync);
    return true;
  } catch (e) {
    // `[ -e ]` answers through its exit code: 1 is a real "no such pid in that namespace". Any other
    // status (docker's own 125/126/127, a timeout kill with no status) means the question was not answered.
    return (e as { status?: number | null }).status === 1 ? false : undefined;
  }
}

/**
 * W1-T6261 — judge each inflight lock in the PID NAMESPACE that wrote it. A lock whose `host` is this
 * process's hostname is judged by pid as always; one whose `host` names a RUNNING container is judged by
 * `/proc/<pid>` inside that container; any other host is `unverifiable`, never dead: doctor reports,
 * W1-T978 owns reclamation, and a false "stale" invites deleting a live run's lock. A lock that cannot be
 * parsed is in neither set, so the caller still counts it as having no live holder.
 */
export function judgeInflightLocks(inflightDir: string, probes: InflightLockProbes = {}): JudgedInflightLocks {
  const live: LiveInflightRun[] = [];
  const unverifiable: UnverifiableLock[] = [];
  if (!existsSync(inflightDir)) return { live, unverifiable };
  const myHost = (probes.hostname ?? osHostname)();
  const isPidAlive = probes.isPidAlive ?? defaultIsPidAlive;
  let containers: RunningContainer[] | undefined;
  let containersRead = false;
  for (const entry of readdirSync(inflightDir)) {
    if (!entry.endsWith(".lock")) continue;
    const taskId = entry.slice(0, -".lock".length);
    const info = readInflightLock(inflightDir, taskId);
    if (!info) continue;
    const run: LiveInflightRun = { taskId, runId: info.run_id, pid: info.pid };
    if (sameHost(info.host, myHost)) {
      if (isPidAlive(info.pid)) live.push(run);
      continue;
    }
    if (!containersRead) {
      containers = (probes.listContainers ?? defaultListContainers)();
      containersRead = true;
    }
    const ctr = containers?.find((c) => c.hostname === info.host);
    const alive = ctr ? (probes.pidAliveInContainer ?? defaultPidAliveInContainer)(ctr.id, info.pid) : undefined;
    if (alive === true) live.push(run);
    else if (alive === undefined) unverifiable.push({ taskId, host: info.host });
  }
  return { live, unverifiable };
}

/**
 * AN ABSENT DIR IS ZERO LOCKS; AN UNREADABLE ONE IS NOT. A fleet that has never dispatched has no
 * inflight dir and is genuinely healthy, but a permissions fault HIDES locks, and answering "none"
 * to both would let a health check report all-clear on a fault that blinded it. Only ENOENT is
 * silently empty; every other error is surfaced as `unreadable` and reaches the caller as a WARN
 * naming that lock state is unknown.
 *
 * EXTRACTED WITH AN INJECTED `readdir` so both arms are reachable from a test rather than requiring
 * a real EACCES on disk.
 */
export function readLockFilesFrom(
  dir: string,
  readdir: (p: string) => string[] = readdirSync,
): { locks: string[]; unreadableReason?: string } {
  try {
    return { locks: readdir(dir).filter((n) => n.endsWith(".lock")).map((n) => n.slice(0, -".lock".length)) };
  } catch (e) {
    // classifyReadFailure carries the distinction: an absent dir reads as zero locks, any other
    // failure is named in `unreadableReason` rather than folded into the same empty answer.
    const { absent, reason } = classifyReadFailure(e);
    return absent ? { locks: [] } : { locks: [], unreadableReason: `inflight dir unreadable (${reason})` };
  }
}

/**
 * The LOCAL merged set `deriveQueueHead` needs, built from rows this host already wrote.
 *
 * THIS IS THE SUBSTITUTION THAT KEEPS THE STALL CHECK ALIVE WITHOUT A NETWORK READ.
 * `deriveQueueHead` bails to an unknown the moment its projections are absent, which is why a
 * GitHub outage blanks the queue head — and takes the stall check with it — in `rmd status`.
 * Feeding it ledger-derived projections answers the same question with no `gh` call.
 *
 * EXTRACTED so its effect is assertable directly. `merged === true` is a STRICT comparison on
 * purpose: a truthy non-boolean must not count as merged, because a false positive here REMOVES a
 * task from the eligible pool and would hide a stall rather than report one — the fail-closed
 * direction for a health check.
 */
export function localMergedProjections(lines: ReadonlyArray<Record<string, unknown>>): Map<string, StatusProjection> {
  const projections = new Map<string, StatusProjection>();
  for (const line of lines) {
    const id = typeof line.task_id === "string" ? line.task_id : undefined;
    if (!id) continue;
    if (line.step === "verdict" && line.merged === true) {
      projections.set(id, { taskId: id, status: "merged", merged: true } as StatusProjection);
    }
  }
  return projections;
}

/**
 * W1-T2332: the canonical checkout's HISTORY HORIZON — `git rev-parse --is-shallow-repository`
 * and `git rev-list --count HEAD`. A shallow checkout breaks every history read SILENTLY (`git
 * log -S`, `--follow`, merge-base checks) — both git reads share ONE try/catch: a partial answer
 * (one succeeds, the other throws) is not a usable answer, so it is treated the same as a failed
 * read — `undefined`, never a guessed value. Wired into `doctorCommand`'s `checkout-depth` health
 * arm below.
 */
export function readCheckoutDepth(cwd: string): { shallow: boolean; commitCount: number } | undefined {
  try {
    const shallow =
      execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "true";
    const commitCount = parseInt(
      execFileSync("git", ["rev-list", "--count", "HEAD"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
      10,
    );
    if (!Number.isFinite(commitCount)) return undefined;
    return { shallow, commitCount };
  } catch {
    // THE REASON, STATED HERE RATHER THAN ONLY IN THE DOC ABOVE (catch-erasure ratchet, route 4):
    // both git reads share this ONE try/catch, so a PARTIAL answer — one read succeeding and the
    // other throwing — is not a usable answer and is treated exactly like a failed read. `undefined`
    // is "not measured", never a guessed depth, and `judgeCheckoutDepth` refuses on it by name
    // rather than reporting a horizon nobody observed.
    return undefined;
  }
}

function defaultReadWorktreeHead(worktreePath: string): string | undefined {
  try {
    return hostWorktreeGit(worktreePath, ["rev-parse", "HEAD"]).trim();
  } catch {
    // W1-T2627: `undefined` is the ABSENT reading, not a swallowed failure. A worktree can
    // legitimately have no resolvable HEAD — freshly added and not yet checked out, or its
    // directory reaped from under the admin record — and `rev-parse` exits non-zero for all of
    // them alike. `doctor` is READ-ONLY and reports what it could and could not observe, so an
    // unreadable head must degrade to "not observed" rather than throw and take the whole health
    // check down over one worktree.
    return undefined;
  }
}

function defaultIsWorktreeBaseAncestor(worktreePath: string, base: string, head: string): boolean | undefined {
  try {
    hostWorktreeGit(worktreePath, ["merge-base", "--is-ancestor", base, head]);
    return true;
  } catch (e) {
    // W1-T2627: `git merge-base --is-ancestor` ANSWERS THROUGH ITS EXIT CODE, so a throw here is
    // two different events wearing one shape. Exit 1 is a real answer — "base is not an ancestor
    // of head" — and must read as `false`. ANY OTHER status (128 for a bad revision or a corrupt
    // worktree, or a spawn error with no status at all) means git could not decide, which is
    // `undefined` = not observed. Collapsing the second case into `false` would report a healthy
    // worktree as diverged on nothing more than an unreadable ref.
    return (e as { status?: number | null }).status === 1 ? false : undefined;
  }
}

/** Injectable seams for {@link doctorCommand} — every reader it drives, so the whole command is
 *  exercisable without a real /proc, a real ledger, or a live daemon. */
export interface DoctorDeps extends ReportRepoContext {
  out?: (line: string) => void;
  err?: (line: string) => void;
  loadConfig?: () => Config;
  nowMs?: number;
  readLedgerLines?: (path: string) => Array<Record<string, unknown>>;
  loadPlan?: () => Plan | undefined;
  liveInflightRuns?: (dir: string) => LiveInflightRun[];
  /** W1-T6261 — per-namespace lock judgement. Used when `liveInflightRuns` is not injected. */
  judgeInflightLocks?: (dir: string) => JudgedInflightLocks;
  readWorktreeBase?: (worktreePath: string) => string | null;
  readWorktreeHead?: (worktreePath: string) => string | undefined;
  isWorktreeBaseAncestor?: (worktreePath: string, base: string, head: string) => boolean | undefined;
  readMemInfo?: () => MemInfo;
  /** W1-T3628 — injected so the arm is testable without a real process table. */
  readWorkerProcesses?: () => WorkerProcessReading | { unreadableReason: string };
  readDiskFreeBytes?: (path: string) => number | undefined;
  readDiskTotalBytes?: (path: string) => number | undefined;
  readPauseAgeMs?: (root: string, nowMs: number) => number | undefined;
  readGitLocks?: (root: string, nowMs: number) => Array<{ path: string; ageMs: number }>;
  readLockFiles?: (dir: string) => { locks: string[]; unreadableReason?: string };
  /** W1-T2332 — the `checkout-depth` arm's only measurement. Defaults to {@link readCheckoutDepth}. */
  readCheckoutDepth?: (cwd: string) => { shallow: boolean; commitCount: number } | undefined;
  /** R-49 — the `node-version-pin` arm's only measurement. Defaults to {@link readNvmrcVersion}. */
  readNvmrcVersion?: (root: string) => string | undefined;
  /** W1-T3472 — persisted feedback-docket fires. Defaults to `state/last-feedback-docket.json`. */
  readCaptureSurfaceFireHistory?: (root: string) => Array<Record<string, unknown>>;
  /** W1-T3665 — the `provider-capacity` arm's only measurement: the SAME read-only projection
   *  `/v1/provider-routing` (serve.ts) and `review-capacity.ts` already read. Defaults to
   *  {@link readProviderRoutingStatus}; doctor never probes a provider or touches a credential of
   *  its own. Typed via `typeof readProviderRoutingStatus` rather than restating its `deps`
   *  parameter's own millis-clock field inline (W1-T2897's clock-signature census: writing that
   *  legacy shape out here would be a NEW site in a file the census baselines at zero, not a
   *  repeat of the one already recorded against provider-routing-status.ts itself). */
  readProviderRoutingStatus?: typeof readProviderRoutingStatus;
  /** W1-T3728: presence only. Doctor never prints or persists the Azure Foundry key. */
  readCashKey?: () => string | undefined;
}

export function readCaptureSurfaceFireHistory(root: string): Array<Record<string, unknown>> {
  const markerPath = join(root, "state", "last-feedback-docket.json");
  if (!existsSync(markerPath)) return [];
  try {
    return parseCaptureSurfaceFireHistory(JSON.parse(readFileSync(markerPath, "utf8")) as unknown);
  } catch (e) {
    // Corrupt marker JSON reads as no retained capture-surface history, not as live-ledger evidence.
    void e;
    return [];
  }
}

/**
 * W1-T1047 — `rmd doctor`: the one LOCAL, READ-ONLY command that answers "is the fleet healthy"
 * with an exit code that means something. Every judgement lives in `src/lib/doctor.ts` as a pure
 * function; this is the I/O shell that measures the inputs and prints the report.
 *
 * NO NETWORK, BY CONSTRUCTION. The stall check reuses `deriveQueueHead`/`deriveDispatchCadence`
 * but supplies LOCALLY-derived projections instead of the GitHub ones, so the check that would
 * have caught the stall survives the API outage during which it is most needed. Nothing here
 * calls `gh`.
 *
 * A DOWN DAEMON IS NOT AN ERROR. Every reader degrades to a stated unknown; the command still
 * prints a full report and still exits by worst verdict.
 */
export async function doctorCommand(rest: string[], deps: DoctorDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const refusal = refuseUnsupportedArgs(rest);
  if (refusal) {
    err(refusal);
    return DOCTOR_USAGE_EXIT;
  }
  const config = (deps.loadConfig ?? loadConfig)();
  const repoDir = reportRepoRoot(deps);
  const nowMs = deps.nowMs ?? Date.now();
  const root = config.root;
  const ledgerLines = (deps.readLedgerLines ?? ((pth: string) => readLedgerLines(pth) as Array<Record<string, unknown>>))(ledgerPathFor(config));

  // LOCAL merged set: a task is merged if the ledger says so. This is the substitution that keeps
  // the stall check alive without a network read — `deriveQueueHead` needs projections, and these
  // come from rows this host already wrote.
  const projections = localMergedProjections(ledgerLines);

  const plan = deps.loadPlan ? deps.loadPlan() : undefined;
  const cadence = deriveDispatchCadence(ledgerLines as Array<Record<string, unknown>>);
  const head = deriveQueueHead(plan, ledgerLines as Array<Record<string, unknown>>, projections, undefined, 5, nowMs);
  const newestDispatchMs = cadence.newestTs ? Date.parse(cadence.newestTs) : NaN;

  const inflightDir = join(root, "state", "inflight");
  // `liveInflightRuns` returns ONLY runs whose pid is alive, so divergence is the difference
  // between the lock FILES on disk and that live set — a lock with no live pid is a run that died
  // without releasing. Both halves are injectable so the arm is testable without real pids.
  // W1-T6261: a lock written inside a container is judged in THAT container's pid namespace; a lock
  // whose holder cannot be asked is `unverifiable`, which is neither live nor dead.
  const judged: JudgedInflightLocks = deps.liveInflightRuns
    ? { live: deps.liveInflightRuns(inflightDir), unverifiable: [] }
    : (deps.judgeInflightLocks ?? ((d) => judgeInflightLocks(d)))(inflightDir);
  const live = judged.live;
  const lockRead = (deps.readLockFiles ?? readLockFilesFrom)(inflightDir);
  const lockFiles = lockRead.locks;
  const liveIds = new Set(live.map((r) => r.taskId));
  const unverifiableIds = new Set(judged.unverifiable.map((u) => u.taskId));
  const dead = lockFiles.filter((f) => !liveIds.has(f) && !unverifiableIds.has(f));

  const worktreeBases: WorktreeBaseRow[] = live.map((r) => {
    const branch = `run-${r.runId}`;
    const worktreePath = join(worktreesDir(config), branch);
    const base = (deps.readWorktreeBase ?? readWorktreeBase)(worktreePath);
    const head = (deps.readWorktreeHead ?? defaultReadWorktreeHead)(worktreePath);
    const isAncestor = (b: string, h: string) => (deps.isWorktreeBaseAncestor ?? defaultIsWorktreeBaseAncestor)(worktreePath, b, h);
    return { runId: r.runId, taskId: taskIdFromRunBranch(branch), state: classifyWorktreeBase(base, head, isAncestor) };
  });

  const report = buildDoctorReport({
    nowMs,
    ledgerLines: ledgerLines as Array<Record<string, unknown>>,
    captureSurfaceFires: (deps.readCaptureSurfaceFireHistory ?? readCaptureSurfaceFireHistory)(root),
    candidateCount: head.rows.length,
    ...(Number.isFinite(newestDispatchMs) ? { dispatchSinceMs: Math.max(0, nowMs - newestDispatchMs) } : {}),
    ...(cadence.boundMs === undefined ? {} : { dispatchBoundMs: cadence.boundMs }),
    ...(cadence.boundDerivation === undefined ? {} : { dispatchBoundDerivation: cadence.boundDerivation }),
    mem: (deps.readMemInfo ?? readMemInfo)(),
    ...(((v) => (v === undefined ? {} : { diskFreeBytes: v }))((deps.readDiskFreeBytes ?? readDiskFreeBytes)(root))),
    ...(((v) => (v === undefined ? {} : { diskTotalBytes: v }))((deps.readDiskTotalBytes ?? readDiskTotalBytes)(root))),
    ...(((v) => (v === undefined ? {} : { pauseAgeMs: v }))((deps.readPauseAgeMs ?? readPauseAgeMs)(root, nowMs))),
    totalLocks: lockFiles.length,
    ...(lockRead.unreadableReason === undefined ? {} : { locksUnreadableReason: lockRead.unreadableReason }),
    deadLocks: dead,
    gitLocks: (deps.readGitLocks ?? readGitLocks)(repoDir, nowMs),
    // W1-T3628: a LIVE reading, not the literal 0 that stood here. The arm it feeds could not
    // return anything but OK while this was a constant, and read "0 worker process(es)" on a host
    // carrying two `npm ci` stuck 80 minutes during the 2026-09-16 outage.
    ...(((r) =>
      "unreadableReason" in r
        ? { workerCount: 0, workersUnreadableReason: r.unreadableReason }
        : { workerCount: r.count, ...(r.oldestEtimeS === undefined ? {} : { oldestWorkerEtimeS: r.oldestEtimeS }) })(
      (deps.readWorkerProcesses ?? readWorkerProcesses)(),
    )),
    ...(((v) => (v === undefined ? {} : { checkoutDepth: v }))((deps.readCheckoutDepth ?? readCheckoutDepth)(repoDir))),
    worktreeBases,
    // R-49: THIS process's own running interpreter, measured here — the caller — exactly like
    // every other injected reading above, never read inside buildDoctorReport itself.
    runningNodeVersion: process.versions.node,
    ...(((v) => (v === undefined ? {} : { nvmrcVersion: v }))((deps.readNvmrcVersion ?? readNvmrcVersion)(repoDir))),
    // W1-T3665: the LIVE provider-routing snapshot, projected into doctor's own reading shape.
    // `unreadableForMs` is deliberately omitted — `rmd doctor` keeps no history of its own between
    // runs, and judgeProviderCapacityReadable treats that unmeasured duration as already past the
    // bound rather than waiting on evidence this command has no way to gather (see doctor.ts).
    providerCapacity: (
      (deps.readProviderRoutingStatus ?? readProviderRoutingStatus)(root, { now: () => nowMs }).providers ?? []
    ).map(
      (p): ProviderCapacityReading => ({
        provider: p.provider,
        readable: p.readable,
        windows: p.windows,
        ...(p.reason ? { reason: p.reason } : {}),
      }),
    ),
    cashSpendability: {
      configured: config.workerProviders?.cashFallbackWhenBlocked === true && enabledWorkerProviders(config).includes("cash"),
      keyPresent: Boolean((deps.readCashKey ?? (() => process.env[OPENWEIGHT_API_KEY_ENV]))()),
    },
  });

  const unverifiableLines = judged.unverifiable.map((u) => `${u.taskId}: unverifiable here (host ${u.host})`);
  if (rest.includes("--json")) {
    out(JSON.stringify({ worst: report.worst, checks: report.checks }, null, 2));
    for (const l of unverifiableLines) err(l);
  } else {
    out(report.text);
    for (const l of unverifiableLines) out(l);
  }
  return report.exitCode;
}

// ── statusCommand ─────────────────────────────────────────────────────────────────────────────

/**
 * W1-T1235 — one GitHub quota bucket's most-recently-observed REFUSAL, for `rmd status`'s
 * GITHUB BUCKETS section: the read half of "carry the reading to a status line" (design (i)).
 * Folds `automerge.rate_limit_refused` rows — NEWEST `ts` per bucket wins. A bucket this host has
 * never seen refused is simply absent from the result, so the render below states "no refusal
 * recorded" rather than fabricating a healthy reading for a resource nothing has actually
 * observed — this is a REFUSAL log, not a live quota probe.
 */
export interface GhBucketRefusalStatus {
  bucket: string;
  resetsAt: string;
  operation: string;
  ts: string;
  prUrl?: string;
}

export function latestGhRateLimitRefusalsFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
): GhBucketRefusalStatus[] {
  const byBucket = new Map<string, GhBucketRefusalStatus>();
  for (const line of lines) {
    if (line.step !== "automerge.rate_limit_refused") continue;
    if (typeof line.gh_bucket !== "string") continue;
    const ts = typeof line.ts === "string" ? line.ts : "";
    const prior = byBucket.get(line.gh_bucket);
    if (prior && prior.ts >= ts) continue;
    byBucket.set(line.gh_bucket, {
      bucket: line.gh_bucket,
      resetsAt: typeof line.gh_bucket_resets_at === "string" ? line.gh_bucket_resets_at : GH_RATE_LIMIT_BUCKET_UNKNOWN,
      operation: typeof line.gh_bucket_operation === "string" ? line.gh_bucket_operation : "",
      ts,
      prUrl: typeof line.pr_url === "string" ? line.pr_url : undefined,
    });
  }
  return [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/**
 * W1-T1235 — "GITHUB BUCKETS", rendered BESIDE HEADROOM, never folded into it (design (v)): a
 * GitHub bucket is a different resource with a different reset than the model's own weekly/
 * session window, and folding them would make one figure mean two things. Pure text, exactly
 * like `renderStatusBoardText`'s own section style.
 */
export function renderGhBucketsSection(refusals: ReadonlyArray<GhBucketRefusalStatus>): string {
  const header = "── GITHUB BUCKETS ───────────────────────────────────────";
  if (refusals.length === 0) {
    return [header, "  no rate-limit refusal recorded (auto-merge arm) since this ledger began"].join("\n");
  }
  const rows = refusals.map(
    (r) => `  ${r.bucket}: refused ${r.ts} during "${r.operation}" — resets ${r.resetsAt}${r.prUrl ? ` (${r.prUrl})` : ""}`,
  );
  return [header, ...rows].join("\n");
}

/** Injectable seam for {@link statusCommand} — every default is the real, production behaviour;
 *  a test overrides just enough to avoid `loadConfig()`'s `which claude` shell-out and any real
 *  launchd query. `usage` is the ONLY exception to "every default is real": see this file's
 *  header for why it is injected rather than imported. */
export interface StatusDeps extends ReportRepoContext {
  loadConfig?: () => Config;
  queryService?: (service: ServiceName) => {
    running: boolean;
    pid: number | null;
    lastExitCode?: number;
    sensed?: boolean;
    sensor?: LivenessSensor;
  };
  lifecycleExec?: (cmd: string, args: string[]) => string;
  resolveSupervisorIntervalS?: () => number | undefined;
  ledgerPathFor?: (config: Config) => string;
  buildBatchedGithub?: typeof buildBatchedGithub;
  /** Test seam for the JSON health probe's wall-clock budget; production uses 30 seconds. */
  jsonDeadlineMs?: number;
  github?: GitHub | null;
  buildStatusBoard?: typeof buildStatusBoard;
  renderStatusBoardText?: typeof renderStatusBoardText;
  readLedgerLines?: (path: string) => Array<Record<string, unknown>>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** The full `rmd --help` listing, appended to a usage refusal — `run-task.ts`'s CLI dispatch
   *  passes the real `USAGE` here; see this file's header for why it is injected. */
  usage?: string;
}

/** Leave five seconds to finish local derivation and serialize a truthful degraded board. */
export const STATUS_JSON_DEADLINE_MS = 30_000;
const STATUS_JSON_FINALIZE_RESERVE_MS = 5_000;

export async function statusCommand(rest: string[], deps: StatusDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const badArg = unknownArgError("status", rest, [], ["--json"]);
  if (badArg) {
    err(badArg + "\n" + (deps.usage ?? ""));
    return 2;
  }
  const jsonMode = rest.includes("--json");
  const jsonBudget = deps.jsonDeadlineMs ?? STATUS_JSON_DEADLINE_MS;
  const externalDeadline = jsonMode
    ? systemClock.now() + Math.max(1, jsonBudget - Math.min(STATUS_JSON_FINALIZE_RESERVE_MS, Math.floor(jsonBudget / 6)))
    : undefined;
  const remainingExternalMs = (): number => Math.max(0, (externalDeadline ?? Infinity) - systemClock.now());
  const externalReadFailures: Record<string, string> = {};
  const recordError = (name: string, err: unknown): void => {
    const code = (err as NodeJS.ErrnoException)?.code;
    externalReadFailures[name] = code === "ETIMEDOUT" || remainingExternalMs() === 0 ? "deadline" : code ?? "read-failed";
  };
  const deadlineError = (): NodeJS.ErrnoException => {
    const error = new Error("status JSON external-read deadline exceeded") as NodeJS.ErrnoException;
    error.code = "ETIMEDOUT";
    return error;
  };
  const boundedGit = (repoDir: string, args: string[]): string => {
    const remaining = remainingExternalMs();
    if (remaining <= 0) throw new Error("status JSON external-read deadline exceeded");
    return execFileSync("git", ["-C", repoDir, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26,
      timeout: Math.max(1, Math.floor(remaining)), killSignal: "SIGKILL",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  };
  const config = (deps.loadConfig ?? loadConfig)();
  const uid = realUid();
  const lifecycleExec = deps.lifecycleExec ?? (jsonMode
    ? (cmd: string, args: string[]): string => {
        const remaining = remainingExternalMs();
        if (remaining <= 0) {
          const error = deadlineError();
          recordError("lifecycle", error);
          throw error;
        }
        try {
          return execFileSync(cmd, args, { encoding: "utf8", timeout: Math.max(1, Math.floor(remaining)), killSignal: "SIGKILL" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ETIMEDOUT") recordError("lifecycle", error);
          throw error;
        }
      }
    : defaultLifecycleExec);
  const queryService =
    deps.queryService ??
    ((service: ServiceName): { running: boolean; pid: number | null; lastExitCode?: number; sensed: boolean; sensor?: LivenessSensor } => {
      const label = service === "daemon" ? DAEMON_LABEL : service === "serve" ? SERVE_LABEL : SUPERVISOR_LABEL;
      // W1-T2450: the SENSOR-AWARE query, not `queryLaunchdService` — this is the ONE caller
      // that must not fold "launchctl itself is unavailable" (every non-launchd host) into the
      // same `pid: null` a genuinely unloaded/stopped service returns (recon rationale Q1: the
      // panel "cannot tell 'I HAVE NO SENSOR HERE' from 'THE ANSWER IS NO'").
      const state = queryLaunchdServiceSensed(label, uid, lifecycleExec);
      if (externalReadFailures.lifecycle === "deadline") return { running: false, pid: null, sensed: false };
      if (!state.sensed) return queryProcessServiceSensed(service, lifecycleExec);
      // "running" means a live pid, not merely "loaded" — a bootstrapped-but-not-spawned job
      // answers "is it running" with no, exactly like an unloaded one.
      if (service !== "deploy-supervisor") return { running: state.pid !== null, pid: state.pid, sensed: state.sensed, sensor: "launchd" };
      // deploy-supervisor is an interval job: its own `pid`/`loaded` mean nothing between ticks
      // — `launchctl list`'s Status column is the fact that actually carries its health.
      const listStatus = queryLaunchdListStatusSensed(label, lifecycleExec);
      if (externalReadFailures.lifecycle === "deadline") return { running: false, pid: null, sensed: false };
      if (!listStatus.sensed) return queryProcessServiceSensed(service, lifecycleExec);
      return {
        running: listStatus.pid !== null,
        pid: listStatus.pid,
        lastExitCode: listStatus.lastExitCode,
        sensed: listStatus.sensed,
        sensor: "launchd",
      };
    });
  const resolveSupervisorIntervalS =
    deps.resolveSupervisorIntervalS ??
    ((): number | undefined => {
      try {
        const xml = readFileSync(launchdPlistPath(SUPERVISOR_LABEL), "utf8");
        return parseSupervisorStartInterval(xml);
      } catch {
        return undefined; // not installed / unreadable — the board falls back to the default pace
      }
    });
  // W1-T11128: the default board answers INBOX's evidence anchors through the async grep (no sync `git grep` per
  // anchor); an injected `buildStatusBoard` keeps its synchronous contract and is awaited all the same.
  const buildBoard: (...args: Parameters<typeof buildStatusBoard>) => ReturnType<typeof buildStatusBoard> | ReturnType<typeof buildStatusBoardAsync> =
    deps.buildStatusBoard ?? buildStatusBoardAsync;
  const render = deps.renderStatusBoardText ?? renderStatusBoardText;
  const ledgerPath = (deps.ledgerPathFor ?? ledgerPathFor)(config);
  const repoDir = reportRepoRoot(deps);
  let pushedBranchesUnavailable = false;
  const jsonRemoteReads = jsonMode ? {
    resolveOriginMainSha: (dir: string): string | undefined => {
      try {
        const sha = boundedGit(dir, ["rev-parse", "origin/main"]).trim();
        return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
      } catch (err) { recordError("originMainSha", err); return undefined; }
    },
    readPushedRunBranches: (dir: string): string => {
      try { return boundedGit(dir, ["ls-remote", "--heads", "origin", "run-*"]); }
      catch (err) { recordError("runBranches", err); pushedBranchesUnavailable = true; return ""; }
    },
    readSharedPauseState: (dir: string) => {
      if (!existsSync(join(dir, ".git"))) return "absent" as const;
      return readSharedPause({ ...realSharedPauseGitDeps(dir), run: (args: string[]) => {
        try { return { status: 0, stdout: boundedGit(dir, args) }; }
        catch (err) { recordError("sharedPause", err); return { status: 1, stdout: "" }; }
      } });
    },
    readDispatchClaims: (dir: string) => {
      if (!existsSync(join(dir, ".git"))) return { status: "clear" as const };
      try {
        const prefix = dispatchClaimRef("");
        const claims = boundedGit(dir, ["ls-remote", "origin", `${prefix}*`]).split("\n").flatMap((line) => {
          const [holder, ref] = line.trim().split("\t");
          return holder && ref?.startsWith(prefix) && ref.length > prefix.length
            ? [{ taskId: ref.slice(prefix.length), holder }] : [];
        });
        return claims.length ? { status: "held" as const, claims } : { status: "clear" as const };
      } catch (err) { recordError("dispatchClaims", err); return { status: "unreachable" as const }; }
    },
  } : {};
  // GITHUB IS DECORATION, NEVER A GATE: `resolveOwnerRepo`/`buildBatchedGithub` can themselves
  // fail (no `git` remote, no network) — caught here so a status read NEVER throws on a bad
  // network day; the board degrades the rows that needed it to a stated unknown instead.
  let github: GitHub | undefined;
  if (deps.github === undefined) {
    try {
      const { owner, repo } = reportOwnerRepo(deps, repoDir);
      // A 60-second timeout PER request allowed several sequential GitHub reads to park a JSON
      // health probe for minutes. Give the entire remote walk one shared budget. The gateway's
      // existing failure flag then turns timed-out reads into queue/inbox unknowns, never zeroes.
      github = jsonMode
        ? (deps.buildBatchedGithub ?? buildBatchedGithub)(owner, repo, {
            // The gateway's rate-limit pacer and refusal backoff also sleep synchronously. Bound
            // those waits by the same clock; a per-child timeout alone cannot cap the whole walk.
            pacer: createGhCallPacer({ sleepSync: (ms) => {
              if (ms > remainingExternalMs()) throw deadlineError();
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
            } }),
            exec: (args) => {
              const remaining = externalDeadline! - systemClock.now();
              if (remaining <= 0) throw deadlineError();
              return ghExecFile("gh", args, {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                maxBuffer: 1 << 26,
                timeout: Math.max(1, Math.min(remaining, GH_CALL_TIMEOUT_MS)),
              });
            },
          })
        : (deps.buildBatchedGithub ?? buildBatchedGithub)(owner, repo);
    } catch {
      // Deliberate degrade, documented above the try: no git remote / no network reads exactly
      // like an unreachable gateway would, never a thrown status read.
      github = undefined;
    }
  } else {
    github = deps.github ?? undefined;
  }
  const model = await buildBoard(config.root, ledgerPath, {
    queryService,
    repoDir,
    github,
    resolveHeadroomEnabled: () => resolveHeadroomEnabled(config),
    resolveSupervisorIntervalS,
    ...jsonRemoteReads,
  });
  // W1-T1235: GITHUB BUCKETS, read BESIDE the board's own HEADROOM section rather than folded
  // into it (design (v)) — a local ledger fold of `automerge.rate_limit_refused` rows, never a
  // new `gh api rate_limit` call, so this section costs `rmd status` no additional network
  // request.
  const readLedger = deps.readLedgerLines ?? ((pth: string) => readLedgerLines(pth) as Array<Record<string, unknown>>);
  const ghBucketRefusals = latestGhRateLimitRefusalsFromLedger(readLedger(ledgerPath));
  if (jsonMode) {
    // The board's text renderer uses []/0 alongside an unknownReason to keep its established
    // model types. In JSON, those success-shaped values invite consumers to treat an unfinished
    // read as a measured empty queue or inbox. Make unavailable explicit at this boundary.
    const queueHeadReason = [
      model.queueHead.unknownReason,
      pushedBranchesUnavailable ? "run-branch lookup unavailable before the status JSON deadline" : undefined,
    ].filter(Boolean).join("; ") || undefined;
    const queueHead = queueHeadReason
      ? { ...model.queueHead, unknownReason: queueHeadReason, status: "unavailable", rows: null, refused: null, refusedTruncated: null }
      : model.queueHead;
    const inbox = model.inbox.unknownReason
      ? { ...model.inbox, status: "unavailable", readyCount: null, notReadyCount: null }
      : model.inbox;
    const externalReads = Object.fromEntries(Object.entries(externalReadFailures).map(([name, reason]) =>
      [name, { status: "unavailable", reason }]));
    out(JSON.stringify({ ...model, queueHead, inbox, ghBucketRefusals, externalReads }, null, 2));
  } else {
    out(`${render(model)}\n\n${renderGhBucketsSection(ghBucketRefusals)}`);
  }
  return 0;
}

/** One explicit PR read for an operator-requested case file. A rollup absence is unknown, not green. */
export function parseCasePrSnapshot(value: unknown, readAt: string): CasePrRead {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "unavailable", reason: "pr-response-invalid" };
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.number) || (row.number as number) <= 0 || typeof row.url !== "string"
    || !["OPEN", "CLOSED", "MERGED"].includes(String(row.state))
    || typeof row.headRefOid !== "string" || !/^[a-f0-9]{40}$/i.test(row.headRefOid)) {
    return { state: "unavailable", reason: "pr-identity-invalid" };
  }
  const checks: CasePrSnapshot["checks"] = Array.isArray(row.statusCheckRollup)
    ? classifyRollupSupersession(row.statusCheckRollup.filter((e: unknown): e is RollupCheckEntry => !!e && typeof e === "object" && !Array.isArray(e))).latest.flatMap((entry) => {
      const check = entry as Record<string, unknown>;
      const name = typeof check.name === "string" ? check.name : typeof check.context === "string" ? check.context : null;
      const raw = check.__typename === "StatusContext" ? check.state : check.conclusion ?? check.status;
      if (!name || typeof raw !== "string") return [];
      const state = raw.toLowerCase();
      return [{ name, state: state === "success" ? "success" as const
        : ["failure", "error", "cancelled", "timed_out", "action_required"].includes(state) ? "failure" as const
          : "pending" as const }];
    }) : null;
  return { state: "observed", value: {
    number: row.number as number, url: row.url, state: row.state as CasePrSnapshot["state"],
    headSha: row.headRefOid, body: typeof row.body === "string" ? row.body : "",
    mergedAt: typeof row.mergedAt === "string" ? row.mergedAt : null,
    checks, readAt,
  } };
}

export interface CaseFileCommandInput extends ReportRepoContext {
  loadConfig?: () => Config;
  buildGithub?: typeof buildBatchedGithub;
  readGhPr?: typeof ghJson;
  readTask?: (taskId: string) => Task | undefined;
  readLedger?: (stateDir: string, taskId: string, asOf: string) => Promise<CaseLedgerRead>;
  /** The batch form's ONE union pass for every requested task. */
  readLedgers?: (stateDir: string, taskIds: readonly string[], asOf: string) => Promise<Map<string, CaseLedgerRead>>;
  readProjection?: (task: Task, ledger: CaseLedgerRead) => StatusProjection | undefined;
  readPr?: (number: number, owner: string, repo: string, readAt: string) => CasePrRead;
  nowIso?: () => string;
  stateDir?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  usage?: string;
}

/**
 * BACKSTOP: the batch form's per-task GitHub reads are sequential, one PR view each. A cohort
 * snapshot (27 tasks in the 2026-09-27 A/A) sits far below this; a list beyond it is refused
 * whole rather than issuing an unbounded run of reads.
 */
export const MAX_CASE_FILE_BATCH_TASKS = 200;

const CASE_FILE_TASK_ID = /^W\d+-T\d+$/;

/** `--tasks <id,id,...>` and `--tasks-file <path>` (ids split on commas or whitespace), deduped in order. */
function caseFileBatchIds(rest: string[]): string[] | string {
  const ids: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--json") continue;
    const value = rest[index + 1];
    if ((flag !== "--tasks" && flag !== "--tasks-file") || value === undefined) return `unexpected argument ${flag}`;
    index += 1;
    let text = value;
    if (flag === "--tasks-file") {
      try { text = readFileSync(value, "utf8"); }
      catch {
        const reason = `--tasks-file ${value} is unreadable`;
        return reason;
      }
    }
    ids.push(...text.split(/[\s,]+/).filter(Boolean));
  }
  const unique = [...new Set(ids)];
  const invalid = unique.find((id) => !CASE_FILE_TASK_ID.test(id));
  if (invalid !== undefined) return `${invalid} is not a task id`;
  if (unique.length === 0) return "no task ids given";
  if (unique.length > MAX_CASE_FILE_BATCH_TASKS) return `${unique.length} task ids exceed the batch bound of ${MAX_CASE_FILE_BATCH_TASKS}`;
  return unique;
}

/** One task's GitHub side: the batched board read (shared across a batch) and one exact PR read. */
function assembleCaseFile(task: Task, ledger: CaseLedgerRead, asOf: string, root: string, deps: CaseFileCommandInput,
  github: (owner: string, repo: string) => ReturnType<typeof buildBatchedGithub>): TaskCaseFile {
  let projection: StatusProjection | undefined;
  let prRead: CasePrRead = { state: "unavailable", reason: "github-not-read" };
  let ownerRepo: { owner: string; repo: string } | undefined;
  try {
    ownerRepo = reportOwnerRepo(deps, root);
    projection = deps.readProjection ? deps.readProjection(task, ledger) : deriveStatus(task, {
      ledgerPath: ledgerPathFor((deps.loadConfig ?? loadConfig)()),
      readLedger: () => ledger.state === "observed" ? ledger.rows : [],
      github: github(ownerRepo.owner, ownerRepo.repo),
    });
    if (projection?.indeterminate === true && projection.prNumber === undefined) {
      // A failed status read is not an observed absence: "no PR" here would read as a run that ended without one.
      prRead = { state: "unavailable", reason: `projection-indeterminate:${projection.unavailableReason ?? "unclassified"}` };
    } else if (projection?.prNumber !== undefined) {
      prRead = deps.readPr ? deps.readPr(projection.prNumber, ownerRepo.owner, ownerRepo.repo, asOf)
        : parseCasePrSnapshot((deps.readGhPr ?? ghJson)(["pr", "view", String(projection.prNumber), "--repo", `${ownerRepo.owner}/${ownerRepo.repo}`,
          "--json", "number,url,state,headRefOid,body,mergedAt,statusCheckRollup"]), asOf);
    } else {
      prRead = { state: "unavailable", reason: "no-pr-in-current-projection" };
    }
  } catch (error) {
    prRead = { state: "unavailable", reason: `github-read-failed:${error instanceof Error ? error.name : "unknown"}` };
  }
  return buildTaskCaseFile({ task, projection, ledger, prRead, asOf });
}

/** `rmd case-file`: one task (or a `--tasks` batch under one asOf and ONE ledger union pass),
 * bounded local ledger union, batched board read, one exact PR read per task. */
export async function caseFileCommand(rest: string[], deps: CaseFileCommandInput = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const batch = rest.includes("--tasks") || rest.includes("--tasks-file");
  const taskIds = batch ? caseFileBatchIds(rest) : [rest[0]];
  if (typeof taskIds === "string" || (!batch && (!rest[0] || !CASE_FILE_TASK_ID.test(rest[0])
    || rest.some((arg, index) => index > 0 && arg !== "--json")))) {
    err(typeof taskIds === "string" ? `rmd case-file: expected --tasks <id,id,...> [--tasks-file <path>] [--json] (${taskIds})\n${deps.usage ?? ""}`
      : `rmd case-file: expected <task-id> [--json]\n${deps.usage ?? ""}`);
    return 2;
  }
  const root = reportRepoRoot(deps);
  const asOf = (deps.nowIso ?? (() => systemClock.iso()))();
  const tasks: Task[] = [];
  const roots: string[] = [];
  for (const taskId of taskIds) {
    const located = deps.readTask ? undefined : deps.resolveTaskPlan?.(taskId);
    if (located && !located.ok) { err(`rmd case-file: ${taskId} is not in the plan (${located.error})`); return 2; }
    const taskRoot = located?.ok ? located.root : root;
    const task = deps.readTask ? deps.readTask(taskId) : loadPlan(resolveRepoLayout(taskRoot).planMonolith).byId.get(taskId);
    if (!task) { err(`rmd case-file: ${taskId} is not in the plan (${resolveRepoLayout(taskRoot).planMonolith})`); return 2; }
    tasks.push(task);
    roots.push(taskRoot);
  }
  const stateDir = deps.stateDir ?? join((deps.loadConfig ?? loadConfig)().root, "state");
  const ledgers = batch ? await (deps.readLedgers ?? readTaskCaseLedgers)(stateDir, taskIds, asOf)
    : new Map([[taskIds[0], await (deps.readLedger ?? readTaskCaseLedger)(stateDir, taskIds[0], asOf)]]);
  let gateway: ReturnType<typeof buildBatchedGithub> | undefined;
  // A cold walk stops at the board's page ceiling, below this repository's closed-PR count, so every
  // older task read as indeterminate. The daemon's persisted snapshot turns it into a delta read.
  const github = (owner: string, repo: string) => gateway ??= (deps.buildGithub ?? buildBatchedGithub)(owner, repo,
    { snapshotCache: createBoardSnapshotCache(dirname(stateDir), owner, repo) });
  const files = tasks.map((task, index) => assembleCaseFile(task, ledgers.get(task.id)!, asOf, roots[index]!, deps, github));
  // JSON is also the default so every evidence state, source, and as-of remains machine-readable.
  out(JSON.stringify(batch ? files : files[0], null, 2));
  return 0;
}

// ── receiptCommand ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve review/receipt's --repo override; a bare name keeps the default owner.
 * Pure so sandbox gating can be tested without gh.
 */
export function resolveReviewTarget(
  defaults: { owner: string; repo: string },
  rest: string[],
): { owner: string; repo: string } {
  const i = rest.indexOf("--repo");
  const arg = i >= 0 ? rest[i + 1] : undefined;
  if (!arg) return defaults;
  if (arg.includes("/")) {
    const [owner, repo] = arg.split("/", 2);
    return { owner, repo };
  }
  return { owner: defaults.owner, repo: arg };
}

export function reviewTaskIdFromBody(body: string): string | undefined {
  return extractTaskTrailerId(body);
}

/**
 * Resolve a number or PR URL for REST; branches return undefined and keep gh pr view.
 */
export function reviewPrNumber(prArg: string): number | undefined {
  const bare = /^#?(\d+)$/.exec(prArg.trim());
  if (bare) return Number(bare[1]);
  // A github.com PR URL, the other form an operator pastes. Anchored on `/pull/<n>` so a branch
  // literally named "pull/7" cannot be mistaken for one.
  const url = /^https?:\/\/[^\s]*\/pull\/(\d+)(?:[/?#].*)?$/.exec(prArg.trim());
  return url ? Number(url[1]) : undefined;
}

/**
 * Receipt/review use REST for resolved PR numbers, gh pr view for branches.
 * Reuse singlePrRestArgs/mapRestPr's tested html_url, null body, headRefName and auto_merge mapping.
 */
export function reviewViewArgs(owner: string, repo: string, prArg: string): string[] {
  const n = reviewPrNumber(prArg);
  if (n !== undefined) return singlePrRestArgs(owner, repo, n);
  return ["pr", "view", prArg, "--repo", `${owner}/${repo}`, "--json", "headRefOid,headRefName,body,url,number"];
}

/** Seams for {@link receiptCommand} — defaulted to the real gateways; a test injects fakes so
 *  the command's own PR/task-id resolution + print path is exercisable with zero network. */
export interface ReceiptCommandDeps extends ReportRepoContext {
  gh?: (args: string[]) => unknown;
  config?: Config;
  /** W1-T2257: archive∪live union, scoped to receipt steps; injectable for success/refusal tests. */
  resolveReceiptLedgerLines?: (stateDir: string) => ReceiptLedgerRead;
}

/**
 * Read-only deterministic receipt for open/merged PRs (W1-T71/P17). Reuse review's hardened
 * task-trailer extractor (#119); missing task ids refuse rather than guess.
 * W1-T2257: resolveReceiptLedgerLines reads archive∪live, since rotation empties the live slice.
 * A refused union exits nonzero with its reason, never a misleading receipt of null leaves.
 */
export async function receiptCommand(prArg: string, rest: string[] = [], deps: ReceiptCommandDeps = {}): Promise<number> {
  const badArg = unknownArgError("receipt", rest, ["--repo"]);
  if (badArg) {
    console.error(badArg);
    return 2;
  }
  const { owner, repo } = resolveReviewTarget(reportOwnerRepo(deps), rest);
  const gh = deps.gh ?? ghJson;
  const args = reviewViewArgs(owner, repo, prArg);
  const raw = gh(args);
  const view = (reviewPrNumber(prArg) !== undefined ? mapRestPr(raw as RestPullRow) : raw) as {
    headRefOid: string;
    headRefName: string;
    body: string;
    url: string;
    number: number;
  };
  const body = view.body ?? "";
  const taskId = reviewTaskIdFromBody(body);
  if (!taskId) {
    console.error(
      `rmd receipt: no Remudero-Task trailer resolvable from ${view.url ?? prArg}'s body — nothing to build a receipt for`,
    );
    return 1;
  }
  const config = deps.config ?? loadConfig();
  const stateDir = dirname(ledgerPathFor(config));
  const resolved = (deps.resolveReceiptLedgerLines ?? resolveReceiptLedgerLines)(stateDir);
  if (!resolved.ok) {
    console.error(`rmd receipt: ${resolved.reason}`);
    return 1;
  }
  const receipt = buildReceipt(resolved.lines, { taskId, prUrl: view.url ?? prArg });
  console.log(JSON.stringify(receipt, null, 2));
  return 0;
}

// ── replayCommand ─────────────────────────────────────────────────────────────────────────────

/**
 * W1-T2296: read-only narration of a ledger window via buildReplay, without GitHub or writes.
 * resolveReplayLedgerLines reads archive∪live and refuses a partial corpus; rotation empties live.
 */
export interface ReplayCommandOpts {
  /** Injectable so a test drives both branches against a synthetic state root — same seam
   *  `ledgerGrepCommand`'s `opts.stateDir` uses. */
  stateDir?: string;
  /** Injectable so a test drives the resolved-lines and refused (`ok: false`) paths without a
   *  real state dir — same seam `receiptCommand`'s `deps.resolveReceiptLedgerLines` uses. */
  resolveReplayLedgerLines?: (stateDir: string) => ReplayLedgerRead;
  /** This command's own `rmd replay ...` syntax line, appended to a usage refusal —
   *  `run-task.ts`'s CLI dispatch passes `commandSyntax("replay")`; see this file's header. */
  commandSyntax?: string;
  /** The full `rmd --help` listing, appended to a usage refusal; see this file's header. */
  usage?: string;
}

export function replayCommand(
  since: string | undefined,
  until: string | undefined,
  rest: string[],
  opts: ReplayCommandOpts = {},
): number {
  const badArg = unknownArgError("replay", rest, ["--task", "--step"], []);
  if (!since || !until || badArg) {
    if (badArg) console.error(badArg);
    console.error(`usage: ${opts.commandSyntax ?? "rmd replay <since> <until> [--task <id>] [--step <prefix>]"}\n` + (opts.usage ?? ""));
    return 2;
  }
  const taskId = flagValue(rest, "--task");
  const stepPrefix = flagValue(rest, "--step");

  // Mirrors receiptCommand's own stateDir derivation rather than introducing a second,
  // defensively-caught derivation idiom for the same job.
  const stateDir = opts.stateDir ?? dirname(ledgerPathFor(loadConfig()));
  const resolved = (opts.resolveReplayLedgerLines ?? resolveReplayLedgerLines)(stateDir);
  if (!resolved.ok) {
    console.error(`rmd replay: ${resolved.reason}`);
    return 1;
  }
  console.log(buildReplay(resolved.lines, { since, until, taskId, stepPrefix }));
  return 0;
}

// ── ledgerGrepCommand ─────────────────────────────────────────────────────────────────────────

/** The `step` field of one raw matched ledger line's JSON text, or `undefined` when the line does
 *  not parse as JSON or carries no string `step` -- never thrown, since `ledgerGrepCommand` must
 *  keep printing the row itself either way (W1-T2764). */
export function stepFromRawLedgerLine(line: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Malformed/torn JSON is a genuinely absent step, never a throw here: the row itself was
    // already printed above, unconditionally, before this parse was attempted.
    return undefined;
  }
  const step = (parsed as { step?: unknown } | null)?.step;
  return typeof step === "string" ? step : undefined;
}

export interface LedgerGrepCommandOpts {
  stateDir?: string;
  /** This command's own `rmd ledger-grep ...` syntax line, appended to a usage refusal —
   *  `run-task.ts`'s CLI dispatch passes `commandSyntax("ledger-grep")`; see this file's header. */
  commandSyntax?: string;
  /** The full `rmd --help` listing, appended to a usage refusal; see this file's header. */
  usage?: string;
}

export function ledgerGrepCommand(rest: string[], opts: LedgerGrepCommandOpts = {}): number {
  const pattern = rest[0];
  const badArg = unknownArgError("ledger-grep", rest.slice(1), [], []);
  if (!pattern || badArg) {
    if (badArg) console.error(badArg);
    console.error(`usage: ${opts.commandSyntax ?? "rmd ledger-grep <pattern>"}\n` + (opts.usage ?? ""));
    return 2;
  }

  // Injected LAST and defaulted, so no positional caller shifts — a test drives both the
  // "archives present" and "zero archives" branches against a synthetic state root instead of
  // this host's real one.
  const stateDir =
    opts.stateDir ??
    (() => {
      try {
        return join(loadConfig().root, "state");
      } catch {
        // An unreadable config is reported by name at the caller (the `stateDir === undefined`
        // branch just below), never guessed at or silently retried here.
        return undefined;
      }
    })();
  if (stateDir === undefined) {
    console.error("rmd ledger-grep: cannot resolve a state dir — unreadable config");
    return 1;
  }

  console.log(`pattern:    ${pattern}`);
  console.log(`state dir:  ${stateDir}`);
  const result = resolveLedgerUnion(stateDir, pattern);
  console.log(`archives:   ${result.archiveCount} matched`);
  if (!result.ok) {
    console.error(
      `rmd ledger-grep: ZERO archive files matched ${join(stateDir, "ledger.*.ndjson.gz")} — refusing to ` +
        "answer from the live ledger alone. A count from the live file only is the exact silent " +
        "undercount this verb exists to kill, so it is an error, never a smaller result.",
    );
    return 1;
  }
  console.log(`matches:    ${result.matches.length}`);
  for (const line of result.matches) {
    console.log(line);
    // W1-T2764: the one decoder seam this verb wires. `stepFromRawLedgerLine` reads `step` off
    // the matched raw JSON text without trusting the whole line to parse as a well-formed
    // LedgerLine — a torn or hand-edited row still prints unchanged above; this only ever adds a
    // second line when both the row's own `step` field AND a registered meaning for it exist.
    const step = stepFromRawLedgerLine(line);
    const decoded = step === undefined ? undefined : meaningOfStep(step);
    if (decoded) console.log(`  meaning: ${decoded.meaning}`);
  }
  return 0;
}

// ── digestPlistCommand ────────────────────────────────────────────────────────────────────────

export async function digestPlistCommand(rest: string[], opts: { usage?: string } = {}): Promise<number> {
  const badArg = unknownArgError("digest-plist", rest, ["--hour"], ["--write"]);
  if (badArg) {
    console.error(badArg + "\n" + (opts.usage ?? ""));
    return 2;
  }
  const config = loadConfig();
  const hourRaw = flagValue(rest, "--hour");
  const hour = hourRaw !== undefined ? Number(hourRaw) : undefined;
  // W1-T925: install-derived, never repoRoot — see daemonPlistCommand's identical comment.
  const installRoot = resolveInstallRoot(config);
  const rmdBin = join(installRoot, "bin", "rmd");
  const plist = generateDigestLaunchdPlist({
    rmdBin,
    installRoot,
    installRootExists: existsSync(installRoot),
    root: config.root,
    hour,
  });
  const plistPath = launchdPlistPath(DIGEST_LABEL);

  if (rest.includes("--write")) {
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, plist);
    console.log(`### rmd digest-plist — wrote ${plistPath}`);
  } else {
    console.log(plist);
  }
  console.log(
    `\n# to commission (operator-run — NOT done by this command):\n` +
      `launchctl load ${plistPath}`,
  );
  return 0;
}

// ── digestCommand ─────────────────────────────────────────────────────────────────────────────

/**
 * W1-T163: without --since, share the console recap's per-write-token last-seen marker,
 * falling back to 24h ago on first use. Send advances it; --dry-run has no side effects.
 * Explicit --since uses that window without changing the shared push/pull marker.
 */
export async function digestCommand(
  rest: string[],
  deps: { notifyChannel?: NotifyChannel } = {},
): Promise<number> {
  const explicitSince = flagValue(rest, "--since");
  const config = loadConfig();
  const ledgerPath = ledgerPathFor(config);

  if (explicitSince !== undefined) {
    if (rest.includes("--dry-run")) {
      console.log(buildDigest(ledgerPath, explicitSince, consoleAppUrl(config)));
      return 0;
    }
    const text = sendDigest(
      ledgerPath,
      explicitSince,
      {
        channel: deps.notifyChannel ?? imessageChannel(notifyRecipient(config)),
        ledgerPath,
        runId: `DIGEST-${Date.now()}`,
        taskId: "DIGEST",
      },
      consoleAppUrl(config),
    );
    console.log(text);
    return 0;
  }

  const tokenId = hashToken(resolveServiceTokens(config.root).write);
  const store = createLastSeenStore(lastSeenPath(config.root));
  const nowIso = new Date().toISOString();
  if (rest.includes("--dry-run")) {
    console.log(buildMarkerAwareDigest(ledgerPath, store, tokenId, nowIso, consoleAppUrl(config)).text);
    return 0;
  }
  const text = sendMarkerAwareDigest(
    ledgerPath,
    store,
    tokenId,
    {
      channel: deps.notifyChannel ?? imessageChannel(notifyRecipient(config)),
      ledgerPath,
      runId: `DIGEST-${Date.now()}`,
      taskId: "DIGEST",
    },
    nowIso,
    consoleAppUrl(config),
  );
  console.log(text);
  return 0;
}

// ── learningsCommand / learningsExportCommand / learningsImportCommand ──────────────────────────

/**
 * §6 transport (W1-T425): route export/import to wrappers over learnings.ts privacy/pin logic.
 */
export interface LearningsCommandOpts extends ReportRepoContext {
  usage?: string;
}

export function learningsCommand(rest: string[], opts: LearningsCommandOpts = {}): number {
  const sub = rest[0];
  if (sub === "export") return learningsExportCommand(rest.slice(1), opts);
  if (sub === "import") return learningsImportCommand(rest.slice(1), { usage: opts.usage });
  console.error(
    `rmd learnings: unknown subcommand '${sub ?? ""}' — usage: rmd learnings export <out> | rmd learnings import <file> --pin <hash>\n` +
      (opts.usage ?? ""),
  );
  return 2;
}

/**
 * Export ACTIVE, share:public project entries as a pinned learnings-v2 bundle (§6, W1-T425).
 * buildExportBundle binds public provenance, excludes author src/Git locators, and refuses
 * zero opt-ins or leak-grep matches without writing. Keep privacy logic in that builder.
 * Injectable projectDir/headSha allow fixture exports and unreadable-git tests without
 * changing this checkout's shards.
 */
export function learningsExportCommand(
  rest: string[],
  opts: LearningsCommandOpts & { projectDir?: string; headSha?: () => string } = {},
): number {
  const out = rest[0];
  const badArg = unknownArgError("learnings export", rest.slice(1), [], []);
  if (badArg) {
    console.error(badArg + "\n" + (opts.usage ?? ""));
    return 2;
  }
  if (!out) {
    console.error(`rmd learnings export: <out> is required — usage: rmd learnings export <out>\n` + (opts.usage ?? ""));
    return 2;
  }
  const repoDir = reportRepoRoot(opts);
  const entries = loadLearningsCorpus(opts.projectDir ?? projectLearningsHome(repoDir));
  let sourceRepo = "unknown";
  try {
    const { owner, repo } = reportOwnerRepo(opts, repoDir);
    sourceRepo = `${owner}/${repo}`;
  } catch {
    // no origin remote configured — provenance degrades to "unknown", never a crash.
  }
  const readHeadSha =
    opts.headSha ?? (() => execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  let sourceSha = "unknown";
  try {
    sourceSha = readHeadSha() || "unknown";
  } catch {
    // no git history readable — same degrade-to-"unknown" as above.
  }
  const result = buildExportBundle(entries, { sourceRepo, sourceSha, exportedAt: new Date().toISOString() });
  if (!result.ok) {
    console.error(`rmd learnings export: ${result.reason}`);
    return 1;
  }
  writeFileSync(out, renderExportBundle(result.bundle), "utf8");
  const n = result.bundle.entries.length;
  console.log(
    `### rmd learnings export — wrote ${out}: ${n} shared entr${n === 1 ? "y" : "ies"} from ${sourceRepo}@${sourceSha.slice(0, 12)}.\n` +
      `hash=${result.bundle.hash}\n` +
      `Share this hash out-of-band — the importer must pass it as \`--pin <hash>\` or the import refuses.`,
  );
  return 0;
}

/**
 * Import (§6, W1-T425) writes the bundle VERBATIM to globalArtifactPath only if verifyBundlePin
 * matches --pin. Overwrite only the imported global bundle, never project/user-overall layers.
 * loadGlobalArtifact rechecks content against the hash at prompt assembly, catching later edits;
 * this wrapper checks only the declared pin.
 */
export function learningsImportCommand(rest: string[], opts: { usage?: string } = {}): number {
  const file = rest[0];
  const badArg = unknownArgError("learnings import", rest.slice(1), ["--pin"], []);
  if (badArg) {
    console.error(badArg + "\n" + (opts.usage ?? ""));
    return 2;
  }
  if (!file) {
    console.error(`rmd learnings import: <file> is required — usage: rmd learnings import <file> --pin <hash>\n` + (opts.usage ?? ""));
    return 2;
  }
  const pin = flagValue(rest, "--pin");
  if (!pin) {
    console.error(
      `rmd learnings import: --pin <hash> is required — the operator-supplied hash the bundle must match\n` + (opts.usage ?? ""),
    );
    return 2;
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    console.error(`rmd learnings import: cannot read ${file}: ${String((e as Error)?.message ?? e)}`);
    return 2;
  }
  const verified = verifyBundlePin(text, pin);
  if (!verified.ok) {
    console.error(`rmd learnings import: ${verified.reason}`);
    return 1;
  }
  const config = loadConfig();
  mkdirSync(globalLearningsHome(config), { recursive: true });
  const dest = globalArtifactPath(config);
  writeFileSync(dest, text, "utf8");
  console.log(
    `### rmd learnings import — wrote ${dest} (pin verified against ${file}). Trust enforcement (the content-hash ` +
      `re-check) runs again at prompt-assembly time via the existing loadGlobalArtifact guard — a bundle ` +
      `hand-edited after this pin check still contributes zero entries, never silently trusted.`,
  );
  return 0;
}

// ── traceCommand ──────────────────────────────────────────────────────────────────────────────

/**
 * W1-T43 / MASTER-PLAN §7B / Standing rule 17: trace feedback → proposal → tasks → runs → PRs → sha.
 * Resolve task id first (reverse to origin), then feedback id (forward to tasks).
 * If neither resolves, emit a fail-loud usage error, never an empty chain.
 */
export async function traceCommand(
  rest: string[],
  opts: ReportRepoContext & { usage?: string; commandSyntax?: string } = {},
): Promise<number> {
  const id = rest[0];
  const badArg = id?.startsWith("--")
    ? `rmd trace: unexpected argument '${id}' — see \`rmd --help\``
    : unknownArgError("trace", rest.slice(1), [], []);
  if (badArg) {
    console.error(badArg + "\n" + (opts.usage ?? ""));
    return 2;
  }
  if (!id) {
    console.error(`rmd trace: <id> is required — usage: ${opts.commandSyntax ?? "rmd trace <id>"}\n` + (opts.usage ?? ""));
    return 2;
  }

  const located = opts.resolveTaskPlan?.(id);
  const repoDir = located?.ok ? located.root : reportRepoRoot(opts);
  const planPath = join(repoDir, "plan", "tasks.yaml");
  let plan: Plan;
  try {
    plan = loadPlan(planPath);
  } catch (e) {
    if (!located || located.ok) throw e;
    console.error(`rmd trace: '${id}' (${located.error}); cannot load plan for feedback tracing: ${String((e as Error)?.message ?? e)}`);
    return 2;
  }
  const config = loadConfig();
  const ownerRepo = reportOwnerRepo(opts, repoDir);
  const { owner, repo: defaultRepo } = located?.ok && located.owner
    ? { ...ownerRepo, owner: located.owner }
    : ownerRepo;
  const ledgerPath = ledgerPathFor(config);
  const ledgerLines = readLedgerLines(ledgerPath);

  const task = plan.byId.get(id);
  if (task) {
    const github = ghTraceGateway(owner, task.repo || defaultRepo);
    let feedbackEntry: FeedbackEntry | undefined;
    if (task.origin?.startsWith("feedback#")) {
      const feedbackId = task.origin.slice("feedback#".length);
      try {
        feedbackEntry = readFeedbackEntry(repoDir, feedbackId);
      } catch (e) {
        console.error(`### rmd trace — note: ${task.id} names origin: ${task.origin}, but ${String((e as Error)?.message ?? e)}`);
      }
    }
    const chain = traceReverse(task, { plan, ledgerLines, github }, feedbackEntry);
    console.log(`### rmd trace ${id} (reverse — task back to its origin)`);
    console.log(renderTraceChain(chain));
    return 0;
  }

  let entry: FeedbackEntry;
  try {
    entry = readFeedbackEntry(repoDir, id);
  } catch {
    console.error(
      `rmd trace: '${id}' is neither a known task id (${located && !located.ok ? located.error : planPath}) nor a feedback entry (plan/feedback/${id}.yaml)`,
    );
    return 2;
  }
  const github = ghTraceGateway(owner, defaultRepo);
  const chain = traceForward(entry, { plan, ledgerLines, github });
  console.log(`### rmd trace ${id} (forward — feedback out to its task(s))`);
  console.log(renderTraceChain(chain));
  return 0;
}
