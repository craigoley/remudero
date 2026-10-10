import { runSweep as runSweepProduction } from "../../src/lib/sweep.js";

export * from "../../src/lib/sweep.js";

/**
 * Legacy sweep fixtures pin the pre-W1-T7096 stopping behaviour. They wire NO progress judge, so the sweep
 * uses its announced former-bound stand-in, which rules "escalate" wherever a judgment is due
 * ({@link fixProgressJudgmentDue}) — exactly the former bound. Judge-led tests inject `fixProgressJudge`.
 */
export async function runSweep(...args: Parameters<typeof runSweepProduction>) {
  return runSweepProduction(...args);
}
