import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { ghTextAsync } from "./github-transport.js";
import { deriveThreadId, readAllThreads, type ThreadIdentity, type ThreadMessage } from "./inbox-thread.js";
import type { Route } from "./service.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";

const MAX_SOURCE_BYTES = 65_536;
const MAX_HISTORY_MESSAGES = 100;
const MAX_HISTORY_BYTES = 131_072;
const SOURCE_CACHE_MS = 15_000;
const MAX_CACHED_ISSUES = 32;
const RECEIPT_ROTATIONS = 8;
const CLASSES = new Set(["BLOCKED", "MANUAL", "HARD_STOP", "GRILL"]);
const CAUSES = new Set(["review", "ci", "conflict", "stage-stall"]);

export interface EscalationIssueSource {
  html_url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  updated_at: string;
}

export interface EscalationConversation {
  version: 1;
  issueUrl: string;
  repository: string;
  identity: ThreadIdentity;
  threadId: string;
  revision: string;
  headline: string;
  whatHappened: string;
  recommendation: string | null;
  options: { label: string; detail: string; executable: false }[];
  source: { state: "current" | "stale"; observedAt: string; updatedAt: string; revision: string };
  history: "verified" | "absent" | "unavailable" | "partial";
  attention: "needs_input" | "waiting_for_agent" | "archived" | "unknown";
  messages: { seq: number; from: "operator" | "daemon"; text: string; ts: number; intentId?: string; sourceImported?: true }[];
  canReply: boolean;
  canStartConversation: boolean;
  initialMessage?: string;
  recommendationReplies?: { accept?: string; decline: string };
  replyUnavailableReason?: string;
  details: string;
}

export type EscalationConversationRead =
  | { state: "served"; conversation: EscalationConversation }
  | { state: "unavailable"; reason: "invalid_request" | "wrong_repository" | "source_unavailable" | "invalid_source"; detail: string };

export type EscalationConversationReader = (issueUrl: string, fresh?: boolean) => Promise<EscalationConversationRead>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function escalationIssueLocation(value: string): { repository: string; number: number } | undefined {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return undefined;
  return { repository: match[1]!, number: Number(match[2]) };
}

/** Uses the native paced transport, including its sentinel, broker and process timeout. */
export async function readEscalationIssueSource(issueUrl: string): Promise<unknown> {
  const location = escalationIssueLocation(issueUrl);
  if (!location) throw new Error("A canonical escalation issue is required.");
  return JSON.parse(await ghTextAsync(["api", `repos/${location.repository}/issues/${location.number}`], {
    maxBuffer: MAX_SOURCE_BYTES * 2, timeout: 10_000,
  })) as unknown;
}

function sourceOf(raw: unknown, issueUrl: string): EscalationIssueSource | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.html_url !== issueUrl || typeof r.title !== "string" || r.title.length > 1024 || typeof r.body !== "string"
    || Buffer.byteLength(r.body) > MAX_SOURCE_BYTES || r.body.includes("\0") || r.pull_request !== undefined
    || (r.state !== "open" && r.state !== "closed") || typeof r.updated_at !== "string"
    || !Number.isFinite(Date.parse(r.updated_at))) return undefined;
  return { html_url: issueUrl, title: r.title, body: r.body, state: r.state, updated_at: r.updated_at };
}

/** Parse only the native writer's anchored metadata and sections, never instructions from prose. */
export function parseEscalationConversationSource(source: EscalationIssueSource): {
  identity: ThreadIdentity; headline: string; detail: string; recommendation: string | null;
  options: EscalationConversation["options"];
} | undefined {
  const [header = ""] = source.body.split(/\r?\n\r?\n/, 1);
  const field = (name: string): string | undefined => {
    const matches = [...header.matchAll(new RegExp(`^\\*\\*${name}:\\*\\* (.+)$`, "gm"))];
    return matches.length === 1 ? matches[0]![1]!.trim() : undefined;
  };
  const taskId = field("Task"), cls = field("Class"), cause = field("Cause");
  if (!taskId || taskId.length > 256 || /[\s\u0000-\u001f]/.test(taskId) || taskId.includes("::")
    || !cls || !CLASSES.has(cls) || (cause !== undefined && !CAUSES.has(cause))) return undefined;
  const prefix = `[${cls}] ${taskId}: `;
  if (!source.title.startsWith(prefix)) return undefined;
  let headline = source.title.slice(prefix.length).trim();
  const fullSummary = field("Full summary \\(JSON\\)");
  if (fullSummary !== undefined) {
    try {
      const parsed: unknown = JSON.parse(fullSummary);
      if (typeof parsed !== "string" || parsed.length > 16_384) return undefined;
      headline = parsed;
    } catch {
      // Malformed JSON and an invalid summary both mean an unsupported native source; neither can select a reply destination.
      return undefined;
    }
  }
  const optionsHeaders = [...source.body.matchAll(/^## Options\r?$/gm)];
  const recommendationHeaders = [...source.body.matchAll(/^## Recommendation\r?$/gm)];
  if (optionsHeaders.length !== 1 || recommendationHeaders.length !== 1) return undefined;
  const optionsAt = optionsHeaders[0]!.index!, recommendationAt = recommendationHeaders[0]!.index!;
  if (optionsAt >= recommendationAt) return undefined;
  const detail = source.body.slice(header.length, optionsAt).trim();
  // The footer is the native writer's source annotation, not recommendation text.
  const recommendation = source.body.slice(recommendationAt + recommendationHeaders[0]![0].length)
    .split(/\r?\n_Opened automatically by Remudero /, 1)[0]!.trim() || null;
  const optionsText = source.body.slice(optionsAt + optionsHeaders[0]![0].length, recommendationAt);
  const options = [...optionsText.matchAll(/^- \*\*(.+)\*\* — (.+)$/gm)]
    .map((match) => ({ label: match[1]!, detail: match[2]!, executable: false as const }));
  if (!headline || options.length > 24) return undefined;
  // These are the native producer's PR referent rules, exercised against its real writer in tests.
  const text = `${headline}\n${detail}`;
  const prRef = /\/pull\/(\d+)\b/.exec(text)?.[1] ?? /\bPR\s*#(\d+)\b/i.exec(text)?.[1] ?? /\bPR\s+(\d+)\b/i.exec(text)?.[1];
  return { identity: { taskId, class: cls, ...(cause ? { cause } : {}), ...(prRef ? { prRef } : {}) }, headline, detail, recommendation, options };
}

function boundedMessages(messages: ThreadMessage[]): EscalationConversation["messages"] | undefined {
  if (messages.length > MAX_HISTORY_MESSAGES || Buffer.byteLength(JSON.stringify(messages)) > MAX_HISTORY_BYTES
    || new Set(messages.map(m => m.seq)).size !== messages.length
    || messages.some(m => !Number.isSafeInteger(m.seq) || m.seq < 1 || !Number.isSafeInteger(m.ts)
      || Math.abs(m.ts) > 8_640_000_000_000_000
      || typeof m.body !== "string" || (m.role !== "reply" && m.role !== "escalation"))) return undefined;
  return messages.map(m => ({ seq: m.seq, from: m.role === "reply" ? "operator" : "daemon", text: m.body, ts: m.ts,
    ...(typeof m.extra?.replyId === "string" ? { intentId: m.extra.replyId } : {}),
    ...(typeof m.extra?.sourceImport?.issueUrl === "string" && escalationIssueLocation(m.extra.sourceImport.issueUrl)
      && /^[a-f0-9]{64}$/.test(m.extra.sourceImport.revision) ? { sourceImported: true as const } : {}) }));
}

/** Per-service bounded cache. Revalidating a reply bypasses saved source, while concurrent reads coalesce. */
export function createEscalationConversationReader(opts: {
  repository?: string; threadStorePath?: string; ledgerPath?: string; clock?: Clock; readIssue?: (issueUrl: string) => Promise<unknown>;
  knownIssue?: (issueUrl: string, identity: ThreadIdentity) => boolean;
}): EscalationConversationReader {
  const clock = opts.clock ?? systemClock;
  const cache = new Map<string, { source: EscalationIssueSource; observedAt: string; at: number }>();
  const pending = new Map<string, Promise<unknown>>();
  const nativeReceipts = new Set<string>();
  return async (issueUrl, fresh = false) => {
    const location = escalationIssueLocation(issueUrl);
    if (!location) return { state: "unavailable", reason: "invalid_request", detail: "Choose a canonical GitHub escalation issue." };
    if (!opts.repository || location.repository.toLowerCase() !== opts.repository.toLowerCase()) {
      return { state: "unavailable", reason: "wrong_repository", detail: "This escalation does not belong to the selected repository." };
    }
    const saved = cache.get(issueUrl);
    let evidence = saved;
    let stale = false;
    if (fresh || !saved || clock.now() - saved.at >= SOURCE_CACHE_MS || clock.now() < saved.at) {
      if (!pending.has(issueUrl) && pending.size >= MAX_CACHED_ISSUES) {
        return { state: "unavailable", reason: "source_unavailable", detail: "Escalation reads are busy. No current conversation was confirmed." };
      }
      let reading = pending.get(issueUrl);
      if (!reading) {
        reading = Promise.resolve().then(() => (opts.readIssue ?? readEscalationIssueSource)(issueUrl));
        pending.set(issueUrl, reading);
      }
      try {
        const source = sourceOf(await reading, issueUrl);
        if (!source) return { state: "unavailable", reason: "invalid_source", detail: "The escalation source could not be verified." };
        evidence = { source, observedAt: clock.iso(), at: clock.now() };
        if (cache.size >= MAX_CACHED_ISSUES && !cache.has(issueUrl)) cache.delete(cache.keys().next().value!);
        cache.set(issueUrl, evidence);
      } catch {
        if (!saved || fresh) return { state: "unavailable", reason: "source_unavailable", detail: "The current escalation source could not be read. No reply was sent." };
        stale = true;
      } finally {
        if (pending.get(issueUrl) === reading) pending.delete(issueUrl);
      }
    }
    if (!evidence) return { state: "unavailable", reason: "source_unavailable", detail: "No escalation source is available." };
    const source = evidence.source;
    const parsed = parseEscalationConversationSource(source);
    if (!parsed) return { state: "unavailable", reason: "invalid_source", detail: "This issue has no supported native escalation identity. It cannot be used as a reply destination." };
    const receiptKey = `${issueUrl}|${parsed.identity.taskId}|${parsed.identity.class}`;
    let known = nativeReceipts.has(receiptKey);
    let provenanceFailure: { reason: "board_unavailable" | "ledger_unavailable" } | undefined;
    try { known ||= opts.knownIssue?.(issueUrl, parsed.identity) === true; }
    catch { provenanceFailure = { reason: "board_unavailable" }; }
    if (!known && opts.ledgerPath) {
      try {
        // A bounded positive search proves native origin. A negative or incomplete search proves nothing.
        readLedgerUnionRecordsSync(dirname(opts.ledgerPath), { liveFirst: true, order: "newest-first", maxRotations: RECEIPT_ROTATIONS,
          step: ["escalation.issue_opened", "escalation.deduped"],
          pattern: new RegExp(issueUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          onRecord: row => { if (row.issue_url === issueUrl && row.task_id === parsed.identity.taskId && row.class === parsed.identity.class) known = true; },
          satisfied: () => known,
        });
      } catch { known = false; provenanceFailure = { reason: "ledger_unavailable" }; }
    }
    let stored: ReturnType<typeof readAllThreads> | undefined;
    try { stored = opts.threadStorePath ? readAllThreads({ threadStorePath: opts.threadStorePath }) : undefined; }
    catch { stored = { status: "unresolved", reason: "The saved discussion could not be read." }; }
    const prefix = `thread:${parsed.identity.taskId}::${parsed.identity.class}::${parsed.identity.cause ?? "-"}::`;
    // Match the writer's saved summary/detail, rather than infer a PR from a generated decision summary.
    const candidates = stored?.status === "ok" ? [...stored.threads].filter(([id, messages]) => typeof id === "string"
      && id.startsWith(prefix) && /^(?:-|[1-9][0-9]*)$/.test(id.slice(prefix.length))
      && messages.some(m => m?.role === "escalation" && typeof m.body === "string"
        && m.body.startsWith(`${parsed.headline}\n\n`) && source.body.includes(m.body.slice(parsed.headline.length + 2)))) : [];
    const selected = candidates.length === 1 ? candidates[0] : undefined;
    if (!selected && /^## Decision Summary\r?$/m.test(source.body)) {
      return { state: "unavailable", reason: "invalid_source", detail: "The source includes generated context, but no saved native identity could distinguish it from the original escalation. No reply destination is confirmed." };
    }
    const identity: ThreadIdentity = selected ? { taskId: parsed.identity.taskId, class: parsed.identity.class,
      ...(parsed.identity.cause ? { cause: parsed.identity.cause } : {}),
      ...(selected[0].slice(prefix.length) !== "-" ? { prRef: selected[0].slice(prefix.length) } : {}) } : parsed.identity;
    const threadId = deriveThreadId(identity);
    const messages = selected ? boundedMessages(selected[1]) : undefined;
    const history = stored?.status !== "ok" ? "unavailable" : candidates.length === 0
      ? stored.threads.get(threadId)?.length ? "partial" : "absent" : !messages ? "partial" : "verified";
    // A bound answer in this native store is a durable receipt of the route's prior
    // origin check. Archived correspondence must remain readable after a restart and
    // ledger rotation; an unbound legacy message or another issue's receipt proves nothing.
    known ||= history === "verified" && selected![1].some(message => message.role === "reply"
      && typeof message.extra?.replyId === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(message.extra.replyId)
      && message.extra.escalation?.issueUrl === issueUrl && /^[a-f0-9]{64}$/.test(message.extra.escalation.revision));
    if (!known) return { state: "unavailable", reason: provenanceFailure ? "source_unavailable" : "invalid_source", detail: provenanceFailure
      ? "Native escalation evidence is unavailable. No reply destination is confirmed."
      : "Remudero's own record of this escalation could not be verified. No reply destination is confirmed." };
    if (nativeReceipts.size >= MAX_CACHED_ISSUES && !nativeReceipts.has(receiptKey)) nativeReceipts.delete(nativeReceipts.values().next().value!);
    nativeReceipts.add(receiptKey);
    const ordered = history === "verified" ? [...selected![1]].sort((a, b) => a.seq - b.seq) : [];
    const last = ordered.at(-1);
    // Only an explicit agent message can end correspondence. Saving an answer or an
    // unconfigured interpreter's "understood" does not establish that the agent needs no input.
    const attention = !last ? "unknown" : last.role === "reply" ? "waiting_for_agent"
      : last.extra?.question === false && ordered.some(message => message.role === "reply") ? "archived"
        : source.state === "closed" ? "unknown" : "needs_input";
    const canReply = !stale && source.state === "open" && history === "verified";
    // Starting is a separate, explicit write. Unknown/corrupt history never qualifies,
    // and generated summaries cannot supply an unstored native PR referent.
    const canStartConversation = !stale && source.state === "open" && history === "absent"
      && Boolean(opts.threadStorePath && existsSync(opts.threadStorePath))
      && !/^## Decision Summary\r?$/m.test(source.body);
    const sourceRevision = digest([source.html_url, source.body, source.title, source.updated_at, source.state]);
    const acceptedText = parsed.recommendation ? `I accept this recommendation: ${parsed.recommendation}` : undefined;
    const recommendationReplies = (canReply && attention === "needs_input" || canStartConversation) && (messages === undefined || messages.every(message => message.from !== "operator")) && acceptedText ? {
      ...(acceptedText.length <= 4000 ? { accept: acceptedText } : {}),
      decline: "I decline this recommendation. Please suggest another approach.",
    } : undefined;
    return { state: "served", conversation: {
      version: 1, issueUrl, repository: location.repository, identity, threadId,
      revision: digest([sourceRevision, threadId, messages ?? history, attention, canStartConversation, recommendationReplies ?? null]), headline: parsed.headline,
      whatHappened: parsed.detail, recommendation: parsed.recommendation, options: parsed.options,
      source: { state: stale ? "stale" : "current", observedAt: evidence.observedAt, updatedAt: source.updated_at, revision: sourceRevision },
      history, attention, messages: messages ?? [], canReply, canStartConversation,
      ...(canStartConversation ? { initialMessage: `${parsed.headline}\n\n${parsed.detail}` } : {}),
      ...(recommendationReplies ? { recommendationReplies } : {}),
      ...(!canReply && !canStartConversation ? { replyUnavailableReason: stale ? "The saved source is stale. Refresh before replying."
        : source.state === "closed" ? "This escalation is closed. Earlier messages remain readable."
          : "The complete saved discussion could not be verified. No reply destination is confirmed." } : {}),
      details: source.body,
    } };
  };
}

export function buildEscalationConversationRoute(read: EscalationConversationReader): Route {
  return { method: "GET", path: "/v1/escalation/thread", scope: "read", handler: async (req, res) => {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const result = await read(params.get("issueUrl") ?? "");
    const status = result.state === "served" ? 200 : result.reason === "invalid_request" ? 400
      : result.reason === "wrong_repository" ? 404 : result.reason === "invalid_source" ? 422 : 503;
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result));
  } };
}
