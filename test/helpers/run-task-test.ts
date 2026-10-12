import { runFixRung as runFixRungProduction } from "../../src/run-task.js";

export * from "../../src/run-task.js";

/**
 * Legacy rung tests pin the pre-W1-T7096 stopping behaviour. They wire NO progress judge, so the rung
 * uses its announced former-bound stand-in, which rules "escalate" at exactly the sites the fixed rung
 * stopped (a reached bound, an unchanged tree, a ci-log or review false-block). Tests for the judge-led
 * path inject their own `fixProgressJudge`.
 */
export async function runFixRung(...args: Parameters<typeof runFixRungProduction>) {
  return runFixRungProduction(...args);
}

/**
 * W1-T7096 judge-led fixtures: an explicit TEST judge that stops at the fixture's former ceiling, so a test
 * pins that the JUDGE (not a snapshot or a counter) chose the stop. Import as `runFixRungJudged`.
 */
export const fixtureCeilingJudge: import("../../src/lib/fix-progress-judge.js").FixProgressJudge = async (input) => {
  if (input.formerCeiling !== undefined && input.rounds.length >= input.formerCeiling) {
    return {
      verdict: "escalate",
      loop: `fixture-selected former ceiling ${input.formerCeiling}`,
      reason: "the fixture's judge chose an explicit human handoff at its former bound",
    };
  }
  return { verdict: "continue", reason: "the fixture's judge permits the next test round" };
};

export async function runFixRungJudged(...args: Parameters<typeof runFixRungProduction>) {
  const [options] = args;
  return runFixRungProduction({
    ...options,
    deps: { ...options.deps, fixProgressJudge: options.deps.fixProgressJudge ?? fixtureCeilingJudge },
  });
}
