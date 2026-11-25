/**
 * THE PRE-OPEN GATE ALSO ASKS THE TASK'S OWN FILED `grep:` PROOFS, AT THE WORKER'S HEAD.
 *
 * A `grep:` proof that matches nothing at the worker's head (a criterion label the worker never wrote) used to
 * surface only when the PR opened: `openPullRequestChecked` refused with a terminal `branch-gap`
 * `pr_open.refused`, which blocks the task for hours and re-dispatches a fresh build. The fast gate cannot see
 * it, because the fast gate knows no task. This wrapper runs the same proofs, head-only and through the same
 * `check-proof` runner the open uses, BEFORE the PR opens, so a miss becomes one more named failed step in the
 * existing pre-open repair round, where the worker still holds the tree and can write the missing text.
 *
 * Only `grep:` proofs run here: they answer in milliseconds. A `unit test:` proof runs a suite and stays with the
 * open. Only a CONCLUSIVE miss (check-proof exit 1 or 3) is handed to the worker; a proof the harness could not
 * look at (a timeout, a spawn failure, exit 4) is not the worker's to fix and is left to the open's own retry.
 */
import type { AcceptanceCriterion } from "./plan.js";
import { partitionAcceptanceCriteria, type AsyncOpenPullRequestProofRunner } from "./pr-open.js";
import { parseWhitelistedProof, type SuiteRegistryTarget } from "./review.js";
import type { PreopenGateResult } from "./preopen-gate.js";

/** The failing step a filed grep proof's miss is handed back under, with the proof and its output after it. */
export const FILED_GREP_PROOF_STEP_NAME = "filed-grep-proof";

/** `rmd check-proof` exits 1 (an executed proof failed) and 3 (no match): the two verdicts that mean "not in your tree". */
const CONCLUSIVE_MISS_EXITS: ReadonlySet<number> = new Set([1, 3]);

/** BACKSTOP: the longest slice of a proof's own output one failed step carries, so the repair prompt stays readable. */
export const FILED_GREP_PROOF_DETAIL_MAX = 400;

/** One failed-step line per filed `grep:` proof that matches nothing in `cwd`; empty when every one matches. */
export async function filedGrepProofMisses(
  criteria: readonly AcceptanceCriterion[],
  cwd: string,
  runProof: AsyncOpenPullRequestProofRunner,
  target?: SuiteRegistryTarget,
): Promise<string[]> {
  const misses: string[] = [];
  for (const criterion of partitionAcceptanceCriteria(criteria).executable) {
    const proof = criterion.proof.trim();
    if (parseWhitelistedProof(proof, target)?.kind !== "grep") continue;
    const result = await runProof(proof, undefined, cwd, target);
    if (result.status === null || !CONCLUSIVE_MISS_EXITS.has(result.status) || result.error) continue;
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    const detail = output.length > FILED_GREP_PROOF_DETAIL_MAX ? `…${output.slice(-FILED_GREP_PROOF_DETAIL_MAX)}` : output;
    misses.push(
      `${FILED_GREP_PROOF_STEP_NAME}: the task's own filed proof \`${proof}\` matches nothing in your tree ` +
        `(criterion: ${JSON.stringify(criterion.claim)}). Write what it looks for, verbatim, where it looks — ` +
        `the proof is the task's and is never edited by you; if you hold it unsatisfiable, say so in your REPORT.` +
        (detail ? ` check-proof said: ${detail}` : ""),
    );
  }
  return misses;
}

/**
 * `gate`, then the filed grep proofs. A pass with a miss, or a fail with one, is a fail whose steps are the gate's own
 * followed by each miss; a gate that measured nothing (`unmeasured`, `skipped`) is returned as it was, so a health
 * row is never rewritten by a check the gate did not make.
 */
export function withFiledGrepProofs(
  gate: (worktreePath: string) => Promise<PreopenGateResult>,
  criteria: () => readonly AcceptanceCriterion[],
  runProof: AsyncOpenPullRequestProofRunner,
  target?: SuiteRegistryTarget,
): (worktreePath: string) => Promise<PreopenGateResult> {
  return async (worktreePath) => {
    const result = await gate(worktreePath);
    if (result.kind === "unmeasured" || result.kind === "skipped") return result;
    const misses = await filedGrepProofMisses(criteria(), worktreePath, runProof, target);
    if (misses.length === 0) return result;
    const own = result.kind === "fail" ? result.failedSteps : [];
    return { ...result, kind: "fail", failedSteps: [...own, ...misses] };
  };
}
