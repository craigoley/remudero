import { buildPlanPrBody, type PlanPrBodyOpts } from "../../src/lib/plan-pr-emitter.js";

/** Formatting tests should not spawn the real proof checker; the author-time decision has its own suite. */
export function buildFixturePlanPrBody(opts: PlanPrBodyOpts): string {
  return buildPlanPrBody({
    ...opts,
    baseRef: opts.baseRef ?? "fixture-base",
    proofCheck: opts.proofCheck ?? (() => 0),
  });
}
