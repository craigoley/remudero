import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./fs-race-safe.js";
import type { Task } from "./plan.js";

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
 * rather than dispatching a second repair lane. That escalation is terminal for the unchanged
 * verdict: later reads are held rather than escalating again. A task whose verdict CHANGES
 * between refusals is PROGRESS, not a repeat, and is treated exactly like a first-ever refusal.
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
 *  it, and how many times that EXACT verdict has now been seen in a row. `escalated` is optional
 *  only for compatibility with records written before terminal escalation was persisted; every
 *  new record writes it explicitly. */
export interface PriorRefusal {
  verdict: string;
  attempts: number;
  escalated?: boolean;
  /** W1-T3959: the parsed admission/linter contract that earned a terminal hold. Absent is a
   * legacy record, never evidence that the current task was already handled. */
  preDispatchContractRevision?: string;
}

/** BACKSTOP: bounds one selection pass's state materialization, never normal admission. Entries
 * beyond this ceiling fail open: a missing observation can spend a zero-cost lint attempt, while
 * a fabricated held state could silently suppress real work. */
export const MAX_TERMINAL_PRE_DISPATCH_REFUSALS = 256;

/** Stable JSON for the small, parsed contract below. Object keys sort; array order remains part of
 * the revision because linter inputs such as acceptance criteria are ordered. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

/**
 * The one durable identity for "has this task's deterministic admission contract changed?".
 * `sourcePath` varies between the daemon's parsed plan and a temporary `runTask` copy. Every
 * other parsed field is deliberately included: even a field that looks administrative can affect
 * selector admission today or become a deterministic-linter input later. That conservative shape
 * makes a corrected contract earn exactly one re-offer instead of silently inheriting an old hold.
 */
export function preDispatchContractRevision(task: Task): string {
  const { sourcePath: _sourcePath, ...contract } = task;
  return `pre-dispatch-v1:${createHash("sha256").update(stableJson(contract)).digest("hex")}`;
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
  | { kind: "escalate"; taskId: string; verdict: string; attempts: number }
  | { kind: "held"; taskId: string; verdict: string; attempts: number };

/**
 * THE PURE DECISION (rationale, W1-T3657 "THE SHAPE"). No prior refusal recorded for this task,
 * OR a prior refusal recorded with a DIFFERENT verdict, dispatches one repair lane. A prior
 * refusal recorded with the IDENTICAL verdict escalates instead of dispatching a second one —
 * "the second refusal of the same task with the same verdict" the rationale names. Once that
 * escalation is recorded, the same verdict is held with its original attempt count. Old records
 * without `escalated` are deliberately treated as not-yet-terminal, so their next identical
 * refusal still earns the one escalation.
 */
export function decideRepairDispatch(taskId: string, verdict: string, prior: PriorRefusal | undefined): RepairDispatchAction {
  if (prior === undefined || prior.verdict !== verdict) {
    return { kind: "dispatch_repair", taskId, verdict, progress: prior !== undefined };
  }
  if (prior.escalated === true) {
    return { kind: "held", taskId, verdict, attempts: prior.attempts };
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
      typeof (raw as { attempts?: unknown }).attempts === "number" &&
      (typeof (raw as { escalated?: unknown }).escalated === "undefined" ||
        typeof (raw as { escalated?: unknown }).escalated === "boolean") &&
      (typeof (raw as { preDispatchContractRevision?: unknown }).preDispatchContractRevision === "undefined" ||
        (typeof (raw as { preDispatchContractRevision?: unknown }).preDispatchContractRevision === "string" &&
          (raw as { preDispatchContractRevision: string }).preDispatchContractRevision.length > 0))
    ) {
      return {
        verdict: (raw as { verdict: string }).verdict,
        attempts: (raw as { attempts: number }).attempts,
        escalated: (raw as { escalated?: boolean }).escalated === true,
        ...(typeof (raw as { preDispatchContractRevision?: unknown }).preDispatchContractRevision === "string"
          ? { preDispatchContractRevision: (raw as { preDispatchContractRevision: string }).preDispatchContractRevision }
          : {}),
      };
    }
    return undefined; // present but not this shape: read as "never refused before".
  } catch {
    return undefined; // absent or corrupt: read as "never refused before", per this file's own doc.
  }
}

/**
 * Read terminal records once per daemon selection pass. The directory itself is the bounded index:
 * no ledger scan and no failed open per plan task. A missing, unreadable, corrupt, legacy or
 * over-cap record is absent from the result, deliberately re-offering work rather than suppressing
 * it on an assumption.
 */
export function terminalPreDispatchRefusalRevisions(stateRoot: string): ReadonlyMap<string, string> {
  let entries: string[];
  try {
    entries = readdirSync(join(stateRoot, "dispatch-repair"))
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .slice(0, MAX_TERMINAL_PRE_DISPATCH_REFUSALS);
  } catch {
    // Deliberate: a missing or unreadable state directory is not evidence that any task was held,
    // so this reader returns no suppressions rather than manufacturing a terminal refusal.
    return new Map();
  }
  const out = new Map<string, string>();
  for (const entry of entries) {
    const taskId = entry.slice(0, -".json".length);
    const prior = readPriorRefusal(stateRoot, taskId);
    if (prior?.escalated === true && prior.preDispatchContractRevision) out.set(taskId, prior.preDispatchContractRevision);
  }
  return out;
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
 * prior refusal, drives exactly ONE of `dispatchRepairLane`/`escalate` — or neither for a held
 * decision — and persists the decision as the next prior record so the NEXT refusal is judged
 * against it. A held decision does not rewrite the record or invoke either side effect.
 */
export function repairRefusedTask(
  taskId: string,
  violations: readonly RefusalViolation[],
  readPrior: (taskId: string) => PriorRefusal | undefined,
  writePrior: (taskId: string, prior: PriorRefusal) => void,
  dispatchRepairLane: (input: { taskId: string; verdict: string; progress: boolean }) => void,
  escalate: (input: { taskId: string; verdict: string; attempts: number }) => void,
  currentPreDispatchContractRevision?: string,
): RepairDispatchAction {
  const verdict = refusalVerdictText(violations);
  const prior = readPrior(taskId);
  const action = decideRepairDispatch(taskId, verdict, prior);
  if (action.kind === "dispatch_repair") {
    dispatchRepairLane({ taskId, verdict, progress: action.progress });
    writePrior(taskId, { verdict, attempts: 1, escalated: false, ...(currentPreDispatchContractRevision ? { preDispatchContractRevision: currentPreDispatchContractRevision } : {}) });
  } else if (action.kind === "escalate") {
    escalate({ taskId, verdict, attempts: action.attempts });
    writePrior(taskId, { verdict, attempts: action.attempts, escalated: true, ...(currentPreDispatchContractRevision ? { preDispatchContractRevision: currentPreDispatchContractRevision } : {}) });
  } else if (prior && currentPreDispatchContractRevision && prior.preDispatchContractRevision !== currentPreDispatchContractRevision) {
    // A legacy record or a corrected task earns exactly one re-offer. If the re-offer reaches this
    // terminal same-verdict hold, advance only the identity; never dispatch, repair or escalate again.
    writePrior(taskId, { ...prior, preDispatchContractRevision: currentPreDispatchContractRevision });
  }
  return action;
}
