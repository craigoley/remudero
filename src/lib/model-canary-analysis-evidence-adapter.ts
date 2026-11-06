/** Read terminal canary receipts from an existing owner database without creating or mutating it. */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { assertExistingCanaryOwnerV1 } from "./model-canary-owner.js";
import { fixedClock } from "./clock.js";
import type { CanaryRun } from "./model-canary-metrics.js";
import type { CanarySlot } from "./model-canary-schedule.js";

export interface NativeAnalysisReceiptV1 {
  slot: CanarySlot;
  run: CanaryRun;
  grade: { passed: boolean; reason: string; schemaValid: boolean } | null;
  executionWindow: { startedAt: string; completedAt: string } | null;
  state: "scored" | "unavailable";
}
export type NativeAnalysisEvidenceResultV1 =
  | { state: "available"; evidence: { version: "native-canary-analysis-evidence-v1"; private: true;
      receipts: readonly NativeAnalysisReceiptV1[] } }
  | { state: "unavailable"; reason: string };
const MAX_ROWS = 100_000, MAX_RECEIPT_BYTES = 128 * 1024, MAX_TOTAL_RECEIPT_BYTES = 64 * 1024 * 1024;
function canaryAnalysisRecord(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === "object" && !Array.isArray(v); }
export function nativeAnalysisEvidenceWithinBounds(rows: number, totalBytes: number): boolean {
  return Number.isSafeInteger(rows) && rows >= 0 && rows <= MAX_ROWS
    && Number.isSafeInteger(totalBytes) && totalBytes >= 0 && totalBytes <= MAX_TOTAL_RECEIPT_BYTES;
}
function projectCanaryAnalysisReceipt(raw: unknown): NativeAnalysisReceiptV1 {
  if (!canaryAnalysisRecord(raw) || !canaryAnalysisRecord(raw.slot) || !canaryAnalysisRecord(raw.run)) throw new Error("native-analysis-receipt-invalid");
  const slot = raw.slot, run = raw.run;
  if (typeof slot.id !== "string" || typeof slot.caseId !== "string" || !canaryAnalysisRecord(slot.pin)
    || typeof slot.pin.model !== "string" || typeof slot.pin.route !== "string"
    || typeof slot.pin.effort !== "string" || typeof slot.pin.suiteHash !== "string"
    || !["api", "subscription"].includes(String(slot.pin.billing))
    || typeof run.id !== "string" || typeof run.caseId !== "string" || typeof run.suiteHash !== "string"
    || typeof run.model !== "string" || typeof run.route !== "string" || typeof run.effort !== "string"
    || !Array.isArray(run.attempts) || !(run.verified === null || typeof run.verified === "boolean"))
    throw new Error("native-analysis-receipt-invalid");
  const gradeRaw = raw.grade;
  const grade = gradeRaw === null ? null : canaryAnalysisRecord(gradeRaw) && typeof gradeRaw.passed === "boolean"
    && typeof gradeRaw.reason === "string" && typeof gradeRaw.schemaValid === "boolean"
    ? { passed: gradeRaw.passed, reason: gradeRaw.reason, schemaValid: gradeRaw.schemaValid } : null;
  if (gradeRaw !== null && grade === null) throw new Error("native-analysis-grade-invalid");
  const timestamp = (value: unknown): value is string => typeof value === "string"
    && Number.isFinite(Date.parse(value)) && fixedClock(Date.parse(value)).iso() === value;
  let executionWindow: NativeAnalysisReceiptV1["executionWindow"] = null;
  if (run.executionWindow !== undefined) {
    if (!canaryAnalysisRecord(run.executionWindow) || Object.keys(run.executionWindow).sort().join("\0") !== "completedAt\0startedAt"
      || !timestamp(run.executionWindow.startedAt) || !timestamp(run.executionWindow.completedAt)
      || Date.parse(run.executionWindow.startedAt) > Date.parse(run.executionWindow.completedAt))
      throw new Error("native-analysis-execution-window-invalid");
    executionWindow = { startedAt: run.executionWindow.startedAt, completedAt: run.executionWindow.completedAt };
  }
  const safeRun = {
    id: run.id, caseId: run.caseId, suiteHash: run.suiteHash, model: run.model, route: run.route,
    effort: run.effort, family: run.family, executionSource: run.executionSource,
    verified: run.verified, totalDurationMs: run.totalDurationMs, attempts: run.attempts,
    ...(run.sourceActivity === undefined ? {} : { sourceActivity: run.sourceActivity }),
    ...(run.outcomeReason === undefined ? {} : { outcomeReason: run.outcomeReason }),
    ...(run.retention === undefined ? {} : { retention: run.retention }),
    ...(run.contextProfile === undefined ? {} : { contextProfile: run.contextProfile }),
    ...(run.trial === undefined ? {} : { trial: run.trial }),
  } as CanaryRun;
  const state = raw.state === "scored" ? "scored" : raw.state === "unavailable" ? "unavailable" : null;
  if (state === null) throw new Error("native-analysis-state-invalid");
  return { slot: raw.slot as unknown as CanarySlot, run: safeRun, grade, executionWindow, state };
}
export function createAnalysisEvidenceReader(privateDirectory: string): () => NativeAnalysisEvidenceResultV1 {
  return () => {
    let db: DatabaseSync | undefined;
    try {
      assertExistingCanaryOwnerV1(privateDirectory);
      db = new DatabaseSync(join(privateDirectory, "model-canary-slots.sqlite"), { readOnly: true, timeout: 5_000 });
      const stats = db.prepare("SELECT COUNT(*) AS rows, COALESCE(SUM(length(CAST(receipt AS BLOB))),0) AS bytes FROM canary_slots_v1 WHERE phase='terminal'")
        .get() as { rows?: unknown; bytes?: unknown };
      if (typeof stats.rows !== "number" || typeof stats.bytes !== "number"
        || !nativeAnalysisEvidenceWithinBounds(stats.rows, stats.bytes))
        return { state: "unavailable", reason: "native-analysis-receipt-corpus-bound" };
      const rows = db.prepare("SELECT phase,receipt FROM canary_slots_v1 WHERE phase='terminal' ORDER BY id LIMIT ?")
        .all(MAX_ROWS + 1) as Array<{ phase?: unknown; receipt?: unknown }>;
      if (rows.length > MAX_ROWS) return { state: "unavailable", reason: "native-analysis-receipt-bound" };
      const receipts = rows.map(row => {
        if (row.phase !== "terminal" || typeof row.receipt !== "string"
          || Buffer.byteLength(row.receipt, "utf8") > MAX_RECEIPT_BYTES) throw new Error("native-analysis-receipt-invalid");
        return projectCanaryAnalysisReceipt(JSON.parse(row.receipt));
      });
      if (!receipts.length) return { state: "unavailable", reason: "native-analysis-no-terminal-receipts" };
      return { state: "available", evidence: { version: "native-canary-analysis-evidence-v1", private: true, receipts } };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { state: "unavailable", reason: error instanceof Error
        && (error.message.startsWith("canary-owner-") || error.message.startsWith("native-analysis-"))
        ? error.message : code === "ENOENT" ? "canary-owner-db-not-private" : "native-analysis-owner-unreadable" };
    } finally { db?.close(); }
  };
}
