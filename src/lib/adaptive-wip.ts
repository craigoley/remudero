/**
 * THE QUEUE GOVERNOR'S WIP BOUND FOLLOWS FLOW, STUCK WORK AND HOST HEADROOM — operator ruling
 * 2026-10-09 ("I hate hard ceilings"; "never be left with stuck prs"). The fixed `policy.wipLimit`
 * held every new build for 1–3 h at a time that day while the open fleet PRs were mostly stuck red
 * and merges kept landing. W1-T7243 (#10387) owns every other fixed budget; this module owns the
 * WIP bound only.
 *
 * Three measured inputs, each continuous, none a gate on its own:
 *  - STUCK OWNED PRS do not hold the queue: a PR parked on a blocker no fix lane is moving (or one
 *    past its blocker SLO) is subtracted from the owned count before the bound is compared.
 *  - TRAILING THROUGHPUT loosens the bound: every merge in the governor's flow window adds a slot,
 *    so a queue that is draining fast admits more work (Little's law: WIP follows throughput).
 *  - HOST HEADROOM tightens it: below a comfortable available-memory fraction the bound scales down
 *    continuously; an unreadable reading leaves the bound unscaled and is ledgered as unread.
 * The base `policy.wipLimit` stays the starting point; {@link WIP_BOUND_BACKSTOP_MULTIPLE} is a
 * SAFETY BACKSTOP only, never the mechanism.
 */
import { readFileSync } from "node:fs";

import { BLOCKER_SLO_MS } from "./pr-blocker.js";

/** BACKSTOP ONLY: the adaptive bound never exceeds this multiple of the base limit. */
export const WIP_BOUND_BACKSTOP_MULTIPLE = 3;
/** The available-memory fraction at and above which headroom does not scale the bound. */
export const WIP_HEADROOM_COMFORT_FRACTION = 0.3;
/** The smallest scale low headroom applies; the dispatch memory guard owns the hard stop. */
const WIP_HEADROOM_MIN_SCALE = 0.25;

/** Blockers on which no automated lane is moving the PR right now, whatever their age. */
const PARKED_BLOCKERS = new Set([
  "strikes-exhausted", "escalated", "operator-hold", "plan-proof-unrunnable", "held-draft", "stale-reviewer-withheld",
]);
/** Blockers a lane is working on: stuck only once they outlive the blocker SLO. */
const AGEING_BLOCKERS = new Set(["own-red", "review-failed", "conflict", "base-red", "other"]);

export interface AdaptiveWipInputs {
  baseLimit: number;
  trailingMergedCount?: number;
  /** MemAvailable / MemTotal, or undefined when it could not be read. */
  headroomFraction?: number;
}

/** The adaptive bound: base plus trailing merges, scaled by headroom, capped by the backstop. */
export function adaptiveWipBound(inputs: AdaptiveWipInputs): number {
  const base = Math.max(1, inputs.baseLimit);
  const flowRoom = base + Math.max(0, inputs.trailingMergedCount ?? 0);
  const h = inputs.headroomFraction;
  const scale = h === undefined || !Number.isFinite(h)
    ? 1
    : Math.min(1, Math.max(WIP_HEADROOM_MIN_SCALE, h / WIP_HEADROOM_COMFORT_FRACTION));
  return Math.min(Math.max(1, Math.floor(flowRoom * scale)), base * WIP_BOUND_BACKSTOP_MULTIPLE);
}

/** How many of `ownedPrNumbers` are stuck, from each PR's latest `sweep.disposed` row. A PR with no
 *  disposition row counts as progressing, so an unread signal never frees a slot. */
export function deriveStuckOwnedCount(
  lines: ReadonlyArray<Record<string, unknown>>,
  ownedPrNumbers: readonly number[],
  nowMs: number,
): number {
  const owned = new Set(ownedPrNumbers);
  const latest = new Map<number, Record<string, unknown>>();
  for (const line of lines) {
    if (line.step !== "sweep.disposed" || typeof line.pr_number !== "number" || !owned.has(line.pr_number)) continue;
    latest.set(line.pr_number, line);
  }
  let stuck = 0;
  for (const row of latest.values()) {
    const blocker = typeof row.blocker === "string" ? row.blocker : "";
    if (PARKED_BLOCKERS.has(blocker)) { stuck++; continue; }
    if (!AGEING_BLOCKERS.has(blocker)) continue;
    const ts = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
    const ageAtRow = typeof row.blocker_age_ms === "number" ? row.blocker_age_ms : NaN;
    if (!Number.isFinite(ts) || !Number.isFinite(ageAtRow)) continue;
    if (ageAtRow + Math.max(0, nowMs - ts) >= BLOCKER_SLO_MS) stuck++;
  }
  return stuck;
}

/** MemAvailable / MemTotal from a /proc/meminfo-shaped file; throws when either line is absent. */
export function readMemoryHeadroomFraction(path = "/proc/meminfo"): number {
  const text = readFileSync(path, "utf8");
  const total = /^MemTotal:\s*(\d+)\s*kB\s*$/m.exec(text);
  const available = /^MemAvailable:\s*(\d+)\s*kB\s*$/m.exec(text);
  if (!total || !available || Number(total[1]) <= 0) throw new Error(`${path}: no MemTotal/MemAvailable pair`);
  return Number(available[1]) / Number(total[1]);
}

export interface AdaptiveQueueFlowInputs {
  lines: ReadonlyArray<Record<string, unknown>>;
  ownedPrNumbers?: readonly number[];
  nowMs: number;
  baseLimit: number;
  trailingMergedCount: number;
  /** Throws (unreadable) or returns the fraction; the throw is recorded as an unread reading. */
  readHeadroom: () => number;
}

export interface AdaptiveQueueFlow {
  stuckOwnedCount: number;
  headroomFraction: number | undefined;
  headroomUnread: boolean;
  adaptiveBound: number;
}

/** Everything the production dispatch gate hands {@link checkQueueGovernor} besides the counts. */
export function assembleAdaptiveQueueFlow(inputs: AdaptiveQueueFlowInputs): AdaptiveQueueFlow {
  let headroomFraction: number | undefined;
  let headroomUnread = false;
  try {
    headroomFraction = inputs.readHeadroom();
  } catch {
    headroomUnread = true;
  }
  const stuckOwnedCount = inputs.ownedPrNumbers === undefined
    ? 0
    : deriveStuckOwnedCount(inputs.lines, inputs.ownedPrNumbers, inputs.nowMs);
  return {
    stuckOwnedCount,
    headroomFraction,
    headroomUnread,
    adaptiveBound: adaptiveWipBound({
      baseLimit: inputs.baseLimit, trailingMergedCount: inputs.trailingMergedCount, headroomFraction,
    }),
  };
}
