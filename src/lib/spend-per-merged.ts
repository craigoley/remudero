/**
 * W1-T13904 (rebuild of W1-T13862): paid model spend per merged PR for one finished UTC day, by lane.
 *
 * A dollar is counted once: from its produced row ({@link isProducedSpendRow} with `billing_mode` api or provider
 * cash), or from its `worker.attempt` api row only when no produced paid row carries the same
 * `selection_assignment_id`. A cash row whose token usage is partial or unavailable has no price; it is counted in
 * `unpriced_rows` and never added to the dollars. This module reads ledger rows only and makes no model call.
 */
import { fixedClock } from "./clock.js";
import { PR_TERMINAL_STEP } from "./ledger-carry.js";
import { isCashSpendProducer, isProducedSpendRow, spendAmountUsd } from "./spend-rows.js";

export const SPEND_PER_MERGED_DAILY_STEP = "spend.per_merged_daily";
export const SPEND_LANES = ["implement", "fix", "review", "judge_shadow", "gardener", "inbox_triage", "retro", "scout", "other"] as const;
export type SpendLane = (typeof SPEND_LANES)[number];

type Row = Record<string, unknown>;
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;

/** The assignment id of a `worker.assignment` row that routed to the cash provider, else undefined. */
function cashAssignmentId(row: Row): string | undefined {
  if (row.step !== "worker.assignment" || !row.worker_assignment || typeof row.worker_assignment !== "object") return undefined;
  const assignment = row.worker_assignment as { id?: unknown; selected?: { provider?: unknown } };
  return assignment.selected?.provider === "cash" ? text(assignment.id) : undefined;
}

/**
 * The rows a daily measurement reads, chosen by the shared spend rules rather than a step list, so a producer the
 * rules accept (a `review.reviewer` row carrying a model and a cost) is never dropped before the assignment join.
 */
export function isSpendPerMergedInput(row: Row): boolean {
  return row.step === "worker.attempt" || row.step === PR_TERMINAL_STEP || row.step === SPEND_PER_MERGED_DAILY_STEP ||
    isProducedSpendRow(row) || isCashSpendProducer(row) || cashAssignmentId(row) !== undefined;
}

export interface SpendPerMergedDay {
  day: string;
  paid_usd: number;
  merged_prs: number;
  /** null when no PR merged that day: never 0 or Infinity. */
  paid_usd_per_merged_pr: number | null;
  lanes: Record<SpendLane, number>;
  unpriced_rows: number;
  /** The part of `paid_usd` that came from `worker.attempt` api rows with no produced row. */
  attempt_only_usd: number;
}

const usd =(value: number): number => Math.round(value * 1e6) / 1e6;
const DAY_MS = 86_400_000;

/** The UTC day (`YYYY-MM-DD`) of a row's `ts`, or undefined when it has none. */
function utcDayOf(ts: unknown): string | undefined {
  const ms = typeof ts === "string" ? Date.parse(ts) : NaN;
  return Number.isFinite(ms) ? fixedClock(ms).iso().slice(0, 10) : undefined;
}

const LANE_RULES: readonly [RegExp, SpendLane][] = [
  [/judge|shadow/, "judge_shadow"],
  [/gardener/, "gardener"],
  [/inbox|triage|issue_revalidation/, "inbox_triage"],
  [/^retro/, "retro"],
  [/scout/, "scout"],
  [/^review/, "review"],
  [/^(fix|sweep-fix|alert-fix|main-repair|census_push|sweep\.plan_round)/, "fix"],
  [/^(implement|recon|diagnose)/, "implement"],
];
function laneOfName(name: string | undefined): SpendLane {
  if (name === undefined) return "other";
  return LANE_RULES.find(([pattern]) => pattern.test(name))?.[1] ?? "other";
}
/** A produced row's lane comes from its step; a `worker.attempt` row's from the first lane field that names one. */
function spendLaneOf(row: Row): SpendLane {
  if (row.step !== "worker.attempt") return laneOfName(text(row.step));
  const repair = row.repair && typeof row.repair === "object" ? (row.repair as Row).rung : undefined;
  const names = [row.guardrail_lane, row.lane, row.workLane, row.worker_rung, repair].map(text);
  return names.map(laneOfName).find(lane => lane !== "other") ?? "other";
}

const paidProduced = (row: Row): boolean => row.step !== "worker.attempt" && isProducedSpendRow(row) &&
  (row.billing_mode === "api" || row.provider === "cash");
const incompleteUsage = (row: Row): boolean => row.token_usage_state === "partial" || row.token_usage_state === "unavailable";

export function paidSpendPerMergedDay(rows: readonly Row[], utcDay: string): SpendPerMergedDay {
  const lanes = Object.fromEntries(SPEND_LANES.map(lane => [lane, 0])) as Record<SpendLane, number>;
  const idOf = (row: Row): string | undefined => text(row.selection_assignment_id);
  const producedIds = new Set(rows.filter(paidProduced).map(idOf).filter((id): id is string => id !== undefined));
  const unpricedIds = new Set(rows.filter(row => row.step !== "worker.attempt" && isCashSpendProducer(row) &&
    spendAmountUsd(row) === undefined).map(idOf).filter((id): id is string => id !== undefined));
  const cashIds = new Set([...rows.filter(row => row.provider === "cash").map(idOf), ...rows.map(cashAssignmentId)]
    .filter((id): id is string => id !== undefined));
  const countedUnpriced = new Set<string>();
  const merged = new Set<string>();
  let paid = 0, attemptOnly = 0, unpriced = 0, unkeyedMerged = 0;
  for (const row of rows) {
    if (utcDayOf(row.ts) !== utcDay) continue;
    if (row.step === PR_TERMINAL_STEP) {
      if (row.state !== "merged") continue;
      const key = text(row.pr_url) ?? (row.pr_number !== undefined ? `#${String(row.pr_number)}` : undefined);
      if (key === undefined) unkeyedMerged++;
      else merged.add(key);
      continue;
    }
    const id = idOf(row);
    if (row.step === "worker.attempt") {
      const cash = row.provider === "cash" || (id !== undefined && cashIds.has(id));
      if (row.billing_mode !== "api" && !(cash && incompleteUsage(row))) continue;
      if (id !== undefined && unpricedIds.has(id)) continue;
      if (cash && incompleteUsage(row)) {
        if (id === undefined || !countedUnpriced.has(id)) unpriced++;
        if (id !== undefined) countedUnpriced.add(id);
        continue;
      }
    } else if (isCashSpendProducer(row) && spendAmountUsd(row) === undefined) {
      unpriced++;
      continue;
    }
    const amount = spendAmountUsd(row);
    if (amount === undefined) continue;
    if (paidProduced(row)) {
      paid += amount;
      lanes[spendLaneOf(row)] += amount;
    } else if (row.step === "worker.attempt") {
      if (id !== undefined && producedIds.has(id)) continue;
      paid += amount;
      attemptOnly += amount;
      lanes[spendLaneOf(row)] += amount;
    }
  }
  const mergedPrs = merged.size + unkeyedMerged;
  for (const lane of SPEND_LANES) lanes[lane] = usd(lanes[lane]);
  return { day: utcDay, paid_usd: usd(paid), merged_prs: mergedPrs,
    paid_usd_per_merged_pr: mergedPrs > 0 ? usd(paid / mergedPrs) : null,
    lanes, unpriced_rows: unpriced, attempt_only_usd: usd(attemptOnly) };
}

/** The finished UTC days, newest first, from yesterday back `count` days. */
export function finishedUtcDays(nowMs: number, count: number): string[] {
  const today = Date.parse(`${fixedClock(nowMs).iso().slice(0, 10)}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, i) => fixedClock(today - (i + 1) * DAY_MS).iso().slice(0, 10));
}

export interface LatestSpendPerMerged { row: SpendPerMergedDay; median7d: number | null; topLane?: { lane: SpendLane; usd: number } }

/** The newest daily row, the median ratio of the daily rows in the seven days ending on its day, and its largest lane. */
export function latestSpendPerMergedRow(rows: readonly Row[]): LatestSpendPerMerged | undefined {
  const byDay = new Map<string, Row>();
  for (const row of rows) {
    if (row.step !== SPEND_PER_MERGED_DAILY_STEP || typeof row.day !== "string" || typeof row.paid_usd !== "number") continue;
    if (String(byDay.get(row.day)?.ts ?? "") > String(row.ts ?? "")) continue; // the newest row of a day wins, whatever the read order
    byDay.set(row.day, row);
  }
  const days = [...byDay.keys()].sort();
  const newest = days.at(-1);
  if (newest === undefined) return undefined;
  const row = byDay.get(newest)! as unknown as SpendPerMergedDay;
  const from = fixedClock(Date.parse(`${newest}T00:00:00.000Z`) - 6 * DAY_MS).iso().slice(0, 10);
  const ratios = days.filter(day => day >= from).map(day => byDay.get(day)!.paid_usd_per_merged_pr)
    .filter((ratio): ratio is number => typeof ratio === "number" && Number.isFinite(ratio)).sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  const median7d = ratios.length === 0 ? null : ratios.length % 2 === 1 ? ratios[mid]! : usd((ratios[mid - 1]! + ratios[mid]!) / 2);
  const lanes = row.lanes && typeof row.lanes === "object" ? Object.entries(row.lanes) : [];
  const top = lanes.filter(([, value]) => typeof value === "number" && value > 0).sort((a, b) => b[1] - a[1])[0];
  return { row, median7d, ...(top ? { topLane: { lane: top[0] as SpendLane, usd: top[1] } } : {}) };
}

/** The status board's one line: "spend/merged : $X.XXX yesterday (7-day median $Y.YYY), top lane <lane> $Z.ZZ". */
export function renderSpendPerMergedLine(latest: LatestSpendPerMerged, nowMs: number): string {
  const when = latest.row.day === finishedUtcDays(nowMs, 1)[0] ? "yesterday" : `on ${latest.row.day}`;
  const ratio = latest.row.paid_usd_per_merged_pr === null
    ? `no merged PR ${when} ($${latest.row.paid_usd.toFixed(2)} paid)` : `$${latest.row.paid_usd_per_merged_pr.toFixed(3)} ${when}`;
  const median = latest.median7d === null ? "none" : `$${latest.median7d.toFixed(3)}`;
  const top = latest.topLane ? `top lane ${latest.topLane.lane} $${latest.topLane.usd.toFixed(2)}` : "top lane none";
  return `spend/merged : ${ratio} (7-day median ${median}), ${top}`;
}
