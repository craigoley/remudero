/**
 * lib/glance.ts — the GLANCE layer's AGGREGATE reductions (W1-T159, MASTER-PLAN §7/§9): the
 * pinned summary strip's "merged-today" and "spend-today"/"spend-this-week" figures, none of
 * which board.ts's already-loaded client arrays can answer correctly at scale (GET /v1/recent
 * caps at a handful of entries — board.ts's own `buildRecentRoute` default `max` — so a day/week
 * with more activity than that window would silently under-count if computed client-side off
 * whatever happens to already be in memory). This module owns exactly the reduction the task's
 * queue_note calls "the aggregate strip (counts, spend totals)" — the four other strip numbers
 * (running/needs-me/blocked/queued) are the EXISTING W1-T155 taxonomy counts (board.ts's
 * `summarizeCounts`, or — for needs-me — the console's own combined NEEDS ME set), never
 * reimplemented here.
 *
 * BOUNDARY WITH W1-T184 (already shipped, PR #479): that task owns the per-event RECENT feed and
 * per-run live spend (board.ts's `computeRecentActivity`/`liveRunSpend`) — a bounded window over
 * the ledger's TAIL. This module owns the OPPOSITE shape: an unbounded reduction over the whole
 * ledger (or at minimum, the whole day/week), which is exactly why it cannot reuse RECENT's
 * capped feed and needs its own pass. "If both need the same ledger reduction, factor it once" —
 * the shared reduction here is `deriveWindowCostUsd` (sweep.ts), reused verbatim for spend, and
 * `utcDayWindowMs` (sweep.ts), reused verbatim so "today" means the same thing for spend AND for
 * merged-today.
 */

import { deriveDayCostUsd, deriveWeekCostUsd, utcDayWindowMs } from "./sweep.js";

/**
 * The GLANCE strip's ledger-derived spend/merge figures — see this module's header.
 *
 * W1-T2240: every `cost_usd`-bearing ledger step is emitted around a SPAWN the fleet itself
 * issued (`workerLedgerFields`, lib/worker.ts) — an operator/interactive session runs OUTSIDE
 * the daemon, on a subscription, with no spawn and no `WorkerResult` envelope, so it produces no
 * ledger row anywhere this reduction can reach. `spendTodayUsd`/`spendWeekUsd` therefore measure
 * one CHANNEL, not a project total, and `channel` names it so a reader of `spendTodayUsd` alone
 * never mistakes "fleet spend today" for "spend today". `sessionSpendUsd` is the other channel,
 * rendered — never fabricated — as the `null` this module's read of the ledger actually is: no
 * step anywhere carries a session's cost, so there is nothing to sum, and design (iii) forbids
 * estimating or imputing one. This mirrors serve.ts's existing `latestSpend ? … : "…"` refusal
 * to print a fabricated 0 when a figure is unknown — same defect class, one level up: a figure
 * that silently omits a whole channel is as misleading as one that can't tell EMPTY from
 * UNMEASURED (board.ts's `merged_known`, lib/autonomy.ts's `"measured" | "unmeasured"`).
 */
export interface GlanceSpend {
  /** Count of `verdict` lines with `verdict: "merged"` dated within `now`'s UTC calendar day. */
  mergedToday: number;
  /** The channel `spendTodayUsd`/`spendWeekUsd` cover — always `"fleet"` today; see this
   *  interface's doc comment. Naming it here, beside the figures, is the whole of this task. */
  channel: "fleet";
  /** Ledgered cost today (UTC calendar day), per-run — {@link deriveDayCostUsd} verbatim.
   *  FLEET-channel only — see `channel`. */
  spendTodayUsd: number;
  /** Ledgered cost this UTC week to date, per-run — {@link deriveWeekCostUsd} verbatim.
   *  FLEET-channel only — see `channel`. */
  spendWeekUsd: number;
  /** The operator-session channel's cost — always `null`: no ledger step records one (see this
   *  interface's doc comment). `null` means UNMEASURED, deliberately distinct from a `0` that
   *  would read as "sessions cost nothing". Never computed, estimated, or imputed. */
  sessionSpendUsd: null;
}

/**
 * `mergedToday`: one ledger scan, counting `verdict` lines whose `verdict` field is exactly
 * `"merged"` and whose `ts` falls in `now`'s UTC calendar day (the SAME day window
 * {@link deriveDayCostUsd} uses, via {@link utcDayWindowMs} — one shared "today", not two).
 * `spendTodayUsd`/`spendWeekUsd` are {@link deriveDayCostUsd}/{@link deriveWeekCostUsd} verbatim
 * over the SAME `lines` — never a second, independently-derived total; their VALUE is exactly
 * what this function returned before W1-T2240 — only `channel`/`sessionSpendUsd` are new, and
 * `sessionSpendUsd` is unconditionally `null` (see {@link GlanceSpend}).
 */
export function computeGlanceSpend(lines: ReadonlyArray<Record<string, unknown>>, now: number): GlanceSpend {
  const [dayStart, dayEnd] = utcDayWindowMs(now);
  let mergedToday = 0;
  for (const line of lines) {
    if (line.step !== "verdict" || line.verdict !== "merged") continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed) || parsed < dayStart || parsed >= dayEnd) continue;
    mergedToday += 1;
  }
  return {
    mergedToday,
    channel: "fleet",
    spendTodayUsd: deriveDayCostUsd(lines, now),
    spendWeekUsd: deriveWeekCostUsd(lines, now),
    sessionSpendUsd: null,
  };
}
