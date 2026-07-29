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
 *     `daemon.iteration`/etc each fire on a DIFFERENT branch) — but every branch that does not
 *     exit the process logs at least one `daemon.`-prefixed line before its next tick. The MAX
 *     `ts` among every `daemon.`-prefixed ledger line is therefore a real, always-advancing "last
 *     poll" signal, with no new unconditional log call needed.
 *   - NEXT-POLL COUNTDOWN: that same winning line's own `poll_interval_ms` (already logged on
 *     most of those lines) added to its `ts`; falls back to an injected default
 *     (`daemon.ts`'s `DEFAULT_POLL_INTERVAL_MS`) when the winning line carries none.
 *   - DISK FREE: `fs.statfsSync(path).bavail * bsize` (real, injectable for tests — the SAME
 *     injectable-implementation shape `ghGateway`'s `exec` option already uses in status.ts).
 *   - RATE-LIMIT REMAINING: `gh api rate_limit`'s `resources.core.remaining` — CORE, not
 *     GraphQL: status.ts's `ghGateway`/`buildBatchedGithub` (the board's own GitHub reads) both
 *     shell real `gh` subcommands (`pr view`/`pr list`/`issue view`), which spend the REST/core
 *     budget, so core is the budget an operator glancing at fleet health actually cares about.
 *     Read via an INJECTABLE `exec: (args: string[]) => string`, mirroring `ghGateway`'s own
 *     pattern (status.ts) so this is unit-testable without a real network call.
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
 * step name is unconditional, and why the max-over-the-prefix is the correct substitute). Ties/
 * out-of-order lines are handled by comparing PARSED timestamps, never assuming ledger order.
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
