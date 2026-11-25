// src/lib/plan-load-refusal.ts — a plan-lint "unavailable" whose reason is the plan's own load refusal, as a finding.
import type { PlanLintOutcome } from "./review.js";
import type { RelintViolation } from "./relint.js";

/** W1-T13116: an "unavailable" lint whose reason is the plan's own load refusal (a malformed proposal, an unknown
 *  dependency) is the worker's defect, not the harness's — hand it back as a blocking finding so the lane repairs it.
 *  The `triage.relint_plan_lint_unavailable` row is still written either way. */
const PLAN_LINT_INFRA_REASON = /^(no PR-head checkout|no merge base|lint-plan (aborted|could not start|killed|exited without|threw)|cannot resolve --base|--plan .* resolves OUTSIDE|lint-plan exited \d+ with no summary)/;

export function planLoadRefusalViolations(outcome: PlanLintOutcome): RelintViolation[] {
  if (outcome.ran || PLAN_LINT_INFRA_REASON.test(outcome.reason)) return [];
  return [{ check: "plan-load", severity: "block" as const, message: "the plan does not load with your filing: " + outcome.reason }];
}
