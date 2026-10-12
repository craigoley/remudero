import { runSweep as runSweepProduction } from "../../src/lib/sweep.js";

export * from "../../src/lib/sweep.js";

/** In-memory ledgers cover all refresh steps from before the fixture PR was opened. */
export function completeLiveRefreshHistory(now: number): Record<string, unknown>[] {
  const ts = new Date(now - 120 * 60_000).toISOString();
  return ["fix.base_refreshed", "sweep.base_red.refresh", "sweep.base_fixed.refresh", "refresh.clearance"]
    .map(step => ({ step, ts, outcome: "skipped" }));
}

/**
 * Legacy sweep fixtures pin the pre-W1-T7096 stopping behaviour. They wire NO progress judge, so the sweep
 * uses its announced former-bound stand-in, which rules "escalate" wherever a judgment is due
 * ({@link fixProgressJudgmentDue}) — exactly the former bound. Judge-led tests inject `fixProgressJudge`.
 */
export async function runSweep(...args: Parameters<typeof runSweepProduction>) {
  return runSweepProduction(...args);
}
