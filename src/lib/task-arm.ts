import { createHash } from "node:crypto";

/**
 * W1-T14137: a withheld-arm draw keyed on the TASK, never the run. A run id is per attempt
 * (`<task>-<ms>` on the implement lane, the pass-wide `SWEEP-<ms>` on a sweep's fix rounds), so a
 * per-run draw put one task's runs in different arms and every task of one sweep pass in the same one,
 * and the task's single outcome could not be credited to one arm. Routing experiments fixed the same
 * leak the same way (W1-T4617).
 *
 * INVARIANT task-arm-stable: every run of one task, from any lane, draws the same arm for the same unit
 * and epoch. The draw is pure: nothing but its four inputs decides it, so a ledger row's assignment is
 * recomputable from the row alone.
 */

/** The hash domain. Changing the formula is a new version, never an edit of this one. */
const TASK_ARM_DOMAIN = "task-arm/v1";

/** The `arm_unit` a row drawn by {@link taskArmWithheld} records: the unit of randomization is the task. */
export const TASK_ARM_UNIT = "task";

/** The epoch the skill-withholding draw uses. A row without `arm_unit` was drawn per run, before this epoch. */
export const SKILL_ARM_EPOCH = "skill-withholding-v1";

export interface TaskArmDraw {
  /** The task the arm belongs to: every run of it, from any lane, draws the same arm. */
  taskId: string;
  /** What is withheld, e.g. a skill name; units draw independently of each other. */
  unit: string;
  /** Predeclared share of tasks withheld, in [0, 1]. */
  share: number;
  /** A new epoch redraws every task, so a redesigned experiment never inherits an old assignment. */
  epoch: string;
}

/** True when `taskId` falls in the withheld arm: the first 4 bytes of the draw's sha256 over 2^32, below `share`. */
export function taskArmWithheld({ taskId, unit, share, epoch }: TaskArmDraw): boolean {
  const digest = createHash("sha256").update([TASK_ARM_DOMAIN, epoch, unit, taskId].join("\0")).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000 < share;
}
