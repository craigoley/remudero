/**
 * lib/review-precedence.ts — W1-T12712: a green pull request waiting for review gets the next free worker before a
 * new fix or build worker starts.
 *
 * The host worker budget is one pool. Fix rounds (sweep.ts) and build lanes (daemon.ts) took it first come, first
 * served, so a green head one review away from merge waited behind them. While the review width is held at
 * host-worker-budget and a green head has waited longer than one sweep cadence, a NEW fix round or build lane yields.
 *
 * - no-starvation: the hold lasts only while such a head waits; the first pass with none starts the held work.
 * - in-flight-untouched: this module only answers "start or wait". It never stops or pauses a running worker.
 * - The budget value does not change. This orders who starts next; it adds no limit.
 */
import { priorBlockersFromLedger } from "./pr-blocker.js";
import { DEFAULT_POLL_INTERVAL_MS } from "./poll-interval.js";

export type ReviewPrecedence = "yield" | "proceed";
/** The lane that yields: the sweep's fix dispatch or the daemon's build dispatch. */
export type PrecedenceLane = "fix" | "build";
export interface WaitingGreenHead { prNumber: number; sinceMs: number }

/** The width reason under which a waiting review takes the next free worker. */
export const PRECEDENCE_WIDTH_REASON = "host-worker-budget";

/** Pure. `yield` when the width decision's reason is host-worker-budget and a green head has waited for review longer
 *  than one cadence; `proceed` otherwise (and for a cadence that is not positive). */
export function reviewPrecedence(input: {
  waitingGreenHeads: readonly WaitingGreenHead[]; cadenceMs: number; nowMs: number; widthReason: string | undefined;
}): ReviewPrecedence {
  if (input.widthReason !== PRECEDENCE_WIDTH_REASON || !(input.cadenceMs > 0)) return "proceed";
  return input.waitingGreenHeads.some((head) => input.nowMs - head.sinceMs > input.cadenceMs) ? "yield" : "proceed";
}

type Row = Record<string, unknown>;
type Log = (step: string, extra?: Record<string, unknown>) => void;
type HeadView = { prNumber: number; headSha: string; checksState: string };

/** The green heads in `prs` whose newest `sweep.disposed` row names `awaiting-review` at the same head, with the
 *  time that wait began (`blocker_since`). A head with no readable start is left out. */
export function waitingGreenHeadsFromLedger(lines: readonly Row[], prs: readonly HeadView[]): WaitingGreenHead[] {
  if (prs.length === 0) return [];
  const prior = priorBlockersFromLedger(lines);
  const heads: WaitingGreenHead[] = [];
  for (const pr of prs) {
    const blocker = prior.get(pr.prNumber);
    const sinceMs = blocker?.since === undefined ? Number.NaN : Date.parse(blocker.since);
    if (pr.checksState !== "green" || blocker?.blocker !== "awaiting-review" || !Number.isFinite(sinceMs)) continue;
    if (blocker.headSha === undefined || blocker.headSha === pr.headSha) heads.push({ prNumber: pr.prNumber, sinceMs });
  }
  return heads;
}

/** The reason of the newest `review.capacity` row: the last width decision. */
export function lastWidthReasonFromLedger(lines: readonly Row[]): string | undefined {
  const row = lines.findLast((line) => line.step === "review.capacity" && typeof line.reason === "string");
  return row?.reason as string | undefined;
}

interface PrecedenceReading { atMs: number; heads: readonly WaitingGreenHead[]; widthReason: string | undefined }

// One process holds one daemon and its sweep passes. The newest sweep reading is what the build dispatch decides on.
let latestReading: PrecedenceReading | undefined;
const heldSpells = new Set<PrecedenceLane>();

/** Decide for one lane and write one `sweep.budget_yield` row when a held spell begins; a proceed ends the spell. */
function decideReviewPrecedence(lane: PrecedenceLane, surface: string, reading: PrecedenceReading, nowMs: number, cadenceMs: number,
  log: Log | undefined, claimant?: number): { decision: ReviewPrecedence; waiting: readonly WaitingGreenHead[] } {
  const heads = reading.heads.filter((head) => head.prNumber !== claimant);
  const decision = reviewPrecedence({ waitingGreenHeads: heads, cadenceMs, nowMs, widthReason: reading.widthReason });
  if (decision === "proceed") {
    heldSpells.delete(lane);
    return { decision, waiting: [] };
  }
  const waiting = heads.filter((head) => nowMs - head.sinceMs > cadenceMs);
  if (!heldSpells.has(lane)) {
    heldSpells.add(lane);
    log?.("sweep.budget_yield", {
      lane, surface, width_reason: reading.widthReason, cadence_ms: cadenceMs,
      waiting_heads: waiting.map((head) => head.prNumber),
      oldest_wait_ms: Math.max(...waiting.map((head) => nowMs - head.sinceMs)),
    });
  }
  return { decision, waiting };
}

const waitingText = (waiting: readonly WaitingGreenHead[]): string =>
  `${waiting.length} green head(s) wait for review longer than one cadence (${waiting.map((head) => `#${head.prNumber}`).join(", ")})` +
  ` and the review width is held by ${PRECEDENCE_WIDTH_REASON}`;

type FixClaim<P> = (pr: P) => { admitted: true; release?: () => void } | { admitted: false; reason: string };

/**
 * The sweep's fix admission with review precedence in front of it. `waiting` is the pass's review queue (the heads
 * eligible for review); `admitted` are those this pass already gave a review lane, so they do not wait. Each call
 * records the pass's reading for the build dispatch. A yield refuses only the NEW round: the claim is not consulted,
 * so a reservation already granted is never touched, and the repair re-derives next pass. No claim: no change.
 */
export function yieldingFixClaim<P extends { prNumber: number }>(surface: string, claim: FixClaim<P>, lines: readonly Row[],
  nowMs: number, log: Log | undefined, waiting: readonly HeadView[], admitted?: readonly { prNumber: number }[]): FixClaim<P>;
export function yieldingFixClaim<P extends { prNumber: number }>(surface: string, claim: FixClaim<P> | undefined,
  lines: readonly Row[], nowMs: number, log: Log | undefined, waiting: readonly HeadView[],
  admitted?: readonly { prNumber: number }[]): FixClaim<P> | undefined;
export function yieldingFixClaim<P extends { prNumber: number }>(surface: string, claim: FixClaim<P> | undefined,
  lines: readonly Row[], nowMs: number, log: Log | undefined, waiting: readonly HeadView[],
  admitted: readonly { prNumber: number }[] = []): FixClaim<P> | undefined {
  if (claim === undefined) return undefined;
  const lanes = new Set(admitted.map((pr) => pr.prNumber));
  const reading: PrecedenceReading = {
    atMs: nowMs,
    heads: waitingGreenHeadsFromLedger(lines, waiting.filter((pr) => !lanes.has(pr.prNumber))),
    widthReason: lastWidthReasonFromLedger(lines),
  };
  latestReading = reading;
  return (pr) => {
    const precedence = decideReviewPrecedence("fix", surface, reading, nowMs, DEFAULT_POLL_INTERVAL_MS, log, pr.prNumber);
    if (precedence.decision === "proceed") return claim(pr);
    return { admitted: false, reason: `review precedence: ${waitingText(precedence.waiting)} — repair remains queued and will be re-derived next pass` };
  };
}

/** The daemon's build dispatch: a `REVIEW` hold for a new batch or lane refill while the newest sweep reading yields.
 *  A reading older than two cadences is not evidence of a wait: it holds nothing. Other surfaces are never held. */
export function reviewPrecedenceHold(surface: string, nowMs: number, cadenceMs: number, log?: Log):
  { control: "REVIEW"; detail: string; reason: string } | undefined {
  if (surface !== "dispatch" && surface !== "lane-refill") return undefined;
  const fresh = latestReading !== undefined && nowMs - latestReading.atMs <= 2 * cadenceMs;
  const reading = fresh ? latestReading! : { atMs: nowMs, heads: [], widthReason: undefined };
  const precedence = decideReviewPrecedence("build", surface, reading, nowMs, cadenceMs, log);
  if (precedence.decision === "proceed") return undefined;
  const detail = waitingText(precedence.waiting);
  return { control: "REVIEW", detail, reason: `review precedence hold: ${detail}` };
}
