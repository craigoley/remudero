/** Application trace capture, owner-custody verification and private canary scoring. */
import { createHash } from "node:crypto";
import { createStoredApplicationToolDispatcher, gradeStoredPrivateCase, privateCorpusMetadata,
  canonicalPrivateCanaryJson, snapshotPrivateCanaryJson,
  type PrivateTraceBindingV1, type PrivateTraceReceiptV1, type ValidatedPrivateCorpus } from "./model-canary-private-corpus.js";
import type { CanaryToolEvent } from "./model-canary-suite.js";
export type { PrivateTraceBindingV1, PrivateTraceReceiptV1 } from "./model-canary-private-corpus.js";

const MAX_TRACE_EVENTS = 32;
const MAX_TRACE_BYTES = 32 * 1024;
const MAX_FINAL_TEXT_BYTES = 65_536;
const MAX_RECEIPT_BYTES = 128 * 1024;
interface TraceBudget { remaining: number }
interface FrozenTraceSnapshot {
  binding: PrivateTraceBindingV1 | null;
  finalText: string | null;
  complete: boolean;
  reason: string | null;
  events: readonly CanaryToolEvent[];
}

/** Public type deliberately carries no serializable evidence, ids, or self-asserted trust fields. */
export type CapturedCanaryTrace = object;
const traceSnapshots = new WeakMap<object, FrozenTraceSnapshot>();
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function fail(reason: string): never { throw new Error(reason); }

function snapshotTraceJson(value: unknown, limit: number): unknown {
  try { return snapshotPrivateCanaryJson(value, limit); }
  catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (reason === "private-corpus-json-cycle") return fail("private-trace-json-cycle");
    if (reason === "private-corpus-json-invalid" || reason === "private-corpus-json-object-invalid"
      || reason === "private-corpus-json-array-invalid") return fail("private-trace-json-invalid");
    if (reason === "private-corpus-json-complexity-bound") return fail("private-trace-json-bound");
    return fail("private-trace-size-bound");
  }
}

function canonicalTraceJson(value: unknown, limit = MAX_RECEIPT_BYTES): string {
  try { return canonicalPrivateCanaryJson(value, limit); }
  catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (reason === "private-corpus-json-cycle") return fail("private-trace-json-cycle");
    if (reason === "private-corpus-json-invalid" || reason === "private-corpus-json-object-invalid"
      || reason === "private-corpus-json-array-invalid") return fail("private-trace-json-invalid");
    if (reason === "private-corpus-json-complexity-bound") return fail("private-trace-json-bound");
    return fail("private-trace-size-bound");
  }
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!record(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.every(key => typeof key === "string") && actual.length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function normalizeBinding(corpus: ValidatedPrivateCorpus, caseId: string, raw: unknown): PrivateTraceBindingV1 | null {
  try {
    const binding = snapshotTraceJson(raw, 4096);
    if (!exactKeys(binding, ["version", "runId", "slotId", "caseId", "suiteHash", "corpusDigest", "scorerDigest"])
      || binding.version !== "private-canary-trace-binding-v1"
      || typeof binding.runId !== "string" || binding.runId.length < 1 || binding.runId.length > 128
      || typeof binding.slotId !== "string" || binding.slotId.length < 1 || binding.slotId.length > 160
      || binding.caseId !== caseId
      || typeof binding.suiteHash !== "string" || !/^[a-f0-9]{64}$/.test(binding.suiteHash)
      || typeof binding.corpusDigest !== "string" || !/^[a-f0-9]{64}$/.test(binding.corpusDigest)
      || typeof binding.scorerDigest !== "string" || !/^[a-f0-9]{64}$/.test(binding.scorerDigest)) return null;
    const metadata = privateCorpusMetadata(corpus);
    const scorer = metadata?.cases.find(item => item.caseId === caseId)?.scorerDigest;
    if (!metadata || binding.corpusDigest !== metadata.digest || binding.scorerDigest !== scorer) return null;
    return binding as unknown as PrivateTraceBindingV1;
  } catch { // Malformed or oversized evidence supplies no usable trace binding or receipt.
    return null;
  }
}

function bindingsEqual(left: PrivateTraceBindingV1, right: PrivateTraceBindingV1): boolean {
  try { return canonicalTraceJson(left, 4096) === canonicalTraceJson(right, 4096); }
  catch { // A failed canonical comparison cannot establish binding equality.
    return false;
  }
}

function snapshotReceipt(snapshot: FrozenTraceSnapshot): PrivateTraceReceiptV1 | null {
  try {
    if (!snapshot.binding) return null;
    const body = { version: "private-canary-trace-receipt-v1" as const, binding: snapshot.binding,
      finalText: snapshot.finalText, events: snapshot.events, complete: snapshot.complete, reason: snapshot.reason };
    const digest = sha256(canonicalTraceJson(body));
    const receipt = Object.freeze({ ...body, digest });
    if (Buffer.byteLength(canonicalTraceJson(receipt), "utf8") > MAX_RECEIPT_BYTES) return null;
    return receipt;
  } catch { // Malformed or oversized evidence supplies no usable trace binding or receipt.
    return null;
  }
}

function receiptSnapshot(corpus: ValidatedPrivateCorpus, caseId: string, expectedBinding: unknown,
  value: unknown): { snapshot: FrozenTraceSnapshot } | { reason: string } {
  try {
    const safe = snapshotTraceJson(value, MAX_RECEIPT_BYTES);
    if (!exactKeys(safe, ["version", "binding", "finalText", "events", "complete", "reason", "digest"])
      || safe.version !== "private-canary-trace-receipt-v1" || !Array.isArray(safe.events)
      || typeof safe.complete !== "boolean" || !(safe.reason === null || typeof safe.reason === "string")
      || !(safe.finalText === null || typeof safe.finalText === "string")
      || safe.events.length > MAX_TRACE_EVENTS || safe.reason !== null && safe.reason.length > 200)
      return { reason: "private-trace-receipt-shape-invalid" };
    const binding = normalizeBinding(corpus, caseId, safe.binding);
    const expected = normalizeBinding(corpus, caseId, expectedBinding);
    if (!binding || !expected || !bindingsEqual(binding, expected)) return { reason: "private-trace-binding-mismatch" };
    if (safe.finalText !== null && Buffer.byteLength(safe.finalText, "utf8") > MAX_FINAL_TEXT_BYTES)
      return { reason: "private-trace-final-text-bound" };
    if (safe.complete ? safe.reason !== null : typeof safe.reason !== "string" || safe.reason.length === 0)
      return { reason: "private-trace-receipt-completeness-invalid" };
    const events = snapshotTraceJson(safe.events, MAX_TRACE_BYTES) as CanaryToolEvent[];
    for (const event of events) {
      if (!exactKeys(event, ["name", "args", "result", "denied"]) || typeof event.name !== "string"
        || event.name.length > 100 || typeof event.denied !== "boolean") return { reason: "private-trace-event-invalid" };
    }
    const body = { version: safe.version, binding, finalText: safe.finalText, events,
      complete: safe.complete, reason: safe.reason };
    const computed = sha256(canonicalTraceJson(body));
    if (safe.digest !== computed) return { reason: "private-trace-receipt-digest-invalid" };
    return { snapshot: Object.freeze({ binding, finalText: safe.finalText, complete: safe.complete,
      reason: safe.reason, events }) };
  } catch (error) {
    return { reason: error instanceof Error && error.message.startsWith("private-trace-")
      ? error.message : "private-trace-receipt-invalid" };
  }
}

/**
 * App-owned tool recorder. It calls the validated case's native deterministic tool port itself;
 * it never accepts a serialized event array. `binding` must come from the active runner slot.
 */
export function createApplicationTraceRecorder(corpus: ValidatedPrivateCorpus, caseId: string,
  rawBinding: PrivateTraceBindingV1) {
  const binding = normalizeBinding(corpus, caseId, rawBinding);
  const dispatch = binding ? createStoredApplicationToolDispatcher(corpus, caseId) : null;
  const events: CanaryToolEvent[] = [];
  const budget: TraceBudget = { remaining: MAX_TRACE_BYTES };
  let failed: string | null = binding === null ? "private-trace-binding-mismatch"
    : dispatch === null ? "private-corpus-case-unknown" : null;
  let closed = false;
  return Object.freeze({
    dispatch(name: string, args: unknown): CanaryToolEvent {
      if (closed) throw new Error("private-trace-recorder-closed");
      if (events.length >= MAX_TRACE_EVENTS) { failed = "private-trace-event-bound"; throw new Error(failed); }
      try {
        const safeArgs = snapshotTraceJson(args, budget.remaining);
        if (!dispatch || typeof name !== "string" || name.length < 1 || name.length > 100)
          fail("private-trace-dispatch-unavailable");
        const raw = dispatch(name, safeArgs);
        const event = snapshotTraceJson(raw, budget.remaining);
        if (!exactKeys(event, ["name", "args", "result", "denied"]) || event.name !== name
          || typeof event.denied !== "boolean") fail("private-trace-dispatch-result-invalid");
        const captured = event as unknown as CanaryToolEvent;
        const charge = Buffer.byteLength(canonicalTraceJson(captured, budget.remaining), "utf8");
        if (charge > budget.remaining) fail("private-trace-size-bound");
        budget.remaining -= charge;
        events.push(captured);
        return captured;
      } catch (error) {
        failed ??= error instanceof Error && error.message.startsWith("private-trace-")
          ? error.message : "private-trace-dispatch-failed";
        throw error;
      }
    },
    finish(finalText: string | null): CapturedCanaryTrace {
      if (closed) throw new Error("private-trace-recorder-closed");
      closed = true;
      if (finalText !== null && (typeof finalText !== "string" || Buffer.byteLength(finalText, "utf8") > MAX_FINAL_TEXT_BYTES)) {
        failed ??= "private-trace-final-text-bound";
        finalText = null;
      }
      const token = Object.freeze(Object.create(null)) as CapturedCanaryTrace;
      const snapshot = Object.freeze({ binding,
        finalText, events: Object.freeze([...events]), complete: failed === null, reason: failed });
      traceSnapshots.set(token, snapshot);
      return token;
    },
  });
}

/** Returns a serializable receipt only for an in-process trace token created by the app recorder. */
export function capturedPrivateTraceReceipt(trace: unknown): PrivateTraceReceiptV1 | null {
  if (trace === null || typeof trace !== "object") return null;
  const snapshot = traceSnapshots.get(trace);
  return snapshot ? snapshotReceipt(snapshot) : null;
}

/**
 * Native owner reader is the only supported JSON-to-capability restoration boundary. The callback
 * must perform the real read-only owner verification; a receipt's own labels are never authority.
 * This boundary does not defend against replacement of trusted same-process code or same-UID DB edits.
 */
export function loadPrivateTraceFromCustody(corpus: ValidatedPrivateCorpus, caseId: string,
  expectedBinding: PrivateTraceBindingV1,
  readVerifiedReceipt: (binding: PrivateTraceBindingV1) => unknown):
  | { state: "available"; trace: CapturedCanaryTrace; finalText: string | null }
  | { state: "unavailable"; reason: string } {
  const binding = normalizeBinding(corpus, caseId, expectedBinding);
  if (!binding) return { state: "unavailable", reason: "private-trace-binding-mismatch" };
  if (typeof readVerifiedReceipt !== "function") return { state: "unavailable", reason: "private-trace-owner-reader-unavailable" };
  try {
    const read = readVerifiedReceipt(binding);
    if (!record(read) || typeof read.state !== "string"
      || !["available", "unavailable"].includes(read.state))
      return { state: "unavailable", reason: "private-trace-owner-reader-result-invalid" };
    if (read.state === "unavailable") return { state: "unavailable", reason: typeof read.reason === "string"
      ? read.reason : "private-trace-owner-receipt-unavailable" };
    const checked = receiptSnapshot(corpus, caseId, binding, read.receipt);
    if ("reason" in checked) return { state: "unavailable", reason: checked.reason };
    const token = Object.freeze(Object.create(null)) as CapturedCanaryTrace;
    traceSnapshots.set(token, checked.snapshot);
    return { state: "available", trace: token, finalText: checked.snapshot.finalText };
  } catch { return { state: "unavailable", reason: "private-trace-owner-reader-failed" }; }
}

export type PrivateTraceGrade =
  | { state: "unavailable"; reason: string }
  | { state: "scored"; passed: boolean; finalPassed: boolean | null; tracePassed: boolean; schemaValid: boolean;
      reason: string };

export function gradePrivateTrace(corpus: ValidatedPrivateCorpus, caseId: string, finalText: string | null,
  trace: unknown, expectedBinding: PrivateTraceBindingV1): PrivateTraceGrade {
  const snapshot = trace !== null && typeof trace === "object" ? traceSnapshots.get(trace) : undefined;
  if (!snapshot) return { state: "unavailable", reason: "private-trace-capability-unrecognized" };
  const binding = normalizeBinding(corpus, caseId, expectedBinding);
  if (!binding || !snapshot.binding || !bindingsEqual(snapshot.binding, binding)) return { state: "unavailable", reason: "private-trace-binding-mismatch" };
  if (finalText !== snapshot.finalText) return { state: "unavailable", reason: "private-trace-answer-capture-mismatch" };
  if (snapshotReceipt(snapshot) === null) return { state: "unavailable", reason: "private-trace-receipt-size-bound" };
  const unauthorized = snapshot.events.some(event => event.denied);
  if (snapshot.complete === false)
    return { state: "unavailable", reason: snapshot.reason ?? "private-trace-incomplete" };
  if (snapshot.finalText === null) {
    if (unauthorized) return { state: "scored", passed: false, finalPassed: null, tracePassed: false,
      schemaValid: false, reason: "unauthorized-action" };
    return { state: "unavailable", reason: "private-trace-final-answer-unavailable" };
  }
  try {
    const result = gradeStoredPrivateCase(corpus, caseId, snapshot.finalText, snapshot.events);
    if (result.state !== "scored") return result;
    return result;
  } catch { return { state: "unavailable", reason: "private-trace-scorer-error" }; }
}
