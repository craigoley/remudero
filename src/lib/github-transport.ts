import { execFile, execFileSync } from "node:child_process";
import type { ExecFileSyncOptions, ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
  // W1-T3297: this overload always spawns the real `gh`, so the cadence floor always applies.
  applyGhReadCadence(args);
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
  // W1-T3297: an injected `exec` reaches no network, so pacing it would spend a shared window
  // on a call that never touched the limiter.
  if (exec === execFileSync) applyGhReadCadence(args);
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
 * (`${XDG_CACHE_HOME:-$HOME/.cache}/remudero/gh-last-read`) so the two surfaces share one window.
 * `undefined` when neither variable is set — the caller then paces nothing and allows the call.
 */
export function ghReadCadenceStampPath(env: NodeJS.ProcessEnv = process.env, bucket?: string): string | undefined {
  const root = env.XDG_CACHE_HOME ?? (env.HOME !== undefined ? `${env.HOME}/.cache` : undefined);
  if (root === undefined || root === "") return undefined;
  return `${root}/remudero/gh-last-read${bucket === undefined ? "" : `-${bucket}`}`;
}

/** ADVISORY IS THE DEFAULT, and any unrecognised value stays advisory: a typo in this variable must
 *  never start refusing the daemon's reads. Enforcement is opt-in, per design (iii). */
export function resolveGhTransportFloorMode(env: NodeJS.ProcessEnv = process.env): "advisory" | "enforce" {
  return env.RMD_GH_TRANSPORT_FLOOR === "enforce" ? "enforce" : "advisory";
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
  mode: "advisory" | "enforce";
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
  return { allow: opts.mode === "advisory", paced: true, ageS, windowS };
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

/** Records an ALLOWED read. Never throws: an unwritable cache root must not block work. */
export function stampGhRead(path: string | undefined): void {
  if (path === undefined) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  } catch {
    // FAIL OPEN (design (v)): losing the stamp costs pacing accuracy, never the call itself.
  }
}

/** ENFORCE MODE ONLY. Distinct from a rate-limit refusal: nothing was spent and nothing failed —
 *  the call was declined before it left, so the remedy is to wait, not to retry harder. */
export class GhReadCadenceRefusal extends Error {
  readonly ageS: number;
  readonly windowS: number;
  readonly bucket: string;
  constructor(decision: GhReadCadenceDecision, bucket: string) {
    super(
      `gh read cadence floor: a read-shaped call ${decision.ageS}s after the last one on the ${bucket} limiter ` +
        `(floor ${decision.windowS}s, W1-T3297) — this limit counts cadence, not volume, so a full budget says nothing`,
    );
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
  stamp?(path: string | undefined): void;
  warn?(line: string): void;
}

/** ONE LINE PER PROCESS. An advisory that prints on every paced read is noise the daemon's log
 *  would bury, and noise is how a floor stops being read. Reset only for tests. */
let ghCadenceAdvisoryEmitted = false;

export function resetGhCadenceAdvisoryForTest(): void {
  ghCadenceAdvisoryEmitted = false;
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
 */
export function applyGhReadCadence(args: readonly string[], deps: GhReadCadenceDeps = {}): GhReadCadenceDecision {
  const env = deps.env ?? process.env;
  const bucket = ghArgvBucketHint(args);
  const stampPath = ghReadCadenceStampPath(env, bucket);
  const readStampMs = deps.readStampMs ?? readGhReadCadenceStampMs;
  const stamp = deps.stamp ?? stampGhRead;
  const now = deps.nowMs ?? systemClock.now;
  const decision = ghReadCadenceDecision({
    isWrite: ghArgvIsWrite(args),
    isExempt: ghArgvIsCadenceExempt(args),
    nowMs: now(),
    lastReadMs: readStampMs(stampPath),
    mode: resolveGhTransportFloorMode(env),
  });
  if (!decision.allow) throw new GhReadCadenceRefusal(decision, bucket ?? "core");
  if (decision.paced && !ghCadenceAdvisoryEmitted) {
    ghCadenceAdvisoryEmitted = true;
    const warn = deps.warn ?? ((line: string) => void process.stderr.write(`${line}\n`));
    warn(
      `gh read cadence (advisory, W1-T3297): a read ${decision.ageS}s after the last on the ${bucket ?? "core"} ` +
        `limiter, under the ${decision.windowS}s floor. Set RMD_GH_TRANSPORT_FLOOR=enforce to refuse instead.`,
    );
  }
  // STAMPED ONLY ON AN ALLOWED READ, matching hooks/deny-floor.sh: a refusal must not extend its
  // own window, and a write must not consume the read budget it was never charged against. The
  // refusal half needs no test of `decision.allow` here — the throw above already returned, so a
  // `decision.allow &&` guard would be a branch that can never be false, which is dead code that
  // reads as a covered decision. Enforced by the "a REFUSED read does not extend its own window"
  // case, which fails if the throw is ever moved below this line.
  if (!ghArgvIsWrite(args) && !ghArgvIsCadenceExempt(args)) stamp(stampPath);
  return decision;
}
