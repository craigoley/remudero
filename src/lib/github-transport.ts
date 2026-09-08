import { execFile, execFileSync } from "node:child_process";
import type { ExecFileSyncOptions, ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";

import { clockFromMillisFn, systemClock } from "./clock.js";

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

export function splitGhHeaderBlock(out: string): { headers: string; body: string } {
  if (!out.startsWith("HTTP/")) return { headers: "", body: out };
  const sep = out.match(/\r?\n\r?\n/);
  if (!sep || sep.index === undefined) return { headers: "", body: out };
  return { headers: out.slice(0, sep.index), body: out.slice(sep.index + sep[0].length) };
}

export function ghOptionsWithDefaultTimeout<T extends object>(opts: T & { timeout?: number }): T & { timeout: number } {
  return { ...opts, timeout: opts.timeout ?? DEFAULT_GH_CALL_TIMEOUT_MS };
}

export function ghExec(args: string[], opts: ExecFileSyncOptionsWithStringEncoding): string;
export function ghExec(args: string[], opts?: ExecFileSyncOptions): Buffer;
export function ghExec(args: string[], opts: ExecFileSyncOptions = {}): string | Buffer {
  return ghExecFile("gh", args, opts) as string | Buffer;
}

export function ghExecFile(file: string, args: string[], opts: ExecFileSyncOptionsWithStringEncoding): string;
export function ghExecFile(file: string, args: string[], opts?: ExecFileSyncOptions): Buffer;
export function ghExecFile(file: string, args: string[], opts: ExecFileSyncOptions = {}): string | Buffer {
  return execFileSync(file, args, ghOptionsWithDefaultTimeout(opts)) as string | Buffer;
}

export function ghJson(
  args: string[],
  onRateLimit?: (reading: GhRateLimitReading) => void,
  exec: (file: string, execArgs: string[], opts: { encoding: "utf8"; maxBuffer: number; timeout: number }) => string = execFileSync,
): unknown {
  const isApiCall = args[0] === "api";
  const execArgs = isApiCall ? [...args, "-i"] : args;
  const out = exec("gh", execArgs, { encoding: "utf8", maxBuffer: DEFAULT_GH_MAX_BUFFER, timeout: DEFAULT_GH_CALL_TIMEOUT_MS });
  if (!isApiCall) return JSON.parse(out);
  const { headers, body } = splitGhHeaderBlock(out);
  if (onRateLimit) onRateLimit(parseGhRateLimitHeaders(headers));
  return JSON.parse(body);
}

const execFileAsync = promisify(execFile) as (
  file: string,
  args: readonly string[],
  opts: { encoding: BufferEncoding; maxBuffer: number; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export async function ghJsonAsync(args: string[], execAsync: typeof execFileAsync = execFileAsync): Promise<unknown> {
  const { stdout } = await execAsync("gh", args, {
    encoding: "utf8",
    maxBuffer: DEFAULT_GH_MAX_BUFFER,
    timeout: DEFAULT_GH_CALL_TIMEOUT_MS,
  });
  return JSON.parse(stdout);
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
  } = {},
): GhCallPacer {
  const minGapMs = opts.minGapMs ?? DEFAULT_GH_PACE_MIN_GAP_MS;
  const rateLimitGapMs = opts.rateLimitGapMs ?? DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS;
  const lowWaterFraction = opts.lowWaterFraction ?? DEFAULT_GH_PACE_LOW_WATER_FRACTION;
  const floorFraction = opts.floorFraction ?? DEFAULT_GH_PACE_FLOOR_FRACTION;
  const now = opts.now ?? systemClock.now;
  const sleepSync = opts.sleepSync ?? defaultBlockingSleepSync;
  let lastCallAt: number | undefined;
  let gapMs = minGapMs;
  let standDown: GhBudgetReading | undefined;
  return {
    wait() {
      if (standDown) {
        const reading = standDown;
        standDown = undefined;
        throw new GhPaceFloorStandDownError(reading);
      }
      if (lastCallAt !== undefined) {
        const remaining = gapMs - (now() - lastCallAt);
        if (remaining > 0) sleepSync(remaining);
      }
      lastCallAt = now();
    },
    recordResult(rateLimited, budget) {
      const lowWater = budget !== undefined && budget.limit > 0 && budget.remaining <= budget.limit * lowWaterFraction;
      gapMs = rateLimited || lowWater ? rateLimitGapMs : minGapMs;
      standDown = budget !== undefined && budget.limit > 0 && budget.remaining <= budget.limit * floorFraction ? budget : undefined;
    },
    sleepSync,
  };
}

function defaultBlockingSleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
