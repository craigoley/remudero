import { systemClock } from "./clock.js";
import type { Config, ModelApproval } from "./config-schema.js";
import { RmdError } from "./errors.js";

/**
 * Model families no lane may run without a human's permission (operator ruling, 2026-09-22):
 * "We should never use Astra or Fable without getting human permission first." Matched as a
 * whole token, so `gpt-6-astra` and `claude-fable-5-1` are gated and a name merely containing
 * the letters is not.
 */
export const HUMAN_GATED_MODEL_FAMILIES = ["astra", "fable"] as const;

const GATED_TOKEN = new RegExp(`(?:^|[^a-z0-9])(${HUMAN_GATED_MODEL_FAMILIES.join("|")})(?:[^a-z0-9]|$)`, "i");

export function humanGatedFamily(model: string | undefined): string | undefined {
  return model === undefined ? undefined : GATED_TOKEN.exec(model)?.[1]?.toLowerCase();
}

/**
 * An approval counts only for the exact model id, with a named approver and a parseable
 * approval time, and only before any expiry. Approvals live in the host's config.json, which no
 * worker can write, so a worker cannot approve its own model.
 */
export function modelApproved(model: string, approvals: readonly ModelApproval[] | undefined, now: number): boolean {
  return (approvals ?? []).some((approval) =>
    approval.model.toLowerCase() === model.toLowerCase() &&
    approval.approvedBy.trim().length > 0 &&
    Number.isFinite(Date.parse(approval.approvedAt)) &&
    (approval.expiresAt === undefined || Date.parse(approval.expiresAt) > now));
}

/** Adopts the shared envelope (src/lib/errors.ts) rather than extending Error directly, which the
 *  error-subclass census holds at a recorded ceiling. `usage` is the kind: the remedy is an edit to
 *  the operator's config.json, the same family as {@link RepoLayoutError}. */
export class HumanGatedModelError extends RmdError {
  constructor(readonly model: string, readonly family: string) {
    super(
      "usage",
      1,
      `model ${model} is in the human-gated ${family} family and has no operator approval: ` +
        `add { model, approvedBy, approvedAt } to modelApprovals in config.json to allow it`,
      { model, family },
    );
    this.name = "HumanGatedModelError";
  }
}

/** True when a model may run: it is not gated, or an operator approved it. */
export function modelAllowed(model: string | undefined, config: Pick<Config, "modelApprovals">, now = systemClock.now()): boolean {
  return humanGatedFamily(model) === undefined || modelApproved(model!, config.modelApprovals, now);
}

/** The launch-point check: throws before any process is spawned for an unapproved gated model. */
export function assertModelAllowed(model: string | undefined, config: Pick<Config, "modelApprovals">, now = systemClock.now()): void {
  const family = humanGatedFamily(model);
  if (family !== undefined && !modelApproved(model!, config.modelApprovals, now)) {
    throw new HumanGatedModelError(model!, family);
  }
}
