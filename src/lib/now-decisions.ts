/**
 * `now`'s open decisions (arch Phase 4 design §2, P4-T08): everything the operator answers, each with the
 * ONE route that steers it, so the console answers in place instead of showing a count.
 *
 * | kind | source | answer route |
 * |---|---|---|
 * | `grill` | core's feedback entries parked `grilling` | `POST /v1/feedback {replyTo, text}` |
 * | `task_question` | core's `plan/questions.ndjson`: a QUESTION with no later answer for its task, on an open task | `POST /v1/questions/answer {taskId, answer}` |
 * | `manual_approval` | a board task whose open escalation is class MANUAL | `POST /v1/manual/approve {taskId, issueUrl}` |
 * | `escalation` | any other open escalation on the board | `POST /v1/escalation/mark-handled {taskId, issueUrl, class, disposition}` |
 *
 * Each answer names its route's write tier from {@link ESCALATION_OPTION_ROUTES}, the table serve's
 * route tiers are copied into, so a `high` answer still runs the console's confirm nonce. An escalation's
 * reply text is NOT offered: `/v1/escalation/reply` steers nothing yet (W1-T4471), so the question route
 * that does is the only text answer. Every field is an absolute time or content: no clock in `data`.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BoardRow } from "./board.js";
import { ESCALATION_OPTION_ROUTES } from "./escalate.js";
import { ESCALATION_DISPOSITIONS } from "./escalation-precision.js";
import type { FeedbackEntry } from "./feedback.js";
import type { WriteTier } from "./service.js";

/** BACKSTOP: decisions carried per instance, bounding the body; the rest are counted in `decisionsMore`. */
export const NOW_DECISIONS_CAP = 50;
/** A prompt is cut at this many characters; the full text is in the task or feedback entry. */
export const NOW_DECISION_PROMPT_CHARS = 2_048;
const TITLE_CHARS = 120;
const CLOSED_STATUSES: ReadonlySet<string> = new Set(["merged", "done"]);
const FEEDBACK_ANSWER_TIER: WriteTier = "low";

export type NowDecisionKind = "grill" | "task_question" | "manual_approval" | "escalation";

export interface NowDecisionAnswer {
  method: "POST";
  path: string;
  tier: WriteTier;
  /** Body fields the console sends as given; the operator's own input goes in the field `input` names. */
  fields: Record<string, string>;
  input: "text" | "choice" | "none";
}

export interface NowDecision {
  id: string;
  kind: NowDecisionKind;
  instance: string;
  taskId?: string;
  title: string;
  prompt: string;
  options?: string[];
  currentAssumption?: string;
  impactIfWrong?: "low" | "med";
  /** When it was asked; absent only when its source carries no time (an escalation row never projected, a hand-written entry). */
  askedAt?: string;
  answer: NowDecisionAnswer;
}

/** One `plan/questions.ndjson` line: a QUESTION (`question`) or an ANSWER (`answer`), as worker.ts writes them. */
export type QuestionStoreLine = { ts?: unknown; task?: unknown; question?: unknown; answer?: unknown; current_assumption?: unknown; impact_if_wrong?: unknown };

function firstLine(text: string, chars: number): string {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > chars ? `${line.slice(0, chars - 1)}…` : line;
}

function bounded(text: string): string {
  return text.length > NOW_DECISION_PROMPT_CHARS ? `${text.slice(0, NOW_DECISION_PROMPT_CHARS - 1)}…` : text;
}

/** Each `grilling` feedback entry, answered by a reply that advances it to `answered`. */
export function grillDecisions(instance: string, entries: readonly FeedbackEntry[]): NowDecision[] {
  return entries.filter((e) => e.status === "grilling" && typeof e.id === "string").map((e) => {
    const raw = typeof e.raw === "string" ? e.raw : "";
    return {
      id: `grill:${e.id}`, kind: "grill", instance, title: firstLine(raw, TITLE_CHARS) || e.id, prompt: bounded(raw), ...(typeof e.ts === "string" ? { askedAt: e.ts } : {}),
      answer: { method: "POST", path: "/v1/feedback", tier: FEEDBACK_ANSWER_TIER, fields: { replyTo: e.id }, input: "text" },
    };
  });
}

/**
 * Each QUESTION on a task still open on the board, with no answer after it: an answer line in the store,
 * or a `panel.question_answered` fact for its task (the route ledgers one even when the store write failed).
 */
export function taskQuestionDecisions(
  instance: string,
  lines: readonly QuestionStoreLine[],
  answeredByFact: (taskId: string) => string | undefined,
  tasks: readonly Pick<BoardRow, "taskId" | "title" | "status">[],
): NowDecision[] {
  const open = new Map(tasks.filter((t) => !CLOSED_STATUSES.has(t.status)).map((t) => [t.taskId, t]));
  const lastAnswer = new Map<string, string>();
  const asked = new Set(lines.flatMap((l) => (typeof l.question === "string" && typeof l.task === "string" && open.has(l.task) ? [l.task] : [])));
  for (const taskId of asked) {
    const at = answeredByFact(taskId);
    if (at !== undefined) lastAnswer.set(taskId, at);
  }
  for (const line of lines) {
    if (typeof line.answer !== "string" || typeof line.task !== "string" || typeof line.ts !== "string") continue;
    if ((lastAnswer.get(line.task) ?? "") < line.ts) lastAnswer.set(line.task, line.ts);
  }
  const out: NowDecision[] = [];
  for (const line of lines) {
    if (typeof line.question !== "string" || typeof line.task !== "string" || typeof line.ts !== "string") continue;
    const task = open.get(line.task);
    if (!task || (lastAnswer.get(line.task) ?? "") >= line.ts) continue;
    const impact = line.impact_if_wrong === "low" || line.impact_if_wrong === "med" ? line.impact_if_wrong : undefined;
    out.push({
      id: `question:${line.task}:${line.ts}`, kind: "task_question", instance, taskId: line.task, title: firstLine(task.title, TITLE_CHARS) || line.task,
      prompt: bounded(line.question), askedAt: line.ts,
      ...(typeof line.current_assumption === "string" ? { currentAssumption: bounded(line.current_assumption) } : {}), ...(impact ? { impactIfWrong: impact } : {}),
      answer: { method: "POST", path: "/v1/questions/answer", tier: ESCALATION_OPTION_ROUTES["/v1/questions/answer"], fields: { taskId: line.task }, input: "text" },
    });
  }
  return out;
}

/** Each task's newest `escalation.issue_opened` row: its class and time, by task. */
export function escalationClasses(rows: ReadonlyArray<Record<string, unknown>>): Map<string, { class?: string; ts?: string }> {
  const out = new Map<string, { class?: string; ts?: string }>();
  for (const row of rows) {
    if (row.step !== "escalation.issue_opened" || typeof row.task_id !== "string") continue;
    out.set(row.task_id, { ...(typeof row.class === "string" ? { class: row.class } : {}), ...(typeof row.ts === "string" ? { ts: row.ts } : {}) });
  }
  return out;
}

/** Each open escalation on the board with an issue to act on: MANUAL ones are approved, the rest marked handled. */
export function escalationDecisions(instance: string, tasks: readonly BoardRow[], opened: ReadonlyMap<string, { class?: string; ts?: string }>): NowDecision[] {
  return tasks.flatMap((t): NowDecision[] => {
    if (!t.needsHuman || !t.escalationIssueUrl) return [];
    const row = opened.get(t.taskId);
    const cls = row?.class;
    const askedAt = t.escalationOpenedAt ?? row?.ts;
    const title = firstLine(t.escalationTitle ?? t.title, TITLE_CHARS) || t.taskId;
    const base = { instance, taskId: t.taskId, title, prompt: bounded(t.escalationTitle ?? t.title), ...(askedAt ? { askedAt } : {}) };
    if (cls === "MANUAL") {
      return [{ ...base, id: `manual:${t.taskId}:${t.escalationIssueUrl}`, kind: "manual_approval",
        answer: { method: "POST", path: "/v1/manual/approve", tier: ESCALATION_OPTION_ROUTES["/v1/manual/approve"], fields: { taskId: t.taskId, issueUrl: t.escalationIssueUrl }, input: "none" } }];
    }
    return [{ ...base, id: `escalation:${t.taskId}:${t.escalationIssueUrl}`, kind: "escalation", options: [...ESCALATION_DISPOSITIONS],
      answer: { method: "POST", path: "/v1/escalation/mark-handled", tier: ESCALATION_OPTION_ROUTES["/v1/escalation/mark-handled"],
        fields: { taskId: t.taskId, issueUrl: t.escalationIssueUrl, class: cls ?? "UNKNOWN" }, input: "choice" } }];
  });
}

/** Newest first by `askedAt`, then id; at most {@link NOW_DECISIONS_CAP}, the rest counted. */
export function capDecisions(all: readonly NowDecision[]): { decisions: NowDecision[]; decisionsMore?: number } {
  const at = (d: NowDecision): string => d.askedAt ?? "";
  const sorted = [...all].sort((a, b) => (at(a) === at(b) ? (a.id < b.id ? -1 : 1) : at(a) < at(b) ? 1 : -1));
  const more = sorted.length - NOW_DECISIONS_CAP;
  return { decisions: sorted.slice(0, NOW_DECISIONS_CAP), ...(more > 0 ? { decisionsMore: more } : {}) };
}

export function questionStorePath(root: string): string {
  return join(root, "plan", "questions.ndjson");
}

/** The store's lines and its mtime; an absent store has no questions, an unreadable one says why. */
export function readQuestionStore(root: string): { lines: QuestionStoreLine[]; mtimeMs?: number } | { reason: string } {
  const path = questionStorePath(root);
  let text: string;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { lines: [] };
    return { reason: `the question store is unreadable: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` };
  }
  const lines: QuestionStoreLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      lines.push(JSON.parse(raw) as QuestionStoreLine);
    } catch {
      // deliberate: a torn or hand-edited line is skipped; every whole line around it still counts.
      continue;
    }
  }
  return { lines, mtimeMs };
}
