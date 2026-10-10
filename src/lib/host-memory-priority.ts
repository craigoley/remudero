/**
 * lib/host-memory-priority.ts — W1-T7095: WHO WOULD HAVE WAITED, counterfactually, under a host-wide memory budget.
 *
 * Review precedence exists only inside one instance today (sweep.ts reserves review width before fixes, W1-T3202).
 * Across instances nothing orders work. This module answers the question an enforcement ruling needs, from the shadow
 * verdict's own snapshot: would a non-review start have yielded to a review, and would any class or instance starve?
 *
 * (1) DEMAND. Each instance's sweep publishes its eligible review demand (count, lane-ready count, oldest eligible-since)
 *     as one JSON row in `review-demand/` inside the W1-T7093 ledger directory. A row past its refresh bound is STALE:
 *     it stops counting as eligible and is never deleted.
 * (2) COUNTERFACTUAL YIELD. {@link wouldYieldToReview} says yield ONLY when a fresh, queued, lane-ready review exists,
 *     that review's own verdict in the SAME snapshot defers for a host-memory reason alone, and this start yielding
 *     would make it fit. No eligible review, or one held by anything else, never holds a build.
 * (3) FAIRNESS. Demand is ordered by class weight times aged wait ({@link priorityScore}), so an older build outranks a
 *     newer review and no instance is overtaken indefinitely. Weights and the aging rate are PROPOSALS.
 * (4) DIAGNOSTICS. Routine would-be deferrals collapse to one machine row per (class, instance, reason). Only a
 *     SUSTAINED zero-worker shortfall becomes one human decision per scenario, naming the levers and choosing none.
 *
 * SHADOW ONLY: nothing here delays, rejects or reorders a real start. Every function that touches the filesystem
 * catches its own failure; the pure rules take no clock and no fs.
 */

import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { systemClock, type Clock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";
import { defaultInstance, type LedgerInstance, type WorkerClass } from "./host-memory-ledger.js";
import { resolveTestSlotDir } from "./test-slot.js";

// ── policy: every value a proposal ───────────────────────────────────────────────────────────────────────────────

export const HOST_MEMORY_PRIORITY_ORIGIN = "proposal";

export interface HostMemoryPriorityPolicy {
  origin: typeof HOST_MEMORY_PRIORITY_ORIGIN;
  /** Relative class weight. Review outranks a build of EQUAL wait; aging lets an older build outrank a newer review. */
  classWeight: Readonly<Record<WorkerClass, number>>;
  /** How fast a wait raises its score: score = weight * (1 + agingPerMinute * minutes waited). Zero disables aging. */
  agingPerMinute: number;
  /** A published demand row older than this is stale and stops counting as eligible. */
  demandRefreshBoundMs: number;
  /** Consecutive zero-worker-shortfall samples, per scenario, before one human decision is raised. */
  zeroWorkerShortfallSamples: number;
}

/** PROPOSALS, to be calibrated from the would-be wait distribution the shadow rows report — never a ruling. */
export const HOST_MEMORY_PRIORITY_PROPOSAL: HostMemoryPriorityPolicy = {
  origin: HOST_MEMORY_PRIORITY_ORIGIN,
  classWeight: { review: 3, fix: 2, implement: 1, unclassified: 1 },
  agingPerMinute: 0.05,
  demandRefreshBoundMs: 5 * 60_000,
  zeroWorkerShortfallSamples: 6,
};

// ── (3) fairness: weight times aged wait (pure) ──────────────────────────────────────────────────────────────────

export interface WaitingDemand {
  instance: string;
  workerClass: WorkerClass;
  /** When this demand started waiting (ms epoch). */
  waitingSinceMs: number;
}

/** Class weight times aged wait. Monotone in wait, so every waiting demand eventually outranks any newer one. */
export function priorityScore(demand: WaitingDemand, policy: HostMemoryPriorityPolicy, now: number): number {
  const minutes = Math.max(0, now - demand.waitingSinceMs) / 60_000;
  return policy.classWeight[demand.workerClass] * (1 + policy.agingPerMinute * minutes);
}

/** Highest score first; ties go to the older wait, then the instance name, so the order is total and stable. */
export function rankDemand<T extends WaitingDemand>(demands: readonly T[], policy: HostMemoryPriorityPolicy, now: number): T[] {
  return [...demands].sort((a, b) =>
    priorityScore(b, policy, now) - priorityScore(a, policy, now) ||
    a.waitingSinceMs - b.waitingSinceMs ||
    a.instance.localeCompare(b.instance));
}

// ── (1) demand: published by each sweep, read by every shadow verdict ────────────────────────────────────────────

export const REVIEW_DEMAND_SUBDIR = "review-demand";

/** What one sweep pass knows about its own spawning-lane reviews. */
export interface ReviewDemand {
  /** Reviews the instance's own selection rule counts eligible (post-review, outcome not already known). */
  eligible: number;
  /** Of those, how many a review lane admits right now: the ones only memory could still hold. */
  laneReady: number;
  /** The oldest eligible-since among them (ISO), or null with none. */
  oldestEligibleSince: string | null;
}

export interface ReviewDemandRow extends ReviewDemand {
  schema: 1;
  instance: string;
  instanceHostUnique: boolean;
  publishedAt: string;
  refreshBoundMs: number;
}

export interface ObservedDemand extends ReviewDemandRow {
  stale: boolean;
  ageMs: number;
}

export interface ReviewDemandReading {
  /** A missing directory is "missing", never an empty healthy one; an unreadable one is named. */
  state: "present" | "missing" | "unreadable";
  reason?: string;
  rows: ObservedDemand[];
  unreadableRows: number;
}

export interface ReviewDemandOptions {
  /** The W1-T7093 ledger directory. Default: `<test slot dir>/host-memory`, as the ledger itself. */
  location?: () => { dir: string; scope: "host" | "local" };
  root?: string;
  instance?: (root: string) => LedgerInstance;
  clock?: Clock;
  policy?: HostMemoryPriorityPolicy;
  write?: (path: string, content: string) => void;
  read?: (path: string) => string;
  list?: (dir: string) => string[];
  log?: (event: Record<string, unknown>) => void;
}

function defaultLedgerLocation(): { dir: string; scope: "host" | "local" } {
  const slot = resolveTestSlotDir();
  return { dir: join(slot.dir, "host-memory"), scope: slot.scope === "configured" || slot.scope === "host-scratch" ? "host" : "local" };
}

function demandDir(opts: ReviewDemandOptions): string {
  return join((opts.location ?? defaultLedgerLocation)().dir, REVIEW_DEMAND_SUBDIR);
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function reasonOf(error: unknown): string {
  return errnoOf(error) ?? String((error as Error)?.message ?? error).slice(0, 120);
}

const demandDiagnosticsSeen = new Set<string>();

function diagnose(opts: ReviewDemandOptions, op: string, reason: string): void {
  const key = `${op}:${reason}`;
  if (demandDiagnosticsSeen.has(key)) return;
  demandDiagnosticsSeen.add(key);
  try {
    opts.log?.({ event: "memory_budget.review_demand_error", op, reason });
  } catch (logError) {
    void logError; // The diagnostic of a diagnostic: the sweep must not hear of it.
  }
}

/** One instance's file name: its instance name, with anything outside a safe set replaced. */
export function reviewDemandFileName(instance: string): string {
  return `${instance.replace(/[^A-Za-z0-9._-]/g, "_") || "_"}.json`;
}

/**
 * Publish this instance's eligible review demand, replacing its previous row. Called from each sweep pass. NEVER throws:
 * a failure logs one deduplicated diagnostic and returns undefined, and the sweep proceeds unchanged.
 */
export function publishReviewDemand(demand: ReviewDemand, opts: ReviewDemandOptions = {}): ReviewDemandRow | undefined {
  try {
    const root = opts.root ?? join(homedir(), "Remudero");
    const instance = (opts.instance ?? defaultInstance)(root);
    const clock = opts.clock ?? systemClock;
    const policy = opts.policy ?? HOST_MEMORY_PRIORITY_PROPOSAL;
    const row: ReviewDemandRow = {
      schema: 1,
      instance: instance.name,
      instanceHostUnique: instance.hostUnique,
      eligible: Math.max(0, Math.trunc(demand.eligible)),
      laneReady: Math.max(0, Math.min(Math.trunc(demand.laneReady), Math.trunc(demand.eligible))),
      oldestEligibleSince: demand.oldestEligibleSince,
      publishedAt: new Date(clock.now()).toISOString(),
      refreshBoundMs: policy.demandRefreshBoundMs,
    };
    const path = join(demandDir(opts), reviewDemandFileName(instance.name));
    const write = opts.write ?? ((target: string, content: string) => {
      mkdirSync(dirname(target), { recursive: true });
      writeAtomic(target, content);
    });
    write(path, `${JSON.stringify(row)}\n`);
    return row;
  } catch (error) {
    const reason = reasonOf(error);
    diagnose(opts, "publish", reason);
    return undefined;
  }
}

function shapedRow(raw: unknown): ReviewDemandRow | undefined {
  const row = raw as ReviewDemandRow | undefined;
  const ok = row?.schema === 1 && typeof row.instance === "string" && Number.isFinite(row.eligible) &&
    Number.isFinite(row.laneReady) && typeof row.publishedAt === "string" && Number.isFinite(Date.parse(row.publishedAt)) &&
    Number.isFinite(row.refreshBoundMs) && (row.oldestEligibleSince === null || typeof row.oldestEligibleSince === "string");
  return ok ? row : undefined;
}

/** Every instance's demand row, each marked stale or fresh against its own refresh bound. Writes nothing. NEVER throws. */
export function readReviewDemand(opts: ReviewDemandOptions = {}): ReviewDemandReading {
  const now = (opts.clock ?? systemClock).now();
  let dir: string;
  let names: string[];
  try {
    dir = demandDir(opts);
    names = (opts.list ?? ((d: string) => readdirSync(d)))(dir).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { state: "missing", reason: "no review demand has been published", rows: [], unreadableRows: 0 };
    diagnose(opts, "list", reasonOf(error));
    return { state: "unreadable", reason: reasonOf(error), rows: [], unreadableRows: 0 };
  }
  const read = opts.read ?? ((path: string) => readFileSync(path, "utf8"));
  const rows: ObservedDemand[] = [];
  let unreadableRows = 0;
  for (const name of names) {
    try {
      const row = shapedRow(JSON.parse(read(join(dir, name))));
      if (!row) {
        unreadableRows += 1;
        continue;
      }
      const ageMs = Math.max(0, now - Date.parse(row.publishedAt));
      rows.push({ ...row, ageMs, stale: ageMs > row.refreshBoundMs });
    } catch (error) {
      void error; // Torn or foreign: counted, left in place, never deleted.
      unreadableRows += 1;
    }
  }
  return { state: "present", rows, unreadableRows };
}

const eligibleSince = new Map<string, number>();

/**
 * The oldest eligible-since among `keys` (one per eligible review head), as this process first observed each. A key no
 * longer eligible is forgotten, so a head that leaves and returns waits afresh. Returns null with no keys.
 */
export function trackEligibleSince(keys: readonly string[], now: number): string | null {
  const current = new Set(keys);
  for (const key of [...eligibleSince.keys()]) if (!current.has(key)) eligibleSince.delete(key);
  let oldest: number | undefined;
  for (const key of current) {
    const since = eligibleSince.get(key) ?? now;
    eligibleSince.set(key, since);
    oldest = oldest === undefined ? since : Math.min(oldest, since);
  }
  return oldest === undefined ? null : new Date(oldest).toISOString();
}

// ── (2) the counterfactual yield (pure) ──────────────────────────────────────────────────────────────────────────

/** The shadow reasons a yield could cure: the shared host budget. Swap-in, PSI and a container ceiling (another
 *  container's, for a review elsewhere) are held by something one yield in this snapshot does not change. */
export const HOST_MEMORY_REASONS: ReadonlySet<string> = new Set(["memory-available", "unrealized-reservations", "uncertainty"]);

export const WOULD_YIELD_TO_REVIEW = "would-yield-to-review";

export type YieldRefusal =
  | "start-is-review"
  | "demand-unread"
  | "no-eligible-review"
  | "demand-stale"
  | "review-lane-busy"
  | "review-started"
  | "review-fits"
  | "review-blocked-by-other"
  | "yield-would-not-fit"
  | "start-outranks-review";

export type YieldDecision =
  | {
    yield: true;
    to: { instance: string; waitingSinceMs: number; score: number };
    startScore: number;
    reviewReasons: string[];
  }
  | { yield: false; why: YieldRefusal; detail?: string; startScore?: number; reviewScore?: number };

/** A minimal verdict shape, so this module never imports the shadow recorder that consults it. */
export interface CounterfactualVerdict {
  wouldAdmit: boolean;
  reasons: readonly string[];
}

export interface YieldContext {
  start: WaitingDemand;
  demand: ReviewDemandReading;
  /** Reservations in the same snapshot: a review opened since a demand row was published is no longer queued. */
  reservations: ReadonlyArray<{ owner: string; workerClass: WorkerClass; ageMs?: number }>;
  /** The queued review's own verdict in THIS snapshot: with this start counted, or with it yielded. */
  reviewVerdict: (withStart: boolean) => CounterfactualVerdict;
  policy: HostMemoryPriorityPolicy;
  now: number;
}

/** Lane-ready reviews in `row` not yet started: lane-ready minus the review reservations opened since it was published. */
export function queuedReviews(row: ObservedDemand, reservations: YieldContext["reservations"]): number {
  const started = reservations.filter((r) =>
    r.workerClass === "review" && r.owner.split("@")[0] === row.instance &&
    r.ageMs !== undefined && r.ageMs <= row.ageMs).length;
  return Math.max(0, row.laneReady - started);
}

/**
 * Would this non-review start have yielded to a review? ONLY when, in the same snapshot, some instance has a fresh,
 * queued, lane-ready review; that review's own verdict defers for host-memory reasons alone; this start yielding makes
 * it fit; and the review's aged priority outranks the start's. Every refusal is named.
 */
export function wouldYieldToReview(ctx: YieldContext): YieldDecision {
  const { start, policy, now } = ctx;
  if (start.workerClass === "review") return { yield: false, why: "start-is-review" };
  if (ctx.demand.state === "unreadable") return { yield: false, why: "demand-unread", detail: ctx.demand.reason };
  const wanting = ctx.demand.rows.filter((row) => row.eligible > 0);
  const fresh = wanting.filter((row) => !row.stale);
  if (fresh.length === 0) {
    return wanting.length > 0
      ? { yield: false, why: "demand-stale", detail: wanting.map((row) => `${row.instance}: ${Math.round(row.ageMs / 1000)}s old`).join(", ") }
      : { yield: false, why: "no-eligible-review" };
  }
  const ready = fresh.filter((row) => row.laneReady > 0);
  if (ready.length === 0) return { yield: false, why: "review-lane-busy", detail: fresh.map((row) => row.instance).join(", ") };
  const queued = ready.filter((row) => queuedReviews(row, ctx.reservations) > 0 && row.oldestEligibleSince !== null);
  if (queued.length === 0) return { yield: false, why: "review-started" };

  const withStart = ctx.reviewVerdict(true);
  if (withStart.wouldAdmit) return { yield: false, why: "review-fits" };
  const other = withStart.reasons.filter((reason) => !HOST_MEMORY_REASONS.has(reason));
  if (other.length > 0) return { yield: false, why: "review-blocked-by-other", detail: other.join(", ") };
  if (!ctx.reviewVerdict(false).wouldAdmit) return { yield: false, why: "yield-would-not-fit" };

  const reviews = rankDemand(queued.map((row): WaitingDemand => ({
    instance: row.instance,
    workerClass: "review",
    waitingSinceMs: Date.parse(row.oldestEligibleSince!),
  })), policy, now);
  const top = reviews[0]!;
  const reviewScore = priorityScore(top, policy, now);
  const startScore = priorityScore(start, policy, now);
  if (rankDemand([start, top], policy, now)[0] === start) {
    return { yield: false, why: "start-outranks-review", startScore, reviewScore };
  }
  return {
    yield: true,
    to: { instance: top.instance, waitingSinceMs: top.waitingSinceMs, score: reviewScore },
    startScore,
    reviewReasons: [...withStart.reasons],
  };
}

// ── (4a) routine deferrals: one machine row per (class, instance, reason) ────────────────────────────────────────

export interface DeferralEvent {
  workerClass: WorkerClass;
  instance: string;
  reason: string;
  /** The would-be wait so far, for the distribution a reader can query. */
  waitMs: number;
}

export interface DeferralSummaryRow {
  workerClass: WorkerClass;
  instance: string;
  reason: string;
  count: number;
  owner: "machine";
  escalate: false;
  waitMs: { p50: number; p90: number; max: number };
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

const keyOfDeferral = (e: Pick<DeferralEvent, "workerClass" | "instance" | "reason">): string =>
  `${e.workerClass}\u0000${e.instance}\u0000${e.reason}`;

/** Collapse deferrals to one summary row per (class, instance, reason), with its would-be wait distribution. Pure. */
export function summarizeDeferrals(events: readonly DeferralEvent[]): DeferralSummaryRow[] {
  const groups = new Map<string, DeferralEvent[]>();
  for (const event of events) {
    const key = keyOfDeferral(event);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups.values()].map((group) => {
    const waits = group.map((e) => e.waitMs).sort((a, b) => a - b);
    const first = group[0]!;
    return {
      workerClass: first.workerClass,
      instance: first.instance,
      reason: first.reason,
      count: group.length,
      owner: "machine",
      escalate: false,
      waitMs: { p50: quantile(waits, 0.5), p90: quantile(waits, 0.9), max: waits.at(-1) ?? 0 },
    };
  });
}

/** BACKSTOP per key on the retained wait samples; the count keeps growing past it. */
const DEFERRAL_SAMPLE_CAP = 512;

export interface DeferralDiagnostics {
  /** Record one deferral; `first` is true only for the first of its (class, instance, reason) in this process. */
  observe(event: DeferralEvent): { first: boolean };
  /** The queryable report: one row per key with its count and wait distribution. */
  report(): DeferralSummaryRow[];
}

export function createDeferralDiagnostics(): DeferralDiagnostics {
  const byKey = new Map<string, { events: DeferralEvent[]; count: number }>();
  return {
    observe(event) {
      const key = keyOfDeferral(event);
      const seen = byKey.get(key);
      if (seen) {
        seen.count += 1;
        if (seen.events.length < DEFERRAL_SAMPLE_CAP) seen.events.push(event);
        return { first: false };
      }
      byKey.set(key, { events: [event], count: 1 });
      return { first: true };
    },
    report() {
      return [...byKey.values()].map(({ events, count }) => ({ ...summarizeDeferrals(events)[0]!, count }));
    },
  };
}

// ── (4b) a sustained zero-worker shortfall: one human decision per scenario ──────────────────────────────────────

export interface ZeroWorkerSample {
  scenario: string;
  memAvailableMib: number | null;
  /** rss+swap of every worker tree in the ledger: what MemAvailable would regain with zero workers. */
  workersResidentMib: number;
  daemonGrowthMib: number;
  coldStartReserveMib: number;
  hostReserveMib: number;
}

/** MiB the host would still lack with ZERO workers, or undefined when it fits (or headroom was unread). */
export function zeroWorkerShortfallMib(sample: ZeroWorkerSample): number | undefined {
  if (sample.memAvailableMib === null) return undefined;
  const zeroWorkerAvailable = sample.memAvailableMib + sample.workersResidentMib - sample.daemonGrowthMib - sample.coldStartReserveMib;
  const shortfall = sample.hostReserveMib - zeroWorkerAvailable;
  return shortfall > 0 ? shortfall : undefined;
}

export const SHORTFALL_LEVERS = [
  "a smaller service baseline (serve or a daemon)",
  "less concurrency (fewer instances or narrower lanes)",
  "more RAM for the host",
] as const;

export interface CapacityDecision {
  scenario: string;
  shortfallMib: number;
  shortfallGb: number;
  samples: number;
  levers: readonly string[];
}

export interface ShortfallTracker {
  /** One sample; returns a decision exactly once per scenario, when its shortfall has been sustained. */
  observe(sample: ZeroWorkerSample, policy: HostMemoryPriorityPolicy): CapacityDecision | undefined;
}

export function createShortfallTracker(): ShortfallTracker {
  const streak = new Map<string, { samples: number; worstMib: number }>();
  const raised = new Set<string>();
  return {
    observe(sample, policy) {
      const shortfall = zeroWorkerShortfallMib(sample);
      if (shortfall === undefined) {
        streak.delete(sample.scenario);
        return undefined;
      }
      const s = streak.get(sample.scenario) ?? { samples: 0, worstMib: 0 };
      s.samples += 1;
      s.worstMib = Math.max(s.worstMib, shortfall);
      streak.set(sample.scenario, s);
      if (s.samples < policy.zeroWorkerShortfallSamples || raised.has(sample.scenario)) return undefined;
      raised.add(sample.scenario);
      return {
        scenario: sample.scenario,
        shortfallMib: s.worstMib,
        shortfallGb: Math.round((s.worstMib / 1024) * 10) / 10,
        samples: s.samples,
        levers: SHORTFALL_LEVERS,
      };
    },
  };
}

/** The decision's words for the existing escalation path: the shortfall in GB and every lever, recommending none. */
export function capacityDecisionText(d: CapacityDecision): {
  taskId: string;
  summary: string;
  detail: string;
  options: Array<{ label: string; detail: string }>;
  recommendation: string;
} {
  return {
    taskId: `MEMORY-CAPACITY-${d.scenario}`,
    // STABLE per scenario (no number): the escalation path dedups on the title.
    summary: `host memory cannot fit zero workers in scenario ${d.scenario}`,
    detail:
      `Shadow evidence (counterfactual, nothing was held): in scenario ${d.scenario} the measured service baselines plus ` +
      `that scenario's serve reserve leave the host ${d.shortfallGb} GB short of its reserve with ZERO workers, across ` +
      `${d.samples} consecutive samples. This is a capacity choice; the fleet does not choose a lever.`,
    options: d.levers.map((lever) => ({ label: lever, detail: `close the ${d.shortfallGb} GB shortfall with ${lever}` })),
    recommendation: "none: the operator chooses the lever",
  };
}

const pendingDecisions: CapacityDecision[] = [];

/** The shadow recorder queues a decision; the sweep, which owns an escalation gateway, drains it. */
export function queueCapacityDecision(decision: CapacityDecision): void {
  if (!pendingDecisions.some((d) => d.scenario === decision.scenario)) pendingDecisions.push(decision);
}

export function takeCapacityDecisions(): CapacityDecision[] {
  return pendingDecisions.splice(0, pendingDecisions.length);
}

export function resetHostMemoryPriorityStateForTests(): void {
  demandDiagnosticsSeen.clear();
  eligibleSince.clear();
  pendingDecisions.length = 0;
}
