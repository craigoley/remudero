/**
 * lib/promotion-bars.ts — the numbers that decide whether the fleet promotes one of its own changes.
 *
 * The config gardener's canaries, the judge cash moves and model switches, the judge shadow pool and the skill-eval
 * gate all promote with no person in the loop, and every PR is merged without waiting on one (operator ruling). A bar
 * held as a TypeScript constant could therefore be loosened by any PR, silently. So the bars live in two baseline files
 * that scripts/baseline-monotonic-check.mjs, a REQUIRED check, holds monotonic against origin/main: a floor may only
 * rise and a ceiling only fall unless the file's `bumpRationale` names a PR or task its previous rationale did not.
 *
 * READ ON FIRST USE, NEVER AT IMPORT: judge-shadow.ts and experiment-promotion.ts sit in the import closure of about a
 * hundred src modules that load in a tree carrying src/ but not scripts/ (child-entry-argv.ts names that consumer
 * checkout), so those two reach the bars through getters. config-gardener.ts and skill-eval.ts already import from
 * scripts/, so they read theirs into plain constants at import. The read is memoized per process.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Higher is stricter: each field is a `direction: "increase"` row in baseline-monotonic-check's SCORE_TABLE. */
export const PROMOTION_FLOORS_PATH = "scripts/promotion-floors-baseline.json";
/** Lower is stricter: each field is a `direction: "decrease"` row in baseline-monotonic-check's SCORE_TABLE. Every
 *  value in the file is a PRIMARY CONTROL: the number that normally stops a bad promotion, not a backstop behind one. */
export const PROMOTION_CEILINGS_PATH = "scripts/promotion-ceilings-baseline.json";

/** The floors file's fields, each read by one module (the file's `_comment` names which). */
export const PROMOTION_FLOOR_FIELDS = [
  "canaryMinTasksPerSide", "judgeMinPaired", "judgeMinAgreeShare", "skillEvalHeldOutTasks", "skillEvalTrialsPerArm", "skillEvalMinMeanGain",
] as const;
/** The ceilings file's fields, each a PRIMARY CONTROL read by one module (the file's `_comment` names which). */
export const PROMOTION_CEILING_FIELDS = [
  "judgeMaxNoAnswerShare", "judgeMaxBrier", "poolMaxRejectedShare", "poolMaxMedianCaseUsd", "canaryMaxCostRatio", "canaryMaxMergeRateDrop",
] as const;
export type PromotionFloor = (typeof PROMOTION_FLOOR_FIELDS)[number];
export type PromotionCeiling = (typeof PROMOTION_CEILING_FIELDS)[number];

/** This module's own checkout: two levels above src/lib/, and two above dist/child-entries/ for a bundle. */
export const PROMOTION_BARS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every one of `fields` from `<root>/<path>`. Throws, naming the file and field, when the file is unreadable, is not
 *  JSON, or a field is not a finite number: no default stands in for a bar. */
export function readPromotionBars<F extends string>(root: string, path: string, fields: readonly F[]): Readonly<Record<F, number>> {
  let text: string;
  try {
    text = readFileSync(join(root, path), "utf8");
  } catch (error) {
    throw new Error(`promotion-bars: cannot read ${path} under ${root} (${(error as Error).message}); the automatic-promotion bars live there`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`promotion-bars: ${path} is not valid JSON (${(error as Error).message})`);
  }
  const record = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
  const bars = {} as Record<F, number>;
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`promotion-bars: ${path}'s "${field}" is not a finite number (${JSON.stringify(value)})`);
    }
    bars[field] = value;
  }
  return Object.freeze(bars);
}

let floors: Readonly<Record<PromotionFloor, number>> | undefined;
let ceilings: Readonly<Record<PromotionCeiling, number>> | undefined;

/** One floor from {@link PROMOTION_FLOORS_PATH}, read on first use. */
export function promotionFloor(field: PromotionFloor): number {
  floors ??= readPromotionBars(PROMOTION_BARS_ROOT, PROMOTION_FLOORS_PATH, PROMOTION_FLOOR_FIELDS);
  return floors[field];
}

/** One ceiling from {@link PROMOTION_CEILINGS_PATH}, read on first use. */
export function promotionCeiling(field: PromotionCeiling): number {
  ceilings ??= readPromotionBars(PROMOTION_BARS_ROOT, PROMOTION_CEILINGS_PATH, PROMOTION_CEILING_FIELDS);
  return ceilings[field];
}
