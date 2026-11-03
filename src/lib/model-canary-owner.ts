/** Durable canary ownership. No provider execution, stale-claim reclamation or schedule activation. */
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CanarySlot, CanarySchedulePorts } from "./model-canary-schedule.js";
import { retentionSlotTurnBound, retentionTerminalMatches } from "./model-canary-retention-schedule.js";
import { contextSlotCallBound, contextTerminalMatches } from "./model-canary-context-schedule.js";
import { canonicalPrivateCanaryJson, snapshotPrivateCanaryJson,
  type PrivateTraceBindingV1, type PrivateTraceReceiptV1 } from "./model-canary-private-corpus.js";

type Outcome = Parameters<CanarySchedulePorts["terminal"]>[1];
const MAX_SLOTS = 100_000;
const MAX_RECEIPT_BYTES = 128 * 1024;
const PRIVATE_TRACE_VERSION = "private-canary-trace-receipt-v1";
const privateTraceDigestPattern = /^[a-f0-9]{64}$/;

export type OwnedPrivateTraceReceiptResult =
  | { state: "available"; receipt: PrivateTraceReceiptV1 }
  | { state: "unavailable"; reason: string };

function privateTraceBindingMatches(binding: PrivateTraceBindingV1, slot: CanarySlot, runId: string,
  expected?: PrivateTraceBindingV1): boolean {
  if (!binding || Object.keys(binding).sort().join("\0") !==
    ["caseId", "corpusDigest", "runId", "scorerDigest", "slotId", "suiteHash", "version"].join("\0")
    || typeof binding.runId !== "string" || binding.runId.length < 1 || binding.runId.length > 128
    || binding.version !== "private-canary-trace-binding-v1"
    || binding.runId !== runId || binding.slotId !== slot.id || binding.caseId !== slot.caseId
    || binding.suiteHash !== slot.pin.suiteHash || typeof binding.corpusDigest !== "string"
    || !privateTraceDigestPattern.test(binding.corpusDigest) || typeof binding.scorerDigest !== "string"
    || !privateTraceDigestPattern.test(binding.scorerDigest)) return false;
  if (!expected) return true;
  return expected.version === binding.version && expected.runId === binding.runId
    && expected.slotId === binding.slotId && expected.caseId === binding.caseId
    && expected.suiteHash === binding.suiteHash && expected.corpusDigest === binding.corpusDigest
    && expected.scorerDigest === binding.scorerDigest;
}

/** Validate and copy the receipt before either terminal persistence or read-only custody return. */
function privateTraceReceipt(value: unknown, slot: CanarySlot, runId: string,
  expected?: PrivateTraceBindingV1): PrivateTraceReceiptV1 | null {
  if (value === null || typeof value !== "object") return null;
  let snapshot: unknown;
  try { snapshot = snapshotPrivateCanaryJson(value, MAX_RECEIPT_BYTES); } catch { // Invalid or oversized receipt bytes cannot establish owner custody.
    return null;
  }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const raw = snapshot as Record<string, unknown>;
  const keys = ["version", "binding", "finalText", "events", "complete", "reason", "digest"].sort();
  if (Object.keys(raw).sort().join("\0") !== keys.join("\0") || raw.version !== PRIVATE_TRACE_VERSION
    || !privateTraceBindingMatches(raw.binding as PrivateTraceBindingV1, slot, runId, expected)
    || !(raw.finalText === null || typeof raw.finalText === "string")
    || (typeof raw.finalText === "string" && Buffer.byteLength(raw.finalText, "utf8") > 65_536)
    || !Array.isArray(raw.events) || raw.events.length > 32 || typeof raw.complete !== "boolean"
    || !(raw.reason === null || typeof raw.reason === "string")
    || (typeof raw.reason === "string" && Buffer.byteLength(raw.reason, "utf8") > 200)
    || (raw.complete ? raw.reason !== null : typeof raw.reason !== "string" || raw.reason.length === 0)
    || typeof raw.digest !== "string" || !privateTraceDigestPattern.test(raw.digest)) return null;
  for (const event of raw.events) {
    if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
    const eventRecord = event as Record<string, unknown>;
    if (Object.keys(eventRecord).sort().join("\0") !== ["args", "denied", "name", "result"].join("\0")
      || typeof eventRecord.name !== "string" || eventRecord.name.length > 100
      || typeof eventRecord.denied !== "boolean") return null;
  }
  let eventBytes: number, actualDigest: string;
  try {
    eventBytes = Buffer.byteLength(canonicalPrivateCanaryJson(raw.events, 32 * 1024), "utf8");
    const withoutDigest = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "digest"));
    actualDigest = createHash("sha256").update(canonicalPrivateCanaryJson(withoutDigest, MAX_RECEIPT_BYTES)).digest("hex");
  } catch { // Invalid or oversized receipt bytes cannot establish owner custody.
    return null;
  }
  if (eventBytes > 32 * 1024) return null;
  if (raw.digest !== actualDigest) return null;
  return raw as unknown as PrivateTraceReceiptV1;
}

function privateDirectoryPath(privateDirectory: string): string {
  const requested = resolve(privateDirectory), dir = realpathSync(requested), info = statSync(dir);
  if (!lstatSync(requested).isDirectory() || !info.isDirectory() || (info.mode & 0o077) !== 0
    || (process.geteuid && info.uid !== process.geteuid())) throw new Error("canary-owner-private-directory-required");
  for (let parent = dir; ; parent = dirname(parent)) {
    if (existsSync(join(parent, ".git"))) throw new Error("canary-owner-directory-inside-git");
    if (dirname(parent) === parent) break;
  }
  return dir;
}

function binding(slot: CanarySlot): string {
  if (!/^[a-f0-9]{64}$/.test(slot.id) || !/^[a-f0-9]{64}$/.test(slot.pin.suiteHash)
    || !slot.caseId || slot.caseId.length > 128 || !slot.pin.model || slot.pin.model.length > 128
    || !slot.pin.route || slot.pin.route.length > 128 || !slot.pin.effort || slot.pin.effort.length > 32
    || !["api", "subscription"].includes(slot.pin.billing) || ![null, "A", "B"].includes(slot.aaLabel))
    throw new Error("canary-owner-slot-invalid");
  retentionSlotTurnBound(slot);
  contextSlotCallBound(slot);
  const ordinary = [slot.caseId, slot.pin.model, slot.pin.route, slot.pin.effort,
    slot.pin.suiteHash, slot.pin.billing, slot.aaLabel];
  return JSON.stringify(slot.context !== undefined ? [...ordinary, slot.context]
    : slot.retention === undefined ? ordinary : [...ordinary, slot.retention]);
}

/** The directory is an existing private operations directory shared by every runner on this host.
 * SQLite serializes each write. Its durable started row survives process exit; age is never authority
 * to repeat a possibly billed call. One active slot across all plans enforces shared concurrency one. */
export class CanarySlotOwner {
  private readonly db: DatabaseSync;
  private readonly owner = randomUUID();

  constructor(privateDirectory: string) {
    // Canonicalize ancestor aliases such as macOS /var; the requested leaf itself cannot be a symlink.
    const dir = privateDirectoryPath(privateDirectory);
    const file = join(dir, "model-canary-slots.sqlite");
    this.db = new DatabaseSync(file, { timeout: 5_000 });
    try {
      chmodSync(file, 0o600);
      this.db.exec(`PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS canary_slots_v1 (
          id TEXT PRIMARY KEY, binding TEXT NOT NULL, owner TEXT NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('started','terminal')), receipt TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS canary_one_active_v1
          ON canary_slots_v1((1)) WHERE phase='started';`);
    } catch (error) {
      this.db.close(); throw error;
    }
  }

  claim(slot: CanarySlot): "claimed" | "already-owned-or-terminal" {
    const identity = binding(slot);
    const added = this.db.prepare(`INSERT INTO canary_slots_v1(id,binding,owner,phase)
      SELECT ?,?,?,'started' WHERE (SELECT COUNT(*) FROM canary_slots_v1) < ?
        AND NOT EXISTS(SELECT 1 FROM canary_slots_v1 WHERE phase='started')
      ON CONFLICT DO NOTHING`).run(slot.id, identity, this.owner, MAX_SLOTS);
    if (added.changes === 1) return "claimed";
    const prior = this.db.prepare("SELECT binding FROM canary_slots_v1 WHERE id=?").get(slot.id);
    if (prior) {
      if (prior.binding !== identity) throw new Error("canary-owner-slot-identity-conflict");
      return "already-owned-or-terminal";
    }
    // Neither a busy shared owner nor a full store can be called a completed/skipped slot.
    throw new Error("canary-owner-busy-or-capacity");
  }

  terminal(slot: CanarySlot, outcome: Outcome): void {
    const identity = binding(slot), run = outcome.run;
    if ((outcome.state !== "scored" && outcome.state !== "unavailable")
      || run.caseId !== slot.caseId || run.suiteHash !== slot.pin.suiteHash || run.model !== slot.pin.model
      || run.route !== slot.pin.route || run.effort !== slot.pin.effort
      || (outcome.state === "unavailable" ? run.verified !== null : typeof run.verified !== "boolean")
      || run.attempts.length > (slot.context === undefined ? retentionSlotTurnBound(slot) : contextSlotCallBound(slot))
      || run.attempts.some(a => a.billing !== slot.pin.billing)
      || !retentionTerminalMatches(slot, run, outcome.state) || !contextTerminalMatches(slot, run, outcome.state))
      throw new Error("canary-owner-terminal-identity-invalid");
    const privateOutcome = outcome as Outcome & { privateTrace?: unknown;
      privateGrade?: { state?: unknown; passed?: unknown; finalPassed?: unknown; tracePassed?: unknown;
        reason?: unknown; schemaValid?: unknown } };
    const hasPrivateTrace = privateOutcome.privateTrace !== undefined;
    let privateTrace: PrivateTraceReceiptV1 | undefined;
    if (hasPrivateTrace) {
      privateTrace = privateTraceReceipt(privateOutcome.privateTrace, slot, run.id) ?? undefined;
      if (!privateTrace) throw new Error("canary-owner-private-trace-invalid");
      if (privateOutcome.privateGrade?.state === "scored") {
        const denied = privateTrace.events.some(event => event.denied);
        const legacyGrade = outcome.grade as { passed?: unknown; reason?: unknown; schemaValid?: unknown } | null;
        const passedFromFields = privateOutcome.privateGrade.finalPassed === true
          && privateOutcome.privateGrade.tracePassed === true;
        if (!privateTrace.complete
          || typeof privateOutcome.privateGrade.passed !== "boolean"
          || (typeof privateOutcome.privateGrade.finalPassed !== "boolean" && privateOutcome.privateGrade.finalPassed !== null)
          || typeof privateOutcome.privateGrade.tracePassed !== "boolean"
          || typeof privateOutcome.privateGrade.reason !== "string"
          || typeof privateOutcome.privateGrade.schemaValid !== "boolean"
          || privateOutcome.privateGrade.passed !== passedFromFields
          || (privateOutcome.privateGrade.finalPassed === null
            && (!denied || privateOutcome.privateGrade.tracePassed || privateOutcome.privateGrade.schemaValid))
          || outcome.state !== "scored"
          || (denied && (privateOutcome.privateGrade.passed || privateOutcome.privateGrade.tracePassed
            || privateOutcome.privateGrade.reason !== "unauthorized-action"))
          || run.verified !== privateOutcome.privateGrade.passed
          || run.outcomeReason !== privateOutcome.privateGrade.reason
          || outcome.reason !== privateOutcome.privateGrade.reason
          || !legacyGrade || legacyGrade.passed !== privateOutcome.privateGrade.passed
          || legacyGrade.reason !== privateOutcome.privateGrade.reason
          || legacyGrade.schemaValid !== privateOutcome.privateGrade.schemaValid)
          throw new Error("canary-owner-private-trace-grade-invalid");
      } else if (privateOutcome.privateGrade?.state !== "unavailable" || outcome.state !== "unavailable"
        || run.verified !== null || outcome.grade !== null) {
        throw new Error("canary-owner-private-trace-unavailable-grade-invalid");
      }
    } else if (privateOutcome.privateGrade !== undefined) {
      throw new Error("canary-owner-private-trace-missing");
    }
    // Retain result/usage and the held-out grade, never an arbitrary transport Error or credential.
    // Omitting this conditional field preserves the exact legacy serialization for ordinary runs.
    const receipt = JSON.stringify({ slot, run, grade: outcome.grade, state: outcome.state, reason: outcome.reason,
      ...(privateTrace === undefined ? {} : { privateTrace }) });
    if (Buffer.byteLength(receipt, "utf8") > MAX_RECEIPT_BYTES) throw new Error("canary-owner-receipt-bound");
    const changed = this.db.prepare(`UPDATE canary_slots_v1 SET phase='terminal',receipt=?
      WHERE id=? AND binding=? AND owner=? AND phase='started'`).run(receipt, slot.id, identity, this.owner);
    if (changed.changes !== 1) throw new Error("canary-owner-terminal-not-owned");
  }

  close(): void { this.db.close(); }
}

/**
 * Read a private trace from the existing terminal owner row. `privateDirectory` must come from
 * the trusted native owner's preconfigured private directory, never from a corpus or imported receipt.
 * This function is strictly read-only:
 * it never creates a directory/database/schema, claims a slot, or repairs malformed custody.
 * The returned JSON receipt is inert; the trace grader must restore its own WeakMap token through
 * loadPrivateTraceFromCustody before it can be used as scoring evidence.
 */
export function readOwnedPrivateTraceReceipt(privateDirectory: string, slot: CanarySlot,
  expectedBinding: PrivateTraceBindingV1): OwnedPrivateTraceReceiptResult {
  let db: DatabaseSync | undefined;
  try {
    const dir = privateDirectoryPath(privateDirectory), file = join(dir, "model-canary-slots.sqlite");
    const expectedSnapshot = snapshotPrivateCanaryJson(expectedBinding, 4096);
    if (expectedSnapshot === null || typeof expectedSnapshot !== "object" || Array.isArray(expectedSnapshot))
      return { state: "unavailable", reason: "canary-owner-expected-binding-invalid" };
    const safeExpected = expectedSnapshot as PrivateTraceBindingV1;
    const fileInfo = lstatSync(file);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || (fileInfo.mode & 0o077) !== 0
      || (process.geteuid && fileInfo.uid !== process.geteuid()))
      return { state: "unavailable", reason: "canary-owner-db-not-private" };
    const expectedSlotBinding = binding(slot);
    if (!privateTraceBindingMatches(safeExpected, slot, safeExpected.runId, safeExpected))
      return { state: "unavailable", reason: "canary-owner-expected-binding-invalid" };
    db = new DatabaseSync(file, { readOnly: true, timeout: 5_000 });
    const row = db.prepare("SELECT binding,phase,receipt FROM canary_slots_v1 WHERE id=?").get(slot.id) as
      { binding?: unknown; phase?: unknown; receipt?: unknown } | undefined;
    if (!row || row.binding !== expectedSlotBinding || row.phase !== "terminal" || typeof row.receipt !== "string"
      || Buffer.byteLength(row.receipt, "utf8") > MAX_RECEIPT_BYTES)
      return { state: "unavailable", reason: "canary-owner-terminal-receipt-missing" };
    const stored = JSON.parse(row.receipt) as Record<string, unknown>;
    if (!stored || typeof stored !== "object" || Array.isArray(stored) || !stored.slot || !stored.run
      || !stored.privateTrace) return { state: "unavailable", reason: "canary-owner-private-trace-missing" };
    const storedSlot = stored.slot as CanarySlot;
    const run = stored.run as { id?: unknown; caseId?: unknown; suiteHash?: unknown; model?: unknown; route?: unknown;
      effort?: unknown; attempts?: unknown; verified?: unknown; outcomeReason?: unknown };
    if (binding(storedSlot) !== expectedSlotBinding || run.id !== safeExpected.runId
      || run.caseId !== slot.caseId || run.suiteHash !== slot.pin.suiteHash || run.model !== slot.pin.model
      || run.route !== slot.pin.route || run.effort !== slot.pin.effort || !Array.isArray(run.attempts)
      || (run.verified !== null && typeof run.verified !== "boolean"))
      return { state: "unavailable", reason: "canary-owner-private-trace-run-binding-mismatch" };
    const trace = privateTraceReceipt(stored.privateTrace, slot, String(run.id), safeExpected);
    if (!trace) return { state: "unavailable", reason: "canary-owner-private-trace-invalid" };
    const grade = stored.grade as { passed?: unknown; reason?: unknown; schemaValid?: unknown } | null;
    const expectedState = run.verified === null ? "unavailable" : "scored";
    if (stored.state !== expectedState)
      return { state: "unavailable", reason: "canary-owner-private-trace-state-mismatch" };
    if (run.verified !== null) {
      const denied = trace.events.some(event => event.denied);
      if (!trace.complete || !grade || typeof grade !== "object"
        || grade.passed !== run.verified || typeof grade.reason !== "string" || typeof grade.schemaValid !== "boolean"
        || stored.reason !== grade.reason || run.outcomeReason !== grade.reason
        || (denied && (run.verified || grade.reason !== "unauthorized-action")))
        return { state: "unavailable", reason: "canary-owner-private-trace-grade-invalid" };
    } else if (stored.grade !== null) {
      return { state: "unavailable", reason: "canary-owner-private-trace-unavailable-grade-invalid" };
    }
    return { state: "available", receipt: trace };
  } catch {
    return { state: "unavailable", reason: "canary-owner-private-trace-custody-unreadable" };
  } finally {
    db?.close();
  }
}
