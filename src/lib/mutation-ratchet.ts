/**
 * Mutation-testing ratchet — PURE decision logic (W1-T25, MASTER-PLAN §5
 * TIER 2 "Mutation-testing baseline ... Baseline recorded, ratcheted like
 * coverage." / LEARNINGS: "green tests that kill no mutants are theater; a
 * mutation-testing baseline is the falsifier coverage % cannot provide.").
 *
 * Same split as coverage-ratchet.ts: `evaluateMutationRatchet()` takes an
 * already-computed score and baseline as INPUTS, unit-testable over FIXTURE
 * scores without running a real (multi-hour, see mutation.yml) mutation
 * pass. `computeMutationScore()` is the other pure half — Stryker's own
 * "mutation score" definition (killed / (killed + survived + timeout) * 100;
 * NoCoverage and Ignored mutants are excluded from the denominator, same as
 * Stryker's own scoring — an un-covered mutant is a coverage-ratchet
 * problem, not a mutation-score one). The caller
 * (.github/scripts/mutation-ratchet.mjs) owns the I/O: run Stryker, read its
 * JSON report, extract mutant statuses, then call these.
 */

export type MutantStatus = "Killed" | "Survived" | "Timeout" | "NoCoverage" | "Ignored" | "CompileError" | "RuntimeError";

export interface RatchetVerdict {
  pass: boolean;
  reasons: string[];
}

/**
 * Stryker's own mutation-score formula: what fraction of the mutants that
 * COULD have been killed (killed + survived + timeout) actually were.
 * Returns null (no score) when there is nothing to divide by — e.g. every
 * mutant was NoCoverage/Ignored — rather than fabricating a 0 or 100.
 */
export function computeMutationScore(statuses: MutantStatus[]): number | null {
  let killed = 0;
  let survived = 0;
  let timeout = 0;
  for (const status of statuses) {
    if (status === "Killed") killed++;
    else if (status === "Survived") survived++;
    else if (status === "Timeout") timeout++;
  }
  const denominator = killed + survived + timeout;
  if (denominator === 0) return null;
  return (killed / denominator) * 100;
}

/**
 * `baseline` is `null` in the BOOTSTRAP state (MASTER-PLAN §5A: "ratchet
 * BASELINES captured at onboarding ... a repo never onboards 'at zero'" —
 * but a multi-hour full mutation run cannot be captured live while authoring
 * the gate itself; see .remudero/quality-baseline.json's mutation note). A
 * null baseline always passes — there is nothing yet to ratchet against —
 * so this never blocks a PR before a real baseline exists. Once a baseline
 * is recorded (non-null), a measured score below it fails: a
 * mutation-score-lowering change is CI-red, same as coverage.
 */
export function evaluateMutationRatchet(score: number | null, baseline: number | null): RatchetVerdict {
  if (baseline === null) {
    return { pass: true, reasons: ["no mutation baseline recorded yet (bootstrap) — nothing to ratchet against"] };
  }
  if (score === null) {
    return { pass: false, reasons: ["no mutation score could be computed (no killed/survived/timeout mutants) — cannot verify the ratchet"] };
  }
  if (score < baseline) {
    return { pass: false, reasons: [`mutation score ${score}% is below the ratcheted floor of ${baseline}%`] };
  }
  return { pass: true, reasons: [] };
}
