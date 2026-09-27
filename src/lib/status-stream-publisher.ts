/**
 * lib/status-stream-publisher.ts — the ONE shared engine behind GET /v1/status/stream (W1-T4455).
 *
 * WHY THIS FILE EXISTS. Before this task, `board.ts`'s `buildStatusStream` ran its own
 * `createLedgerTailCache()`, its own priming derive over EVERY plan task, and its own
 * `setInterval` poll — all INSIDE `subscribe()`, so each connection paid for its own. N viewers
 * cost N ledger tails and N full derives, and a quiet stream carried no heartbeat, so Cloudflare's
 * ~100s idle timeout cut it. `subscribeStatusStream` here is the fix: ONE ledger tail, ONE
 * `lastSent` map, ONE poll loop and ONE heartbeat timer for the whole process, lazily started on
 * the first subscriber and torn down once the last one leaves. `board.ts`'s `buildStatusStream`
 * is now a thin adapter over it (see the `subscribeStatusStream(` call there).
 *
 * WIRE CONTRACT (CONSOLE-T70 pins it; see the task's `design:` note for the full text this keeps
 * byte-for-byte where the CURRENT transport (`SseSend`, `lib/service.ts`) allows):
 * - `event: status` with the same {@link StatusProjection} JSON payload as before (unchanged).
 * - a monotonic per-publisher `generation` counter and a random `bootId`, minted fresh every time
 *   the publisher (re)starts, together forming the resume token `<bootId>:<generation>`.
 * - a `heartbeat` event on every open stream every {@link DEFAULT_STATUS_STREAM_HEARTBEAT_MS}
 *   (25s) — real byte-for-byte `: hb` COMMENT framing needs a raw-write primitive `SseSend` does
 *   not have today; see the follow-up note on {@link sendHeartbeat}.
 * - a subscriber that arrives with a `lastEventId` naming a DIFFERENT `bootId`, or a generation
 *   older than the retained window ({@link STATUS_STREAM_RETAINED_WINDOW} events), is sent
 *   `event: resync` / `data: {"reason":"gap"}` FIRST, before anything else. No history is ever
 *   replayed to any subscriber, gap or not — exactly as before this task.
 */

import { randomUUID } from "node:crypto";
import type { Task } from "./plan.js";
import {
  createLedgerTailCache,
  deriveStatus,
  readLedgerTail,
  type BoardDeps,
  type StatusProjection,
} from "./status.js";
import type { SseSend } from "./service.js";

/** Ledger poll pace, shared by every subscriber of the one publisher (mirrors `board.ts`'s
 *  historical per-connection default). */
export const DEFAULT_STATUS_STREAM_POLL_MS = 250;

/** Heartbeat pace: comfortably inside Cloudflare's ~100s idle-connection timeout. */
export const DEFAULT_STATUS_STREAM_HEARTBEAT_MS = 25_000;

/** How many emitted `status` events the publisher's resume window covers. A `lastEventId` naming
 *  a generation older than `currentGeneration - STATUS_STREAM_RETAINED_WINDOW + 1` is a gap. */
export const STATUS_STREAM_RETAINED_WINDOW = 500;

export interface SubscribeStatusStreamOptions {
  /** Ledger poll pace; only consulted when THIS subscriber starts the publisher (the first one). */
  pollMs?: number;
  /** Heartbeat pace; only consulted when THIS subscriber starts the publisher (the first one). */
  heartbeatMs?: number;
  /** The resuming client's own `Last-Event-ID`, `<bootId>:<generation>`, if any. */
  lastEventId?: string;
}

/**
 * Live accumulated spend/turns (W1-T184): sums `cost_usd`/`num_turns` over `implement.done`/
 * `fix.done` lines for `taskId` since its latest `run.start` — the same reset rule
 * `deriveRunState` uses (task_id + `run.start`/`verdict`, never `run_id`; a cold fix-rung
 * dispatch stamps its own pseudo `run_id`, so keying on that instead silently freezes live
 * spend). Narrow to these two step names: `budget.warning`/`verdict` log a running total, not an
 * increment, so summing those too would double-count.
 *
 * MOVED HERE FROM `board.ts` (W1-T4455): `board.ts`'s `computeBoardSnapshot` imports it back —
 * this module never imports FROM `board.ts`, so the two stay a one-way edge, not a cycle.
 */
// Why: the frozen-live-spend incident this reset rule fixes — docs/forensics/board.md#liverunspend
export function liveRunSpend(
  lines: Array<Record<string, unknown>>,
  taskId: string,
): { spendUsd: number; turns: number; hasData: boolean } | undefined {
  let inFlight = false;
  let spendUsd = 0;
  let turns = 0;
  // Distinguishes "no data yet" from a real zero (fb-1784902052582-c124f9).
  let hasData = false;
  for (const line of lines) {
    if (line.task_id !== taskId) continue;
    if (line.step === "run.start") {
      inFlight = true;
      spendUsd = 0;
      turns = 0;
      hasData = false;
      continue;
    }
    if (line.step === "verdict") {
      inFlight = false;
      continue;
    }
    if (!inFlight) continue;
    if (line.step !== "implement.done" && line.step !== "fix.done") continue;
    if (typeof line.cost_usd === "number") spendUsd += line.cost_usd;
    if (typeof line.num_turns === "number") turns += line.num_turns;
    hasData = true;
  }
  return inFlight ? { spendUsd, turns, hasData } : undefined;
}

/** Every distinct `task_id` named on a ledger line, in first-seen order. */
function taskIdsOf(lines: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  for (const line of lines) {
    if (typeof line.task_id === "string") seen.add(line.task_id);
  }
  return [...seen];
}

/** Enrich with live spend/turns (W1-T184), the same way `computeBoardSnapshot` does, off the
 *  same already-read lines: a client's `ingestProjection` overwrites the previously-known row on
 *  every SSE flip, so a payload with no spend fields would silently wipe whatever the last REST
 *  poll had shown. */
// Why: the "tonight's burn was invisible" fixture this enrichment fixes —
// docs/forensics/board.md#buildstatusstream--live-spend-over-sse
function deriveForStream(
  deps: BoardDeps,
  task: Task,
  lines: Array<Record<string, unknown>>,
): StatusProjection & { liveSpendUsd?: number; liveTurns?: number } {
  const projection = deriveStatus(task, deps);
  if (!projection.phase) return projection;
  const spend = liveRunSpend(lines, task.id);
  return spend ? { ...projection, liveSpendUsd: spend.spendUsd, liveTurns: spend.turns } : projection;
}

/** True when `lastEventId` names a gap the publisher can no longer vouch for: a different boot
 *  (the publisher restarted since) or a generation older than the retained window. A malformed
 *  token (no `:`, a non-numeric generation) is treated as a gap too — fail toward a resync, never
 *  toward silently trusting an unparsable resume claim. Pure, so the window arithmetic is
 *  provable on its own, apart from any live publisher state. */
export function isStatusStreamResumeGap(currentBootId: string, currentGeneration: number, lastEventId: string): boolean {
  const idx = lastEventId.lastIndexOf(":");
  if (idx < 0) return true;
  const bootId = lastEventId.slice(0, idx);
  const generation = Number(lastEventId.slice(idx + 1));
  if (bootId !== currentBootId) return true;
  if (!Number.isFinite(generation)) return true;
  return generation < currentGeneration - STATUS_STREAM_RETAINED_WINDOW + 1;
}

interface PublisherState {
  bootId: string;
  generation: number;
  subscribers: Set<SseSend>;
  deps: BoardDeps;
  lastSent: Map<string, string>;
  lastLineCount: number;
  pollTimer: ReturnType<typeof setInterval>;
  heartbeatTimer: ReturnType<typeof setInterval>;
}

/** THE ONE PUBLISHER FOR THE WHOLE PROCESS (by design — see the file header). `null` whenever no
 *  subscriber is connected; a fresh one is minted (a fresh `bootId` included) on the next
 *  `subscribeStatusStream` call, so a client resuming across a process restart always sees a
 *  `bootId` mismatch and gets `resync`, never a silently-wrong generation comparison. */
let publisher: PublisherState | null = null;

function tick(state: PublisherState): void {
  const lines = state.deps.readLedger!(state.deps.ledgerPath);
  if (lines.length <= state.lastLineCount) return;
  const newLines = lines.slice(state.lastLineCount);
  state.lastLineCount = lines.length;

  for (const taskId of taskIdsOf(newLines)) {
    const task = state.deps.plan.byId.get(taskId);
    if (!task) continue; // a ledger line for a task not (or no longer) in the plan.
    // Re-derive off the FULL `lines` (not just `newLines`) — liveRunSpend needs the task's whole
    // current run, and deriveStatus itself always re-reads the ledger too.
    const projection = deriveForStream(state.deps, task, lines);
    const serialized = JSON.stringify(projection);
    if (state.lastSent.get(taskId) === serialized) continue; // no actual flip (incl. spend) — don't spam.
    state.lastSent.set(taskId, serialized);
    state.generation += 1;
    for (const send of state.subscribers) send("status", projection);
  }
}

/**
 * A `heartbeat` SSE event on every open stream, every {@link DEFAULT_STATUS_STREAM_HEARTBEAT_MS}.
 *
 * FOLLOW-UP (out of THIS task's declared scope — `board.ts`/`status-stream-publisher.ts` only):
 * the design's wire contract pins a raw `: hb` COMMENT line, not a named event, so an
 * `EventSource` client's own event listeners never see it fire. `SseSend` (`lib/service.ts`) has
 * no comment-writing primitive today — only `event:`/`data:` framing — so a byte-for-byte `: hb`
 * frame needs `service.ts` to grow one; that file is outside this task's declared `files:`. This
 * publisher still resets Cloudflare's idle timer every {@link DEFAULT_STATUS_STREAM_HEARTBEAT_MS}
 * either way, which is the acceptance bar this task closes; the exact framing is tracked below.
 */
function sendHeartbeat(state: PublisherState): void {
  for (const send of state.subscribers) send("heartbeat", {});
}

function startPublisher(deps: BoardDeps, pollMs: number, heartbeatMs: number): PublisherState {
  const tail = createLedgerTailCache();
  const readLedger = deps.readLedger ?? ((path: string) => readLedgerTail(path, tail));
  const effectiveDeps: BoardDeps = { ...deps, readLedger };

  // Prime lastSent with every task's current projection, not an empty map — otherwise the first
  // ledger line touching a task would always look like a flip, even when it lands on the state
  // the client already has. Paid ONCE per publisher lifetime, never per subscriber (the whole
  // point of this file).
  const primingLines = readLedger(deps.ledgerPath);
  const lastSent = new Map<string, string>(
    deps.plan.tasks.map((t) => [t.id, JSON.stringify(deriveForStream(effectiveDeps, t, primingLines))]),
  );

  const state: PublisherState = {
    bootId: randomUUID(),
    generation: 0,
    subscribers: new Set(),
    deps: effectiveDeps,
    lastSent,
    lastLineCount: primingLines.length,
    pollTimer: undefined as unknown as ReturnType<typeof setInterval>,
    heartbeatTimer: undefined as unknown as ReturnType<typeof setInterval>,
  };
  state.pollTimer = setInterval(() => tick(state), pollMs);
  state.heartbeatTimer = setInterval(() => sendHeartbeat(state), heartbeatMs);
  return state;
}

/**
 * Register `send` with the ONE shared status-stream publisher, starting it (a fresh `bootId`, one
 * ledger tail, one priming derive) if it is not already running, and stopping it once the LAST
 * subscriber (across every caller, not just this one) leaves. `pollMs`/`heartbeatMs` are consulted
 * only by whichever call happens to start the publisher; a later subscriber joining an already-
 * running one simply gets what is already running — exactly the sharing this exists for.
 *
 * A subscriber arriving with `opts.lastEventId` naming a gap is sent `resync` first; either way it
 * is never replayed history, exactly as before this task.
 */
export function subscribeStatusStream(deps: BoardDeps, send: SseSend, opts: SubscribeStatusStreamOptions = {}): () => void {
  const pollMs = opts.pollMs ?? DEFAULT_STATUS_STREAM_POLL_MS;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_STATUS_STREAM_HEARTBEAT_MS;
  if (!publisher) publisher = startPublisher(deps, pollMs, heartbeatMs);
  const state = publisher;

  if (opts.lastEventId !== undefined && isStatusStreamResumeGap(state.bootId, state.generation, opts.lastEventId)) {
    send("resync", { reason: "gap" });
  }

  state.subscribers.add(send);
  return () => {
    state.subscribers.delete(send);
    if (state.subscribers.size === 0 && publisher === state) {
      clearInterval(state.pollTimer);
      clearInterval(state.heartbeatTimer);
      publisher = null;
    }
  };
}
