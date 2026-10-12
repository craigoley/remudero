/**
 * #10470 (2026-10-09): a REST update-branch merged main into a PR at 21:15:15Z and no ledger row
 * said which path asked for it. Three writers call the endpoint — run-task's fix rung, the sweep's
 * refresh paths and the arm/direct-merge preflight — and only some of their callers ledgered after.
 * Every writer now writes this one `branch.update_requested` row itself, naming the caller (`via`),
 * the PR, the head it expected and what GitHub answered.
 */
import { loadConfig } from "./config.js";
import { appendLedger } from "./ledger.js";
import { ledgerPathFor } from "./ledger-path.js";

export const BRANCH_UPDATE_STEP = "branch.update_requested";

export interface BranchUpdateFields {
  repo: string;
  prNumber: number;
  /** Which path asked: the row's whole point. */
  via: string;
  expectedHeadSha?: string;
  outcome: string;
  error?: string;
}

export type BranchUpdateRecorder = (row: Record<string, unknown>) => void;

function recordToLiveLedger(row: Record<string, unknown>): void {
  try {
    appendLedger(ledgerPathFor(loadConfig()), { run_id: "branch-update", task_id: "SWEEP", ...row, step: BRANCH_UPDATE_STEP });
  } catch (error) {
    console.warn(`branch-update: the ${BRANCH_UPDATE_STEP} row could not be written: ${String((error as Error)?.message ?? error)}`);
  }
}

export function recordBranchUpdate(fields: BranchUpdateFields, record: BranchUpdateRecorder = recordToLiveLedger): void {
  record({
    step: BRANCH_UPDATE_STEP, repo: fields.repo, pr_number: fields.prNumber, via: fields.via,
    ...(fields.expectedHeadSha ? { expected_head_sha: fields.expectedHeadSha } : {}),
    outcome: fields.outcome, ...(fields.error ? { error: fields.error.split("\n")[0] } : {}),
  });
}
