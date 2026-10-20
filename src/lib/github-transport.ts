import { execFileSync, spawn } from "node:child_process";
import { boundChildByLoopTime, childLoopBound, execFileLoopBounded } from "./loop-bounded-child.js";
import type { ChildProcess, ExecFileSyncOptions, ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync, constants as fsConstants, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { clockFromMillisFn, loopAvailableDeadline, systemClock } from "./clock.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { RmdError } from "./errors.js";
import { refreshInstallationToken } from "./github-app.js";
import { sameHost } from "./host-identity.js";
import { deriveLedgerActor, type LedgerActor } from "./ledger.js";
import { LIVE_WRITE_SENTINEL_TOKEN, LiveWriteBlockedError } from "./live-write-guard.js";

/** PRIMARY CONTROL: every GitHub CLI invocation gets a wall-clock ceiling unless a caller narrows it. */
export const DEFAULT_GH_CALL_TIMEOUT_MS = 60_000;

const DEFAULT_GH_MAX_BUFFER = 1 << 24;

export interface GhRateLimitReading {
  remaining?: number;
  used?: number;
  limit?: number;
  reset?: number;
  resource?: string;
}

function ghRateLimitHeaderField(headerBlock: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}:\\s*(.+)$`, "im").exec(headerBlock);
  return match?.[1]?.trim();
}

export function parseGhRateLimitHeaders(headerBlock: string): GhRateLimitReading {
  const numberField = (name: string): number | undefined => {
    const raw = ghRateLimitHeaderField(headerBlock, name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    remaining: numberField("X-Ratelimit-Remaining"),
    used: numberField("X-Ratelimit-Used"),
    limit: numberField("X-Ratelimit-Limit"),
    reset: numberField("X-Ratelimit-Reset"),
    resource: ghRateLimitHeaderField(headerBlock, "X-Ratelimit-Resource"),
  };
}

/** BACKSTOP: fallback bucket identity when GitHub omits or hides the rate-limit resource header. */
export const GH_RATE_LIMIT_BUCKET_UNKNOWN = "unknown";

export interface GhRateLimitRefusal {
  bucket: string;
  resetsAt: string;
  operation: string;
}

export function ghRateLimitRefusalFromReading(
  reading: GhRateLimitReading,
  operation: string,
): GhRateLimitRefusal | undefined {
  if (reading.remaining !== 0) return undefined;
  // W1-T2897: routed through the Clock port's millis adapter rather than a bare constructor call
  // here, so this file's own text carries none of the four legacy clock shapes the census in
  // test/clock-signature-census.test.ts holds — src/lib/clock.ts owns the one Date construction.
  const resetMs = reading.reset !== undefined ? reading.reset * 1000 : undefined;
  return {
    bucket: reading.resource ?? GH_RATE_LIMIT_BUCKET_UNKNOWN,
    resetsAt: resetMs !== undefined ? clockFromMillisFn(() => resetMs).iso() : GH_RATE_LIMIT_BUCKET_UNKNOWN,
    operation,
  };
}

export function ghRateLimitRefusalUnknown(operation: string): GhRateLimitRefusal {
  return { bucket: GH_RATE_LIMIT_BUCKET_UNKNOWN, resetsAt: GH_RATE_LIMIT_BUCKET_UNKNOWN, operation };
}

export function splitGhHeaderBlock(out: string, slurp = false): { headers: string; body: string } {
  if (slurp) {
    // gh opens the outer slurp array BEFORE printing each included HTTP header block. Preserve
    // every page and its separators; the LAST response carries the remaining quota after them.
    let headers = "";
    const body = out.replace(/(^|[\[,\r\n])(HTTP\/[0-9.]+ [0-9]{3}[^\r\n]*\r?\n(?:[A-Za-z0-9-]+:[^\r\n]*\r?\n)*\r?\n)/g,
      (_match, prefix: string, block: string) => { headers = block.trimEnd(); return prefix; });
    return { headers, body };
  }
  if (!out.startsWith("HTTP/")) return { headers: "", body: out };
  const sep = out.match(/\r?\n\r?\n/);
  if (!sep || sep.index === undefined) return { headers: "", body: out };
  return { headers: out.slice(0, sep.index), body: out.slice(sep.index + sep[0].length) };
}

// SIGKILL not SIGTERM: a sync spawn's one `timeout` cannot escalate (W1-T4446, cf. review.ts).
export const DEFAULT_GH_SYNC_KILL_SIGNAL: NodeJS.Signals = "SIGKILL";

export function ghOptionsWithDefaultTimeout<T extends object>(
  opts: T & { timeout?: number; maxBuffer?: number; killSignal?: NodeJS.Signals | number },
): T & { timeout: number; maxBuffer: number; killSignal: NodeJS.Signals | number } {
  return {
    ...opts,
    maxBuffer: opts.maxBuffer ?? DEFAULT_GH_MAX_BUFFER,
    timeout: opts.timeout ?? DEFAULT_GH_CALL_TIMEOUT_MS,
    killSignal: opts.killSignal ?? DEFAULT_GH_SYNC_KILL_SIGNAL,
  };
}

/** W1-T4805: true when `file` resolves (through `env.PATH` when it is a bare name) to an executable
 *  under the OS temp dir: a test's own PATH-stubbed CLI (test/helpers/gh-shim.ts, or the shared
 *  refusing stub in test/setup/tmp-hygiene.ts). Such a script cannot reach GitHub. */
function resolvesToTmpdirStub(file: string, env: NodeJS.ProcessEnv): boolean {
  const dirs = file.includes("/") ? [""] : (env.PATH ?? "").split(":").filter((d) => d.length > 0);
  for (const dir of dirs) {
    const candidate = dir === "" ? file : join(dir, file);
    try {
      accessSync(candidate, fsConstants.X_OK);
    } catch {
      continue; // not in this PATH entry; a spawn would try the next one
    }
    return candidate.startsWith(tmpdir() + sep);
  }
  return false; // nothing resolves: not a stub, and the spawn would fail anyway
}

/**
 * W1-T4805: refuse to spawn the real CLI while its effective token is the test-runner sentinel
 * ({@link LIVE_WRITE_SENTINEL_TOKEN}). Throws {@link LiveWriteBlockedError} naming the command, so
 * the refusal never degrades into the CLI's own 401. `env` is the env the child will receive. A CLI
 * that resolves into the OS temp dir is a test's own stub and is left to run: it is its own containment.
 */
export function refuseSentinelGhToken(file: string, args: readonly string[], env: NodeJS.ProcessEnv | undefined): void {
  const e = env ?? process.env;
  if (e.GH_TOKEN !== LIVE_WRITE_SENTINEL_TOKEN && e.GITHUB_TOKEN !== LIVE_WRITE_SENTINEL_TOKEN) return;
  if (basename(file) !== "gh") return; // ghExecFile also carries non-gh executables (a test's node child)
  if (resolvesToTmpdirStub(file, e)) return;
  throw new LiveWriteBlockedError(
    "gh-transport",
    `\`gh ${args.slice(0, 4).join(" ")}\` carries the test-runner sentinel token (W1-T4805: the suite ` +
      `cannot reach live GitHub, read or write; put a PATH-stubbed gh from test/helpers/gh-shim.ts first on ` +
      `PATH, or use an injected gateway)`,
  );
}

export function ghExec(args: string[], opts: ExecFileSyncOptionsWithStringEncoding): string;
export function ghExec(args: string[], opts?: ExecFileSyncOptions): Buffer;
export function ghExec(args: string[], opts: ExecFileSyncOptions = {}): string | Buffer {
  // W1-T3297: this overload always spawns the real `gh`, so the cadence floor always applies.
  applyGhReadCadence(args);
  return ghExecFile("gh", args, opts) as string | Buffer;
}

export function ghExecFile(file: string, args: string[], opts: ExecFileSyncOptionsWithStringEncoding): string;
export function ghExecFile(file: string, args: string[], opts?: ExecFileSyncOptions): Buffer;
export function ghExecFile(file: string, args: string[], opts: ExecFileSyncOptions = {}): string | Buffer {
  refuseSentinelGhToken(file, args, opts.env);
  return execFileSync(file, args, ghOptionsWithDefaultTimeout(opts)) as string | Buffer;
}

export function ghJson(
  args: string[],
  onRateLimit?: (reading: GhRateLimitReading) => void,
  exec: (
    file: string,
    execArgs: string[],
    opts: { encoding: "utf8"; maxBuffer: number; timeout: number; killSignal?: NodeJS.Signals | number },
  ) => string = execFileSync,
): unknown {
  // W1-T3297: an injected `exec` reaches no network, so pacing it would spend a shared window
  // on a call that never touched the limiter.
  if (exec === execFileSync) {
    refuseSentinelGhToken("gh", args, undefined);
    applyGhReadCadence(args);
  }
  const isApiCall = args[0] === "api";
  const execArgs = isApiCall ? [...args, "-i"] : args;
  const out = exec("gh", execArgs, {
    encoding: "utf8",
    maxBuffer: DEFAULT_GH_MAX_BUFFER,
    timeout: DEFAULT_GH_CALL_TIMEOUT_MS,
    killSignal: DEFAULT_GH_SYNC_KILL_SIGNAL,
  });
  if (!isApiCall) return parseGhJsonBody(args, out);
  const { headers, body } = splitGhHeaderBlock(out, args.includes("--slurp"));
  if (onRateLimit) onRateLimit(parseGhRateLimitHeaders(headers));
  return parseGhJsonBody(args, body);
}

/** The real `gh` executor. W1-T9651: `timeout` is a LOOP-AVAILABLE budget, never execFile's own timer, which after a
 *  held loop destroys the unread stdout of a read that already finished and RESOLVES it empty. */
const execFileAsync = (
  file: string,
  args: readonly string[],
  opts: { encoding: BufferEncoding; maxBuffer: number; timeout: number },
): Promise<{ stdout: string; stderr: string }> => execFileLoopBounded(file, args, opts);

export type GhAsyncExecutor = typeof execFileAsync;

/** Grace past a wedged `gh` child's SIGTERM before SIGKILL (W1-T4446). */
export const DEFAULT_GH_KILL_GRACE_MS = 5_000;

function logGhKillEscalated(args: readonly string[], warn: (line: string) => void): void {
  warn(
    `gh.kill_escalated (W1-T4446): gh ${args[0] ?? ""} ignored SIGTERM and was sent SIGKILL ` +
      `${DEFAULT_GH_KILL_GRACE_MS}ms after its timeout elapsed`,
  );
}

/** Escalates a `gh` child surviving `execAsync`'s SIGTERM to SIGKILL, via `promisify(execFile)`'s `.child` (W1-T4446). */
export function withGhKillEscalation<T extends { stdout: string; stderr: string }>(
  execPromise: Promise<T> & { child?: ChildProcess },
  args: readonly string[],
  timeoutMs: number,
  opts: { graceMs?: number; warn?: (line: string) => void } = {},
): Promise<T> {
  const child = execPromise.child;
  if (child === undefined || !(timeoutMs > 0)) return execPromise;
  const graceMs = opts.graceMs ?? DEFAULT_GH_KILL_GRACE_MS;
  const warn = opts.warn ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const primary = childLoopBound(child);
  if (primary !== undefined && graceMs > 0) {
    primary.escalateAfter(graceMs, () => logGhKillEscalated(args, warn));
    return execPromise;
  }
  // Compatibility for injected/legacy execFile promises whose primary is not owned by the helper.
  // W1-T9651: loop-available time, so a held loop never escalates a child whose exit is already waiting.
  const clearEscalation = loopAvailableDeadline(systemClock, timeoutMs + graceMs, () => {
    if (child.exitCode === null && child.signalCode === null) {
      logGhKillEscalated(args, warn);
      child.kill("SIGKILL");
    }
  });
  execPromise.then(clearEscalation, clearEscalation);
  return execPromise;
}

/**
 * ONE IN-FLIGHT READ PER EXACT REQUEST. The daemon, review lane, and console can all wake for the
 * same head at once; without this map each caller reaches the cadence gate independently and the
 * first allowed caller still leaves a burst of identical subprocesses queued behind it. This is
 * deliberately transport-local: every async consumer gets the protection without having to agree
 * on a higher-level cache, and a rejected read is removed in `finally` so an outage never poisons
 * later attempts.
 */
const asyncReadInFlight = new Map<string, Promise<unknown>>();

function ghArgsAreCoalescibleRead(args: readonly string[]): boolean {
  if (args[0] === "pr") return ["view", "list", "checks"].includes(args[1] ?? "");
  if (args[0] !== "api") return false;
  let explicitGet = false;
  let hasPayload = false;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-X" || arg === "--method" || arg.startsWith("-X") || arg.startsWith("--method=")) {
      const method = arg === "-X" || arg === "--method" ? args[++i]
        : arg.startsWith("-X") ? arg.slice(2).replace(/^=/, "") : arg.slice("--method=".length);
      if (method !== "GET") return false;
      explicitGet = true;
    } else if (/^(?:-[fF]|--(?:raw-field|field|input))$/.test(arg)) {
      hasPayload = true;
      i += 1;
    } else if (/^(?:-[fF].|--(?:raw-field|field|input)=)/.test(arg)) {
      hasPayload = true;
    } else if (/^(?:-[Hqpt]|--(?:header|jq|preview|template|hostname|cache))$/.test(arg)) {
      i += 1;
    } else if (arg.startsWith("-") && !/^(?:-i|--(?:include|paginate|slurp|silent|verbose|allow-escape-sequences)|--(?:header|jq|preview|template|hostname|cache)=.*|-[Hqpt].+)$/.test(arg)) {
      return false;
    }
  }
  return explicitGet || !hasPayload;
}

/** A successful `gh` process whose JSON response cannot be read is a transport failure, not a
 * worker/parser failure. The operation is deliberately reduced to the command family so an error
 * can be logged without carrying request arguments, headers, tokens, or response contents. */
export class GhJsonUnreadableResponseError extends RmdError {
  readonly reasonClass = "gh_json_unreadable_response" as const;
  readonly operation: "api" | "command";
  readonly cause: unknown;

  constructor(operation: "api" | "command", cause: unknown) {
    super("github", 1, `gh ${operation} response body was unreadable`, { operation });
    this.name = "GhJsonUnreadableResponseError";
    this.operation = operation;
    this.cause = cause;
  }
}

function parseGhJsonBody(args: string[], body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new GhJsonUnreadableResponseError(args[0] === "api" ? "api" : "command", cause);
  }
}

export async function ghJsonAsync(
  args: string[],
  execAsync: typeof execFileAsync = execFileAsync,
  /** W1-T6591: {@link ghJson}'s rate-limit reading, from the response headers of an `api` read. */
  onRateLimit?: (reading: GhRateLimitReading) => void,
): Promise<unknown> {
  const withHeaders = onRateLimit !== undefined && args[0] === "api";
  const execArgs = withHeaders ? [...args, "-i"] : args;
  const stdout = await ghStdoutAsync(args, execArgs, execAsync);
  if (!withHeaders) return parseGhJsonBody(args, stdout);
  const { headers, body } = splitGhHeaderBlock(stdout, args.includes("--slurp"));
  onRateLimit(parseGhRateLimitHeaders(headers));
  return parseGhJsonBody(args, body);
}

async function ghStdoutAsync(args: string[], execArgs: string[], execAsync: typeof execFileAsync): Promise<string> {
  const run = async (): Promise<string> => (await withGhKillEscalation(
    execAsync("gh", execArgs, {
      encoding: "utf8",
      maxBuffer: DEFAULT_GH_MAX_BUFFER,
      timeout: DEFAULT_GH_CALL_TIMEOUT_MS,
    }),
    execArgs,
    DEFAULT_GH_CALL_TIMEOUT_MS,
  )).stdout;
  // Injected executors are test/offline seams and may have independent side effects, so only the
  // real `gh` transport participates in production single-flight coalescing.
  if (execAsync !== execFileAsync) return run();
  const key = ghArgsAreCoalescibleRead(args) ? JSON.stringify(execArgs) : undefined;
  const existing = key === undefined ? undefined : asyncReadInFlight.get(key) as Promise<string> | undefined;
  if (existing) return existing;
  const request = (async (): Promise<string> => {
    // Keep the async poll path behind the same transport floor as ghJson/ghExec. The daemon and
    // review handlers enforce RMD_GH_TRANSPORT_FLOOR for their lifetime, but without this call the
    // CI/review wait loops bypassed that boundary entirely and could emit a rapid read burst.
    refuseSentinelGhToken("gh", args, undefined);
    await applyGhReadCadenceAsync(args);
    return run();
  })();
  if (key === undefined) return request;
  asyncReadInFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (asyncReadInFlight.get(key) === request) asyncReadInFlight.delete(key);
  }
}

/** Bounded, paced async `gh` transport for endpoints whose response is plain text (for example
 * Actions job logs). Unlike {@link ghJsonAsync}, this deliberately preserves the response as text
 * and never attempts JSON parsing. */
export async function ghTextAsync(
  args: string[],
  opts: { maxBuffer?: number; timeout?: number } = {},
  execAsync: GhAsyncExecutor = execFileAsync,
): Promise<string> {
  const maxBuffer = opts.maxBuffer ?? DEFAULT_GH_MAX_BUFFER;
  const timeout = opts.timeout ?? DEFAULT_GH_CALL_TIMEOUT_MS;
  const read = async (): Promise<string> => {
    const { stdout } = await withGhKillEscalation(execAsync("gh", args, { encoding: "utf8", maxBuffer, timeout }), args, timeout);
    return stdout;
  };

  // An injected executor is an offline seam; only the real `gh` process spends cadence and joins
  // same-request reads. Prefix the key so a concurrent JSON reader can never receive raw text.
  if (execAsync !== execFileAsync) return read();
  const key = ghArgsAreCoalescibleRead(args) ? `text:${JSON.stringify(args)}:${maxBuffer}:${timeout}` : undefined;
  const existing = key === undefined ? undefined : asyncReadInFlight.get(key) as Promise<string> | undefined;
  if (existing) return existing;
  const request = (async (): Promise<string> => {
    refuseSentinelGhToken("gh", args, undefined);
    await applyGhReadCadenceAsync(args);
    return read();
  })();
  if (key === undefined) return request;
  asyncReadInFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (asyncReadInFlight.get(key) === request) asyncReadInFlight.delete(key);
  }
}

/**
 * W1-T5836: a plain-text `gh` response handed to `onLine` one line at a time, never held whole —
 * the Actions job log, whose coverage-shard body outgrew every `maxBuffer` it was given (ENOBUFS).
 * Lines split on "\n" exactly as `String.split` would, the last segment included. Same sentinel
 * refusal, read cadence and kill escalation as {@link ghTextAsync}; a throwing `onLine` ends the
 * read with that error.
 */
export async function ghLinesAsync(
  args: string[],
  onLine: (line: string) => void,
  opts: { timeout?: number } = {},
): Promise<void> {
  const timeout = opts.timeout ?? DEFAULT_GH_CALL_TIMEOUT_MS;
  refuseSentinelGhToken("gh", args, undefined);
  await applyGhReadCadenceAsync(args);
  const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
  // Not spawn's own `timeout`: a child that never started never exits, and that timer then holds the process open.
  // W1-T9651: bounded by loop-available time, so a held loop never kills a log that already finished.
  const bound = boundChildByLoopTime(child, timeout);
  let partial = "";
  let stderr = "";
  let refused: unknown;
  const emit = (lines: string[]): void => {
    try {
      for (const line of lines) if (refused === undefined) onLine(line);
    } catch (err) {
      // Carried, not dropped: the close handler rejects the read with this error.
      refused = err;
      child.kill();
    }
  };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    emit(lines);
  });
  // BACKSTOP: only the end of stderr is kept, enough to carry the CLI's own one-line refusal.
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => void (stderr = (stderr + chunk).slice(-4096)));
  const read = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    child.on("error", (err) => {
      bound.cancel();
      reject(err);
    });
    child.on("close", (code, signal) => {
      bound.cancel();
      if (bound.timedOut) return reject(bound.timeoutError(`gh ${args.slice(0, 2).join(" ")}`, { signal, exitCode: code, stderr }));
      if (code === 0) emit([partial]);
      if (refused !== undefined) return reject(refused);
      if (code === 0) return resolve({ stdout: "", stderr });
      const cause = signal ? `was killed by ${signal}` : `failed with exit code ${code}`;
      reject(new Error(`gh ${args.slice(0, 2).join(" ")} ${cause}\n${stderr.trim()}`));
    });
  }) as Promise<{ stdout: string; stderr: string }> & { child?: typeof child };
  read.child = child;
  await withGhKillEscalation(read, args, timeout);
}

export const DEFAULT_GH_PACE_MIN_GAP_MS = 1_500;

/** PRIMARY CONTROL: a rate-limit signal widens pacing until a later clean result narrows it again. */
export const DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS = 10_000;

export interface GhBudgetReading {
  remaining: number;
  limit: number;
  resource: string;
}

export const DEFAULT_GH_PACE_LOW_WATER_FRACTION = 0.1;
export const DEFAULT_GH_PACE_FLOOR_FRACTION = 0.02;

export class GhPaceFloorStandDownError extends Error {
  readonly resource: string;
  readonly remaining: number;
  readonly limit: number;
  constructor(budget: GhBudgetReading) {
    super(
      `gh call pacer stood down: ${budget.resource} at ${budget.remaining}/${budget.limit}, at or below the floor — refusing rather than spending what's left`,
    );
    this.name = "GhPaceFloorStandDownError";
    this.resource = budget.resource;
    this.remaining = budget.remaining;
    this.limit = budget.limit;
  }
}

export interface GhCallPacer {
  wait(): void;
  recordResult(rateLimited: boolean, budget?: GhBudgetReading): void;
  sleepSync?(ms: number): void;
  /** W1-T6591: {@link wait} for an event loop — the same gap and floor, the sleep an awaited timer. */
  waitAsync?(): Promise<void>;
  sleepAsync?(ms: number): Promise<void>;
}

export function createGhCallPacer(
  opts: {
    minGapMs?: number;
    rateLimitGapMs?: number;
    lowWaterFraction?: number;
    floorFraction?: number;
    // W1-T2897: a method signature, not an arrow-typed field — structurally identical for every
    // existing `{ now: () => n }` caller, but outside test/clock-signature-census.test.ts's four
    // tracked legacy-shape patterns, so this port-facing seam does not itself re-grow the count
    // src/lib/clock.ts's Clock exists to retire.
    now?(): number;
    sleepSync?: (ms: number) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): GhCallPacer {
  const minGapMs = opts.minGapMs ?? DEFAULT_GH_PACE_MIN_GAP_MS;
  const rateLimitGapMs = opts.rateLimitGapMs ?? DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS;
  const lowWaterFraction = opts.lowWaterFraction ?? DEFAULT_GH_PACE_LOW_WATER_FRACTION;
  const floorFraction = opts.floorFraction ?? DEFAULT_GH_PACE_FLOOR_FRACTION;
  const now = opts.now ?? systemClock.now;
  const sleepSync = opts.sleepSync ?? defaultBlockingSleepSync;
  const sleep = opts.sleep ?? defaultTimerSleep;
  let lastCallAt: number | undefined;
  let gapMs = minGapMs;
  let standDown: GhBudgetReading | undefined;
  const takeStandDown = (): void => {
    if (!standDown) return;
    const reading = standDown;
    standDown = undefined;
    throw new GhPaceFloorStandDownError(reading);
  };
  return {
    wait() {
      takeStandDown();
      if (lastCallAt !== undefined) {
        const remaining = gapMs - (now() - lastCallAt);
        if (remaining > 0) sleepSync(remaining);
      }
      lastCallAt = now();
    },
    async waitAsync() {
      takeStandDown();
      const remaining = lastCallAt === undefined ? 0 : gapMs - (now() - lastCallAt);
      // The slot is claimed before the timer, so a second waiter queues behind it rather than beside it.
      lastCallAt = now() + Math.max(0, remaining);
      if (remaining > 0) await sleep(remaining);
    },
    recordResult(rateLimited, budget) {
      const lowWater = budget !== undefined && budget.limit > 0 && budget.remaining <= budget.limit * lowWaterFraction;
      gapMs = rateLimited || lowWater ? rateLimitGapMs : minGapMs;
      standDown = budget !== undefined && budget.limit > 0 && budget.remaining <= budget.limit * floorFraction ? budget : undefined;
    },
    sleepSync,
    sleepAsync: sleep,
  };
}

/** Raised by {@link createNonBlockingGhCallPacer} in place of a synchronous sleep, so the caller sees why no call was made. */
export class GhPaceWouldBlockError extends RmdError {
  readonly waitMs: number;
  constructor(waitMs: number) {
    super(
      "github",
      1,
      `gh call pacer refused to sleep ${waitMs}ms on this thread: a blocking sleep would freeze the event loop, so retry after the gap`,
      { waitMs },
    );
    this.name = "GhPaceWouldBlockError";
    this.waitMs = waitMs;
  }
}

/** A pacer for a thread that must never block (serve's loop): the same gap and floor as {@link createGhCallPacer},
 *  but a wait that would sleep throws {@link GhPaceWouldBlockError} instead. Never calls a blocking sleep. */
export function createNonBlockingGhCallPacer(opts: Parameters<typeof createGhCallPacer>[0] = {}): GhCallPacer {
  return createGhCallPacer({
    ...opts,
    sleepSync: (ms: number): void => {
      if (ms > 0) throw new GhPaceWouldBlockError(ms);
    },
  });
}

function defaultBlockingSleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** W1-T4970: the async readers' wait — a timer, so the event loop keeps running through it. */
async function defaultTimerSleep(ms: number): Promise<void> {
  await delay(ms);
}

export const DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS = 60_000;

/** PRIMARY CONTROL: a refused call retries only this many times before surfacing the refusal. */
export const DEFAULT_GH_REFUSAL_BACKOFF_MAX_ATTEMPTS = 4;
export const DEFAULT_GH_REFUSAL_BACKOFF_JITTER_FRACTION = 0.25;

export function defaultGhRetryAfterSeconds(err: unknown): number | undefined {
  const e = err as { stderr?: string | Buffer; message?: string } | null | undefined;
  const text = `${e?.stderr ?? ""}\n${e?.message ?? ""}`;
  const match = /retry-after\s*:?\s*(\d+)/i.exec(text);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export interface GhRefusalBackoffOpts {
  retryAfterSeconds?: (err: unknown) => number | undefined;
  random?: () => number;
  floorMs?: number;
  maxAttempts?: number;
}

function ghRefusalBackoffMs(
  attempt: number,
  err: unknown,
  opts: { retryAfterSeconds: (err: unknown) => number | undefined; floorMs: number; random: () => number },
): number {
  const afterSeconds = opts.retryAfterSeconds(err);
  const base = afterSeconds !== undefined ? Math.max(0, afterSeconds) * 1000 : opts.floorMs * 2 ** attempt;
  return Math.round(base + opts.random() * base * DEFAULT_GH_REFUSAL_BACKOFF_JITTER_FRACTION);
}

const GH_BUDGET_READING = Symbol("github-transport.ghBudgetReading");

export function withGhBudgetReading<T>(value: T, budget: GhBudgetReading | undefined): T {
  if (budget !== undefined && value !== null && (typeof value === "object" || typeof value === "function")) {
    (value as unknown as Record<symbol, GhBudgetReading>)[GH_BUDGET_READING] = budget;
  }
  return value;
}

function ghBudgetReadingOf(value: unknown): GhBudgetReading | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  return (value as Record<symbol, GhBudgetReading | undefined>)[GH_BUDGET_READING];
}

export function paceGhEntry<T>(
  pacer: GhCallPacer | undefined,
  isRateLimited: (err: unknown) => boolean,
  call: () => T,
  backoff: GhRefusalBackoffOpts = {},
): T {
  if (!pacer) return call();
  const floorMs = backoff.floorMs ?? DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS;
  const maxAttempts = backoff.maxAttempts ?? DEFAULT_GH_REFUSAL_BACKOFF_MAX_ATTEMPTS;
  const retryAfterSeconds = backoff.retryAfterSeconds ?? defaultGhRetryAfterSeconds;
  const random = backoff.random ?? Math.random;
  pacer.wait();
  let attempt = 0;
  for (;;) {
    try {
      const result = call();
      pacer.recordResult(false, ghBudgetReadingOf(result));
      return result;
    } catch (err) {
      const limited = isRateLimited(err);
      pacer.recordResult(limited);
      if (!limited || attempt + 1 >= maxAttempts) throw err;
      pacer.sleepSync?.(ghRefusalBackoffMs(attempt, err, { retryAfterSeconds, floorMs, random }));
      attempt += 1;
    }
    pacer.wait();
  }
}

/** W1-T6591: {@link paceGhEntry} for an awaited call — the same pacer, budget floor and refusal
 *  backoff, but the gap and the backoff are timers, never a blocking sleep on the event loop. */
export async function paceGhEntryAsync<T>(
  pacer: GhCallPacer | undefined,
  isRateLimited: (err: unknown) => boolean,
  call: () => Promise<T>,
  backoff: GhRefusalBackoffOpts = {},
): Promise<T> {
  if (!pacer) return call();
  const floorMs = backoff.floorMs ?? DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS;
  const maxAttempts = backoff.maxAttempts ?? DEFAULT_GH_REFUSAL_BACKOFF_MAX_ATTEMPTS;
  const retryAfterSeconds = backoff.retryAfterSeconds ?? defaultGhRetryAfterSeconds;
  const random = backoff.random ?? Math.random;
  const wait = async (): Promise<void> => (pacer.waitAsync ? pacer.waitAsync() : pacer.wait());
  await wait();
  let attempt = 0;
  for (;;) {
    try {
      const result = await call();
      pacer.recordResult(false, ghBudgetReadingOf(result));
      return result;
    } catch (err) {
      const limited = isRateLimited(err);
      pacer.recordResult(limited);
      if (!limited || attempt + 1 >= maxAttempts) throw err;
      await (pacer.sleepAsync ?? defaultTimerSleep)(ghRefusalBackoffMs(attempt, err, { retryAfterSeconds, floorMs, random }));
      attempt += 1;
    }
    await wait();
  }
}

// ── W1-T3297 — THE SECONDARY LIMIT, AND THE CADENCE FLOOR THAT SEES `rmd` VERBS ──────────────
//
// `ghRateLimitRefusalFromReading` above refuses only at `remaining === 0`, and is correct to: that
// is the PRIMARY hourly budget. But every 403 measured on 2026-09-09 arrived with core AND graphql
// reading 5000/5000, because the limit that fires here is the SECONDARY one, which counts request
// RATE rather than volume and sends no `X-Ratelimit-Remaining: 0`. Everything below is ADDITIVE;
// the primary refusal is untouched.
//
// WHY IT LIVES HERE AND NOT ONLY IN THE HOOK. `hooks/deny-floor.sh` rule 9 (W1-T3275) matches `gh`
// in a command's TEXT, so `./bin/rmd review 4862` — which contains none — is invisible to it while
// making the same GitHub calls in-process through `ghExec`. The two surfaces are disjoint by
// construction, so no call is paced twice.
//
// RATIFIED SCOPE WIDENING (operator, 2026-09-09), recorded here per Rule 15 rather than in the
// shard: the SEARCH bucket. `search/issues` is a separate limiter with a far lower ceiling (~30
// requests/minute against core's 5000/hour), and the measured 403 that widened this task arrived on
// search while both core and graphql read full. Two consequences: a search burst inside ONE Bash
// tool call is stamped once by the hook but makes N requests, which only a per-request floor can
// see; and search must be accounted SEPARATELY, because a shared stamp would let general reads
// consume a budget an order of magnitude smaller than the one they are sized against.
//
// ONE STAMP PER LIMITER is therefore the rule, and it is the same rule that forbids a second stamp
// for general reads: the general read stamp is SHARED with the hook (two windows against one
// limiter halve the effective cadence), and search gets its own because it IS a second limiter.

/** SHARED with `hooks/deny-floor.sh` rule 9's default. The two must agree or the windows diverge. */
export const DEFAULT_GH_READ_CADENCE_S = 180;

/** A short, cross-process transport gap protects the secondary limiter without making a normal
 * daemon sweep self-refuse after its first read. This is not another 180-second budget window. */
export const DEFAULT_GH_SHARED_READ_GAP_MS = DEFAULT_GH_PACE_MIN_GAP_MS;
export const GH_SHARED_READ_GAP_ENV = "RMD_GH_SHARED_READ_GAP_MS";
const GH_CADENCE_LOCK_WAIT_MS = 25;
const GH_CADENCE_LOCK_MAX_WAIT_MS = 1_000;
const GH_CADENCE_LOCK_STALE_MS = 30_000;

function resolveGhSharedReadGapMs(env: NodeJS.ProcessEnv): number {
  const raw = env[GH_SHARED_READ_GAP_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_GH_SHARED_READ_GAP_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_GH_SHARED_READ_GAP_MS;
}

/**
 * How many further reads ONE enforce-mode invocation may make after its first read is admitted.
 *
 * WHY A BURST EXISTS AT ALL. `withGhTransportFloor`'s own doc calls it a "standalone" command
 * wrapper, and the per-read floor only makes sense under that assumption: one invocation, one read.
 * `rmd review` — the ONLY command wrapped in enforce mode — makes TWELVE reads (measured on a live
 * invocation, 2026-09-22). So the floor refused the verb's own second read four seconds in, every
 * time, and the verb could never complete. It protected nothing: its sole caller was the only thing
 * it ever refused, and the documented escape (`RMD_GH_TRANSPORT_FLOOR=advisory`) disables the floor
 * for the WHOLE process, which is a strictly broader relaxation than the verb needs.
 *
 * WHAT THE FLOOR IS ACTUALLY FOR, AND WHAT THIS PRESERVES. GitHub's secondary limit counts request
 * CADENCE, and the hazard the floor was built against is a POLLING LOOP — `hooks/deny-floor.sh`
 * says so in its own words ("a run of cheap reads trips it", "a wait is the operator's to
 * schedule"). Spacing between INVOCATIONS is what defeats a polling loop; spacing between the reads
 * inside one bounded verb defeats only the verb. So the first read of an invocation is still gated
 * at the full window, and only then is a burst granted.
 *
 * THE SIZE IS A SEPARATION, NOT A TUNING. The two populations are a bounded verb (12 reads,
 * measured) and an unbounded loop (hundreds). Any value between them separates them, so this is set
 * at 32 — well over 2.5x the only measured need, and small enough that a runaway loop is refused
 * within seconds. It is deliberately NOT fitted to 12: a bound sitting exactly on the observed
 * value fires the first time a healthy caller does one more read than it did last week.
 */
export const DEFAULT_GH_READ_BURST = 32;

/** The `search` limiter — a separate bucket with its own, far lower ceiling. */
export const GH_SEARCH_BUCKET = "search";

/** A rate-limit failure's LIMITER, which decides the remedy: a reset time, or a backoff. */
export type GhLimitKind = "primary" | "secondary";

/** REMEDY, NOT RESET. A secondary limit clears in about a minute and carries no reset timestamp, so
 *  naming a reset here would send the reader to a wait an hour away for the wrong condition. */
export interface GhSecondaryLimitRefusal {
  kind: "secondary";
  bucket: string;
  operation: string;
  remedy: string;
}

function ghErrorTextLooksRateLimited(err: unknown): boolean {
  const e = err as { status?: number; stderr?: string | Buffer; message?: string } | null | undefined;
  if (e === null || e === undefined) return false;
  const text = `${e.stderr ?? ""}\n${e.message ?? ""}`;
  if (/rate limit|too many requests|secondary rate|abuse detection/i.test(text)) return true;
  // A bare 403/429 with no body still reads as pacing; a 404 or 422 never does.
  return e.status === 429;
}

/**
 * Which limiter refused this call, or `undefined` if it was not a rate-limit failure at all.
 *
 * ORDER IS LOAD-BEARING: `remaining === 0` is the PRIMARY budget and keeps that name even though a
 * primary 403's text also reads "rate limit exceeded". Only a rate-limit-shaped failure with the
 * budget NOT exhausted is the secondary limit — which is every 403 measured on 2026-09-09.
 */
export function classifyGhLimitFailure(err: unknown, reading?: GhRateLimitReading): GhLimitKind | undefined {
  if (!ghErrorTextLooksRateLimited(err)) return undefined;
  return reading?.remaining === 0 ? "primary" : "secondary";
}

export function ghSecondaryLimitRefusal(operation: string, bucket: string = GH_RATE_LIMIT_BUCKET_UNKNOWN): GhSecondaryLimitRefusal {
  return {
    kind: "secondary",
    bucket,
    operation,
    remedy: "stop reading and let the rate clear, then resume with backoff — this limit counts cadence, not volume",
  };
}

/** WRITE-SHAPED argv, mirroring `hooks/deny-floor.sh` rule 9's own classifier. A write is what the
 *  fleet does when it has something to say and is self-limiting; pacing one stalls a dispatch. */
export function ghArgvIsWrite(args: readonly string[]): boolean {
  const joined = args.join(" ");
  if (/(?:^|\s)(?:-X|--method)\s+(?:POST|PATCH|PUT|DELETE)\b/i.test(joined)) return true;
  if (/^(?:pr|issue)\s+(?:create|merge|edit|close|reopen|comment|review|ready|lock|unlock)\b/.test(joined)) return true;
  return /^(?:run\s+(?:rerun|cancel|delete)|workflow\s+(?:run|enable|disable)|release\s+(?:create|edit|delete)|label\s+(?:create|edit|delete)|secret\s+set)\b/.test(
    joined,
  );
}

/** The budget probe itself must never be paced — it is how a caller finds out where it stands. */
export function ghArgvIsCadenceExempt(args: readonly string[]): boolean {
  const joined = args.join(" ");
  return /^api\s+rate_limit\b/.test(joined) || /^auth\s+status\b/.test(joined);
}

/** The separate limiter this call spends against, when it is not the general read budget. */
export function ghArgvBucketHint(args: readonly string[]): string | undefined {
  if (args[0] === "search") return GH_SEARCH_BUCKET;
  if (args[0] === "api" && args.slice(1).some((a) => /(?:^|\/)search\//.test(a) || /^search\//.test(a))) {
    return GH_SEARCH_BUCKET;
  }
  return undefined;
}

/**
 * The stamp file, resolved EXACTLY as `hooks/deny-floor.sh` rule 9 resolves it
 * (`${RMD_GH_CACHE_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}}/remudero/gh-last-read`) so the two
 * surfaces share one window, including an explicit host-wide cache override.
 * `undefined` when neither variable is set — the caller then paces nothing and allows the call.
 */
/**
 * The burst this process grants, overridable with `RMD_GH_READ_BURST` for an operator running a
 * verb that legitimately needs more. A non-numeric or negative value falls back to the default
 * rather than disabling the floor, so a typo can never read as "unlimited".
 */
export function ghReadBurst(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RMD_GH_READ_BURST);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_GH_READ_BURST;
}

/**
 * The burst belongs to the FLOOR SCOPE, not to the process.
 *
 * `undefined` means "no scope is open", and then nothing bursts — a direct `applyGhReadCadence`
 * call behaves exactly as it did before this existed. That is deliberate: scoping the burst to
 * `withGhTransportFloorMode`'s dynamic extent is what makes "one invocation is one burst" true by
 * construction rather than by a counter nobody remembers to clear. A process-global counter leaked
 * between callers the first time it was tried, which is how this shape was found.
 */
let ghReadBurstScope: { remaining: number } | undefined;

export function ghReadCadenceStampPath(env: NodeJS.ProcessEnv = process.env, bucket?: string): string | undefined {
  const root = env.RMD_GH_CACHE_HOME ?? env.XDG_CACHE_HOME ?? (env.HOME !== undefined ? `${env.HOME}/.cache` : undefined);
  if (root === undefined || root === "") return undefined;
  return `${root}/remudero/gh-last-read${bucket === undefined ? "" : `-${bucket}`}`;
}

/** ADVISORY IS THE DEFAULT, and any unrecognised value stays advisory: a typo in this variable must
 *  never start refusing the daemon's reads. Enforcement is opt-in, per design (iii). */
export function resolveGhTransportFloorMode(env: NodeJS.ProcessEnv = process.env): "advisory" | "enforce" | "wait" {
  const mode = env.RMD_GH_TRANSPORT_FLOOR;
  return mode === "enforce" || mode === "wait" ? mode : "advisory";
}

/**
 * Run a command with its default read-floor mode and a fresh invocation burst.
 *
 * The transport keeps advisory mode as its library default so injected callers and interactive
 * diagnostics cannot be turned into a hard stop accidentally. CLI handlers use this boundary to
 * select enforcement or waiting, and the daemon selects advisory mode. An explicit environment
 * choice remains authoritative. The restore
 * makes this safe for in-process tests and for a caller that runs more than one verb.
 */
export async function withGhTransportFloorMode<T>(
  mode: "advisory" | "enforce" | "wait",
  fn: () => T | Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const previous = env.RMD_GH_TRANSPORT_FLOOR;
  if (previous === undefined) env.RMD_GH_TRANSPORT_FLOOR = mode;
  // One invocation is one burst. Saved and restored like the env var above so a nested scope
  // cannot hand its parent a budget the parent never earned.
  const previousScope = ghReadBurstScope;
  ghReadBurstScope = { remaining: 0 };
  try {
    return await fn();
  } finally {
    ghReadBurstScope = previousScope;
    if (previous === undefined) delete env.RMD_GH_TRANSPORT_FLOOR;
    else env.RMD_GH_TRANSPORT_FLOOR = previous;
  }
}

/** Run a standalone unattended command with the read floor explicitly enforced by default. */
export async function withGhTransportFloor<T>(fn: () => T | Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  return await withGhTransportFloorMode("enforce", fn, env);
}

/**
 * Run the long-lived daemon with advisory transport reads unless the operator selected a mode.
 * Its GhCallPacer remains the per-call rate controller for normal multi-read sweeps.
 */
export async function withDaemonGhTransportFloor<T>(fn: () => T | Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  return await withGhTransportFloorMode("advisory", fn, env);
}

export interface GhReadCadenceDecision {
  allow: boolean;
  /** Inside the window: `true` even in advisory mode, which is what makes advisory observable. */
  paced: boolean;
  ageS?: number;
  windowS: number;
}

/**
 * PURE. Every fail-open case resolves here rather than at the io boundary, so the reasons are
 * visible in one place: a write, the budget probe, no stamp at all, and a stamp in the FUTURE
 * (clock skew or a restored cache would otherwise refuse every read for hours).
 */
export function ghReadCadenceDecision(opts: {
  isWrite: boolean;
  isExempt: boolean;
  nowMs: number;
  lastReadMs?: number;
  mode: "advisory" | "enforce" | "wait";
  windowS?: number;
}): GhReadCadenceDecision {
  const windowS = opts.windowS ?? DEFAULT_GH_READ_CADENCE_S;
  if (opts.isWrite || opts.isExempt) return { allow: true, paced: false, windowS };
  if (opts.lastReadMs === undefined) return { allow: true, paced: false, windowS };
  const ageMs = opts.nowMs - opts.lastReadMs;
  // A STAMP IN THE FUTURE SPLITS TWO WAYS, and conflating them is a live defect: the first draft
  // allowed on ANY negative age, so a stamp written microseconds earlier — whose `mtimeMs` can
  // round just past `now()` — fell open and let a real `gh` spawn through mid-window. MEASURED: the
  // wiring test hit GitHub and got a 404 on 3 runs in 6.
  //   * a SMALL future offset is ordinary jitter, not skew: clamp to age 0 and pace it, because the
  //     safe direction for an unreadable clock is to pace, never to allow.
  //   * an offset beyond the whole window cannot be a read that already happened (a restored cache,
  //     a wrong clock). Refusing on it would block every read for as long as the skew lasts, so it
  //     is undecidable and falls open.
  if (-ageMs > windowS * 1000) return { allow: true, paced: false, windowS };
  const ageS = Math.floor(Math.max(0, ageMs) / 1000);
  if (ageS >= windowS) return { allow: true, paced: false, ageS, windowS };
  return { allow: opts.mode !== "enforce", paced: true, ageS, windowS };
}

/** The stamp's mtime in millis, or `undefined` for absent/undecidable — never a throw. */
export function readGhReadCadenceStampMs(path: string | undefined): number | undefined {
  if (path === undefined) return undefined;
  try {
    const st = statSync(path);
    // A DIRECTORY where a file belongs is undecidable, not zero: fall open rather than treat it as
    // a fresh read, which would pace every caller against a path that will never be a stamp.
    if (!st.isFile()) return undefined;
    return Math.round(st.mtimeMs);
  } catch {
    // FAIL OPEN (design (v)): an absent, unreadable or unstattable stamp allows the call. A floor
    // that refuses because it could not read its own timestamp is worse than no floor at all.
    return undefined;
  }
}

/** Records an ALLOWED read. Never throws: an unwritable cache root must not block work.
 *
 *  W1-T10271: `text` is what the read leaves in the file — empty, exactly as the hook's `: >` leaves
 *  it, for a read that counts against a gated window, or {@link ghAdvisoryStampText} for a daemon's
 *  advisory read. `atMs` sets the mtime on the caller's clock, the one every reader judges it by. */
export function stampGhRead(path: string | undefined, text = "", atMs?: number): void {
  if (path === undefined) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    if (atMs !== undefined) utimesSync(path, atMs / 1000, atMs / 1000);
  } catch {
    // FAIL OPEN (design (v)): losing the stamp costs pacing accuracy, never the call itself.
  }
}

/** A stamp file's text, or `undefined` when it is absent or unreadable — never a throw. */
export function readGhStampText(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// ── W1-T10271 — A WAITING GH READ GETS A FAIR TURN ──────────────────────────────────────────────
//
// OBSERVED 2026-10-20: an operator's `rmd review` in core, with RMD_GH_TRANSPORT_FLOOR=wait, waited
// 30 min and never got a slot. The wait was measured from the NEWEST stamp, and core's advisory reads
// restamp it about three times a second (median 2.94 req/s from `daemon.quota` deltas, 10-18..10-20),
// so a 180 s quiet stretch never came. The floor exists to space INVOCATIONS (see DEFAULT_GH_READ_BURST);
// the daemon's sweeps are paced by GhCallPacer and the shared gap. Counting them against a gated
// caller's window served neither limiter. Two rules, one limiter:
//   * every read still waits the shared gap after the NEWEST stamp, which the hook shares;
//   * a gated first read (enforce or wait) is floored from the newest read that COUNTS: an admitted
//     gated read (`<stamp>.gated`), a burst read, or a session's hook-paced read. A daemon's advisory
//     read marks the shared stamp's text and CARRIES the last counted read forward, so overwriting a
//     hook's `: >` cannot erase it.
// A gated read that must wait takes a FIFO ticket, operators first, and sleeps OUTSIDE the lock; the
// first reader that finds a due head ticket yields it one shared gap, so the slot is reserved.

const GH_ADVISORY_STAMP_MARK = "advisory";

/** The text a daemon's advisory read leaves: the mark, and the newest counted read it replaced. */
export function ghAdvisoryStampText(countedMs: number | undefined): string {
  return `${GH_ADVISORY_STAMP_MARK} ${countedMs ?? ""}\n`;
}

/** The newest read on a stamp that counts against a gated window: its mtime, unless its text marks an
 *  advisory read, which counts only the read it carried forward (none when it carried nothing). */
export function ghCountedStampMs(ms: number | undefined, text: string | undefined): number | undefined {
  if (ms === undefined) return undefined;
  const marked = /^advisory(?:[ \t]+([0-9]+))?/.exec(text ?? "");
  if (marked === null) return ms;
  return marked[1] === undefined ? undefined : Number(marked[1]);
}

export function ghGatedStampPath(stampPath: string): string {
  return `${stampPath}.gated`;
}

/** The gated stamp's cumulative admission count; an absent or garbled stamp reads 0. */
function ghGatedCount(text: string | undefined): number {
  const n = Number((text ?? "").trim());
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** One waiting gated read's place in the queue. Times are on the waiter's clock, in the file. */
export interface GhReadTicket {
  id: string;
  /** 0 serves first: operators and unknown callers. 1: daemon, run_child, worker and service callers. */
  rank: number;
  actor: LedgerActor;
  seq: number;
  pid: number;
  host: string;
  createdMs: number;
  refreshedMs: number;
  /** A reader has already given this ticket its reserved slot; nobody yields to it again. */
  yielded: boolean;
}

export function ghReadTicketDir(stampPath: string): string {
  return `${stampPath}.tickets`;
}

/** W1-T10271's priority order, which W1-T10279's broker reuses: a person, or a caller nobody can name,
 *  ahead of the automation that can always try again next tick. */
export function ghReadTicketRank(actor: LedgerActor): number {
  return actor === "daemon" || actor === "run_child" || actor === "worker" || actor === "service" || actor === "host_automation" ? 1 : 0;
}

function compareGhReadTickets(a: GhReadTicket, b: GhReadTicket): number {
  return a.rank - b.rank || a.seq - b.seq || a.createdMs - b.createdMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function parseGhReadTicket(id: string, raw: string): GhReadTicket | undefined {
  try {
    const t = JSON.parse(raw) as Partial<GhReadTicket>;
    if (typeof t.rank !== "number" || typeof t.seq !== "number" || typeof t.pid !== "number" ||
      typeof t.createdMs !== "number" || typeof t.refreshedMs !== "number" || typeof t.host !== "string") return undefined;
    return { ...t, id, yielded: t.yielded === true } as GhReadTicket;
  } catch {
    return undefined;
  }
}

/** The queue in serving order. A garbled ticket is removed: it can never be served, only block. */
export function readGhReadTickets(stampPath: string): GhReadTicket[] {
  const dir = ghReadTicketDir(stampPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const tickets: GhReadTicket[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    const ticket = parseGhReadTicket(id, readGhStampText(join(dir, name)) ?? "");
    if (ticket) tickets.push(ticket);
    else removeGhReadTicket(stampPath, id);
  }
  return tickets.sort(compareGhReadTickets);
}

/** Written whole and renamed into place, so a reader never sees half a ticket. */
export function writeGhReadTicket(stampPath: string, ticket: GhReadTicket): void {
  const dir = ghReadTicketDir(stampPath);
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${ticket.id}.${process.pid}.tmp`);
    const { id: _id, ...body } = ticket;
    writeFileSync(tmp, JSON.stringify(body));
    renameSync(tmp, join(dir, `${ticket.id}.json`));
  } catch {
    // FAIL OPEN: an unwritable queue costs ordering, never the read.
  }
}

function removeGhReadTicket(stampPath: string, id: string): void {
  try {
    rmSync(join(ghReadTicketDir(stampPath), `${id}.json`), { force: true });
  } catch {
    // Already gone, or unwritable: either way it no longer holds anyone up that we can help.
  }
}

/** Process-local counts since the previous {@link takeGhReadCadenceTally}; the gated admissions are
 *  read from the shared `.gated` stamp instead, because they happen in OTHER processes. */
const ghReadCadenceCounts = { advisory: 0, enforce: 0, wait: 0, slotsYielded: 0 };
const ghGatedCountSeen = new Map<string, number>();

export interface GhReadCadenceTally {
  reads_stamped: { advisory: number; enforce: number; wait: number };
  gated_admitted: number;
  slots_yielded: number;
}

/** W1-T10271: what `daemon.quota` reports per poll — this process's stamped reads by mode and slots it
 *  yielded, and every process's admitted gated reads — each since the previous call, then reset. */
export function takeGhReadCadenceTally(
  env: NodeJS.ProcessEnv = process.env,
  readText: (path: string | undefined) => string | undefined = readGhStampText,
): GhReadCadenceTally {
  const path = ghReadCadenceStampPath(env);
  let gatedAdmitted = 0;
  if (path !== undefined) {
    const count = ghGatedCount(readText(ghGatedStampPath(path)));
    const previous = ghGatedCountSeen.get(path);
    // A first poll has no previous one to count from; a count that went DOWN was reset, so all of it is new.
    if (previous !== undefined) gatedAdmitted = count >= previous ? count - previous : count;
    ghGatedCountSeen.set(path, count);
  }
  const tally: GhReadCadenceTally = {
    reads_stamped: { advisory: ghReadCadenceCounts.advisory, enforce: ghReadCadenceCounts.enforce, wait: ghReadCadenceCounts.wait },
    gated_admitted: gatedAdmitted,
    slots_yielded: ghReadCadenceCounts.slotsYielded,
  };
  ghReadCadenceCounts.advisory = 0;
  ghReadCadenceCounts.enforce = 0;
  ghReadCadenceCounts.wait = 0;
  ghReadCadenceCounts.slotsYielded = 0;
  return tally;
}

/** ENFORCE MODE ONLY. Distinct from a rate-limit refusal: nothing was spent and nothing failed —
 *  the call was declined before it left, so the remedy is to wait, not to retry harder. */
export class GhReadCadenceRefusal extends RmdError {
  readonly ageS: number;
  readonly windowS: number;
  readonly bucket: string;
  readonly burstRemaining: number;
  constructor(decision: GhReadCadenceDecision, bucket: string, burstRemaining = 0, queuedAhead = 0) {
    const waitS = Math.max(0, decision.windowS - (decision.ageS ?? 0));
    super(
      "usage",
      1,
      `gh read cadence floor: a read-shaped call ${decision.ageS}s after the last one on the ${bucket} limiter ` +
        `(floor ${decision.windowS}s, W1-T3297) — this limit counts cadence, not volume, so a full budget says nothing. ` +
        (queuedAhead > 0
          ? `${queuedAhead} waiting gated read(s) are queued ahead of it (W1-T10271), so an enforced read cannot take ` +
            `their slot: re-run with RMD_GH_TRANSPORT_FLOOR=wait to take a turn. `
          : "") +
        // THE RECOVERY RIDES ON THE REFUSAL. Without it the operator sees a stack trace and no way
        // forward, and the obvious guess — re-running — SPENDS another read and re-stamps the
        // window, so trying harder makes it strictly worse. Both exits are named here instead.
        `This is the FIRST read of this invocation, so no burst applies: wait ${waitS}s, or re-run ` +
        `with RMD_GH_TRANSPORT_FLOOR=advisory to pace rather than refuse. Re-running sooner spends ` +
        `another read and restarts the ${decision.windowS}s window.`,
      { ageS: decision.ageS ?? 0, windowS: decision.windowS, bucket, waitS, burstRemaining, queuedAhead },
    );
    this.burstRemaining = burstRemaining;
    this.name = "GhReadCadenceRefusal";
    this.ageS = decision.ageS ?? 0;
    this.windowS = decision.windowS;
    this.bucket = bucket;
  }
}

export interface GhReadCadenceDeps {
  env?: NodeJS.ProcessEnv;
  // W1-T2897: method signatures, not arrow-typed fields — outside the four legacy clock shapes
  // test/clock-signature-census.test.ts tracks.
  nowMs?(): number;
  readStampMs?(path: string | undefined): number | undefined;
  /** W1-T10271: `text` and `atMs` as {@link stampGhRead} takes them. */
  stamp?(path: string | undefined, text?: string, atMs?: number): void;
  /** W1-T10271: a stamp file's text, which says whether its read counts against a gated window. */
  readStampText?(path: string | undefined): string | undefined;
  /** W1-T10271: writes `<stamp>.gated` for an admitted gated read; {@link stampGhRead} by default. */
  stampGated?(path: string | undefined, text?: string, atMs?: number): void;
  /** W1-T10271: the process this read is made from — its own stamps, and its ticket. */
  pid?: number;
  /** W1-T10271: the caller whose priority a ticket carries; {@link deriveLedgerActor} by default. */
  actor?(): LedgerActor;
  /** W1-T10271: whether a ticket's process on THIS host is still alive. */
  pidAlive?(pid: number): boolean;
  sleepSync?(ms: number): void;
  /** W1-T4970: {@link applyGhReadCadenceAsync}'s awaited wait for the shared gap and the lock;
   *  defaults to a real timer. The sync path ignores it and uses `sleepSync`. */
  sleep?(ms: number): Promise<void>;
  warn?(line: string): void;
  /** W1-T4085: forces the bucket a read is accounted against, overriding `ghArgvBucketHint`'s own
   *  guess from the argv shape. `routeInteractiveGhRead` is the one caller: once a read is riding
   *  the installation token, it must stamp the APP bucket, never whatever bucket the argv alone
   *  would have implied (e.g. `search`), or the two budgets would bleed into each other. */
  bucketOverride?: string;
  /** W1-T4085: mints the installation token `routeInteractiveGhRead` rides; ignored by the cadence
   *  itself. Injectable so a test drives every branch with no network and no real private key. */
  mint?: GhAppTokenMinter;
}

/** ONE LINE PER PROCESS. An advisory that prints on every paced read is noise the daemon's log
 *  would bury, and noise is how a floor stops being read. Reset only for tests. */
let ghCadenceAdvisoryEmitted = false;
let ghCadenceAsyncContentionAdvisoryEmitted = false;
// A daemon can perform several read-shaped calls in one process. The shared file is for
// coordination with sibling processes; sleeping after our own stamp would turn every normal
// sweep into a 1.5s-per-read queue (and made the instrumented CI suite hit its timeout). Keep the
// last value this process wrote so only a newer, foreign stamp consumes the cross-process gap.
const ghCadenceOwnStampMs = new Map<string, number>();

/**
 * Serialise the read-and-stamp critical section across daemon processes. A process-local pacer
 * cannot protect two launchd jobs (or a worker and the daemon) from both seeing an old stamp. The
 * lock is a tiny directory because mkdir is atomic on the filesystems Remudero supports. It is
 * fail-open after a bounded wait, and stale locks are reclaimed so a killed process cannot freeze
 * GitHub access permanently. One attempt is shared by the sync and async lock loops below.
 */
function tryGhCadenceLock(lockPath: string, startedAt: number): "locked" | "reclaimed" | "wait" | "give-up" {
  try {
    mkdirSync(lockPath);
    try {
      // W1-T10271: the lock's age is judged on systemClock below, so it is stamped on that clock too.
      const now = systemClock.now();
      utimesSync(lockPath, now / 1000, now / 1000);
    } catch {
      // A lock whose mtime could not be set still serialises; only its stale bound reads the kernel time.
    }
    return "locked";
  } catch {
    try {
      const ageMs = systemClock.now() - statSync(lockPath).mtimeMs;
      if (ageMs > GH_CADENCE_LOCK_STALE_MS) {
        rmdirSync(lockPath);
        return "reclaimed";
      }
    } catch {
      // The owner may have released the lock between stat and mkdir. Retry immediately.
    }
    return systemClock.now() - startedAt >= GH_CADENCE_LOCK_MAX_WAIT_MS ? "give-up" : "wait";
  }
}

function releaseGhCadenceLock(lockPath: string, locked: boolean): void {
  if (!locked) return;
  try {
    rmdirSync(lockPath);
  } catch {
    // Fail open: a cleanup failure must not turn a successful GitHub call into a daemon error.
  }
}

function withGhCadenceLock<T>(stampPath: string, sleepSync: (ms: number) => void, fn: () => T): T {
  const lockPath = `${stampPath}.lock`;
  const startedAt = systemClock.now();
  let locked = false;
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    for (let step = tryGhCadenceLock(lockPath, startedAt); step !== "give-up"; step = tryGhCadenceLock(lockPath, startedAt)) {
      if (step === "locked") {
        locked = true;
        break;
      }
      if (step === "wait") sleepSync(GH_CADENCE_LOCK_WAIT_MS);
    }
  } catch {
    // An unwritable cache is already a documented fail-open case; run the call without a lock.
  }
  try {
    return fn();
  } finally {
    releaseGhCadenceLock(lockPath, locked);
  }
}

/** Async reads queue before the file lock; sync reads consult this queue to avoid blocking
 *  the event loop an async holder needs to release its lock. W1-T10271: a waiting async read stays in
 *  this in-process queue for its whole wait, so the process's reads keep their order, while it holds
 *  the cross-process FILE lock only for each short turn. */
const ghCadenceAsyncQueue = new Map<string, Promise<void>>();

async function withGhCadenceQueueAsync<T>(stampPath: string, fn: () => Promise<T>): Promise<T> {
  const prior = ghCadenceAsyncQueue.get(stampPath) ?? Promise.resolve();
  let leave!: () => void;
  const mine = new Promise<void>((resolve) => (leave = resolve));
  const tail = prior.then(() => mine);
  ghCadenceAsyncQueue.set(stampPath, tail);
  await prior;
  try {
    return await fn();
  } finally {
    leave();
    if (ghCadenceAsyncQueue.get(stampPath) === tail) ghCadenceAsyncQueue.delete(stampPath);
  }
}

/** The async twin of {@link withGhCadenceLock}: the same lock, attempts and bound, but every wait
 *  is awaited, so the event loop keeps running while a sibling holds the lock. */
async function withGhCadenceLockAsync<T>(stampPath: string, sleep: (ms: number) => Promise<void>, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${stampPath}.lock`;
  const startedAt = systemClock.now();
  let locked = false;
  try {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      for (let step = tryGhCadenceLock(lockPath, startedAt); step !== "give-up"; step = tryGhCadenceLock(lockPath, startedAt)) {
        if (step === "locked") {
          locked = true;
          break;
        }
        if (step === "wait") await sleep(GH_CADENCE_LOCK_WAIT_MS);
      }
    } catch {
      // An unwritable cache is already a documented fail-open case; run the call without a lock.
    }
    return await fn();
  } finally {
    releaseGhCadenceLock(lockPath, locked);
  }
}

export function resetGhCadenceAdvisoryForTest(): void {
  ghCadenceAdvisoryEmitted = false;
  ghCadenceAsyncContentionAdvisoryEmitted = false;
}

/** One read's cadence, shared by the sync and async paths: the decision, its turn in the queue, and
 *  the shared-gap arithmetic and stamp that run inside the lock. Only the WAITING differs. */
interface GhReadCadencePlan {
  evaluate(): GhReadCadenceDecision;
  /** Inside the lock, after `evaluate`: how long to wait OUTSIDE the lock before the next turn, or 0
   *  when this read may go — a waiter's floor and queue, or another reader's reserved-slot yield. */
  turnRemainingMs(): number;
  /** A waiter's remaining floor, re-read after the in-lock gap sleep; 0 for every other read. */
  floorWaitRemainingMs(): number;
  /** Whether `evaluate` found this read must wait at all (its floor, or a queue ahead of it). */
  mustWait(): boolean;
  /** `undefined`: writes, budget probes, and calls without a usable cache path need no shared
   *  coordination, so no lock, gap or stamp. */
  coordinatedStampPath: string | undefined;
  sharedGapRemainingMs(stampPath: string): number;
  stampAfterGap(stampPath: string): void;
  /** Removes this read's ticket: an admitted, refused or interrupted waiter never holds the queue. */
  leaveQueue(): void;
}

function planGhReadCadence(args: readonly string[], deps: GhReadCadenceDeps): GhReadCadencePlan {
  const env = deps.env ?? process.env;
  const bucket = deps.bucketOverride ?? ghArgvBucketHint(args);
  const stampPath = ghReadCadenceStampPath(env, bucket);
  const readStampMs = deps.readStampMs ?? readGhReadCadenceStampMs;
  const readStampText = deps.readStampText ?? readGhStampText;
  const stamp = deps.stamp ?? stampGhRead;
  const stampGated = deps.stampGated ?? stampGhRead;
  const now = deps.nowMs ?? systemClock.now;
  const pid = deps.pid ?? process.pid;
  const pidAlive = deps.pidAlive ?? defaultIsPidAlive;
  const ownKey = (path: string) => `${path}\0${pid}`;
  const isWrite = ghArgvIsWrite(args);
  const isExempt = ghArgvIsCadenceExempt(args);
  const cooldown = env.RMD_GH_COOLDOWN_S;
  const windowS = cooldown !== undefined && /^[0-9]+$/.test(cooldown) ? Number(cooldown) : DEFAULT_GH_READ_CADENCE_S;
  const windowMs = windowS * 1000;
  const sharedReadGapMs = resolveGhSharedReadGapMs(env);
  let mode = resolveGhTransportFloorMode(env);
  /** An invocation's first read under enforce or wait: floored from the counted stamps; stamps `.gated`. */
  let gatedFirst = false;
  /** A gated first read in wait mode that must wait: its floor, or a ticket queued ahead of it. */
  let waiter = false;
  let floorWaitMs = 0;
  let ticket: GhReadTicket | undefined;
  let actor: LedgerActor | undefined;

  const callerActor = (): LedgerActor => (actor ??= deps.actor?.() ?? deriveLedgerActor(env));
  /** The newest read that counts against a gated window: the gated stamp, or a shared stamp that is
   *  not a daemon's advisory read (whose text carries the counted read it replaced instead). */
  const countedFloorMs = (): number | undefined => {
    const shared = ghCountedStampMs(readStampMs(stampPath), readStampText(stampPath));
    const gated = stampPath === undefined ? undefined : readStampMs(ghGatedStampPath(stampPath));
    if (shared === undefined) return gated;
    return gated === undefined ? shared : Math.max(shared, gated);
  };
  const floorRemainingAt = (nowMs: number): number => {
    const lastReadMs = countedFloorMs();
    const decision = ghReadCadenceDecision({ isWrite, isExempt, nowMs, lastReadMs, mode: "wait", windowS });
    return decision.paced ? Math.max(0, windowMs - Math.max(0, nowMs - (lastReadMs ?? nowMs))) : 0;
  };
  /** The queue, with every ticket whose process is gone, or that nobody refreshed for a window plus the
   *  lock-stale bound, reclaimed. A pid is judged only on its own host: another container's pid
   *  namespace says nothing here, so a foreign ticket ages out instead. */
  const liveTickets = (nowMs: number): GhReadTicket[] => {
    if (stampPath === undefined) return [];
    const host = hostname();
    return readGhReadTickets(stampPath).filter((t) => {
      if (t.id === ticket?.id) return true;
      const dead = nowMs - t.refreshedMs > windowMs + GH_CADENCE_LOCK_STALE_MS || (sameHost(t.host, host) && !pidAlive(t.pid));
      if (dead) removeGhReadTicket(stampPath, t.id);
      return !dead;
    });
  };
  /** Tickets served before this read: those that outrank its ticket, or, before it has one, every
   *  ticket of its own priority or better — a newcomer joins the back of its class. */
  const queuedAhead = (tickets: GhReadTicket[]): GhReadTicket[] => {
    const rank = ghReadTicketRank(callerActor());
    return tickets.filter((t) => t.id !== ticket?.id && (ticket ? compareGhReadTickets(t, ticket) < 0 : t.rank <= rank));
  };
  const warnLine = (line: string) => (deps.warn ?? ((l: string) => void process.stderr.write(`${l}\n`)))(line);

  const evaluate = (): GhReadCadenceDecision => {
    // Read at evaluation, not planning: an async read may wait in the lock queue meanwhile.
    const burstAllowed = !isWrite && !isExempt && (ghReadBurstScope?.remaining ?? 0) > 0;
    mode = resolveGhTransportFloorMode(env);
    const nowMs = now();
    gatedFirst = !isWrite && !isExempt && !burstAllowed && mode !== "advisory";
    // An advisory read gates nothing; its notice still reports the cadence from the NEWEST stamp.
    const lastReadMs = gatedFirst ? countedFloorMs() : readStampMs(stampPath);
    const decision = ghReadCadenceDecision({
      isWrite,
      isExempt,
      nowMs,
      lastReadMs,
      mode,
      windowS,
    });
    const ahead = gatedFirst && windowS > 0 ? queuedAhead(liveTickets(nowMs)).length : 0;
    waiter = gatedFirst && mode === "wait" && (decision.paced || ahead > 0);
    floorWaitMs = waiter && decision.paced ? Math.max(0, decision.windowS * 1000 - Math.max(0, nowMs - (lastReadMs ?? nowMs))) : 0;
    // SPEND THE BURST BEFORE REFUSING. A read inside an invocation the floor has already admitted is
    // part of that one burst, not a new one, so it is allowed and the stamp is still refreshed below
    // — the NEXT invocation is therefore gated from this read, not from the first of the burst.
    if (burstAllowed && ghReadBurstScope) ghReadBurstScope.remaining -= 1;
    else if (!decision.allow) throw new GhReadCadenceRefusal(decision, bucket ?? "core", 0);
    // W1-T10271: an enforced read never waits, so it cannot take a turn — and taking the slot a queued
    // waiter is due would restart that waiter's whole window.
    else if (gatedFirst && mode === "enforce" && ahead > 0) throw new GhReadCadenceRefusal(decision, bucket ?? "core", 0, ahead);
    // GRANTED ONLY BY AN ADMITTED, GATED READ, AND ONLY INSIDE AN OPEN SCOPE. An exempt call
    // (`rate_limit`) and a write never open a burst, so neither can be used to buy one for a loop
    // that would otherwise be refused.
    else if (!isWrite && !isExempt && ghReadBurstScope && !waiter) ghReadBurstScope.remaining = ghReadBurst(env);
    if (waiter) {
      warnLine(
        `gh read cadence (wait, W1-T7957): waiting ${floorWaitMs / 1000}s for the ${decision.windowS}s floor on ${stampPath}` +
          (ahead > 0 ? `, behind ${ahead} queued gated read(s) (W1-T10271)` : ""),
      );
    } else if (decision.paced && !burstAllowed && !ghCadenceAdvisoryEmitted) {
      ghCadenceAdvisoryEmitted = true;
      warnLine(
        `gh read cadence (advisory, W1-T3297): a read ${decision.ageS}s after the last on the ${bucket ?? "core"} ` +
          `limiter, under the ${decision.windowS}s floor. Set RMD_GH_TRANSPORT_FLOOR=enforce to refuse instead.`,
      );
    }
    return decision;
  };

  const leaveQueue = () => {
    if (ticket === undefined || stampPath === undefined) return;
    removeGhReadTicket(stampPath, ticket.id);
    ticket = undefined;
  };

  return {
    evaluate,
    turnRemainingMs: () => {
      if (stampPath === undefined) return 0;
      const nowMs = now();
      if (waiter) {
        const tickets = liveTickets(nowMs);
        const floor = floorRemainingAt(nowMs);
        const ahead = queuedAhead(tickets);
        if (floor === 0 && ahead.length === 0) return 0;
        // Take a ticket, or refresh ours so no reader reclaims it as stale. A reclaimed ticket is written
        // back with its own sequence, so the waiter keeps its place; a yield already given stays given.
        const mine = ticket;
        const onDisk = mine === undefined ? undefined : tickets.find((t) => t.id === mine.id);
        ticket = mine === undefined
          ? {
            id: `${pid}-${nowMs}-${randomUUID().slice(0, 8)}`, rank: ghReadTicketRank(callerActor()), actor: callerActor(),
            seq: tickets.reduce((max, t) => Math.max(max, t.seq), 0) + 1, pid, host: hostname(),
            createdMs: nowMs, refreshedMs: nowMs, yielded: false,
          }
          : { ...mine, refreshedMs: nowMs, yielded: onDisk?.yielded ?? mine.yielded };
        writeGhReadTicket(stampPath, ticket);
        // Behind a due head, look again after one shared gap: the head takes its slot within it.
        return floor > 0 ? floor : Math.max(sharedReadGapMs, GH_CADENCE_LOCK_WAIT_MS);
      }
      // THE RESERVED SLOT. The first reader to find a due head ticket gives it one shared gap, outside the
      // lock, so the waiter takes the next slot. Marked on the ticket: nobody yields to it twice.
      if (sharedReadGapMs === 0) return 0;
      const head = liveTickets(nowMs)[0];
      if (head === undefined || head.yielded || floorRemainingAt(nowMs) > 0) return 0;
      writeGhReadTicket(stampPath, { ...head, yielded: true });
      ghReadCadenceCounts.slotsYielded += 1;
      return sharedReadGapMs;
    },
    floorWaitRemainingMs: () => (waiter ? floorRemainingAt(now()) : 0),
    mustWait: () => waiter,
    coordinatedStampPath: isWrite || isExempt ? undefined : stampPath,
    sharedGapRemainingMs: (path) => {
      // The 180-second floor is intentionally advisory for daemon multi-read sweeps. A bounded
      // shared gap still protects the secondary limiter across sibling processes without making a
      // normal sweep self-refuse after its first read.
      const latest = readStampMs(path);
      const ownLatest = latest !== undefined && ghCadenceOwnStampMs.get(ownKey(path)) === latest;
      const elapsed = latest === undefined ? undefined : now() - latest;
      return ownLatest || latest === undefined ? 0 : Math.max(0, sharedReadGapMs - Math.max(0, elapsed ?? 0));
    },
    stampAfterGap: (path) => {
      // Stamp only after the gap so a concurrent process observes the completed transport slot.
      const nowMs = now();
      const advisory = mode === "advisory";
      stamp(path, advisory ? ghAdvisoryStampText(ghCountedStampMs(readStampMs(path), readStampText(path))) : "", nowMs);
      ghReadCadenceCounts[mode] += 1;
      if (gatedFirst) {
        const gatedPath = ghGatedStampPath(path);
        stampGated(gatedPath, `${ghGatedCount(readStampText(gatedPath)) + 1}\n`, nowMs);
      }
      leaveQueue();
      if (waiter && ghReadBurstScope) ghReadBurstScope.remaining = ghReadBurst(env);
      const stampedAt = readStampMs(path);
      if (stampedAt === undefined) ghCadenceOwnStampMs.delete(ownKey(path));
      else ghCadenceOwnStampMs.set(ownKey(path), stampedAt);
    },
    leaveQueue,
  };
}

/** One turn inside the lock, shared by both paths: 0 when the read was stamped, else how long to wait
 *  outside the lock first. `gapSleep` is the only difference: a blocking wait, or an awaited timer. */
function ghReadCadenceTurn(plan: GhReadCadencePlan, stampPath: string, gapSleep: (ms: number) => void): number;
function ghReadCadenceTurn(plan: GhReadCadencePlan, stampPath: string, gapSleep: (ms: number) => Promise<void>): Promise<number>;
function ghReadCadenceTurn(
  plan: GhReadCadencePlan,
  stampPath: string,
  gapSleep: (ms: number) => void | Promise<void>,
): number | Promise<number> {
  const turn = plan.turnRemainingMs();
  if (turn > 0) return turn;
  const finish = (): number => {
    // The shared lock can fail open or be reclaimed during the gap. A newer gated read still
    // owns the floor, so recheck before granting this invocation its read and burst.
    const floor = plan.floorWaitRemainingMs();
    if (floor > 0) return floor;
    plan.stampAfterGap(stampPath);
    return 0;
  };
  const gap = plan.sharedGapRemainingMs(stampPath);
  if (gap === 0) {
    plan.stampAfterGap(stampPath);
    return 0;
  }
  const slept = gapSleep(gap);
  return slept instanceof Promise ? slept.then(finish) : finish();
}

/**
 * THE WIRING — applied by `ghJson`/`ghExec` to a call that will REALLY spawn `gh`.
 *
 * A caller that injected its own `exec` is paced by nothing: it reaches no network, so pacing it
 * would stamp a shared window for a call that never spent from the limiter. That guard is also what
 * keeps this inert across the suite instead of writing a real stamp on every unit test.
 *
 * FAIL OPEN EVERYWHERE (design (v)). Every io path below already swallows its own errors, and the
 * pure decision treats an undecidable stamp as "allow", so the worst case is no pacing at all.
 *
 * W1-T10271: a read that must wait sleeps OUTSIDE the lock and takes the lock again for each turn.
 * Sleeping inside it made every sibling give up after GH_CADENCE_LOCK_MAX_WAIT_MS, fail open and
 * restamp, which is how the waiter's window kept restarting.
 */
export function applyGhReadCadence(args: readonly string[], deps: GhReadCadenceDeps = {}): GhReadCadenceDecision {
  const plan = planGhReadCadence(args, deps);
  const stampPath = plan.coordinatedStampPath;
  if (stampPath === undefined) return plan.evaluate();
  if (ghCadenceAsyncQueue.has(stampPath)) {
    if (!ghCadenceAsyncContentionAdvisoryEmitted) {
      ghCadenceAsyncContentionAdvisoryEmitted = true;
      const warn = deps.warn ?? ((line: string) => void process.stderr.write(`${line}\n`));
      warn(
        "gh read cadence (advisory, W1-T5770): the same process has an async read pending; " +
          "skipping synchronous lock and gap waits so its event loop can continue.",
      );
    }
    const decision = plan.evaluate();
    // A sync wait would block the async holder's event loop; refuse rather than skip the floor.
    if (plan.mustWait()) {
      throw new GhReadCadenceRefusal(decision, deps.bucketOverride ?? ghArgvBucketHint(args) ?? "core", 0);
    }
    plan.stampAfterGap(stampPath);
    return decision;
  }
  const sleepSync = deps.sleepSync ?? defaultBlockingSleepSync;
  let decision: GhReadCadenceDecision | undefined;
  try {
    let waitMs: number;
    do {
      waitMs = withGhCadenceLock(stampPath, sleepSync, () => {
        decision ??= plan.evaluate();
        return ghReadCadenceTurn(plan, stampPath, sleepSync);
      });
      if (waitMs > 0) sleepSync(waitMs);
    } while (waitMs > 0);
    return decision!;
  } finally {
    plan.leaveQueue();
  }
}

/**
 * W1-T4970 — THE ASYNC TWIN, applied by `ghJsonAsync`/`ghTextAsync`. Same lock, decision, queue, gap
 * and stamp as {@link applyGhReadCadence}; every wait is an AWAITED timer instead of `Atomics.wait`,
 * so an async read never freezes the daemon's event loop while it waits.
 */
export async function applyGhReadCadenceAsync(
  args: readonly string[],
  deps: GhReadCadenceDeps = {},
): Promise<GhReadCadenceDecision> {
  const plan = planGhReadCadence(args, deps);
  const stampPath = plan.coordinatedStampPath;
  if (stampPath === undefined) return plan.evaluate();
  const sleep = deps.sleep ?? defaultTimerSleep;
  return await withGhCadenceQueueAsync(stampPath, async () => {
    let decision: GhReadCadenceDecision | undefined;
    try {
      let waitMs: number;
      do {
        waitMs = await withGhCadenceLockAsync(stampPath, sleep, async () => {
          decision ??= plan.evaluate();
          return await ghReadCadenceTurn(plan, stampPath, sleep);
        });
        if (waitMs > 0) await sleep(waitMs);
      } while (waitMs > 0);
      return decision!;
    } finally {
      plan.leaveQueue();
    }
  });
}

// ── W1-T4085 — INTERACTIVE READS SPEND THE OPERATOR'S OWN GITHUB BUDGET ─────────────────────────
//
// `applyGhReadCadence`'s stamp is deliberately SHARED across every session on the host — the
// secondary limit counts per USER, not per process. But that also refuses one session's own read
// behind another session's, seconds apart and unrelated. OBSERVED 2026-09-22: two interactive
// sessions, reads refused "0s after the last one" repeatedly, escaped only by the on-the-record
// override `RMD_GH_COOLDOWN_S=0`, spent several times in one session.
//
// FIX: the fleet's GitHub App installation (github-app.ts) already carries `core`/`graphql`
// buckets wholly separate from any interactive identity, using ids/key the host already has
// (`GH_APP_ID`/`GH_APP_INSTALLATION_ID`/`GH_APP_PRIVATE_KEY_PATH`). Routing a READ through a
// freshly minted installation token spends against THAT budget, paced on its own stamp
// (`GH_APP_READ_BUCKET`) so it can never fight the shared window (design i).
//
// WRITES NEVER MOVE (design ii): authorship matters, and a write is already cadence-exempt, so
// `routeInteractiveGhRead` short-circuits BEFORE ever calling `mint` — provably unattempted, not
// merely unused. A FAILED MINT IS NOT A FAILURE (design iii): every unconfigured host (no
// `GH_APP_*`) falls straight back to `applyGhReadCadence`'s ordinary shared floor, unchanged.

/** The separate limiter an app-token-routed read spends against — never `search`, never the
 *  bucket-less general one. */
export const GH_APP_READ_BUCKET = "app";

export interface GhAppTokenMint {
  ok: boolean;
  /** Present only when `ok`. */
  token?: string;
}

/** Injectable so a test drives every branch with no network and no real private key. */
export type GhAppTokenMinter = (env: NodeJS.ProcessEnv) => Promise<GhAppTokenMint>;

/** Mints into a SCRATCH COPY of `env` — `refreshInstallationToken` writes `GH_TOKEN` onto
 *  whatever env it is given, and the ambient env is what a later WRITE still needs untouched.
 *  A rejection fails open in `routeInteractiveGhRead`'s own catch (design iii). */
async function defaultMintGhAppToken(env: NodeJS.ProcessEnv): Promise<GhAppTokenMint> {
  const scratch: NodeJS.ProcessEnv = { ...env };
  const result = await refreshInstallationToken({ env: scratch });
  return result.ok && scratch.GH_TOKEN ? { ok: true, token: scratch.GH_TOKEN } : { ok: false };
}

export interface InteractiveGhReadRoute {
  /** `true` only when this read is riding the freshly minted app token on its own stamp. */
  usesAppToken: boolean;
  /** Env overlay for the actual `gh` child process — `{}` whenever the ambient identity is kept. */
  envOverlay: NodeJS.ProcessEnv;
  decision: GhReadCadenceDecision;
}

/**
 * Routes ONE interactive `gh` call to the identity and stamp it should spend against — a write
 * (design ii) or a failed mint (design iii) is untouched on the shared floor; a minted read
 * (design i) is paced on `GH_APP_READ_BUCKET` and carries the token as an env overlay.
 */
export async function routeInteractiveGhRead(
  args: readonly string[],
  deps: GhReadCadenceDeps = {},
): Promise<InteractiveGhReadRoute> {
  if (ghArgvIsWrite(args) || ghArgvIsCadenceExempt(args)) {
    return { usesAppToken: false, envOverlay: {}, decision: await applyGhReadCadenceAsync(args, deps) };
  }
  const env = deps.env ?? process.env;
  const mint = deps.mint ?? defaultMintGhAppToken;
  let minted: GhAppTokenMint;
  try {
    minted = await mint(env);
  } catch {
    minted = { ok: false };
  }
  if (!minted.ok || !minted.token) {
    return { usesAppToken: false, envOverlay: {}, decision: await applyGhReadCadenceAsync(args, deps) };
  }
  const decision = await applyGhReadCadenceAsync(args, { ...deps, bucketOverride: GH_APP_READ_BUCKET });
  return { usesAppToken: true, envOverlay: { GH_TOKEN: minted.token }, decision };
}

/**
 * The wired entry point: routes, then actually spawns `gh` with the routed identity. This is the
 * one function an interactive caller needs — it never double-paces, because the routing above is
 * the ONLY place that calls `applyGhReadCadenceAsync` for this call; the spawn below goes through the
 * unpaced `ghExecFile` building block.
 */
export function ghInteractiveRead(
  args: readonly string[],
  opts: ExecFileSyncOptions & { deps?: GhReadCadenceDeps } = {},
): Promise<string | Buffer> {
  const { deps = {}, ...execOpts } = opts;
  return routeInteractiveGhRead(args, deps).then((route) => {
    const env = { ...(execOpts.env ?? deps.env ?? process.env), ...route.envOverlay };
    return ghExecFile("gh", [...args], { ...execOpts, env });
  });
}
