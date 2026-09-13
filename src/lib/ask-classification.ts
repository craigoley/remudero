/**
 * ASK vs RECORD classification (W1-T3394, ratifies W1-T3186 clause (i)).
 *
 * THE INVARIANT: {@link classifyAskRecordItem} is the ONE pure, total, deterministic function
 * BOTH the inbox renderer (W1-T3395) and the change-management renderer (W1-T3396) consult to
 * decide "is this mine?" — so single-destination routing is a property of the DATA, never of two
 * independently-written templates agreeing by convention. Every value of every source shape below
 * maps to exactly ASK or RECORD, enforced by the `never` check in the exhaustiveness switch.
 *
 * THE TRAP THIS CLOSES: the unbuilt NEEDS ME section was specified to fold four unrelated sources
 * into one banner — inbox proposals (inbox.ts), needs-human escalations (escalate.ts, W1-T8/T77's
 * BLOCKED-AMBIGUOUS disposition), W1-T78 clarification questions, and the post-drain rundown's
 * outcome lines ({@link RundownLine}, W1-T141) — and the rundown and the escalation fire on the
 * SAME blocked-task event with DIFFERENT resolution verbs, so one real escalation double-rendered.
 *
 * THE FALSIFIER: a task with an open BLOCKED-AMBIGUOUS escalation AND a rundown line for the same
 * event yields exactly one ASK (the escalation) and exactly one RECORD (the rundown line) — a
 * rundown line reports what HAPPENED, never asks a question, so it is ALWAYS RECORD regardless of
 * what a sibling escalation for the same task classifies as.
 */

import type { InboxState } from "./inbox.js";
import type { RundownLine } from "./drain.js";

/** Where an ASK/RECORD-classified item routes: ASK is a live decision still pending an operator
 *  verdict; RECORD is a fact about something that already happened or was already answered. */
export type AskRecordClass = "ASK" | "RECORD";

/** The {@link InboxState} values where a ratification decision is still pending (P25's own
 *  READY/NOT-READY/DEFERRED-WITH-TRIGGER tiering, inbox.ts) — every other state (drafting, an
 *  Architect is mid-draft; ratified/retired/declined, already consumed) is a record of what
 *  happened to the proposal, never a live ask. */
const PENDING_INBOX_STATES: ReadonlySet<InboxState> = new Set(["ready", "not_ready", "deferred_with_trigger"]);

/**
 * One item ASK/RECORD classification routes, over the four source shapes the design names:
 *
 *  - `proposal`  — an inbox proposal's current {@link InboxState} (inbox.ts).
 *  - `escalation` — a needs-human escalation issue (escalate.ts, W1-T8/T77's BLOCKED-AMBIGUOUS
 *    disposition): `resolved` is true once the referent has resolved (a W1-T162-class terminal
 *    state) or the issue itself closed, false while it still needs a human decision.
 *  - `question`  — a W1-T78 clarification question: `answered` is true once the operator has
 *    answered it, false while it is still an open, decidable ask.
 *  - `rundown`   — one post-drain rundown outcome line (drain.ts's {@link RundownLine}, W1-T141).
 *
 * Pure and total: every value of every shape maps to exactly one of {@link AskRecordClass}.
 */
export type AskRecordItem =
  | { kind: "proposal"; state: InboxState }
  | { kind: "escalation"; resolved: boolean }
  | { kind: "question"; answered: boolean }
  | { kind: "rundown"; outcome: RundownLine["outcome"] };

/**
 * The ONE routing predicate every ASK/RECORD-aware renderer must consult (design note: "one
 * classifier, consulted by both renderers, makes single-destination routing a property of the
 * DATA rather than of two independently-written templates agreeing by convention").
 */
export function classifyAskRecordItem(item: AskRecordItem): AskRecordClass {
  switch (item.kind) {
    case "proposal":
      return PENDING_INBOX_STATES.has(item.state) ? "ASK" : "RECORD";
    case "escalation":
      return item.resolved ? "RECORD" : "ASK";
    case "question":
      return item.answered ? "RECORD" : "ASK";
    case "rundown":
      // THE FALSIFIER: a rundown line reports what happened to a change, and never itself asks a
      // question — ALWAYS RECORD, even when the same task also carries an open, ASK-classified
      // escalation (the exact double-render this task exists to kill).
      return "RECORD";
    default: {
      const exhaustive: never = item;
      throw new Error(`classifyAskRecordItem: unclassified item kind ${JSON.stringify((exhaustive as { kind?: unknown }).kind)}`);
    }
  }
}
