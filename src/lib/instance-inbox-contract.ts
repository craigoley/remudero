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
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./fs-race-safe.js";
import { proposalIdOfThread } from "./inbox-thread.js";
import { bearerTokenId, sendJson } from "./panel-actions.js";
import { RAW_BODY_CACHE, readBoundedRawBody, type Route } from "./service.js";

/** The conversation contract: each capability, the instance-relative path it mounts at, and the source route it wraps. */
export const INSTANCE_INBOX_ROUTES = [
  { capability: "inbox/threads", method: "GET", kind: "view", source: "/v1/inbox/threads" },
  { capability: "inbox/thread", method: "GET", kind: "view", source: "/v1/inbox/thread" },
  { capability: "inbox/thread/reply", method: "POST", kind: "write", action: "reply", source: "/v1/inbox/thread/reply" },
  { capability: "inbox/thread/read", method: "POST", kind: "write", action: "read", source: "/v1/inbox/thread/read" },
] as const;

type ContractRoute = (typeof INSTANCE_INBOX_ROUTES)[number];

export const INSTANCE_INBOX_VIEWS: readonly string[] = INSTANCE_INBOX_ROUTES.filter((r) => r.kind === "view").map((r) => r.capability);
export const INSTANCE_INBOX_WRITES: readonly string[] = INSTANCE_INBOX_ROUTES.filter((r) => r.kind === "write").map((r) => r.capability);
/** The unprefixed source paths the contract replaces under an instance prefix. */
export const INSTANCE_INBOX_SOURCE_PATHS: ReadonlySet<string> = new Set(INSTANCE_INBOX_ROUTES.map((r) => r.source));

/** The daemon's inbox registry; an instance without one predates the contract and is read-only. */
export const INBOX_CONTRACT_MARKER = "inbox-proposals.json";
export const INBOX_RECEIPT_DIR = "inbox-intent-receipts";

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
    getHeader(name: string) {
      return out.headers[name.toLowerCase()];
    },
    writeHead(code: number, headers?: Record<string, unknown>) {
      out.status = code;
      res.statusCode = code;
      for (const [k, v] of Object.entries(headers ?? {})) out.headers[k.toLowerCase()] = String(v);
      return res;
    },
    write(chunk: unknown) {
      out.text += String(chunk);
      return true;
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

function refuse(res: ServerResponse, binding: InstanceInboxBinding, status: number, body: Body): void {
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
        refuse(res, binding, 409, { error: "inbox_scope_mismatch", detail: mismatch });
        return;
      }
      const capture = captureResponse();
      await source.handler(req, capture.res, ctx);
      const captured = capture.done();
      const parsed = parseBody(captured);
      if ("reason" in parsed) {
        refuse(res, binding, 502, { error: "inbox_source_unreadable", detail: `${spec.capability}: ${parsed.reason}` });
        return;
      }
      const body = parsed.body;
      const foreign = foreignIdentity(body, binding);
      if (foreign) {
        refuse(res, binding, 502, { error: "inbox_identity_mismatch", detail: `the source answered for ${foreign}` });
        return;
      }
      const requested = params.get("id");
      if (spec.capability === "inbox/thread" && captured.status === 200 && body.threadId !== requested) {
        refuse(res, binding, 502, { error: "inbox_thread_identity_mismatch", detail: `asked for ${String(requested)}, the source answered ${String(body.threadId)}` });
        return;
      }
      const mode = (binding.contract ?? (() => instanceInboxContractState(binding.stateDir)))().mode;
      emit(res, captured, { ...body, ...identity(binding), contract: mode });
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
  if (stored.status === "settled" && stored.httpStatus !== undefined && stored.body !== undefined) {
    return { status: stored.httpStatus, body: { ...stored.body, receipt: receiptView(stored), replayed: true } };
  }
  if (stored.status === "pending") return "join";
  return { status: 409, body: { error: "inbox_intent_unknown", delivery: "unknown", detail: "this intent's delivery was never confirmed; it is not retried", receipt: receiptView(stored) } };
}

/** A stored receipt, or why it cannot be read: an unreadable receipt proves nothing, so the caller answers `unknown`. */
function readReceipt(path: string): { receipt: IntentReceipt } | { reason: string } {
  try {
    return { receipt: JSON.parse(readFileSync(path, "utf8")) as IntentReceipt };
  } catch (error) {
    return { reason: `this intent's receipt is unreadable: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` };
  }
}

function writeRoute(spec: ContractRoute & { action: string }, source: Route, binding: InstanceInboxBinding): Route {
  return {
    ...source,
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
        refuse(res, binding, 400, { error: "invalid_request", detail: (error as Error).message });
        return;
      }
      // Scope first: a forged repository or instance is refused whatever state the instance is in.
      const mismatch = scopeMismatch(binding, { repository: params.get("repository") ?? undefined, instance: params.get("instance") ?? undefined }, false)
        ?? scopeMismatch(binding, body, true);
      if (mismatch) {
        refuse(res, binding, 409, { error: "inbox_scope_mismatch", delivery: "not_delivered", detail: mismatch });
        return;
      }
      const contract = (binding.contract ?? (() => instanceInboxContractState(binding.stateDir)))();
      if (contract.mode === "read-only" || binding.stateDir === undefined) {
        const reason = contract.mode === "read-only" ? contract.reason : "no inbox state root is configured";
        refuse(res, binding, 409, { error: "inbox_read_only", delivery: "not_delivered", contract: "read-only", detail: reason });
        return;
      }
      if (typeof body.threadId !== "string" || !proposalIdOfThread(body.threadId)) {
        refuse(res, binding, 400, { error: "invalid_request", detail: "threadId must name an inbox thread" });
        return;
      }
      if (typeof body.intentId !== "string" || !INTENT_ID.test(body.intentId)) {
        refuse(res, binding, 400, { error: "invalid_request", detail: "intentId is required: 8-128 ASCII identifier characters" });
        return;
      }
      const payload = canonicalPayload(spec.action, body);
      if ("error" in payload) {
        refuse(res, binding, 400, { error: "invalid_request", detail: payload.error });
        return;
      }
      const operator = bearerTokenId(req);
      const intent: IntentBinding = {
        operator, repository: binding.repository, instance: binding.instance, threadId: body.threadId, action: spec.action,
        payloadHash: createHash("sha256").update(JSON.stringify(payload.payload)).digest("hex"),
      };
      const key = createHash("sha256").update(JSON.stringify([operator, binding.instance, body.intentId])).digest("hex");
      const path = intentReceiptPath(binding.stateDir, key);
      const pending: IntentReceipt = { ...intent, intentId: body.intentId, key, status: "pending" };
      try {
        mkdirSync(join(binding.stateDir, INBOX_RECEIPT_DIR), { recursive: true });
        // The exclusive create IS the claim: one request per key, across requests, processes and restarts.
        writeFileSync(path, `${JSON.stringify(pending)}\n`, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          refuse(res, binding, 503, { error: "inbox_receipt_store_unavailable", delivery: "not_delivered", detail: String((error as NodeJS.ErrnoException).code ?? error) });
          return;
        }
        const read = readReceipt(path);
        const answer = "reason" in read
          ? { status: 409, body: { error: "inbox_intent_unknown", delivery: "unknown", detail: read.reason } }
          : replayAnswer(read.receipt, intent);
        if (answer !== "join") {
          refuse(res, binding, answer.status, answer.body);
          return;
        }
        const running = inflight.get(path);
        if (running === undefined) {
          refuse(res, binding, 409, { error: "inbox_intent_unknown", delivery: "unknown", detail: "this intent was claimed but its outcome was never recorded; it is not retried", receipt: receiptView((read as { receipt: IntentReceipt }).receipt) });
          return;
        }
        const joined = await running;
        refuse(res, binding, joined.status, { ...joined.body, replayed: true });
        return;
      }
      const run = deliver(spec, source, binding, req, ctx, raw, pending, path);
      inflight.set(path, run);
      try {
        const outcome = await run;
        refuse(res, binding, outcome.status, { ...outcome.body, replayed: false });
      } finally {
        inflight.delete(path);
      }
    },
  };
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
function releaseReceipt(path: string): string | undefined {
  try {
    unlinkSync(path);
    return undefined;
  } catch (error) {
    return `the refused intent stays claimed: ${String((error as NodeJS.ErrnoException).code ?? error)}`;
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
    await source.handler(req, capture.res, ctx);
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
    return { status: captured.status, body: released === undefined ? body : { ...body, receiptError: released } };
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
    const source = binding.routes.find((r) => r.method === spec.method && r.path === spec.source);
    if (source === undefined) continue;
    out.push(spec.kind === "write" ? writeRoute(spec, source, binding) : viewRoute(spec, source, binding));
  }
  return out;
}
