import { THROWN_RUN_VERDICT_STAGES } from "./status.js";

/** W1-T4709: a verdict that ended a run which never did any work — a thrown/deferred/refused run's
 *  stage (the set itself, never a copy) or an operator backfill. Its span and cost are setup only.
 *  A leaf (W1-T4711) so retro.ts can read it without a retro <-> cost-anomaly cycle. */
export function isNeverWorkedVerdict(line: { readonly [k: string]: unknown } | undefined): boolean {
  if (!line) return false;
  if (line.backfilled === true) return true;
  return typeof line.stage === "string" && THROWN_RUN_VERDICT_STAGES.has(line.stage);
}
