/**
 * lib/daemon-health.ts — the GLANCE layer's daemon-health widget (W1-T159, MASTER-PLAN §7/§9):
 * last poll, a live next-poll countdown, disk free, and rate-limit remaining, each traced to a
 * real source — never a placeholder (the task's own falsifier: "a widget with a placeholder
 * value fails").
 *
 * SOURCES (verified from source, not assumed — the task's design note explicitly distrusts its
 * own recon here):
 *   - LAST POLL: `src/lib/daemon.ts`'s `runDaemon` loop has no SINGLE ledger step name that fires
 *     unconditionally every tick (`daemon.pause`/`daemon.headroom`/`daemon.idle`/
 *     `daemon.iteration`/etc each fire on a DIFFERENT branch). W1-T1274 CORRECTS A FALSE CLAIM
 *     THAT USED TO STAND HERE: "every branch that does not exit the process logs at least one
 *     `daemon.`-prefixed line before its next tick" was MEASURED FALSE — the prefix went silent
 *     for 102.5 minutes on 2026-08-23 while the daemon stayed alive, because the only RECURRING
 *     `daemon.`-prefixed emitter (`daemon.alive`) is a ticker confined to three windows (retro,
 *     full sweep, dispatch settling), and every stretch of the loop outside those three — plain
 *     inter-iteration sleep, or an early return at the freshness check — wrote nothing with this
 *     prefix at all. `runDaemon` now writes an UNCONDITIONAL `daemon.tick` row as the first
 *     statement of every iteration, on every path, which is what makes the MAX `ts` among every
 *     `daemon.`-prefixed ledger line a real, always-advancing "last poll" signal today.
 *   - NEXT-POLL COUNTDOWN: that same winning line's own `poll_interval_ms` (already logged on
 *     most of those lines) added to its `ts`; falls back to an injected default
 *     (`daemon.ts`'s `DEFAULT_POLL_INTERVAL_MS`) when the winning line carries none.
 *   - DISK FREE: `fs.statfsSync(path).bavail * bsize` (real, injectable for tests — the SAME
 *     injectable-implementation shape `ghGateway`'s `exec` option already uses in status.ts).
 *   - RATE-LIMIT REMAINING (this widget's own display value): `gh api rate_limit`'s
 *     `resources.core.remaining` — CORE, not GraphQL: status.ts's `ghGateway`/
 *     `buildBatchedGithub` (the board's own GitHub reads) both shell real `gh` subcommands
 *     (`pr view`/`pr list`/`issue view`), which spend the REST/core budget, so core is the
 *     budget an operator glancing at fleet health actually cares about. Read via an
 *     INJECTABLE `exec: (args: string[]) => string`, mirroring `ghGateway`'s own pattern
 *     (status.ts) so this is unit-testable without a real network call.
 *
 * W1-T372 (the daemon's TICK, not this widget's pull-only display): the CORE-only choice
 * above was correct for a GLANCE widget but left the daemon itself blind to the OTHER bucket
 * — GraphQL, which `gh pr create`/`gh pr view --json` actually spend, and which has sat at
 * 0/5000 while core held thousands unused. {@link readGhRateLimitBuckets} reads BOTH buckets
 * off the SAME `gh api rate_limit` payload {@link readGhRateLimitRemaining} already fetches
 * (never a second exec call for the second number) and is consulted from `runDaemon`'s tick
 * (daemon.ts), not from this route.
 */

import { statfsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { ServerResponse } from "node:http";
import { readLedgerLines, type LedgerReader } from "./status.js";
import { DEFAULT_POLL_INTERVAL_MS } from "./daemon.js";
import type { Route } from "./service.js";

/** {@link deriveLastPoll}'s result — see this module's header for each field's own source. */
export interface DaemonPollInfo {
  /** ISO-8601 `ts` of the most recent `daemon.`-prefixed ledger line; absent if there is none. */
  lastPollTs?: string;
  /** That line's own `poll_interval_ms`, or the injected default when it carries none. */
  pollIntervalMs: number;
}

/**
 * The MAX `ts` among every ledger line whose `step` starts with `"daemon."` — real, ledger-
 * sourced, and advancing every tick the daemon runs (see this module's header for why no single
 * step name is unconditional, why `runDaemon` now writes one unconditionally regardless
 * (`daemon.tick`, W1-T1274), and why the max-over-the-prefix — never narrowed to `daemon.tick`
 * alone — is the correct read: every OTHER `daemon.`-prefixed line (`daemon.idle`,
 * `daemon.iteration`, `daemon.alive`, boot-time rows, …) is an equally valid, equally real
 * "the daemon is alive" signal, and this reader has always taken the newest of all of them
 * rather than any one step name. Ties/out-of-order lines are handled by comparing PARSED
 * timestamps, never assuming ledger order.
 */
export function deriveLastPoll(
  lines: ReadonlyArray<Record<string, unknown>>,
  defaultPollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): DaemonPollInfo {
  let bestTs: string | undefined;
  let bestParsed = -Infinity;
  let bestPollIntervalMs: number | undefined;
  for (const line of lines) {
    const step = typeof line.step === "string" ? line.step : undefined;
    if (!step || !step.startsWith("daemon.")) continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed) || parsed < bestParsed) continue;
    bestParsed = parsed;
    bestTs = ts;
    bestPollIntervalMs = typeof line.poll_interval_ms === "number" ? line.poll_interval_ms : undefined;
  }
  return { lastPollTs: bestTs, pollIntervalMs: bestPollIntervalMs ?? defaultPollIntervalMs };
}

/** Minimal shape {@link readDiskFreeBytes} needs off a `statfs` result — real `fs.statfsSync`
 *  returns more fields; only these two are consulted. */
export interface StatfsLike {
  bavail: number;
  bsize: number;
}

/**
 * Real disk headroom: `bavail * bsize` (available blocks for an unprivileged process, times
 * block size) — never a decorative estimate. `statfs` is injectable (default the real
 * `fs.statfsSync`) so a test never touches the real filesystem's actual free space. Fails soft
 * (`undefined`, never a fake `0`) on any read error — a caller renders "unknown", not "0 bytes
 * free" as fact, mirroring this codebase's `readFailed`/`indeterminate` discipline elsewhere.
 */
export function readDiskFreeBytes(path: string, statfs: (path: string) => StatfsLike = statfsSync): number | undefined {
  try {
    const stat = statfs(path);
    return stat.bavail * stat.bsize;
  } catch {
    return undefined;
  }
}

/**
 * `gh api rate_limit`'s `resources.core.remaining` — the REST/core budget status.ts's own
 * `gh pr view`/`pr list`/`issue view` calls spend (see this module's header for why core, not
 * graphql). `exec` is injectable exactly like `ghGateway`'s own `opts.exec` (status.ts) — real
 * callers omit it and get the actual `execFileSync("gh", args, ...)` call; a unit test injects a
 * fake so this is provable without a real network call. Fails soft (`undefined`, never a fake
 * number) on any read/parse error.
 */
export function readGhRateLimitRemaining(exec: (args: string[]) => string = defaultGhExec): number | undefined {
  try {
    const parsed = JSON.parse(exec(["api", "rate_limit"])) as { resources?: { core?: { remaining?: number } } };
    const remaining = parsed.resources?.core?.remaining;
    return typeof remaining === "number" ? remaining : undefined;
  } catch {
    return undefined;
  }
}

function defaultGhExec(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** One bucket's reading — {@link readGhRateLimitBuckets}. */
export interface GhRateLimitBucket {
  remaining: number;
  /** ISO-8601, converted from `gh api rate_limit`'s Unix-epoch-seconds `reset` field — the
   *  same string shape `daemon.headroom`'s own `resets_at` already carries, so a quota
   *  exhaustion's dedup episode key (W1-T372) is built the identical way. */
  resetsAt: string;
}

/**
 * Is this bucket out of budget?
 *
 * THE SAME QUESTION `runDaemon`'s quota tick asks, written down once so the drain's end-of-run
 * report cannot come to a different answer about the same reading. `<= 0` rather than `=== 0`
 * mirrors that tick exactly (it clears its latch on `remaining > 0` and escalates otherwise), so
 * a negative reading off a malformed payload keeps reading as exhausted rather than as healthy.
 *
 * THE DAEMON TICK STILL CARRIES ITS OWN INLINE BRANCH, and that is a constraint rather than an
 * oversight: `daemon.ts` imports this module TYPE-ONLY on purpose, because this module imports a
 * VALUE from it (`DEFAULT_POLL_INTERVAL_MS`) — a value import back would be a genuine cycle, which
 * that file's own comment says in as many words. Rewiring it was rejected as scope for a drain
 * reporting change. What guards the drift instead is an EQUIVALENCE TEST that drives the real
 * `runDaemon` tick and the real drain reporter over one shared table of readings and asserts they
 * escalate the same buckets — so tuning either side alone goes red.
 */
export function isBucketExhausted(reading: GhRateLimitBucket): boolean {
  return reading.remaining <= 0;
}

/** Both buckets `gh api rate_limit` reports off ONE payload — {@link readGhRateLimitBuckets}.
 *  Each bucket independently absent (never a fabricated reading) when its own sub-object
 *  could not be read/parsed. */
export interface GhRateLimitBuckets {
  core?: GhRateLimitBucket;
  graphql?: GhRateLimitBucket;
}

interface RawGhRateLimitPayload {
  resources?: {
    core?: { remaining?: number; reset?: number };
    graphql?: { remaining?: number; reset?: number };
  };
}

function parseGhRateLimitBucket(raw: { remaining?: number; reset?: number } | undefined): GhRateLimitBucket | undefined {
  if (!raw || typeof raw.remaining !== "number" || typeof raw.reset !== "number") return undefined;
  return { remaining: raw.remaining, resetsAt: new Date(raw.reset * 1000).toISOString() };
}

/**
 * `gh api rate_limit`'s REST/core AND GraphQL buckets, off a SINGLE exec call — never a
 * second `gh api rate_limit` shell-out to get the second number (this module's header,
 * W1-T372). GraphQL is the bucket `gh pr create`/`gh pr view --json` actually spend, and the
 * one {@link readGhRateLimitRemaining} above never reads — this is the daemon-tick counterpart
 * to that pull-only display value, consulted from `runDaemon` (daemon.ts), never from this
 * route. `exec` is injectable exactly like {@link readGhRateLimitRemaining}'s own seam. Fails
 * soft: `{}` on any read/parse error of the WHOLE payload, and each bucket independently
 * `undefined` (never a fabricated number) when only its own sub-object is missing/malformed —
 * the same discipline `readGhRateLimitRemaining` already applies to `core` alone.
 */
export function readGhRateLimitBuckets(exec: (args: string[]) => string = defaultGhExec): GhRateLimitBuckets {
  try {
    const parsed = JSON.parse(exec(["api", "rate_limit"])) as RawGhRateLimitPayload;
    return {
      core: parseGhRateLimitBucket(parsed.resources?.core),
      graphql: parseGhRateLimitBucket(parsed.resources?.graphql),
    };
  } catch {
    return {};
  }
}

/** {@link buildDaemonHealthRoute}'s dependencies. */
export interface DaemonHealthDeps {
  /** `<root>/state/ledger.ndjson` — the SAME ledger every other daemon-health/board reader tails. */
  ledgerPath: string;
  /** Ledger reader; defaults to reading + parsing NDJSON from disk (mirrors DeriveDeps). */
  readLedger?: LedgerReader;
  /** The path to statfs for disk-free (typically `config.root`'s filesystem). */
  diskPath: string;
  /** Injectable `fs.statfsSync` stand-in — see {@link readDiskFreeBytes}. */
  statfs?: (path: string) => StatfsLike;
  /** Injectable `gh` invocation — see {@link readGhRateLimitRemaining}. */
  exec?: (args: string[]) => string;
  /** Clock; defaults to `Date.now`. Injectable so a test can assert an exact `lastPollAgeMs`. */
  now?: () => number;
  /** Default poll interval when the winning `daemon.*` line carries none of its own. */
  defaultPollIntervalMs?: number;
}

/** `GET /v1/daemon-health`'s body — every field individually optional/absent (never a
 *  placeholder) when its own source could not be read. */
export interface DaemonHealthSnapshot {
  lastPollTs?: string;
  lastPollAgeMs?: number;
  pollIntervalMs: number;
  /** `lastPollTs + pollIntervalMs`, ISO-8601 — the client ticks a LIVE countdown to this instant
   *  (the same `.elapsed[data-started]` ticking mechanism the NOW section already drives, never a
   *  second clock). Absent when there is no `lastPollTs` to add to. */
  nextPollAt?: string;
  diskFreeBytes?: number;
  rateLimitRemaining?: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** `GET /v1/daemon-health` — read-scoped, computed fresh per request (this route is polled at a
 *  much coarser cadence than `/v1/status`, so no memoization layer is warranted). */
export function buildDaemonHealthRoute(deps: DaemonHealthDeps): Route {
  return {
    method: "GET",
    path: "/v1/daemon-health",
    scope: "read",
    handler: (_req, res) => {
      const now = deps.now ?? Date.now;
      const readLedger = deps.readLedger ?? readLedgerLines;
      const lines = readLedger(deps.ledgerPath);
      const poll = deriveLastPoll(lines, deps.defaultPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
      const body: DaemonHealthSnapshot = {
        lastPollTs: poll.lastPollTs,
        lastPollAgeMs: poll.lastPollTs ? Math.max(0, now() - Date.parse(poll.lastPollTs)) : undefined,
        pollIntervalMs: poll.pollIntervalMs,
        nextPollAt: poll.lastPollTs ? new Date(Date.parse(poll.lastPollTs) + poll.pollIntervalMs).toISOString() : undefined,
        diskFreeBytes: readDiskFreeBytes(deps.diskPath, deps.statfs),
        rateLimitRemaining: readGhRateLimitRemaining(deps.exec),
      };
      sendJson(res, 200, body);
    },
  };
}
