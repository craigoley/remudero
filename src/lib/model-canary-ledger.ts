/** Bounded private coding receipts in the existing ledger; no additional collector or store. */
import { appendProducerLedger } from "./ledger.js";
import { projectCanaryRuns, type CanaryRun } from "./model-canary-metrics.js";
import { analyzeCanaryPairs } from "./model-canary-paired-analysis.js";
import type { CanaryExecutionPorts } from "./model-canary-runner.js";

export const CANARY_CODING_OBSERVED_STEP = "model_canary.coding_observed";
const MAX_RECEIPT_BYTES = 64 * 1024;
const identity = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128;

/** Keep only measurements/identities, never submissions, prompts, raw errors or extra SDK fields. */
export function codingRunReceipt(input: CanaryRun, maxBytes = MAX_RECEIPT_BYTES): CanaryRun {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RECEIPT_BYTES) throw new Error("canary-coding-ledger-byte-bound-invalid");
  if (!input || input.family !== "coding" || input.verified !== null
    || !["coding-parser", "coding-cleanup", "coding-accounting"].includes(input.caseId)
    || ![input.id, input.caseId, input.model, input.route, input.effort].every(identity)
    || !Array.isArray(input.attempts) || input.attempts.length > 1
    || input.attempts.some(a => !a || !identity(a.id) || a.billing !== "subscription" || a.usageRatedUsd !== null
      || (a.servedModel !== null && !identity(a.servedModel)))) throw new Error("canary-coding-ledger-contract-invalid");
  const run: CanaryRun = { id: input.id, caseId: input.caseId, suiteHash: input.suiteHash,
    model: input.model, route: input.route, effort: input.effort, family: "coding", verified: null,
    totalDurationMs: input.totalDurationMs, attempts: input.attempts.map(a => ({
      id: a.id, durationMs: a.durationMs, firstTextMs: a.firstTextMs, generationMs: a.generationMs,
      inputTokens: a.inputTokens, outputTokens: a.outputTokens, cacheReadTokens: a.cacheReadTokens,
      cacheWriteTokens: a.cacheWriteTokens, reasoningTokens: a.reasoningTokens, usageRatedUsd: null,
      billing: "subscription", servedModel: a.servedModel, terminal: a.terminal,
    })) };
  if (input.outcomeReason !== undefined) {
    if (typeof input.outcomeReason !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(input.outcomeReason)) throw new Error("canary-coding-ledger-reason-invalid");
    run.outcomeReason = input.outcomeReason;
  }
  if (input.trial !== undefined) {
    const t = input.trial;
    if (!t || !Array.isArray(t.plannedSlotIds)) throw new Error("canary-coding-ledger-trial-invalid");
    run.trial = { version: t.version, day: t.day, scheduleDigest: t.scheduleDigest, blockId: t.blockId,
      slotId: t.slotId, plannedSlotIds: [...t.plannedSlotIds], position: t.position, aaLabel: t.aaLabel };
  }
  projectCanaryRuns([run]);
  if (Buffer.byteLength(JSON.stringify(run), "utf8") > maxBytes) throw new Error("canary-coding-ledger-receipt-bound");
  return run;
}

/** The real ledger default must synchronize; an ambiguous write rejects and keeps slot ownership. */
export function codingLedgerSave(ledgerPath: string, write = appendProducerLedger): CanaryExecutionPorts["save"] {
  return async (input, grade) => {
    if (grade !== null) throw new Error("canary-coding-ledger-grade-unqualified");
    const run = codingRunReceipt(input);
    write(ledgerPath, "MODEL-CANARY", { run_id: run.id, step: CANARY_CODING_OBSERVED_STEP,
      canary_coding: { version: "canary-coding-ledger-v1", qualification: "unregistered-mechanics-only", run } }, { durable: true });
  };
}

export interface CodingLedgerObservation {
  version: string;
  scope: string;
  qualification: string;
  sourceScanComplete: boolean;
  state: "unavailable" | "observed-partial" | "observed";
  reasons: string[];
  rows: number; invalid: number; invalidErrorTypes: string[];
  duplicates: number; conflicts: number; omitted: number; retainedRuns: number; maxRuns: number;
  runDetails: CanaryRun[]; detailsOmitted: number;
  measurements: ReturnType<typeof projectCanaryRuns> | null;
  pairs: ReturnType<typeof analyzeCanaryPairs> | null;
  efficacyClaim: string;
}

/** Feed this from the sole collector's existing bounded union scan, before raw-row retention. */
export function codingLedgerObserver(maxRuns = 8192) {
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 8192) throw new Error("canary-coding-ledger-observer-bound");
  const runs = new Map<string, CanaryRun>();
  const invalidErrorTypes = new Set<string>();
  let rows = 0, invalid = 0, duplicates = 0, conflicts = 0, omitted = 0;
  return {
    observe(row: { step?: unknown; run_id?: unknown; task_id?: unknown; canary_coding?: unknown }) {
      if (row.step !== CANARY_CODING_OBSERVED_STEP) return;
      rows++;
      try {
        const envelope = row.canary_coding as { version?: unknown; qualification?: unknown; run?: CanaryRun } | undefined;
        if (!envelope || envelope.version !== "canary-coding-ledger-v1" || envelope.qualification !== "unregistered-mechanics-only"
          || !envelope.run || envelope.run.id !== row.run_id || row.task_id !== "MODEL-CANARY")
          throw new Error("canary-coding-ledger-envelope-invalid");
        const run = codingRunReceipt(envelope.run), prior = runs.get(run.id);
        if (prior) {
          if (JSON.stringify(prior) !== JSON.stringify(run)) conflicts++;
          else duplicates++;
        } else if (runs.size >= maxRuns) omitted++;
        else runs.set(run.id, run);
      } catch (error) {
        invalid++;
        const errorType = error instanceof Error && ["Error", "TypeError", "RangeError", "SyntaxError"].includes(error.name) ? error.name : "unknown";
        invalidErrorTypes.add(errorType);
        return { state: "invalid" as const, reason: "canary-coding-ledger-receipt-invalid", errorType };
      }
    },
    report(sourceObserved: boolean): CodingLedgerObservation {
      const reasons = [...(!sourceObserved ? ["ledger-source-incomplete"] : []), ...(invalid ? ["canary-receipt-invalid"] : []),
        ...(conflicts ? ["canary-receipt-conflicting"] : []), ...(omitted ? ["canary-receipt-row-bound"] : [])];
      const values = [...runs.values()];
      return { version: "canary-coding-observation-v1", scope: "private-observed-coding-receipts", qualification: "unregistered-mechanics-only",
        sourceScanComplete: sourceObserved, state: !sourceObserved && rows === 0 ? "unavailable" : reasons.length ? "observed-partial" : "observed", reasons,
        rows, invalid, invalidErrorTypes: [...invalidErrorTypes].sort(), duplicates, conflicts, omitted, retainedRuns: runs.size, maxRuns,
        runDetails: values.slice(0, 128), detailsOmitted: Math.max(0, values.length - 128),
        measurements: conflicts || (!sourceObserved && rows === 0) ? null : projectCanaryRuns(values),
        pairs: conflicts || (!sourceObserved && rows === 0) ? null : analyzeCanaryPairs(values), efficacyClaim: "none" };
    },
  };
}
