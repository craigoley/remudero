import { createHash } from "node:crypto";
import type { FeedbackEntry } from "./feedback.js";
import { appendThreadMessageOnce, deriveThreadId, readThread, type ThreadIdentity, type ThreadStoreDeps } from "./inbox-thread.js";
import { ghTextAsync } from "./github-transport.js";
import { parse } from "yaml";

const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const issue = (url: string): string | undefined => /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/[1-9][0-9]*$/.exec(url)?.[1];

/** Existing feedback submission identity joins one immutable answer to one native intake. */
export function escalationReplySubmissionKey(threadId: string, intentId: string, issueUrl: string): string {
  return `escalation-reply:${sha([threadId, intentId, issueUrl])}`;
}

export function escalationThreadIdentity(threadId: string): ThreadIdentity | undefined {
  if (!threadId.startsWith("thread:")) return undefined;
  const [taskId, cls, cause, prRef, extra] = threadId.slice(7).split("::");
  if (!taskId || taskId.length > 256 || /[\s\u0000-\u001f]/.test(taskId) || extra !== undefined
    || !cls || !["BLOCKED", "MANUAL", "HARD_STOP", "GRILL"].includes(cls)
    || !cause || !["-", "review", "ci", "conflict", "stage-stall"].includes(cause)
    || !prRef || !/^(?:-|[1-9][0-9]*)$/.test(prRef)) return undefined;
  return { taskId, class: cls, ...(cause !== "-" ? { cause } : {}), ...(prRef !== "-" ? { prRef } : {}) };
}

/** Current merged feedback metadata, through the existing paced read transport. */
export async function readEscalationQuestionFeedback(repository: string, feedbackId: string, fresh = false): Promise<FeedbackEntry> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[A-Za-z0-9_-]{1,256}$/.test(feedbackId))
    throw new Error("A canonical repository and feedback identity are required.");
  const raw: unknown = JSON.parse(await ghTextAsync(["api", `repos/${repository}/contents/plan/feedback/${feedbackId}.yaml`],
    { timeout: 10_000, maxBuffer: 131_072, ...(fresh ? { fresh: true } : {}) }));
  const envelope = raw as { encoding?: unknown; content?: unknown } | null;
  if (envelope?.encoding !== "base64" || typeof envelope.content !== "string" || envelope.content.length > 100_000
    || !/^[A-Za-z0-9+/=\r\n]+$/.test(envelope.content)) throw new Error("The canonical feedback source is unreadable.");
  const bytes = Buffer.from(envelope.content, "base64");
  if (bytes.length > 65_536) throw new Error("The canonical feedback source exceeds its read bound.");
  const entry = parse(bytes.toString("utf8")) as FeedbackEntry | null;
  if (!entry || typeof entry !== "object" || entry.id !== feedbackId || typeof entry.raw !== "string" || typeof entry.status !== "string")
    throw new Error("The canonical feedback source has no matching identity.");
  return entry;
}

export type EscalationIntakeOutcome =
  | { action: "propose" | "no_task"; publicationPr: string; detail: string }
  | { action: "grill"; publicationPr: string; detail: string; questionIssueUrl: string }
  | { action: "error"; reason: string };

export type EscalationIntakeResult = { state: "recorded" | "existing"; seq: number }
  | { state: "not_applicable" | "unknown"; reason: string };

/** Only a published intake result may end an ask. Capture and interpreter success cannot. */
export function recordEscalationIntakeOutcome(entry: FeedbackEntry, outcome: EscalationIntakeOutcome,
  deps: ThreadStoreDeps & { repository: string }): EscalationIntakeResult {
  if (typeof entry.thread_id !== "string" || typeof entry.submission_key !== "string" || !entry.submission_key.startsWith("escalation-reply:"))
    return { state: "not_applicable", reason: "This intake has no bound escalation answer." };
  const unknown = (reason: string): EscalationIntakeResult => ({ state: "unknown", reason });
  const identity = escalationThreadIdentity(entry.thread_id);
  if (!identity || deriveThreadId(identity) !== entry.thread_id || typeof entry.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(entry.id) || typeof entry.raw !== "string")
    return unknown("The original escalation identity could not be verified.");
  const current = readThread(entry.thread_id, deps);
  if (current.status !== "ok") return unknown("The original conversation could not be read.");
  const answers = current.messages.filter(message => message.role === "reply" && message.extra?.replyId
    && message.extra.escalation && escalationReplySubmissionKey(entry.thread_id!, message.extra.replyId, message.extra.escalation.issueUrl) === entry.submission_key);
  const answer = answers.length === 1 ? answers[0] : undefined;
  if (!answer || answer.body.trim() !== entry.raw.trim() || answer.extra?.escalation === undefined
    || issue(answer.extra.escalation.issueUrl)?.toLowerCase() !== deps.repository.toLowerCase()
    || !/^[a-f0-9]{64}$/.test(answer.extra.escalation.revision)) return unknown("The intake does not match one exact saved answer.");
  if (outcome.action === "error") return unknown(outcome.reason);
  const publication = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/[1-9][0-9]*$/.exec(outcome.publicationPr);
  if (publication?.[1]?.toLowerCase() !== deps.repository.toLowerCase() || !outcome.detail || outcome.detail.length > 16_384 || outcome.detail.includes("\0"))
    return unknown("A bounded, source-matching intake publication is required.");
  if (outcome.action === "grill" && issue(outcome.questionIssueUrl)?.toLowerCase() !== deps.repository.toLowerCase())
    return unknown("The follow-up question is outside the original repository.");
  const body = outcome.action === "grill"
    ? `I need more information before I can proceed.\n\n${outcome.detail}\n\nQuestion: ${outcome.questionIssueUrl}\nIntake record: ${outcome.publicationPr}`
    : outcome.action === "propose"
      ? `I proposed a plan that is waiting for review: ${outcome.publicationPr}\n\n${outcome.detail}\n\nI need no more input now. Work remains pending.`
      : `I reviewed your answer. No task was proposed.\n\n${outcome.detail}\n\nIntake record: ${outcome.publicationPr}\nI need no more input now.`;
  const saved = appendThreadMessageOnce(identity, "escalation", body, `intake:${sha([entry.thread_id, entry.id])}`, deps,
    { question: outcome.action === "grill", intake: { feedbackId: entry.id, replyId: answer.extra.replyId!, replySeq: answer.seq,
      publicationPr: outcome.publicationPr, ...(outcome.action === "grill" ? { questionIssueUrl: outcome.questionIssueUrl } : {}) } });
  if ("reason" in saved) return unknown(saved.reason);
  return { state: saved.kind === "appended" ? "recorded" : "existing", seq: saved.seq };
}
