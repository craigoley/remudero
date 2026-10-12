/**
 * test/helpers/acceptance-fallback-surface.ts — W1-T4263.
 *
 * The run-task.ts seams the acceptance-fallback diff-anchor suite drives. The suite reaches them through
 * this helper so it adds no DIRECT `src/run-task.ts` importer to the affected-suite reach ratchet
 * (scripts/affected-reach-baseline.json only shrinks); the transitive edge the selector follows is unchanged.
 */
export {
  acceptanceGateBodyRepair,
  bodyRepairFallback,
  DIFF_ANCHOR_UNAVAILABLE_STEP,
  diffAnchoredAcceptanceCriterion,
  diffSinceMergeBase,
  ghPrCreateFillCommand,
  repairRetroAcceptanceBlock,
  runFixRung,
  runGhPrCreate,
} from "../../src/run-task.js";
