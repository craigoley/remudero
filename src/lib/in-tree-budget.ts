import { defaultProofTimeoutMs } from "./review.js";
import { readHostLoad, type HostLoad } from "./test-slot.js";
import { killProcessGroup } from "./worker-containment.js";

/**
 * A LOAD-SCALED BUDGET FOR ONE IN-TREE CHECK, AND THE GROUP KILL WHEN IT RUNS OUT.
 *
 * OBSERVED 2026-10-10 on the fleet host at load 30: the plan-PR preflight's unbounded `check-proof --base` leg held
 * the measurement cadence for 78 minutes, 66 of them in the `git reset --hard` under a `git worktree add`. The repo
 * had no load-aware timeout; this stretches the closest existing bound, the policy's per-proof hang guard, by host
 * pressure (test-slot's own load reading) instead of adding a fixed cap.
 */

/** {@link inTreeCheckBudgetMs}'s base when plan/policy.yaml cannot be read: that row's own floor, as `check-proof`'s. */
const BASE_FALLBACK_MS = 60_000;

/**
 * How long ONE in-tree check may run: `proofTimeoutMs` (the bound `check-proof` applies to the proof it runs)
 * stretched by the one-minute load per core, never below 1x. No fixed cap: an idle host gives exactly the guard,
 * and load 30 on 8 cores gives 3.75x it.
 */
export function inTreeCheckBudgetMs(load: HostLoad = readHostLoad(), readBase?: () => number): number {
  let base: number;
  try {
    base = readBase?.() ?? defaultProofTimeoutMs();
  } catch {
    base = BASE_FALLBACK_MS; // an unreadable policy still bounds the leg, at the policy's own floor
  }
  const cores = Number.isFinite(load.cores) && load.cores >= 1 ? load.cores : 1;
  const pressure = Number.isFinite(load.load1) && load.load1 > 0 ? load.load1 / cores : 0;
  return Math.round(base * Math.max(1, pressure));
}

/** Spawn options for a budgeted child: killed at the budget, and `detached` so it leads its own process group. */
export function budgetedSpawn(budgetMs: number): { timeout: number; killSignal: "SIGKILL"; detached: true } {
  return { timeout: budgetMs, killSignal: "SIGKILL", detached: true };
}

/** Node's budget kill reaches only the child it spawned; that child leads its own group ({@link budgetedSpawn}), so
 *  this takes the rest. A killed `git worktree add` would otherwise leave its `git reset --hard` writing as an orphan. */
export function killBudgetLeftovers(pid: number | undefined): void {
  if (pid !== undefined) killProcessGroup(pid);
}

/** A timeout is not a teardown receipt: wait for every process in the detached group to exit before removing its worktree. */
export async function waitForProcessGroupExit(pgid: number | undefined, timeoutMs = 5_000): Promise<boolean> {
  if (pgid === undefined || !Number.isInteger(pgid) || pgid <= 0) return false;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      process.kill(-pgid, 0);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return true;
      if (code !== "EPERM") return false;
    }
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
