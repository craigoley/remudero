/** Bounded private projection in the sole collector's existing ledger scan. */
import { ciRemedyExecutionOf, ciRemedyExecutionReport } from "./ci-remedy-execution.js";
import { projectRepairCostContext } from "./repair-cost-evidence.js";

export const CI_REMEDY_OBSERVER_MAX_ROWS = 4096;
export const CI_REMEDY_OBSERVER_MAX_BYTES = 2 * 1024 * 1024;
const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const text = (v: unknown, max = 160): string | null => typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
const timestamp = (v: unknown): string | null =>
  typeof v === "string" && v.length <= 80 && Number.isFinite(Date.parse(v)) ? v : null;

function project(row: Record<string, unknown>) {
  if (!["fix.remedy_path_execution", "worker.assignment", "worker.attempt"].includes(String(row.step))) return undefined;
  const repair = projectRepairCostContext(row);
  // Keep fix terminals even without execution evidence: dropping one could hide a conflicting end.
  if (row.step !== "fix.remedy_path_execution" && repair.rung !== "fix"
    && !Object.hasOwn(row, "prevention_execution")) return undefined;
  const assignment = object(row.worker_assignment);
  return { step: String(row.step), ts: timestamp(row.ts), host: text(row.host), runId: text(row.run_id),
    assignmentId: text(assignment?.id) ?? text(row.selection_assignment_id),
    success: typeof row.success === "boolean" ? row.success : null,
    repair: { ...repair, repo: text(repair.repo, 320), roundId: text(repair.roundId),
      workerRunId: text(repair.workerRunId), rung: text(repair.rung) },
    remedyExecution: ciRemedyExecutionOf(row.prevention_execution) };
}

/** No second ledger read/store. Encoded retained payload and row bounds are separate from RSS.
 * On lost evidence, retain invocation observations and withhold qualified later-work joins. */
export function ciRemedyExecutionObserver(asOf: string, windowStart: string, limits = {
  maxRows: CI_REMEDY_OBSERVER_MAX_ROWS, maxBytes: CI_REMEDY_OBSERVER_MAX_BYTES,
}) {
  if (!Number.isSafeInteger(limits.maxRows) || limits.maxRows < 1 || limits.maxRows > CI_REMEDY_OBSERVER_MAX_ROWS
    || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || limits.maxBytes > CI_REMEDY_OBSERVER_MAX_BYTES)
    throw new RangeError("component observer limits must stay within the retained resource contract");
  const validWindow = timestamp(asOf) !== null && timestamp(windowStart) !== null
    && Date.parse(windowStart) <= Date.parse(asOf);
  const rows: NonNullable<ReturnType<typeof project>>[] = [];
  let retainedBytes = 0, omittedRows = 0;
  return {
    observe(raw: Record<string, unknown>) {
      if (!validWindow || timestamp(raw.ts) === null || Date.parse(String(raw.ts)) < Date.parse(windowStart)
        || Date.parse(String(raw.ts)) > Date.parse(asOf)) return;
      const row = project(raw);
      if (row === undefined) return;
      const bytes = Buffer.byteLength(JSON.stringify(row), "utf8");
      if (rows.length >= limits.maxRows || retainedBytes + bytes > limits.maxBytes) { omittedRows++; return; }
      rows.push(row); retainedBytes += bytes;
    },
    report(scanComplete: boolean) {
      const complete = validWindow && scanComplete && omittedRows === 0;
      const reason = !validWindow ? "invalid-observation-window" : omittedRows > 0
        ? "component-evidence-retention-bound" : !scanComplete ? "component-source-incomplete" : undefined;
      const report = ciRemedyExecutionReport(rows, asOf);
      return { ...report, ...(reason ? { state: report.records.length ? "observed-partial" : "unavailable", reason } : {}),
        records: report.records.map(item => complete ? item : { ...item,
          laterWork: { state: "unavailable" as const, reason: reason! } }),
        evidence: { scope: "daily-window-existing-union", scanComplete: complete, sourceScanComplete: scanComplete,
          retainedRows: rows.length, retainedBytes, omittedRows, rowLimit: limits.maxRows, byteLimit: limits.maxBytes,
          encoding: "utf8-projected-json", history: "unavailable-retention-uncertified" },
        efficacyClaim: "none" as const };
    },
  };
}
