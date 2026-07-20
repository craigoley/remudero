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
import type { Plan } from "./plan.js";
import { deriveStatus, projectPlan, readLedgerLines, type DeriveDeps, type StatusProjection } from "./status.js";
import type { Route, SseRoute, SseSend } from "./service.js";

/** Ledger poll pace for the SSE stream — comfortably under the 2s acceptance budget. */
export const DEFAULT_POLL_MS = 250;

/** GET /v1/status's body — one StatusProjection per plan task, as of `generated_at`. */
export interface BoardSnapshot {
  generated_at: string;
  tasks: StatusProjection[];
}

export interface BoardDeps extends DeriveDeps {
  plan: Plan;
}

/** The board snapshot, reusing {@link projectPlan} verbatim — no new derivation logic. */
export function computeBoardSnapshot(deps: BoardDeps): BoardSnapshot {
  const byId = projectPlan(deps.plan, deps);
  return { generated_at: new Date().toISOString(), tasks: [...byId.values()] };
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
