import type { BillingMode } from "./env.js";

/**
 * THE ROUTING OBJECTIVE (W1-T2577, MASTER-PLAN §9).
 *
 * §9 IS EXPLICIT AND EVERY ROUTER MUST AGREE WITH IT: "on subscription, `total_cost_usd` is
 * NOTIONAL — it is the API-equivalent price, not billed spend", used for exactly two things, the
 * runaway tripwire and metering when `billing_mode == api`. A recommender that MINIMISES that
 * number on a subscription install is minimising a figure nobody is billed, and it will happily
 * trade away throughput to do so — #3486 is the measured case on record: dispatch lanes were cut
 * 3 -> 2 on `daemon.headroom` evidence (a five-hour window going 30% -> 100% used in 58 minutes)
 * while every dollar figure argued nothing. The binding constraint was the WINDOW.
 *
 * SO THE OBJECTIVE, ON SUBSCRIPTION, IS WINDOW SHARE CONSUMED PER SETTLED TASK — and this is
 * where two providers pay most. Claude and Codex meter against SEPARATE subscriptions with
 * separate resets, so the SAME work costs a different fraction of a different scarce pool
 * depending on where it is sent (`selectWorkerProvider`, worker-provider.ts, already reads both
 * windows to make exactly that call). {@link routingObjectiveFor} therefore reads each arm's own
 * `windowShare` and NEVER borrows another arm's provider's window — see the provider-mismatch
 * branch below.
 *
 * NOTIONAL DOLLARS ARE NOT DISCARDED, THEY ARE DEMOTED TO WHAT §9 SAYS THEY ARE. Under
 * `billing_mode == "api"` the dollars are real and the window is not the constraint, so the
 * dollar objective is the CORRECT one, not a fallback. Under `billing_mode == "subscription"`,
 * an arm whose window could not be read (a provider capacity probe failed, or the caller simply
 * has no window evidence yet) falls back to the dollar objective — but LOUDLY, via `opts.warn`
 * (defaulting to `console.warn`), naming exactly what is missing, so an install that cannot
 * justify the proxy it is using never optimises it silently.
 */

/**
 * One arm's own window-share evidence — always keyed to its OWN `provider`. A caller that hands
 * `routingObjectiveFor` evidence for a DIFFERENT provider than the arm's own is refused (falls
 * back, loudly) rather than silently applied: the whole point of tracking two windows is that
 * they are never conflated.
 */
export interface ArmWindowShare {
  provider: string;
  /**
   * Percent of this provider's tightest window consumed by this arm's runs, divided by this
   * arm's own settled-task count — the SAME "per completed task" denominator
   * `costPerCompletedTaskUsd` already uses (mirrors it, never a different unit). `null` means the
   * window could not be read (unreadable capacity, no evidence yet) — NEVER treated as zero
   * consumption.
   */
  percentConsumedPerCompletedTask: number | null;
}

/** The (structural, minimal) arm shape {@link routingObjectiveFor} reads. */
export interface RoutingObjectiveArm {
  provider: string;
  /** Notional dollars per completed task (§9: NEVER billed spend on subscription). Always the
   *  runaway-tripwire figure; kept available here so the dollar objective never disappears. */
  costPerCompletedTaskUsd: number | null;
  /** This arm's own window-share evidence, when the caller has it. Absent (or a `null` percent)
   *  means "unreadable", not "zero". */
  windowShare?: ArmWindowShare;
}

export type RoutingObjectiveKind = "window-share" | "notional-dollar";

export interface RoutingObjective {
  kind: RoutingObjectiveKind;
  /** The figure to MINIMISE — a window-percent or a notional-USD figure, both "per completed
   *  task". Never mix `value`s of different `kind`s across arms in one comparison. */
  value: number;
  provider: string;
  unit: "percent-per-completed-task" | "usd-per-completed-task";
  /** Present ONLY when `kind` is `"notional-dollar"` because a subscription window could not be
   *  read — the loud reason, mirrored into whatever `opts.warn` was told. Absent when
   *  `billing_mode` is genuinely `"api"` (there the dollar objective is not a fallback at all). */
  fallbackReason?: string;
}

export interface RoutingObjectiveOptions {
  /** Called (never silently swallowed) when this call falls back to the dollar objective on a
   *  subscription install. Defaults to `console.warn`, prefixed `[routing-objective]`. */
  warn?: (message: string) => void;
}

function defaultWarn(message: string): void {
  console.warn(`[routing-objective] ${message}`);
}

/**
 * The routing objective for ONE arm, selected by `billingMode` — never hardcoded to dollars. See
 * this module's own header for the full ruling. Returns `undefined` only when NEITHER a dollar
 * figure NOR a readable window share is available for this arm — there is nothing to minimise.
 */
export function routingObjectiveFor(
  arm: RoutingObjectiveArm,
  billingMode: BillingMode,
  opts: RoutingObjectiveOptions = {},
): RoutingObjective | undefined {
  if (billingMode === "api") {
    // §9: dollars are REAL under API billing, and the window is not the constraint there — this
    // is the correct objective outright, not a proxy standing in for one.
    if (arm.costPerCompletedTaskUsd === null) return undefined;
    return { kind: "notional-dollar", value: arm.costPerCompletedTaskUsd, provider: arm.provider, unit: "usd-per-completed-task" };
  }

  // billing_mode === "subscription": the scarce resource is the WINDOW, not the notional dollar
  // (this task's own title) — and it is THIS arm's own provider's window, never another's.
  const share = arm.windowShare;
  if (share && share.provider === arm.provider && share.percentConsumedPerCompletedTask !== null) {
    return { kind: "window-share", value: share.percentConsumedPerCompletedTask, provider: arm.provider, unit: "percent-per-completed-task" };
  }

  const reason = !share
    ? `no window-share evidence supplied for provider '${arm.provider}' on a subscription install`
    : share.provider !== arm.provider
      ? `window-share evidence names provider '${share.provider}', not this arm's own provider ` +
        `'${arm.provider}' — refusing to borrow another provider's window`
      : `window-share for provider '${arm.provider}' is unreadable (percentConsumedPerCompletedTask is null)`;
  (opts.warn ?? defaultWarn)(
    `${reason} — falling back to the notional-dollar objective for provider '${arm.provider}'. ` +
      `§9: on subscription this is a PROXY, not the real constraint; the window this arm actually spends could not be measured.`,
  );
  if (arm.costPerCompletedTaskUsd === null) return undefined;
  return {
    kind: "notional-dollar",
    value: arm.costPerCompletedTaskUsd,
    provider: arm.provider,
    unit: "usd-per-completed-task",
    fallbackReason: reason,
  };
}
