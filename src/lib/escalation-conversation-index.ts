import { createHash } from "node:crypto";
import { fixedClock, systemClock } from "./clock.js";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { parseAllThreads, type ThreadMessage, type ThreadStoreDeps } from "./inbox-thread.js";
import { escalationCorrespondenceAttention, escalationIssueLocation } from "./escalation-conversation.js";
import { escalationThreadIdentity } from "./escalation-correspondence.js";
import type { ThreadIdentity } from "./inbox-thread.js";
import type { Route } from "./service.js";
import type { BoardSnapshotState } from "./board.js";

export type EscalationMailboxAttention = "needs_input" | "waiting_for_agent" | "archived" | "unknown";
export interface EscalationMailboxBoard {
  state: "current" | "stale" | "unavailable";
  observedAt: string | null;
  flags: Array<{ issueUrl: string; taskId: string; sourceText: string; lastActivityAt?: string }>;
}
/** Reuse a dated native board; missing or stale coverage cannot claim a complete mailbox. */
export function escalationMailboxBoardFromSnapshot(state: BoardSnapshotState | undefined): EscalationMailboxBoard {
  if (state?.state !== "ready") return { state: "unavailable", observedAt: null, flags: [] };
  const snapshot = state.snapshot;
  return { state: snapshot.github_unreachable ? "unavailable" : snapshot.github_facts_status === "stale" ? "stale" : "current",
    observedAt: snapshot.generated_at,
    flags: snapshot.tasks.filter(task => typeof task.escalationIssueUrl === "string").map(task => ({
      issueUrl: task.escalationIssueUrl!, taskId: task.taskId, sourceText: task.title,
      ...(task.lastActivityAt ? { lastActivityAt: task.lastActivityAt } : {}),
    })) };
}

export interface EscalationMailboxItem {
  sourceKind: "engineering";
  issueUrl: string;
  threadId: string | null;
  identity: ThreadIdentity | null;
  subject: string;
  preview: string;
  attention: EscalationMailboxAttention;
  lastActivityAt: string | null;
  evidence: "saved_conversation" | "source_flag" | "conflicting_sources";
  sourceText: string;
}
type Folder = "all" | EscalationMailboxAttention;
type History = "complete" | "partial" | "unavailable" | "oversize";
export type EscalationConversationIndex = {
  state: "served"; version: 1; repository: string; snapshot: string; generatedAt: string;
  coverage: { state: "complete" | "incomplete"; board: EscalationMailboxBoard["state"]; history: History; detail: string };
  items: EscalationMailboxItem[];
  counts: { unit: "conversations"; loaded: number; total: number | null; byAttention: Record<EscalationMailboxAttention, number> | null };
  page: { folder: Folder; nextCursor: string | null; hasMore: boolean };
} | { state: "invalid_request" | "refresh_required"; detail: string };
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const MAX_ITEMS = 1000;
const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const folders: Folder[] = ["all", "needs_input", "waiting_for_agent", "archived", "unknown"];
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Bound the real store read, including growth during the read. Missing is unavailable, not empty. */
function savedHistory(path: string): { state: History; threads: Map<string, ThreadMessage[]>; revision: string } {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const before = fstatSync(fd);
    if (!before.isFile()) return { state: "unavailable", threads: new Map(), revision: "not-file" };
    if (before.size > MAX_STORE_BYTES) return { state: "oversize", threads: new Map(), revision: `oversize:${before.size}:${before.mtimeMs}` };
    const bytes = Buffer.alloc(before.size + 1); let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, size);
      if (n === 0) break;
      size += n;
    }
    const after = fstatSync(fd);
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      return { state: "partial", threads: new Map(), revision: "changed-during-read" };
    const raw = bytes.subarray(0, size).toString("utf8"), parsed = parseAllThreads(raw, "native conversation store");
    return parsed.status === "ok" ? { state: "complete", threads: parsed.threads, revision: sha(raw) }
      : { state: "partial", threads: new Map(), revision: sha(raw) };
  } catch {
    // Unreadable history is explicitly unavailable; it is never reported as a readable empty store.
    return { state: "unavailable", threads: new Map(), revision: "unreadable" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Reads native source receipts and the existing board only. It never fetches issues or writes messages. */
export function readEscalationConversationIndex(deps: ThreadStoreDeps & { repository: string; readBoard: () => EscalationMailboxBoard },
  request: { folder?: Folder; limit?: number; cursor?: string } = {}): EscalationConversationIndex {
  const folder = request.folder ?? "all", limit = request.limit ?? 30;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(deps.repository) || !folders.includes(folder)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    return { state: "invalid_request", detail: "Choose a supported folder and a page size from 1 to 50." };
  let board: EscalationMailboxBoard;
  try { board = deps.readBoard(); }
  catch { /* A failed board read withholds totals, preserving any readable saved conversations. */ board = { state: "unavailable", observedAt: null, flags: [] }; }
  const history = savedHistory(deps.threadStorePath), rows = new Map<string, EscalationMailboxItem>();
  let incomplete = history.state !== "complete" || board.state !== "current" || !instant(board.observedAt);
  if (!Array.isArray(board.flags) || board.flags.length > MAX_ITEMS) {
    board = { state: "unavailable", observedAt: null, flags: [] }; incomplete = true;
  }
  const sourceFlags = new Map<string, typeof board.flags[number]>();
  const issueKey = (url: string): string => { const location = escalationIssueLocation(url)!; return `${location.repository.toLowerCase()}/issues/${location.number}`; };
  const ownIssue = (value: unknown): value is string => typeof value === "string"
    && escalationIssueLocation(value)?.repository.toLowerCase() === deps.repository.toLowerCase();
  for (const flag of board.flags) {
    if (!ownIssue(flag.issueUrl) || typeof flag.taskId !== "string" || !flag.taskId || flag.taskId.length > 256
      || typeof flag.sourceText !== "string" || flag.sourceText.includes("\0")) { incomplete = true; continue; }
    const key = issueKey(flag.issueUrl), prior = sourceFlags.get(key);
    const conflicting = prior && prior.taskId !== flag.taskId || rows.get(key)?.evidence === "conflicting_sources";
    if (conflicting) incomplete = true;
    sourceFlags.set(key, flag);
    rows.set(key, { sourceKind: "engineering", issueUrl: flag.issueUrl, threadId: null, identity: null,
      subject: "Conversation about this task", preview: "The native conversation has not been verified.",
      attention: "unknown", lastActivityAt: instant(flag.lastActivityAt) ? flag.lastActivityAt : null,
      evidence: conflicting ? "conflicting_sources" : "source_flag", sourceText: flag.sourceText.slice(0, 500) });
  }
  const issueThreads = new Map<string, string>();
  for (const [threadId, messages] of history.threads) {
    const identity = typeof threadId === "string" ? escalationThreadIdentity(threadId) : undefined;
    if (typeof threadId !== "string" || !threadId.startsWith("thread:") || messages.some(message =>
      !message || typeof message !== "object" || typeof message.body !== "string" || !Number.isSafeInteger(message.seq)
      || !Number.isSafeInteger(message.ts) || !["reply", "escalation"].includes(message.role))) { incomplete = true; continue; }
    if (!identity) {
      // Proposal conversations stay with their inbox; malformed engineering identities withhold totals.
      if (/::(?:BLOCKED|MANUAL|HARD_STOP|GRILL)(?:::|$)/.test(threadId)) incomplete = true;
      continue;
    }
    if (!messages.length || messages.length > 100 || Buffer.byteLength(JSON.stringify(messages)) > 131072
      || messages.some((message, i) => message.threadId !== threadId || message.seq !== i + 1 || !Number.isSafeInteger(message.ts)
        || Math.abs(message.ts) > 8640000000000000 || typeof message.body !== "string" || message.body.includes("\0")
        || !["reply", "escalation"].includes(message.role))) { incomplete = true; continue; }
    const urls = new Set<string>(); let invalidReceipt = false;
    for (const message of messages) {
      for (const receipt of [message.extra?.escalation, message.extra?.sourceImport]) {
        if (receipt === undefined) continue;
        if (!ownIssue(receipt.issueUrl) || !hash(receipt.revision)) invalidReceipt = true;
        else urls.add(receipt.issueUrl);
      }
    }
    if (invalidReceipt || urls.size !== 1) { incomplete = true; continue; }
    const issueUrl = [...urls][0]!, key = issueKey(issueUrl), priorThread = issueThreads.get(key), flag = sourceFlags.get(key);
    const conflict = priorThread !== undefined && priorThread !== threadId || flag !== undefined && flag.taskId !== identity.taskId
      || rows.get(key)?.evidence === "conflicting_sources";
    issueThreads.set(key, threadId);
    if (conflict) {
      incomplete = true;
      rows.set(key, { sourceKind: "engineering", issueUrl, threadId: null, identity: null,
        subject: "Conversation needs verification", preview: "The saved sources disagree about this conversation.",
        attention: "unknown", lastActivityAt: null, evidence: "conflicting_sources", sourceText: "" });
      continue;
    }
    const last = messages.at(-1)!;
    const attention = escalationCorrespondenceAttention(messages, { sourceOpen: board.state === "current" && Boolean(flag),
      activeQuestion: last.role === "escalation" && last.extra?.question === true });
    rows.set(key, { sourceKind: "engineering", issueUrl, threadId, identity,
      subject: identity.prRef ? `Conversation about PR #${identity.prRef}` : "Conversation about this task",
      preview: last.body.slice(0, 500), attention, lastActivityAt: fixedClock(last.ts).iso(),
      evidence: "saved_conversation", sourceText: flag?.sourceText.slice(0, 500) ?? "Saved native conversation" });
    if (rows.size > MAX_ITEMS) { incomplete = true; break; }
  }
  const all = [...rows.values()].sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") || a.issueUrl.localeCompare(b.issueUrl)).slice(0, MAX_ITEMS);
  const snapshot = sha([deps.repository.toLowerCase(), board, history.revision, incomplete, all]);
  let offset = 0;
  if (request.cursor !== undefined) {
    try {
      if (request.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(request.cursor)) throw new Error("Invalid cursor encoding");
      const cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
      if (cursor.version !== 1 || cursor.repository !== deps.repository.toLowerCase() || cursor.folder !== folder
        || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0 || Number(cursor.offset) > MAX_ITEMS || !hash(cursor.snapshot))
        return { state: "invalid_request", detail: "This page does not belong to the selected repository and folder." };
      if (cursor.snapshot !== snapshot) return { state: "refresh_required", detail: "The conversation list changed. Refresh this folder before continuing." };
      offset = Number(cursor.offset);
    } catch {
      // An unreadable cursor is a refused request, not an empty page or a successful refresh.
      return { state: "invalid_request", detail: "The conversation page could not be verified. Refresh this folder." };
    }
  }
  const filtered = folder === "all" ? all : all.filter(item => item.attention === folder);
  if (offset !== 0 && offset >= filtered.length) return { state: "invalid_request", detail: "This page is outside the current folder. Refresh this folder." };
  const items = filtered.slice(offset, offset + limit);
  const next = offset + items.length, hasMore = next < filtered.length;
  const byAttention: Record<EscalationMailboxAttention, number> = { needs_input: 0, waiting_for_agent: 0, archived: 0, unknown: 0 };
  for (const row of all) byAttention[row.attention]++;
  return { state: "served", version: 1, repository: deps.repository, snapshot, generatedAt: fixedClock(deps.now?.() ?? systemClock.now()).iso(),
    coverage: { state: incomplete ? "incomplete" : "complete", board: board.state, history: history.state, detail: incomplete
      ? "Some conversation sources could not be verified. Folder totals are unknown."
      : "The current board and saved conversation store were read." }, items,
    counts: { unit: "conversations", loaded: items.length, total: incomplete ? null : all.length, byAttention: incomplete ? null : byAttention },
    page: { folder, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({ version: 1, repository: deps.repository.toLowerCase(), folder, snapshot, offset: next })).toString("base64url") : null } };
}

export function buildEscalationConversationIndexRoute(deps: Parameters<typeof readEscalationConversationIndex>[0]): Route {
  return { method: "GET", path: "/v1/escalation/threads", scope: "read", handler: (req, res) => {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const result = readEscalationConversationIndex(deps, { folder: (params.get("folder") ?? "all") as Folder,
      ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}), ...(params.has("cursor") ? { cursor: params.get("cursor")! } : {}) });
    res.writeHead(result.state === "served" ? 200 : result.state === "refresh_required" ? 409 : 400,
      { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(result));
  } };
}
