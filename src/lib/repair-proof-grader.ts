/**
 * W1-T13351 — THE REAL {@link BaseProofGrader}: the proof-discrimination gate's own executor, run in the repair's worktree.
 *
 * scripts/proof-discrimination-gate.mjs spawns `check-proof <proof> --base <merge base>` from the PR head's checkout and
 * reads exit 5 (`CHECK_PROOF_EXIT.executedStale`) as "passes at both head and base". This grader spawns the same entry
 * from the repair worktree's own tree, so a repair lane and the gate cannot disagree about one proof.
 */
import { LoopBoundedChildTimeout } from "./loop-bounded-child.js";
import { execFileRouted } from "./spawn-helper.js";
import { CHECK_PROOF_EXIT, checkProofChildArgv, checkProofTimeoutMs } from "./check-proof.js";
import type { BaseProofGrade, BaseProofGrader } from "./main-repair-acceptance.js";

/** One finished check-proof child: its exit code, or `null` when it was killed or never started. */
export type CheckProofChildRun = (argv: string[], opts: { cwd: string; timeoutMs: number }) => Promise<number | null>;

/** Run `process.execPath <argv>` with the gate's environment shape and return its exit code. The bound is LOOP-AVAILABLE
 *  time (execFileLoopBounded), never wall clock, so a suspended host does not kill a healthy child on wake (W1-T9651). */
export const runCheckProofChild: CheckProofChildRun = async (argv, { cwd, timeoutMs }) => {
  try {
    await execFileRouted(process.execPath, argv, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      // Same as the gate: check-proof answers about the pinned head and base, so it must not re-sync the checkout.
      env: { ...process.env, RMD_SELF_SYNC_DONE: "1" },
    });
    return 0;
  } catch (error) {
    // A non-zero exit carries its numeric code; a kill at the budget, a spawn failure (ENOENT) or a buffer overrun is null.
    if (error instanceof LoopBoundedChildTimeout) return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === "number" ? code : null;
  }
};

/** Map a check-proof exit code to a grade. Only exit 5 is `stale`; only a clean pass that the base does not share is
 *  `discriminates`; a refusal, a no-match, an exec error or a kill stays `unknown`, so the caller keeps the proof. */
export function gradeFromCheckProofExit(code: number | null): BaseProofGrade {
  if (code === CHECK_PROOF_EXIT.executedStale) return "stale";
  if (code === CHECK_PROOF_EXIT.pass) return "discriminates";
  return "unknown";
}

/** A grader for proofs in the checkout at `worktreePath` against `mergeBase`. Head and base each run under the proof
 *  timeout, so the child gets twice that plus start-up headroom before it is killed and graded `unknown`. */
export function checkProofBaseGrader(
  worktreePath: string,
  mergeBase: string,
  run: CheckProofChildRun = runCheckProofChild,
  timeoutMs: number = 2 * checkProofTimeoutMs() + 60_000,
): BaseProofGrader {
  return async (proof) => gradeFromCheckProofExit(await run(checkProofChildArgv(proof, mergeBase, worktreePath), { cwd: worktreePath, timeoutMs }));
}
