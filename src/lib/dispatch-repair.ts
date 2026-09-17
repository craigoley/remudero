import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./fs-race-safe.js";

/**
 * A TASK THE PRE-DISPATCH LINTER REFUSES IS REPAIRED, NOT RE-ATTEMPTED FOREVER (W1-T3657).
 *
 * MEASURED (rationale): 1,232 refusals of one already-shipped task in 10.4 hours, and a second
 * fleet with ZERO dispatchable tasks for the same reason — the pre-dispatch linter
 * (`assertLintClean`, `src/lib/task-linter.ts`) is deterministic, so re-attempting a refused
 * task on the next tick reaches the IDENTICAL verdict every time, forever. No strike is spent,
 * no escalation is raised, no operator is told, and the record is never touched.
 *
 * THE SHAPE: on a refusal, dispatch ONE repair lane carrying the linter's own verdict text
 * VERBATIM (never a paraphrase or a generic prompt — the repair lane must repair the STATED
 * defect). A second refusal of the SAME task with the SAME verdict escalates to the operator
 * rather than dispatching a second repair lane. A task whose verdict CHANGES between refusals
 * is PROGRESS, not a repeat, and is treated exactly like a first-ever refusal.
 *
 * THIS MODULE IS DELIBERATELY PURE AT ITS CORE ({@link decideRepairDispatch}): no spawn, no
 * ledger write, no GitHub call. The one entry point real callers reach for
 * ({@link repairRefusedTask}) receives its callbacks from `run-task.ts`'s composition root, so a
 * unit test can assert on calls without a real worker or a real issue, and `src/run-task.ts`'s
 * §5C pre-dispatch guard (the ONE call site that prints the refusal today, MASTER-PLAN §5C)
 * can drive the real thing through the same function.
 */

/** One violation the pre-dispatch linter reported — `task-linter.ts`'s own `TaskLintError`
 *  shape. This module never re-derives or inspects the linter itself, only the text it
 *  already produced. */
export interface RefusalViolation {
  check: string;
  message: string;
}

/**
 * Canonical, VERBATIM text of a pre-dispatch refusal. Deterministic and order-preserving: the
 * SAME violations, in the SAME order, always render the SAME string — which is what lets
 * {@link decideRepairDispatch} tell "the same refusal, again" from "a changed verdict" by plain
 * string equality, and what lets the repair lane's prompt BE this string rather than a
 * paraphrase (the rationale's "carries the linter's own verdict text" requirement).
 */
export function refusalVerdictText(violations: readonly RefusalViolation[]): string {
  return violations.map((v) => `[${v.check}] ${v.message}`).join("\n");
}

/** The ONLY state threaded across dispatches of one task: the verdict text last recorded for
 *  it, and how many times that EXACT verdict has now been seen in a row. */
export interface PriorRefusal {
  verdict: string;
  attempts: number;
}

export type RepairDispatchAction =
  | {
      kind: "dispatch_repair";
      taskId: string;
      verdict: string;
      /** True when a DIFFERENT verdict was previously recorded for this task — the changed-
       *  verdict case is progress, not a repeat, but it still dispatches exactly one repair
       *  lane, same as a genuinely first-ever refusal. */
      progress: boolean;
    }
  | { kind: "escalate"; taskId: string; verdict: string; attempts: number };

/**
 * THE PURE DECISION (rationale, W1-T3657 "THE SHAPE"). No prior refusal recorded for this task,
 * OR a prior refusal recorded with a DIFFERENT verdict, dispatches one repair lane. A prior
 * refusal recorded with the IDENTICAL verdict escalates instead of dispatching a second one —
 * "the second refusal of the same task with the same verdict" the rationale names.
 */
export function decideRepairDispatch(taskId: string, verdict: string, prior: PriorRefusal | undefined): RepairDispatchAction {
  if (prior === undefined || prior.verdict !== verdict) {
    return { kind: "dispatch_repair", taskId, verdict, progress: prior !== undefined };
  }
  return { kind: "escalate", taskId, verdict, attempts: prior.attempts + 1 };
}

/** Where {@link readPriorRefusal}/{@link writePriorRefusal} persist ONE task's most recently
 *  recorded refusal — the only memory a later `runTask` tick (possibly a different process, a
 *  different host) has of "did this exact verdict already get a repair lane". One small file
 *  per task under `<stateRoot>/dispatch-repair/`, mirroring the per-task inflight-lock
 *  convention (`state/inflight/<taskId>.lock`) rather than a growing ledger scan. */
function priorRefusalPath(stateRoot: string, taskId: string): string {
  return join(stateRoot, "dispatch-repair", `${taskId}.json`);
}

/** Best-effort read (mirrors `deployer.ts`'s `restartPressureState` discipline): a missing or
 *  corrupt file reads as "no prior refusal recorded", never a thrown error — a refusal-repair
 *  loop must never itself become a reason dispatch cannot proceed. */
export function readPriorRefusal(stateRoot: string, taskId: string): PriorRefusal | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(priorRefusalPath(stateRoot, taskId), "utf8"));
    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as { verdict?: unknown }).verdict === "string" &&
      typeof (raw as { attempts?: unknown }).attempts === "number"
    ) {
      return { verdict: (raw as { verdict: string }).verdict, attempts: (raw as { attempts: number }).attempts };
    }
    return undefined; // present but not this shape: read as "never refused before".
  } catch {
    return undefined; // absent or corrupt: read as "never refused before", per this file's own doc.
  }
}

/** Durable, atomic write of the ONE refusal record this module reads back on the next tick. */
export function writePriorRefusal(stateRoot: string, taskId: string, prior: PriorRefusal): void {
  writeAtomic(priorRefusalPath(stateRoot, taskId), JSON.stringify(prior, null, 2));
}

/**
 * THE ONE ENTRY POINT the §5C pre-dispatch guard's `blocked_illformed` catch calls
 * (`src/run-task.ts`, reachable from the dispatch path that prints the refusal today —
 * acceptance criterion 5). The run-task composition root supplies the four side effects; this
 * module owns only the refusal decision. That keeps the repair path on the existing runTask
 * boundary instead of adding a second `*Deps` seam solely for this feature. It reads this task's
 * prior refusal, drives exactly ONE of `dispatchRepairLane`/`escalate` — never both, never
 * neither — and persists the decision as the next prior record so the NEXT refusal is judged
 * against it.
 */
export function repairRefusedTask(
  taskId: string,
  violations: readonly RefusalViolation[],
  readPrior: (taskId: string) => PriorRefusal | undefined,
  writePrior: (taskId: string, prior: PriorRefusal) => void,
  dispatchRepairLane: (input: { taskId: string; verdict: string; progress: boolean }) => void,
  escalate: (input: { taskId: string; verdict: string; attempts: number }) => void,
): RepairDispatchAction {
  const verdict = refusalVerdictText(violations);
  const prior = readPrior(taskId);
  const action = decideRepairDispatch(taskId, verdict, prior);
  if (action.kind === "dispatch_repair") {
    dispatchRepairLane({ taskId, verdict, progress: action.progress });
    writePrior(taskId, { verdict, attempts: 1 });
  } else {
    escalate({ taskId, verdict, attempts: action.attempts });
    writePrior(taskId, { verdict, attempts: action.attempts });
  }
  return action;
}
