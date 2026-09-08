/**
 * THE READ-AND-PRINT CLI VERBS — moved out of `src/run-task.ts` (W1-T2888, decomposition step 5).
 *
 * `receiptCommand`, `replayCommand`, `ledgerGrepCommand`, `digestPlistCommand`, `doctorCommand`,
 * `statusCommand`, `digestCommand`, `learningsCommand`/`learningsExportCommand`/
 * `learningsImportCommand`, and `traceCommand` each take a deps object, read the ledger/plan/
 * GitHub through it, print, and return an exit code — none dispatches a worker, holds a lock, or
 * mutates the plan, the cheapest large cluster of `run-task.ts`'s 75 `*Command` handlers to move.
 *
 * A MOVE, NOT A REDESIGN — same discipline `lib/cli-args.ts`'s `unknownArgError` move (W1-T2260)
 * established: every function below is byte-identical in behaviour to the one it replaces.
 * `run-task.ts` re-imports/re-exports every name under its original identifier, so every
 * pre-existing call site and test import keeps working unchanged.
 *
 * USAGE TEXT IS INJECTED, NEVER IMPORTED: `USAGE`/`commandSyntax(name)` derive from `COMMANDS`,
 * which stays in `run-task.ts` — importing them here would be the `lib -> run-task` edge this
 * decomposition exists to avoid, and would drag the 38k-line dispatcher into
 * `test/report-commands.test.ts`'s import graph. The handful of verbs that print it instead
 * accept `usage`/`syntax` as optional strings; `run-task.ts`'s CLI dispatch passes the real
 * values, so production output is unchanged, while a caller that supplies neither degrades to
 * an empty appended listing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  consoleUrl,
  globalArtifactPath,
  globalLearningsHome,
  loadConfig,
  notifyRecipient,
  resolveHeadroomEnabled,
  type Config,
} from "./config.js";
import { flagValue, unknownArgError } from "./cli-args.js";
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
import { resolveInstallRoot } from "./install-root.js";
import {
  buildStatusBoard,
  deriveDispatchCadence,
  deriveQueueHead,
  renderStatusBoardText,
  type ServiceName,
} from "./status-board.js";
import {
  buildBatchedGithub,
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
  readDiskFreeBytes,
  readDiskTotalBytes,
  readGitLocks,
  readMemInfo,
  readNvmrcVersion,
  readPauseAgeMs,
  refuseUnsupportedArgs,
  type MemInfo,
  type WorktreeBaseRow,
} from "./doctor.js";
import { readInflightLock } from "./inflight-lock.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { repoRoot, resolveOwnerRepo } from "./repo-location.js";
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
import { ghJson, GH_RATE_LIMIT_BUCKET_UNKNOWN } from "./github-transport.js";
import { worktreesDir, readWorktreeBase } from "./worker.js";

// ── launchd query cluster (statusCommand's `queryService`, shared with up/down's own queries) ──
//
// Read-only `launchctl print`/`launchctl list` queries — moved alongside `statusCommand`, which
// needs `realUid`/`queryLaunchdServiceSensed`/`queryLaunchdListStatusSensed` for its default
// `queryService` closure. `queryLaunchdService`/`queryLaunchdListStatus` (the non-sensor-aware
// siblings) and `LaunchdServiceState`/`LaunchdListStatus` are also used by `upCommand`/
// `downCommand`, which stay in `run-task.ts` and import them back from here — never duplicated.
// Deliberately NOT in `lib/launchd.ts`: that module's own header states it "never shells out to
// `launchctl`" (a documented invariant test/launchd.test.ts and test/serve-plist.test.ts hold it
// to); these functions do exactly that, so they belong beside the report verb that reads them.

/** `launchctl print`'s pid line ("	pid = 61234"). Absent — a job bootstrapped but not yet
 *  spawned, or one that just exited — means "loaded, not (yet) running", distinct from "not
 *  loaded at all" (the caller tells those apart via {@link LaunchdServiceState.loaded}). Exported
 *  (W1-T2888) solely so test/report-commands.test.ts can drive its unhealthy arm by identifier —
 *  negative-reachability-ratchet.test.ts's own census. */
export const LAUNCHCTL_PID_RE = /"?pid"?\s*=\s*(\d+)/;

export interface LaunchdServiceState {
  /** True iff `launchctl print` finds the service at all (bootstrapped into the GUI domain). */
  loaded: boolean;
  /** The job's live pid, or `null` when loaded but not (yet) running. */
  pid: number | null;
}

/** The one real subprocess seam every lifecycle helper below defaults to — a test fakes THIS
 *  one function and every helper obeys it, rather than each helper importing `execFileSync`
 *  for itself (the same one-seam discipline deployer.ts's `realDeployDeps` established for
 *  its own `launchctl kickstart` call). */
export function defaultLifecycleExec(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).toString();
}

/** This process's real UID, or 0 when `process.getuid` is unavailable (non-POSIX — launchd
 *  itself is macOS-only, so that branch never actually runs in production; mirrors
 *  `deployRunCommand`'s own `process.getuid` guard). */
export function realUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

/** True iff `e` is the ENOENT `execFileSync` throws when `launchctl` ITSELF cannot be found —
 *  every non-macOS host, this container included (W1-T2450 recon: `command -v launchctl`
 *  measured absent here, `uname -s` Linux). Distinct from `execFileSync` throwing because
 *  `launchctl` ran and exited non-zero (a real "not loaded"/"not found" answer, which carries
 *  no `.code === "ENOENT"`) — the ONE bit that tells "I have no sensor here" apart from "the
 *  answer is no" (recon rationale Q1). */
function isLaunchctlAbsent(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * `launchctl print gui/<uid>/<label>` — the SAME query both `rmd down`'s "already down" check
 * and `rmd up`'s "already up" check read, so the two verbs can never disagree about whether a
 * service is loaded. A non-bootstrapped label exits non-zero ("Could not find service..."),
 * which `execFileSync` turns into a throw — caught here as `loaded: false`, never a crash.
 * Deliberately drops the `sensed` bit {@link queryLaunchdServiceSensed} carries: `rmd down`/
 * `rmd up` treat "no launchd here" and "not loaded" identically on purpose (idempotent
 * unload-when-absent is the right degrade for THEM) — only the status panel must not fold the
 * two together (W1-T2450), so it calls the `*Sensed` sibling below instead.
 */
export function queryLaunchdService(
  label: string,
  uid: number,
  exec: (cmd: string, args: string[]) => string = defaultLifecycleExec,
): LaunchdServiceState {
  const { sensed: _sensed, ...state } = queryLaunchdServiceSensed(label, uid, exec);
  return state;
}

/** Sensor-aware sibling of {@link queryLaunchdService}, for the status panel's `queryService`
 *  (W1-T2450) — the one caller that must distinguish "launchctl itself is unavailable" from "a
 *  bootstrapped-but-unloaded/absent service". Same query, same catch, ONE extra bit. */
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

/** `launchctl list <label>`'s one-line, tab-separated `PID\tStatus\tLabel` — the SAME fact the
 *  W1-T301 rationale read by hand off a real box (`launchctl list` showing `-  0
 *  com.remudero.supervisor`, i.e. not running, last exit 0) to prove a healthy periodic one-shot
 *  was being mis-reported "not running" by a pid-presence-only check. `PID` is `-` when not
 *  currently running (interval jobs rest between ticks); `Status` is the job's LAST completed
 *  run's exit code (0 healthy, nonzero a real failure) — exactly the datum a resident-service pid
 *  check can never surface for a periodic job. A non-bootstrapped label, or any unparseable
 *  output, is caught/returned as "unknown" — never a throw, never a fabricated healthy `0`. */
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

/** Sensor-aware sibling of {@link queryLaunchdListStatus} — see
 *  {@link queryLaunchdServiceSensed}'s doc for why the status panel needs this and `rmd down`/
 *  `rmd up` (which have no caller for this function at all) do not. */
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
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
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
    execFileSync("git", ["merge-base", "--is-ancestor", base, head], { cwd: worktreePath, stdio: ["ignore", "pipe", "pipe"] });
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
export interface DoctorDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
  loadConfig?: () => Config;
  nowMs?: number;
  readLedgerLines?: (path: string) => Array<Record<string, unknown>>;
  loadPlan?: () => Plan | undefined;
  liveInflightRuns?: (dir: string) => LiveInflightRun[];
  readWorktreeBase?: (worktreePath: string) => string | null;
  readWorktreeHead?: (worktreePath: string) => string | undefined;
  isWorktreeBaseAncestor?: (worktreePath: string, base: string, head: string) => boolean | undefined;
  readMemInfo?: () => MemInfo;
  readDiskFreeBytes?: (path: string) => number | undefined;
  readDiskTotalBytes?: (path: string) => number | undefined;
  readPauseAgeMs?: (root: string, nowMs: number) => number | undefined;
  readGitLocks?: (root: string, nowMs: number) => Array<{ path: string; ageMs: number }>;
  readLockFiles?: (dir: string) => { locks: string[]; unreadableReason?: string };
  /** W1-T2332 — the `checkout-depth` arm's only measurement. Defaults to {@link readCheckoutDepth}. */
  readCheckoutDepth?: (cwd: string) => { shallow: boolean; commitCount: number } | undefined;
  /** R-49 — the `node-version-pin` arm's only measurement. Defaults to {@link readNvmrcVersion}. */
  readNvmrcVersion?: (root: string) => string | undefined;
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
  const live = (deps.liveInflightRuns ?? liveInflightRuns)(inflightDir);
  const lockRead = (deps.readLockFiles ?? readLockFilesFrom)(inflightDir);
  const lockFiles = lockRead.locks;
  const liveIds = new Set(live.map((r) => r.taskId));
  const dead = lockFiles.filter((f) => !liveIds.has(f));

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
    gitLocks: (deps.readGitLocks ?? readGitLocks)(repoRoot, nowMs),
    workerCount: 0,
    ...(((v) => (v === undefined ? {} : { checkoutDepth: v }))((deps.readCheckoutDepth ?? readCheckoutDepth)(repoRoot))),
    worktreeBases,
    // R-49: THIS process's own running interpreter, measured here — the caller — exactly like
    // every other injected reading above, never read inside buildDoctorReport itself.
    runningNodeVersion: process.versions.node,
    ...(((v) => (v === undefined ? {} : { nvmrcVersion: v }))((deps.readNvmrcVersion ?? readNvmrcVersion)(repoRoot))),
  });

  if (rest.includes("--json")) out(JSON.stringify({ worst: report.worst, checks: report.checks }, null, 2));
  else out(report.text);
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
export interface StatusDeps {
  loadConfig?: () => Config;
  queryService?: (service: ServiceName) => { running: boolean; pid: number | null; lastExitCode?: number; sensed?: boolean };
  resolveSupervisorIntervalS?: () => number | undefined;
  ledgerPathFor?: (config: Config) => string;
  repoRoot?: string;
  resolveOwnerRepo?: () => { owner: string; repo: string };
  buildBatchedGithub?: typeof buildBatchedGithub;
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

export async function statusCommand(rest: string[], deps: StatusDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const badArg = unknownArgError("status", rest, [], ["--json"]);
  if (badArg) {
    err(badArg + "\n" + (deps.usage ?? ""));
    return 2;
  }
  const config = (deps.loadConfig ?? loadConfig)();
  const uid = realUid();
  const queryService =
    deps.queryService ??
    ((service: ServiceName): { running: boolean; pid: number | null; lastExitCode?: number; sensed: boolean } => {
      const label = service === "daemon" ? DAEMON_LABEL : service === "serve" ? SERVE_LABEL : SUPERVISOR_LABEL;
      // W1-T2450: the SENSOR-AWARE query, not `queryLaunchdService` — this is the ONE caller
      // that must not fold "launchctl itself is unavailable" (every non-launchd host) into the
      // same `pid: null` a genuinely unloaded/stopped service returns (recon rationale Q1: the
      // panel "cannot tell 'I HAVE NO SENSOR HERE' from 'THE ANSWER IS NO'").
      const state = queryLaunchdServiceSensed(label, uid);
      // "running" means a live pid, not merely "loaded" — a bootstrapped-but-not-spawned job
      // answers "is it running" with no, exactly like an unloaded one.
      if (service !== "deploy-supervisor") return { running: state.pid !== null, pid: state.pid, sensed: state.sensed };
      // deploy-supervisor is an interval job: its own `pid`/`loaded` mean nothing between ticks
      // — `launchctl list`'s Status column is the fact that actually carries its health.
      const listStatus = queryLaunchdListStatusSensed(label);
      return {
        running: listStatus.pid !== null,
        pid: listStatus.pid,
        lastExitCode: listStatus.lastExitCode,
        sensed: listStatus.sensed,
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
  const buildBoard = deps.buildStatusBoard ?? buildStatusBoard;
  const render = deps.renderStatusBoardText ?? renderStatusBoardText;
  const ledgerPath = (deps.ledgerPathFor ?? ledgerPathFor)(config);
  const repoDir = deps.repoRoot ?? repoRoot;
  // GITHUB IS DECORATION, NEVER A GATE: `resolveOwnerRepo`/`buildBatchedGithub` can themselves
  // fail (no `git` remote, no network) — caught here so a status read NEVER throws on a bad
  // network day; the board degrades the rows that needed it to a stated unknown instead.
  let github: GitHub | undefined;
  if (deps.github === undefined) {
    try {
      const { owner, repo } = (deps.resolveOwnerRepo ?? resolveOwnerRepo)();
      github = (deps.buildBatchedGithub ?? buildBatchedGithub)(owner, repo);
    } catch {
      // Deliberate degrade, documented above the try: no git remote / no network reads exactly
      // like an unreachable gateway would, never a thrown status read.
      github = undefined;
    }
  } else {
    github = deps.github ?? undefined;
  }
  const model = buildBoard(config.root, ledgerPath, {
    queryService,
    repoDir,
    github,
    resolveHeadroomEnabled: () => resolveHeadroomEnabled(config),
    resolveSupervisorIntervalS,
  });
  // W1-T1235: GITHUB BUCKETS, read BESIDE the board's own HEADROOM section rather than folded
  // into it (design (v)) — a local ledger fold of `automerge.rate_limit_refused` rows, never a
  // new `gh api rate_limit` call, so this section costs `rmd status` no additional network
  // request.
  const readLedger = deps.readLedgerLines ?? ((pth: string) => readLedgerLines(pth) as Array<Record<string, unknown>>);
  const ghBucketRefusals = latestGhRateLimitRefusalsFromLedger(readLedger(ledgerPath));
  if (rest.includes("--json")) {
    out(JSON.stringify({ ...model, ghBucketRefusals }, null, 2));
  } else {
    out(`${render(model)}\n\n${renderGhBucketsSection(ghBucketRefusals)}`);
  }
  return 0;
}

// ── receiptCommand ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve which `owner/repo` a `rmd review`/`rmd receipt` targets: a `--repo <name>` or
 * `--repo <owner>/<name>` flag OVERRIDES the checkout's default (a bare name keeps the
 * default owner). Pure so the sandbox-gating path is unit-tested without a `gh` call.
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
 * The PR NUMBER `prArg` names, or `undefined` when it names something REST cannot address.
 *
 * `gh pr view` accepts a number, a URL, OR a bare branch name; `GET /repos/{o}/{r}/pulls/{n}`
 * accepts only a number. So the transport swap below is conditional on this resolving, and the
 * branch-name form deliberately keeps its existing `gh pr view` path — see {@link reviewViewArgs}.
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
 * THE ARGV `receiptCommand`/`reviewCommand` READ A PR WITH — REST when the PR is addressable by
 * number, `gh pr view` otherwise. Reuses {@link singlePrRestArgs}/{@link mapRestPr} (lib/review.ts)
 * so the four load-bearing translations (html_url→url, `body` null→"", headRefName
 * ""-not-undefined, auto_merge passthrough) are the ones already proven and tested there.
 */
export function reviewViewArgs(owner: string, repo: string, prArg: string): string[] {
  const n = reviewPrNumber(prArg);
  if (n !== undefined) return singlePrRestArgs(owner, repo, n);
  return ["pr", "view", prArg, "--repo", `${owner}/${repo}`, "--json", "headRefOid,headRefName,body,url,number"];
}

/** Seams for {@link receiptCommand} — defaulted to the real gateways; a test injects fakes so
 *  the command's own PR/task-id resolution + print path is exercisable with zero network. */
export interface ReceiptCommandDeps {
  gh?: (args: string[]) => unknown;
  config?: Config;
  /** W1-T2257: defaults to the real {@link resolveReceiptLedgerLines} — the archive∪live UNION,
   *  scoped to the steps `buildReceipt` reads, NEVER the live `ledger.ndjson` file alone (which
   *  rotation empties). A test overrides this to drive both the resolved-lines and the refused
   *  (`ok: false`) path without touching a real state dir. */
  resolveReceiptLedgerLines?: (stateDir: string) => ReceiptLedgerRead;
}

/**
 * `rmd receipt <pr>` (W1-T71, ratifies P17) — the deterministic in-toto-style run receipt,
 * printed for a merged (or open) PR. Resolves the task id from the PR body's trailer via
 * {@link reviewTaskIdFromBody} (the SAME #119-hardened extractor `rmd review` already uses —
 * never a second dialect), reads this checkout's ledger via {@link resolveReceiptLedgerLines}
 * (src/lib/receipt.ts) and hands the result to the pure {@link buildReceipt}. READ-ONLY: writes
 * no ledger line, no state file, posts nothing.
 *
 * A PR whose body carries no resolvable task id (a hand-opened PR, or one predating the
 * trailer contract) REFUSES rather than guessing — never fabricates a receipt for the wrong task.
 *
 * W1-T2257: the ledger read is the archive∪live UNION, never `ledger.ndjson` alone — that live
 * file is exactly the slice ledger rotation empties, keeping only the newest row per step and
 * archiving the rest. A refused union (see {@link resolveReceiptLedgerLines}) REFUSES here too
 * (non-zero exit, a named reason) rather than silently printing a receipt of null leaves that
 * would look indistinguishable from "this run never emitted anything".
 */
export async function receiptCommand(prArg: string, rest: string[] = [], deps: ReceiptCommandDeps = {}): Promise<number> {
  const badArg = unknownArgError("receipt", rest, ["--repo"]);
  if (badArg) {
    console.error(badArg);
    return 2;
  }
  const { owner, repo } = resolveReviewTarget(resolveOwnerRepo(), rest);
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
 * `rmd replay <since> <until> [--task <id>] [--step <prefix>]` (W1-T2296) — a deterministic,
 * plain-text narration of a LEDGER WINDOW, printed to stdout. Between two instants, what did the
 * fleet decide, in what order, and for what recorded reasons. Mirrors `receiptCommand`'s wiring:
 * this stays a thin shell around the pure {@link buildReplay} (src/lib/ledger-replay.ts), never
 * the business logic itself.
 *
 * READ-ONLY: no GitHub call, no write, no state mutation — resolves the corpus via
 * {@link resolveReplayLedgerLines}, the archive∪live UNION (never the live `ledger.ndjson` alone,
 * which rotation empties), and REFUSES rather than narrating a partial corpus.
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
 * W1-T163 (MARKER-AWARE by default): with NO `--since`, the window is the operator's own
 * `lib/last-seen.ts` marker — the SAME per-token marker the console's `GET /v1/status` recap
 * advances on a board view (lib/board.ts) — keyed off the write token's id (the write token is
 * the operator's real credential; a read-only caller never sends this digest). A first-ever send
 * (no marker yet) falls back to the pre-existing 24h-ago default. Sending (never `--dry-run`,
 * which previews without any side effect) then ADVANCES that same marker to now, so "push and
 * pull tell one story": whichever of a digest send or a console view happens next only reports
 * what's left since THIS send, never re-reporting what it already covered.
 *
 * An EXPLICIT `--since` is an operator-directed override/inspection tool — it builds/sends
 * exactly that window (old behavior, unchanged) and deliberately never touches the marker, so a
 * one-off "show me since <date>" never resets the shared push/pull window out from under it.
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
      console.log(buildDigest(ledgerPath, explicitSince, consoleUrl(config)));
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
      consoleUrl(config),
    );
    console.log(text);
    return 0;
  }

  const tokenId = hashToken(resolveServiceTokens(config.root).write);
  const store = createLastSeenStore(lastSeenPath(config.root));
  const nowIso = new Date().toISOString();
  if (rest.includes("--dry-run")) {
    console.log(buildMarkerAwareDigest(ledgerPath, store, tokenId, nowIso, consoleUrl(config)).text);
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
    consoleUrl(config),
  );
  console.log(text);
  return 0;
}

// ── learningsCommand / learningsExportCommand / learningsImportCommand ──────────────────────────

/**
 * `rmd learnings export|import` — the §6 transport (W1-T425): dispatches to
 * the export (sending) or import (receiving) subcommand, both thin CLI
 * wrappers over the pure functions in lib/learnings.ts that carry the actual
 * privacy/pin logic and are unit-tested independently (same split as
 * `rmd correct`'s wrapper over `applyCorrection`).
 */
export function learningsCommand(rest: string[], opts: { usage?: string } = {}): number {
  const sub = rest[0];
  if (sub === "export") return learningsExportCommand(rest.slice(1), { usage: opts.usage });
  if (sub === "import") return learningsImportCommand(rest.slice(1), { usage: opts.usage });
  console.error(
    `rmd learnings: unknown subcommand '${sub ?? ""}' — usage: rmd learnings export <out> | rmd learnings import <file> --pin <hash>\n` +
      (opts.usage ?? ""),
  );
  return 2;
}

/**
 * `rmd learnings export <out>` — the SENDING side (§6, W1-T425): collects
 * this checkout's ACTIVE, `share: public` project-layer entries, stamps
 * provenance (this repo, HEAD sha, export date), and writes the hash-pinned
 * bundle {@link buildExportBundle} produces to `<out>`. Refuses (writes
 * nothing) when zero entries opted in, or when a candidate matches the
 * leak-grep tripwire — either refusal is reported via the SAME
 * {@link buildExportBundle} this command is a thin wrapper over, never
 * reimplemented here.
 *
 * `opts.projectDir` is injectable (defaults to this checkout's real
 * `learnings/` directory) — same seam `ledgerGrepCommand` uses for its
 * state/ledger dirs — so a test can exercise the real success path over a
 * fixture corpus without ever writing `share: public` into this repo's own
 * committed shards. `opts.headSha` is injectable the same way {@link
 * readHeadShaForSummary} injects `exec` — the ONLY way to drive the
 * degrade-to-"unknown" catch arm from a test without an unreadable-git host.
 */
export function learningsExportCommand(
  rest: string[],
  opts: { projectDir?: string; headSha?: () => string; usage?: string } = {},
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
  const entries = loadLearningsCorpus(opts.projectDir ?? projectLearningsHome(repoRoot));
  let sourceRepo = "unknown";
  try {
    const { owner, repo } = resolveOwnerRepo();
    sourceRepo = `${owner}/${repo}`;
  } catch {
    // no origin remote configured — provenance degrades to "unknown", never a crash.
  }
  const readHeadSha =
    opts.headSha ?? (() => execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
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
 * `rmd learnings import <file> --pin <hash>` — the RECEIVING side (§6,
 * W1-T425): checks the bundle's own declared hash against the
 * operator-supplied `--pin` ({@link verifyBundlePin}) and, only on a match,
 * writes the bundle VERBATIM to the RMD-GLOBAL artifact path the injector
 * already reads ({@link globalArtifactPath}) — an import overwrites only its
 * own prior bundle there, never the project or user-overall layers. Import
 * deliberately does NOT re-derive the hash from `entries` itself; that
 * content-vs-hash tamper check is {@link loadGlobalArtifact}'s job, run
 * again the next time a prompt is assembled, so a bundle hand-edited AFTER
 * passing the pin check here is still refused there — the existing guard,
 * never a reimplementation of it.
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
 * `rmd trace <id>` — render the provenance chain (MASTER-PLAN §7B / Standing rule 17,
 * W1-T43): feedback → proposal PR → task(s) → run(s) → PR(s) → merge sha. `<id>` is
 * resolved as a TASK id first (an exact `plan/tasks.yaml` id — reverse direction, task
 * back to its origin); only if that fails is it read as a FEEDBACK id
 * (`plan/feedback/<id>.yaml` — forward direction, feedback out to every task it
 * produced). Neither resolving is a fail-loud usage error, not a silent empty chain.
 */
export async function traceCommand(
  rest: string[],
  opts: { usage?: string; commandSyntax?: string } = {},
): Promise<number> {
  const id = rest[0];
  const badArg = unknownArgError("trace", rest.slice(1), [], []);
  if (badArg) {
    console.error(badArg + "\n" + (opts.usage ?? ""));
    return 2;
  }
  if (!id) {
    console.error(`rmd trace: <id> is required — usage: ${opts.commandSyntax ?? "rmd trace <id>"}\n` + (opts.usage ?? ""));
    return 2;
  }

  const planPath = join(repoRoot, "plan", "tasks.yaml");
  const plan = loadPlan(planPath);
  const config = loadConfig();
  const { owner, repo: defaultRepo } = resolveOwnerRepo();
  const ledgerPath = ledgerPathFor(config);
  const ledgerLines = readLedgerLines(ledgerPath);

  const task = plan.byId.get(id);
  if (task) {
    const github = ghTraceGateway(owner, task.repo || defaultRepo);
    let feedbackEntry: FeedbackEntry | undefined;
    if (task.origin?.startsWith("feedback#")) {
      const feedbackId = task.origin.slice("feedback#".length);
      try {
        feedbackEntry = readFeedbackEntry(repoRoot, feedbackId);
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
    entry = readFeedbackEntry(repoRoot, id);
  } catch {
    console.error(
      `rmd trace: '${id}' is neither a known task id (${planPath}) nor a feedback entry (plan/feedback/${id}.yaml)`,
    );
    return 2;
  }
  const github = ghTraceGateway(owner, defaultRepo);
  const chain = traceForward(entry, { plan, ledgerLines, github });
  console.log(`### rmd trace ${id} (forward — feedback out to its task(s))`);
  console.log(renderTraceChain(chain));
  return 0;
}
