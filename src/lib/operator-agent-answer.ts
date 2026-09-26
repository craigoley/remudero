/** Bounded, read-only answers over the process-owned analytics projection. No model or ledger scan. */
import type { AnalyticsSnapshot, ConsoleV1Metric } from "./analytics-route.js";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { proposalIdOfThread } from "./inbox-thread.js";
import { jsonAction, sendJson } from "./panel-actions.js";
import type { Route } from "./service.js";

const MAX_QUESTION = 500;
const MAX_ANSWER = 700;
const MAX_CITATIONS = 4;
const FRESH_MS = 30 * 60_000;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_INBOX_STORE_BYTES = 256 * 1024;

export type InboxAnswerEvidence =
  | { status: "measured"; threadCount: number; latestFleetMessageCount: number; observedAt: string }
  | { status: "unavailable"; reason: string };

/** Read only a small, server-owned thread store; never serialize message bodies or claim actionability. */
export function readInboxAnswerEvidence(path: string, readBytes: typeof readSync = readSync): InboxAnswerEvidence {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { status: "unavailable", reason: "the thread-message store is absent or unreadable" };
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_INBOX_STORE_BYTES) return { status: "unavailable", reason: "the thread-message store exceeds the bounded read limit" };
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readBytes(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) return { status: "unavailable", reason: "the thread-message store changed during the bounded read" };
      offset += read;
    }
    const after = fstatSync(fd);
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) return { status: "unavailable", reason: "the thread-message store changed during the bounded read" };
    const latest = new Map<string, { seq: number; role: string }>();
    for (const line of buffer.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let row: unknown;
      try { row = JSON.parse(line); } catch { return { status: "unavailable", reason: "the thread-message store could not be parsed" }; }
      if (!row || typeof row !== "object" || Array.isArray(row)) return { status: "unavailable", reason: "the thread-message store contains an invalid row" };
      const message = row as Record<string, unknown>;
      if (typeof message.threadId !== "string" || !Number.isInteger(message.seq) || Number(message.seq) < 1 ||
          (message.role !== "escalation" && message.role !== "reply") || typeof message.ts !== "number" || !Number.isFinite(message.ts)) {
        return { status: "unavailable", reason: "the thread-message store contains an invalid row" };
      }
      if (proposalIdOfThread(message.threadId) === undefined) continue;
      const prior = latest.get(message.threadId);
      if (!prior || Number(message.seq) > prior.seq) latest.set(message.threadId, { seq: Number(message.seq), role: message.role });
    }
    return {
      status: "measured", threadCount: latest.size,
      latestFleetMessageCount: [...latest.values()].filter((message) => message.role === "escalation").length,
      observedAt: info.mtime.toISOString(),
    };
  } catch {
    return { status: "unavailable", reason: "the thread-message store could not be read" };
  } finally {
    closeSync(fd);
  }
}

export type AnswerCoverage = "verified" | "partial" | "unavailable" | "unsupported";
export interface AnswerCitation {
  sourceId: string;
  observedAt: string;
  freshness: "verified" | "stale";
  label: string;
  value: string;
}
export interface OperatorAgentAnswer {
  version: "answer-v1";
  repository: string | null;
  instance: string;
  lens: "current-repository";
  coverage: AnswerCoverage;
  answer: string;
  citations: AnswerCitation[];
  missingSources: Array<{ sourceId: string; reason: string }>;
  generatedAt: string;
}

interface AnswerInput {
  question: string;
  repository?: string;
  instance: string;
  snapshot: Pick<AnalyticsSnapshot, "asOf" | "consoleV1" | "queue">;
  inbox?: InboxAnswerEvidence;
  now?: number;
}

function topicFor(question: string): "proof" | "outcomes" | "capacity" | "decisions" | "cost" | "inbox" | "unsupported" {
  const q = question.toLowerCase();
  if (/\binbox|message|reply|thread\b/.test(q)) return "inbox";
  if (/\bproof|validation|test failure\b/.test(q)) return "proof";
  if (/\brevert|task outcome|follow.?up fix\b/.test(q)) return "outcomes";
  if (/\bapproval|approve|accept|reject|hold|operator decision\b/.test(q)) return "decisions";
  if (/\bworker|fleet|capacity|queue|utilization|scale\b/.test(q)) return "capacity";
  if (/\btoken|spend|cost|run|repository|repo\b/.test(q)) return "cost";
  return "unsupported";
}

function metric(snapshot: AnswerInput["snapshot"], key: ConsoleV1Metric["key"]): ConsoleV1Metric | undefined {
  return snapshot.consoleV1.metrics.find((item) => item.key === key);
}

/** Only server-owned, aggregate evidence may become an answer; no arbitrary question text is interpolated. */
export function buildOperatorAgentAnswer(input: AnswerInput): OperatorAgentAnswer {
  const now = input.now ?? Date.now();
  const generatedAt = new Date(now).toISOString();
  const repository = input.repository && REPOSITORY.test(input.repository) ? input.repository : null;
  const base = {
    version: "answer-v1" as const,
    repository,
    instance: input.instance,
    lens: "current-repository" as const,
    generatedAt,
  };
  const unavailable = (sourceId: string, reason: string): OperatorAgentAnswer => ({
    ...base, coverage: "unavailable", answer: `I can't verify that for this repository: ${reason}.`,
    citations: [], missingSources: [{ sourceId, reason }],
  });
  if (!repository) return unavailable("server.repository", "the serving instance has no verified repository identity");
  const namedRepos = input.question.match(/(?<![\/A-Za-z0-9_.-])[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/g) ?? [];
  if (namedRepos.some((name) => name.toLowerCase() !== repository.toLowerCase())) return {
    ...base, coverage: "unsupported", answer: `This instance can answer only for ${repository}; choose another connected repository in the console.`,
    citations: [], missingSources: [{ sourceId: "server.repository", reason: "question names another repository" }],
  };
  const topic = topicFor(input.question);
  if (topic === "unsupported") return {
    ...base, coverage: "unsupported", answer: "I don't have a supported evidence source for that question yet.",
    citations: [], missingSources: [{ sourceId: "answer-v1", reason: "no supported question category" }],
  };
  if (topic === "inbox") {
    if (!input.inbox || input.inbox.status === "unavailable") return unavailable("/v1/inbox/threads", input.inbox?.reason ?? "the thread-message store is not configured");
    const sourceAt = input.inbox.observedAt;
    const age = now - Date.parse(sourceAt);
    if (!Number.isFinite(age) || age < 0) return unavailable("/v1/inbox/threads", "the thread-message store has no valid observation time");
    return {
      ...base, coverage: "partial",
      answer: `For ${repository}, the bounded thread-message store contains ${input.inbox.threadCount} inbox conversations; ${input.inbox.latestFleetMessageCount} have a fleet message as the latest stored message. That does not establish which need your reply.`,
      citations: [{ sourceId: "/v1/inbox/threads#message-store", observedAt: sourceAt, freshness: age <= FRESH_MS ? "verified" : "stale", label: "Stored inbox threads", value: String(input.inbox.threadCount) }],
      missingSources: [{ sourceId: "/v1/inbox", reason: "proposal classification and read marks are not part of this bounded thread-message projection" }],
    };
  }
  const observedAt = input.snapshot.asOf;
  const observedMs = observedAt === null ? NaN : Date.parse(observedAt);
  if (!observedAt || !Number.isFinite(observedMs) || observedMs > now || now - observedMs > 24 * 60 * 60_000) {
    return unavailable("/v1/analytics", "the analytics snapshot has not completed a recent readable refresh");
  }
  const snapshotFreshness = now - observedMs <= FRESH_MS ? "verified" : "stale";
  const citations: AnswerCitation[] = [];
  const missingSources: OperatorAgentAnswer["missingSources"] = [];
  const missing = (sourceId: string, reason: string): void => { missingSources.push({ sourceId, reason }); };
  const add = (sourceId: string, label: string, value: string, sourceAt = observedAt): void => {
    const atMs = Date.parse(sourceAt);
    if (!Number.isFinite(atMs) || atMs > now) {
      missing(sourceId, "the source observation time is invalid");
      return;
    }
    const freshness = now - atMs <= FRESH_MS ? "verified" : "stale";
    if (citations.length < MAX_CITATIONS) citations.push({ sourceId, observedAt: sourceAt, freshness, label, value });
    if (freshness === "stale" && sourceAt !== observedAt) missing(sourceId, "the underlying observation is stale");
  };
  const agent = input.snapshot.consoleV1.operatorAgent;
  let answer = "";
  if (topic === "proof") {
    const proof = agent.proof;
    if (proof.status === "measured" && proof.denominator !== null) {
      add("/v1/analytics#consoleV1.operatorAgent.proof", "Executed proofs", `${proof.executedPass} passed, ${proof.executedFail} failed of ${proof.denominator}`);
      answer = `For ${repository}, ${proof.executedPass} of ${proof.denominator} executed proofs passed; ${proof.executedFail} failed.`;
    } else missing("/v1/analytics#consoleV1.operatorAgent.proof", proof.unavailableReason ?? "no executable proof denominator was observed");
  } else if (topic === "outcomes") {
    const outcomes = agent.outcomes;
    if (outcomes.status === "measured") {
      add("/v1/analytics#consoleV1.operatorAgent.outcomes", "Classified task arms", `${outcomes.armsClassified} of ${outcomes.armsSeen}`);
      answer = `For ${repository}, ${outcomes.armsClassified} of ${outcomes.armsSeen} task arms have classified outcomes.`;
      if (outcomes.armsClassified < outcomes.armsSeen) missing("/v1/analytics#consoleV1.operatorAgent.outcomes.unmeasurable", `${outcomes.armsSeen - outcomes.armsClassified} arms lack a classified outcome`);
    } else missing("/v1/analytics#consoleV1.operatorAgent.outcomes", outcomes.unavailableReason ?? "task-outcome joins are not collected");
  } else if (topic === "decisions") {
    const decisions = agent.decisions;
    if (decisions.status === "measured") {
      add("/v1/analytics#consoleV1.operatorAgent.decisions", "Explicit operator decisions", String(decisions.explicitDecisionCount));
      answer = `For ${repository}, ${decisions.explicitDecisionCount} explicit operator decisions were measured. Automatic merge events are separate and do not count as operator approvals.`;
    } else missing("/v1/analytics#consoleV1.operatorAgent.decisions", "explicit operator decisions are not collected");
  } else if (topic === "capacity") {
    const capacity = agent.capacity;
    const measured = capacity.measurements.filter((row) => row.repo.toLowerCase() === repository.toLowerCase()).at(-1);
    if (capacity.status === "measured" && measured) {
      add("/v1/analytics#consoleV1.operatorAgent.capacity", "Workers and queue", `${measured.activeWorkers}/${measured.configuredCapacity} active; ${measured.queuedWork} queued`, measured.windowEnd);
      answer = `For ${repository}, ${measured.activeWorkers} of ${measured.configuredCapacity} workers were active and ${measured.queuedWork} tasks were queued in the measured window.`;
    } else {
      missing("/v1/analytics#consoleV1.operatorAgent.capacity", "a complete worker-capacity window was not measured for this repository");
      const queue = input.snapshot.queue.pending;
      if (queue.state === "observed" && queue.value !== undefined && queue.asOf && Number.isFinite(Date.parse(queue.asOf))) {
        add("/v1/analytics#queue.pending", "Queue pending", String(queue.value), queue.asOf);
        answer = `For ${repository}, ${queue.value} tasks were queued; worker utilization is unavailable, so this does not justify a scaling recommendation.`;
      }
    }
  } else {
    const tokens = metric(input.snapshot, "tokens.total");
    const cost = metric(input.snapshot, "cost.modeled.usd");
    if (tokens?.value !== null && tokens?.value !== undefined) add("/v1/analytics#consoleV1.tokens.total", "Provider-reported tokens", String(tokens.value));
    else missing("/v1/analytics#consoleV1.tokens.total", tokens?.notCollectedReason ?? "token total not collected");
    if (cost?.value !== null && cost?.value !== undefined) add("/v1/analytics#consoleV1.cost.modeled.usd", "Modeled cost USD", String(cost.value));
    else missing("/v1/analytics#consoleV1.cost.modeled.usd", cost?.notCollectedReason ?? "modeled cost not collected");
    if (citations.length > 0) answer = `For ${repository}, the observed total is ${tokens?.value ?? "unavailable"} provider-reported tokens and $${cost?.value ?? "unavailable"} modeled cost. This is not a cash-spend receipt.`;
  }
  if (snapshotFreshness === "stale") missing("/v1/analytics#asOf", "the latest analytics snapshot is stale");
  if (citations.length === 0) return { ...base, coverage: "unavailable", answer: "I can't verify that from the available evidence for this repository.", citations, missingSources };
  return {
    ...base, coverage: missingSources.length > 0 ? "partial" : "verified",
    answer: answer.slice(0, MAX_ANSWER), citations, missingSources,
  };
}

export function buildOperatorAgentAnswerRoute(deps: { repository?: string; instance: string; snapshot: () => AnswerInput["snapshot"]; inboxStorePath?: string; now?: () => number; project?: typeof buildOperatorAgentAnswer }): Route {
  return {
    method: "POST", path: "/v1/operator-agent/ask", scope: "read", sensitivity: "sensitive",
    handler: jsonAction((body: unknown): { question: string } | { error: string } => {
      if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body must contain one question" };
      const fields = Object.keys(body);
      if (fields.length !== 1 || fields[0] !== "question") return { error: "agent ask route rejects forged repository scope and unknown fields" };
      const question = (body as { question?: unknown }).question;
      if (typeof question !== "string" || !question.trim() || question.length > MAX_QUESTION) return { error: "question must be 1 to 500 characters" };
      return { question: question.trim() };
    }, (input, _req, res) => {
      const answer = (deps.project ?? buildOperatorAgentAnswer)({ ...input, repository: deps.repository, instance: deps.instance, snapshot: deps.snapshot(), inbox: deps.inboxStorePath ? readInboxAnswerEvidence(deps.inboxStorePath) : undefined, now: deps.now?.() });
      sendJson(res, 200, answer);
    }),
  };
}
