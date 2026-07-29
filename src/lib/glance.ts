/**
 * lib/glance.ts — the GLANCE layer's server side (W1-T159, MASTER-PLAN §7/§9): the pinned
 * summary strip's numbers, its anomaly emphasis, and the daemon-health widget's data — every
 * figure traced to a NAMED source, never a decorative estimate (the task's own acceptance bar).
 *
 * TRACEABILITY, BY CONSTRUCTION: `running`/`needsMe`/`blocked`/`queued` are the SAME
 * StatusProjection fields W1-T155's taxonomy already derives (board.ts's `computeBoardSnapshot`
 * — this module takes its `tasks`, never re-derives status itself); `mergedToday`/spend-today/
 * spend-this-week are summed straight off the ledger's own `verdict`/`cost_usd` lines (spend
 * reuses W1-T148's `deriveDayCostUsd`/`deriveWeekCostUsd` verbatim, sweep.ts); daemon-health's
 * last-poll/next-poll come from the daemon's own heartbeat ledger lines, disk-free from a real
 * `statfs` read, and rate-limit-remaining from a real `gh api rate_limit` probe. Nothing here is
 * a hardcoded/placeholder number — the FALSIFIER this task's first acceptance criterion names.
 */

import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { statfsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { computeBoardSnapshot, isRunningRow, type BoardDeps, type BoardRow } from "./board.js";
import { readLedgerLines } from "./status.js";
import { deriveDayCostUsd, deriveWeekCostUsd } from "./sweep.js";
import type { Route } from "./service.js";

/** One 24h window, in ms — the "needs-me older than 24h" anomaly threshold (design note text). */
const STALE_NEEDS_ME_MS = 24 * 60 * 60 * 1000;

// ── COUNTS — every figure a pass-through of an already-named source ──────────────────────────

export interface GlanceCounts {
  total: number;
  running: number;
  needsMe: number;
  blocked: number;
  queued: number;
  /** Ledger-native: distinct task ids with a `verdict: "merged"` line whose `ts` falls on
   *  `now`'s UTC calendar day — the SAME boundary {@link deriveDayCostUsd} uses for "today". */
  mergedToday: number;
  /** False when the GitHub read backing the taxonomy's merge-state was unreachable this
   *  snapshot — mirrors board.ts's `CountSummary.merged_known` (the strip must not render a
   *  degraded read as though it were a confirmed fact). */
  taxonomy_known: boolean;
}

/** Distinct `task_id`s with a `verdict: "merged"` ledger line dated `now`'s UTC calendar day. */
function mergedTodayTaskIds(lines: ReadonlyArray<Record<string, unknown>>, now: number): string[] {
  const day = new Date(now).toISOString().slice(0, 10);
  const ids = new Set<string>();
  for (const line of lines) {
    if (line.step !== "verdict" || line.verdict !== "merged") continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    if (!ts || !ts.startsWith(day)) continue;
    if (typeof line.task_id === "string") ids.add(line.task_id);
  }
  return [...ids];
}

/**
 * The strip's six counts, derived from the SAME `tasks` array W1-T155's taxonomy already
 * computed (never a second, disagreeing predicate — standing rule 22) plus one ledger scan for
 * `mergedToday` (the one bucket the taxonomy itself does not carry, board.ts's `summarizeCounts`
 * only ever totals ALL-TIME merges).
 */
export function computeGlanceCounts(
  tasks: ReadonlyArray<Pick<BoardRow, "phase" | "status" | "needsHuman">>,
  lines: ReadonlyArray<Record<string, unknown>>,
  now: number,
  taxonomyKnown: boolean,
): GlanceCounts {
  return {
    total: tasks.length,
    running: tasks.filter(isRunningRow).length,
    needsMe: tasks.filter((t) => t.needsHuman === true).length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
    queued: tasks.filter((t) => t.status === "queued").length,
    mergedToday: mergedTodayTaskIds(lines, now).length,
    taxonomy_known: taxonomyKnown,
  };
}

// ── ANOMALY EMPHASIS — "is everything okay?", not merely a count ─────────────────────────────

export interface GlanceAnomalies {
  /** Task ids currently in-flight (`phase` present) whose `elapsedMs` exceeds ITS OWN phase's
   *  threshold — the SAME per-row check `nowRowHtml`/`tickElapsed` already run client-side
   *  (serve.ts, W1-T183), rolled up here so the STRIP itself surfaces it, not only the row. */
  phaseBreachTaskIds: string[];
  /** Needs-me task ids whose most recent `escalation.issue_opened` ledger line is older than
   *  {@link STALE_NEEDS_ME_MS} (24h) — the W1-T1-at-27h21m falsifier this criterion names. */
  staleNeedsMeTaskIds: string[];
  /** True iff either list above is non-empty — the strip's single "look here" signal. */
  hasAnomaly: boolean;
}

/** Each needs-me task id's most recent `escalation.issue_opened` line `ts` (ledger is
 *  append-only, so the LAST matching line scanned is the latest — mirrors status.ts's own
 *  "last one wins" idiom, e.g. `latestEscalationLine`). */
function latestEscalationOpenedTs(lines: ReadonlyArray<Record<string, unknown>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines) {
    if (line.step !== "escalation.issue_opened") continue;
    const taskId = typeof line.task_id === "string" ? line.task_id : undefined;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    if (!taskId || !ts) continue;
    out.set(taskId, ts);
  }
  return out;
}

export function computeGlanceAnomalies(
  tasks: ReadonlyArray<Pick<BoardRow, "taskId" | "phase" | "elapsedMs" | "needsHuman">>,
  lines: ReadonlyArray<Record<string, unknown>>,
  now: number,
  phaseElapsedThresholdsMs: Record<string, number>,
): GlanceAnomalies {
  const phaseBreachTaskIds = tasks
    .filter((t) => t.phase != null && typeof t.elapsedMs === "number")
    .filter((t) => (t.elapsedMs as number) > (phaseElapsedThresholdsMs[t.phase as string] ?? phaseElapsedThresholdsMs.default ?? Infinity))
    .map((t) => t.taskId);

  const escalationTsByTask = latestEscalationOpenedTs(lines);
  const staleNeedsMeTaskIds = tasks
    .filter((t) => t.needsHuman === true)
    .filter((t) => {
      const ts = escalationTsByTask.get(t.taskId);
      if (!ts) return false; // no escalation-open line to date it by -- never guessed as stale.
      return now - Date.parse(ts) > STALE_NEEDS_ME_MS;
    })
    .map((t) => t.taskId);

  return { phaseBreachTaskIds, staleNeedsMeTaskIds, hasAnomaly: phaseBreachTaskIds.length > 0 || staleNeedsMeTaskIds.length > 0 };
}

// ── DAEMON HEALTH — last poll, a live next-poll ETA, disk free, rate-limit remaining ─────────

export interface DaemonHealth {
  /** ISO ts of the most recent `daemon.*` heartbeat ledger line (daemon.ts's `daemon.idle`/
   *  `daemon.pause`/`daemon.headroom*`) — undefined when the ledger carries none yet. */
  lastPollAt?: string;
  /** That same line's own `poll_interval_ms` (daemon.ts's `DEFAULT_POLL_INTERVAL_MS` unless
   *  overridden) — the daemon's OWN stated cadence, never a guessed constant here. */
  pollIntervalMs?: number;
  /** `lastPollAt + pollIntervalMs`, ISO — undefined unless both inputs above are present. */
  nextPollEta?: string;
  /** Free bytes on the ledger's own filesystem (`statfsSync(dirname(ledgerPath))`), or
   *  undefined if the read itself failed (never a fabricated 0/Infinity). */
  diskFreeBytes?: number;
  /** `gh api rate_limit`'s live `.rate.remaining`, or undefined if the probe failed
   *  (auth/network/rate-limited-on-the-probe-itself) — never a placeholder number. */
  rateLimitRemaining?: number;
}

const DAEMON_HEARTBEAT_STEPS = new Set(["daemon.idle", "daemon.pause", "daemon.headroom", "daemon.headroom.degraded", "daemon.headroom.unavailable"]);

/** The most recent `daemon.*` heartbeat line's `ts` + `poll_interval_ms` — ledger append-only,
 *  so the LAST matching line scanned is the latest, mirroring every other "last one wins" scan
 *  in this codebase (status.ts's `latestEscalationLine`, board.ts's `lastActivityByTask`). */
export function computeDaemonHeartbeat(lines: ReadonlyArray<Record<string, unknown>>): { lastPollAt?: string; pollIntervalMs?: number } {
  let lastPollAt: string | undefined;
  let pollIntervalMs: number | undefined;
  for (const line of lines) {
    if (typeof line.step !== "string" || !DAEMON_HEARTBEAT_STEPS.has(line.step)) continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    if (!ts) continue;
    lastPollAt = ts;
    if (typeof line.poll_interval_ms === "number") pollIntervalMs = line.poll_interval_ms;
  }
  return { lastPollAt, pollIntervalMs };
}

/** Real disk-free read (bytes) — fails soft to undefined (a mount error, an unsupported
 *  platform) rather than fabricating a number the daemon-health widget would render as fact. */
export function readDiskFreeBytes(path: string, statfs: typeof statfsSync = statfsSync): number | undefined {
  try {
    const s = statfs(path);
    return s.bavail * s.bsize;
  } catch {
    return undefined;
  }
}

/** Real `gh api rate_limit` probe, returning the actual remaining count (not merely a boolean
 *  warning, unlike retro.ts's `probeGithubThrottle` — the daemon-health widget needs the number
 *  itself). Fails soft to undefined on any probe error (auth expiry, network outage, `gh`
 *  missing) — the widget then renders "unknown", never a fabricated remaining count. */
export function readGithubRateLimitRemaining(exec: typeof execFileSync = execFileSync): number | undefined {
  try {
    const out = String(exec("gh", ["api", "rate_limit", "--jq", ".rate.remaining"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** {@link readDiskFreeBytes}/{@link readGithubRateLimitRemaining}'s combined result — the ONLY
 *  two {@link DaemonHealth} fields worth caching (see {@link createProbeCache}'s own doc: every
 *  other field is a cheap in-memory ledger scan that must NEVER read stale). */
interface ProbeResult {
  diskFreeBytes?: number;
  rateLimitRemaining?: number;
}

function computeDaemonHealth(lines: ReadonlyArray<Record<string, unknown>>, probe: ProbeResult): DaemonHealth {
  const heartbeat = computeDaemonHeartbeat(lines);
  const nextPollEta =
    heartbeat.lastPollAt && heartbeat.pollIntervalMs != null
      ? new Date(Date.parse(heartbeat.lastPollAt) + heartbeat.pollIntervalMs).toISOString()
      : undefined;
  return { ...heartbeat, nextPollEta, ...probe };
}

// ── THE GLANCE SNAPSHOT — GET /v1/glance's body ───────────────────────────────────────────────

export interface GlanceSnapshot {
  generated_at: string;
  counts: GlanceCounts;
  spend: { todayUsd: number; weekUsd: number };
  anomalies: GlanceAnomalies;
  daemonHealth: DaemonHealth;
}

export interface GlanceDeps extends BoardDeps {
  /** DATA, not a constant baked in here — the SAME per-phase thresholds ServeDeps.
   *  phaseElapsedThresholdsMs / DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS already name (serve.ts),
   *  passed in by the caller so this module never imports serve.ts (would cycle back through
   *  board.ts) and never re-declares a second copy of the same policy data. */
  phaseElapsedThresholdsMs: Record<string, number>;
  /** Directory `statfsSync` reads for {@link DaemonHealth.diskFreeBytes} — defaults to the
   *  ledger's own directory (the volume that actually matters: worker-scratch/ledger writes
   *  land there). */
  diskPath?: string;
  /** Injection seams for a test — real `execFileSync`/`statfsSync` otherwise. */
  execFile?: typeof execFileSync;
  statfs?: typeof statfsSync;
}

/**
 * `probe` is OPTIONAL: a direct/unit-test caller omits it and gets a genuinely fresh
 * disk/rate-limit read every call (see {@link readDiskFreeBytes}/{@link readGithubRateLimitRemaining});
 * {@link buildGlanceRoute} supplies a {@link createProbeCache}-backed one so a polling client
 * does not shell out to `gh`/`statfs` on every single request. EVERYTHING ELSE here — counts,
 * spend, anomalies, the daemon heartbeat — is a cheap in-memory ledger reduction, recomputed
 * FRESH on every call, NEVER cached: a stale needs-me count here would silently fight the SSE
 * `needs-human` event's own, faster-arriving truth (board.ts's buildStatusStream) — the exact
 * race a whole-snapshot TTL cache produced during this task's own review (the browser tab title
 * flipped correctly on the SSE event, then flipped BACK on the next stale poll).
 */
export function computeGlanceSnapshot(deps: GlanceDeps, now: number = Date.now(), probe?: ProbeResult): GlanceSnapshot {
  const readLedger = deps.readLedger ?? readLedgerLines;
  const lines = readLedger(deps.ledgerPath);
  const board = computeBoardSnapshot({ ...deps, readLedger: () => lines });
  const resolvedProbe: ProbeResult = probe ?? {
    diskFreeBytes: readDiskFreeBytes(deps.diskPath ?? dirname(deps.ledgerPath), deps.statfs ?? statfsSync),
    rateLimitRemaining: readGithubRateLimitRemaining(deps.execFile ?? execFileSync),
  };
  return {
    generated_at: new Date(now).toISOString(),
    counts: computeGlanceCounts(board.tasks, lines, now, board.counts.merged_known),
    spend: { todayUsd: deriveDayCostUsd(lines, now), weekUsd: deriveWeekCostUsd(lines, now) },
    anomalies: computeGlanceAnomalies(board.tasks, lines, now, deps.phaseElapsedThresholdsMs),
    daemonHealth: computeDaemonHealth(lines, resolvedProbe),
  };
}

/**
 * Memoizes ONLY {@link readDiskFreeBytes}/{@link readGithubRateLimitRemaining} — the two fields
 * on this snapshot that are an actual subprocess/syscall, not a ledger scan — behind a short TTL,
 * so a client polling every few seconds does not shell out to `gh api rate_limit`/`statfs` on
 * every single request. Deliberately NOT a whole-snapshot cache (see {@link computeGlanceSnapshot}'s
 * own doc for the staleness bug that shape produced).
 */
export interface ProbeCache {
  get(exec: typeof execFileSync, statfs: typeof statfsSync, diskPath: string, now?: number): ProbeResult;
}

const DEFAULT_PROBE_CACHE_TTL_MS = 4000;

export function createProbeCache(ttlMs = DEFAULT_PROBE_CACHE_TTL_MS): ProbeCache {
  let cached: { computedAtMs: number; result: ProbeResult } | undefined;
  return {
    get(exec, statfs, diskPath, now: number = Date.now()): ProbeResult {
      if (cached && now - cached.computedAtMs < ttlMs) return cached.result;
      const result: ProbeResult = { diskFreeBytes: readDiskFreeBytes(diskPath, statfs), rateLimitRemaining: readGithubRateLimitRemaining(exec) };
      cached = { computedAtMs: now, result };
      return result;
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** GET /v1/glance — the GLANCE strip + daemon-health widget's data, read-scoped. Counts/spend/
 *  anomalies are always fresh (see {@link computeGlanceSnapshot}); disk-free/rate-limit are
 *  probe-cached (see {@link createProbeCache}). */
export function buildGlanceRoute(deps: GlanceDeps): Route {
  const probeCache = createProbeCache();
  return {
    method: "GET",
    path: "/v1/glance",
    scope: "read",
    handler: (_req, res) => {
      const now = Date.now();
      const probe = probeCache.get(deps.execFile ?? execFileSync, deps.statfs ?? statfsSync, deps.diskPath ?? dirname(deps.ledgerPath), now);
      sendJson(res, 200, computeGlanceSnapshot(deps, now, probe));
    },
  };
}
