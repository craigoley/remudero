import { unknownArgError } from "./cli-args.js";
import { appendLedger, type LedgerLine } from "./ledger.js";
import { automergeHoldFromLedger, type AutomergeHold } from "./review.js";
import { readLedgerLines } from "./status.js";

export type OperatorMergeHoldAction = "engage" | "release";

export interface OperatorMergeHoldInput {
  action: OperatorMergeHoldAction;
  by: string;
  reason: string;
  /** Omitted means the whole fleet. */
  prNumber?: number;
  /** Optional board enrichment. The hold decision itself is scoped by prNumber, never this id. */
  taskId?: string;
}

export type ParsedOperatorMergeHold =
  | { ok: true; input: OperatorMergeHoldInput }
  | { ok: false; error: string };

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Strict, side-effect-free parser for `rmd merge-hold`. */
export function parseOperatorMergeHoldArgs(args: string[]): ParsedOperatorMergeHold {
  const action = args[0];
  if (action !== "engage" && action !== "release") {
    return { ok: false, error: "the first argument must be `engage` or `release`" };
  }

  const tail = args.slice(1);
  const unknown = unknownArgError("merge-hold", tail, ["--pr", "--task", "--by", "--reason"]);
  if (unknown) return { ok: false, error: unknown };

  const by = flagValue(tail, "--by")?.trim();
  if (!by || by.startsWith("--")) return { ok: false, error: "--by <name> is required" };
  const reason = flagValue(tail, "--reason")?.trim();
  if (!reason || reason.startsWith("--")) return { ok: false, error: "--reason <text> is required" };

  const prRaw = flagValue(tail, "--pr");
  let prNumber: number | undefined;
  if (prRaw !== undefined) {
    prNumber = Number(prRaw);
    if (!/^\d+$/.test(prRaw) || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
      return { ok: false, error: `--pr must be a positive integer, got ${JSON.stringify(prRaw)}` };
    }
  }

  const taskId = flagValue(tail, "--task")?.trim();
  if (taskId && !/^W1-T\d+$/.test(taskId)) {
    return { ok: false, error: `--task must be a W1-T<n> id, got ${JSON.stringify(taskId)}` };
  }
  if (taskId && prNumber === undefined) {
    return { ok: false, error: "--task is valid only with a PR-scoped hold (`--pr <n>`)" };
  }

  return {
    ok: true,
    input: {
      action,
      by,
      reason,
      ...(prNumber !== undefined ? { prNumber } : {}),
      ...(taskId ? { taskId } : {}),
    },
  };
}

export interface OperatorMergeHoldResult {
  action: OperatorMergeHoldAction;
  scope: string;
  written: boolean;
  prior?: AutomergeHold;
  current?: AutomergeHold;
}

export interface OperatorMergeHoldDeps {
  readLedger?: (path: string) => Array<Record<string, unknown>>;
  appendLedger?: (path: string, line: LedgerLine) => void;
  now?: () => number;
}

/**
 * Append one durable operator decision and read it back through the same production reader every
 * arm site uses. A release of an already-clear scope is an idempotent no-op, not a misleading row.
 */
export function applyOperatorMergeHold(
  ledgerPath: string,
  input: OperatorMergeHoldInput,
  deps: OperatorMergeHoldDeps = {},
): OperatorMergeHoldResult {
  const read = deps.readLedger ?? ((path: string) => readLedgerLines(path));
  const append = deps.appendLedger ?? appendLedger;
  const scopeProbe = input.prNumber ?? -1;
  const scope = input.prNumber === undefined ? "the whole fleet" : `PR #${input.prNumber}`;
  const prior = automergeHoldFromLedger(read(ledgerPath), scopeProbe);

  if (input.action === "release" && !prior) {
    return { action: input.action, scope, written: false };
  }

  const step = input.action === "engage" ? "automerge.hold_engaged" : "automerge.hold_released";
  append(ledgerPath, {
    run_id: `OPERATOR-MERGE-HOLD-${(deps.now ?? Date.now)()}`,
    task_id: input.taskId ?? (input.prNumber === undefined ? "FLEET" : `PR-${input.prNumber}`),
    step,
    lane: "operator",
    by: input.by,
    reason: input.reason,
    ...(input.prNumber !== undefined ? { pr_number: input.prNumber } : {}),
  });

  const current = automergeHoldFromLedger(read(ledgerPath), scopeProbe);
  const expected = input.action === "engage" ? { by: input.by, reason: input.reason } : undefined;
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error(
      `merge-hold write did not become the current decision for ${scope}; requested=${JSON.stringify(expected)} observed=${JSON.stringify(current)}`,
    );
  }

  return { action: input.action, scope, written: true, prior, current };
}
