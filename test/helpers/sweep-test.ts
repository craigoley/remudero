import { isProductionFixProgressJudge, runSweep as runSweepProduction } from "../../src/lib/sweep.js";
import type { FixProgressJudge } from "../../src/lib/fix-progress-judge.js";

export * from "../../src/lib/sweep.js";

/** Existing sweep fixtures model the former cap as an explicit judge-selected handoff. */
export async function runSweep(...args: Parameters<typeof runSweepProduction>) {
  const [openPrs, deps, policy] = args;
  const fixtureProgressJudge: FixProgressJudge = async input => {
    const pr = openPrs.find(candidate => candidate.prNumber === input.prNumber || candidate.taskId === input.taskId);
    const spentRounds = Math.max(input.strikesSpent, pr?.priorStrikes ?? 0);
    if (input.signals.refusedRounds >= 2 && input.parkedReason) {
      return {
        verdict: "escalate",
        loop: `repeated refusal: ${input.parkedReason}`,
        reason: "the fixture models the existing no-information stand-down for an identical refusal",
      };
    }
    if (input.formerCeiling !== undefined &&
        (spentRounds >= input.formerCeiling || (pr?.priorStrikes ?? 0) >= input.formerCeiling)) {
      return {
        verdict: "escalate",
        loop: `fix strikes exhausted at former ceiling ${input.formerCeiling}`,
        reason: "legacy fixture explicitly models a human handoff at its former bound",
      };
    }
    return { verdict: "continue", reason: "legacy fixture explicitly permits the next test round" };
  };
  return runSweepProduction(openPrs, {
    ...deps,
    // buildSweepEffects wires the production LLM judge; a fixture that did not CHOOSE a judge keeps the former bound.
    fixProgressJudge: deps.fixProgressJudge && !isProductionFixProgressJudge(deps.fixProgressJudge)
      ? deps.fixProgressJudge : fixtureProgressJudge,
  }, policy);
}
