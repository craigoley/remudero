import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { BoardSnapshotState } from "./board.js";
import { systemClock, type Clock } from "./clock.js";
import { boundedMessages, escalationIssueLocation, projectEscalationCorrespondence, type EscalationAttention } from "./escalation-conversation.js";
import { readAllThreads, type ThreadMessage } from "./inbox-thread.js";
import type { Route } from "./service.js";

/** One list read bounds: rows retained per snapshot, rows per page, text per row, store bytes read. */
export const ESCALATION_INDEX_MAX_ROWS = 2_000;
export const ESCALATION_INDEX_MAX_LIMIT = 50;
export const ESCALATION_INDEX_DEFAULT_LIMIT = 25;
export const ESCALATION_INDEX_MAX_TEXT = 200;
export const ESCALATION_INDEX_MAX_STORE_BYTES = 16 * 1024 * 1024;
const NATIVE_CLASSES = new Set(["BLOCKED", "MANUAL", "HARD_STOP", "GRILL"]);
const FOLDERS: readonly EscalationAttention[] = ["needs_input", "waiting_for_agent", "archived", "unknown"];

export interface EscalationIndexBoardFlag { taskId: string; issueUrl: string; title?: string; openedAt?: string; unverified?: boolean }
export type EscalationIndexBoard =
  | { state: "ready"; flags: readonly EscalationIndexBoardFlag[] }
  | { state: "unavailable"; reason: string };

export type EscalationIndexSourceState = "complete" | "unavailable";
export type EscalationIndexSourceKind = "saved_thread" | "board_flag" | "saved_thread_and_board_flag";

export interface EscalationIndexItem {
  id: string;
  issueUrl: string;
  threadId: string | null;
  identity: { taskId: string; class: string; cause?: string; prRef?: string } | null;
  identityState: "verified" | "unverified";
  source: { kind: EscalationIndexSourceKind; taskId: string; headline: string | null };
  correspondence: { state: EscalationAttention; reason?: "identity_unverified" | "history_incomplete" | "source_unverified" };
  history: "verified" | "partial" | "absent";
  lastActivityAt: string | null;
  messageCount: number;
  preview: { from: "operator" | "daemon"; text: string } | null;
}

export type EscalationIndexFolderCounts = Record<EscalationAttention, number | null>;
export interface EscalationIndexRead {
  state: "served";
  version: 1;
  repository: string;
  snapshot: { version: string; observedAt: string };
  coverage: {
    state: "complete" | "partial" | "unavailable";
    sources: { threads: EscalationIndexSourceState; board: EscalationIndexSourceState };
    truncated: boolean;
    conflicts: number;
    incompleteHistory: number;
    unboundThreads: number;
    reasons: string[];
  };
  counts: {
    unit: "unique_conversations";
    scope: "repository_snapshot";
    complete: boolean;
    total: number | null;
    folders: EscalationIndexFolderCounts;
    loaded: { total: number; folders: Record<EscalationAttention, number> };
  };
  items: EscalationIndexItem[];
  page: { limit: number; folder: EscalationAttention | null; nextCursor: string | null };
}
export type EscalationIndexResult =
  | EscalationIndexRead
  | { state: "unavailable"; reason: "invalid_request" | "refresh_required" | "source_unavailable"; detail: string };
export type EscalationIndexReader = (query: { limit?: string | null; cursor?: string | null; folder?: string | null }) => EscalationIndexResult;

export interface EscalationIndexDeps {
  repository?: string;
  threadStorePath?: string;
  readBoard: () => EscalationIndexBoard;
  clock?: Clock;
  /** Seam over the saved-thread read; the default is the size-bounded real store read. */
  readThreads?: (path: string) => ReturnType<typeof readAllThreads>;
}

/** The board snapshot's escalation flags, or an explicit outage; an absent source is never an empty board. */
export function boardFlagsOf(state: BoardSnapshotState | undefined): EscalationIndexBoard {
  if (state?.state !== "ready") return { state: "unavailable", reason: state?.reason ?? "no board snapshot source" };
  return { state: "ready", flags: state.snapshot.tasks.flatMap(task => task.escalationIssueUrl ? [{
    taskId: task.taskId, issueUrl: task.escalationIssueUrl,
    ...(task.escalationTitle ? { title: task.escalationTitle } : {}),
    ...(task.escalationOpenedAt ? { openedAt: task.escalationOpenedAt } : {}),
    ...(task.escalationUnverified ? { unverified: true } : {}),
  }] : []) };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function clip(text: string): string {
  return text.length > ESCALATION_INDEX_MAX_TEXT ? `${text.slice(0, ESCALATION_INDEX_MAX_TEXT - 1)}…` : text;
}

function isoOf(ms: number): string | null {
  return Number.isFinite(ms) && Math.abs(ms) <= 8_640_000_000_000_000 ? new Date(ms).toISOString() : null;
}

function defaultReadThreads(path: string): ReturnType<typeof readAllThreads> {
  const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
  if (size > ESCALATION_INDEX_MAX_STORE_BYTES) return { status: "unresolved", reason: "The saved discussion store exceeds the index read bound." };
  return readAllThreads({ threadStorePath: path });
}

function parseThreadId(id: string): { taskId: string; class: string; cause?: string; prRef?: string } | undefined {
  if (typeof id !== "string" || !id.startsWith("thread:")) return undefined;
  const parts = id.slice("thread:".length).split("::");
  if (parts.length !== 4 || !parts[0] || !NATIVE_CLASSES.has(parts[1]!)) return undefined;
  return { taskId: parts[0], class: parts[1]!,
    ...(parts[2] !== "-" ? { cause: parts[2]! } : {}), ...(parts[3] !== "-" ? { prRef: parts[3]! } : {}) };
}

interface Snapshot { rows: EscalationIndexItem[]; coverage: EscalationIndexRead["coverage"]; complete: boolean }

/** Build the whole repository snapshot from the saved thread store and the current board, writing nothing. */
export function buildEscalationIndexSnapshot(deps: EscalationIndexDeps): Snapshot {
  const reasons: string[] = [];
  const repository = deps.repository?.toLowerCase();
  let threads: Map<string, ThreadMessage[]> | undefined;
  if (!deps.threadStorePath) reasons.push("The saved discussion store is not configured.");
  else {
    try {
      const read = (deps.readThreads ?? defaultReadThreads)(deps.threadStorePath);
      if (read.status === "ok") threads = read.threads; else reasons.push("The saved discussions could not be read.");
    } catch {
      // A store that throws mid-parse is an unreadable source, never an empty mailbox.
      reasons.push("The saved discussions could not be read.");
    }
  }
  let board: EscalationIndexBoard;
  try { board = deps.readBoard(); }
  catch { board = { state: "unavailable", reason: "board read failed" }; }
  if (board.state !== "ready") reasons.push("The current board flags are unavailable.");
  if (!repository) reasons.push("No serving repository is configured.");

  let conflicts = 0, incompleteHistory = 0, unboundThreads = 0, truncated = false;
  type Saved = { threadId: string; identity: NonNullable<ReturnType<typeof parseThreadId>>; messages: ThreadMessage[]; urls: Set<string> };
  const saved: Saved[] = [];
  if (threads && repository) {
    for (const [threadId, raw] of threads) {
      const identity = parseThreadId(threadId);
      if (!identity) continue;
      const messages = [...raw].filter(m => m !== null && typeof m === "object" && Number.isSafeInteger(m.seq)).sort((a, b) => a.seq - b.seq);
      const urls = new Set<string>();
      let foreign = false;
      for (const m of messages) {
        for (const url of [m.extra?.escalation?.issueUrl, m.extra?.sourceImport?.issueUrl]) {
          if (typeof url !== "string") continue;
          const location = escalationIssueLocation(url);
          if (!location || location.repository.toLowerCase() !== repository) foreign = true; else urls.add(url);
        }
      }
      if (foreign) { conflicts++; continue; }
      saved.push({ threadId, identity, messages, urls });
    }
  }
  // One issue may name one thread, and one thread one issue; anything else is rejected, not chosen between.
  const claims = new Map<string, Set<string>>();
  for (const s of saved) for (const url of s.urls) claims.set(url, new Set([...(claims.get(url) ?? []), s.threadId]));
  const flagsByUrl = new Map<string, EscalationIndexBoardFlag>();
  const rejectedUrls = new Set<string>();
  if (board.state === "ready" && repository) {
    for (const flag of board.flags) {
      const location = typeof flag?.issueUrl === "string" ? escalationIssueLocation(flag.issueUrl) : undefined;
      if (!location || location.repository.toLowerCase() !== repository || typeof flag.taskId !== "string" || !flag.taskId) { conflicts++; continue; }
      const prior = flagsByUrl.get(flag.issueUrl);
      if (prior && prior.taskId !== flag.taskId) { rejectedUrls.add(flag.issueUrl); continue; }
      if (!prior) flagsByUrl.set(flag.issueUrl, flag);
    }
  }
  const rows: EscalationIndexItem[] = [];
  const usedUrls = new Set<string>();
  for (const s of saved) {
    if (s.urls.size === 0) { unboundThreads++; continue; }
    const [issueUrl] = [...s.urls];
    const flag = flagsByUrl.get(issueUrl!);
    if (s.urls.size > 1 || claims.get(issueUrl!)!.size > 1 || rejectedUrls.has(issueUrl!) || (flag && flag.taskId !== s.identity.taskId)) {
      conflicts++; for (const u of s.urls) usedUrls.add(u); continue;
    }
    usedUrls.add(issueUrl!);
    const bounded = boundedMessages(s.messages);
    const last = bounded ? s.messages.at(-1) : undefined;
    const sourceOpen = flag !== undefined && flag.unverified !== true;
    const state = projectEscalationCorrespondence({ last, hasReply: s.messages.some(m => m.role === "reply"),
      // An agent question naming a native follow-up issue is verified only by the detail read.
      questionFailure: last?.role === "escalation" && last.extra?.question === true && last.extra.intake?.questionIssueUrl !== undefined,
      activeQuestion: false, sourceOpen });
    if (!bounded) incompleteHistory++;
    const first = s.messages.find(m => m.role === "escalation");
    const lastOut = bounded ? bounded.at(-1) : undefined;
    rows.push({ id: `issue:${issueUrl}`, issueUrl: issueUrl!, threadId: s.threadId, identity: s.identity, identityState: "verified",
      source: { kind: flag ? "saved_thread_and_board_flag" : "saved_thread", taskId: s.identity.taskId,
        headline: first ? clip(first.body.split("\n", 1)[0]!) : flag?.title ? clip(flag.title) : null },
      correspondence: { state, ...(!bounded ? { reason: "history_incomplete" as const }
        : last?.role === "escalation" && last.extra?.question === true && last.extra.intake?.questionIssueUrl !== undefined ? { reason: "source_unverified" as const }
        : state === "unknown" && last?.role === "escalation" && !sourceOpen ? { reason: "source_unverified" as const } : {}) },
      history: bounded ? "verified" : "partial",
      lastActivityAt: s.messages.length > 0 ? isoOf(s.messages.at(-1)!.ts) : flag?.openedAt ?? null,
      messageCount: s.messages.length,
      preview: lastOut ? { from: lastOut.from, text: clip(lastOut.text) } : null });
  }
  for (const [issueUrl, flag] of flagsByUrl) {
    if (usedUrls.has(issueUrl)) continue;
    if (rejectedUrls.has(issueUrl)) { conflicts++; continue; }
    // A flag with no receipt-bound history keeps its native URL; its class and thread are not invented.
    rows.push({ id: `issue:${issueUrl}`, issueUrl, threadId: null, identity: null, identityState: "unverified",
      source: { kind: "board_flag", taskId: flag.taskId, headline: flag.title ? clip(flag.title) : null },
      correspondence: { state: "unknown", reason: "identity_unverified" }, history: "absent",
      lastActivityAt: flag.openedAt && Number.isFinite(Date.parse(flag.openedAt)) ? flag.openedAt : null,
      messageCount: 0, preview: null });
  }
  rows.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") || a.id.localeCompare(b.id));
  if (rows.length > ESCALATION_INDEX_MAX_ROWS) { rows.length = ESCALATION_INDEX_MAX_ROWS; truncated = true; reasons.push("The mailbox exceeded the index row bound."); }
  if (conflicts > 0) reasons.push("Some sources named conflicting conversations and were left out.");
  const sources = { threads: (threads ? "complete" : "unavailable") as EscalationIndexSourceState,
    board: (board.state === "ready" ? "complete" : "unavailable") as EscalationIndexSourceState };
  const complete = sources.threads === "complete" && sources.board === "complete" && conflicts === 0 && !truncated && repository !== undefined;
  const state = sources.threads === "unavailable" && sources.board === "unavailable" ? "unavailable" : complete ? "complete" : "partial";
  return { rows, complete, coverage: { state, sources, truncated, conflicts, incompleteHistory, unboundThreads, reasons } };
}

function encodeCursor(repository: string, snapshot: string, offset: number, folder: string | null): string {
  return Buffer.from(JSON.stringify({ r: repository.toLowerCase(), s: snapshot, o: offset, f: folder })).toString("base64url");
}

function decodeCursor(value: string): { r: string; s: string; o: number; f: string | null } | undefined {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.r !== "string" || typeof parsed.s !== "string" || !Number.isSafeInteger(parsed.o) || (parsed.o as number) < 0
      || (parsed.f !== null && typeof parsed.f !== "string")) return undefined;
    return { r: parsed.r, s: parsed.s, o: parsed.o as number, f: parsed.f };
  } catch {
    // An undecodable cursor is a malformed request, never a position.
    return undefined;
  }
}

export function createEscalationConversationIndexReader(deps: EscalationIndexDeps): EscalationIndexReader {
  const clock = deps.clock ?? systemClock;
  return query => {
    const invalid = (detail: string): EscalationIndexResult => ({ state: "unavailable", reason: "invalid_request", detail });
    if (!deps.repository) return { state: "unavailable", reason: "source_unavailable", detail: "No serving repository is configured." };
    let limit = ESCALATION_INDEX_DEFAULT_LIMIT;
    if (query.limit !== undefined && query.limit !== null) {
      if (!/^[1-9][0-9]{0,3}$/.test(query.limit) || Number(query.limit) > ESCALATION_INDEX_MAX_LIMIT) return invalid(`limit must be 1 to ${ESCALATION_INDEX_MAX_LIMIT}.`);
      limit = Number(query.limit);
    }
    const folder = query.folder === undefined || query.folder === null || query.folder === "" ? null : query.folder as EscalationAttention;
    if (folder !== null && !FOLDERS.includes(folder)) return invalid("folder must be one of needs_input, waiting_for_agent, archived, unknown.");
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (query.cursor && !cursor) return invalid("cursor is not valid.");
    const snap = buildEscalationIndexSnapshot(deps);
    const total = snap.rows.length;
    const folderCounts = Object.fromEntries(FOLDERS.map(f => [f, snap.rows.filter(r => r.correspondence.state === f).length])) as Record<EscalationAttention, number>;
    const version = digest([deps.repository.toLowerCase(), snap.rows, snap.coverage]);
    let offset = 0;
    if (cursor) {
      if (cursor.r !== deps.repository.toLowerCase() || cursor.s !== version || cursor.f !== folder) {
        return { state: "unavailable", reason: "refresh_required", detail: "The mailbox changed or the cursor belongs to another view. Refresh from the first page." };
      }
      offset = cursor.o;
    }
    const view = folder ? snap.rows.filter(r => r.correspondence.state === folder) : snap.rows;
    const items = view.slice(offset, offset + limit);
    const loadedFolders = Object.fromEntries(FOLDERS.map(f => [f, items.filter(r => r.correspondence.state === f).length])) as Record<EscalationAttention, number>;
    const more = offset + items.length < view.length;
    return { state: "served", version: 1, repository: deps.repository, snapshot: { version, observedAt: clock.iso() }, coverage: snap.coverage,
      counts: { unit: "unique_conversations", scope: "repository_snapshot", complete: snap.complete, total: snap.complete ? total : null,
        folders: Object.fromEntries(FOLDERS.map(f => [f, snap.complete ? folderCounts[f] : null])) as EscalationIndexFolderCounts,
        loaded: { total: items.length, folders: loadedFolders } },
      items, page: { limit, folder, nextCursor: more ? encodeCursor(deps.repository, version, offset + items.length, folder) : null } };
  };
}

export function buildEscalationConversationIndexRoute(read: EscalationIndexReader): Route {
  return { method: "GET", path: "/v1/escalation/threads", scope: "read", handler: async (req, res) => {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const result = read({ limit: params.get("limit"), cursor: params.get("cursor"), folder: params.get("folder") });
    const status = result.state === "served" ? 200 : result.reason === "invalid_request" ? 400 : result.reason === "refresh_required" ? 409 : 503;
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result));
  } };
}
