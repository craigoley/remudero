import { fixedClock, systemClock } from "./clock.js";
import type { Plan } from "./plan.js";
import type { ReadModelDb, ReadModelStatement } from "./read-model-db.js";

function prNumberFromUrl(url: string): number | undefined {
  const n = Number(url.match(/\/pull\/(\d+)/)?.[1]);
  return Number.isFinite(n) ? n : undefined;
}

export type RecentActivityVerb =
  | "merged"
  | "verdict"
  | "fix"
  | "escalated"
  | "spend"
  | "run-refused"
  | "run-started"
  | "worker"
  | "started"
  | "review"
  | "automerge";

/** Every verb the feed can mint, so a `?verb=` filter can refuse a typo instead of answering empty. */
export const RECENT_ACTIVITY_VERBS: readonly RecentActivityVerb[] = [
  "merged", "verdict", "fix", "escalated", "spend", "run-refused", "run-started", "worker", "started", "review", "automerge",
];

/** The steps that record the daemon's resolution of an operator-initiated console action
 *  (W1-T266) — an allowlist, not a removal of the `!task` guard every other pseudo-id line
 *  ({@link computeRecentActivity}) still gets, since that housekeeping traffic would bury the
 *  feed. These two lines carry the real task id in `line.task`, not `line.task_id`. */
// Why: the 2026-07-31 silent-refusal incident this allowlist fixes —
// docs/forensics/board.md#operator_action_steps
export const OPERATOR_ACTION_STEPS = new Set(["console.kick_refused", "console.kick_dispatched"]);

/** One RECENT row: a single ledger event, not a task's final state — see this section's header. */
export interface RecentActivityEntry {
  taskId: string;
  /** The originating dispatch identity. Task ids can be dispatched again; this is the join key
   *  that keeps a worker's selected-run activity separate from older attempts. */
  runId?: string;
  /** The plan task's own title, so RECENT names what a row is, not just its id. */
  title: string;
  verb: RecentActivityVerb;
  /** ISO-8601 `ts` of the originating ledger line — the feed's relative-timestamp source. */
  ts: string;
  /** The originating step's own outcome label (e.g. a `verdict` string, an escalation `class`). */
  detail?: string;
  /** Present wherever the originating ledger line carries `cost_usd`. */
  costUsd?: number;
  numTurns?: number;
  prNumber?: number;
  prUrl?: string;
  /** Present for `worker.activity` rows; all are bounded/structured, never raw tool payloads. */
  eventKind?: "working" | "tool-executing" | "message";
  eventAt?: string;
  workerRole?: "recon" | "implementer" | "reviewer" | "fixer" | "triage" | "retro" | "unknown";
  /** Provider/model values are assignment or stream metadata, not proof of a served model. */
  provider?: string;
  requestedModel?: string;
  servedModel?: string;
  turnsSoFar?: number;
  toolName?: string;
  toolReason?: string;
  toolStartedAt?: string;
  toolCompletedAt?: string;
  toolDurationMs?: number;
  toolOutcome?: "success" | "error";
  /** GitHub decoration, never a gate — the PR's title, present only when a read resolved it. */
  prTitle?: string;
  /** GitHub decoration attempted and failed for this row's `prUrl` — the row still renders, ledger-only. */
  githubUnavailable?: true;
}

/** PRIMARY CONTROL: bounded rolling history — large enough that `max` (the
 *  feed's visible window) is always a small tail slice of it, never the whole thing. */
export const RECENT_ACTIVITY_HISTORY_CAP = 200;

/** PRIMARY CONTROL: longest refusal reason a RECENT row will carry. See {@link boundedReason}. */
const MAX_REFUSAL_REASON_CHARS = 120;

/** A refusal `reason`, bounded so one row cannot swallow the feed (W1-T266). Truncation is
 *  visible (a trailing ellipsis), never silent — a cut reason must not read as one that was short. */
// Why: the real console.kick_refused reason this bound was sized against — docs/forensics/board.md#boundedreason
function boundedReason(reason: unknown): string {
  if (typeof reason !== "string" || reason === "") return "no reason recorded";
  return reason.length <= MAX_REFUSAL_REASON_CHARS ? reason : `${reason.slice(0, MAX_REFUSAL_REASON_CHARS)}…`;
}

/** Metadata values are identifiers, not prose. Bound them so a malformed ledger row cannot
 *  turn the recent feed into an unbounded payload; unlike a reason, an absent identifier stays
 *  absent instead of being replaced by a success-shaped fallback. */
function boundedRecentTelemetryText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length <= 160 ? text : `${text.slice(0, 159)}…`;
}

function recentPrNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function recentWorkerRole(value: unknown): RecentActivityEntry["workerRole"] {
  return value === "recon" || value === "implementer" || value === "reviewer" || value === "fixer" || value === "triage" || value === "retro" || value === "unknown"
    ? value
    : undefined;
}

/** The activity feed's own event classification: one ledger line in, at most one
 *  {@link RecentActivityEntry} out. Pure and separate from the stateful scan below, so the
 *  mapping is easy to audit. */
export function recentEntryFromLine(
  line: Record<string, unknown>,
  taskId: string,
  title: string,
  ts: string,
  prUrl: string | undefined,
): RecentActivityEntry | undefined {
  const prNumber = prUrl ? prNumberFromUrl(prUrl) : undefined;
  const costUsd = typeof line.cost_usd === "number" ? line.cost_usd : undefined;
  const numTurns = typeof line.num_turns === "number" ? line.num_turns : undefined;
  switch (line.step) {
    case "verdict": {
      const verdict = typeof line.verdict === "string" ? line.verdict : "unknown";
      return { taskId, title, ts, verb: verdict === "merged" ? "merged" : "verdict", detail: verdict, costUsd, prUrl, prNumber };
    }
    // The sweep's merge credit: on the live fleet it is how nearly every merge is recorded, because
    // the run's own `verdict` row closes as blocked_ci or awaiting review long before GitHub merges.
    case "verdict.merged":
      return { taskId, title, ts, verb: "merged", detail: "merged", prUrl, prNumber: prNumber ?? recentPrNumber(line.pr_number) };
    case "run.start":
      return { taskId, title, ts, verb: "started", detail: boundedRecentTelemetryText(line.type) ?? boundedRecentTelemetryText(line.lane) ?? "run" };
    case "review.posted":
      return { taskId, title, ts, verb: "review", detail: boundedRecentTelemetryText(line.state) ?? "posted", prUrl, prNumber };
    case "automerge.armed":
      return { taskId, title, ts, verb: "automerge", detail: "armed", prUrl, prNumber: prNumber ?? recentPrNumber(line.pr_number) };
    case "fix.dispatch":
      return { taskId, title, ts, verb: "fix", detail: `dispatched (strike ${String(line.strike ?? "?")})`, prUrl, prNumber };
    case "fix.done":
      return { taskId, title, ts, verb: "fix", detail: `done (strike ${String(line.strike ?? "?")})`, costUsd, numTurns, prUrl, prNumber };
    case "fix.exhausted":
      return { taskId, title, ts, verb: "fix", detail: `exhausted (${String(line.strikes ?? "?")} strikes)`, prUrl, prNumber };
    case "escalation.issue_opened":
      return { taskId, title, ts, verb: "escalated", detail: typeof line.class === "string" ? line.class : undefined, prUrl, prNumber };
    case "implement.done":
      return { taskId, title, ts, verb: "spend", costUsd, numTurns, prUrl, prNumber };
    case "worker.activity": {
      const workerRole = recentWorkerRole(line.worker_role);
      const provider = boundedRecentTelemetryText(line.provider);
      const requestedModel = boundedRecentTelemetryText(line.requested_model);
      const servedModel = boundedRecentTelemetryText(line.served_model);
      return {
        taskId,
        title,
        ts,
        verb: "worker",
        detail: typeof line.event_kind === "string" ? line.event_kind : "activity",
        eventKind:
          line.event_kind === "working" || line.event_kind === "tool-executing" || line.event_kind === "message"
            ? line.event_kind
            : undefined,
        ...(typeof line.event_at === "string" ? { eventAt: line.event_at } : {}),
        ...(workerRole ? { workerRole } : {}),
        ...(provider ? { provider } : {}),
        ...(requestedModel ? { requestedModel } : {}),
        ...(servedModel ? { servedModel } : {}),
        ...(typeof line.turns_so_far === "number" && Number.isFinite(line.turns_so_far) && line.turns_so_far >= 0
          ? { turnsSoFar: line.turns_so_far }
          : {}),
        ...(typeof line.tool_name === "string" ? { toolName: line.tool_name } : {}),
        ...(typeof line.tool_reason === "string" ? { toolReason: line.tool_reason } : {}),
        ...(typeof line.tool_started_at === "string" ? { toolStartedAt: line.tool_started_at } : {}),
        ...(typeof line.tool_completed_at === "string" ? { toolCompletedAt: line.tool_completed_at } : {}),
        ...(typeof line.tool_duration_ms === "number" ? { toolDurationMs: Math.max(0, line.tool_duration_ms) } : {}),
        ...(line.tool_outcome === "success" || line.tool_outcome === "error" ? { toolOutcome: line.tool_outcome } : {}),
        prUrl,
        prNumber,
      };
    }
    // W1-T266 — the daemon's resolution of an operator's Run click. See OPERATOR_ACTION_STEPS.
    // The `reason` is carried VERBATIM (bar the length bound below) rather than mapped to
    // friendlier prose: a translation table here would be a second place for the truth to live,
    // and this codebase has had three false comments cause live operator-visible defects in one
    // week. The verb label supplies the plain-English framing ("Run refused"); the reason
    // supplies the fact.
    case "console.kick_refused":
      return { taskId, title, ts, verb: "run-refused", detail: boundedReason(line.reason) };
    case "console.kick_dispatched":
      return { taskId, title, ts, verb: "run-started", detail: "dispatched from the console" };
    default:
      return undefined;
  }
}

const RECENT_DDL = `
  CREATE TABLE IF NOT EXISTS recent_instance(k INTEGER PRIMARY KEY, instance TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS recent_entry(instance TEXT NOT NULL, ts TEXT NOT NULL, ts_ms INTEGER NOT NULL,
    seq INTEGER NOT NULL, verb TEXT NOT NULL, task_id TEXT NOT NULL, run_id TEXT, pr_url TEXT,
    cost_usd REAL, detail TEXT, body TEXT NOT NULL, PRIMARY KEY(instance, ts_ms, seq)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS recent_merge(instance TEXT NOT NULL, ts_ms INTEGER NOT NULL, seq INTEGER NOT NULL,
    task_id TEXT NOT NULL, run_id TEXT, pr_url TEXT, PRIMARY KEY(instance, ts_ms, seq)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS recent_run_pr(instance TEXT NOT NULL, run_id TEXT NOT NULL, ts_ms INTEGER NOT NULL,
    seq INTEGER NOT NULL, pr_url TEXT NOT NULL, PRIMARY KEY(instance, run_id)) WITHOUT ROWID;
`;

type RecentIdentity = { ts: string; tsMs: number; h: bigint };
const statements = new WeakMap<ReadModelDb, { instance: ReadModelStatement; entry: ReadModelStatement; merge: ReadModelStatement; pr: ReadModelStatement; deduplicate: ReadModelStatement; prune: ReadModelStatement }>();

function recentStatements(db: ReadModelDb) {
  let held = statements.get(db);
  if (!held) {
    statements.set(db, held = {
      instance: db.prepare("INSERT OR IGNORE INTO recent_instance(k, instance) VALUES(1, ?)"),
      entry: db.prepare(`INSERT OR IGNORE INTO recent_entry(instance, ts, ts_ms, seq, verb, task_id, run_id, pr_url, cost_usd, detail, body)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      merge: db.prepare("INSERT OR IGNORE INTO recent_merge(instance, ts_ms, seq, task_id, run_id, pr_url) VALUES(?, ?, ?, ?, ?, ?)"),
      pr: db.prepare(`INSERT INTO recent_run_pr(instance, run_id, ts_ms, seq, pr_url) VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(instance, run_id) DO UPDATE SET ts_ms = excluded.ts_ms, seq = excluded.seq, pr_url = excluded.pr_url
        WHERE (excluded.ts_ms, excluded.seq) > (recent_run_pr.ts_ms, recent_run_pr.seq)`),
      deduplicate: db.prepare(`DELETE FROM recent_entry WHERE instance = ? AND verb = 'merged' AND (ts_ms, seq) NOT IN
        (SELECT ts_ms, seq FROM (SELECT e.ts_ms, e.seq, ROW_NUMBER() OVER
          (PARTITION BY e.task_id, COALESCE(e.pr_url, p.pr_url) ORDER BY e.ts_ms DESC, e.seq DESC) AS rank
          FROM recent_entry e LEFT JOIN recent_run_pr p ON p.instance = e.instance AND p.run_id = e.run_id
          WHERE e.instance = ? AND e.verb = 'merged') WHERE rank = 1)`),
      prune: db.prepare(`DELETE FROM recent_entry WHERE instance = ? AND (ts_ms, seq) NOT IN
        (SELECT ts_ms, seq FROM recent_entry WHERE instance = ? ORDER BY ts_ms DESC, seq DESC LIMIT ${RECENT_ACTIVITY_HISTORY_CAP})`),
    });
  }
  return held;
}

/** Applied inside the projector's fenced transaction; seq is the exact-line hash, not ingest order. */
export function projectRecentEntry(db: ReadModelDb, instance: string, line: Record<string, unknown>, id: RecentIdentity): void {
  const ts = typeof line.ts === "string" ? line.ts : "";
  const tsMs = Date.parse(ts);
  if (!Number.isFinite(tsMs)) return;
  const runId = typeof line.run_id === "string" ? line.run_id : undefined;
  const prUrl = typeof line.pr_url === "string" ? line.pr_url : undefined;
  const sql = recentStatements(db);
  sql.instance.run(instance);
  if (line.step === "pr.opened" && runId && prUrl) {
    sql.pr.run(instance, runId, tsMs, id.h, prUrl);
    sql.deduplicate.run(instance, instance);
  }
  const operator = typeof line.step === "string" && OPERATOR_ACTION_STEPS.has(line.step);
  const taskId = operator && typeof line.task === "string" ? line.task : typeof line.task_id === "string" ? line.task_id : undefined;
  if (!taskId) return;
  const entry = recentEntryFromLine(line, taskId, taskId, ts, prUrl);
  if (!entry) return;
  if (runId) entry.runId = runId;
  sql.entry.run(instance, ts, tsMs, id.h, entry.verb, taskId, runId ?? null, prUrl ?? null, entry.costUsd ?? null, entry.detail ?? null, JSON.stringify(entry));
  if (entry.verb === "merged") {
    sql.merge.run(instance, tsMs, id.h, taskId, runId ?? null, prUrl ?? null);
    sql.deduplicate.run(instance, instance);
  }
  sql.prune.run(instance, instance);
}

/** Structural LedgerRowProjection typing keeps this leaf independent of its registering module. */
export const RECENT_ROW_PROJECTION = {
  name: "recent_entry",
  version: 1,
  tables: ["recent_instance", "recent_entry", "recent_merge", "recent_run_pr"],
  ddl: RECENT_DDL,
  markers: ['"step":'],
  apply(db: ReadModelDb, _line: string, id: RecentIdentity, parse: () => Record<string, unknown> | undefined): void {
    const row = parse();
    if (!row) return;
    if (typeof row.ts !== "string" || !Number.isFinite(Date.parse(row.ts))) return;
    // The oracle copies this context with the projection tables into its scratch database.
    const context = db.prepare("SELECT instance FROM recent_instance WHERE k = 1").get();
    const instance = context ? String(context.instance) : db.meta("instance");
    if (!instance) throw new Error("recent projection requires read-model instance metadata");
    projectRecentEntry(db, instance, row, id);
  },
};

export interface RecentReadOptions {
  plan?: Plan;
  verbs?: ReadonlySet<string>;
  limit?: number;
  nowMs?: number;
}

/** The merge index outlives the bounded feed, so today's count remains exact after pruning. */
export function readRecentActivity(db: ReadModelDb, instance: string, opts: RecentReadOptions = {}): { entries: RecentActivityEntry[]; mergedToday: number } {
  const limit = opts.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > RECENT_ACTIVITY_HISTORY_CAP) throw new RangeError(`limit must be an integer from 1 to ${RECENT_ACTIVITY_HISTORY_CAP}`);
  if (opts.verbs && [...opts.verbs].some((verb) => !RECENT_ACTIVITY_VERBS.includes(verb as RecentActivityVerb))) throw new RangeError("unknown recent verb");
  const rows = db.prepare(`SELECT e.body, e.verb, COALESCE(e.pr_url, p.pr_url) AS pr_url FROM recent_entry e
    LEFT JOIN recent_run_pr p ON p.instance = e.instance AND p.run_id = e.run_id
    WHERE e.instance = ? ORDER BY e.ts_ms DESC, e.seq DESC`).all(instance);
  const entries: RecentActivityEntry[] = [];
  const merges = new Set<string>();
  for (const row of rows) {
    const entry = JSON.parse(String(row.body)) as RecentActivityEntry;
    const task = opts.plan?.byId.get(entry.taskId);
    if (opts.plan && !task && entry.verb !== "run-refused" && entry.verb !== "run-started") continue;
    entry.title = task?.title ?? entry.taskId;
    if (row.pr_url !== null && entry.verb !== "started" && entry.verb !== "run-refused" && entry.verb !== "run-started") {
      entry.prUrl = String(row.pr_url);
      entry.prNumber = prNumberFromUrl(entry.prUrl) ?? entry.prNumber;
    }
    if (entry.verb === "merged") {
      const key = JSON.stringify([entry.taskId, entry.prUrl ?? null]);
      if (merges.has(key)) continue;
      merges.add(key);
    }
    if (!opts.verbs || opts.verbs.has(entry.verb)) entries.push(entry);
  }
  const midnight = (opts.nowMs === undefined ? systemClock : fixedClock(opts.nowMs)).date();
  midnight.setUTCHours(0, 0, 0, 0);
  const today = midnight.getTime();
  const counted = db.prepare(`SELECT m.task_id FROM recent_merge m
    LEFT JOIN recent_run_pr p ON p.instance = m.instance AND p.run_id = m.run_id
    WHERE m.instance = ? GROUP BY m.task_id, COALESCE(m.pr_url, p.pr_url)
    HAVING MAX(m.ts_ms) >= ? AND MAX(m.ts_ms) < ?`).all(instance, today, today + 86400000);
  const mergedToday = counted.filter((row) => !opts.plan || opts.plan.byId.has(String(row.task_id))).length;
  return { entries: entries.slice(0, limit), mergedToday };
}
