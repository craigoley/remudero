/**
 * Plan-scope guard (pure) — W1-T2895.
 *
 * Split out of `plan-architect.ts` so this predicate is a LEAF: `isInPlanScope` is imported by
 * `review.ts`, and `review.ts` -> `plan-architect.ts` -> `plan-pr-emitter.ts` -> `review.ts` was
 * one of thirteen import cycles `npm run cycle-ratchet` tolerated (`.dependency-cruiser.cjs`'s
 * `no-circular` rule). This module imports NOTHING from that ring, so `review.ts` importing it
 * directly (instead of through `plan-architect.ts`) breaks that ring at this edge.
 *
 * `plan-architect.ts` re-exports these three names unchanged for its other, non-cyclic
 * consumers (`status.ts`, `task-linter.ts`, `prompt-render.ts`) — moving the DEFINITION, never
 * the public surface.
 */

/**
 * The ONE doc path in plan scope. A NAMED EXACT PATH, deliberately not a `docs/` prefix or a
 * glob: `isInPlanScope` feeds `ReviewVerdict.planOnly`, and a `planOnly` CAPPED verdict arms
 * auto-merge with NO executed proof (the W1-T205 carve-out). Widening that to all of `docs/`
 * would let any documentation change inherit an exemption meant for plan filings.
 *
 * impl-BI — WHY IT IS IN SCOPE AT ALL. `rmd retro` REGENERATES this file itself on every run
 * (ledger `orientation.regenerated`) and stamps a header saying so: "MAINTAINED BY `rmd retro`
 * … Hand edits are overwritten on the next retro". It is a machine-derived projection of the
 * plan and the ledger, no more hand-authored than `plan/plan-index.json` (already in scope for
 * the same reason). Because it sat OUTSIDE this predicate, every retro PR since #236 computed
 * `planOnly: false` and its structurally-capped verdict was refused by `decideAutoMergeArm` —
 * so retro PRs have needed a hand merge for their whole history (#287, #353, #469, #883, #974).
 *
 * The second reason is coherence, and it is the load-bearing one. `armAutoMerge`'s W1-T230
 * gate is STATE-ONLY (`decideArmFromLedgerVerdict` checks head + `state === "success"`, never
 * `capped`), while `decideAutoMergeArm` — used by the sweep and by `armIfVerdictPermits` —
 * refuses a CAPPED non-plan-only verdict. Those two agree on every lane whose diff is plan-only.
 * Repairing the retro's task-id key (impl-BI) without this line would create the one lane where
 * they DISAGREE: the review path would refuse the arm and `retroCommand` would arm it anyway
 * seconds later, quietly defeating W1-T229's safety lock. One named path keeps them aligned.
 */
export const ORIENTATION_DOC = "docs/ORIENTATION.md";

/**
 * Whether a repo-relative path is IN scope for a `rmd plan` proposal — `plan/**`,
 * `MASTER-PLAN.md` (the plan skill's output can rewire MASTER-PLAN §sections too, unlike
 * triage's narrower "plan/ only" floor — `.remudero/skills/plan.yaml`'s output_contract names
 * both), or the single regenerated doc {@link ORIENTATION_DOC}.
 */
export function isInPlanScope(path: string): boolean {
  return path === "MASTER-PLAN.md" || path === ORIENTATION_DOC || path.startsWith("plan/");
}

/** Every path in `files` that is OUT of plan scope (see {@link isInPlanScope}). */
export function outOfPlanScopeFiles(files: string[]): string[] {
  return files.filter((f) => !isInPlanScope(f));
}
