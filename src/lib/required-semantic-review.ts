import { createHash } from "node:crypto";

/** Explicit semantic requirements cannot replay decisions produced by the advisory-only policy. */
export function requiredSemanticDecisionDigest(digest: string, required: boolean): string {
  return required ? `required-semantic-v1:${createHash("sha256").update(digest).digest("hex")}` : digest;
}

/** An unavailable reviewer is an incomplete evaluation, not evidence that the code passed. */
export function requiredSemanticRefusal(input: {
  required: boolean; planOnly: boolean; outcome: string;
  criteriaCount: number; verdicts: readonly (boolean | undefined)[] | undefined;
}): string | undefined {
  if (!input.required || input.planOnly) return undefined;
  if (input.outcome !== "success") return `required-semantic-${input.outcome}`;
  if (input.criteriaCount <= 0 || input.verdicts?.length !== input.criteriaCount ||
      input.verdicts.some(value => typeof value !== "boolean")) return "required-semantic-incomplete-verdicts";
  return undefined;
}
