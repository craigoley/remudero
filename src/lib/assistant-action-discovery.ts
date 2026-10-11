/**
 * lib/assistant-action-discovery.ts — read-only, actor- and target-scoped discovery of admitted
 * assistant control actions that have no verified completion receipt (W1-T5399).
 *
 * A device that lost its local hint (closed tab, new browser, restarted replica) cannot ask the
 * known-ID receipt route, because it no longer knows the action ID. This reader walks the same
 * authoritative claim store POST /v1/control/assistant-action writes, and returns only the
 * calling actor's own claims for the exact mounted target. It never writes, never prepares or
 * retries an action, and never reverses a filename hash: a claim that does not carry its own
 * identity (the pre-v2 four-field shape) is a named limitation, never an invented ID.
 *
 * Every bound is explicit — listed entries, examined files, bytes per file, total bytes, elapsed
 * time and page size — and every read is asynchronous with periodic yielding. Anything this reader
 * could not certify (unreadable, oversized, unsupported or changed-during-read entries, an
 * exhausted budget) makes the answer partial or unavailable, never a verified empty pending list.
 */

import { createHash } from "node:crypto";
import { open, opendir, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { RmdError } from "./errors.js";

/** The authoritative claim shape POST writes before any side effect. */
export const ASSISTANT_CLAIM_VERSION = "assistant-claim-v2";
export const ASSISTANT_DISCOVERY_CONTRACT_VERSION = "assistant-action-discovery-v1";

export type AssistantClaimAction = "pause" | "resume" | "stop";

export interface AssistantClaimV2 {
  version: typeof ASSISTANT_CLAIM_VERSION;
  actionId: string;
  action: AssistantClaimAction;
  actorHash: string;
  instance: string;
  repository: string | null;
  submittedAt: string;
  fingerprint: string;
}

export interface DiscoveryBudget {
  /** Directory entries listed before the corpus is declared over its listing bound. */
  maxListed: number;
  /** Claim files examined in one request. */
  maxFiles: number;
  /** Bytes read from one claim or receipt file; a larger file is oversized, never truncated. */
  maxFileBytes: number;
  /** Bytes read across one request. */
  maxTotalBytes: number;
  /** Wall-clock work in one request. */
  maxElapsedMs: number;
  /** Files examined between cooperative yields to the event loop. */
  yieldEvery: number;
}

export const DEFAULT_DISCOVERY_BUDGET: DiscoveryBudget = {
  maxListed: 20_000, maxFiles: 2_000, maxFileBytes: 8_192, maxTotalBytes: 1_048_576, maxElapsedMs: 2_000, yieldEvery: 32,
};

/** PRIMARY CONTROL: the response-size bound; a full page stops the scan and hands back a continuation. */
export const MAX_DISCOVERY_PAGE = 100;
export const DEFAULT_DISCOVERY_PAGE = 50;

export type DiscoveryLimitation =
  | "legacy_claims_without_identity"
  | "unreadable_entries"
  | "oversized_entries"
  | "unsupported_entries"
  | "unverifiable_entries"
  | "corpus_changed"
  | "corpus_over_listing_bound"
  | "file_budget"
  | "byte_budget"
  | "time_budget"
  | "page_size"
  | "store_unavailable";

export interface DiscoveredAction {
  actionId: string;
  action: AssistantClaimAction;
  instance: string;
  repository: string | null;
  submittedAt: string;
  /** claimed_unknown: no receipt; receipt_unverified: a receipt exists but does not match this exact action and target. */
  status: "claimed_unknown" | "receipt_unverified";
}

export interface AssistantActionDiscovery {
  contract: typeof ASSISTANT_DISCOVERY_CONTRACT_VERSION;
  source: { instance: string; repository: string | null; bootSha: string };
  observedAt: string;
  /** complete: every entry in the scanned range was certified; partial: some were not, or the range stopped early; unavailable: the store could not be read. */
  completeness: "complete" | "partial" | "unavailable";
  limitations: DiscoveryLimitation[];
  pending: DiscoveredAction[];
  /** Opaque, actor- and target-bound; null when the scan reached the end of the store. */
  continuation: string | null;
  /** True only for a cursor-less, complete scan of the whole store that found nothing pending. */
  verifiedEmpty: boolean;
}

export interface DiscoveryRequest {
  claimRoot: string;
  actorHash: string;
  instance: string;
  repository: string | null;
  bootSha?: string;
  limit?: number;
  continuation?: string | null;
  budget?: Partial<DiscoveryBudget>;
  clock?: Clock;
  /** Read-only opener for claim and receipt files; the default is fs/promises `open(path, "r")`. */
  openFile?: (path: string) => Promise<FileHandle>;
}

export class DiscoveryContinuationError extends RmdError {
  constructor(options?: { cause?: unknown }) {
    super("usage", 1, "continuation is not valid for this actor and target", options?.cause === undefined ? undefined : { cause: String(options.cause) });
  }
}

const CLAIM_NAME = /^([0-9a-f]{64})\.claim\.json$/;
const RECEIPT_NAME = /^[0-9a-f]{64}\.receipt\.json$/;
const TEMP_NAME = /^[0-9a-f]{64}\.receipt\.json\.[0-9a-f-]{36}\.tmp$/;
const ACTION_ID = /^[A-Za-z0-9._:-]{8,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The digest a claim file is named by — the same one POST derives from the action ID. */
export function assistantClaimKey(actionId: string): string {
  return sha256(actionId);
}

/** The canonical payload fingerprint, unchanged from W1-T4763 so legacy duplicates still match. */
export function assistantClaimFingerprint(input: { actorHash: string; instance: string; repository: string | null; action: string; reason: string | null }): string {
  return sha256(JSON.stringify({ actorHash: input.actorHash, instance: input.instance, repository: input.repository, action: input.action, reason: input.reason }));
}

function binding(req: DiscoveryRequest): string {
  return sha256(JSON.stringify(["assistant-discovery-binding", req.actorHash, req.instance, req.repository]));
}

/** A position token that names no store path: a binding-salted digest of the last examined key. */
function positionToken(bind: string, key: string): string {
  return sha256(`${bind}:${key}`);
}

function encodeContinuation(bind: string, key: string): string {
  return Buffer.from(JSON.stringify({ v: 1, b: bind.slice(0, 16), p: positionToken(bind, key) })).toString("base64url");
}

function decodeContinuation(bind: string, token: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch (error) {
    throw new DiscoveryContinuationError({ cause: error });
  }
  if (!isRecord(parsed) || parsed.v !== 1 || parsed.b !== bind.slice(0, 16) || typeof parsed.p !== "string" || !/^[0-9a-f]{64}$/.test(parsed.p)) {
    throw new DiscoveryContinuationError();
  }
  return parsed.p;
}

type FileRead =
  | { kind: "ok"; text: string; bytes: number }
  | { kind: "missing" }
  | { kind: "oversized" }
  | { kind: "changed" }
  | { kind: "unreadable"; reason: string };

const openReadOnly = (path: string): Promise<FileHandle> => open(path, "r");

async function readOpen(handle: FileHandle, maxBytes: number): Promise<FileRead> {
  try {
    const before = await handle.stat();
    if (!before.isFile()) return { kind: "unreadable", reason: "not_a_file" };
    if (before.size > maxBytes) return { kind: "oversized" };
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) return { kind: "oversized" };
    const after = await handle.stat();
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return { kind: "changed" };
    return { kind: "ok", text: buffer.subarray(0, bytesRead).toString("utf8"), bytes: bytesRead };
  } catch (error) {
    return { kind: "unreadable", reason: (error as NodeJS.ErrnoException).code ?? "read_failed" };
  }
}

async function readBounded(path: string, maxBytes: number, openFile: (path: string) => Promise<FileHandle>): Promise<FileRead> {
  let handle: FileHandle;
  try {
    handle = await openFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable", reason: code ?? "open_failed" };
  }
  const result = await readOpen(handle, maxBytes);
  try {
    await handle.close();
  } catch (error) {
    // A handle that cannot be released is not a certified read: an uncertified entry, never a crashed scan.
    return { kind: "unreadable", reason: `close:${(error as NodeJS.ErrnoException).code ?? "close_failed"}` };
  }
  return result;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

type ClaimVerdict =
  | { kind: "v2"; claim: AssistantClaimV2 }
  | { kind: "legacy"; actorHash: string; instance: string; repository: unknown }
  | { kind: "unsupported" }
  | { kind: "unverifiable" };

function classifyClaim(value: unknown, key: string): ClaimVerdict {
  if (!isRecord(value)) return { kind: "unverifiable" };
  if (value.version === undefined) {
    if (typeof value.fingerprint === "string" && typeof value.actorHash === "string" && typeof value.instance === "string") {
      return { kind: "legacy", actorHash: value.actorHash, instance: value.instance, repository: value.repository };
    }
    return { kind: "unverifiable" };
  }
  if (value.version !== ASSISTANT_CLAIM_VERSION) return { kind: "unsupported" };
  const { actionId, action, actorHash, instance, repository, submittedAt, fingerprint } = value;
  if (typeof actionId !== "string" || !ACTION_ID.test(actionId) || assistantClaimKey(actionId) !== key) return { kind: "unverifiable" };
  if (action !== "pause" && action !== "resume" && action !== "stop") return { kind: "unverifiable" };
  if (typeof actorHash !== "string" || !/^[0-9a-f]{64}$/.test(actorHash)) return { kind: "unverifiable" };
  if (typeof instance !== "string" || !instance || (repository !== null && typeof repository !== "string")) return { kind: "unverifiable" };
  if (typeof submittedAt !== "string" || Number.isNaN(Date.parse(submittedAt))) return { kind: "unverifiable" };
  if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) return { kind: "unverifiable" };
  return { kind: "v2", claim: { version: ASSISTANT_CLAIM_VERSION, actionId, action, actorHash, instance, repository, submittedAt, fingerprint } };
}

/** An exact-target completion receipt: same action ID, verb, instance and repository, with ledger evidence. */
export function isExactAssistantReceipt(value: unknown, claim: Pick<AssistantClaimV2, "actionId" | "action" | "instance" | "repository">): boolean {
  return isRecord(value) && value.status === "completed" && value.actionId === claim.actionId && value.action === claim.action
    && value.instance === claim.instance && value.repository === (claim.repository ?? undefined)
    && typeof value.evidenceRef === "string" && value.evidenceRef.startsWith("ledger:") && isRecord(value.result);
}

async function directoryStamp(dir: string): Promise<string> {
  try {
    const s = await stat(dir);
    return `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
  } catch (error) {
    return `error:${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Read the calling actor's admitted-but-uncompleted actions for one exact target. GET-only:
 * this function opens files for reading and nothing else.
 */
export async function readAssistantActionDiscovery(req: DiscoveryRequest): Promise<AssistantActionDiscovery> {
  const budget = { ...DEFAULT_DISCOVERY_BUDGET, ...req.budget };
  const clock = req.clock ?? systemClock;
  const openFile = req.openFile ?? openReadOnly;
  const started = clock.now();
  const limit = Math.max(1, Math.min(MAX_DISCOVERY_PAGE, req.limit ?? DEFAULT_DISCOVERY_PAGE));
  const bind = binding(req);
  const resumeAt = req.continuation ? decodeContinuation(bind, req.continuation) : null;
  const limitations = new Set<DiscoveryLimitation>();
  const pending: DiscoveredAction[] = [];
  const answer = (completeness: AssistantActionDiscovery["completeness"], continuation: string | null): AssistantActionDiscovery => ({
    contract: ASSISTANT_DISCOVERY_CONTRACT_VERSION,
    source: { instance: req.instance, repository: req.repository, bootSha: req.bootSha ?? "unknown" },
    observedAt: clock.iso(),
    completeness: completeness === "complete" && limitations.size > 0 ? "partial" : completeness,
    limitations: [...limitations].sort(),
    pending,
    continuation,
    verifiedEmpty: completeness === "complete" && limitations.size === 0 && !resumeAt && !continuation && pending.length === 0,
  });

  const rootState = await stat(req.claimRoot).then((s) => (s.isDirectory() ? "directory" : "not_a_directory"),
    (error: NodeJS.ErrnoException) => `unreadable:${error.code ?? "unknown"}`);
  if (rootState !== "directory") {
    limitations.add("store_unavailable");
    return answer("unavailable", null);
  }
  const dir = join(req.claimRoot, "state", "assistant-control-actions");
  const stampBefore = await directoryStamp(dir);
  const keys: string[] = [];
  try {
    const handle = await opendir(dir);
    for await (const entry of handle) {
      if (keys.length >= budget.maxListed) {
        limitations.add("corpus_over_listing_bound");
        break;
      }
      const name = entry.name;
      const match = CLAIM_NAME.exec(name);
      if (match) keys.push(match[1]);
      else if (!RECEIPT_NAME.test(name) && !TEMP_NAME.test(name)) limitations.add("unverifiable_entries");
    }
  } catch (error) {
    // A never-initialized store under an existing root has admitted nothing: certifiably empty.
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !resumeAt) return answer("complete", null);
    limitations.add("store_unavailable");
    return answer("unavailable", null);
  }
  if (limitations.has("corpus_over_listing_bound")) {
    // An arbitrary listing subset has no stable order to continue from.
    limitations.add("unverifiable_entries");
  }
  keys.sort();
  let start = 0;
  if (resumeAt) {
    const index = keys.findIndex((key) => positionToken(bind, key) === resumeAt);
    if (index < 0) throw new DiscoveryContinuationError();
    start = index + 1;
  }

  let examined = 0;
  let totalBytes = 0;
  let lastKey: string | null = null;
  let stoppedEarly = false;
  for (let i = start; i < keys.length; i++) {
    // Every request examines at least one entry, so a continuation always advances.
    if (examined > 0) {
      if (examined >= budget.maxFiles) { limitations.add("file_budget"); stoppedEarly = true; break; }
      if (totalBytes >= budget.maxTotalBytes) { limitations.add("byte_budget"); stoppedEarly = true; break; }
      if (clock.now() - started >= budget.maxElapsedMs) { limitations.add("time_budget"); stoppedEarly = true; break; }
      if (pending.length >= limit) { limitations.add("page_size"); stoppedEarly = true; break; }
      if (examined % budget.yieldEvery === 0) await yieldToLoop();
    }
    const key = keys[i];
    examined++;
    lastKey = key;
    const read = await readBounded(join(dir, `${key}.claim.json`), budget.maxFileBytes, openFile);
    if (read.kind === "missing" || read.kind === "changed") { limitations.add("corpus_changed"); continue; }
    if (read.kind === "oversized") { limitations.add("oversized_entries"); continue; }
    if (read.kind === "unreadable") { limitations.add("unreadable_entries"); continue; }
    totalBytes += read.bytes;
    const parsed = parseJson(read.text);
    if (!parsed.ok) { limitations.add("unreadable_entries"); continue; }
    const verdict = classifyClaim(parsed.value, key);
    if (verdict.kind === "unsupported") { limitations.add("unsupported_entries"); continue; }
    if (verdict.kind === "unverifiable") { limitations.add("unverifiable_entries"); continue; }
    if (verdict.kind === "legacy") {
      // Only this actor's own pre-v2 claims are a gap in THIS answer; another actor's are not disclosed.
      if (verdict.actorHash === req.actorHash && verdict.instance === req.instance && (verdict.repository ?? null) === req.repository) {
        limitations.add("legacy_claims_without_identity");
      }
      continue;
    }
    const claim = verdict.claim;
    if (claim.actorHash !== req.actorHash || claim.instance !== req.instance || claim.repository !== req.repository) continue;
    const receipt = await readBounded(join(dir, `${key}.receipt.json`), budget.maxFileBytes, openFile);
    let status: DiscoveredAction["status"] | null;
    if (receipt.kind === "missing") status = "claimed_unknown";
    else if (receipt.kind === "ok") {
      totalBytes += receipt.bytes;
      const parsedReceipt = parseJson(receipt.text);
      status = parsedReceipt.ok && isExactAssistantReceipt(parsedReceipt.value, claim) ? null : "receipt_unverified";
    } else status = "receipt_unverified";
    if (status) {
      pending.push({ actionId: claim.actionId, action: claim.action, instance: claim.instance, repository: claim.repository, submittedAt: claim.submittedAt, status });
    }
  }
  if (await directoryStamp(dir) !== stampBefore) limitations.add("corpus_changed");
  if (!stoppedEarly || lastKey === null) return answer("complete", null);
  return answer("partial", encodeContinuation(bind, lastKey));
}
