/**
 * W1-T5339 — the selected repository's conversations, served by its OWN instance (issue #7911, first slice).
 *
 * Before this module the inbox thread routes existed only at core's unprefixed paths, so the instances
 * view could not advertise `inbox/threads` for any instance and the console (rightly) refused to fall
 * back to core's data for another repository. This module is the one contract every instance mounts:
 *
 * - {@link INSTANCE_INBOX_ROUTES} is the single table both the mount and the advertisement read, so an
 *   advertised capability cannot name a route that is not mounted.
 * - Every route is instance-rooted: its handlers are built from (or, for core, shared with) that
 *   instance's own state. Every envelope echoes the exact `repository` and `instance`; a request that
 *   names another one, or a source body that names another one, is refused before or instead of answering.
 * - Writes (reply, read mark) are bound to ONE durable intent receipt on disk — operator, instance,
 *   thread, action and payload. An exact replay returns the stored receipt without a second side effect,
 *   across concurrent requests (joined in-process) and restarts (read from disk); a changed replay is
 *   refused; a delivery whose outcome was never recorded stays `unknown`, never guessed.
 * - An instance whose daemon has no inbox registry (an old daemon) is explicitly READ-ONLY: its views
 *   answer, its writes refuse with the reason, and nothing else on the instance is held.
 *
 * Approval and retirement are NOT part of this slice; no confirmation tier changes here.
 */
import { systemClock } from "./clock.js";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { INBOX_RETIREMENT_RESTORE_ACTION, restoreInboxRetirement, type InboxRetirementRestoreInput } from "./inbox-retirement.js";
import { writeAtomic } from "./fs-race-safe.js";
import { proposalIdOfThread } from "./inbox-thread.js";
import { bearerTokenId, sendJson } from "./panel-actions.js";
import { RAW_BODY_CACHE, readBoundedRawBody, verifiedActor, type Route } from "./service.js";

import { readPersistedInbox } from "./fleet-lane.js";
import { INBOX_RECEIPT_DIR, WHY_ME_ACTION, whyMePresencePath, correctionOf, whyMePayload, type WhyMeCorrection } from "./inbox-why-me.js";
import { INBOX_STALE_AFTER_MS } from "./inbox-freshness.js";
import { INBOX_THREAD_PAGE_MAX_BYTES } from "./inbox-thread-list-view.js";
export { INBOX_RECEIPT_DIR } from "./inbox-why-me.js";

/** The conversation contract: each capability, the instance-relative path it mounts at, and the source route it wraps. */
export const INSTANCE_INBOX_ROUTES = [
  { capability: "inbox", method: "GET", kind: "view", source: "/v1/inbox" },
  { capability: "inbox/attention-census", method: "GET", kind: "view", source: "/v1/inbox/attention-census" },
  { capability: "inbox/proposal", method: "GET", kind: "view", source: "/v1/inbox/proposal" },
  { capability: "inbox/threads", method: "GET", kind: "view", source: "/v1/inbox/threads" },
  { capability: "inbox/thread", method: "GET", kind: "view", source: "/v1/inbox/thread" },
  { capability: "inbox/thread/reply", method: "POST", kind: "write", action: "reply", source: "/v1/inbox/thread/reply" },
  { capability: "inbox/thread/read", method: "POST", kind: "write", action: "read", source: "/v1/inbox/thread/read" },
  { capability: "inbox/why-me-correction", method: "POST", kind: "write", action: "why-me-correction", source: "/v1/inbox/why-me-correction" },
  { capability: "inbox/retirement-restore", method: "POST", kind: "write", action: "retirement-restore", source: "/v1/inbox/retirement-restore" },
  { capability: "inbox/reframe", method: "POST", kind: "write", action: "reframe", source: "/v1/inbox/reframe" },
] as const;

type ContractRoute = (typeof INSTANCE_INBOX_ROUTES)[number];

export const INSTANCE_INBOX_VIEWS: readonly string[] = INSTANCE_INBOX_ROUTES.filter((r) => r.kind === "view").map((r) => r.capability);
export const INSTANCE_INBOX_WRITES: readonly string[] = INSTANCE_INBOX_ROUTES.filter((r) => r.kind === "write").map((r) => r.capability);
/** The unprefixed source paths the contract replaces under an instance prefix. */
export const INSTANCE_INBOX_SOURCE_PATHS: ReadonlySet<string> = new Set(INSTANCE_INBOX_ROUTES.map((r) => r.source));

/** The daemon's inbox registry; an instance without one predates the contract and is read-only. */
export const INBOX_CONTRACT_MARKER = "inbox-proposals.json";

export type InstanceInboxContractState =
  | { mode: "read-write" }
  | { mode: "read-only"; code: "inbox_contract_absent" | "inbox_contract_unreadable" | "inbox_state_unconfigured"; reason: string };

/** Whether an instance's state dir carries a readable inbox registry. Never throws. */
export function instanceInboxContractState(stateDir: string | undefined, read: (path: string) => string = (p) => readFileSync(p, "utf8")): InstanceInboxContractState {
  if (stateDir === undefined) return { mode: "read-only", code: "inbox_state_unconfigured", reason: "no inbox state root is configured for this instance" };
  let text: string;
  try {
    text = read(join(stateDir, INBOX_CONTRACT_MARKER));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { mode: "read-only", code: "inbox_contract_absent", reason: "this instance's daemon keeps no inbox registry; its conversations are read-only" };
    return { mode: "read-only", code: "inbox_contract_unreadable", reason: `the inbox registry is unreadable: ${code ?? String(error)}` };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not a JSON object or array");
  } catch (error) {
    return { mode: "read-only", code: "inbox_contract_unreadable", reason: `the inbox registry is malformed: ${(error as Error).message}` };
  }
  return { mode: "read-write" };
}

/** What the instances view advertises for one served instance's conversations: only usable routes. */
export function instanceInboxCapabilities(stateDir: string | undefined): { views: string[]; writes: string[]; inbox: { mode: InstanceInboxContractState["mode"]; reason?: string } } {
  const state = instanceInboxContractState(stateDir);
  return state.mode === "read-write"
    ? { views: [...INSTANCE_INBOX_VIEWS], writes: [...INSTANCE_INBOX_WRITES], inbox: { mode: "read-write" } }
    : { views: [...INSTANCE_INBOX_VIEWS], writes: [], inbox: { mode: "read-only", reason: state.reason } };
}

export interface InstanceInboxBinding {
  instance: string;
  /** `owner/name`, echoed exactly and required exactly on every write. */
  repository: string;
  /** The instance's `state/` dir: the contract marker and the durable receipts live here. */
  stateDir: string | undefined;
  /** This instance's own source routes at their unprefixed paths ({@link INSTANCE_INBOX_SOURCE_PATHS}). */
  routes: readonly Route[];
  /** Override the contract probe (tests); defaults to {@link instanceInboxContractState} per request. */
  contract?: () => InstanceInboxContractState;
  /** Fault seam for the durable correction write; the default is the real atomic receipt store. */
  recordWhyMeReceipt?: typeof writeAtomic;
}

interface Captured {
  status: number;
  headers: Record<string, string>;
  text: string;
  ended: boolean;
}

/** A response stand-in the source handler writes into, so the contract can check and envelope it. */
function captureResponse(): { res: ServerResponse; done: () => Captured } {
  const out: Captured = { status: 200, headers: {}, text: "", ended: false };
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(name: string, value: unknown) {
      out.headers[name.toLowerCase()] = String(value);
      return res;
    },
    writeHead(code: number, headers?: Record<string, unknown>) {
      out.status = code;
      res.statusCode = code;
      for (const [k, v] of Object.entries(headers ?? {})) out.headers[k.toLowerCase()] = String(v);
      return res;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) out.text += String(chunk);
      out.ended = true;
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, done: () => ({ ...out, status: res.statusCode }) };
}

type Body = Record<string, unknown>;

/** The source's JSON object, or why it cannot be enveloped (the caller answers 502 naming the reason). */
function parseBody(captured: Captured): { body: Body } | { reason: string } {
  if (!captured.ended) return { reason: "the source never finished its answer" };
  try {
    const parsed: unknown = JSON.parse(captured.text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? { body: parsed as Body } : { reason: "the source answered JSON that is not an object" };
  } catch (error) {
    return { reason: `the source answered non-JSON: ${(error as Error).message}` };
  }
}

/** A body naming a different repository or instance is another scope's data, never this one's. */
function foreignIdentity(body: Body, binding: InstanceInboxBinding): string | undefined {
  if (body.repository !== undefined && body.repository !== binding.repository) return `repository ${String(body.repository)}`;
  if (body.instance !== undefined && body.instance !== binding.instance) return `instance ${String(body.instance)}`;
  return undefined;
}

function identity(binding: InstanceInboxBinding): { repository: string; instance: string } {
  return { repository: binding.repository, instance: binding.instance };
}

function sendScoped(res: ServerResponse, binding: InstanceInboxBinding, status: number, body: Body): void {
  sendJson(res, status, { ...body, ...identity(binding) });
}

function emit(res: ServerResponse, captured: Captured, body: Body): void {
  for (const [k, v] of Object.entries(captured.headers)) if (k !== "content-type" && k !== "content-length") res.setHeader(k, v);
  sendJson(res, captured.status, body);
}

/** Exact scope from a request: absent is the mounted scope; present must match it character for character. */
function scopeMismatch(binding: InstanceInboxBinding, named: { repository?: unknown; instance?: unknown }, required: boolean): string | undefined {
  for (const key of ["repository", "instance"] as const) {
    const value = named[key];
    if (value === undefined || value === null) {
      if (required) return `${key} is required and must be ${binding[key]}`;
      continue;
    }
    if (value !== binding[key]) return `${key} ${String(value)} is not this route's ${key} ${binding[key]}`;
  }
  return undefined;
}

function viewRoute(spec: ContractRoute, source: Route, binding: InstanceInboxBinding): Route {
  return {
    ...source,
    path: `/v1/i/${binding.instance}/${spec.capability}`,
    handler: async (req, res, ctx) => {
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      const mismatch = scopeMismatch(binding, { repository: params.get("repository") ?? undefined, instance: params.get("instance") ?? undefined }, false);
      if (mismatch) {
        sendScoped(res, binding, 409, { error: "inbox_scope_mismatch", detail: mismatch });
        return;
      }
      const capture = captureResponse();
      const pagedThreads = spec.capability === "inbox/threads" && (params.has("limit") || params.has("cursor"));
      const pageContract = pagedThreads ? (binding.contract ?? (() => instanceInboxContractState(binding.stateDir)))().mode : undefined;
      const sourceContext = pagedThreads ? { ...ctx, params: { ...ctx.params,
        inboxThreadRepository: binding.repository, inboxThreadInstance: binding.instance, inboxThreadContract: pageContract!,
      } } : ctx;
      await source.handler(req, capture.res, sourceContext);
      const captured = capture.done();
      const parsed = parseBody(captured);
      if ("reason" in parsed) {
        sendScoped(res, binding, 502, { error: "inbox_source_unreadable", detail: `${spec.capability}: ${parsed.reason}` });
        return;
      }
      const body = parsed.body;
      const foreign = foreignIdentity(body, binding);
      if (foreign) {
        sendScoped(res, binding, 502, { error: "inbox_identity_mismatch", detail: `the source answered for ${foreign}` });
        return;
      }
      const requested = params.get("id");
      if (spec.capability === "inbox/thread" && captured.status === 200 && body.threadId !== requested) {
        sendScoped(res, binding, 502, { error: "inbox_thread_identity_mismatch", detail: `asked for ${String(requested)}, the source answered ${String(body.threadId)}` });
        return;
      }
      const mode = pageContract ?? (binding.contract ?? (() => instanceInboxContractState(binding.stateDir)))().mode;
      if (spec.capability === "inbox/proposal" && captured.status === 200) {
        if (body.proposalId !== requested) {
          sendScoped(res, binding, 502, { error: "inbox_proposal_identity_mismatch" }); return;
        }
        if (typeof body.snapshotKey !== "string" || !/^[a-f0-9]{64}$/.test(body.snapshotKey)) {
          sendScoped(res, binding, 502, { error: "inbox_proposal_source_unreadable" }); return;
        }
        const reframe = binding.routes.some(r => r.method === "POST" && r.path === "/v1/inbox/reframe");
        body.actions = mode === "read-write" && reframe ? [{ action: "reframe", tier: "low", path: `/v1/i/${binding.instance}/inbox/reframe` }] : [];
      }
      const envelope = { ...body, ...identity(binding), contract: mode };
      const page = body.page as { total?: unknown; nextCursor?: unknown } | null | undefined;
      if (pagedThreads && captured.status === 200 && (typeof body.threadListKey !== "string" || !/^[a-f0-9]{64}$/.test(body.threadListKey) ||
        !Array.isArray(body.threads) || typeof page !== "object" || page === null || !Number.isSafeInteger(page.total) || (page.total as number) < body.threads.length ||
        typeof body.source !== "object" || body.source === null || page.nextCursor !== undefined && typeof page.nextCursor !== "string")) {
        sendScoped(res, binding, 502, { error: "inbox_thread_page_unverified", detail: "The source did not return a keyed, source-qualified thread page." });
        return;
      }
      if (pagedThreads && captured.status === 200 && Buffer.byteLength(JSON.stringify(envelope)) > INBOX_THREAD_PAGE_MAX_BYTES) {
        sendScoped(res, binding, 413, { error: "inbox_thread_page_too_large", detail: "The complete scoped page exceeds the response bound; no row was omitted or truncated." });
        return;
      }
      emit(res, captured, envelope);
    },
  };
}

// ── Durable intent receipts ────────────────────────────────────────────────────────────────────

export interface IntentBinding {
  operator: string;
  repository: string;
  instance: string;
  threadId: string;
  action: string;
  payloadHash: string;
}

export interface IntentReceipt extends IntentBinding {
  intentId: string;
  key: string;
  /** `pending` until the outcome is recorded; `unknown` when the source could not say whether it delivered. */
  status: "pending" | "settled" | "unknown";
  httpStatus?: number;
  body?: Body;
}

const INTENT_ID = /^[A-Za-z0-9._:-]{8,128}$/;
/** Requests for one receipt joined while its first request is still running. A join, not a cache: removed on settle. */
const inflight = new Map<string, Promise<{ status: number; body: Body }>>();

export function intentReceiptPath(stateDir: string, key: string): string {
  return join(stateDir, INBOX_RECEIPT_DIR, `${key}.json`);
}

function sameBinding(a: IntentBinding, b: IntentBinding): boolean {
  return a.operator === b.operator && a.repository === b.repository && a.instance === b.instance &&
    a.threadId === b.threadId && a.action === b.action && a.payloadHash === b.payloadHash;
}

function canonicalPayload(action: string, body: Body): { error: string } | { payload: unknown } {
  if (action === INBOX_RETIREMENT_RESTORE_ACTION) {
    if (body.proposalId !== proposalIdOfThread(String(body.threadId)) || ![body.retirementId, body.snapshotKey].every(x => typeof x === "string" && /^[a-f0-9]{64}$/.test(x)) ||
      !(body.taskId === null || typeof body.taskId === "string" && body.taskId.length <= 160 && /^W\d+-T[A-Za-z0-9]+$/.test(body.taskId)) || typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 2000 ||
      Object.keys(body).some(k => !["repository", "instance", "proposalId", "threadId", "intentId", "retirementId", "snapshotKey", "taskId", "reason"].includes(k))) return { error: "exact retirement scope, original snapshot, task and reason are required" };
    return { payload: { proposalId: body.proposalId, retirementId: body.retirementId, snapshotKey: body.snapshotKey, taskId: body.taskId, reason: body.reason } };
  }
  if (action === WHY_ME_ACTION) {
    const payload = whyMePayload(body);
    if ("error" in payload) return payload;
    if (payload.proposalId !== proposalIdOfThread(String(body.threadId))) return { error: "proposalId must identify the requested thread" };
    return { payload };
  }
  if (action === "reframe") {
    if (typeof body.feedback !== "string" || !body.feedback.trim() || body.feedback.length > 4000) return { error: "feedback must contain 1-4000 characters" };
    if (typeof body.snapshotKey !== "string" || !/^[a-f0-9]{64}$/.test(body.snapshotKey)) return { error: "proposal snapshotKey is required" };
    if (body.proposalId !== proposalIdOfThread(String(body.threadId))) return { error: "proposalId must identify the requested thread" };
    return { payload: { feedback: body.feedback, snapshotKey: body.snapshotKey } };
  }
  if (action === "reply") {
    if (typeof body.text !== "string" || !body.text.trim()) return { error: "text is required" };
    return { payload: { text: body.text.trim() } };
  }
  if (typeof body.seq !== "number" || !Number.isInteger(body.seq) || body.seq < 0) return { error: "seq must be a whole number" };
  return { payload: { seq: body.seq } };
}

function receiptView(r: IntentReceipt): Body {
  return { intentId: r.intentId, key: r.key, status: r.status, action: r.action, threadId: r.threadId };
}

/** What a stored receipt answers to a replay of the same key. */
function replayAnswer(stored: IntentReceipt, binding: IntentBinding): { status: number; body: Body } | "join" {
  if (!sameBinding(stored, binding)) {
    return { status: 409, body: { error: "inbox_intent_conflict", delivery: "not_delivered", detail: "this intent was already used for a different thread, action or payload", receipt: receiptView(stored) } };
  }
  if (stored.status === "settled" && binding.action === WHY_ME_ACTION && correctionOf(stored, binding) === undefined) {
    return { status: 409, body: { error: "inbox_intent_unknown", delivery: "unknown", detail: "the stored correction acknowledgement is unverified; this intent is not retried", receipt: { ...receiptView(stored), status: "unknown" } } };
  }
  if (stored.status === "settled" && stored.httpStatus !== undefined && stored.body !== undefined) {
    return { status: stored.httpStatus, body: { ...stored.body, receipt: receiptView(stored), replayed: true } };
  }
  if (stored.status === "pending") return "join";
  return { status: 409, body: { error: "inbox_intent_unknown", delivery: "unknown", detail: "this intent's delivery was never confirmed; it is not retried", receipt: receiptView(stored) } };
}

/** A stored receipt, or why it cannot be read: an unreadable receipt proves nothing, so the caller answers `unknown`. */
function readReceipt(path: string): { receipt: IntentReceipt } | { reason: string; code?: string } {
  try {
    const receipt: IntentReceipt = JSON.parse(readFileSync(path, "utf8"));
    if (!receipt || typeof receipt !== "object" || [receipt.operator, receipt.repository, receipt.instance, receipt.threadId,
      receipt.action, receipt.payloadHash, receipt.intentId, receipt.key].some(value => typeof value !== "string") ||
      !["pending", "settled", "unknown"].includes(receipt.status)) throw new Error("malformed intent receipt");
    if (receipt.action === WHY_ME_ACTION && basename(path) !== `${receipt.key}.json`) throw new Error("correction receipt identity differs from its filename");
    return { receipt };
  } catch (error) {
    return { code: (error as NodeJS.ErrnoException).code, reason: `this intent's receipt is unreadable: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` };
  }
}

async function answerIntentReplay(path: string, intent: IntentBinding, binding: InstanceInboxBinding, res: ServerResponse): Promise<void> {
  const read = readReceipt(path);
  const answer = "reason" in read
    ? { status: 409, body: { error: "inbox_intent_unknown", delivery: "unknown", detail: read.reason } }
    : replayAnswer(read.receipt, intent);
  if (answer !== "join") {
    sendScoped(res, binding, answer.status, answer.body);
    return;
  }
  const running = inflight.get(path);
  if (running === undefined) {
    sendScoped(res, binding, 409, { error: "inbox_intent_unknown", delivery: "unknown", detail: "this intent was claimed but its outcome was never recorded; it is not retried", receipt: receiptView((read as { receipt: IntentReceipt }).receipt) });
    return;
  }
  const joined = await running;
  sendScoped(res, binding, joined.status, { ...joined.body, replayed: true });
  return;
}

function writeRoute(spec: ContractRoute & { action: string }, source: Route, binding: InstanceInboxBinding): Route {
  return {
    ...source,
    method: "POST", scope: "write", tier: "low", cacheQualification: undefined,
    path: `/v1/i/${binding.instance}/${spec.capability}`,
    handler: async (req, res, ctx) => {
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      let raw: string;
      let body: Body;
      try {
        raw = await readBoundedRawBody(req, 16_384);
        const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("body must be a JSON object");
        body = parsed as Body;
      } catch (error) {
        sendScoped(res, binding, 400, { error: "invalid_request", detail: (error as Error).message });
        return;
      }
      // Scope first: a forged repository or instance is refused whatever state the instance is in.
      const mismatch = scopeMismatch(binding, { repository: params.get("repository") ?? undefined, instance: params.get("instance") ?? undefined }, false)
        ?? scopeMismatch(binding, body, true);
      if (mismatch) {
        sendScoped(res, binding, 409, { error: "inbox_scope_mismatch", delivery: "not_delivered", detail: mismatch });
        return;
      }
      const contract = (binding.contract ?? (() => instanceInboxContractState(binding.stateDir)))();
      if (contract.mode === "read-only" || binding.stateDir === undefined) {
        const reason = contract.mode === "read-only" ? contract.reason : "no inbox state root is configured";
        sendScoped(res, binding, 409, { error: "inbox_read_only", delivery: "not_delivered", contract: "read-only", detail: reason });
        return;
      }
      if (typeof body.threadId !== "string" || !proposalIdOfThread(body.threadId)) {
        sendScoped(res, binding, 400, { error: "invalid_request", detail: "threadId must name an inbox thread" });
        return;
      }
      if (typeof body.intentId !== "string" || !INTENT_ID.test(body.intentId)) {
        sendScoped(res, binding, 400, { error: "invalid_request", detail: "intentId is required: 8-128 ASCII identifier characters" });
        return;
      }
      const payload = canonicalPayload(spec.action, body);
      if ("error" in payload) {
        sendScoped(res, binding, 400, { error: "invalid_request", detail: payload.error });
        return;
      }
      if ((spec.action === WHY_ME_ACTION || spec.action === INBOX_RETIREMENT_RESTORE_ACTION) && !verifiedActor(req)) {
        sendScoped(res, binding, 403, { error: "verified_operator_required", delivery: "not_delivered" }); return;
      }
      const operator = bearerTokenId(req);
      if (spec.action === INBOX_RETIREMENT_RESTORE_ACTION) {
        try {
          const restored = await restoreInboxRetirement(binding.stateDir, { ...identity(binding), root: dirname(binding.stateDir) }, payload.payload as InboxRetirementRestoreInput, operator, body.intentId as string, systemClock.iso(), () => {
            const qualification = source.cacheQualification?.(req), current = readPersistedInbox(binding.stateDir!);
            const age = current ? systemClock.now() - Date.parse(current.generatedAt) : Number.NaN;
            const target = current?.classifications.find(c => c.proposalId === body.proposalId);
            return Boolean(qualification && !("status" in qualification) && current && Number.isFinite(age) && age >= 0 && age <= INBOX_STALE_AFTER_MS &&
              qualification.key === current.snapshotKey && current.snapshotScope?.repository === binding.repository && current.snapshotScope.instance === binding.instance && target?.retirement && target.retirement.retirementId === body.retirementId &&
              (target.state === "retired" || target.retirement.state === "restored_for_review"));
          });
          if ("state" in restored) sendScoped(res, binding, 503, { error: "inbox_retirement_busy", delivery: "not_delivered" });
          else sendScoped(res, binding, restored.status, restored.body);
        } catch (error) {
          sendScoped(res, binding, 503, { error: "inbox_retirement_receipt_unavailable", delivery: "unknown", detail: String(error) });
        }
        return;
      }
      const intent: IntentBinding = {
        operator, repository: binding.repository, instance: binding.instance, threadId: body.threadId, action: spec.action,
        payloadHash: createHash("sha256").update(JSON.stringify(payload.payload)).digest("hex"),
      };
      const key = createHash("sha256").update(JSON.stringify([operator, binding.instance, body.intentId])).digest("hex");
      const path = intentReceiptPath(binding.stateDir, key);
      let correction: WhyMeCorrection | undefined;
      if (spec.action === WHY_ME_ACTION) {
        const prior = readReceipt(path);
        if ("receipt" in prior || prior.code !== "ENOENT") {
          await answerIntentReplay(path, intent, binding, res); return;
        }
        let qualified: ReturnType<NonNullable<Route["cacheQualification"]>>;
        try { qualified = source.cacheQualification?.(req); }
        catch { /* A failed read-only qualifier is unavailable evidence, never write readiness. */ qualified = undefined; }
        if (!qualified || "status" in qualified) {
          sendScoped(res, binding, 503, { error: "why_me_source_unavailable", delivery: "not_delivered" }); return;
        }
        const persisted = readPersistedInbox(binding.stateDir);
        const age = persisted ? systemClock.now() - Date.parse(persisted.generatedAt) : Number.NaN;
        if (persisted === undefined || persisted.attentionCensus === undefined || !persisted.snapshotKey || !Number.isFinite(age) || age < 0 || age > INBOX_STALE_AFTER_MS ||
          persisted.snapshotScope?.instance !== binding.instance || persisted.snapshotScope.repository !== binding.repository) {
          sendScoped(res, binding, 503, { error: "why_me_source_unavailable", delivery: "not_delivered" }); return;
        }
        if (qualified.key !== persisted.snapshotKey || body.snapshotKey !== persisted.snapshotKey) {
          sendScoped(res, binding, 409, { error: "inbox_snapshot_changed", delivery: "not_delivered", snapshotKey: persisted.snapshotKey }); return;
        }
        const item = persisted.attentionCensus.items.find(item => item.proposalId === body.proposalId && item.threadId === body.threadId);
        if (!item || (item.attention !== "decision" && item.attention !== "reply")) {
          sendScoped(res, binding, 404, { error: "why_me_item_unavailable", delivery: "not_delivered" }); return;
        }
        const input = payload.payload as WhyMeCorrection;
        if (input.supersedes) {
          const before = readReceipt(intentReceiptPath(binding.stateDir, input.supersedes));
          const priorCorrection = "receipt" in before ? correctionOf(before.receipt, binding) : undefined;
          if (!priorCorrection || priorCorrection.proposalId !== item.proposalId || priorCorrection.operator !== operator) {
            sendScoped(res, binding, 409, { error: "why_me_supersedes_mismatch", delivery: "not_delivered" }); return;
          }
        }
        correction = { ...input, ...identity(binding), threadId: body.threadId, intentId: body.intentId, receiptId: key, operator,
          recordedAt: systemClock.iso(), original: { whyMe: item.whyMe, sourceFacts: item.sourceFacts, ...(item.judgment ? { judgment: item.judgment } : {}) } };
      }
      const pending: IntentReceipt = { ...intent, intentId: body.intentId, key, status: "pending" };
      try {
        mkdirSync(join(binding.stateDir, INBOX_RECEIPT_DIR), { recursive: true });
        // The exclusive create IS the claim: one request per key, across requests, processes and restarts.
        writeFileSync(path, `${JSON.stringify(pending)}\n`, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          sendScoped(res, binding, 503, { error: "inbox_receipt_store_unavailable", delivery: "not_delivered", detail: String((error as NodeJS.ErrnoException).code ?? error) });
          return;
        }
        await answerIntentReplay(path, intent, binding, res);
        return;
      }
      const run = correction ? Promise.resolve(recordWhyMe(path, pending, correction, binding)) : deliver(spec, source, binding, req, ctx, raw, pending, path);
      inflight.set(path, run);
      try {
        const outcome = await run;
        sendScoped(res, binding, outcome.status, { ...outcome.body, replayed: false });
      } finally {
        inflight.delete(path);
      }
    },
  };
}

/** One settled receipt IS the correction effect and its audit. Failed durability is never success. */
function recordWhyMe(path: string, pending: IntentReceipt, correction: WhyMeCorrection, binding: InstanceInboxBinding): { status: number; body: Body } {
  const body = { ok: true, delivery: "delivered", authority: "feedback_only", audit: "receipt_recorded", correction,
    receipt: receiptView({ ...pending, status: "settled" }) };
  try {
    // This conservative index survives lost classifications; it never substitutes for a receipt.
    mkdirSync(whyMePresencePath(binding.stateDir!, correction, correction.proposalId), { recursive: true });
    (binding.recordWhyMeReceipt ?? writeAtomic)(path, JSON.stringify({ ...pending, status: "settled", httpStatus: 200, body }) + "\n");
    return { status: 200, body };
  } catch (error) {
    return { status: 503, body: { error: "why_me_receipt_unavailable", delivery: "unknown", audit: "unavailable", detail: String(error), receipt: receiptView(pending) } };
  }
}

/** Record an outcome; a failed record leaves the claim `pending`, which a replay without a live join answers `unknown`. */
function recordReceipt(path: string, receipt: IntentReceipt): IntentReceipt {
  try {
    writeAtomic(path, `${JSON.stringify(receipt)}\n`);
    return receipt;
  } catch (error) {
    return { ...receipt, status: "pending", body: { receiptError: String((error as Error).message ?? error) } };
  }
}

/** Drop a claim whose write was refused before any side effect; the reason is returned when it cannot be dropped. */
function releaseReceipt(path: string): { released: true } | { reason: string } {
  try {
    unlinkSync(path);
    return { released: true };
  } catch (error) {
    return { reason: `the refused intent stays claimed: ${String((error as NodeJS.ErrnoException).code ?? error)}` };
  }
}

/** Run the source write once and record its outcome on the claimed receipt. */
async function deliver(
  spec: ContractRoute,
  source: Route,
  binding: InstanceInboxBinding,
  req: IncomingMessage,
  ctx: Parameters<Route["handler"]>[2],
  raw: string,
  pending: IntentReceipt,
  path: string,
): Promise<{ status: number; body: Body }> {
  (req as unknown as Record<symbol, unknown>)[RAW_BODY_CACHE] = raw;
  const capture = captureResponse();
  let captured: Captured;
  try {
    await source.handler(req, capture.res, { ...ctx, params: { ...ctx.params,
      inboxThreadRepository: binding.repository, inboxThreadInstance: binding.instance,
    } });
    captured = capture.done();
  } catch (error) {
    const unknown: IntentReceipt = { ...pending, status: "unknown" };
    const recorded = recordReceipt(path, unknown);
    return { status: 500, body: { error: "inbox_delivery_unknown", delivery: "unknown", detail: String((error as Error).message ?? error), receipt: receiptView(recorded) } };
  }
  const answered = parseBody(captured);
  const unreadable = "reason" in answered;
  const body: Body = { ...(unreadable ? { error: "inbox_source_unreadable", delivery: "unknown", detail: answered.reason } : answered.body), ...identity(binding) };
  const ok = !unreadable && captured.status >= 200 && captured.status < 300;
  const unknownDelivery = unreadable || captured.status >= 500 || body.delivery === "unverified" || body.delivery === "unknown";
  if (!ok && !unknownDelivery) {
    // Refused before any side effect (not found, ahead of the thread, invalid): nothing to replay.
    const released = releaseReceipt(path);
    return { status: captured.status, body: "reason" in released ? { ...body, receiptError: released.reason } : body };
  }
  const settled: IntentReceipt = ok ? { ...pending, status: "settled", httpStatus: captured.status, body } : { ...pending, status: "unknown" };
  return { status: captured.status, body: { ...body, receipt: receiptView(recordReceipt(path, settled)) } };
}

/**
 * Mount the conversation contract for ONE instance at `/v1/i/<instance>/inbox/…`. Only routes whose
 * source is present are mounted, and the instances view advertises only from the same table.
 */
export function mountInstanceInboxRoutes(binding: InstanceInboxBinding): Route[] {
  const out: Route[] = [];
  for (const spec of INSTANCE_INBOX_ROUTES) {
    const source = spec.kind === "write" && (spec.action === WHY_ME_ACTION || spec.action === INBOX_RETIREMENT_RESTORE_ACTION)
      ? binding.routes.find(r => r.method === "GET" && r.path === "/v1/inbox/attention-census")
      : binding.routes.find((r) => r.method === spec.method && r.path === spec.source);
    if (source === undefined) continue;
    out.push(spec.kind === "write" ? writeRoute(spec, source, binding) : viewRoute(spec, source, binding));
  }
  return out;
}
