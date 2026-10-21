/**
 * W1-T10279 — EVERY MAC SESSION READS GITHUB THROUGH ONE BROKER.
 *
 * OBSERVED 2026-10-20: hooks/deny-floor.sh rule 10 refuses any read-shaped `gh` call within 180 s of the
 * last allowed one, on ONE stamp shared by every Claude session and agent of the Mac account — about 20
 * reads an hour between all of them, whatever they read. An interactive session waited over five minutes
 * for a slot. This broker is one process per Mac account that every session's reads go through:
 *
 *   * a read inside the response's own `Cache-Control: max-age` is served with NO upstream call;
 *   * a stale `gh api` read revalidates with `If-None-Match` (or `If-Modified-Since`), and a 304 serves
 *     the stored body. A 304 is free against the PRIMARY limit only — it is still a request, and the
 *     SECONDARY limit counts requests — so the secondary saving comes from fresh hits and coalescing;
 *   * identical reads in flight from any number of clients share ONE upstream call;
 *   * interactive callers go first, then agents, then background, round-robin by caller within a class;
 *   * upstream calls are serial per limiter and paced from GitHub's own signals: `retry-after`, a
 *     secondary-limit refusal's backoff, and `x-ratelimit-remaining`/`-reset` spread to the reset.
 *
 * WRITES ARE UNCHANGED: a write sent here is refused by name, and `rmd gh` refuses writes and auth calls;
 * a write runs as a plain `gh` call, where hooks/deny-floor.sh judges it.
 * NO FIXED BOUNDS: every number below is an initial guess the broker adapts from GitHub's own signals,
 * and `rmd gh-broker status` prints it. The gain is MEASURED: `status --since <dur>` reads the log.
 *
 * THE MAC RUNTIME RULING. The operator ruled on 2026-10-09 that no remudero runtime runs on the Mac; this
 * is the operator-approved exception (2026-10-20), an account-local helper installed like the Mac janitor
 * by deploy/mac/install-gh-read-broker.sh. It makes only GitHub READS, as the account's own `gh` identity.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { clockFromMillisFn, systemClock, type Clock } from "./clock.js";
import {
  brokerGhRead, brokerRequest, GH_BROKER_CLASSES, GH_BROKER_HEARTBEAT, GH_BROKER_INVALIDATIONS, GH_BROKER_SOCKET,
  ghBrokerCallerId, ghBrokerDir, ghBrokerDirLive, ghReadBrokerLive, isGhBrokerClass,
  type GhBrokerClass, type GhBrokerOutcome, type GhBrokerProgress, type GhBrokerReadRequest, type GhBrokerResult,
} from "./gh-read-broker-client.js";
import {
  classifyGhLimitFailure, DEFAULT_GH_CALL_TIMEOUT_MS, DEFAULT_GH_PACE_MIN_GAP_MS, DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS, ghRunForBroker,
  ghArgvIsWrite, ghBrokerClassForActor, parseGhApiArgv, parseGhRateLimitHeaders, refuseSentinelGhToken, splitGhHeaderBlock,
} from "./github-transport.js";
import { deriveLedgerActor } from "./ledger.js";
import { execFileLoopBounded } from "./loop-bounded-child.js";
import { hostWorktreeGitEnv, pinWorktreeGit } from "./worktree-git.js";

// ── WHAT A READ IS ──────────────────────────────────────────────────────────────────────────────

/** `api-rest`: a plain `gh api` GET, cached with its ETag and revalidated conditionally. `opaque`: a read
 *  whose output is not an HTTP body (porcelain, GraphQL, `--jq`, `--paginate`), cached as a unit for the
 *  freshness GitHub last advertised. `run-log`: a completed run's log, immutable. `passthrough`: any other
 *  read — paced and coalesced, never cached. */
export type GhBrokerReadKind = "api-rest" | "opaque" | "run-log" | "passthrough";
export type GhBrokerLimiter = "core" | "graphql" | "search";

export interface GhBrokerClassified {
  kind: GhBrokerReadKind | "write";
  limiter: GhBrokerLimiter;
  /** The client asked for the response headers (`-i`); the cache key ignores it, the output does not. */
  wantsInclude: boolean;
  /** The argv sent upstream, without `-i` for an `api-rest` read (the broker adds its own). */
  upstreamArgs: string[];
  /** The pull requests and issues a cached result describes, for write invalidation. */
  subjects: GhBrokerSubject[];
}

/** `number: null` is a LIST of that repository's pull requests or issues: any write there invalidates it. */
export interface GhBrokerSubject {
  repo: string;
  number: number | null;
}

const PORCELAIN_READS: Record<string, readonly string[]> = {
  pr: ["view", "list", "checks", "diff", "status"],
  issue: ["view", "list", "status"],
  run: ["view", "list"],
  search: ["prs", "issues", "repos", "code", "commits"],
};

function flagValue(args: readonly string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    for (const name of names) {
      if (args[i] === name) return args[i + 1];
      if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
    }
  }
  return undefined;
}

function apiSubjects(endpoint: string): GhBrokerSubject[] {
  const m = /^\/?repos\/([^/]+\/[^/?]+)\/(?:pulls|issues)(?:\/([0-9]+))?/.exec(endpoint);
  if (!m) return [];
  return [{ repo: m[1], number: m[2] === undefined ? null : Number(m[2]) }];
}

function apiUsesStdin(args: readonly string[]): boolean {
  if (args[0] !== "api") return false;
  const api = parseGhApiArgv(args);
  return api.input === "-" || api.fields.some((f) => f.typed && f.value === "@-");
}

/** Keep gh's rendering flags out of the request identity, including attached short flag values. */
function apiRequestArgs(args: readonly string[], rendering = false): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const name = arg.split("=")[0];
    if (["-i", "--include"].includes(name)) continue;
    if (name === "--cache" || (!rendering && ["-q", "--jq", "-t", "--template"].includes(name))) {
      if (!arg.includes("=")) i++;
      continue;
    }
    if (!rendering && (/^-[qt].+/.test(arg) || ["--silent", "--verbose"].includes(name))) continue;
    out.push(arg);
    if (["-H", "--header", "-p", "--preview", "-f", "--raw-field", "-F", "--field", "-X", "--method", "--input", "--hostname"].includes(arg) && i + 1 < args.length) out.push(args[++i]);
  }
  return out;
}

/** A missing file/context is a passthrough, never a cache identity shared with another failure. */
function apiRequestIdentity(request: GhBrokerReadRequest): unknown[] | undefined {
  const args = apiRequestArgs(request.args);
  const api = parseGhApiArgv(args);
  try {
    const hashFile = (path: string) => createHash("sha256").update(readFileSync(resolve(request.cwd ?? process.cwd(), path))).digest("hex");
    const fields = api.fields.map((f) => [f.typed, f.key, f.typed && f.value.startsWith("@") ? ["sha256", hashFile(f.value.slice(1))] : f.value]);
    const input = api.input === undefined ? undefined : hashFile(api.input);
    const placeholders = [api.endpoint ?? "", ...api.fields.map((f) => f.value)].join("\n");
    let context: unknown;
    if (/\{(?:owner|repo|branch)\}/.test(placeholders)) {
      const cwd = request.cwd ?? process.cwd();
      // Pin the repository and neutralise executable config. These two commands only read metadata;
      // unlike worktree operations, they must admit the account's remote.*.gh-resolved marks.
      const pin = pinWorktreeGit(cwd);
      const git = (args: string[]) => execFileSync("git", args, {
        encoding: "utf8", env: hostWorktreeGitEnv(pin), timeout: DEFAULT_GH_CALL_TIMEOUT_MS, killSignal: "SIGKILL",
      });
      const remotes = git(["config", "--local", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"]);
      const branch = placeholders.includes("{branch}") ? git(["symbolic-ref", "--quiet", "HEAD"]) : undefined;
      context = [remotes, branch];
    }
    // Field file paths are replaced by their bytes; all other request flags retain gh's ordering.
    const shape = args.filter((arg, i) => {
      if (["-f", "-F", "--field", "--raw-field", "--input", "-X", "--method"].includes(arg)) return false;
      if (["-f", "-F", "--field", "--raw-field", "--input", "-X", "--method"].includes(args[i - 1])) return false;
      return !/^(?:--(?:field|raw-field|input|method)=|-[fFX].+)/.test(arg);
    });
    return [api.method, shape, fields, input, request.repo ?? "", context];
  } catch (cause) {
    // gh owns the diagnostic. No identity is safer than memoising an unreadable input or repository.
    void cause;
    return undefined;
  }
}

function directoryBytes(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((sum, item) => {
    const path = join(dir, item.name);
    return sum + (item.isDirectory() ? directoryBytes(path) : statSync(path).size);
  }, 0);
}

/** PURE but for reading a local GraphQL query file: what kind of read `args` is, which limiter it
 *  spends, and what it is about. WRITE OR READ IS NOT DECIDED HERE: it is {@link ghArgvIsWrite}, the one
 *  rule every gh path shares, judged in `cwd`, the directory the upstream call would run in. */
export function classifyGhBrokerRead(args: readonly string[], repo?: string, cwd?: string): GhBrokerClassified {
  const wantsInclude = args.includes("-i") || args.includes("--include");
  const base = { wantsInclude, upstreamArgs: [...args], subjects: [] as GhBrokerSubject[] };
  const api = args[0] === "api" ? parseGhApiArgv(args) : undefined;
  if (ghArgvIsWrite(args, { cwd })) return { ...base, kind: "write", limiter: api?.endpoint === "graphql" ? "graphql" : "core" };
  if (api !== undefined) {
    if (api.endpoint === "graphql") return { ...base, kind: "opaque", limiter: "graphql" };
    const limiter: GhBrokerLimiter = /(?:^|\/)search\//.test(api.endpoint ?? "") ? "search" : "core";
    const subjects = apiSubjects(api.endpoint ?? "");
    // A GET with fields sends them as a query string: its output is still one body, but keyed as a unit.
    if (api.opaqueOutput || api.fields.length > 0 || api.input !== undefined || args.some((a) => /^--(?:silent|verbose)(?:=|$)/.test(a))) return { ...base, kind: "opaque", limiter, subjects };
    return { ...base, kind: "api-rest", limiter, subjects, upstreamArgs: args.filter((a) => a !== "-i" && a !== "--include") };
  }
  const verbs = PORCELAIN_READS[args[0] ?? ""];
  if (verbs?.includes(args[1] ?? "")) {
    const limiter: GhBrokerLimiter = args[0] === "search" ? "search" : "core";
    if (args[0] === "run" && args[1] === "view" && (args.includes("--log") || args.includes("--log-failed"))) {
      return { ...base, kind: "run-log", limiter };
    }
    const target = flagValue(args, "-R", "--repo") ?? repo;
    const numbered = args[0] === "pr" || args[0] === "issue"
      ? (/^[0-9]+$/.test(args[2] ?? "") ? Number(args[2]) : args[1] === "list" ? null : undefined)
      : undefined;
    // An unnamed repository is "*": a write to that number in ANY repository invalidates it.
    const subjects = numbered !== undefined ? [{ repo: target ?? "*", number: numbered }] : [];
    return { ...base, kind: "opaque", limiter, subjects };
  }
  return { ...base, kind: "passthrough", limiter: args[0] === "search" ? "search" : "core" };
}

// ── PACING FROM GITHUB'S OWN SIGNALS ────────────────────────────────────────────────────────────

/** The parts of one upstream answer a pacer reads. */
export interface GhUpstreamSignal {
  headers: string;
  stderr: string;
  /** The HTTP status from an `-i` header block, when there was one. */
  status?: number;
  exitCode: number;
}

/**
 * One limiter's pacing. The gap STARTS at the transport's DEFAULT_GH_PACE_MIN_GAP_MS as a guess, WIDENS
 * multiplicatively on each secondary-limit refusal and NARROWS additively after each success: AIMD,
 * so it settles where GitHub stops refusing rather than where anyone guessed. `retry-after` holds the
 * limiter for exactly that long; a secondary refusal without one holds with exponential backoff from
 * GitHub's documented "at least one minute"; the primary budget is spread over the time to its reset.
 */
export class GhLimiterPacer {
  gapMs: number;
  holdUntilMs = 0;
  lastStartMs = Number.NEGATIVE_INFINITY;
  secondaryRefusals = 0;
  primary: { remaining: number; resetMs: number } | undefined;
  readonly initialGapMs: number;
  readonly narrowStepMs: number;

  constructor(initialGapMs: number = DEFAULT_GH_PACE_MIN_GAP_MS) {
    this.initialGapMs = initialGapMs;
    this.gapMs = initialGapMs;
    // An initial guess too: ten successes undo one doubling's worth of the starting gap.
    this.narrowStepMs = initialGapMs / 10;
  }

  /** The primary budget spread evenly over the time to its reset; 0 when there is no reading. */
  primarySpreadMs(nowMs: number): number {
    if (this.primary === undefined || this.primary.resetMs <= nowMs) return 0;
    if (this.primary.remaining <= 0) return this.primary.resetMs - nowMs;
    return (this.primary.resetMs - nowMs) / this.primary.remaining;
  }

  /** The earliest moment the next upstream call on this limiter may start. */
  nextStartMs(nowMs: number): number {
    return Math.max(this.lastStartMs + Math.max(this.gapMs, this.primarySpreadMs(nowMs)), this.holdUntilMs);
  }

  record(nowMs: number, signal: GhUpstreamSignal): "secondary" | "primary" | "ok" | "failed" {
    const reading = parseGhRateLimitHeaders(signal.headers);
    if (reading.remaining !== undefined && reading.reset !== undefined) {
      this.primary = { remaining: reading.remaining, resetMs: reading.reset * 1000 };
    }
    const retryAfterS = Number(/^retry-after:\s*([0-9]+)\s*$/im.exec(signal.headers)?.[1] ?? Number.NaN);
    const kind = signal.exitCode === 0 && (signal.status === undefined || signal.status < 400)
      ? undefined
      : classifyGhLimitFailure({ status: signal.status, stderr: signal.stderr }, reading);
    if (kind === "secondary" || (Number.isFinite(retryAfterS) && signal.status !== undefined && signal.status >= 400)) {
      this.secondaryRefusals += 1;
      this.gapMs = Math.max(this.gapMs * 2, this.initialGapMs);
      this.holdUntilMs = nowMs + (Number.isFinite(retryAfterS)
        ? retryAfterS * 1000
        : DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS * 2 ** (this.secondaryRefusals - 1));
      return "secondary";
    }
    if (kind === "primary") {
      this.holdUntilMs = Math.max(this.holdUntilMs, this.primary?.resetMs ?? nowMs + DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS);
      return "primary";
    }
    if (signal.exitCode !== 0) return "failed";
    this.secondaryRefusals = 0;
    this.gapMs = Math.max(0, this.gapMs - this.narrowStepMs);
    return "ok";
  }
}

// ── THE CACHE ───────────────────────────────────────────────────────────────────────────────────

interface GhBrokerCacheEntry {
  key: string;
  kind: GhBrokerReadKind;
  storedAtMs: number;
  /** `undefined`: never fresh by age (immutable entries are always fresh instead). */
  maxAgeMs?: number;
  immutable: boolean;
  etag?: string;
  lastModified?: string;
  headers: string;
  body: string;
  stdout: string;
  stderr: string;
  subjects: GhBrokerSubject[];
  apiView?: string;
  requestIds?: string[];
}

function headerField(headers: string, name: string): string | undefined {
  return new RegExp(`^${name}:\\s*(.+?)\\s*$`, "im").exec(headers)?.[1];
}

/** `Cache-Control: max-age=N` in ms, or `undefined` when GitHub advertised none (or `no-cache`). */
export function ghMaxAgeMs(headers: string): number | undefined {
  const cc = headerField(headers, "cache-control");
  if (cc === undefined || /no-cache|no-store/i.test(cc)) return undefined;
  const m = /max-age=([0-9]+)/i.exec(cc);
  return m ? Number(m[1]) * 1000 : undefined;
}

function httpStatus(headers: string): number | undefined {
  const m = /^HTTP\/\S+\s+([0-9]{3})/.exec(headers);
  return m ? Number(m[1]) : undefined;
}

// ── THE BROKER ──────────────────────────────────────────────────────────────────────────────────

export interface GhUpstreamResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The account's own `gh`, as a direct call would run it. Injected in tests: no real `gh`, no network. */
export type GhUpstreamExec = (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<GhUpstreamResult>;

export const defaultGhUpstreamExec: GhUpstreamExec = async (args, opts) => {
  if (!opts.env) return ghRunForBroker(args, { cwd: opts.cwd, maxBuffer: 1 << 26 });
  try {
    refuseSentinelGhToken("gh", args, opts.env);
    const result = await execFileLoopBounded("gh", args, { cwd: opts.cwd, env: opts.env, encoding: "utf8", maxBuffer: 1 << 26, timeout: DEFAULT_GH_CALL_TIMEOUT_MS });
    return { ...result, exitCode: 0 };
  } catch (cause) {
    const error = cause as { stdout?: string; stderr?: string; code?: unknown; message?: string };
    return { stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? error.message ?? cause), exitCode: typeof error.code === "number" ? error.code : 1 };
  }
};

export interface GhReadBrokerCounts {
  "hit-fresh": number;
  coalesced: number;
  "revalidated-304": number;
  "upstream-200": number;
  "upstream-error": number;
  refused: number;
  upstream_calls: number;
}

interface QueuedJob {
  key: string;
  cls: GhBrokerClass;
  caller: string;
  seq: number;
  enqueuedMs: number;
  limiter: GhBrokerLimiter;
  listeners: Array<(p: GhBrokerProgress) => void>;
  lastReported?: string;
  start(): Promise<void>;
}

interface InFlight {
  job: QueuedJob;
  promise: Promise<GhBrokerResult>;
  view: string;
}

/** Initial guesses, each printed by `status` with the value the broker holds now. */
export const GH_BROKER_INITIAL_FRESH_MS = 60_000; // GitHub's own `max-age=60` on authenticated REST reads
export const GH_BROKER_CACHE_SHARE_OF_FREE = 0.01;
export const GH_BROKER_LOG_RETENTION_DAYS = 7;

export class GhReadBroker {
  readonly dir: string;
  readonly counts: GhReadBrokerCounts = {
    "hit-fresh": 0, coalesced: 0, "revalidated-304": 0, "upstream-200": 0, "upstream-error": 0, refused: 0, upstream_calls: 0,
  };
  /** The freshness of an opaque read: the max-age GitHub advertised on its most recent REST response. */
  opaqueFreshMs = GH_BROKER_INITIAL_FRESH_MS;
  cacheShareOfFree = GH_BROKER_CACHE_SHARE_OF_FREE;
  logRetentionDays = GH_BROKER_LOG_RETENTION_DAYS;
  readonly pacers = new Map<GhBrokerLimiter, GhLimiterPacer>();
  private readonly exec: GhUpstreamExec;
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly freeBytes: () => number;
  private readonly entries = new Map<string, { bytes: number; subjects: GhBrokerSubject[] }>();
  private readonly memo = new Map<string, GhBrokerCacheEntry>();
  private readonly inflight = new Map<string, InFlight>();
  private readonly queues = new Map<GhBrokerLimiter, QueuedJob[]>();
  private readonly draining = new Set<GhBrokerLimiter>();
  private readonly lastServed = new Map<string, string>();
  /** Reads accepted and not yet answered, from every client. */
  inProgress = 0;
  private loggedDay: string | undefined;
  private invalidationOffset = 0;
  private seq = 0;
  private loginPromise: Promise<string> | undefined;
  private apiFilterCache: "unverified" | "shared" | "filter-keyed" = "unverified";

  /** `exec` is the account's own `gh`; `freeBytes` is the cache volume's free space, read at each write —
   *  the cache's budget is a share of it. Tests inject all four: no real `gh`, no network, no real time. */
  constructor(
    dir: string,
    exec: GhUpstreamExec = defaultGhUpstreamExec,
    clock: Clock = systemClock,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    freeBytes?: () => number,
  ) {
    this.dir = dir;
    this.exec = exec;
    this.clock = clock;
    this.sleep = sleep;
    this.freeBytes = freeBytes ?? (() => {
      const fs = statfsSync(this.dir);
      return fs.bavail * fs.bsize;
    });
    mkdirSync(join(dir, "cache"), { recursive: true, mode: 0o700 });
    for (const name of readdirSync(join(dir, "cache"))) {
      if (!name.endsWith(".json")) continue;
      const entry = this.readEntry(name.slice(0, -".json".length));
      if (entry) this.entries.set(entry.key, { bytes: statSync(this.entryPath(entry.key)).size + this.ghCacheBytes(entry.key), subjects: entry.subjects });
    }
    // Invalidations written before this broker started describe cache it never served stale.
    try {
      this.invalidationOffset = statSync(join(dir, GH_BROKER_INVALIDATIONS)).size;
    } catch {
      this.invalidationOffset = 0; // no invalidation file yet: nothing has been written
    }
  }

  private now(): number {
    return this.clock.now();
  }

  pacer(limiter: GhBrokerLimiter): GhLimiterPacer {
    let pacer = this.pacers.get(limiter);
    if (!pacer) this.pacers.set(limiter, pacer = new GhLimiterPacer());
    return pacer;
  }

  /** The login the account's token reads as: one `gh api user` per broker, so state is keyed by it. */
  login(): Promise<string> {
    this.loginPromise ??= this.exec(["api", "user", "--jq", ".login"], {}).then((r) => (r.exitCode === 0 ? r.stdout.trim() : "") || "unknown");
    return this.loginPromise;
  }

  private entryPath(key: string): string {
    return join(this.dir, "cache", `${key}.json`);
  }

  private ghCachePath(key: string): string {
    return join(this.dir, "cache", `${key}.gh`);
  }

  private ghCacheBytes(key: string): number {
    const path = this.ghCachePath(key);
    return readdirSync(join(this.dir, "cache")).includes(`${key}.gh`) ? directoryBytes(path) : 0;
  }

  private readEntry(key: string): GhBrokerCacheEntry | undefined {
    const memo = this.memo.get(key);
    if (memo) return memo;
    try {
      const entry = JSON.parse(readFileSync(this.entryPath(key), "utf8")) as GhBrokerCacheEntry;
      this.memo.set(key, entry);
      return entry;
    } catch {
      // Absent and unreadable are both a miss: the read goes upstream and rewrites the entry.
      return undefined;
    }
  }

  private dropEntry(key: string): void {
    this.entries.delete(key);
    this.memo.delete(key);
    rmSync(this.entryPath(key), { force: true });
    rmSync(this.ghCachePath(key), { recursive: true, force: true });
  }

  /** LEAST RECENTLY USED out, until the cache fits its share of the free disk measured at this write. */
  private writeEntry(entry: GhBrokerCacheEntry): void {
    const text = JSON.stringify(entry);
    const tmp = `${this.entryPath(entry.key)}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, this.entryPath(entry.key));
    this.memo.set(entry.key, entry);
    this.entries.delete(entry.key);
    this.entries.set(entry.key, { bytes: Buffer.byteLength(text) + this.ghCacheBytes(entry.key), subjects: entry.subjects });
    const budget = this.cacheShareOfFree * this.freeBytes();
    let total = [...this.entries.values()].reduce((sum, e) => sum + e.bytes, 0);
    for (const [key, meta] of this.entries) {
      if (total <= budget || key === entry.key) break;
      this.dropEntry(key);
      total -= meta.bytes;
    }
  }

  private touch(key: string): void {
    const meta = this.entries.get(key);
    if (!meta) return;
    this.entries.delete(key);
    this.entries.set(key, meta);
  }

  /** Drops cached reads about any pull request or issue a hook-seen `gh` write touched. */
  applyInvalidations(): void {
    let text: string;
    try {
      const raw = readFileSync(join(this.dir, GH_BROKER_INVALIDATIONS));
      text = raw.subarray(Math.min(this.invalidationOffset, raw.length)).toString("utf8");
      this.invalidationOffset = raw.length;
    } catch {
      return; // no invalidation file: no write has been seen since install
    }
    for (const line of text.split("\n")) {
      const [repo, num] = line.trim().split(/\s+/);
      if (!repo || !num) continue;
      const number = Number(num);
      for (const [key, meta] of [...this.entries]) {
        if (meta.subjects.some((s) => (repo === "*" || s.repo === "*" || s.repo.toLowerCase() === repo.toLowerCase()) && (s.number === null || s.number === number))) {
          this.dropEntry(key);
        }
      }
    }
  }

  private fresh(entry: GhBrokerCacheEntry, nowMs: number): boolean {
    if (entry.immutable) return true;
    return entry.maxAgeMs !== undefined && nowMs - entry.storedAtMs < entry.maxAgeMs;
  }

  private render(entry: GhBrokerCacheEntry, wantsInclude: boolean, outcome: GhBrokerOutcome): GhBrokerResult {
    if (entry.kind === "api-rest") {
      return { stdout: wantsInclude ? `${entry.headers}\r\n\r\n${entry.body}` : entry.body, stderr: "", exitCode: 0, outcome };
    }
    return { stdout: entry.stdout, stderr: entry.stderr, exitCode: 0, outcome };
  }

  private log(row: Record<string, unknown>): void {
    const nowMs = this.now();
    const day = clockFromMillisFn(() => nowMs).iso().slice(0, 10);
    const logDir = join(this.dir, "log");
    try {
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      appendFileSync(join(logDir, `requests-${day}.ndjson`), `${JSON.stringify({ ts: clockFromMillisFn(() => nowMs).iso(), ...row })}\n`);
      // Rotate on this process's first line and at each new day: decided in memory, never by a stat
      // of the file just written (a check-then-act race on a file another broker could touch).
      if (this.loggedDay !== day) {
        this.loggedDay = day;
        const oldest = clockFromMillisFn(() => nowMs - this.logRetentionDays * 86_400_000).iso().slice(0, 10);
        for (const name of readdirSync(logDir)) {
          const d = /^requests-([0-9-]{10})\.ndjson$/.exec(name)?.[1];
          if (d !== undefined && d < oldest) rmSync(join(logDir, name), { force: true });
        }
      }
    } catch {
      // The log is evidence about the broker, never a condition of serving a read: a full or
      // unwritable disk costs the measurement, not the answer.
    }
  }

  /** The queue in serving order: classes in order; within a class, callers round-robin starting after
   *  the one served last; within a caller, FIFO. */
  private ordered(limiter: GhBrokerLimiter): QueuedJob[] {
    const queue = this.queues.get(limiter) ?? [];
    const out: QueuedJob[] = [];
    for (const cls of GH_BROKER_CLASSES) {
      const byCaller = new Map<string, QueuedJob[]>();
      for (const job of [...queue].filter((j) => j.cls === cls).sort((a, b) => a.seq - b.seq)) {
        byCaller.set(job.caller, [...(byCaller.get(job.caller) ?? []), job]);
      }
      const callers = [...byCaller.keys()];
      const last = this.lastServed.get(`${limiter}\0${cls}`);
      const at = last === undefined ? -1 : callers.indexOf(last);
      const rotated = at < 0 ? callers : [...callers.slice(at + 1), ...callers.slice(0, at + 1)];
      for (let round = 0; out.length < queue.length; round += 1) {
        let took = false;
        for (const caller of rotated) {
          const job = byCaller.get(caller)?.[round];
          if (job) { out.push(job); took = true; }
        }
        if (!took) break;
      }
    }
    return out;
  }

  /** Tells each queued caller its position and expected wait, at most once per change. */
  private reportPositions(limiter: GhBrokerLimiter): void {
    const nowMs = this.now();
    const pacer = this.pacer(limiter);
    const step = Math.max(pacer.gapMs, pacer.primarySpreadMs(nowMs));
    const first = Math.max(0, pacer.nextStartMs(nowMs) - nowMs);
    this.ordered(limiter).forEach((job, position) => {
      const progress = { position: position + 1, expectedWaitMs: Math.round(first + position * step) };
      // A read that goes upstream at once is not waiting, and says nothing.
      if (progress.expectedWaitMs === 0) return;
      const signature = `${progress.position}:${Math.round(progress.expectedWaitMs / 1000)}`;
      if (signature === job.lastReported) return;
      job.lastReported = signature;
      for (const listener of job.listeners) listener(progress);
    });
  }

  /** Upstream calls are SERIAL per limiter: one drainer per limiter, sleeping out the pacer's gap. */
  private async drain(limiter: GhBrokerLimiter): Promise<void> {
    if (this.draining.has(limiter)) return;
    this.draining.add(limiter);
    try {
      const queue = this.queues.get(limiter)!;
      while (queue.length > 0) {
        const waitMs = this.pacer(limiter).nextStartMs(this.now()) - this.now();
        if (waitMs > 0) {
          this.reportPositions(limiter);
          await this.sleep(waitMs);
          continue;
        }
        const job = this.ordered(limiter)[0];
        queue.splice(queue.indexOf(job), 1);
        this.lastServed.set(`${limiter}\0${job.cls}`, job.caller);
        this.pacer(limiter).lastStartMs = this.now();
        this.reportPositions(limiter);
        await job.start();
      }
    } finally {
      this.draining.delete(limiter);
    }
  }

  /** One read. Never throws: every failure comes back as `gh` would have reported it. */
  async read(request: GhBrokerReadRequest, onProgress?: (p: GhBrokerProgress) => void): Promise<GhBrokerResult> {
    this.inProgress += 1;
    try {
      return await this.readOnce(request, onProgress);
    } finally {
      this.inProgress -= 1;
    }
  }

  private async readOnce(request: GhBrokerReadRequest, onProgress?: (p: GhBrokerProgress) => void): Promise<GhBrokerResult> {
    const startedMs = this.now();
    const cls: GhBrokerClass = isGhBrokerClass(request.class) ? request.class : "background";
    const c = classifyGhBrokerRead(request.args, request.repo, request.cwd);
    c.subjects = c.subjects.map((subject) => /\{(?:owner|repo)\}/.test(subject.repo) ? { ...subject, repo: request.repo ?? "*" } : subject);
    const api = request.args[0] === "api";
    const view = JSON.stringify(request.args);
    const finish = (result: GhBrokerResult, extra: Record<string, unknown> = {}): GhBrokerResult => {
      this.counts[result.outcome] += 1;
      this.log({ class: cls, key: extra.key, outcome: result.outcome, limiter: c.limiter, wait_ms: this.now() - startedMs, ...extra });
      return result;
    };
    if (c.kind === "write") {
      return finish({
        stdout: "",
        stderr: `gh-broker: refused a WRITE (gh ${request.args.slice(0, 2).join(" ")}): the broker serves reads only; ` +
          "writes go straight to gh, unpaced, exactly as before.\n",
        exitCode: 2,
        outcome: "refused",
      });
    }
    this.applyInvalidations();
    const login = await this.login();
    const host = flagValue(request.args, "--hostname") ?? "github.com";
    const identity = api && !apiUsesStdin(request.args) ? apiRequestIdentity(request) : undefined;
    if (api && identity === undefined) c.kind = "passthrough";
    const keyed = api ? [identity ?? [view, request.cwd], this.apiFilterCache === "filter-keyed" ? view : ""] : request.args;
    const key = createHash("sha256")
      .update(JSON.stringify(["request-v2", login, host, api ? "api" : c.kind, api ? "" : request.repo ?? request.cwd ?? "", keyed]))
      .digest("hex");
    const cached = c.kind === "passthrough" ? undefined : this.readEntry(key);
    if (cached && !request.fresh && this.fresh(cached, this.now())) {
      this.touch(key);
      if (api && cached.apiView !== view && !(c.kind === "api-rest" && cached.kind === "api-rest")) {
        const result = await this.upstream(c, request, key, cached, true);
        return finish(result, { key: key.slice(0, 12), request_key: key, gh_filtered_locally: result.outcome === "hit-fresh" });
      }
      return finish(this.render(cached, c.wantsInclude, "hit-fresh"), { key: key.slice(0, 12), request_key: key, gh_filtered_locally: false });
    }
    const joined = this.inflight.get(key);
    if (joined) {
      // A higher class joining a queued read lifts it: the read is served at its most urgent caller's turn.
      if (GH_BROKER_CLASSES.indexOf(cls) < GH_BROKER_CLASSES.indexOf(joined.job.cls)) joined.job.cls = cls;
      if (onProgress) joined.job.listeners.push(onProgress);
      const result = await joined.promise;
      if (api && joined.view !== view && result.exitCode === 0) {
        return this.readOnce(request, onProgress);
      }
      return finish({ ...result, outcome: "coalesced" }, { key: key.slice(0, 12), request_key: key, gh_filtered_locally: false });
    }
    let resolveResult!: (r: GhBrokerResult) => void;
    const promise = new Promise<GhBrokerResult>((resolve) => (resolveResult = resolve));
    let upstreamMs = 0;
    const job: QueuedJob = {
      key, cls, caller: request.caller || "unknown", seq: (this.seq += 1), enqueuedMs: startedMs, limiter: c.limiter,
      listeners: onProgress ? [onProgress] : [],
      start: async () => {
        const began = this.now();
        const result = await this.upstream(c, request, key, cached);
        upstreamMs = this.now() - began;
        resolveResult(result);
      },
    };
    this.inflight.set(key, { job, promise, view });
    const queue = this.queues.get(c.limiter) ?? [];
    this.queues.set(c.limiter, queue);
    queue.push(job);
    this.reportPositions(c.limiter);
    void this.drain(c.limiter);
    try {
      const result = await promise;
      return finish(result, { key: key.slice(0, 12), request_key: key, gh_filtered_locally: false, upstream_ms: upstreamMs, gap_ms: this.pacer(c.limiter).gapMs });
    } finally {
      this.inflight.delete(key);
    }
  }

  private async upstream(
    c: GhBrokerClassified,
    request: GhBrokerReadRequest,
    key: string,
    cached: GhBrokerCacheEntry | undefined,
    replay = false,
  ): Promise<GhBrokerResult> {
    const nowAtStart = this.now();
    const api = request.args[0] === "api" && c.kind !== "passthrough";
    const args = api ? apiRequestArgs(c.upstreamArgs, true) : [...c.upstreamArgs];
    const conditional = c.kind === "api-rest" && cached?.kind === "api-rest" && !replay && (cached.etag || cached.lastModified);
    const expectedReplay = replay && this.ghCacheBytes(key) > 0;
    if (api) {
      args.push("-i");
      if (!replay) rmSync(this.ghCachePath(key), { recursive: true, force: true });
      if (conditional && cached?.etag) args.push("-H", `If-None-Match: ${cached.etag}`);
      else if (conditional && cached?.lastModified) args.push("-H", `If-Modified-Since: ${cached.lastModified}`);
      else if (c.kind !== "api-rest" || replay) args.push("--cache", `${Math.max(0, replay && cached ? (cached.maxAgeMs ?? this.opaqueFreshMs) - (nowAtStart - cached.storedAtMs) : this.opaqueFreshMs)}ms`);
    }
    const env = api || request.repo ? { ...process.env, GH_REPO: request.repo ?? "", ...(api ? { XDG_CACHE_HOME: this.ghCachePath(key) } : {}) } : undefined;
    const raw = await this.exec(args, { cwd: request.cwd, env });
    const nowMs = this.now();
    const split = api || c.kind === "api-rest" || c.wantsInclude
      ? splitGhHeaderBlock(raw.stdout, request.args.includes("--paginate") || request.args.includes("--slurp")) : { headers: "", body: raw.stdout };
    const status = httpStatus(split.headers);
    const requestIds = [...raw.stdout.matchAll(/^x-github-request-id:\s*([^\r\n]+)/gim)].map((m) => m[1]);
    const local = replay && raw.exitCode === 0 && requestIds.length > 0 && JSON.stringify(requestIds) === JSON.stringify(cached?.requestIds);
    if (local) this.apiFilterCache = "shared";
    else {
      if (expectedReplay) this.apiFilterCache = "filter-keyed";
      this.counts.upstream_calls += 1;
      this.pacer(c.limiter).lastStartMs = nowAtStart;
      this.pacer(c.limiter).record(nowMs, { headers: split.headers, stderr: raw.stderr, status, exitCode: raw.exitCode });
    }
    const maxAgeMs = ghMaxAgeMs(split.headers);
    if (maxAgeMs !== undefined) this.opaqueFreshMs = maxAgeMs;
    if (c.kind === "api-rest" && status === 304 && cached) {
      const refreshed: GhBrokerCacheEntry = {
        ...cached, storedAtMs: nowAtStart, maxAgeMs: maxAgeMs ?? cached.maxAgeMs,
        etag: headerField(split.headers, "etag") ?? cached.etag,
      };
      this.writeEntry(refreshed);
      return this.render(refreshed, c.wantsInclude, "revalidated-304");
    }
    if (raw.exitCode !== 0 || (status !== undefined && status >= 300)) {
      // NOT CACHED: every waiter gets this failure, and the next read tries again.
      const stdout = api && !c.wantsInclude ? split.body : raw.stdout;
      return { stdout, stderr: raw.stderr, exitCode: raw.exitCode === 0 ? 1 : raw.exitCode, outcome: "upstream-error" };
    }
    if (c.kind !== "passthrough") {
      this.writeEntry({
        key, kind: c.kind as GhBrokerReadKind, storedAtMs: local ? cached!.storedAtMs : nowAtStart,
        maxAgeMs: local ? cached!.maxAgeMs : c.kind === "api-rest" ? maxAgeMs : maxAgeMs ?? this.opaqueFreshMs,
        // A run log only exists once the run completed (`gh run view --log` refuses before), so it never changes.
        immutable: c.kind === "run-log",
        etag: headerField(split.headers, "etag"), lastModified: headerField(split.headers, "last-modified"),
        headers: split.headers, body: split.body, stdout: api && !c.wantsInclude ? split.body : raw.stdout, stderr: raw.stderr,
        subjects: c.subjects, apiView: api ? JSON.stringify(request.args) : undefined, requestIds,
      });
    }
    return { stdout: api && !c.wantsInclude ? split.body : raw.stdout, stderr: raw.stderr, exitCode: 0, outcome: local ? "hit-fresh" : "upstream-200" };
  }

  status(): Record<string, unknown> {
    const nowMs = this.now();
    const queues: Record<string, Record<string, number>> = {};
    for (const [limiter, queue] of this.queues) {
      queues[limiter] = Object.fromEntries(GH_BROKER_CLASSES.map((cls) => [cls, queue.filter((j) => j.cls === cls).length]));
    }
    const limiters: Record<string, unknown> = {};
    for (const [limiter, pacer] of this.pacers) {
      limiters[limiter] = {
        gap_ms: Math.round(pacer.gapMs),
        hold_ms: Math.max(0, Math.round(pacer.holdUntilMs - nowMs)),
        primary_spread_ms: Math.round(pacer.primarySpreadMs(nowMs)),
        secondary_refusals: pacer.secondaryRefusals,
      };
    }
    return {
      type: "status",
      api_filter_cache: this.apiFilterCache,
      counts: { ...this.counts },
      queues,
      limiters,
      opaque_fresh_s: this.opaqueFreshMs / 1000,
      in_progress: this.inProgress,
      cache_entries: this.entries.size,
      cache_bytes: [...this.entries.values()].reduce((sum, e) => sum + e.bytes, 0),
      cache_share_of_free: this.cacheShareOfFree,
      log_retention_days: this.logRetentionDays,
      scope: "one broker per Mac account; two accounts reading as the same GitHub login each run a broker and do NOT share a pacer",
    };
  }
}

/** `status --since <dur>`: the broker's own measurement over the request log. */
export function summariseGhBrokerLog(dir: string, sinceMs: number): Record<string, unknown> {
  const byOutcome: Record<string, number> = {};
  let reads = 0;
  let upstream = 0;
  let filteredLocally = 0;
  let longestInteractiveWaitMs = 0;
  const since = clockFromMillisFn(() => sinceMs).iso();
  let files: string[] = [];
  try {
    files = readdirSync(join(dir, "log")).filter((n) => /^requests-.*\.ndjson$/.test(n));
  } catch {
    files = []; // no log yet: a broker that has served nothing reports zeros, with `files: 0` saying so
  }
  for (const name of files) {
    for (const line of readFileSync(join(dir, "log", name), "utf8").split("\n")) {
      if (!line) continue;
      let row: { ts?: string; outcome?: string; class?: string; wait_ms?: number; gh_filtered_locally?: boolean };
      try {
        row = JSON.parse(line) as typeof row;
      } catch {
        continue; // a torn last line from a crash is not a request
      }
      if ((row.ts ?? "") < since) continue;
      reads += 1;
      if (row.gh_filtered_locally) filteredLocally += 1;
      byOutcome[row.outcome ?? "unknown"] = (byOutcome[row.outcome ?? "unknown"] ?? 0) + 1;
      if (row.outcome === "upstream-200" || row.outcome === "upstream-error" || row.outcome === "revalidated-304") upstream += 1;
      if (row.class === "interactive") longestInteractiveWaitMs = Math.max(longestInteractiveWaitMs, row.wait_ms ?? 0);
    }
  }
  return {
    files: files.length, reads, upstream_calls: upstream, by_outcome: byOutcome,
    filtered_locally: filteredLocally,
    served_without_upstream_share: reads === 0 ? null : (reads - upstream) / reads,
    longest_interactive_wait_ms: longestInteractiveWaitMs,
  };
}

// ── THE SERVER ──────────────────────────────────────────────────────────────────────────────────

export interface GhReadBrokerServer {
  socketPath: string;
  close(): Promise<void>;
  /** Resolves when the server stops, by `close()` or a `stop` request. */
  closed: Promise<void>;
}

/** The heartbeat interval the broker ADVERTISES in its heartbeat file — an initial guess; readers judge
 *  liveness against twice whatever value is written there. */
export const GH_BROKER_HEARTBEAT_INTERVAL_S = 10;

/**
 * Serves `broker` on `<dir>/broker.sock`. The directory is 0700 and must be this uid's: Node exposes no
 * peer credentials on a unix socket, so the directory's own permissions are what admit only this uid.
 */
export async function serveGhReadBroker(opts: {
  dir: string;
  broker: GhReadBroker;
  heartbeatIntervalS?: number;
  /** The account uid the broker serves: this process's own by default. */
  uid?: number;
}): Promise<GhReadBrokerServer> {
  const { dir, broker } = opts;
  const intervalS = opts.heartbeatIntervalS ?? GH_BROKER_HEARTBEAT_INTERVAL_S;
  const uid = opts.uid ?? process.getuid?.();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`gh-broker: ${dir} belongs to uid ${st.uid}, not this account (${uid}); refusing to serve it`);
  }
  chmodSync(dir, 0o700);
  const socketPath = join(dir, GH_BROKER_SOCKET);
  if (ghBrokerDirLive(dir)) {
    try {
      await brokerRequest(socketPath, { op: "status" });
      throw new Error(`gh-broker: a broker is already serving ${socketPath}`);
    } catch (err) {
      if (String((err as Error).message).includes("already serving")) throw err;
      // A heartbeat with nobody answering is a dead broker's leftover: take its place below.
    }
  }
  rmSync(socketPath, { force: true });
  const heartbeat = join(dir, GH_BROKER_HEARTBEAT);
  const beat = () => {
    try {
      // Written whole and renamed into place: a reader between a truncate and a write would see an empty
      // heartbeat and call a live broker dead (the hook would floor, a transport read would not route).
      writeFileSync(`${heartbeat}.tmp`, `${intervalS}\n`, { mode: 0o600 });
      renameSync(`${heartbeat}.tmp`, heartbeat);
    } catch {
      // A missed beat only lets the hook fall back to its own floor for a while; serving goes on.
    }
  };
  let stopped!: () => void;
  const closed = new Promise<void>((resolve) => (stopped = resolve));
  const timer = setInterval(beat, intervalS * 1000);
  const connections = new Set<Socket>();
  const server: Server = createServer((conn: Socket) => {
    connections.add(conn);
    conn.on("close", () => connections.delete(conn));
    let buffered = "";
    conn.setEncoding("utf8");
    conn.on("error", () => conn.destroy());
    conn.on("data", (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      buffered = "";
      void (async () => {
        let message: { op?: string; sinceMs?: number } & Omit<Partial<GhBrokerReadRequest>, "op">;
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          // A request that is not JSON is refused as gh would refuse a bad flag: exit 2, said on stderr.
          conn.end(`${JSON.stringify({ type: "result", stdout: "", stderr: "gh-broker: unreadable request\n", exitCode: 2, outcome: "refused" })}\n`);
          return;
        }
        if (message.op === "status") {
          const summary = message.sinceMs === undefined ? undefined : summariseGhBrokerLog(dir, message.sinceMs);
          conn.end(`${JSON.stringify({ ...broker.status(), heartbeat_interval_s: intervalS, since: summary })}\n`);
          return;
        }
        if (message.op === "stop") {
          conn.end(`${JSON.stringify({ type: "stopped" })}\n`);
          await close();
          return;
        }
        const result = await broker.read(message as GhBrokerReadRequest, (p) => {
          if (!conn.destroyed) conn.write(`${JSON.stringify({ type: "progress", ...p })}\n`);
        });
        if (!conn.destroyed) conn.end(`${JSON.stringify({ type: "result", ...result })}\n`);
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  chmodSync(socketPath, 0o600);
  beat();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      clearInterval(timer);
      rmSync(heartbeat, { force: true });
      // A client still waiting sees a closed connection and falls back to its direct path.
      for (const conn of connections) conn.destroy();
      server.close(() => {
        rmSync(socketPath, { force: true });
        stopped();
        resolve();
      });
    });
    return closing;
  };
  return { socketPath, close, closed };
}

// ── THE CLI ─────────────────────────────────────────────────────────────────────────────────────

export const GH_COMMAND_USAGE = "usage: rmd gh [--class interactive|agent|background] [--fresh] -- <gh args>";

/** The class a caller gets when it names none: W1-T10271's priority order, read from the actor. */
export function defaultGhBrokerClass(env: NodeJS.ProcessEnv = process.env): GhBrokerClass {
  return ghBrokerClassForActor(deriveLedgerActor(env));
}

/** The repository a porcelain read names, without a network call or a git spawn: `-R`, else GH_REPO. An
 *  unnamed repository keys the read by its cwd and is invalidated by a write to that number anywhere. */
function resolvePorcelainRepo(args: readonly string[], env: NodeJS.ProcessEnv): string | undefined {
  return flagValue(args, "-R", "--repo") ?? (env.GH_REPO || undefined);
}

/** Runs a `gh` read directly with inherited stdio when no broker is live; resolves its exit code. */
export function runGhDirect(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("gh", args, { stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** `rmd gh [--class c] [--fresh] -- <gh args>`: prints exactly what `gh` would and exits with its code. */
export async function ghCommand(
  rest: string[],
  env: NodeJS.ProcessEnv = process.env,
  runDirect: (args: string[]) => number | Promise<number> = runGhDirect,
  read: typeof brokerGhRead = brokerGhRead,
  write: (stream: "stdout" | "stderr", text: string) => void = (stream, text) => void process[stream].write(text),
): Promise<number> {
  const out = (t: string) => write("stdout", t);
  const err = (t: string) => write("stderr", t);
  const dash = rest.indexOf("--");
  if (dash < 0) {
    err(`${GH_COMMAND_USAGE}\n`);
    return 2;
  }
  let cls = defaultGhBrokerClass(env);
  let fresh = false;
  const flags = rest.slice(0, dash);
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] === "--fresh") fresh = true;
    else if (flags[i] === "--class" && isGhBrokerClass(flags[i + 1])) cls = flags[(i += 1)] as GhBrokerClass;
    else {
      err(`${GH_COMMAND_USAGE}\n`);
      return 2;
    }
  }
  const args = rest.slice(dash + 1);
  if (args.length === 0) {
    err(`${GH_COMMAND_USAGE}\n`);
    return 2;
  }
  // A READ CLIENT. A write (the one write rule, ghArgvIsWrite) or any `auth` call is refused, never run:
  // run here it would pass hooks/deny-floor.sh's gh rules, which judge the command a session typed.
  const cwd = process.cwd();
  if (args[0] === "auth" || ghArgvIsWrite(args, { cwd })) {
    err(`rmd gh: refused - rmd gh serves GitHub reads only, and \`gh ${args.slice(0, 2).join(" ")}\` is ${args[0] === "auth" ? "an auth call" : "a write"}.\n`);
    err("  Run it as a plain `gh` call, where the deny floor judges it.\n");
    return 2;
  }
  if (apiUsesStdin(args)) return runDirect(args);
  const socketPath = ghReadBrokerLive(env);
  if (socketPath === undefined) return runDirect(args);
  try {
    const result = await read(socketPath, args, {
      class: cls, caller: ghBrokerCallerId(env), fresh, cwd, repo: resolvePorcelainRepo(args, env),
      onProgress: (p) => err(`gh-broker: queued, position ${p.position}, about ${Math.ceil(p.expectedWaitMs / 1000)}s\n`),
    });
    out(result.stdout);
    err(result.stderr);
    return result.exitCode;
  } catch (cause) {
    // The broker went away mid-read: answer the caller the old way rather than not at all.
    err(`gh-broker: unreachable (${String((cause as Error)?.message ?? cause)}); running gh directly\n`);
    return runDirect(args);
  }
}

export const GH_BROKER_USAGE = "usage: rmd gh-broker serve | status [--since <dur>] | stop";

/** `<n>s|m|h|d` to milliseconds. */
export function parseGhBrokerDuration(raw: string | undefined): number | undefined {
  const m = /^([0-9]+)([smhd])$/.exec(raw ?? "");
  if (!m) return undefined;
  return Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
}

/** `rmd gh-broker serve|status|stop`. `serve` is injected by the CLI (run-task.ts), which owns the process. */
export async function ghBrokerCommand(
  rest: string[],
  serve: (dir: string) => Promise<GhReadBrokerServer>,
  env: NodeJS.ProcessEnv = process.env,
  print: (text: string) => void = (t) => void process.stdout.write(t),
): Promise<number> {
  const dir = ghBrokerDir(env);
  if (dir === undefined) {
    print("gh-broker: no cache root (set the GitHub cache home or HOME)\n");
    return 2;
  }
  const sub = rest[0];
  if (sub === "serve") {
    const server = await serve(dir);
    print(`gh-broker: serving ${server.socketPath}\n`);
    await server.closed;
    return 0;
  }
  if (sub === "status" || sub === "stop") {
    const sinceRaw = rest[1] === "--since" ? rest[2] : undefined;
    const sinceDur = parseGhBrokerDuration(sinceRaw);
    if (sub === "status" && rest.length > 1 && sinceDur === undefined) {
      print(`${GH_BROKER_USAGE}\n`);
      return 2;
    }
    const socketPath = ghReadBrokerLive(env);
    if (socketPath === undefined) {
      print("gh-broker: not running (no live heartbeat)\n");
      return 1;
    }
    const reply = await brokerRequest(socketPath, sub === "stop"
      ? { op: "stop" }
      : { op: "status", sinceMs: sinceDur === undefined ? undefined : systemClock.now() - sinceDur });
    print(`${JSON.stringify(reply, null, 2)}\n`);
    return 0;
  }
  print(`${GH_BROKER_USAGE}\n`);
  return 2;
}
