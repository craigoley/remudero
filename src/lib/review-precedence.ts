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
 *
 * W1-T15291: the next free worker goes to the oldest waiter, by wait alone. A green head outranks build demand only if it
 * began waiting no later than the build did (a tie goes to the review); a NEW fix round yields to build demand that began
 * before its pull request's wait. The daemon records when build demand began; with none, every answer is W1-T12712's.
 */
import { fixedClock } from "./clock.js";
import { priorBlockersFromLedger } from "./pr-blocker.js";
import { DEFAULT_POLL_INTERVAL_MS } from "./poll-interval.js";

export type ReviewPrecedence = "yield" | "proceed";
/** The lane that yields: the sweep's fix dispatch or the daemon's build dispatch. */
export type PrecedenceLane = "fix" | "build";
export interface WaitingGreenHead { prNumber: number; sinceMs: number }

/** The width reason under which a waiting review takes the next free worker. */
export const PRECEDENCE_WIDTH_REASON = "host-worker-budget";

/** W1-T15291: build demand that began strictly before `waiterSinceMs` has waited longer than that waiter. */
const buildWaitedLonger = (waiterSinceMs: number, buildWaitingSinceMs: number | undefined): boolean =>
  buildWaitingSinceMs !== undefined && Number.isFinite(buildWaitingSinceMs) && buildWaitingSinceMs < waiterSinceMs;

/** The heads that take the next free worker before the build: past one cadence, and waiting no less long than it. */
const outrankingHeads = (heads: readonly WaitingGreenHead[], nowMs: number, cadenceMs: number,
  buildWaitingSinceMs: number | undefined): WaitingGreenHead[] =>
  heads.filter((head) => nowMs - head.sinceMs > cadenceMs && !buildWaitedLonger(head.sinceMs, buildWaitingSinceMs));

/** Pure. `yield` when the width decision's reason is host-worker-budget and a green head has waited for review longer
 *  than one cadence and no less long than the build demand (`buildWaitingSinceMs`, absent when nothing is dispatchable);
 *  `proceed` otherwise (and for a cadence that is not positive). */
export function reviewPrecedence(input: {
  waitingGreenHeads: readonly WaitingGreenHead[]; cadenceMs: number; nowMs: number; widthReason: string | undefined;
  buildWaitingSinceMs?: number;
}): ReviewPrecedence {
  if (input.widthReason !== PRECEDENCE_WIDTH_REASON || !(input.cadenceMs > 0)) return "proceed";
  return outrankingHeads(input.waitingGreenHeads, input.nowMs, input.cadenceMs, input.buildWaitingSinceMs).length > 0
    ? "yield" : "proceed";
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
// W1-T15291: when the daemon's build demand began; the fix-side mirror reads it in the same process.
let buildDemandSinceMs: number | undefined;

/** W1-T15291: the daemon records when dispatchable build demand began, or `undefined` when there is none. */
export function recordBuildDemandSince(sinceMs: number | undefined): void {
  buildDemandSinceMs = sinceMs;
}

/** Decide for one lane and write one `sweep.budget_yield` row when a held spell begins; a proceed ends the spell. */
function decideReviewPrecedence(lane: PrecedenceLane, surface: string, reading: PrecedenceReading, nowMs: number, cadenceMs: number,
  log: Log | undefined, claimant?: number, buildWaitingSinceMs?: number): { decision: ReviewPrecedence; waiting: readonly WaitingGreenHead[] } {
  const heads = reading.heads.filter((head) => head.prNumber !== claimant);
  const decision = reviewPrecedence({ waitingGreenHeads: heads, cadenceMs, nowMs, widthReason: reading.widthReason, buildWaitingSinceMs });
  if (decision === "proceed") {
    heldSpells.delete(lane);
    return { decision, waiting: [] };
  }
  const waiting = outrankingHeads(heads, nowMs, cadenceMs, buildWaitingSinceMs);
  if (!heldSpells.has(lane)) {
    heldSpells.add(lane);
    log?.("sweep.budget_yield", {
      lane, surface, width_reason: reading.widthReason, cadence_ms: cadenceMs,
      waiting_heads: waiting.map((head) => head.prNumber),
      oldest_wait_ms: Math.max(...waiting.map((head) => nowMs - head.sinceMs)),
      ...(buildWaitingSinceMs === undefined ? {} : { build_waiting_since: fixedClock(buildWaitingSinceMs).iso() }),
    });
  }
  return { decision, waiting };
}

const waitingText = (waiting: readonly WaitingGreenHead[]): string =>
  `${waiting.length} green head(s) wait for review longer than one cadence (${waiting.map((head) => `#${head.prNumber}`).join(", ")})` +
  ` and the review width is held by ${PRECEDENCE_WIDTH_REASON}`;

const buildWaitText = (sinceMs: number, nowMs: number): string =>
  `dispatchable build demand has waited ${Math.max(0, Math.floor((nowMs - sinceMs) / 60_000))} min (since ${fixedClock(sinceMs).iso()})`;

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
  const buildSinceMs = buildDemandSinceMs;
  let prior: ReturnType<typeof priorBlockersFromLedger> | undefined;
  return (pr) => {
    const precedence = decideReviewPrecedence("fix", surface, reading, nowMs, DEFAULT_POLL_INTERVAL_MS, log, pr.prNumber);
    if (precedence.decision !== "proceed") {
      return { admitted: false, reason: `review precedence: ${waitingText(precedence.waiting)} — repair remains queued and will be re-derived next pass` };
    }
    // W1-T15291: the fix-side mirror. Under the same width reason, build demand older than this round's wait goes first.
    if (buildSinceMs !== undefined && reading.widthReason === PRECEDENCE_WIDTH_REASON) {
      prior ??= priorBlockersFromLedger(lines);
      const since = prior.get(pr.prNumber)?.since;
      const sinceMs = since === undefined ? Number.NaN : Date.parse(since);
      if (Number.isFinite(sinceMs) && buildWaitedLonger(sinceMs, buildSinceMs)) {
        return { admitted: false, reason: `review precedence: ${buildWaitText(buildSinceMs, nowMs)}, longer than #${pr.prNumber} has waited` +
          ` (since ${since}) and the review width is held by ${PRECEDENCE_WIDTH_REASON} — repair remains queued and will be re-derived next pass` };
      }
    }
    return claim(pr);
  };
}

/** The daemon's build dispatch: a `REVIEW` hold for a new batch or lane refill while the newest sweep reading yields.
 *  A reading older than two cadences is not evidence of a wait: it holds nothing. Other surfaces are never held.
 *  W1-T15291: `buildWaitingSinceMs` is when the daemon's build demand began; a head that began waiting later does not hold. */
export function reviewPrecedenceHold(surface: string, now: number | (() => number), cadenceMs: number, log?: Log,
  buildWaitingSinceMs?: number):
  { control: "REVIEW"; detail: string; reason: string } | undefined {
  if (surface !== "dispatch" && surface !== "lane-refill") return undefined;
  // No sweep reading yet: nothing waits, and the injected clock is not advanced by a question that has no answer.
  if (latestReading === undefined) return undefined;
  const nowMs = typeof now === "function" ? now() : now;
  const fresh = latestReading !== undefined && nowMs - latestReading.atMs <= 2 * cadenceMs;
  const reading = fresh ? latestReading! : { atMs: nowMs, heads: [], widthReason: undefined };
  const precedence = decideReviewPrecedence("build", surface, reading, nowMs, cadenceMs, log, undefined, buildWaitingSinceMs);
  if (precedence.decision === "proceed") return undefined;
  const detail = waitingText(precedence.waiting);
  return { control: "REVIEW", detail, reason: `review precedence hold: ${detail}` };
}
