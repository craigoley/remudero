import { runFixRung as runFixRungProduction } from "../../src/run-task.js";
import type { FixProgressJudge } from "../../src/lib/fix-progress-judge.js";

export * from "../../src/run-task.js";

/**
 * Legacy rung tests used the former strike ceiling as their stopping policy. Model that explicitly
 * as a test judge response; production no longer treats the ceiling as an automatic decision.
 * Tests for the new unbounded, judge-led path inject their own judge and bypass this default.
 */
const legacyFixtureJudge: FixProgressJudge = async input => {
  if (input.formerCeiling !== undefined && input.rounds.length >= input.formerCeiling) {
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
  return runFixRungProduction({
    ...options,
    deps: {
      ...options.deps,
      fixProgressJudge: options.deps.fixProgressJudge ?? legacyFixtureJudge,
    },
  });
}
