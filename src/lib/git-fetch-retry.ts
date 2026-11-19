/** A leaf module so worker.ts and self-sync.ts can share the fetch retry without an import cycle. */
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type GitRunner = (args: string[]) => string;
/** The same runner, off the event loop: a network `git fetch` on the daemon loop stalled it 49 s (E36).
 *  `signal` aborts at the fetch's bound; the real runner kills its child on it (W1-T5282).
 *  W1-T13664: `boundMs` names the bound a spawn helper stops the child at; a runner that forks its child directly has
 *  its signal for that and may ignore it. */
export type AsyncGitRunner = (args: string[], signal?: AbortSignal, env?: NodeJS.ProcessEnv, boundMs?: number) => Promise<string>;

/** W1-T4229 BACKSTOP: a hung fetch must not hold the checkout read open past the next re-check.
 *  Moved here from serve.ts so the daemon's awaited freshness reads share the number (W1-T5282). */
export const GATEWAY_FETCH_TIMEOUT_MS = 60_000;

/** W1-T5282 BACKSTOP: how long a fetch killed at its bound may ignore SIGTERM before SIGKILL. */
export const GIT_FETCH_KILL_GRACE_MS = 5_000;

/** SIGKILL for a child still running `graceMs` after its SIGTERM; one that already exited is left alone. */
export function killAfterGrace(child: Pick<ChildProcess, "exitCode" | "signalCode" | "kill">, graceMs = GIT_FETCH_KILL_GRACE_MS): void {
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, graceMs).unref();
}

/** W1-T5964: a bound timer this late was held by a blocked event loop, not by git. */
export const LATE_TIMER_SLACK_MS = 1_000;
/** W1-T5964: how long a late bound waits for a fetch whose exit may already be queued behind it. */
export const LATE_TIMER_GRACE_MS = 2_000;

/** One awaited git call ended at `timeoutMs` (W1-T5282): the signal aborts, and the call rejects whether or
 *  not the runner honours it, so a hung fetch reads as a failed one and never holds its awaiter forever.
 *  W1-T5964: a timer that fires late first waits `lateGraceMs`, since timers run before the poll phase
 *  that would deliver a finished child's exit; #9460's review was withheld for a fetch that had finished. */
export async function boundGitCall(
  git: AsyncGitRunner, args: string[], timeoutMs: number, lateGraceMs = LATE_TIMER_GRACE_MS, baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const controller = new AbortController();
  const traceDir = mkdtempSync(join(tmpdir(), "rmd-fetch-trace-"));
  const tracePath = join(traceDir, "events.json");
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      const fail = (lateMs: number): void => {
        const trace = readTrace(tracePath);
        reject(new Error(`git ${args.join(" ")} exceeded its ${timeoutMs}ms bound and was killed; ` +
          `last trace2 region: ${trace.region}; ` +
          `elapsed ${Math.round(performance.now() - started)}ms` +
          (trace.running ? `; still running: ${trace.running}` : "") +
          (lateMs > LATE_TIMER_SLACK_MS ? `; its timer fired ${Math.round(lateMs)}ms late (event loop blocked)` : "")));
        controller.abort();
      };
      timer = setTimeout(() => {
        const lateMs = performance.now() - started - timeoutMs;
        if (lateMs > LATE_TIMER_SLACK_MS) timer = setTimeout(() => fail(lateMs), lateGraceMs);
        else fail(lateMs);
      }, timeoutMs);
      // W1-T13664: a helper stops the child at the abort plus both graces, the time the direct path's SIGKILL would come.
      const boundMs = timeoutMs + lateGraceMs + GIT_FETCH_KILL_GRACE_MS;
      Promise.resolve().then(() => git(args, controller.signal, { ...baseEnv, GIT_TRACE2_EVENT: tracePath }, boundMs)).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    rmSync(traceDir, { recursive: true, force: true });
  }
}

/** The last region a fetch entered, and (W1-T5964) any child it started and never reaped: a fetch past its
 *  final region is waiting on one, e.g. the `git maintenance run --auto` it starts at exit. */
function readTrace(path: string): { region: string; running?: string } {
  let trace: string;
  try {
    trace = readFileSync(path, "utf8");
  } catch (error) {
    const reason = String(error);
    return { region: `unavailable (could not read trace: ${reason})` };
  }
  let last: string | undefined;
  let unavailable = "no region_enter event recorded";
  const children = new Map<string, string>();
  for (const line of trace.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { event?: string; category?: string; label?: string; sid?: string; child_id?: number; argv?: unknown } | null;
      if (event?.event === "region_enter" && typeof event.label === "string") {
        last = event.category ? `${event.category}/${event.label}` : event.label;
      }
      const child = `${event?.sid}#${event?.child_id}`;
      if (event?.event === "child_start") {
        children.set(child, Array.isArray(event.argv) ? event.argv.join(" ") : `(child ${event.child_id}, argv unrecorded)`);
      } else if (event?.event === "child_exit") children.delete(child);
    } catch (error) {
      const reason = String(error);
      unavailable = `could not parse trace event: ${reason}`;
    }
  }
  const running = [...children.values()].join(", ");
  return { region: last ?? `unavailable (${unavailable})`, ...(running ? { running } : {}) };
}

function fetchArgs(scope: "all" | "main"): string[] {
  return scope === "main"
    ? ["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]
    : ["fetch", "--quiet", "origin"];
}

const REF_LOCK_FAILURE = /cannot lock ref|unable to update local ref/i;

function isRefLockFailure(error: unknown): boolean {
  const e = error as { stderr?: unknown; message?: unknown } | null;
  return REF_LOCK_FAILURE.test(`${String(e?.stderr ?? "")}\n${String(e?.message ?? error)}`);
}

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function timerSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `git fetch origin`, retried briefly on a transient ref lock (#8017 lost ~1h to one); anything else throws. */
export function fetchOriginRetryingRefLock(git: GitRunner, sleep: (ms: number) => void = blockingSleep, attempts = 3, scope: "all" | "main" = "all"): void {
  const args = fetchArgs(scope);
  for (let attempt = 1; ; attempt++) {
    try {
      git(args);
      return;
    } catch (error) {
      let failure = error;
      // W1-T13409: the first failure only. A GitRunner takes no time bound, so the repair's calls run as its fetch does.
      if (attempt === 1) {
        try {
          retryAfterDanglingRefRepair((a) => git(a), args, error, () => git(args));
          return;
        } catch (after) {
          // The retry's failure, or the original error: the ref lock test reads that one.
          failure = after;
        }
      }
      if (attempt >= attempts || !isRefLockFailure(failure)) throw failure;
      sleep(1_000 * attempt);
    }
  }
}

/** {@link fetchOriginRetryingRefLock} with an awaited fetch and a timer backoff: same retries, same throws.
 *  Each attempt is bounded by `timeoutMs`; one past it throws like any other failed fetch (W1-T5282). */
export async function fetchOriginRetryingRefLockAsync(
  git: AsyncGitRunner,
  sleep: (ms: number) => Promise<void> = timerSleep,
  attempts = 3,
  timeoutMs = GATEWAY_FETCH_TIMEOUT_MS,
  scope: "all" | "main" = "all",
): Promise<void> {
  const args = fetchArgs(scope);
  for (let attempt = 1; ; attempt++) {
    try {
      await boundGitCall(git, args, timeoutMs);
      return;
    } catch (error) {
      let failure = error;
      if (attempt === 1) {
        try {
          await retryAfterDanglingRefRepairAsync((a, ms) => boundGitCall(git, a, ms, undefined, repairEnv()), args, error,
            () => boundGitCall(git, args, timeoutMs));
          return;
        } catch (after) {
          // The retry's failure, or the original error: the ref lock test reads that one.
          failure = after;
        }
      }
      if (attempt >= attempts || !isRefLockFailure(failure)) throw failure;
      await sleep(1_000 * attempt);
    }
  }
}

// ── W1-T13409: a fetch that meets a ref naming a missing object repairs that ref and retries once. ──

/** BACKSTOP: at most this many dangling tracking refs are repaired in one call; more are reported only (2026-11-17 had 1). */
const DANGLING_REF_MAX_REFS = 16;
/** BACKSTOP: the listing is killed after this (one pass over 9,796 refs took 0.71 s on the loaded host). */
const DANGLING_REF_LIST_TIMEOUT_MS = 30_000;
/** BACKSTOP: the repair pass is killed after this, the bound the hand repair used. */
const DANGLING_REF_REPAIR_TIMEOUT_MS = 120_000;
/** BACKSTOP: a listing holds one line per ref; a clone of 9,796 refs prints about 1 MB. */
export const DANGLING_REF_MAX_BUFFER = 64 * 1024 * 1024;

interface DanglingRefBounds { maxRefs: number; listMs: number; repairMs: number }
const DANGLING_REF_BOUNDS: DanglingRefBounds = {
  maxRefs: DANGLING_REF_MAX_REFS, listMs: DANGLING_REF_LIST_TIMEOUT_MS, repairMs: DANGLING_REF_REPAIR_TIMEOUT_MS,
};

/** One git call of the repair, killed at `timeoutMs` when the runner can. */
export type RepairGit = (args: string[], timeoutMs: number) => string;
export type RepairGitAsync = (args: string[], timeoutMs: number) => Promise<string>;
export type DanglingRefRepairLog = (step: string, extra: Record<string, unknown>) => void;

const stderrRepairLog: DanglingRefRepairLog = (step, extra) => console.error(JSON.stringify({ event: step, ...extra }));
let repairLog: DanglingRefRepairLog = stderrRepairLog;

/** Where the repair rows go; a process sets its ledger log once (setWorkerEntryLog's shape). `keepSet` leaves a
 *  log already set, since the daemon runs `rmd fix` in its own process. */
export function setDanglingRefRepairLog(log: DanglingRefRepairLog | undefined, keepSet = false): void {
  if (keepSet && repairLog !== stderrRepairLog) return;
  repairLog = log ?? stderrRepairLog;
}

/** The property a repaired-at error carries: what was found. An error with it is never repaired again. */
const FINDING = "danglingRefRepair";
interface DanglingRefFinding { dangling: string[]; repairError?: unknown; retried?: boolean }

const DANGLING_REF_FAILURE = /bad object refs\/|did not send all necessary objects/;
const REPAIRED = "git.dangling_ref_repaired";
const UNREPAIRED = "git.dangling_ref_unrepaired";

/** The env of a repair call: no object directory of a caller's own. */
function repairEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  return env;
}

function isFetchArgv(args: readonly string[]): boolean {
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "-C" || arg === "-c") at++;
    else if (!arg.startsWith("-")) return arg === "fetch";
  }
  return false;
}

function isDanglingRefFailure(args: readonly string[], error: unknown): error is Record<string, unknown> {
  if (typeof error !== "object" || error === null || FINDING in error || !isFetchArgv(args)) return false;
  const e = error as { stderr?: unknown; message?: unknown };
  return DANGLING_REF_FAILURE.test(`${String(e.stderr ?? "")}\n${String(e.message ?? "")}`);
}

function reason(error: unknown): string {
  return String((error as { message?: unknown } | null)?.message ?? error).slice(0, 500);
}

type RepairCall = { args: string[]; timeoutMs: number };
type RepairAnswer = { out: string } | { error: unknown };
interface ListedRef { id: string; ref: string }

/** Lists the refs, keeps those whose own object is missing, and repairs the tracking ones: one listing, one pass.
 *  Yields each git call; returns whether every dangling ref was repaired, so the caller retries once. */
function* danglingRefRepairPlan(error: Record<string, unknown>, bounds: DanglingRefBounds): Generator<RepairCall, boolean, RepairAnswer> {
  const finding: DanglingRefFinding = { dangling: [] };
  error[FINDING] = finding;
  const until = (start: number, ms: number): number => Math.max(1, Math.round(start + ms - performance.now()));
  const listed = performance.now();
  const dir = yield { args: ["rev-parse", "--path-format=absolute", "--git-common-dir"], timeoutMs: bounds.listMs };
  const clone = "out" in dir ? dir.out.trim() : "unknown";
  const failed = (refs: readonly (string | null)[], cause: unknown): false => {
    finding.repairError = cause;
    for (const ref of refs) repairLog(UNREPAIRED, { clone, ref, why: "repair_failed", error: reason(cause) });
    return false;
  };
  const list = yield { args: ["for-each-ref", "--format=%(objectname) %(refname) %(symref)"], timeoutMs: until(listed, bounds.listMs) };
  if (!("out" in list)) return failed([null], list.error);
  const refs: ListedRef[] = [];
  for (const line of list.out.split("\n")) {
    const [id, ref, symref] = line.split(" ");
    if (id && ref && !symref) refs.push({ id, ref });
  }
  const ids = [...new Set(refs.map((r) => r.id))];
  const check = yield {
    args: ["rev-list", "--objects", "--no-walk", "--ignore-missing", "--filter=tree:0", ...ids], timeoutMs: until(listed, bounds.listMs),
  };
  if (!("out" in check)) return failed([null], check.error);
  const present = new Set(check.out.split("\n").map((line) => line.split(" ")[0]));
  const dangling = refs.filter((r) => !present.has(r.id));
  finding.dangling = dangling.map((r) => r.ref);
  const tracking: Array<ListedRef & { remote: string; branch: string }> = [];
  for (const r of dangling) {
    const m = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(r.ref);
    if (m) tracking.push({ ...r, remote: m[1]!, branch: m[2]! });
    else repairLog(UNREPAIRED, { clone, ref: r.ref, why: "not_a_tracking_ref" });
  }
  if (dangling.length === 0) {
    repairLog(UNREPAIRED, { clone, ref: null, why: "no_dangling_ref" });
    return false;
  }
  if (tracking.length > bounds.maxRefs) {
    repairLog(UNREPAIRED, { clone, ref: tracking[0]!.ref, why: "over_the_bound", count: tracking.length });
    return false;
  }
  if (tracking.length === 0) return false;
  const start = performance.now();
  let all = tracking.length === dangling.length;
  for (const remote of [...new Set(tracking.map((r) => r.remote))]) {
    const group = tracking.filter((r) => r.remote === remote);
    const heads = yield { args: ["ls-remote", remote, ...group.map((r) => `refs/heads/${r.branch}`)], timeoutMs: until(start, bounds.repairMs) };
    if (!("out" in heads)) {
      all = failed(group.map((r) => r.ref), heads.error);
      continue;
    }
    const has = new Set(heads.out.split("\n").map((line) => line.split("\t")[1]));
    const kept = group.filter((r) => has.has(`refs/heads/${r.branch}`));
    if (kept.length > 0) {
      const fetched = yield {
        args: ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "fetch", "--refetch", "--no-tags", remote,
          ...kept.map((r) => `+refs/heads/${r.branch}:${r.ref}`)],
        timeoutMs: until(start, bounds.repairMs),
      };
      // The removals wait for the refetch: a failed refetch leaves every ref as it was.
      if (!("out" in fetched)) {
        all = failed(group.map((r) => r.ref), fetched.error);
        continue;
      }
      for (const r of kept) repairLog(REPAIRED, { clone, ref: r.ref, how: "refetched", ms: Math.round(performance.now() - start) });
    }
    for (const r of group.filter((g) => !kept.includes(g))) {
      // The old value makes the delete a compare-and-swap: a ref repaired meanwhile is left alone.
      const removed = yield { args: ["update-ref", "-d", r.ref, r.id], timeoutMs: until(start, bounds.repairMs) };
      if ("out" in removed) repairLog(REPAIRED, { clone, ref: r.ref, how: "removed", ms: Math.round(performance.now() - start) });
      else all = failed([r.ref], removed.error);
    }
  }
  return all;
}

function markRetried(error: unknown): void {
  if (typeof error === "object" && error !== null && !(FINDING in error)) {
    (error as Record<string, unknown>)[FINDING] = { dangling: [], retried: true } satisfies DanglingRefFinding;
  }
}

/** The fetch `args` failed with `error`: when git names a ref whose object is missing, repair it and run `retry` once;
 *  otherwise throw `error` itself. A failed repair throws `error` with what was found on its `danglingRefRepair`. */
export function retryAfterDanglingRefRepair<T>(
  git: RepairGit, args: readonly string[], error: unknown, retry: () => T, bounds: DanglingRefBounds = DANGLING_REF_BOUNDS,
): T {
  if (!isDanglingRefFailure(args, error)) throw error;
  const plan = danglingRefRepairPlan(error, bounds);
  let step = plan.next();
  while (!step.done) {
    let answer: RepairAnswer;
    try {
      answer = { out: git(step.value.args, step.value.timeoutMs) };
    } catch (failure) {
      answer = { error: failure };
    }
    step = plan.next(answer);
  }
  if (!step.value) throw error;
  try {
    return retry();
  } catch (after) {
    markRetried(after);
    throw after;
  }
}

/** {@link retryAfterDanglingRefRepair} with awaited git calls. */
export async function retryAfterDanglingRefRepairAsync<T>(
  git: RepairGitAsync, args: readonly string[], error: unknown, retry: () => Promise<T>, bounds: DanglingRefBounds = DANGLING_REF_BOUNDS,
): Promise<T> {
  if (!isDanglingRefFailure(args, error)) throw error;
  const plan = danglingRefRepairPlan(error, bounds);
  let step = plan.next();
  while (!step.done) {
    let answer: RepairAnswer;
    try {
      answer = { out: await git(step.value.args, step.value.timeoutMs) };
    } catch (failure) {
      answer = { error: failure };
    }
    step = plan.next(answer);
  }
  if (!step.value) throw error;
  try {
    return await retry();
  } catch (after) {
    markRetried(after);
    throw after;
  }
}
