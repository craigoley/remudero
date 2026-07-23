/**
 * lib/recap.ts — the "since you last checked" recap (W1-T163, MASTER-PLAN §7/§7B).
 *
 * P34's ratified envelope (round 3, clause e): away-mode escalations batch into a recap for
 * ASYNC verdict. `lib/digest.ts` (W1-T112/W1-T144) is the PUSH half of that — this module is the
 * PULL half: given the SAME per-token {@link LastSeenStore} marker (`lib/last-seen.ts`), collect
 * every ledger event AFTER it into rows the console renders, each naming what happened and (when
 * the event actually names a real plan task) drilling into that task's T158 card.
 *
 * ONE SHARED WINDOW DEFINITION, not two: this module classifies over `digest.ts`'s OWN
 * `collectSince` (never a second re-implementation of "lines at/after this marker") — so a
 * digest and a recap built from the SAME `sinceIso` over the SAME ledger can never disagree
 * about which lines are "since". Verified from source (distrust-the-prompt discipline) before
 * wiring: `panel.question_answered` (lib/panel-actions.ts) is the ledger step for "an operator
 * answered a clarification question" and DOES carry a real plan task id (`input.taskId`) — unlike
 * `panel.feedback_submitted`/`panel.proposal_accepted`/`rejected` (lib/panel-graph.ts), which
 * ledger a FEEDBACK-ENTRY id under the same `task_id` field, not a plan task id, and so cannot
 * honestly drill into a task card; this module does not surface those. `retro.marker.advanced`
 * (run-task.ts) ledgers under the pseudo id `"RETRO"` (mirroring `"DRAIN"`/`"PANEL"`/`"SWEEP"`) —
 * a fleet-wide event, not a task's — so its row is a bare summary line, with no card link.
 */

import type { Plan } from "./plan.js";
import { collectSince } from "./digest.js";

/** One ledger line, loosely typed like every other module's own `LedgerLine`. */
type LedgerLine = Record<string, unknown>;

export type RecapEventKind = "merged" | "blocked" | "escalated" | "question_answered" | "retro";

export interface RecapEvent {
  kind: RecapEventKind;
  /** The originating ledger line's `task_id` verbatim — `"RETRO"` for a fleet-wide retro event. */
  taskId: string;
  /** ISO-8601 `ts` of the originating ledger line. */
  ts: string;
  /** A short human-readable detail (verdict string, escalation class, answer text, retro stats). */
  detail?: string;
  /** The plan task's own title, present only when {@link taskId} names a REAL plan task. */
  title?: string;
  /** Present ONLY when {@link taskId} names a real plan task — the console's own `#task=<id>`
   *  hash route (see `lib/digest.ts`'s `consoleCardUrl` doc for why a hash, never a query param,
   *  carries this: it never leaves the client, so no bearer token rides along anywhere). A
   *  fleet-wide event (retro) has no task to drill into and carries no link at all. */
  taskCardLink?: string;
}

/** The console's own same-page deep link — a bare `#task=<id>` hash (no origin prefix: unlike
 *  `digest.ts`'s `consoleCardUrl`, which links FROM a message app back to the console, this link
 *  is rendered and clicked from WITHIN the console page itself). */
function taskCardHash(taskId: string): string {
  return `#task=${encodeURIComponent(taskId)}`;
}

function truncate(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Classify one ledger line into a {@link RecapEvent}, or `undefined` for every step this recap
 * does not surface. `plan` decides whether a row's `taskId` earns a `taskCardLink`/`title` — an
 * id absent from the plan (a pseudo id like `"RETRO"`, or a stale/removed task) renders as a
 * bare, unlinked summary row rather than a link the console's own deep-link handler would reject.
 */
function classifyLine(line: LedgerLine, plan: Plan): RecapEvent | undefined {
  const taskId = typeof line.task_id === "string" ? line.task_id : undefined;
  const ts = typeof line.ts === "string" ? line.ts : undefined;
  if (!taskId || !ts) return undefined;
  const task = plan.byId.get(taskId);
  const linked = task ? { title: task.title, taskCardLink: taskCardHash(taskId) } : {};

  switch (line.step) {
    case "verdict": {
      const verdict = typeof line.verdict === "string" ? line.verdict : undefined;
      if (verdict === "merged") return { kind: "merged", taskId, ts, ...linked };
      if (verdict?.startsWith("blocked")) return { kind: "blocked", taskId, ts, detail: verdict, ...linked };
      return undefined;
    }
    case "escalation.issue_opened":
      return { kind: "escalated", taskId, ts, detail: typeof line.class === "string" ? line.class : undefined, ...linked };
    case "panel.question_answered":
      return {
        kind: "question_answered",
        taskId,
        ts,
        detail: typeof line.answer === "string" ? truncate(line.answer) : undefined,
        ...linked,
      };
    case "retro.marker.advanced":
      return {
        kind: "retro",
        taskId,
        ts,
        detail: `${typeof line.runs_seen === "number" ? line.runs_seen : "?"} runs, ${
          typeof line.learnings_count === "number" ? line.learnings_count : "?"
        } learnings`,
        // deliberately NO `...linked` -- `taskId` here is the pseudo id "RETRO", never a real
        // plan task (see module header); a retro row is fleet-wide and carries no card link.
      };
    default:
      return undefined;
  }
}

/**
 * Every recap-worthy ledger event with `ts >= sinceIso`, newest first (mirrors `board.ts`'s
 * RECENT activity feed convention — the console's other "what just happened" list). Pure over
 * its inputs: the SAME `(lines, sinceIso)` always produces the SAME rows, so a caller comparing
 * this against `digest.ts`'s `summarize(lines, sinceIso)` over the identical inputs can assert
 * the two never disagree about the event window (W1-T163's marker-aware acceptance bar).
 */
export function buildRecapEvents(lines: LedgerLine[], sinceIso: string, plan: Plan): RecapEvent[] {
  const since = collectSince(lines, sinceIso);
  const events: RecapEvent[] = [];
  for (const line of since) {
    const event = classifyLine(line, plan);
    if (event) events.push(event);
  }
  return events.reverse();
}
