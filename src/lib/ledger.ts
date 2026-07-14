import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Minimal append-only NDJSON ledger (MASTER-PLAN §9). W1-T6 expands this into
 * the full metering surface (tokens, effort, billing_mode, brain-plane calls);
 * for the proto-runner it records the loop's step timeline, keyed by task id, so
 * a run's provenance is inspectable after the fact. Every line is one JSON object.
 * `ts` is stamped here at write time.
 */
export interface LedgerLine {
  run_id: string;
  task_id: string;
  step: string;
  [k: string]: unknown;
}

export function appendLedger(path: string, line: LedgerLine): void {
  mkdirSync(dirname(path), { recursive: true });
  const record = { ts: new Date().toISOString(), ...line };
  appendFileSync(path, JSON.stringify(record) + "\n");
}
