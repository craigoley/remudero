/**
 * lib/host-memory-shadow.ts — W1-T7094: a COUNTERFACTUAL host-memory admission verdict for every real worker start.
 *
 * OBSERVED 2026-10-09: three daemon containers and serve share one 16.8 GB host, a container sat with 4.0 GB in swap,
 * and serve (5-6 GB steady, 7.5 GB in a cold start) could not restart without heavy swap-in. Whether a host-wide budget
 * would have protected serve, and what throughput it would cost, is unknown. This module answers "would this start
 * have fit?" for each start that HAPPENED, so enforcement can be ruled on from measurements rather than guesses.
 *
 * THE VERDICT NEVER GATES ITS OWN START. It is computed after the start is committed, synchronously, inside try/catch,
 * and its result is never read by the caller. The policy mode is "off", "shadow" or "enforce"; the shipped mode is
 * "shadow". Under "enforce" a SEPARATE call before the start (host-memory-admission.ts) evaluates the same snapshot and
 * may wait; switching to it is an operator ruling, made by editing plan/policy.yaml.
 *
 * NO DOUBLE COUNT. A worker tree's resident memory is already inside MemAvailable and the container's memory.current,
 * so a reservation counts only its UNREALIZED part: max(0, estimate - the tree's current rss+swap).
 *
 * NEVER WAITS. No lock is taken; a ledger reader that reports a held lock (EWOULDBLOCK/EAGAIN/EBUSY), an errno, or a
 * missing/unreadable/reset store yields a verdict naming that state as an uncertainty that WIDENS the margin. It is
 * never read as zero reservations. File reads are bounded (a ledger tail, a capped process count).
 */

import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { systemClock, type Clock } from "./clock.js";
import { sampleCgroupMemory } from "./daemon-memory-telemetry.js";
import {
  DEFAULT_ESTIMATE_MIB,
  defaultInstance,
  parseProcStat,
  readMemoryLedger,
  type EstimateSource,
  type HostMemoryReading,
  type ProcessIdentity,
  type ReadingStatus,
  type WorkerClass,
} from "./host-memory-ledger.js";
import {
  HOST_MEMORY_PRIORITY_PROPOSAL,
  WOULD_YIELD_TO_REVIEW,
  createDeferralDiagnostics,
  createShortfallTracker,
  queueCapacityDecision,
  readReviewDemand,
  wouldYieldToReview,
  type HostMemoryPriorityPolicy,
  type ReviewDemandReading,
  type YieldDecision,
} from "./host-memory-priority.js";
import { classEstimate } from "./host-memory-learning.js";
import { DAEMON_PID_ENV, type LedgerLine } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { installPolicyPath } from "./policy.js";

export const SHADOW_STEP = "memory_budget.shadow";
export const SHADOW_ERROR_STEP = "memory_budget.shadow_error";
export const SHADOW_SUMMARY_STEP = "memory_budget.shadow_summary";
/** W1-T7095: one machine-owned row per (class, instance, reason) of would-be deferral. Never an escalation. */
export const SHADOW_DEFERRAL_STEP = "memory_budget.deferral_summary";
/** W1-T7095: a sustained zero-worker shortfall, queued once per scenario for the sweep's escalation path. */
export const SHADOW_SHORTFALL_DECISION_STEP = "memory_budget.capacity_decision";

// ── policy ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The ONLY modes. "enforce" is acted on by host-memory-admission.ts, before a start; this module only records. */
export const SHADOW_MODES = ["off", "shadow", "enforce"] as const;
export type ShadowMode = (typeof SHADOW_MODES)[number];
/** Every threshold is a proposal, to be calibrated from shadow rows — never a ruling. */
export const HOST_MEMORY_BUDGET_ORIGIN = "proposal";

export interface HostMemoryBudgetPolicy {
  mode: ShadowMode;
  /** MemAvailable the host must keep after every projected claim. */
  hostReserveMib: number;
  /** memory.max - memory.current this container must keep after its own unrealized reservations. */
  containerReserveMib: number;
  /** Swap-in, pages per second (pswpin delta), above which a start would have waited. */
  swapInPagesPerSecMax: number;
  psiSomeAvg10Max: number;
  psiFullAvg10Max: number;
  /** Held in reserve while serve is cold-starting (a supervisor start or handoff open in the ledger). */
  serveColdStartReserveMib: number;
  /** The widening one named uncertainty adds. */
  uncertaintyMarginMib: number;
  /** The daemon growth assumed for an instance whose history is too short or unreadable. */
  daemonGrowthUnmeasuredMib: number;
  /** daemon.alive rows in the last hour below which growth is "unmeasured". */
  daemonGrowthMinSamples: number;
  /** A prior swap-in sample older than this is stale: the rate is reported unmeasured. */
  staleReadingMs: number;
}

const NUMERIC_KEYS = [
  "hostReserveMib", "containerReserveMib", "swapInPagesPerSecMax", "psiSomeAvg10Max", "psiFullAvg10Max",
  "serveColdStartReserveMib", "uncertaintyMarginMib", "daemonGrowthUnmeasuredMib", "daemonGrowthMinSamples",
  "staleReadingMs",
] as const satisfies ReadonlyArray<keyof HostMemoryBudgetPolicy>;

function mapping(path: string, raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`policy.yaml: '${path}' must be a mapping.`);
  }
  return raw as Record<string, unknown>;
}

function proposalOrigin(path: string, row: Record<string, unknown>): void {
  if (row.origin !== HOST_MEMORY_BUDGET_ORIGIN) {
    throw new Error(
      `policy.yaml: '${path}.origin' must be "${HOST_MEMORY_BUDGET_ORIGIN}", got ${JSON.stringify(row.origin)}.`,
    );
  }
}

/** Validate `sweep.hostMemoryBudget`. The mode accepts only "off", "shadow" or "enforce"; anything else throws. */
export function parseHostMemoryBudgetPolicy(raw: unknown): HostMemoryBudgetPolicy {
  const base = "sweep.hostMemoryBudget";
  const block = mapping(base, raw);
  const modeRow = mapping(`${base}.mode`, block.mode);
  proposalOrigin(`${base}.mode`, modeRow);
  if (!SHADOW_MODES.includes(modeRow.value as ShadowMode)) {
    throw new Error(
      `policy.yaml: '${base}.mode' accepts only "off", "shadow" or "enforce", got ${JSON.stringify(modeRow.value)}.`,
    );
  }
  const out: Partial<HostMemoryBudgetPolicy> = { mode: modeRow.value as ShadowMode };
  for (const key of NUMERIC_KEYS) {
    const path = `${base}.${key}`;
    const row = mapping(path, block[key]);
    proposalOrigin(path, row);
    const { value, min, max } = row;
    if (typeof value !== "number" || typeof min !== "number" || typeof max !== "number" ||
      ![value, min, max].every(Number.isFinite) || value < min || value > max) {
      throw new Error(`policy.yaml: '${path}' must be a finite value inside finite [min, max].`);
    }
    out[key] = value;
  }
  return out as HostMemoryBudgetPolicy;
}

let cachedPolicy: HostMemoryBudgetPolicy | undefined;

/** The shipped `sweep.hostMemoryBudget`, read once per process. Throws on an invalid block; the recorder catches it. */
export function loadHostMemoryBudgetPolicy(path: string = installPolicyPath()): HostMemoryBudgetPolicy {
  if (!cachedPolicy) {
    const doc = mapping("policy.yaml", parseYaml(readFileSync(path, "utf8")));
    cachedPolicy = parseHostMemoryBudgetPolicy(mapping("sweep", doc.sweep).hostMemoryBudget);
  }
  return cachedPolicy;
}

// ── the verdict (pure) ────────────────────────────────────────────────────────────────────────────────────────────

export type ServeScenario = "serve-stopped" | "serve-steady" | "serve-cold-start" | "unknown";
export const SERVE_SCENARIOS: readonly ServeScenario[] = ["serve-stopped", "serve-steady", "serve-cold-start", "unknown"];

export type ShadowReason =
  | "memory-available" | "swap-in" | "psi" | "container-ceiling" | "unrealized-reservations" | "uncertainty"
  /** W1-T7095: the start would have yielded to a queued review that memory alone held (see host-memory-priority.ts). */
  | typeof WOULD_YIELD_TO_REVIEW;

/** Every ledger state the reader can report, plus the two the shadow reader adds for a held lock or a thrown errno. */
export type ShadowLedgerState = HostMemoryReading["state"] | "lock-held" | "error";

export interface ShadowEntryInput {
  id: string;
  owner: string;
  workerClass: WorkerClass;
  estimateMib: number;
  estimateSource: EstimateSource;
  status: ReadingStatus;
  walkComplete: boolean | null;
  /** The tree's current rss+swap, or why it could not be read (then the full estimate counts). */
  resident: { mib: number; complete: boolean; reason?: string } | { unread: string };
  /** Since the reservation opened. W1-T7095 reads it to tell a review started since its demand row was published. */
  ageMs?: number;
  /** Its work has ended: what its tree still holds is resident, and it can claim nothing more. */
  occupancyReleased?: boolean;
}

export interface ShadowInputs {
  memAvailable: { mib: number } | { unread: string };
  swapIn: { pagesPerSec: number } | { unmeasured: string };
  psi: { someAvg10: number; someAvg60: number; fullAvg10?: number; fullAvg60?: number } | { unread: string };
  /** `highMib` is memory.high (reclaim and throttling begin there); `reclaimableMib` is inactive_file, page cache the
   *  kernel drops before it swaps anonymous memory. Both are optional, and absent means not subtracted. */
  container: { currentMib: number; maxMib: number | null; highMib?: number | null; reclaimableMib?: number } | { unread: string };
  ledger: { state: ShadowLedgerState; reason?: string };
  entries: ShadowEntryInput[];
  /** The start this verdict is about. Its own reservation is counted even when the ledger could not show it. */
  start: { reservationId?: string; workerClass: WorkerClass; estimateMib: number };
  /** `own` marks this container's daemon, whose growth also counts against the container ceiling. */
  daemonGrowth: Array<{ instance: string; samples: number; growthMib?: number; reason?: string; basis?: string; own?: boolean }>;
  serve: { scenario: ServeScenario; basis: string };
  /** The learned review estimate, for the counterfactual review (W1-T7095). Absent: the class default. */
  reviewEstimateMib?: number;
}

export interface ShadowUncertainty {
  kind: string;
  count: number;
  marginMib: number;
  detail?: string[];
}

export interface ShadowVerdict {
  wouldAdmit: boolean;
  reasons: ShadowReason[];
  scenario: ServeScenario;
  uncertainty: ShadowUncertainty[];
  numbers: {
    memAvailableMib: number | null;
    unrealizedMib: number;
    unrealizedOwnContainerMib: number;
    daemonGrowthMib: number;
    coldStartReserveMib: number;
    marginMib: number;
    projectedAvailableMib: number | null;
    hostReserveMib: number;
    swapInPagesPerSec: number | null;
    psi: { someAvg10: number; someAvg60: number; fullAvg10?: number; fullAvg60?: number } | null;
    containerCurrentMib: number | null;
    containerMaxMib: number | null;
    containerHeadroomMib: number | null;
    /** min(memory.max, memory.high): where this container's reclaim begins. */
    containerCeilingMib: number | null;
    /** memory.current less reclaimable page cache: the memory the ceiling is measured against. */
    containerWorkingSetMib: number | null;
    containerReserveMib: number;
    /** Container memory no reservation's resident tree accounts for: gardens, measurement children, read-model threads. */
    unreservedContainerMib: number | null;
    unreservedContainerShare: number | null;
  };
}

const DETAIL_CAP = 8;

/** Decide the counterfactual from one snapshot. Pure: no clock, no fs. */
export function evaluateShadowMemory(inputs: ShadowInputs, policy: HostMemoryBudgetPolicy): ShadowVerdict {
  const named = new Map<string, ShadowUncertainty>();
  const widen = (kind: string, marginMib: number, detail?: string): void => {
    const u = named.get(kind) ?? { kind, count: 0, marginMib: 0 };
    u.count += 1;
    u.marginMib += marginMib;
    if (detail !== undefined) {
      u.detail ??= [];
      if (u.detail.length < DETAIL_CAP) u.detail.push(detail);
    }
    named.set(kind, u);
  };
  const margin = policy.uncertaintyMarginMib;

  if (inputs.ledger.state !== "present") widen(`ledger-${inputs.ledger.state}`, margin, inputs.ledger.reason);

  let unrealized = 0;
  let unrealizedOwn = 0;
  let residentOwn = 0;
  for (const entry of inputs.entries) {
    let resident = 0;
    if ("unread" in entry.resident) widen("tree-unread", 0, `${entry.id}: ${entry.resident.unread}`);
    else {
      resident = entry.resident.mib;
      if (!entry.resident.complete) widen("tree-partial", margin, `${entry.id}: ${entry.resident.reason ?? "partial"}`);
    }
    // A released occupancy's tree can only shrink: its resident memory is already measured, so it claims nothing more.
    const share = entry.occupancyReleased ? 0 : Math.max(0, entry.estimateMib - resident);
    unrealized += share;
    if (entry.status === "owned") {
      unrealizedOwn += share;
      residentOwn += resident;
    }
    if (entry.estimateSource.kind === "default-unmeasured" && !entry.occupancyReleased) widen("unmeasured-estimate", margin, entry.id);
    if (entry.status === "uncertain") widen("uncertain-entry", margin, entry.id);
    if (entry.walkComplete === false) widen("incomplete-walk", margin, entry.id);
  }
  const startSeen = inputs.start.reservationId !== undefined &&
    inputs.entries.some((entry) => entry.id === inputs.start.reservationId);
  if (!startSeen) {
    // The start's own claim is counted in full even when the ledger cannot show it: never zero reservations.
    unrealized += inputs.start.estimateMib;
    unrealizedOwn += inputs.start.estimateMib;
    widen("start-unrecorded", 0, inputs.start.reservationId ?? "no reservation id");
  }

  let daemonGrowth = 0;
  let ownDaemonGrowth = 0;
  for (const growth of inputs.daemonGrowth) {
    if (growth.growthMib !== undefined) {
      daemonGrowth += growth.growthMib;
      if (growth.own) ownDaemonGrowth += growth.growthMib;
    } else widen("daemon-growth-unmeasured", policy.daemonGrowthUnmeasuredMib,
      `${growth.instance}: ${growth.reason ?? `${growth.samples} sample(s)`}`);
  }

  const scenario = inputs.serve.scenario;
  const coldStartReserve = scenario === "serve-cold-start" ? policy.serveColdStartReserveMib : 0;
  if (scenario === "unknown") widen("serve-scenario-unknown", margin, inputs.serve.basis);

  const reasons = new Set<ShadowReason>();
  let swapIn: number | null = null;
  if ("unmeasured" in inputs.swapIn) widen("swap-in-unmeasured", margin, inputs.swapIn.unmeasured);
  else {
    swapIn = inputs.swapIn.pagesPerSec;
    if (swapIn > policy.swapInPagesPerSecMax) reasons.add("swap-in");
  }
  const psi = "unread" in inputs.psi ? null : inputs.psi;
  if (psi === null) widen("psi-unread", margin, (inputs.psi as { unread: string }).unread);
  else if (psi.someAvg10 > policy.psiSomeAvg10Max || (psi.fullAvg10 ?? 0) > policy.psiFullAvg10Max) reasons.add("psi");

  let containerCurrent: number | null = null;
  let containerMax: number | null = null;
  let containerHeadroom: number | null = null;
  let containerCeiling: number | null = null;
  let containerWorkingSet: number | null = null;
  if ("unread" in inputs.container) widen("container-unread", margin, inputs.container.unread);
  else {
    containerCurrent = inputs.container.currentMib;
    containerMax = inputs.container.maxMib;
    const limits = [containerMax, inputs.container.highMib ?? null].filter((v): v is number => v !== null);
    containerWorkingSet = Math.max(0, containerCurrent - (inputs.container.reclaimableMib ?? 0));
    if (limits.length > 0) {
      containerCeiling = Math.min(...limits);
      containerHeadroom = containerCeiling - containerWorkingSet - unrealizedOwn - ownDaemonGrowth;
      if (containerHeadroom < policy.containerReserveMib) reasons.add("container-ceiling");
    }
  }

  let memAvailable: number | null = null;
  let projected: number | null = null;
  if ("unread" in inputs.memAvailable) widen("meminfo-unread", margin, inputs.memAvailable.unread);
  const marginMib = [...named.values()].reduce((sum, u) => sum + u.marginMib, 0);
  if ("mib" in inputs.memAvailable) {
    memAvailable = inputs.memAvailable.mib;
    // Staged so each reason names what tipped it: measured headroom alone, then unrealized claims, then uncertainty.
    const base = memAvailable - daemonGrowth - coldStartReserve;
    projected = base - unrealized - marginMib;
    if (base < policy.hostReserveMib) reasons.add("memory-available");
    else if (base - unrealized < policy.hostReserveMib) reasons.add("unrealized-reservations");
    else if (projected < policy.hostReserveMib) reasons.add("uncertainty");
  } else {
    reasons.add("uncertainty"); // No measured headroom: a fit cannot be shown.
  }

  const unreserved = containerCurrent === null ? null : Math.max(0, containerCurrent - residentOwn);
  return {
    wouldAdmit: reasons.size === 0,
    reasons: [...reasons],
    scenario,
    uncertainty: [...named.values()],
    numbers: {
      memAvailableMib: memAvailable,
      unrealizedMib: unrealized,
      unrealizedOwnContainerMib: unrealizedOwn,
      daemonGrowthMib: daemonGrowth,
      coldStartReserveMib: coldStartReserve,
      marginMib,
      projectedAvailableMib: projected,
      hostReserveMib: policy.hostReserveMib,
      swapInPagesPerSec: swapIn,
      psi,
      containerCurrentMib: containerCurrent,
      containerMaxMib: containerMax,
      containerHeadroomMib: containerHeadroom,
      containerCeilingMib: containerCeiling,
      containerWorkingSetMib: containerWorkingSet,
      containerReserveMib: policy.containerReserveMib,
      unreservedContainerMib: unreserved,
      unreservedContainerShare: unreserved === null || !containerCurrent ? null : unreserved / containerCurrent,
    },
  };
}

// ── the counterfactual review (pure, W1-T7095) ──────────────────────────────────────────────────────────────────

/**
 * The verdict a queued review would get in THIS snapshot: with the current start's claim counted (`withStart`), or with
 * the start yielded (its reservation absent). The review is a hypothetical start at the review class estimate.
 */
export function counterfactualReviewVerdict(inputs: ShadowInputs, policy: HostMemoryBudgetPolicy, withStart: boolean): ShadowVerdict {
  const own = inputs.start;
  const recorded = own.reservationId !== undefined && inputs.entries.some((entry) => entry.id === own.reservationId);
  let entries = inputs.entries;
  if (!withStart) entries = entries.filter((entry) => own.reservationId === undefined || entry.id !== own.reservationId);
  else if (!recorded) {
    // Counted in full, exactly as the start's own verdict counts an unrecorded start (no widening for it).
    entries = [...entries, {
      id: own.reservationId ?? "counterfactual-start", owner: "start", workerClass: own.workerClass,
      estimateMib: own.estimateMib, estimateSource: { kind: "measured", samples: 0 }, status: "owned", walkComplete: true,
      resident: { mib: 0, complete: true },
    }];
  }
  return evaluateShadowMemory({
    ...inputs,
    entries,
    start: { workerClass: "review", estimateMib: inputs.reviewEstimateMib ?? DEFAULT_ESTIMATE_MIB.review },
  }, policy);
}

// ── per-scenario validity (pure) ──────────────────────────────────────────────────────────────────────────────────

export type ShadowTally = Record<ServeScenario, { samples: number; admit: number; defer: number }>;

export function emptyShadowTally(): ShadowTally {
  return Object.fromEntries(SERVE_SCENARIOS.map((s) => [s, { samples: 0, admit: 0, defer: 0 }])) as ShadowTally;
}

/** Per-scenario counts, never pooled: serve-stopped samples say nothing about serve coexisting with the fleet. A scenario
 *  with no samples is "unvalidated", never passing. */
export function summarizeShadowTally(tally: ShadowTally): Record<ServeScenario, {
  samples: number; admit: number; defer: number; validity: "unvalidated" | "sampled";
}> {
  return Object.fromEntries(SERVE_SCENARIOS.map((s) => {
    const t = tally[s];
    return [s, { ...t, validity: t.samples === 0 ? "unvalidated" : "sampled" }];
  })) as ReturnType<typeof summarizeShadowTally>;
}

// ── inputs (impure, bounded) ──────────────────────────────────────────────────────────────────────────────────────

const MIB = 1024 * 1024;
/** BACKSTOP on the ledger tail read for daemon.alive and serve rows; an hour of heartbeats fits in a fraction. */
export const LEDGER_TAIL_BYTES = 4 * MIB;
/** BACKSTOP on processes read across every tree. A tree past it is reported partial, never resident-zero. */
export const MAX_TREE_PROCESSES = 1_024;
const HOUR_MS = 60 * 60_000;
/** A supervisor start or handoff with no closing row within this long is no longer read as a cold start. */
const COLD_START_OPEN_MAX_MS = 15 * 60_000;
/** Three serve.memory periods (3 min each) of silence read as serve stopped. */
const SERVE_SILENT_AFTER_MS = 9 * 60_000;
const SERVE_OPEN = new Set(["serve.supervisor_start", "serve.handoff_requested", "serve.generation_forked", "serve.cold_start_degraded"]);
const SERVE_CLOSE = new Set([
  "serve.cold_start_ready", "serve.cold_start_failed", "serve.handoff_done", "serve.handoff_aborted", "serve.handoff_failed",
  "serve.handoff_skipped", "serve.handoff_deferred", "serve.handoff_legacy_exit",
]);
const LOCK_CODES = new Set(["EWOULDBLOCK", "EAGAIN", "EBUSY"]);

export interface ShadowStart {
  runId?: string;
  taskId?: string;
  workerClass: WorkerClass;
  reservationId?: string;
  /** Default: the ledger's unmeasured class estimate, which is what the start's reservation recorded. */
  estimateMib?: number;
  /** The state root: the ledger names its instance (see `instance`), and its ledger holds daemon.alive and serve rows. */
  root: string;
}

export interface ShadowMemoryPorts {
  clock: Clock;
  nowNs: () => bigint;
  readFile: (path: string) => string;
  readTail: (path: string, maxBytes: number) => string;
  readLedger: (root: string) => HostMemoryReading | undefined;
  policy: () => HostMemoryBudgetPolicy;
  /** The row sink. Undefined: no sink was installed, and the verdict is not computed at all. */
  write: ((ledgerPath: string, row: LedgerLine) => void) | undefined;
  /** W1-T7095: every instance's published review demand, from the shared ledger directory. */
  readReviewDemand: () => ReviewDemandReading;
  priorityPolicy: () => HostMemoryPriorityPolicy;
  stderr: (line: string) => void;
  /** This state root's instance name, AS THE LEDGER NAMES IT (the host-side mount), so its own entries read as its own. */
  instance: (root: string) => string;
  /** The daemon main process's pid, whose /proc status measures its growth. Undefined: none known to this process. */
  daemonPid: () => number | undefined;
  /** The state directory's names, for the newest rotation stamp (how far back the live ledger's own rows reach). */
  listStateDir: (dir: string) => string[];
  /** A class's learned estimate (host-memory-learning.ts). */
  estimate: (workerClass: WorkerClass) => number;
}

let installedSink: ShadowMemoryPorts["write"];
let priorSwapIn: { at: number; pswpin: number } | undefined;
let tally = emptyShadowTally();
let lastState: { scenario: ServeScenario; wouldAdmit: boolean } | undefined;
const errorSeen = new Map<string, number>();
/** W1-T7095: per (instance, class), since when this process's starts would have been waiting. Cleared on an admit. */
const wouldWaitSince = new Map<string, number>();
let deferrals = createDeferralDiagnostics();
let shortfalls = createShortfallTracker();

/** run-task.ts installs the ledger appender once per process; a process without one computes nothing. */
export function installShadowMemorySink(sink: ShadowMemoryPorts["write"]): void {
  installedSink = sink;
}

export function resetShadowMemoryStateForTests(): void {
  priorSwapIn = undefined;
  tally = emptyShadowTally();
  lastState = undefined;
  errorSeen.clear();
  wouldWaitSince.clear();
  deferrals = createDeferralDiagnostics();
  shortfalls = createShortfallTracker();
}

/** W1-T7095: the queryable would-be wait distribution, one row per (class, instance, reason). */
export function shadowDeferralReport(): ReturnType<typeof deferrals.report> {
  return deferrals.report();
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function reasonOf(error: unknown): string {
  return errnoOf(error) ?? String((error as Error)?.message ?? error).slice(0, 120);
}

/** The last `maxBytes` of a file, so a large ledger costs one bounded read. */
export function defaultReadTail(path: string, maxBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const text = buf.toString("utf8");
    return length < size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/** The real ports: /proc, cgroup, the shared ledger and the installed row sink. */
export function defaultShadowMemoryPorts(): ShadowMemoryPorts {
  return {
    clock: systemClock,
    nowNs: () => process.hrtime.bigint(),
    readFile: (path) => readFileSync(path, "utf8"),
    readTail: defaultReadTail,
    readLedger: (root) => readMemoryLedger({ root }),
    policy: () => loadHostMemoryBudgetPolicy(),
    write: installedSink,
    stderr: (line) => console.error(line),
    readReviewDemand: () => readReviewDemand(),
    priorityPolicy: () => HOST_MEMORY_PRIORITY_PROPOSAL,
    instance: (root) => defaultInstance(root).name,
    daemonPid: () => {
      const pid = Number(process.env[DAEMON_PID_ENV]);
      return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    },
    listStateDir: (dir) => readdirSync(dir),
    estimate: (workerClass) => classEstimate(workerClass).estimateMib,
  };
}

function readMemAvailable(read: ShadowMemoryPorts["readFile"]): ShadowInputs["memAvailable"] {
  try {
    const kb = /^MemAvailable:\s+(\d+)\s+kB/m.exec(read("/proc/meminfo"))?.[1];
    return kb === undefined ? { unread: "no MemAvailable line" } : { mib: Number(kb) / 1024 };
  } catch (error) {
    const reason = reasonOf(error);
    return { unread: reason };
  }
}

function readSwapIn(read: ShadowMemoryPorts["readFile"], now: number, staleMs: number): ShadowInputs["swapIn"] {
  let pswpin: number;
  try {
    const raw = /^pswpin\s+(\d+)/m.exec(read("/proc/vmstat"))?.[1];
    if (raw === undefined) return { unmeasured: "no pswpin line" };
    pswpin = Number(raw);
  } catch (error) {
    const reason = reasonOf(error);
    return { unmeasured: reason };
  }
  const prior = priorSwapIn;
  priorSwapIn = { at: now, pswpin };
  if (!prior) return { unmeasured: "first sample in this process" };
  const seconds = (now - prior.at) / 1000;
  if (seconds <= 0) return { unmeasured: "no elapsed time since the prior sample" };
  if (now - prior.at > staleMs) return { unmeasured: `stale: prior sample ${Math.round(seconds)}s old` };
  return { pagesPerSec: Math.max(0, pswpin - prior.pswpin) / seconds };
}

function readPsi(read: ShadowMemoryPorts["readFile"]): ShadowInputs["psi"] {
  let text: string;
  try {
    text = read("/proc/pressure/memory");
  } catch (error) {
    const reason = reasonOf(error);
    return { unread: reason };
  }
  const field = (prefix: string, key: string): number | undefined => {
    const line = text.split("\n").find((l) => l.startsWith(`${prefix} `));
    const m = line?.match(new RegExp(`\\b${key}=([0-9.]+)`));
    return m ? Number(m[1]) : undefined;
  };
  const someAvg10 = field("some", "avg10");
  const someAvg60 = field("some", "avg60");
  if (someAvg10 === undefined || someAvg60 === undefined) return { unread: "unparseable" };
  const fullAvg10 = field("full", "avg10");
  const fullAvg60 = field("full", "avg60");
  return {
    someAvg10, someAvg60,
    ...(fullAvg10 !== undefined ? { fullAvg10 } : {}),
    ...(fullAvg60 !== undefined ? { fullAvg60 } : {}),
  };
}

function readContainer(read: ShadowMemoryPorts["readFile"]): ShadowInputs["container"] {
  const cg = sampleCgroupMemory(read, "/sys/fs/cgroup");
  if (cg.cg_memory_current_bytes === undefined || cg.cg_memory_max_bytes === undefined) {
    return { unread: cg.mem_cgroup ?? "memory.current or memory.max absent" };
  }
  return {
    currentMib: cg.cg_memory_current_bytes / MIB,
    maxMib: cg.cg_memory_max_bytes === null ? null : cg.cg_memory_max_bytes / MIB,
    ...containerReclaim(read),
  };
}

/** memory.high and inactive_file. Either one unreadable is simply absent: the ceiling stays memory.max and nothing is
 *  subtracted, which can only make the verdict stricter. */
function containerReclaim(read: ShadowMemoryPorts["readFile"]): { highMib?: number | null; reclaimableMib?: number } {
  const out: { highMib?: number | null; reclaimableMib?: number } = {};
  try {
    const high = read("/sys/fs/cgroup/memory.high").trim();
    if (high === "max") out.highMib = null;
    else if (/^\d+$/.test(high)) out.highMib = Number(high) / MIB;
  } catch (error) {
    void error; // No memory.high (cgroup v1, or none set): the ceiling is memory.max alone.
  }
  try {
    const bytes = /^inactive_file (\d+)$/m.exec(read("/sys/fs/cgroup/memory.stat"))?.[1];
    if (bytes !== undefined) out.reclaimableMib = Number(bytes) / MIB;
  } catch (error) {
    void error; // Unreadable memory.stat: page cache is counted as used, never subtracted on a guess.
  }
  return out;
}

/** The ledger reading, with a held lock or an errno carried as a named state — never an empty, healthy ledger. */
function readLedgerState(ports: ShadowMemoryPorts, root: string): { reading?: HostMemoryReading; state: ShadowLedgerState; reason?: string } {
  let reading: HostMemoryReading | undefined;
  try {
    reading = ports.readLedger(root);
  } catch (error) {
    const code = errnoOf(error);
    return { state: code && LOCK_CODES.has(code) ? "lock-held" : "error", reason: reasonOf(error) };
  }
  if (!reading) return { state: "error", reason: "the ledger reader failed (see its diagnostic)" };
  const code = reading.reason ? /\b(E[A-Z]{2,})\b/.exec(reading.reason)?.[1] : undefined;
  return { reading, state: reading.state, ...(reading.reason ? { reason: code ?? reading.reason } : {}) };
}

/** rss+swap of one recorded tree, verifying each (pid, start) so a reused pid is never counted. */
function treeResident(
  read: ShadowMemoryPorts["readFile"],
  entryPath: string,
  budget: { left: number },
): ShadowEntryInput["resident"] {
  let tree: ProcessIdentity[];
  try {
    const parsed = JSON.parse(read(entryPath)) as { tree?: ProcessIdentity[]; roots?: ProcessIdentity[] };
    const seen = new Set<string>();
    tree = [...(parsed.roots ?? []), ...(parsed.tree ?? [])].filter((p) => {
      const key = `${p.pid}:${p.start}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch (error) {
    const reason = reasonOf(error);
    return { unread: reason };
  }
  let kb = 0;
  for (const identity of tree) {
    if (budget.left <= 0) return { mib: kb / 1024, complete: false, reason: `process cap ${MAX_TREE_PROCESSES}` };
    budget.left -= 1;
    try {
      const stat = parseProcStat(read(`/proc/${identity.pid}/stat`));
      if (!stat || stat.zombie || (identity.start !== "unknown" && stat.start !== identity.start)) continue;
      const status = read(`/proc/${identity.pid}/status`);
      kb += Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) + Number(/^VmSwap:\s+(\d+)/m.exec(status)?.[1] ?? 0);
    } catch (error) {
      void error; // Gone between the listing and the read: it holds nothing now.
    }
  }
  return { mib: kb / 1024, complete: true };
}

interface TailRow { step: string; at: number; bytes?: number }

function readTailRows(ports: ShadowMemoryPorts, root: string): { rows: TailRow[]; earliestMs?: number } | { unread: string } {
  let text: string;
  try {
    text = ports.readTail(join(root, "state", LEDGER_FILENAME), LEDGER_TAIL_BYTES);
  } catch (error) {
    const reason = reasonOf(error);
    return { unread: reason };
  }
  const rows: TailRow[] = [];
  const first = /^\{"ts":"([^"]+)"/m.exec(text)?.[1];
  const earliestMs = first === undefined ? undefined : Date.parse(first);
  for (const line of text.split("\n")) {
    if (!line.includes("\"daemon.alive\"") && !line.includes("\"serve.")) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const at = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
      if (typeof row.step !== "string" || !Number.isFinite(at)) continue;
      const rss = typeof row.rss_bytes === "number" ? row.rss_bytes : undefined;
      const swap = typeof row.vm_swap_bytes === "number" ? row.vm_swap_bytes : 0;
      rows.push({ step: row.step, at, ...(rss !== undefined ? { bytes: rss + swap } : {}) });
    } catch (error) {
      void error; // A torn tail line: skipped, it is one heartbeat among many.
    }
  }
  return { rows: rows.sort((a, b) => a.at - b.at), ...(Number.isFinite(earliestMs) ? { earliestMs } : {}) };
}

const ROTATION_STAMP = /^ledger\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.ndjson(?:\.gz)?$/;

/** The newest rotation stamp in the state directory: rows older than it at the head of the live ledger were CARRIED
 *  over a rotation, so they say nothing about what the ledger saw before it. Undefined when unreadable or none. */
export function newestRotationMs(names: readonly string[]): number | undefined {
  let newest: number | undefined;
  for (const name of names) {
    const m = ROTATION_STAMP.exec(name);
    if (!m) continue;
    const at = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
    if (Number.isFinite(at) && (newest === undefined || at > newest)) newest = at;
  }
  return newest;
}

/**
 * How long, up to now, the ledger tail covers CONTIGUOUSLY: since the later of its first row and the newest rotation.
 * A live ledger begins with rows carried over the last rotation, whose old stamps would otherwise fake a long window.
 */
export function tailCoverageMs(earliestMs: number | undefined, rotationMs: number | undefined, now: number): number | undefined {
  if (earliestMs === undefined) return undefined;
  return Math.max(0, now - Math.max(earliestMs, rotationMs ?? earliestMs));
}

/** The daemon main process's growth allowance from its own /proc status: VmHWM, the resident peak it has already
 *  reached, less VmRSS now. Undefined when the status is unreadable. */
export function daemonGrowthFromStatus(status: string): { growthMib: number; peakMib: number; residentMib: number } | undefined {
  const hwm = /^VmHWM:\s+(\d+)\s+kB/m.exec(status)?.[1];
  const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
  if (hwm === undefined || rss === undefined) return undefined;
  return { growthMib: Math.max(0, Number(hwm) - Number(rss)) / 1024, peakMib: Number(hwm) / 1024, residentMib: Number(rss) / 1024 };
}

/** max - current main-process rss+swap over the last hour, or "unmeasured" with too few rows. */
export function daemonGrowthOf(rows: readonly TailRow[], now: number, minSamples: number): { samples: number; growthMib?: number; reason?: string } {
  const recent = rows.filter((r) => r.step === "daemon.alive" && r.bytes !== undefined && now - r.at <= HOUR_MS);
  if (recent.length < minSamples) return { samples: recent.length, reason: `${recent.length} daemon.alive row(s) in the last hour` };
  const peak = Math.max(...recent.map((r) => r.bytes!));
  return { samples: recent.length, growthMib: Math.max(0, peak - recent.at(-1)!.bytes!) / MIB };
}

/**
 * The serve scenario read from serve's own rows in the ledger tail (serve shares its daemon's state root). With no serve
 * row at all, serve is STOPPED once the tail covers more than three serve.memory periods; a shorter window (a fresh
 * rotation) cannot tell stopped from not-yet-written, and says unknown.
 */
export function serveScenarioOf(rows: readonly TailRow[], now: number, coverageMs?: number): ShadowInputs["serve"] {
  const serve = rows.filter((r) => r.step.startsWith("serve."));
  if (serve.length === 0) {
    if (coverageMs !== undefined && coverageMs > SERVE_SILENT_AFTER_MS) {
      return { scenario: "serve-stopped", basis: `no serve rows in ${Math.round(coverageMs / 1000)}s of ledger` };
    }
    const covered = coverageMs === undefined ? "" : ` (it covers ${Math.round(coverageMs / 1000)}s)`;
    return { scenario: "unknown", basis: `no serve rows in the ledger tail${covered}` };
  }
  const transitions = serve.filter((r) => SERVE_OPEN.has(r.step) || SERVE_CLOSE.has(r.step));
  const lastTransition = transitions.at(-1);
  if (lastTransition && SERVE_OPEN.has(lastTransition.step) && now - lastTransition.at <= COLD_START_OPEN_MAX_MS) {
    return { scenario: "serve-cold-start", basis: `${lastTransition.step} open` };
  }
  const last = serve.at(-1)!;
  if (last.step === "serve.stop") return { scenario: "serve-stopped", basis: "serve.stop" };
  const age = now - last.at;
  if (age <= SERVE_SILENT_AFTER_MS) return { scenario: "serve-steady", basis: `${last.step} ${Math.round(age / 1000)}s ago` };
  return { scenario: "serve-stopped", basis: `serve silent ${Math.round(age / 1000)}s` };
}

/** One bounded snapshot for one start. */
export function gatherShadowInputs(start: ShadowStart, ports: ShadowMemoryPorts, policy: HostMemoryBudgetPolicy): ShadowInputs {
  const now = ports.clock.now();
  const ledger = readLedgerState(ports, start.root);
  const budget = { left: MAX_TREE_PROCESSES };
  const entries: ShadowEntryInput[] = (ledger.reading?.entries ?? []).map((entry) => ({
    id: entry.id,
    owner: entry.owner,
    workerClass: entry.workerClass,
    estimateMib: entry.estimateMib,
    estimateSource: entry.estimateSource,
    status: entry.status,
    walkComplete: entry.walkComplete,
    resident: treeResident(ports.readFile, entry.path, budget),
    ageMs: entry.ageMs,
    ...(entry.occupancyReleased ? { occupancyReleased: true } : {}),
  }));
  const instance = instanceOf(ports, start.root);
  const tail = readTailRows(ports, start.root);
  const own = { ...ownDaemonGrowth(ports, tail, now, policy), instance, own: true };
  // Another instance's heartbeats live in its own ledger, out of reach from here: named, never assumed flat.
  const others = [...new Set(entries.map((e) => e.owner.split("@")[0]!))].filter((name) => name !== instance)
    .map((name) => ({ instance: name, samples: 0, reason: "its daemon.alive rows are not readable from this instance" }));
  return {
    memAvailable: readMemAvailable(ports.readFile),
    swapIn: readSwapIn(ports.readFile, now, policy.staleReadingMs),
    psi: readPsi(ports.readFile),
    container: readContainer(ports.readFile),
    ledger: { state: ledger.state, ...(ledger.reason ? { reason: ledger.reason } : {}) },
    entries,
    start: {
      ...(start.reservationId ? { reservationId: start.reservationId } : {}),
      workerClass: start.workerClass,
      estimateMib: start.estimateMib ?? estimateOf(ports, start.workerClass),
    },
    daemonGrowth: [own, ...others],
    serve: "unread" in tail
      ? { scenario: "unknown", basis: `ledger tail unreadable: ${tail.unread}` }
      : serveScenarioOf(tail.rows, now, tailCoverageMs(tail.earliestMs, rotationOf(ports, start.root), now)),
    reviewEstimateMib: estimateOf(ports, "review"),
  };
}

function instanceOf(ports: ShadowMemoryPorts, root: string): string {
  try {
    return ports.instance(root);
  } catch (error) {
    void error; // An unreadable mount table: the root's own name, as the ledger itself falls back.
    return root.split("/").filter(Boolean).at(-1) ?? root;
  }
}

function estimateOf(ports: ShadowMemoryPorts, workerClass: WorkerClass): number {
  try {
    return ports.estimate(workerClass);
  } catch (error) {
    void error; // An unreadable estimate store: the class default, which is the learned estimate's own prior.
    return DEFAULT_ESTIMATE_MIB[workerClass];
  }
}

function rotationOf(ports: ShadowMemoryPorts, root: string): number | undefined {
  try {
    return newestRotationMs(ports.listStateDir(join(root, "state")));
  } catch (error) {
    void error; // Unlistable: the tail's own first row bounds the window, which can only lengthen what it claims.
    return undefined;
  }
}

/** This instance's daemon growth: measured from the daemon's /proc status when its pid is known and readable, else from
 *  the daemon.alive rows in the tail, else unmeasured with the reasons for both. */
function ownDaemonGrowth(
  ports: ShadowMemoryPorts,
  tail: ReturnType<typeof readTailRows>,
  now: number,
  policy: HostMemoryBudgetPolicy,
): { samples: number; growthMib?: number; reason?: string; basis?: string } {
  let procReason: string;
  const pid = ports.daemonPid();
  if (pid === undefined) procReason = "no daemon pid in this process";
  else {
    try {
      const measured = daemonGrowthFromStatus(ports.readFile(`/proc/${pid}/status`));
      if (measured) {
        return {
          samples: 1, growthMib: measured.growthMib,
          basis: `proc ${pid}: VmHWM ${Math.round(measured.peakMib)} MiB - VmRSS ${Math.round(measured.residentMib)} MiB`,
        };
      }
      procReason = `proc ${pid}: no VmHWM/VmRSS`;
    } catch (error) {
      // The pid exited or /proc is unreadable: named below, and the row series is tried instead.
      procReason = `proc ${pid}: ${reasonOf(error)}`;
    }
  }
  if ("unread" in tail) return { samples: 0, reason: `${procReason}; ledger tail unreadable: ${tail.unread}` };
  const rows = daemonGrowthOf(tail.rows, now, policy.daemonGrowthMinSamples);
  if (rows.growthMib !== undefined) return { ...rows, basis: "daemon.alive rows" };
  return { ...rows, reason: `${procReason}; ${rows.reason}` };
}

// ── the recorder: never in the path ───────────────────────────────────────────────────────────────────────────────

export type ShadowOutcome =
  | { kind: "recorded"; verdict: ShadowVerdict; written: boolean }
  | { kind: "off" }
  | { kind: "no-sink" }
  | { kind: "error"; reason: string };

const ERROR_DEDUP_MS = HOUR_MS;

function logShadowError(ports: ShadowMemoryPorts, start: ShadowStart, ledgerPath: string, reason: string): void {
  try {
    const now = ports.clock.now();
    const last = errorSeen.get(reason);
    if (last !== undefined && now - last < ERROR_DEDUP_MS) return;
    errorSeen.set(reason, now);
    const row = { run_id: start.runId ?? "memory-budget-shadow", task_id: start.taskId ?? "MEMORY-BUDGET", step: SHADOW_ERROR_STEP, reason };
    try {
      ports.write?.(ledgerPath, row);
    } catch (error) {
      ports.stderr(JSON.stringify({ event: SHADOW_ERROR_STEP, reason, error: reasonOf(error) }));
    }
  } catch (error) {
    void error; // The diagnostic of a diagnostic: nothing further can be told, and the start must not hear of it.
  }
}

/** W1-T7095: the counterfactual yield for this start. A failure is a named diagnostic and never a yield. */
function reviewPriorityOf(
  start: ShadowStart,
  inputs: ShadowInputs,
  policy: HostMemoryBudgetPolicy,
  ports: ShadowMemoryPorts,
  waitingSinceMs: number,
  now: number,
  ledgerPath: string,
): YieldDecision {
  try {
    return wouldYieldToReview({
      start: { instance: instanceOf(ports, start.root), workerClass: start.workerClass, waitingSinceMs },
      demand: start.workerClass === "review" ? { state: "present", rows: [], unreadableRows: 0 } : ports.readReviewDemand(),
      reservations: inputs.entries,
      reviewVerdict: (withStart) => counterfactualReviewVerdict(inputs, policy, withStart),
      policy: ports.priorityPolicy(),
      now,
    });
  } catch (error) {
    const reason = `priority:${reasonOf(error)}`;
    logShadowError(ports, start, ledgerPath, reason);
    return { yield: false, why: "demand-unread", detail: reason };
  }
}

/**
 * W1-T7095: routine deferrals become ONE machine row per (class, instance, reason), never an escalation; a sustained
 * zero-worker shortfall is queued ONCE per scenario for the sweep, which owns the escalation path.
 */
function recordDiagnostics(
  start: ShadowStart,
  inputs: ShadowInputs,
  verdict: ShadowVerdict,
  policy: HostMemoryBudgetPolicy,
  ports: ShadowMemoryPorts,
  base: { run_id: string; task_id: string },
  ledgerPath: string,
  waitMs: number,
): void {
  const instance = instanceOf(ports, start.root);
  try {
    for (const reason of verdict.reasons) {
      if (!deferrals.observe({ workerClass: start.workerClass, instance, reason, waitMs }).first) continue;
      ports.write?.(ledgerPath, {
        ...base,
        step: SHADOW_DEFERRAL_STEP,
        counterfactual: true,
        owner: "machine",
        escalate: false,
        worker_class: start.workerClass,
        instance,
        reason,
        dedup: "one row per class, instance and reason; later deferrals only count toward shadowDeferralReport()",
      });
    }
    const workersResidentMib = inputs.entries.reduce((sum, entry) => sum + ("mib" in entry.resident ? entry.resident.mib : 0), 0);
    const decision = shortfalls.observe({
      scenario: verdict.scenario,
      memAvailableMib: verdict.numbers.memAvailableMib,
      workersResidentMib,
      daemonGrowthMib: verdict.numbers.daemonGrowthMib,
      coldStartReserveMib: verdict.numbers.coldStartReserveMib,
      hostReserveMib: policy.hostReserveMib,
    }, ports.priorityPolicy());
    if (decision) {
      queueCapacityDecision(decision);
      ports.write?.(ledgerPath, { ...base, step: SHADOW_SHORTFALL_DECISION_STEP, counterfactual: true, ...decision });
    }
  } catch (error) {
    const reason = `diagnostics:${reasonOf(error)}`;
    logShadowError(ports, start, ledgerPath, reason);
  }
}

/**
 * The counterfactual verdict for one start that is ALREADY committed. Synchronous and bounded; NEVER throws; the caller
 * ignores its result, so admit, defer and error start identically. A failure logs memory_budget.shadow_error, once per
 * reason per hour.
 */
export function recordShadowMemoryVerdict(start: ShadowStart, overrides: Partial<ShadowMemoryPorts> = {}): ShadowOutcome {
  let ports: ShadowMemoryPorts | undefined;
  const ledgerPath = join(start.root ?? ".", "state", LEDGER_FILENAME);
  try {
    ports = { ...defaultShadowMemoryPorts(), ...overrides };
    if (!ports.write) return { kind: "no-sink" };
    const startedNs = ports.nowNs();
    const policy = ports.policy();
    if (policy.mode === "off") return { kind: "off" };
    const inputs = gatherShadowInputs(start, ports, policy);
    const instance = instanceOf(ports, start.root);
    const now = ports.clock.now();
    const waitKey = `${instance}\u0000${start.workerClass}`;
    const waitingSinceMs = wouldWaitSince.get(waitKey) ?? now;
    let verdict = evaluateShadowMemory(inputs, policy);
    const priority = reviewPriorityOf(start, inputs, policy, ports, waitingSinceMs, now, ledgerPath);
    if (priority.yield) {
      verdict = { ...verdict, wouldAdmit: false, reasons: [...verdict.reasons, WOULD_YIELD_TO_REVIEW] };
    }
    if (verdict.wouldAdmit) wouldWaitSince.delete(waitKey);
    else wouldWaitSince.set(waitKey, waitingSinceMs);
    const shadowUs = Number((ports.nowNs() - startedNs) / 1000n);
    const base = { run_id: start.runId ?? "memory-budget-shadow", task_id: start.taskId ?? "MEMORY-BUDGET" };
    let written = true;
    try {
      ports.write(ledgerPath, {
        ...base,
        step: SHADOW_STEP,
        counterfactual: true,
        note: "counterfactual: the work started regardless; cascades (what would have run later had this start deferred) are not modelled",
        cascades_modelled: false,
        mode: policy.mode,
        worker_class: start.workerClass,
        instance,
        reservation_id: start.reservationId ?? null,
        scenario: verdict.scenario,
        scenario_basis: inputs.serve.basis,
        would_admit: verdict.wouldAdmit,
        reasons: verdict.reasons,
        uncertainty: verdict.uncertainty,
        numbers: verdict.numbers,
        ledger_state: inputs.ledger.state,
        reservations: inputs.entries.length,
        daemon_growth: inputs.daemonGrowth,
        would_yield_to_review: priority.yield,
        review_priority: priority,
        would_wait_ms: verdict.wouldAdmit ? 0 : now - waitingSinceMs,
        shadow_us: shadowUs,
      });
    } catch (error) {
      written = false;
      const reason = `write:${reasonOf(error)}`;
      logShadowError(ports, start, ledgerPath, reason);
    }
    tally[verdict.scenario].samples += 1;
    tally[verdict.scenario][verdict.wouldAdmit ? "admit" : "defer"] += 1;
    const trigger = !lastState ? "first" : lastState.scenario !== verdict.scenario
      ? "scenario-change" : lastState.wouldAdmit !== verdict.wouldAdmit ? "verdict-change" : undefined;
    lastState = { scenario: verdict.scenario, wouldAdmit: verdict.wouldAdmit };
    if (trigger && written) {
      try {
        ports.write(ledgerPath, {
          ...base,
          step: SHADOW_SUMMARY_STEP,
          trigger,
          scenarios: summarizeShadowTally(tally),
          pooling: "none: serve-stopped samples say nothing about serve coexisting with the fleet",
        });
      } catch (error) {
        const reason = `summary-write:${reasonOf(error)}`;
        logShadowError(ports, start, ledgerPath, reason);
      }
    }
    if (written) recordDiagnostics(start, inputs, verdict, policy, ports, base, ledgerPath, now - waitingSinceMs);
    return { kind: "recorded", verdict, written };
  } catch (error) {
    const reason = reasonOf(error);
    if (ports) logShadowError(ports, start, ledgerPath, reason);
    return { kind: "error", reason };
  }
}
