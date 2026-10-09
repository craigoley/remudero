import { runFixRung as runFixRungProduction } from "../../src/run-task.js";
import type { FixProgressJudge } from "../../src/lib/fix-progress-judge.js";

export * from "../../src/run-task.js";

/**
 * Legacy rung tests used the former strike ceiling as their stopping policy. Model that explicitly
 * as a test judge response; production no longer treats the ceiling as an automatic decision.
 * Tests for the new unbounded, judge-led path inject their own judge and bypass this default.
 */
const legacyFixtureJudge: FixProgressJudge = async input => {
  if (input.signals.refusedRounds >= 2 && input.parkedReason) {
    return {
      verdict: "escalate",
      loop: `repeated refusal: ${input.parkedReason}`,
      reason: "the fixture models the existing no-information stand-down for an identical refusal",
    };
  }
  if (input.parkedReason?.includes("ci-log false-block") && input.signals.noOpRounds > 0) {
    return {
      verdict: "escalate",
      loop: input.parkedReason,
      reason: "the fixture models the no-information handoff for an unchanged CI finding",
    };
  }
  if (input.formerCeiling !== undefined && input.strikesSpent >= input.formerCeiling) {
    return {
      verdict: "escalate",
      loop: `fixture-selected former ceiling ${input.formerCeiling}`,
      reason: "legacy fixture models an explicit human handoff at its former bound",
    };
  }
  return { verdict: "continue", reason: "legacy fixture explicitly permits the next test round" };
};

export async function runFixRung(...args: Parameters<typeof runFixRungProduction>) {
  const [options] = args;
  // Preserve the caller's option/dependency object identity. A few lifecycle regressions mutate
  // worktreePath from inside spawn to model a worktree disappearing after dispatch; cloning the
  // options here hid that state change from the production rung.
  options.deps.fixProgressJudge ??= legacyFixtureJudge;
  return runFixRungProduction(options);
}
