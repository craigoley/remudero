/** Durable canary ownership. No provider execution, stale-claim reclamation or schedule activation. */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, realpathSync, lstatSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CanarySlot, CanarySchedulePorts } from "./model-canary-schedule.js";
import { retentionSlotTurnBound, retentionTerminalMatches } from "./model-canary-retention-schedule.js";
import { contextSlotCallBound, contextTerminalMatches } from "./model-canary-context-schedule.js";
import { codingSlotCase, isCodingCase, validateCodingCheckpoint, type CodingCheckpoint } from "./model-canary-coding-checkpoint.js";
import { codingScheduledTrial } from "./model-canary-coding-schedule.js";

type Outcome = Parameters<CanarySchedulePorts["terminal"]>[1];
const MAX_SLOTS = 100_000;
const MAX_RECEIPT_BYTES = 128 * 1024;

function binding(slot: CanarySlot): string {
  if (!/^[a-f0-9]{64}$/.test(slot.id) || !/^[a-f0-9]{64}$/.test(slot.pin.suiteHash)
    || !slot.caseId || slot.caseId.length > 128 || !slot.pin.model || slot.pin.model.length > 128
    || !slot.pin.route || slot.pin.route.length > 128 || !slot.pin.effort || slot.pin.effort.length > 32
    || !["api", "subscription"].includes(slot.pin.billing) || ![null, "A", "B"].includes(slot.aaLabel))
    throw new Error("canary-owner-slot-invalid");
  retentionSlotTurnBound(slot);
  contextSlotCallBound(slot);
  codingScheduledTrial(slot);
  const ordinary = [slot.caseId, slot.pin.model, slot.pin.route, slot.pin.effort,
    slot.pin.suiteHash, slot.pin.billing, slot.aaLabel];
  return JSON.stringify(slot.coding !== undefined ? [...ordinary, slot.coding]
    : slot.context !== undefined ? [...ordinary, slot.context]
    : slot.retention === undefined ? ordinary : [...ordinary, slot.retention]);
}

/** The directory is an existing private operations directory shared by every runner on this host.
 * SQLite serializes each write. Its durable started row survives process exit; age is never authority
 * to repeat a possibly billed call. One active slot across all plans enforces shared concurrency one. */
export class CanarySlotOwner {
  private readonly db: DatabaseSync;
  private readonly owner = randomUUID();

  constructor(privateDirectory: string) {
    const requested = resolve(privateDirectory), dir = realpathSync(requested), info = statSync(dir);
    // Canonicalize ancestor aliases such as macOS /var; the requested leaf must be a directory.
    if (!lstatSync(requested).isDirectory() || !info.isDirectory() || (info.mode & 0o077) !== 0
      || (process.geteuid && info.uid !== process.geteuid())) throw new Error("canary-owner-private-directory-required");
    for (let parent = dir; ; parent = dirname(parent)) {
      if (existsSync(join(parent, ".git"))) throw new Error("canary-owner-directory-inside-git");
      if (dirname(parent) === parent) break;
    }
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

  /** Read the same durable row; a started or unreadable slot is never credited as terminal. */
  phase(slot: CanarySlot): "unclaimed" | "started" | "terminal" {
    const identity = binding(slot);
    const row = this.db.prepare("SELECT binding,phase FROM canary_slots_v1 WHERE id=?").get(slot.id);
    if (!row) return "unclaimed";
    if (row.binding !== identity) throw new Error("canary-owner-slot-identity-conflict");
    if (row.phase !== "started" && row.phase !== "terminal") throw new Error("canary-owner-phase-invalid");
    return row.phase;
  }

  terminal(slot: CanarySlot, outcome: Outcome): void {
    if (isCodingCase(slot.caseId)) throw new Error("coding-owner-terminal-requires-cleanup");
    const identity = binding(slot), run = outcome.run;
    if (run.caseId !== slot.caseId || run.suiteHash !== slot.pin.suiteHash || run.model !== slot.pin.model
      || run.route !== slot.pin.route || run.effort !== slot.pin.effort
      || (outcome.state === "unavailable" ? run.verified !== null : typeof run.verified !== "boolean")
      || run.attempts.length > (slot.context === undefined ? retentionSlotTurnBound(slot) : contextSlotCallBound(slot))
      || run.attempts.some(a => a.billing !== slot.pin.billing)
      || !retentionTerminalMatches(slot, run, outcome.state) || !contextTerminalMatches(slot, run, outcome.state))
      throw new Error("canary-owner-terminal-identity-invalid");
    // Retain result/usage and the held-out grade, never an arbitrary transport Error or credential.
    const receipt = JSON.stringify({ slot, run, grade: outcome.grade, state: outcome.state, reason: outcome.reason });
    if (Buffer.byteLength(receipt, "utf8") > MAX_RECEIPT_BYTES) throw new Error("canary-owner-receipt-bound");
    const changed = this.db.prepare(`UPDATE canary_slots_v1 SET phase='terminal',receipt=?
      WHERE id=? AND binding=? AND owner=? AND phase='started' AND receipt IS NULL`).run(receipt, slot.id, identity, this.owner);
    if (changed.changes !== 1) throw new Error("canary-owner-terminal-not-owned");
  }

  /** Same durable row/store as every other canary; failed journaling retains ownership. */
  codingCheckpoint(slot: CanarySlot, checkpoint: CodingCheckpoint): void {
    codingSlotCase(slot);
    const identity = binding(slot), row = this.db.prepare(`SELECT receipt FROM canary_slots_v1
      WHERE id=? AND binding=? AND owner=? AND phase='started'`).get(slot.id, identity, this.owner);
    if (!row) throw new Error("coding-owner-checkpoint-not-owned");
    const prior = row.receipt === null ? null : JSON.parse(String(row.receipt));
    if (prior && prior.kind !== "canary-coding-lifecycle-v1") throw new Error("coding-owner-checkpoint-kind-invalid");
    validateCodingCheckpoint(checkpoint, prior?.checkpoint ?? null);
    const receipt = JSON.stringify({ kind: "canary-coding-lifecycle-v1", slot, checkpoint });
    if (Buffer.byteLength(receipt) > MAX_RECEIPT_BYTES) throw new Error("coding-owner-checkpoint-bound");
    const changed = this.db.prepare(`UPDATE canary_slots_v1 SET receipt=?
      WHERE id=? AND binding=? AND owner=? AND phase='started' AND receipt IS ?`).run(receipt, slot.id, identity, this.owner, row.receipt);
    if (changed.changes !== 1) throw new Error("coding-owner-checkpoint-conflict");
  }

  /** Only a positively cleaned execution can free this row. Behavior samples stay
   * explicitly unqualified, with no invented provider usage, CanaryRun or efficacy. */
  codingTerminal(slot: CanarySlot, outcome: { state: "complete" | "refused" | "unavailable"; passed: boolean | null;
    reason: string; cleanup?: "confirmed" | "unknown"; executorQualified: false; resourceEvidence: null }): void {
    codingSlotCase(slot);
    const identity = binding(slot), row = this.db.prepare(`SELECT receipt FROM canary_slots_v1
      WHERE id=? AND binding=? AND owner=? AND phase='started'`).get(slot.id, identity, this.owner);
    if (!row || row.receipt === null) throw new Error("coding-owner-terminal-not-owned-or-checkpointed");
    const prior = JSON.parse(String(row.receipt));
    if (prior.kind !== "canary-coding-lifecycle-v1" || prior.checkpoint?.phase !== "cleanup-confirmed"
      || outcome.cleanup !== "confirmed" || outcome.executorQualified !== false || outcome.resourceEvidence !== null
      || !["complete", "refused", "unavailable"].includes(outcome.state)
      || (outcome.state === "complete" ? typeof outcome.passed !== "boolean" : outcome.passed !== null)
      || typeof outcome.reason !== "string" || outcome.reason.length > 512)
      throw new Error("coding-owner-terminal-unproven");
    const receipt = JSON.stringify({ ...prior, outcome: { state: outcome.state, passed: outcome.passed, reason: outcome.reason,
      cleanup: "confirmed", executorQualified: false, resourceEvidence: null, scope: "unregistered-mechanics-only" } });
    if (Buffer.byteLength(receipt) > MAX_RECEIPT_BYTES) throw new Error("coding-owner-terminal-bound");
    const changed = this.db.prepare(`UPDATE canary_slots_v1 SET phase='terminal',receipt=?
      WHERE id=? AND binding=? AND owner=? AND phase='started' AND receipt IS ?`).run(receipt, slot.id, identity, this.owner, row.receipt);
    if (changed.changes !== 1) throw new Error("coding-owner-terminal-conflict");
  }

  close(): void { this.db.close(); }
}
