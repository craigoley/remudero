import { join } from "node:path";
import { readLedgerLines } from "./status.js";

/**
 * OPERATOR PRESENCE, INFERRED FROM ACTIVITY (W1-T4674) ──────────────────────────────────────
 *
 * `rmd away` (escalate.ts) is a flag the operator can forget to clear. This module derives a
 * second, unforgettable signal from the operator's own recent activity across four sources —
 * console writes, owner (GitHub) comments, one-tap answer-link clicks, and operator commits — so
 * someone who has simply gone quiet reads as AWAY even with the flag never touched, while the
 * manual flag still overrides it outright (design clause iii). escalate.ts's `presenceMode`
 * consults {@link inferOperatorPresence} only when the AWAY flag file is absent.
 *
 * The lease is LEARNED, not fixed (clause ii): it is 3x the operator's own median reply latency
 * (Buzz's "lease expiring after 3x the heartbeat" shape — this task's rationale), read from the
 * SAME ledger's escalation-opened/answered pairs. A cold root with no reply history yet falls
 * back to {@link COLD_START_LEASE_MS} until one real reply lands.
 *
 * INVARIANT (shared with escalate.ts's own presence flag): DELIVERY only, never dispatch — this
 * module is reached solely through `presenceMode`, which test/away-mode-delivery.test.ts's claim
 * 3 already keeps out of every dispatch-path module.
 */

export type ActivitySource = "console_write" | "owner_comment" | "answer_click" | "operator_commit";

export interface ActivityEvent {
  readonly source: ActivitySource;
  /** ISO-8601 instant the activity happened. */
  readonly at: string;
}

/**
 * Recent commits actually authored BY the operator, never the fleet's own automated ones. No
 * ledger step (or any other primitive in this repo, per recon) yet distinguishes the two, so the
 * default below is an honest no-signal rather than a guess that would misread every autonomous
 * commit as operator presence — a caller with a real distinguishing signal can inject its own.
 */
export interface OperatorCommitReader {
  recentOperatorCommitsAt(): readonly string[];
}

export const NO_OPERATOR_COMMITS: OperatorCommitReader = { recentOperatorCommitsAt: () => [] };

const STEP_ANSWERED_BY_LINK = "escalation.answered_by_link";
const STEP_QUESTION_ANSWERED = "panel.question_answered";
const STEP_ESCALATION_REPLIED = "panel.escalation_replied";
const STEP_ISSUE_OPENED = "escalation.issue_opened";

/** A GitHub-comment-origin answer looks like `issue#701:comment:9701` (W1-T2696/an-operator-reply
 *  fix rung) — anything else answering through the SAME two steps is a console/API write instead. */
const COMMENT_ORIGIN_RE = /:comment:/;

function classifyLedgerLine(line: Record<string, unknown>): ActivitySource | null {
  const step = line.step;
  if (typeof step !== "string") return null;
  if (step === STEP_ANSWERED_BY_LINK) return "answer_click";
  if (step === STEP_QUESTION_ANSWERED || step === STEP_ESCALATION_REPLIED) {
    const origin = typeof line.origin === "string" ? line.origin : "";
    return COMMENT_ORIGIN_RE.test(origin) ? "owner_comment" : "console_write";
  }
  // Every other console/API write lands under the "panel." prefix (panel-actions.ts is the
  // console's own write backend), so it counts as a console write without a per-route list here.
  if (step.startsWith("panel.")) return "console_write";
  return null;
}

function ledgerPathAt(root: string): string {
  return join(root, "state", "ledger.ndjson");
}

function ledgerActivity(root: string): ActivityEvent[] {
  const lines = readLedgerLines(ledgerPathAt(root)); // ledger-read-intent: live — only recent activity matters, never a rotation.
  const events: ActivityEvent[] = [];
  for (const line of lines) {
    const source = classifyLedgerLine(line);
    const at = typeof line.ts === "string" ? line.ts : undefined;
    if (source && at) events.push({ source, at });
  }
  return events;
}

/** Every observable reply latency (ms): the gap between an escalation opening and the operator's
 *  first answer of any shape (link click, console answer, or a GitHub comment reply), paired by
 *  task id. Exported so a lease can be learned, and so a sibling module (e.g. W1-T4675) that also
 *  wants a reply-latency distribution can read the same numbers rather than re-deriving them. */
export function replyLatenciesMs(root: string): number[] {
  const lines = readLedgerLines(ledgerPathAt(root)); // ledger-read-intent: live
  const openedAt = new Map<string, number>();
  const latencies: number[] = [];
  for (const line of lines) {
    const taskId = typeof line.task_id === "string" ? line.task_id : undefined;
    const ts = typeof line.ts === "string" ? Date.parse(line.ts) : NaN;
    if (!taskId || Number.isNaN(ts)) continue;
    if (line.step === STEP_ISSUE_OPENED) {
      if (!openedAt.has(taskId)) openedAt.set(taskId, ts);
      continue;
    }
    if (line.step !== STEP_ANSWERED_BY_LINK && line.step !== STEP_QUESTION_ANSWERED && line.step !== STEP_ESCALATION_REPLIED) continue;
    const opened = openedAt.get(taskId);
    if (opened !== undefined && ts >= opened) {
      latencies.push(ts - opened);
      openedAt.delete(taskId);
    }
  }
  return latencies;
}

function median(sortedAsc: readonly number[]): number {
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 === 0 ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2 : sortedAsc[mid];
}

/** Used only until the ledger carries its first reply — after that, {@link learnLeaseMs} always
 *  learns from real data. 30 minutes: long enough that a mid-reply operator isn't flagged away
 *  between two ledger-visible actions of their own, short enough to catch a truly quiet one
 *  inside a single working session. */
export const COLD_START_LEASE_MS = 30 * 60 * 1000;
const MIN_LEASE_MS = 5 * 60 * 1000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;

/** The lease, learned from the distribution of the operator's own reply latency rather than a
 *  fixed number (design clause ii): 3x the median — Buzz's "3x the heartbeat" shape — clamped so
 *  one freak fast or slow reply can't produce a useless lease in either direction. */
export function learnLeaseMs(latenciesMs: readonly number[]): number {
  if (latenciesMs.length === 0) return COLD_START_LEASE_MS;
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  return Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, 3 * median(sorted)));
}

/** Pure core: attended iff some activity falls within `leaseMs` of `now`. No activity ever
 *  recorded fails to the SAME safe default `presenceMode` already documents for an unreadable
 *  state dir — attended — rather than reading a cold, dataless root as away. */
export function inferPresenceFromActivity(events: readonly ActivityEvent[], now: Date, leaseMs: number): "attended" | "away" {
  const atMs = events.map((e) => Date.parse(e.at)).filter((t) => !Number.isNaN(t));
  if (atMs.length === 0) return "attended";
  return now.getTime() - Math.max(...atMs) <= leaseMs ? "attended" : "away";
}

/** The integration point escalate.ts's `presenceMode` falls back to when no manual flag is set:
 *  reads the ledger's own activity trail across three of the four sources, folds in operator
 *  commits from `commits` (an injectable {@link OperatorCommitReader}), learns the lease from the
 *  same ledger's reply latencies, and infers attended/away from the result. */
export function inferOperatorPresence(root: string, now: Date = new Date(), commits: OperatorCommitReader = NO_OPERATOR_COMMITS): "attended" | "away" {
  const events = ledgerActivity(root);
  for (const at of commits.recentOperatorCommitsAt()) events.push({ source: "operator_commit", at });
  return inferPresenceFromActivity(events, now, learnLeaseMs(replyLatenciesMs(root)));
}
