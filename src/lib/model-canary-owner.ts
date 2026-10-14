/** Durable canary ownership. No provider execution, stale-claim reclamation or schedule activation. */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, realpathSync, lstatSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CanarySlot, CanarySchedulePorts } from "./model-canary-schedule.js";
import { retentionSlotTurnBound, retentionTerminalMatches } from "./model-canary-retention-schedule.js";
import { contextSlotCallBound, contextTerminalMatches } from "./model-canary-context-schedule.js";

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

  terminal(slot: CanarySlot, outcome: Outcome): void {
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
      WHERE id=? AND binding=? AND owner=? AND phase='started'`).run(receipt, slot.id, identity, this.owner);
    if (changed.changes !== 1) throw new Error("canary-owner-terminal-not-owned");
  }

  close(): void { this.db.close(); }
}
