/**
 * lib/board.ts — the read-only live board's daemon-side wiring (W3-T2, MASTER-PLAN §7 WS-5a).
 *
 * Narrow v0 vertical slice (the W3-T2 "Option A" decision): ONE daemon route pair — GET
 * /v1/status (REST snapshot) and GET /v1/status/stream (SSE, one `status` event per task
 * whose derived StatusProjection changes) — built entirely on top of the EXISTING mechanism
 * (lib/service.ts's Route/SseRoute) and the EXISTING projection logic (lib/status.ts's
 * projectPlan/deriveStatus). Zero new business logic: this module only wires those two
 * together and tails state/ledger.ndjson to know WHEN to recompute.
 *
 * "A ledger state flip appears in the UI within 2s of the write" (the task's acceptance
 * bar) drives the streaming design: the stream POLLS the ledger file every
 * {@link DEFAULT_POLL_MS} (250ms, comfortably under the 2s budget) rather than relying on
 * `fs.watch`, whose native change-event semantics are not portable across platforms/CI
 * runners (a missed/coalesced event there would silently blow the 2s bar). A poll only does
 * real work (re-deriving a task's status) when the ledger has grown since the last tick, and
 * only SENDS an event when that task's projection actually differs from the last one sent —
 * a state FLIP, not merely "the ledger was touched".
 *
 * Real `rmd serve` CLI wiring (registering these routes on a live createService(...)
 * instance, with a real ghGateway) is a later task's concern — the same split W3-T1a made
 * for the generic mechanism itself (see service.ts's header: "concrete routes... are
 * registered by a later task's real `rmd serve` wiring"). This module is proven directly
 * against a real HTTP server (test/board.test.ts), exactly like test/service.test.ts proves
 * the generic mechanism, with no CLI entry point required to exercise it.
 */

import type { ServerResponse } from "node:http";
import type { Plan, TaskRisk } from "./plan.js";
import { TASK_STATUSES } from "./plan.js";
import { deriveStatus, projectPlan, readLedgerLines, type DeriveDeps, type StatusProjection } from "./status.js";
import type { Route, SseRoute, SseSend } from "./service.js";

/** Ledger poll pace for the SSE stream — comfortably under the 2s acceptance budget. */
export const DEFAULT_POLL_MS = 250;

/**
 * One board row: a {@link StatusProjection} enriched with the two plan-`Task` fields the FIND
 * layer (W1-T157) needs but {@link StatusProjection} deliberately does not carry — `title`
 * (the search bar is over id + title) and `risk` (the risk facet) — plus `lastActivityAt`, the
 * ISO timestamp of the LAST ledger line naming this task (the `recency` sort key).
 *
 * WHY enrich HERE and not on {@link StatusProjection} itself: that interface is MIRRORED by
 * openapi/daemon.yaml's `StatusProjection` schema and consumed by src/lib/daemon.ts +
 * packages/api-client — widening it is a far larger blast radius than this one wire payload
 * needs. `title`/`risk` are a pure in-memory join off `deps.plan.byId` (already held), never a
 * new GitHub/ledger derivation. The SSE `status` stream keeps emitting the bare
 * {@link StatusProjection} (see {@link buildStatusStream}); ONLY this REST snapshot carries the
 * enrichment, and the shell backfills title/risk across subsequent SSE deltas (src/lib/serve.ts).
 */
export interface BoardRow extends StatusProjection {
  title: string;
  risk: TaskRisk;
  /** ISO-8601 `ts` of the last ledger line naming this task; absent when the task has no ledger line at all. */
  lastActivityAt?: string;
}

/** GET /v1/status's body — one {@link BoardRow} per plan task, as of `generated_at`. */
export interface BoardSnapshot {
  generated_at: string;
  tasks: BoardRow[];
}

export interface BoardDeps extends DeriveDeps {
  plan: Plan;
}

/**
 * The last ledger line naming each task id — its append INDEX (recency ordering) and `ts`
 * (the board's `lastActivityAt`). ONE scan, shared by {@link computeBoardSnapshot} (which wants
 * the timestamp) and {@link computeRecentOutcomes} (which wants the index), rather than
 * duplicating the ledger walk in each — factored out per W1-T157's design note.
 */
interface LedgerActivity {
  idx: number;
  ts?: string;
}
function lastActivityByTask(lines: Array<Record<string, unknown>>): Map<string, LedgerActivity> {
  const out = new Map<string, LedgerActivity>();
  lines.forEach((line, i) => {
    if (typeof line.task_id === "string") {
      out.set(line.task_id, { idx: i, ts: typeof line.ts === "string" ? line.ts : undefined });
    }
  });
  return out;
}

/**
 * The board snapshot, reusing {@link projectPlan} verbatim for the merge-state — no new
 * derivation logic. W1-T155's full status taxonomy (in-flight `phase`, `startedAt`/`elapsedMs`,
 * `needsHuman`, `armedAwaitingMerge`) is carried on {@link StatusProjection} itself, so every
 * task gets it for free through that SAME pass-through. W1-T157 additionally joins each
 * projection with its plan `Task`'s `title`/`risk` and the ledger's `lastActivityAt` to produce
 * a {@link BoardRow} (see that interface's note for why the join lives here, not on the shared type).
 */
export function computeBoardSnapshot(deps: BoardDeps): BoardSnapshot {
  const byId = projectPlan(deps.plan, deps);
  const readLedger = deps.readLedger ?? readLedgerLines;
  const lastActivity = lastActivityByTask(readLedger(deps.ledgerPath));
  const tasks: BoardRow[] = [...byId.values()].map((p) => {
    // Every projection's taskId is one of the plan's own tasks (projectPlan derives from
    // deps.plan.tasks), so this lookup is always present — the join is total, never partial.
    const task = deps.plan.byId.get(p.taskId)!;
    const row: BoardRow = { ...p, title: task.title, risk: task.risk };
    const ts = lastActivity.get(p.taskId)?.ts;
    if (ts) row.lastActivityAt = ts;
    return row;
  });
  return { generated_at: new Date().toISOString(), tasks };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** GET /v1/status — the board snapshot, read-scoped. */
export function buildStatusRoute(deps: BoardDeps): Route {
  return {
    method: "GET",
    path: "/v1/status",
    scope: "read",
    handler: (_req, res) => {
      sendJson(res, 200, computeBoardSnapshot(deps));
    },
  };
}

// ── GET /v1/recent — the last ~10 merges/blocks, PR-linked (W1-T153's RECENT section) ──────
//
// W1-T141's `buildRundown` (drain.ts) renders a rundown ONLY from a just-completed
// `DrainSummary` — a live in-memory value a single drain run produces, never persisted or
// queryable after the fact (verified from source, not assumed). RECENT needs a rundown-shaped
// answer to "what happened lately" from a COLD HTTP request, with no live drain run to ask, so
// this reuses W1-T141's own outcome vocabulary (`merged`/`blocked`) over data this module
// already owns: `computeBoardSnapshot`'s per-task terminal status/PR fields, ordered by RECENCY
// via the ledger's own append order (the last ledger line naming a task is the most recent
// thing that happened to it) rather than re-deriving a second timeline.

export type RecentOutcome = "merged" | "blocked";

/** One RECENT row — a terminal task, PR-linked, in the vocabulary W1-T141's rundown already established. */
export interface RecentEntry {
  taskId: string;
  outcome: RecentOutcome;
  prNumber?: number;
  prUrl?: string;
}

/**
 * The last `max` merged/blocked tasks, most-recent-first. "Most recent" = the LAST ledger line
 * mentioning that task id (any step) — a task with no ledger line at all (e.g. a yaml-decorated
 * `status: blocked` with no run ever attempted) sorts after every task the ledger has actually
 * seen, never crowding out a task the operator watched happen.
 */
export function computeRecentOutcomes(deps: BoardDeps, max = 10): RecentEntry[] {
  const snapshot = computeBoardSnapshot(deps);
  const readLedger = deps.readLedger ?? readLedgerLines;
  const lastActivity = lastActivityByTask(readLedger(deps.ledgerPath));
  const terminal = snapshot.tasks.filter((t) => t.status === "merged" || t.status === "done" || t.status === "blocked");
  return terminal
    .map((t) => ({ t, idx: lastActivity.get(t.taskId)?.idx ?? -1 }))
    .sort((a, b) => b.idx - a.idx)
    .slice(0, max)
    .map(({ t }) => ({
      taskId: t.taskId,
      outcome: (t.status === "blocked" ? "blocked" : "merged") as RecentOutcome,
      prNumber: t.prNumber,
      prUrl: t.prUrl,
    }));
}

/** GET /v1/recent — the RECENT section's data, read-scoped. */
export function buildRecentRoute(deps: BoardDeps): Route {
  return {
    method: "GET",
    path: "/v1/recent",
    scope: "read",
    handler: (_req, res) => {
      sendJson(res, 200, { entries: computeRecentOutcomes(deps) });
    },
  };
}

/** Every distinct `task_id` named on a ledger line, in first-seen order. */
function taskIdsOf(lines: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  for (const line of lines) {
    if (typeof line.task_id === "string") seen.add(line.task_id);
  }
  return [...seen];
}

/**
 * GET /v1/status/stream — one `status` SSE event per task whose derived StatusProjection
 * changes, read-scoped. Subscribing primes the "last known" line count to the CURRENT
 * ledger length, so only lines appended AFTER subscribe count as flips — a client that just
 * connected is never replayed the whole ledger history.
 */
export function buildStatusStream(deps: BoardDeps, pollMs = DEFAULT_POLL_MS): SseRoute {
  return {
    path: "/v1/status/stream",
    scope: "read",
    subscribe: (send: SseSend) => {
      const readLedger = deps.readLedger ?? readLedgerLines;
      let lastLineCount = readLedger(deps.ledgerPath).length;
      // Prime `lastSent` with EVERY task's current projection (the same baseline GET
      // /v1/status would return right now), not an empty map — otherwise the first ledger
      // line touching a task would always look like a "flip" even when deriveStatus lands
      // on the exact state the client already has.
      const lastSent = new Map<string, string>(deps.plan.tasks.map((t) => [t.id, JSON.stringify(deriveStatus(t, deps))]));

      const tick = () => {
        const lines = readLedger(deps.ledgerPath);
        if (lines.length <= lastLineCount) return;
        const newLines = lines.slice(lastLineCount);
        lastLineCount = lines.length;

        for (const taskId of taskIdsOf(newLines)) {
          const task = deps.plan.byId.get(taskId);
          if (!task) continue; // a ledger line for a task not (or no longer) in the plan.
          const projection = deriveStatus(task, deps);
          const serialized = JSON.stringify(projection);
          if (lastSent.get(taskId) === serialized) continue; // no actual flip — don't spam.
          lastSent.set(taskId, serialized);
          send("status", projection);
        }
      };

      const timer = setInterval(tick, pollMs);
      return () => clearInterval(timer);
    },
  };
}

// ── FIND-layer sort comparators (W1-T157) ──────────────────────────────────────────────────
//
// Pure comparators over {@link BoardRow}, one per sortable column (id, status, recency, age).
// The operator console's inline script (src/lib/serve.ts) MIRRORS these for its own client-side
// sort — that script is a bundler-less template literal and cannot import this module — so these
// exported functions are the canonical, unit-tested SPEC of the ordering (test/board.test.ts),
// kept structurally identical to the inline copies. Each takes an explicit direction so the
// "a missing value always sorts LAST, in BOTH directions" rule (recency/age) is expressed HERE,
// once, rather than by a caller that merely reverses the sorted array (which would flip it).

export type BoardSortKey = "id" | "status" | "recency" | "age";
export type SortDir = "asc" | "desc";

/** `av`/`bv` compared numerically; `undefined` (no value) always sorts AFTER any value, whatever `dir`. */
function compareMissingLast(av: number | undefined, bv: number | undefined, dir: SortDir): number {
  if (av === undefined && bv === undefined) return 0;
  if (av === undefined) return 1; // a has no value -> a after b, regardless of direction
  if (bv === undefined) return -1;
  return dir === "desc" ? bv - av : av - bv;
}

/** Lexicographic by taskId. */
export function compareById(a: BoardRow, b: BoardRow, dir: SortDir): number {
  const base = a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  return dir === "desc" ? -base : base;
}

/** By index within {@link TASK_STATUSES} (queued … done). An unknown status sorts as -1 (before queued). */
export function compareByStatus(a: BoardRow, b: BoardRow, dir: SortDir): number {
  const base = TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status);
  return dir === "desc" ? -base : base;
}

/** By `lastActivityAt` (parsed to epoch ms); tasks with no ledger activity sort last, in both directions. */
export function compareByRecency(a: BoardRow, b: BoardRow, dir: SortDir): number {
  const av = a.lastActivityAt ? Date.parse(a.lastActivityAt) : undefined;
  const bv = b.lastActivityAt ? Date.parse(b.lastActivityAt) : undefined;
  return compareMissingLast(av, bv, dir);
}

/**
 * By `elapsedMs` (in-flight runs only). SIMPLIFICATION (house style — an explicit judgment call):
 * a task with no `elapsedMs` (not in flight) has no meaningful "age", so it sorts AFTER every task
 * that does — in BOTH directions — exactly like `recency`'s missing-value rule, never masquerading
 * as "very old" one way and "very new" the other.
 */
export function compareByAge(a: BoardRow, b: BoardRow, dir: SortDir): number {
  return compareMissingLast(a.elapsedMs, b.elapsedMs, dir);
}

const COMPARATORS: Record<BoardSortKey, (a: BoardRow, b: BoardRow, dir: SortDir) => number> = {
  id: compareById,
  status: compareByStatus,
  recency: compareByRecency,
  age: compareByAge,
};

/** Sort a COPY of `rows` by the given column/direction, with a stable id-ascending tiebreak. */
export function sortBoardRows(rows: readonly BoardRow[], sort: BoardSortKey, dir: SortDir): BoardRow[] {
  const cmp = COMPARATORS[sort];
  return [...rows].sort((a, b) => cmp(a, b, dir) || compareById(a, b, "asc"));
}
