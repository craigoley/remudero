import { benchmarkRunLedgerLogger } from "#src/run-task.js";
export { benchmarkRunLedgerLogger };

type Row = Record<string, unknown>;

const ASSIGNMENT = {
  id: "assignment-1",
  requested: { provider: "anthropic", model: "claude-opus-5-5" },
  selected: { provider: "anthropic", model: "claude-opus-5-5" },
};

const DAY_START = Date.parse("2026-11-10T01:00:00.000Z");

/** One run's rows through the real run logger, each stamped with the run id and a clock a minute apart. */
export function runLog(runId: string, startMs = DAY_START): { log: (step: string, extra?: Row) => void; rows: Row[] } {
  const rows: Row[] = [];
  let at = startMs;
  const log = benchmarkRunLedgerLogger((step, fields) => {
    rows.push({ ts: new Date(at).toISOString(), run_id: runId, task_id: "W1-T1", step, ...fields });
    at += 60_000;
  });
  return { log, rows };
}

/** A run that assigned a worker and ended `failed` ten minutes after its start. */
export function assignedRun(runId: string, startMs = DAY_START): Row[] {
  const { log, rows } = runLog(runId, startMs);
  log("run.start", { type: "implement" });
  log("run.phase", { waiting_on: "recon" });
  log("worker.assignment", { worker_assignment: ASSIGNMENT });
  log("verdict", { verdict: "failed", stage: "run.error", reason: "boom" });
  return rows;
}
