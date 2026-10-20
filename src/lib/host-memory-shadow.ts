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
 * so a reservation counts only its UNREALIZED part: max(0, estimate - the tree's current rss+swap). A process inside
 * two recorded trees (a test run nested in a worker's tree) is resident in the innermost one only.
 *
 * ONE TAIL AT A TIME (the container check). A reservation's estimate is its class's p90 peak, and the live trees do not
 * all reach their p90 at once. The container claim is each live tree's TYPICAL remaining growth, max(0, class median -
 * resident), summed, plus ONE tail allowance: the largest single remaining spike above a typical, max over trees of
 * (remaining to the p90 - remaining to the median). Both quantiles are learned (host-memory-learning.ts); a class with
 * no samples has its median equal to its estimate, so its whole claim counts and it adds no tail.
 * The daemon is one more such tail: its growth back to its LAST-HOUR peak rss+swap (W1-T9972: never its boot-time VmHWM)
 * splits into a TYPICAL part, its median rss+swap over the last hour, each less its current rss+swap, and the rest,
 * which competes with the trees' tails for the one allowance. Too few samples: VmHWM - VmRSS, all of it typical. The HOST check applies the same rule across every live tree
 * and every measured daemon: all typical parts, plus the one largest tail. An unseen start carries its class median
 * too (W1-T9762), and a live tree's typical part and tail are scaled by its class's measured survival at its age: the
 * share of the class's trees that peaked later than that (host-memory-learning.ts `survivalAt`).
 * The samples are the daemon's own rolling footprint (daemon-footprint.ts), kept across ledger rotations and daemon
 * restarts; the live ledger's tail, which a rotation cuts and a restart's new pid filters, is read only when it holds
 * more of the last hour than the footprint does (before the daemon has written one).
 *
 * THE CONTAINER CEILING JUDGES ITS OWN PRESSURE. The container check defers when the projected working set (working set +
 * the claims above + the daemon's typical growth) crosses memory.high (#10486's tuner sets it) and its flags predict
 * own pressure beyond sampling noise (unlearned: the projection alone), or while the container
 * is AT its ceiling now: a crossing of its memory.high (memory.events `high`) within the minute before a verdict that
 * finds its OWN tasks stalled past the PSI thresholds (its memory.pressure). Its own swap-in is reported, not judged: it
 * ran at 500-1800 pages/s with no crossing (the host's reclaim). Pressure unread: the static `containerReserveMib`.
 * No onset below memory.high is learned: a crossing proves usage REACHED it at a peak between verdicts, which a sample
 * misses (the cgroup is mounted read-only, so memory.peak cannot be reset per interval). On 10-11/12 (core, 1,283 rows)
 * learning the lowest sampled working set at 12 crossings (2379-3589 MiB) put this arm on 77% of rows, and the
 * projection at them (median 6790 MiB) matched every row's (6705 MiB): no lower level separates them.
 *
 * SWAP-IN COUNTS ONLY WHILE IT PREDICTS STALL. A host swap-in rate past `swapInPagesPerSecMax` defers only when the
 * instance's verdicts over {@link SWAP_STALL_HISTORY_MS} with such a rate were followed by host PSI past its thresholds
 * within {@link SWAP_STALL_WINDOW_MS} more often than all verdicts, by over twice the sampling noise; too few of them,
 * the rate alone. Over the same rows that ratio was 0.95-1.02 (PSI some10 median 0.9 at ~1,245 pages/s): churn.
 *
 * THE PSI START BOUND IS LEARNED LIKE SWAP-IN (W1-T10085). Host PSI full avg10 names "psi" past a bound learned from
 * the instance's own admitted starts over the same windows, minimum and noise: the prior `psiFullAvg10Max` rises only
 * to a level whose admitted starts were followed by harm (an oom_kill rise, or full avg60 past the PRIOR) no more often
 * than every verdict in their band, and by no OOM kill. Unread or thin: the prior.
 *
 * NEVER WAITS. No lock is taken; a ledger reader that reports a held lock (EWOULDBLOCK/EAGAIN/EBUSY), an errno, or a
 * missing/unreadable/reset store yields a verdict naming that state as an uncertainty that WIDENS the margin. It is
 * never read as zero reservations. File reads are bounded (a ledger tail, a capped process count).
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

import { fixedClock, systemClock, type Clock } from "./clock.js";
import { sampleCgroupMemory } from "./daemon-memory-telemetry.js";
import {
  DEFAULT_ESTIMATE_MIB,
  WORKER_CLASSES,
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
import { classEstimate, classSurvival, classTypical, readPeakSamples, type PeakSample, type Survival } from "./host-memory-learning.js";
import {
  JOINT_MODEL, calibrationReport, installCalibrationSink, jointMemoryClaim, kernelMemoryObservation,
  publishMemoryForecast, readCalibrationState, type JointEstimate, type MemoryForecast,
} from "./host-memory-calibration.js";
import { readHostServeEvidence, type HostServeReading } from "./host-serve-evidence.js";
import { readDaemonFootprint, type BootGrowth, type FootprintSample } from "./daemon-footprint.js";
import { writeAtomic } from "./fs-race-safe.js";
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
  /** Derived afresh by the loader, never parsed as operator-supplied permission. */
  jointQualification?: { generation: string; scenarios: string[] };
  claimModel?: "legacy-one-tail" | typeof JOINT_MODEL;
  jointQuantile?: number;
  maxBacktestMissRate?: number;
  calibrationStateDir?: string;
  mode: ShadowMode;
  classModes?: Partial<Record<WorkerClass, ShadowMode>>;
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
  /** The daemon's rss+swap samples in the last hour (its persisted footprint, daemon-footprint.ts, or the ledger tail's
   *  daemon.alive/daemon.tick rows) below which its growth is not split: it all counts as typical. */
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
  if (block.claimModel !== undefined) {
    const row = mapping(`${base}.claimModel`, block.claimModel); proposalOrigin(`${base}.claimModel`, row);
    if (row.value !== "legacy-one-tail" && row.value !== JOINT_MODEL) throw new Error("unknown memory claim model");
    out.claimModel = row.value;
  }
  for (const key of ["jointQuantile", "maxBacktestMissRate"] as const) if (block[key] !== undefined) {
    const row = mapping(`${base}.${key}`, block[key]); proposalOrigin(`${base}.${key}`, row);
    if (typeof row.value !== "number" || !Number.isFinite(row.value) || row.value < (key === "jointQuantile" ? 0.5 : 0) || row.value >= 1) throw new Error(`invalid ${key}`);
    out[key] = row.value;
  }
  if (block.calibrationStateDir !== undefined) {
    const row = mapping(`${base}.calibrationStateDir`, block.calibrationStateDir); proposalOrigin(`${base}.calibrationStateDir`, row);
    if (typeof row.value !== "string" || !row.value.startsWith("/")) throw new Error("calibrationStateDir must be absolute");
    out.calibrationStateDir = row.value;
  }
  if (block.classModes !== undefined) out.classModes = parseClassModes(`${base}.classModes`, mapping(`${base}.classModes`, block.classModes));
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

function parseClassModes(path: string, block: Record<string, unknown>): Partial<Record<WorkerClass, ShadowMode>> {
  const out: Partial<Record<WorkerClass, ShadowMode>> = {};
  for (const [workerClass, raw] of Object.entries(block)) {
    if (!WORKER_CLASSES.includes(workerClass as WorkerClass)) {
      throw new Error(`policy.yaml: '${path}' names an unknown worker class ${JSON.stringify(workerClass)}.`);
    }
    const row = mapping(`${path}.${workerClass}`, raw);
    proposalOrigin(`${path}.${workerClass}`, row);
    if (!SHADOW_MODES.includes(row.value as ShadowMode)) {
      throw new Error(`policy.yaml: '${path}.${workerClass}' accepts only "off", "shadow" or "enforce", got ${JSON.stringify(row.value)}.`);
    }
    out[workerClass as WorkerClass] = row.value as ShadowMode;
  }
  return out;
}

export function hostMemoryBudgetModeFor(policy: Pick<HostMemoryBudgetPolicy, "mode" | "classModes">, workerClass: WorkerClass): ShadowMode {
  return policy.classModes?.[workerClass] ?? policy.mode;
}

const cachedPolicies = new Map<string, HostMemoryBudgetPolicy>();

/** The shipped `sweep.hostMemoryBudget`, read once per process. Throws on an invalid block; the recorder catches it. */
export function loadHostMemoryBudgetPolicy(path: string = installPolicyPath(), clock: Clock = systemClock,
  observe: typeof kernelMemoryObservation = kernelMemoryObservation): HostMemoryBudgetPolicy {
  let policy = cachedPolicies.get(path);
  if (!policy) {
    const doc = mapping("policy.yaml", parseYaml(readFileSync(path, "utf8")));
    policy = parseHostMemoryBudgetPolicy(mapping("sweep", doc.sweep).hostMemoryBudget);
    cachedPolicies.set(path, policy);
  }
  if (policy.mode === "enforce" && policy.claimModel !== JOINT_MODEL) throw new Error("enforce refused: select a qualified joint claim model; the existing class override is not global permission");
  if (policy.claimModel === JOINT_MODEL && (policy.mode === "enforce" || Object.values(policy.classModes ?? {}).includes("enforce"))) {
    if (!policy.calibrationStateDir) throw new Error("joint enforce refused: calibrationStateDir is missing");
    const now = clock.now(), state = readCalibrationState(policy.calibrationStateDir), current = observe(now);
    const report = calibrationReport(state, now, policy.jointQuantile, policy.maxBacktestMissRate);
    if (current.mib === null || state.generation !== current.generation) throw new Error("joint enforce refused: current generation is not qualified");
    if (!report.qualified) throw new Error(`joint enforce refused: ${report.reasons.join("; ")}; evidence ${policy.calibrationStateDir}`);
    return { ...policy, jointQualification: { generation: state.generation, scenarios: Object.keys(report.scenarios) } };
  }
  return policy;
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
  resident: { mib: number; rssMib?: number; complete: boolean; reason?: string } | { unread: string };
  /** Since the reservation opened. W1-T7095 reads it to tell a review started since its demand row was published. */
  ageMs?: number;
  /** Its work has ended: what its tree still holds is resident, and it can claim nothing more. */
  occupancyReleased?: boolean;
  /** The class's learned median peak, at most `estimateMib`. Absent: the estimate, so the whole claim is typical. */
  typicalMib?: number;
  /** W1-T9762: the class's measured survival at `ageMs`, which scales its remaining claim. Absent: not decayed. */
  survival?: Survival;
}

export interface ShadowInputs {
  jointClaim?: Extract<JointEstimate, { kind: "joint" }>;
  memAvailable: { mib: number } | { unread: string };
  swapIn: { pagesPerSec: number } | { unmeasured: string };
  psi: { someAvg10: number; someAvg60: number; fullAvg10?: number; fullAvg60?: number } | { unread: string };
  /** `highMib` is memory.high (reclaim and throttling begin there); `reclaimableMib` is inactive_file, page cache the
   *  kernel drops before it swaps anonymous memory. Both are optional, and absent means not subtracted. */
  container: { currentMib: number; maxMib: number | null; highMib?: number | null; reclaimableMib?: number } | { unread: string };
  ledger: { state: ShadowLedgerState; dir?: string; reason?: string };
  entries: ShadowEntryInput[];
  /** The start this verdict is about. Its own reservation is counted even when the ledger could not show it. */
  start: { reservationId?: string; workerClass: WorkerClass; estimateMib: number; typicalMib?: number; estimateSource?: EstimateSource };
  /** `own` marks this container's daemon, whose growth also counts against the container ceiling. `typicalMib` is the
   *  part of `growthMib` its median footprint accounts for; absent, the whole growth is typical and it adds no tail. */
  daemonGrowth: Array<{
    instance: string; samples: number; growthMib?: number; typicalMib?: number; reason?: string; basis?: string;
    typicalBasis?: string; own?: boolean; currentBasis?: string;
    /** W1-T9972: the proc's VmHWM - VmRSS and its basis, for comparison only (it sizes the growth only on too few samples). */
    lifetimePeakGrowthMib?: number; lifetimePeakBasis?: string;
    /** What the daemon's persisted footprint held for this verdict (daemon-footprint.ts), or why it was unread. */
    footprint?: string;
    /** W1-T9982: "boot" while the daemon is inside the boot phase its earlier boots showed, else "steady", and why. */
    phase?: "boot" | "steady"; phaseBasis?: string;
  }>;
  serve: { scenario: ServeScenario; basis: string };
  /** This container's OWN memory pressure now. Absent or unread: the static `containerReserveMib` below the ceiling
   *  applies. */
  containerPressure?: ContainerPressureInput;
  /** Whether the host's swap-in has been followed by stall, from the instance's verdict history. Absent: unlearned,
   *  so the swap-in rate alone decides. */
  swapStall?: SwapStallRelation;
  /** Whether projection flags predict this container's own pressure. Absent: the projection alone decides. */
  containerLift?: ContainerLift;
  /** W1-T10085: the learned PSI full avg10 bound. Absent: the prior. */
  psiBound?: PsiFullAvg10Bound;
  /** W1-T10085: this verdict's stamp in the PSI record, so an admission can mark its start admitted. */
  psiRecordAt?: number;
  /** Opt-in counter-window evidence only; not atomic history, capacity, calibration or spawn authority. */
  strictEvidence?: StrictPressureEvidence;
  /** The learned review estimate, for the counterfactual review (W1-T7095). Absent: the class default. */
  reviewEstimateMib?: number;
}

/** How often the host's swap-in past the threshold was followed by stall, against all verdicts. */
export type SwapStallRelation =
  | {
    /** Verdicts with swap-in past the threshold whose window has closed. */
    samples: number;
    /** The share of them followed by a stall within {@link SWAP_STALL_WINDOW_MS}. */
    afterSwapIn: number;
    /** The share of all closed verdicts followed by one. */
    afterAny: number;
    /** Twice the sampling noise of `afterSwapIn`: the margin it must clear. */
    noise: number;
  }
  | { unlearned: string };

/** W1-T10085: the level host PSI full avg10 must pass before a verdict names "psi", with the record behind it. */
export interface PsiFullAvg10Bound {
  bound: number;
  prior: number;
  basis: string;
  /** Admitted starts above the prior with a closed window. */
  samples: number;
  /** At the bound's band: the share of its admitted starts followed by harm, of all its verdicts, and twice the noise. */
  afterAdmitted: number | null;
  afterBand: number | null;
  noise: number | null;
  /** Admitted starts above the prior followed by an oom_kill rise; null when oom_kill was unread on every one. */
  ooms: number | null;
}

/** Projection flags followed by own pressure, compared with all closed verdicts. */
export type ContainerLift =
  | { samples: number; afterProjection: number; afterAny: number; noise: number }
  | { unlearned: string };

export interface ContainerPressureSample {
  at: number;
  projected: boolean;
  pressed: boolean;
}

export type ContainerPressureInput =
  | {
    /** memory.stat pswpin, pages per second since the instance's previous verdict. */
    swapIn: { pagesPerSec: number } | { unmeasured: string };
    /** memory.pressure. */
    psi: { someAvg10: number; fullAvg10?: number } | { unread: string };
    /** memory.events `high` crossings since the instance's previous verdict, when that was within
     *  {@link CROSSING_WINDOW_MS}; null when unmeasured or older. */
    ceilingCrossings: number | null;
  }
  | { unread: string };

export interface ShadowUncertainty {
  kind: string;
  count: number;
  marginMib: number;
  detail?: string[];
}

/** One live reservation's part in the claims, so a row can be replayed under another summing rule. */
export interface ShadowClaim {
  workerClass: WorkerClass;
  estimateMib: number;
  typicalMib: number;
  /** Legacy RSS-plus-swap footprint, NOT physical resident RAM; null when unread (the whole estimate counts). */
  residentMib: number | null;
  /** In this container: its claim counts against the container ceiling. */
  own: boolean;
  released: boolean;
  /** W1-T9762: its typical growth after decay; its tail, (remaining p90 - typical) times the same factor, competes for
   *  the one allowance. */
  chargedMib: number;
  /** The survival factor its remaining claim was scaled by, or null and why it was not decayed. */
  decay: { factor: number | null; basis: string };
  /** Since its reservation opened; 0 for the start, null when the ledger did not say. */
  ageMs: number | null;
}

export interface ShadowVerdict {
  wouldAdmit: boolean;
  reasons: ShadowReason[];
  scenario: ServeScenario;
  uncertainty: ShadowUncertainty[];
  /** Every live reservation, then the start's own when the ledger could not show it; at most CLAIMS_CAP. */
  claims: ShadowClaim[];
  numbers: {
    memAvailableMib: number | null;
    /** Every live tree's remaining p90 claim summed (the host rule through #10763), for comparison only. */
    unrealizedMib: number;
    /** What the host check counts: every tree's typical growth plus the ONE tail allowance (a tree's or a daemon's). */
    hostClaimMib: number;
    /** W1-T9762: the same claim were no live tree decayed by its class's measured time to peak, for comparison only. */
    hostClaimUndecayedMib: number;
    hostTypicalMib: number;
    hostTailMib: number;
    /** The sum of this container's trees' remaining p90 claims: every tree at its p90 at once. */
    unrealizedOwnContainerMib: number;
    /** What the container check counts: the trees' typical sum plus the one tail allowance (a tree's or this daemon's);
     *  this daemon's typical growth is subtracted beside it. */
    containerClaimMib: number;
    containerTypicalMib: number;
    containerTailMib: number;
    /** Every measured daemon's growth back to its peak, in full; the typical part counts, the tail competes. */
    daemonGrowthMib: number;
    daemonGrowthTypicalMib: number;
    /** The largest single daemon tail: growth above its typical. */
    daemonGrowthTailMib: number;
    /** W1-T9972: every daemon's VmHWM - VmRSS summed (null: none read), for comparison only. */
    daemonGrowthLifetimePeakMib: number | null;
    /** Whose tail `hostTailMib` is: "daemon:<instance>", the claim's worker class, "start", or null with no tail. */
    hostTailOwner: string | null;
    coldStartReserveMib: number;
    marginMib: number;
    projectedAvailableMib: number | null;
    /** The projection were every tree at its p90 and every daemon at its peak at once, for comparison only. */
    projectedAvailableAllPeaksMib: number | null;
    hostReserveMib: number;
    swapInPagesPerSec: number | null;
    /** Whether swap-in past the threshold counts: its learned relation to stall, or the rate alone while unlearned. */
    swapInBasis: string | null;
    psiFullAvg10Bound: PsiFullAvg10Bound;
    psi: { someAvg10: number; someAvg60: number; fullAvg10?: number; fullAvg60?: number } | null;
    containerCurrentMib: number | null;
    containerMaxMib: number | null;
    containerHeadroomMib: number | null;
    /** The headroom were every tree to reach its p90 at once (the pre-W1 rule), for comparison only; it decides nothing. */
    containerHeadroomAllPeaksMib: number | null;
    /** min(memory.max, memory.high): where this container's reclaim begins. */
    containerCeilingMib: number | null;
    /** memory.current less reclaimable page cache: the memory the ceiling is measured against. */
    containerWorkingSetMib: number | null;
    containerReserveMib: number;
    /** The working set the container check projects: working set + its claim + this daemon's typical growth. */
    containerProjectedMib: number | null;
    /** The projection's learned lift over the pressure base rate, or why the projection alone decides. */
    containerBasis: string;
    /** The level the projection is judged against: memory.high, or memory.high less `containerReserveMib` when the
     *  container's pressure is unread. Its basis also names a container at its ceiling now. */
    containerOnsetMib: number | null;
    containerOnsetBasis: string | null;
    /** This container's own pressure in this snapshot (null: unread). */
    containerSwapInPagesPerSec: number | null;
    containerPsi: { someAvg10: number; fullAvg10?: number } | null;
    /** Its own pressure past the thresholds; `containerSighted` when that came with a crossing of its memory.high. */
    containerPressed: boolean;
    containerSighted: boolean;
    /** Legacy clamped difference against RSS-plus-swap footprints. Kept for historical replay, NOT physical attribution. */
    unreservedContainerMib: number | null;
    unreservedContainerShare: number | null;
    legacyResidentBasis: "rss-plus-swap-footprint";
    /** Sum of this container's measured reservation-tree RSS, not exclusive physical charge (shared pages can repeat).
     * Null if the ledger, a tree's walk or any RSS reading is incomplete. No reservations in a present ledger is zero. */
    reservationRssMib: number | null;
    /** Approximate memory.current minus reservation RSS, NOT "native" or exact unreserved memory. May be negative:
     * process RSS and cgroup charging have different sharing rules. Null when either side is unavailable. */
    unattributedContainerMibApprox: number | null;
    unattributedContainerBasis: "approximate-cgroup-current-minus-reservation-rss";
  };
}

const DETAIL_CAP = 8;
/** BACKSTOP on the claims a row lists; a ledger holds a handful of live reservations. */
const CLAIMS_CAP = 32;

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
  let typicalOwn = 0;
  let tailOwn = 0;
  let typicalAll = 0;
  let tailAll = 0;
  let tailAllOwner: string | null = null;
  let typicalUndecayed = 0;
  let tailUndecayed = 0;
  const claims: ShadowClaim[] = [];
  /** One tree's claim: its remaining growth to the p90 (`share`), how much of that is typical, and both scaled by its
   *  class's survival at its age (`factor`). */
  const claim = (estimateMib: number, typicalMib: number | undefined, resident: number, released: boolean, factor = 1) => {
    if (released) return { share: 0, typical: 0, charged: 0, chargedTail: 0 };
    const share = Math.max(0, estimateMib - resident);
    const typical = Math.min(share, Math.max(0, Math.min(typicalMib ?? estimateMib, estimateMib) - resident));
    return { share, typical, charged: typical * factor, chargedTail: (share - typical) * factor };
  };
  for (const entry of inputs.entries) {
    let resident = 0;
    if ("unread" in entry.resident) widen("tree-unread", 0, `${entry.id}: ${entry.resident.unread}`);
    else {
      resident = entry.resident.mib;
      if (!entry.resident.complete) widen("tree-partial", margin, `${entry.id}: ${entry.resident.reason ?? "partial"}`);
    }
    // A released occupancy's tree can only shrink: its resident memory is already measured, so it claims nothing more.
    const released = entry.occupancyReleased === true;
    const decay = decayOf(entry.survival, released, entry.ageMs);
    const { share, typical, charged, chargedTail } = claim(entry.estimateMib, entry.typicalMib, resident, released, decay.factor ?? 1);
    unrealized += share;
    typicalAll += charged;
    if (chargedTail > tailAll) {
      tailAll = chargedTail;
      tailAllOwner = entry.id === inputs.start.reservationId ? "start" : entry.workerClass;
    }
    typicalUndecayed += typical;
    tailUndecayed = Math.max(tailUndecayed, share - typical);
    const own = entry.status === "owned";
    if (own) {
      unrealizedOwn += share;
      residentOwn += resident;
      typicalOwn += charged;
      tailOwn = Math.max(tailOwn, chargedTail);
    }
    if (claims.length < CLAIMS_CAP) {
      claims.push({ workerClass: entry.workerClass, estimateMib: entry.estimateMib,
        typicalMib: Math.min(entry.typicalMib ?? entry.estimateMib, entry.estimateMib),
        residentMib: "unread" in entry.resident ? null : entry.resident.mib, own, released,
        chargedMib: charged, decay, ageMs: entry.ageMs ?? null });
    }
    if (entry.estimateSource.kind === "default-unmeasured" && !released) widen("unmeasured-estimate", margin, entry.id);
    if (entry.status === "uncertain") widen("uncertain-entry", margin, entry.id);
    if (entry.walkComplete === false) widen("incomplete-walk", margin, entry.id);
  }
  const startSeen = inputs.start.reservationId !== undefined &&
    inputs.entries.some((entry) => entry.id === inputs.start.reservationId);
  if (!startSeen) {
    // The start's own claim is counted in full even when the ledger cannot show it: never zero reservations.
    const own = claim(inputs.start.estimateMib, inputs.start.typicalMib, 0, false);
    unrealized += own.share;
    typicalAll += own.typical;
    if (own.share - own.typical > tailAll) {
      tailAll = own.share - own.typical;
      tailAllOwner = "start";
    }
    typicalUndecayed += own.typical;
    tailUndecayed = Math.max(tailUndecayed, own.share - own.typical);
    unrealizedOwn += own.share;
    typicalOwn += own.typical;
    tailOwn = Math.max(tailOwn, own.share - own.typical);
    if (claims.length < CLAIMS_CAP) {
      claims.push({ workerClass: inputs.start.workerClass, estimateMib: inputs.start.estimateMib,
        typicalMib: Math.min(inputs.start.typicalMib ?? inputs.start.estimateMib, inputs.start.estimateMib),
        residentMib: 0, own: true, released: false, chargedMib: own.typical,
        decay: { factor: null, basis: "the start: not yet running" }, ageMs: 0 });
    }
    widen("start-unrecorded", 0, inputs.start.reservationId ?? "no reservation id");
  }

  // A daemon is one more tail: its typical growth counts, its spike competes with the trees' for the one allowance.
  let daemonGrowth = 0;
  let daemonTypical = 0;
  let daemonTail = 0;
  let daemonTailOwner: string | null = null;
  let lifetimePeak: number | null = null;
  let ownDaemonGrowth = 0;
  let ownDaemonTypical = 0;
  let ownDaemonTail = 0;
  for (const growth of inputs.daemonGrowth) {
    if (growth.lifetimePeakGrowthMib !== undefined) lifetimePeak = (lifetimePeak ?? 0) + growth.lifetimePeakGrowthMib;
    if (growth.growthMib !== undefined) {
      const typical = Math.max(0, Math.min(growth.typicalMib ?? growth.growthMib, growth.growthMib));
      daemonGrowth += growth.growthMib;
      daemonTypical += typical;
      if (growth.growthMib - typical > daemonTail) {
        daemonTail = growth.growthMib - typical;
        daemonTailOwner = `daemon:${growth.instance}`;
      }
      if (growth.own) {
        ownDaemonGrowth += growth.growthMib;
        ownDaemonTypical += typical;
        ownDaemonTail = Math.max(ownDaemonTail, growth.growthMib - typical);
      }
    } else widen("daemon-growth-unmeasured", policy.daemonGrowthUnmeasuredMib,
      `${growth.instance}: ${growth.reason ?? `${growth.samples} sample(s)`}`);
  }
  const containerTail = Math.max(tailOwn, ownDaemonTail);
  const containerClaim = inputs.jointClaim ? inputs.jointClaim.ownMib + ownDaemonTail : typicalOwn + containerTail;
  const hostTail = Math.max(tailAll, daemonTail);
  const hostTailOwner = inputs.jointClaim || daemonTail > tailAll ? daemonTailOwner : tailAllOwner;
  const hostClaim = inputs.jointClaim ? inputs.jointClaim.hostMib + daemonTail : typicalAll + hostTail;
  const hostClaimUndecayed = inputs.jointClaim ? hostClaim : typicalUndecayed + Math.max(tailUndecayed, daemonTail);

  const scenario = inputs.serve.scenario;
  const coldStartReserve = scenario === "serve-cold-start" ? policy.serveColdStartReserveMib : 0;
  if (scenario === "unknown") widen("serve-scenario-unknown", margin, inputs.serve.basis);

  const reasons = new Set<ShadowReason>();
  let swapIn: number | null = null;
  let swapInBasis: string | null = null;
  if ("unmeasured" in inputs.swapIn) widen("swap-in-unmeasured", margin, inputs.swapIn.unmeasured);
  else {
    swapIn = inputs.swapIn.pagesPerSec;
    const relation = swapInPredictsStall(inputs.swapStall);
    swapInBasis = relation.basis;
    if (swapIn > policy.swapInPagesPerSecMax && relation.counts) reasons.add("swap-in");
  }
  const psi = "unread" in inputs.psi ? null : inputs.psi;
  const psiBound = psiBoundFor(inputs.psiBound, policy);
  if (psi === null) widen("psi-unread", margin, (inputs.psi as { unread: string }).unread);
  else if (psi.someAvg10 > policy.psiSomeAvg10Max || (psi.fullAvg10 ?? 0) > psiBound.bound) reasons.add("psi");

  let containerCurrent: number | null = null;
  let containerMax: number | null = null;
  let containerHeadroom: number | null = null;
  let containerHeadroomAllPeaks: number | null = null;
  let containerCeiling: number | null = null;
  let containerWorkingSet: number | null = null;
  let containerProjected: number | null = null;
  let onset: { mib: number; basis: string } | null = null;
  const pressure = containerPressureOf(inputs.containerPressure, policy);
  const containerRelation = containerPredictsPressure(inputs.containerLift);
  if ("unread" in inputs.container) widen("container-unread", margin, inputs.container.unread);
  else {
    containerCurrent = inputs.container.currentMib;
    containerMax = inputs.container.maxMib;
    const limits = [containerMax, inputs.container.highMib ?? null].filter((v): v is number => v !== null);
    containerWorkingSet = Math.max(0, containerCurrent - (inputs.container.reclaimableMib ?? 0));
    if (limits.length > 0) {
      containerCeiling = Math.min(...limits);
      containerProjected = containerWorkingSet + containerClaim + ownDaemonTypical;
      containerHeadroom = containerCeiling - containerProjected;
      containerHeadroomAllPeaks = containerCeiling - containerWorkingSet - unrealizedOwn - ownDaemonGrowth;
      onset = containerOnsetOf(pressure, containerCeiling, policy);
      // Named only when a reading was attempted; an input without one (a pure caller) keeps the static reserve silently.
      if (pressure.unread !== undefined && inputs.containerPressure !== undefined) widen("container-pressure-unread", 0, pressure.unread);
      if (pressure.sighted || (containerProjected > onset.mib && containerRelation.counts)) reasons.add("container-ceiling");
    }
  }

  let memAvailable: number | null = null;
  let projected: number | null = null;
  let projectedAllPeaks: number | null = null;
  if ("unread" in inputs.memAvailable) widen("meminfo-unread", margin, inputs.memAvailable.unread);
  const marginMib = [...named.values()].reduce((sum, u) => sum + u.marginMib, 0);
  if ("mib" in inputs.memAvailable) {
    memAvailable = inputs.memAvailable.mib;
    // Staged so each reason names what tipped it: measured headroom less the daemons' typical growth, then the claims
    // (typical growth plus one tail), then uncertainty.
    const base = memAvailable - daemonTypical - coldStartReserve;
    projected = base - hostClaim - marginMib;
    projectedAllPeaks = memAvailable - daemonGrowth - coldStartReserve - unrealized - marginMib;
    if (base < policy.hostReserveMib) reasons.add("memory-available");
    else if (base - hostClaim < policy.hostReserveMib) reasons.add("unrealized-reservations");
    else if (projected < policy.hostReserveMib) reasons.add("uncertainty");
  } else {
    reasons.add("uncertainty"); // No measured headroom: a fit cannot be shown.
  }

  const unreserved = containerCurrent === null ? null : Math.max(0, containerCurrent - residentOwn);
  const owned = inputs.entries.filter(entry => entry.status === "owned");
  const rssKnown = inputs.ledger.state === "present" && !inputs.entries.some(entry => entry.status === "uncertain") &&
    owned.every(entry => entry.walkComplete === true &&
    "mib" in entry.resident && entry.resident.complete && entry.resident.rssMib !== undefined &&
    Number.isFinite(entry.resident.rssMib) && entry.resident.rssMib >= 0);
  const reservationRss = rssKnown ? owned.reduce((sum, entry) =>
    sum + ("mib" in entry.resident ? entry.resident.rssMib! : 0), 0) : null;
  return {
    wouldAdmit: reasons.size === 0,
    reasons: [...reasons],
    scenario,
    uncertainty: [...named.values()],
    claims,
    numbers: {
      memAvailableMib: memAvailable,
      unrealizedMib: unrealized,
      hostClaimMib: hostClaim,
      hostClaimUndecayedMib: hostClaimUndecayed,
      hostTypicalMib: inputs.jointClaim ? inputs.jointClaim.hostMib : typicalAll,
      hostTailMib: inputs.jointClaim ? daemonTail : hostTail,
      unrealizedOwnContainerMib: unrealizedOwn,
      containerClaimMib: containerClaim,
      containerTypicalMib: inputs.jointClaim ? inputs.jointClaim.ownMib : typicalOwn,
      containerTailMib: inputs.jointClaim ? ownDaemonTail : containerTail,
      daemonGrowthMib: daemonGrowth,
      daemonGrowthTypicalMib: daemonTypical,
      daemonGrowthTailMib: daemonTail,
      daemonGrowthLifetimePeakMib: lifetimePeak,
      hostTailOwner,
      coldStartReserveMib: coldStartReserve,
      marginMib,
      projectedAvailableMib: projected,
      projectedAvailableAllPeaksMib: projectedAllPeaks,
      hostReserveMib: policy.hostReserveMib,
      swapInPagesPerSec: swapIn,
      swapInBasis,
      psiFullAvg10Bound: psiBound,
      psi,
      containerCurrentMib: containerCurrent,
      containerMaxMib: containerMax,
      containerHeadroomMib: containerHeadroom,
      containerHeadroomAllPeaksMib: containerHeadroomAllPeaks,
      containerCeilingMib: containerCeiling,
      containerWorkingSetMib: containerWorkingSet,
      containerReserveMib: policy.containerReserveMib,
      containerProjectedMib: containerProjected,
      containerBasis: containerRelation.basis,
      containerOnsetMib: onset?.mib ?? null,
      containerOnsetBasis: onset?.basis ?? null,
      containerSwapInPagesPerSec: pressure.swapIn,
      containerPsi: pressure.psi,
      containerPressed: pressure.pressed,
      containerSighted: pressure.sighted,
      unreservedContainerMib: unreserved,
      unreservedContainerShare: unreserved === null || !containerCurrent ? null : unreserved / containerCurrent,
      legacyResidentBasis: "rss-plus-swap-footprint",
      reservationRssMib: reservationRss,
      unattributedContainerMibApprox: containerCurrent === null || reservationRss === null ? null : containerCurrent - reservationRss,
      unattributedContainerBasis: "approximate-cgroup-current-minus-reservation-rss",
    },
  };
}

/** W1-T9762: the survival factor a live tree's remaining claim is scaled by, or why it is not decayed. */
function decayOf(survival: Survival | undefined, released: boolean, ageMs: number | undefined): ShadowClaim["decay"] {
  if (released) return { factor: null, basis: "released: it claims nothing" };
  if (survival === undefined) return { factor: null, basis: "not decayed: no time-to-peak reading" };
  if ("unmeasured" in survival) return { factor: null, basis: `not decayed: ${survival.unmeasured}` };
  return { factor: survival.factor, basis: `survival at ${Math.round((ageMs ?? 0) / 1000)}s over ${survival.samples} time-to-peak sample(s)` };
}

/** A crossing is tied to the stall a verdict reads only within the kernel's longest short PSI window (avg60): an older
 *  prior's crossings may have come and gone before the stall it shows. */
export const CROSSING_WINDOW_MS = 60_000;
/** A swap-in verdict is "followed by stall" when host PSI passes its thresholds within this long: the kernel's longest
 *  PSI average (avg300). A proposal, like every number here: the shadow rows calibrate it. */
export const SWAP_STALL_WINDOW_MS = 5 * 60_000;
/** The history the swap-in relation is learned over, so it follows the host as its load changes. */
export const SWAP_STALL_HISTORY_MS = 6 * 60 * 60_000;
/** Closed verdicts with swap-in past the threshold the relation needs before it decides; fewer, the rate alone does. */
export const SWAP_STALL_MIN_SAMPLES = 30;

/** This container's own pressure in one snapshot: past the policy's swap-in or PSI thresholds, or unread. */
function containerPressureOf(input: ShadowInputs["containerPressure"], policy: HostMemoryBudgetPolicy): {
  pressed: boolean; sighted: boolean; swapIn: number | null; psi: { someAvg10: number; fullAvg10?: number } | null;
  unread?: string;
} {
  const none = { pressed: false, sighted: false, swapIn: null, psi: null };
  if (input === undefined) return { ...none, unread: "not read" };
  if ("unread" in input) return { ...none, unread: input.unread };
  const swapIn = "pagesPerSec" in input.swapIn ? input.swapIn.pagesPerSec : null;
  const psi = "unread" in input.psi ? null : input.psi;
  // Neither signal measurable (a first verdict with no memory.pressure): nothing says the container is calm.
  if (swapIn === null && psi === null) {
    const why = `${(input.swapIn as { unmeasured: string }).unmeasured}; ${(input.psi as { unread: string }).unread}`;
    return { pressed: false, sighted: false, swapIn, psi, unread: why };
  }
  const stalled = psi !== null && (psi.someAvg10 > policy.psiSomeAvg10Max || (psi.fullAvg10 ?? 0) > policy.psiFullAvg10Max);
  const pressed = stalled || (swapIn ?? 0) > policy.swapInPagesPerSecMax;
  // At its ceiling: the cgroup itself crossed memory.high while its tasks stalled. Without a crossing it is the host's.
  return { pressed, sighted: stalled && (input.ceilingCrossings ?? 0) > 0, swapIn, psi };
}

/**
 * The level the container's projected working set is judged against: memory.high. A container at its ceiling now
 * defers whatever its projection reads, and its basis says so. Pressure unread: the static reserve below memory.high.
 */
export function containerOnsetOf(
  pressure: ReturnType<typeof containerPressureOf>, ceilingMib: number, policy: HostMemoryBudgetPolicy,
): { mib: number; basis: string } {
  if (pressure.unread !== undefined) {
    return { mib: ceilingMib - policy.containerReserveMib, basis: `static reserve ${policy.containerReserveMib} MiB: pressure unread` };
  }
  if (pressure.sighted) return { mib: ceilingMib, basis: "at its ceiling now: memory.high crossed within the minute while its tasks stall" };
  return { mib: ceilingMib, basis: "memory.high" };
}

/** One verdict in the swap-in history: when, the host's swap-in rate then (null: unmeasured), and whether host PSI
 *  was past its thresholds. */
export interface SwapStallSample {
  at: number;
  pagesPerSec: number | null;
  stalled: boolean;
}

/**
 * Whether the host's swap-in past the threshold has been followed by stall. Over the verdicts in the last
 * SWAP_STALL_HISTORY_MS whose SWAP_STALL_WINDOW_MS has closed, the share followed by a stalled verdict within that window,
 * for those with swap-in past the threshold against all of them, with twice the swap-in share's sampling noise.
 */
export function swapStallRelationOf(history: SwapStallSample[], now: number, policy: HostMemoryBudgetPolicy): SwapStallRelation {
  const closed = history.filter((s) => now - s.at >= SWAP_STALL_WINDOW_MS && now - s.at <= SWAP_STALL_HISTORY_MS)
    .sort((x, y) => x.at - y.at);
  const stalls = history.filter((s) => s.stalled).map((s) => s.at).sort((x, y) => x - y);
  const followed = (at: number): boolean => {
    let lo = 0;
    let hi = stalls.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (stalls[mid]! < at) lo = mid + 1;
      else hi = mid;
    }
    return lo < stalls.length && stalls[lo]! <= at + SWAP_STALL_WINDOW_MS;
  };
  const swapping = closed.filter((s) => s.pagesPerSec !== null && s.pagesPerSec > policy.swapInPagesPerSecMax);
  if (swapping.length < SWAP_STALL_MIN_SAMPLES) {
    return { unlearned: `${swapping.length} of ${SWAP_STALL_MIN_SAMPLES} verdicts with swap-in past ${policy.swapInPagesPerSecMax} pages/s and a closed window` };
  }
  const afterAny = closed.filter((s) => followed(s.at)).length / closed.length;
  const afterSwapIn = swapping.filter((s) => followed(s.at)).length / swapping.length;
  return { samples: swapping.length, afterSwapIn, afterAny, noise: 2 * Math.sqrt(afterAny * (1 - afterAny) / swapping.length) };
}

/** Same closed windows, history span, minimum and noise as the swap-in relation; the outcome is OWN pressure. */
export function containerLiftOf(history: ContainerPressureSample[], now: number): ContainerLift {
  const closed = history.filter((s) => now - s.at >= SWAP_STALL_WINDOW_MS && now - s.at <= SWAP_STALL_HISTORY_MS);
  const pressed = history.filter((s) => s.pressed && s.at <= now).map((s) => s.at).sort((x, y) => x - y);
  const followed = (at: number): boolean => {
    let lo = 0;
    let hi = pressed.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pressed[mid]! < at) lo = mid + 1;
      else hi = mid;
    }
    return lo < pressed.length && pressed[lo]! <= at + SWAP_STALL_WINDOW_MS;
  };
  const flagged = closed.filter((s) => s.projected);
  if (flagged.length < SWAP_STALL_MIN_SAMPLES) {
    return { unlearned: `${flagged.length} of ${SWAP_STALL_MIN_SAMPLES} flagged verdicts with a closed window` };
  }
  const afterAny = closed.filter((s) => followed(s.at)).length / closed.length;
  const afterProjection = flagged.filter((s) => followed(s.at)).length / flagged.length;
  return { samples: flagged.length, afterProjection, afterAny, noise: 2 * Math.sqrt(afterAny * (1 - afterAny) / flagged.length) };
}

function containerPredictsPressure(relation: ContainerLift | undefined): { counts: boolean; basis: string } {
  if (relation === undefined) return { counts: true, basis: "the projection alone: no container history read" };
  if ("unlearned" in relation) return { counts: true, basis: `the projection alone: ${relation.unlearned}` };
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  const counts = relation.afterProjection - relation.afterAny > relation.noise;
  return {
    counts,
    basis: `projection ${counts ? "predicts" : "does not predict"} pressure: ${pct(relation.afterProjection)} of ${relation.samples} ` +
      `flagged verdicts were followed by it, against ${pct(relation.afterAny)} of all (noise ${pct(relation.noise)})`,
  };
}

/** Whether swap-in past the threshold counts in this verdict, and the basis a row records. */
function swapInPredictsStall(relation: SwapStallRelation | undefined): { counts: boolean; basis: string } {
  if (relation === undefined) return { counts: true, basis: "the rate alone: no swap-in history read" };
  if ("unlearned" in relation) return { counts: true, basis: `the rate alone: ${relation.unlearned}` };
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  const counts = relation.afterSwapIn - relation.afterAny > relation.noise;
  return {
    counts,
    basis: `swap-in ${counts ? "predicts" : "does not predict"} stall: ${pct(relation.afterSwapIn)} of ${relation.samples} ` +
      `swap-in verdicts were followed by one, against ${pct(relation.afterAny)} of all (noise ${pct(relation.noise)})`,
  };
}

/** One verdict in the PSI record: host full avg10 and avg60 (null: unread), whether its start was admitted, and the
 *  cumulative /proc/vmstat oom_kill (null: unread). */
export interface PsiStartSample {
  at: number;
  fullAvg10: number | null;
  fullAvg60: number | null;
  admitted: boolean;
  oomKill: number | null;
}

/** The bound a verdict applies: the record's, never below the prior; no record read, the prior. */
function psiBoundFor(learned: PsiFullAvg10Bound | undefined, policy: HostMemoryBudgetPolicy): PsiFullAvg10Bound {
  const prior = policy.psiFullAvg10Max;
  if (learned === undefined) return priorBound(prior, "no PSI record read", 0);
  return { ...learned, prior, bound: Math.max(prior, learned.bound) };
}

function priorBound(prior: number, why: string, samples: number, at?: Partial<PsiFullAvg10Bound>): PsiFullAvg10Bound {
  return { bound: prior, prior, basis: `the prior ${prior}: ${why}`, samples, afterAdmitted: null, afterBand: null,
    noise: null, ooms: null, ...at };
}

/**
 * W1-T10085: the PSI full avg10 bound learned from the record. A verdict is HARMED when, within SWAP_STALL_WINDOW_MS,
 * oom_kill changed from its last reading or a later verdict read full avg60 past the PRIOR: the outcome never reads the
 * learned bound. For each admitted level v above the prior, the admitted starts with closed windows in (prior, v] are
 * compared with every verdict in that band; the bound is the largest v with SWAP_STALL_MIN_SAMPLES such starts, a lift
 * within twice the noise, no OOM kill after one, and oom_kill read in the band. Otherwise the prior, and why.
 */
export function psiStartBoundOf(history: PsiStartSample[], now: number, policy: HostMemoryBudgetPolicy, unread?: string): PsiFullAvg10Bound {
  const prior = policy.psiFullAvg10Max;
  if (unread !== undefined) return priorBound(prior, unread, 0);
  const sorted = history.filter((s) => s.at <= now).sort((x, y) => x.at - y.at);
  const outcome = (i: number): { harmed: boolean; oom: boolean } => {
    const s = sorted[i]!;
    let read = s.oomKill;
    for (let j = i - 1; read === null && j >= 0; j--) read = sorted[j]!.oomKill;
    let stall = false;
    let oom = false;
    for (let j = i + 1; j < sorted.length && sorted[j]!.at <= s.at + SWAP_STALL_WINDOW_MS; j++) {
      const later = sorted[j]!;
      if (later.at === s.at) continue;
      if ((later.fullAvg60 ?? 0) > prior) stall = true;
      // A count that went down is a reboot: harm too.
      if (later.oomKill !== null && read !== null && later.oomKill !== read) oom = true;
    }
    return { harmed: stall || oom, oom };
  };
  const band = sorted.map((s, i) => ({ s, i })).filter(({ s }) => s.fullAvg10 !== null && s.fullAvg10 > prior &&
    now - s.at >= SWAP_STALL_WINDOW_MS && now - s.at <= SWAP_STALL_HISTORY_MS)
    .map(({ s, i }) => ({ ...s, level: s.fullAvg10!, ...outcome(i) })).sort((x, y) => x.level - y.level);
  const admitted = band.filter((s) => s.admitted);
  const allOomUnread = admitted.every((s) => s.oomKill === null);
  const ooms = allOomUnread ? null : admitted.filter((s) => s.oom).length;
  if (admitted.length < SWAP_STALL_MIN_SAMPLES) {
    return priorBound(prior, `${admitted.length} of ${SWAP_STALL_MIN_SAMPLES} admitted starts above it with a closed window`,
      admitted.length, { ooms });
  }
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  let learned: PsiFullAvg10Bound | undefined;
  let refused = "";
  let judged: Partial<PsiFullAvg10Bound> = {};
  let inBand = 0;
  let harmedInBand = 0;
  let inAdmitted = 0;
  let harmedAdmitted = 0;
  let oomsAdmitted = 0;
  let oomRead = false;
  let levelAdmitted = false;
  for (let k = 0; k < band.length; k++) {
    const s = band[k]!;
    inBand += 1;
    if (s.harmed) harmedInBand += 1;
    if (s.oomKill !== null) oomRead = true;
    if (s.admitted) {
      levelAdmitted = true;
      inAdmitted += 1;
      if (s.harmed) harmedAdmitted += 1;
      if (s.oom) oomsAdmitted += 1;
    }
    // Judged once per admitted level, with every verdict at that level in the band.
    if (k + 1 < band.length && band[k + 1]!.level === s.level) continue;
    if (!levelAdmitted) continue;
    levelAdmitted = false;
    if (oomsAdmitted > 0) {
      refused = `${oomsAdmitted} admitted start(s) at full avg10 ${prior}-${s.level} followed by an OOM kill`;
      break;
    }
    if (inAdmitted < SWAP_STALL_MIN_SAMPLES) continue;
    if (!oomRead) {
      refused = `oom_kill unread on every verdict at full avg10 ${prior}-${s.level}`;
      continue;
    }
    const afterAdmitted = harmedAdmitted / inAdmitted;
    const afterBand = harmedInBand / inBand;
    const noise = 2 * Math.sqrt(afterBand * (1 - afterBand) / inAdmitted);
    const line = `${pct(afterAdmitted)} of ${inAdmitted} admitted starts at full avg10 ${prior}-${s.level} were followed by ` +
      `stall or an OOM kill, against ${pct(afterBand)} of all ${inBand} verdicts in that band (noise ${pct(noise)})`;
    if (afterAdmitted - afterBand > noise) {
      refused = line;
      judged = { afterAdmitted, afterBand, noise };
      continue;
    }
    learned = { bound: s.level, prior, basis: `learned ${s.level}: ${line}`, samples: inAdmitted, afterAdmitted, afterBand, noise, ooms };
  }
  return learned ?? priorBound(prior, refused, admitted.length, { ooms, ...judged });
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
  /** Optional provenance for that exact numeric estimate; absence is unknown, never inferred from its value. */
  estimateSource?: EstimateSource;
  /** The state root: the ledger names its instance (see `instance`), and its ledger holds daemon.alive and serve rows. */
  root: string;
}

export interface ShadowMemoryPorts {
  calibrationSamples?: (storeDir?: string) => PeakSample[];
  publishCalibration?: (stateDir: string, forecast: MemoryForecast) => void;
  calibrationObservation?: (at: number) => ReturnType<typeof kernelMemoryObservation>;
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
  /** W1-T8711: serve's shared producer evidence at `now`; absent, the local ledger tail alone decides, as it always did. */
  readHostServe?: (now: number) => HostServeReading;
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
  /** A class's learned TYPICAL (median) peak (host-memory-learning.ts). */
  typical: (workerClass: WorkerClass) => number;
  /** W1-T9762: a class's measured survival at a live tree's age (host-memory-learning.ts). Absent: nothing decays. */
  survival?: (workerClass: WorkerClass, ageMs: number) => Survival;
  /** Writes the instance's pressure store (its prior swap-in sample and its swap-in history). */
  writeFile: (path: string, content: string) => void;
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
  installCalibrationSink(sink ? (stateDir, at, report) => sink(join(stateDir, LEDGER_FILENAME), {
    run_id: "memory-calibration", task_id: "MEMORY-BUDGET", step: "memory_budget.backtest", observed_at_ms: at, ...report,
  }) : undefined);
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
    readHostServe: (now) => readHostServeEvidence({ clock: fixedClock(now) }),
    priorityPolicy: () => HOST_MEMORY_PRIORITY_PROPOSAL,
    instance: (root) => defaultInstance(root).name,
    daemonPid: () => {
      const pid = Number(process.env[DAEMON_PID_ENV]);
      return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    },
    listStateDir: (dir) => readdirSync(dir),
    estimate: (workerClass) => classEstimate(workerClass).estimateMib,
    typical: (workerClass) => classTypical(workerClass).estimateMib,
    survival: (workerClass, ageMs) => classSurvival(workerClass, ageMs),
    calibrationSamples: storeDir => storeDir ? WORKER_CLASSES.flatMap(workerClass => readPeakSamples(workerClass, {
      location: () => ({ dir: storeDir }),
    })) : [],
    publishCalibration: (stateDir, forecast) => {
      if (!existsSync(stateDir)) throw Object.assign(new Error("calibration state directory unavailable"), { code: "ENOENT" });
      publishMemoryForecast(stateDir, forecast);
    },
    calibrationObservation: at => kernelMemoryObservation(at),
    // Never creates the state directory: a root without one (a test's, a fresh checkout's) stores nothing.
    writeFile: (path, content) => {
      if (!existsSync(dirname(path))) throw Object.assign(new Error(`ENOENT: ${dirname(path)}`), { code: "ENOENT" });
      writeAtomic(path, content, { tmpTag: "pressure-tmp" });
    },
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

function readPsi(read: ShadowMemoryPorts["readFile"], path = "/proc/pressure/memory"): ShadowInputs["psi"] {
  let text: string;
  try {
    text = read(path);
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

/** The instance's pressure store, beside its ledger: the previous verdict's pswpin and memory.events `high` counts (any
 *  process of the instance, so a short-lived child still measures a rate) and the swap-in and container projection
 *  histories. A store written before #10907's successor also holds `sightings`, which nothing reads any more and the
 *  next write drops. */
export const CONTAINER_PRESSURE_FILE = "container-pressure.json";
/** BACKSTOP on the swap-in history kept; six hours of verdicts is about a thousand. */
const SWAP_HISTORY_CAP = 4096;

interface PressureStore {
  prior?: { at: number; pswpin?: number; high?: number };
  /** [at, pages/s or null, 1 when stalled]: compact, since the store is rewritten on every verdict. */
  swap: Array<[number, number | null, 0 | 1]>;
  /** [at, 1 when projection exceeds onset, 1 when under own pressure]. */
  container: Array<[number, 0 | 1, 0 | 1]>;
  /** W1-T10085: [at, host full avg10, 1 when its start was admitted, cumulative oom_kill, host full avg60]. */
  psi: PsiEntry[];
  /** Why the store could not be read; the PSI bound then keeps the prior. */
  unread?: string;
  validationObservation?: StrictPressureSample;
  validationMarker?: StrictPsiTarget;
  validationMalformed?: true;
}

type PsiEntry = [number, number | null, 0 | 1, number | null, number | null];

export interface StrictPressureSample {
  version: 1;
  sampleId: string;
  sampleAt: number;
  generation: { bootId: string; cgroup: string; initStart: string };
  counters: { hostPswpin: number; containerPswpin: number; high: number };
}
export interface StrictPsiTarget { sample: StrictPressureSample; row: PsiEntry }
export type StrictPressureEvidence =
  | { kind: "paired"; current: StrictPressureSample; prior: StrictPressureSample; marker: StrictPsiTarget;
      elapsedMs: number; hostPagesPerSec: number; containerPagesPerSec: number; ceilingCrossings: number;
      observationWrite: "returned" }
  | { kind: "unavailable"; reasons: string[]; current?: StrictPressureSample; marker?: StrictPsiTarget;
      observationWrite: "not-attempted" | "returned" | "unknown" };

const STRICT_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
type StrictRead<T> = { kind: "available"; value: T }
  | { kind: "unavailable"; reason: "malformed" }
  | { kind: "unavailable"; reason: "unreadable"; code: "EACCES" | "EPERM" | "ENOENT" | "EIO" | "ENOTDIR" | "EISDIR" | "UNKNOWN" };
function strictReadErrorCode(error: unknown): Extract<StrictRead<never>, { reason: "unreadable" }>['code'] {
  try {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code === "EACCES" || code === "EPERM" || code === "ENOENT" || code === "EIO" ||
      code === "ENOTDIR" || code === "EISDIR" ? code : "UNKNOWN";
  } catch {
    // A hostile diagnostic accessor is unknown, never an escaping error or private message.
    return "UNKNOWN";
  }
}
function strictReadIssue(family: "generation" | "counter", result: Exclude<StrictRead<unknown>, { kind: "available" }>): string {
  return `strict-observation-${family}-${result.reason}${result.reason === "unreadable" ? `:${result.code}` : ""}`;
}
function strictGenerationOf(read: ShadowMemoryPorts["readFile"]): StrictRead<StrictPressureSample["generation"]> {
  try {
    const bootId = read("/proc/sys/kernel/random/boot_id").trim(), cgroup = read("/proc/self/cgroup").trim();
    const init = parseProcStat(read("/proc/1/stat"));
    if (!STRICT_UUID.test(bootId) || !/^0::\/[^\n]*$/.test(cgroup) || !init || init.start === "unknown") return { kind: "unavailable", reason: "malformed" };
    return { kind: "available", value: { bootId, cgroup, initStart: init.start } };
  } catch (error) { return { kind: "unavailable", reason: "unreadable", code: strictReadErrorCode(error) }; }
}
function sameStrictGeneration(a: StrictPressureSample["generation"], b: StrictPressureSample["generation"]): boolean {
  return a.bootId === b.bootId && a.cgroup === b.cgroup && a.initStart === b.initStart;
}
function strictSampleOf(value: unknown): StrictPressureSample | undefined {
  const s = value as Partial<StrictPressureSample> | null;
  if (!s || s.version !== 1 || typeof s.sampleId !== "string" || !STRICT_UUID.test(s.sampleId) ||
      typeof s.sampleAt !== "number" || !Number.isFinite(s.sampleAt) || s.sampleAt < 0 || !s.generation || !s.counters) return undefined;
  const g = s.generation, c = s.counters;
  if (typeof g.bootId !== "string" || !STRICT_UUID.test(g.bootId) || typeof g.cgroup !== "string" || !/^0::\/[^\n]*$/.test(g.cgroup) ||
      typeof g.initStart !== "string" || !/^proc:\d+$/.test(g.initStart) ||
      ![c.hostPswpin, c.containerPswpin, c.high].every(n => Number.isSafeInteger(n) && n >= 0)) return undefined;
  return { version: 1, sampleId: s.sampleId, sampleAt: s.sampleAt,
    generation: { bootId: g.bootId, cgroup: g.cgroup, initStart: g.initStart },
    counters: { hostPswpin: c.hostPswpin, containerPswpin: c.containerPswpin, high: c.high } };
}
function strictPsiRowOf(value: unknown): PsiEntry | undefined {
  if (!Array.isArray(value) || value.length !== 5 || !Number.isFinite(value[0]) || (value[2] !== 0 && value[2] !== 1) ||
      ![value[1], value[3], value[4]].every(v => v === null || (typeof v === "number" && Number.isFinite(v)))) return undefined;
  return [...value] as PsiEntry;
}
function sameStrictSample(a: StrictPressureSample, b: StrictPressureSample): boolean {
  return a.sampleId === b.sampleId && a.sampleAt === b.sampleAt && sameStrictGeneration(a.generation, b.generation) &&
    a.counters.hostPswpin === b.counters.hostPswpin && a.counters.containerPswpin === b.counters.containerPswpin && a.counters.high === b.counters.high;
}
function strictTargetOf(value: unknown): StrictPsiTarget | undefined {
  const v = value as Partial<StrictPsiTarget> | null, sample = strictSampleOf(v?.sample), row = strictPsiRowOf(v?.row);
  return sample && row && row[0] === sample.sampleAt && row[2] === 0 ? { sample, row } : undefined;
}
function strictCounter(read: ShadowMemoryPorts["readFile"], path: string, key: string): StrictRead<number> {
  try {
    const raw = new RegExp(`^${key}[ \\t]+(\\d+)$`, "m").exec(read(path))?.[1];
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? { kind: "available", value: n } : { kind: "unavailable", reason: "malformed" };
  } catch (error) { return { kind: "unavailable", reason: "unreadable", code: strictReadErrorCode(error) }; }
}
interface StrictGather {
  generation: StrictRead<StrictPressureSample["generation"]>;
  rawRead: ShadowMemoryPorts["readFile"];
}
type StrictWindowNumbers = Pick<Extract<StrictPressureEvidence, { kind: "paired" }>,
  "prior" | "elapsedMs" | "hostPagesPerSec" | "containerPagesPerSec" | "ceilingCrossings">;
function strictWindow(store: PressureStore, current: StrictPressureSample | undefined, policy: HostMemoryBudgetPolicy): string[] {
  if (!current) return ["strict-observation-current-unavailable"];
  if (store.validationMalformed) return ["strict-observation-malformed"];
  if (store.unread !== undefined && store.unread !== "ENOENT") return ["strict-observation-history-unavailable"];
  const prior = store.validationObservation;
  if (!prior) return ["strict-observation-untagged"];
  if (!sameStrictGeneration(prior.generation, current.generation)) return ["strict-observation-generation-mismatch"];
  const elapsed = current.sampleAt - prior.sampleAt;
  if (elapsed <= 0) return ["strict-observation-nonpositive-window"];
  if (elapsed > policy.staleReadingMs) return ["strict-observation-stale"];
  if (elapsed > CROSSING_WINDOW_MS) return ["strict-observation-crossing-stale"];
  if (current.counters.hostPswpin < prior.counters.hostPswpin || current.counters.containerPswpin < prior.counters.containerPswpin ||
      current.counters.high < prior.counters.high) return ["strict-observation-counter-reset"];
  return [];
}

function readPressureStore(read: ShadowMemoryPorts["readFile"], path: string, strictPsi = false): PressureStore {
  let parsed: Partial<PressureStore>;
  try {
    parsed = JSON.parse(read(path)) as Partial<PressureStore>;
  } catch (error) {
    // No store yet, or a torn one: no prior sample and no history, so the rate reads unmeasured.
    return { swap: [], container: [], psi: [], unread: error instanceof SyntaxError ? "unparseable" : reasonOf(error) };
  }
  if (strictPsi && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
    return { swap: [], container: [], psi: [], unread: "strict-psi-malformed" };
  }
  const finite = (...n: unknown[]): boolean => n.every((v) => typeof v === "number" && Number.isFinite(v));
  const prior = parsed.prior && finite(parsed.prior.at) ? parsed.prior : undefined;
  const swap = Array.isArray(parsed.swap)
    ? parsed.swap.filter((s) => Array.isArray(s) && finite(s[0]) && (s[1] === null || finite(s[1])) && (s[2] === 0 || s[2] === 1))
    : [];
  const container = Array.isArray(parsed.container)
    ? parsed.container.filter((s) => Array.isArray(s) && finite(s[0]) && (s[1] === 0 || s[1] === 1) && (s[2] === 0 || s[2] === 1))
    : [];
  const nullable = (v: unknown): boolean => v === null || finite(v);
  const psi = Array.isArray(parsed.psi)
    ? parsed.psi.filter((s) => Array.isArray(s) && finite(s[0]) && nullable(s[1]) && (s[2] === 0 || s[2] === 1) &&
      nullable(s[3]) && nullable(s[4]))
    : [];
  if (strictPsi && (!Array.isArray(parsed.psi) || psi.length !== parsed.psi.length || parsed.psi.some(s => s.length !== 5))) {
    return { swap: [], container: [], psi: [], unread: "strict-psi-malformed" };
  }
  const validationObservation = strictSampleOf(parsed.validationObservation), validationMarker = strictTargetOf(parsed.validationMarker);
  const validationMalformed = (parsed.validationObservation !== undefined && !validationObservation) ||
    (parsed.validationMarker !== undefined && (!validationMarker || !validationObservation || !sameStrictSample(validationMarker.sample, validationObservation)));
  return { ...(prior ? { prior } : {}), swap, container, psi,
    ...(validationObservation ? { validationObservation } : {}), ...(validationMarker ? { validationMarker } : {}),
    ...(validationMalformed ? { validationMalformed: true as const } : {}) };
}

function readOomKill(read: ShadowMemoryPorts["readFile"]): number | null {
  try {
    const raw = /^oom_kill (\d+)$/m.exec(read("/proc/vmstat"))?.[1];
    return raw === undefined ? null : Number(raw);
  } catch (error) {
    void error; // Unread: this verdict carries no OOM reading, and a band with none keeps the prior.
    return null;
  }
}

export type StrictPsiStartMark =
  | { kind: "recorded"; at: number; sampleId: string }
  | { kind: "not-recorded"; reason: "unavailable" | "malformed" | "missing" | "ambiguous" | "already-recorded" | "changed"; at: number }
  | { kind: "unknown"; reason: "write-failed"; at: number };

/** The legacy three-argument boolean API and best-effort behavior remain unchanged. */
export function markPsiStartAdmitted(ports: Pick<ShadowMemoryPorts, "readFile" | "writeFile">, root: string, at: number): boolean {
  return markPsiStart(ports, root, at);
}

/** A recorded strict result means this synchronous write returned, not cross-process atomicity or a child start. */
export function markStrictPsiStartAdmitted(ports: Pick<ShadowMemoryPorts, "readFile" | "writeFile">, root: string, target: StrictPsiTarget): StrictPsiStartMark {
  return markPsiStart(ports, root, target.sample.sampleAt, { target });
}

function markPsiStart(ports: Pick<ShadowMemoryPorts, "readFile" | "writeFile">, root: string, at: number): boolean;
function markPsiStart(ports: Pick<ShadowMemoryPorts, "readFile" | "writeFile">, root: string, at: number,
  options: { target: StrictPsiTarget }): StrictPsiStartMark;
function markPsiStart(ports: Pick<ShadowMemoryPorts, "readFile" | "writeFile">, root: string, at: number,
  options?: { target: StrictPsiTarget }): boolean | StrictPsiStartMark {
  const notRecorded = (reason: Extract<StrictPsiStartMark, { kind: "not-recorded" }>['reason']): boolean | StrictPsiStartMark =>
    options ? { kind: "not-recorded", reason, at } : false;
  let writing = false;
  try {
    const path = join(root, "state", CONTAINER_PRESSURE_FILE);
    const { unread, validationMalformed, ...store } = readPressureStore(ports.readFile, path, options !== undefined);
    if (options) {
      if (!Number.isFinite(at)) return notRecorded("unavailable");
      if (unread !== undefined) return notRecorded(unread === "unparseable" || unread === "strict-psi-malformed" ? "malformed" : "unavailable");
      if (validationMalformed) return notRecorded("malformed");
      const matches = store.psi.filter(([stamp]) => stamp === at);
      if (matches.length !== 1) return notRecorded(matches.length === 0 ? "missing" : "ambiguous");
      if (matches[0]![2] !== 0) return notRecorded("already-recorded");
      const expected = strictTargetOf(options.target);
      if (!expected || !store.validationObservation || !store.validationMarker ||
          !sameStrictSample(expected.sample, store.validationObservation) || !sameStrictSample(expected.sample, store.validationMarker.sample) ||
          JSON.stringify(expected.row) !== JSON.stringify(store.validationMarker.row) || JSON.stringify(expected.row) !== JSON.stringify(matches[0])) return notRecorded("changed");
    }
    const entry = unread === undefined ? store.psi.find(([stamp]) => stamp === at) : undefined;
    if (entry === undefined) return notRecorded("missing");
    entry[2] = 1;
    writing = true;
    ports.writeFile(path, `${JSON.stringify(store)}\n`);
    return options ? { kind: "recorded", at, sampleId: options.target.sample.sampleId } : true;
  } catch (error) {
    void error; // Legacy remains best-effort; strict mode reports unknown if a write may already have had effects.
    return options ? writing ? { kind: "unknown", reason: "write-failed", at } : { kind: "not-recorded", reason: "unavailable", at } : false;
  }
}

/**
 * This container's own pressure (memory.pressure, memory.stat pswpin as a rate and memory.events `high` crossings, both
 * since the instance's previous verdict), and the host swap-in relation learned from the instance's history, to which
 * this verdict's host reading is added. Never throws: a store that cannot be written leaves the reading intact.
 */
function readContainerPressure(
  ports: ShadowMemoryPorts, root: string, now: number, policy: HostMemoryBudgetPolicy,
  snapshot: ShadowInputs, admitted: boolean, strict?: StrictGather,
): Pick<ShadowInputs, "psiBound" | "psiRecordAt" | "strictEvidence" | "swapIn"> & { containerPressure: ContainerPressureInput; swapStall: SwapStallRelation; containerLift: ContainerLift } {
  const path = join(root, "state", CONTAINER_PRESSURE_FILE);
  const store = readPressureStore(ports.readFile, path, strict !== undefined);
  const psi = readPsi(ports.readFile, "/sys/fs/cgroup/memory.pressure");
  let pswpin: number | undefined;
  let swapIn: { pagesPerSec: number } | { unmeasured: string };
  try {
    const raw = /^pswpin (\d+)$/m.exec(ports.readFile("/sys/fs/cgroup/memory.stat"))?.[1];
    pswpin = raw === undefined ? undefined : Number(raw);
    swapIn = { unmeasured: "no pswpin in memory.stat" };
  } catch (error) {
    // No memory.stat: the container's swap-in is unmeasured and named; its PSI may still show its pressure.
    swapIn = { unmeasured: reasonOf(error) };
  }
  let high: number | undefined;
  try {
    const raw = /^high (\d+)$/m.exec(ports.readFile("/sys/fs/cgroup/memory.events"))?.[1];
    high = raw === undefined ? undefined : Number(raw);
  } catch (error) {
    void error; // No memory.events: crossings are unmeasured, so the container is never read as at its ceiling.
  }
  const prior = store.prior;
  const fresh = prior !== undefined && now > prior.at && now - prior.at <= policy.staleReadingMs;
  if (pswpin !== undefined) {
    if (!prior || prior.pswpin === undefined) swapIn = { unmeasured: "no prior sample in this instance" };
    else if (now <= prior.at) swapIn = { unmeasured: "no elapsed time since the prior sample" };
    else if (!fresh) swapIn = { unmeasured: `stale: prior sample ${Math.round((now - prior.at) / 1000)}s old` };
    else swapIn = { pagesPerSec: Math.max(0, pswpin - prior.pswpin) / ((now - prior.at) / 1000) };
  }
  // A counter that went down belongs to a new cgroup (the container was recreated): its whole count is new.
  let crossings = high === undefined || !fresh || prior!.high === undefined || now - prior!.at > CROSSING_WINDOW_MS ? null
    : high >= prior!.high ? high - prior!.high : high;
  let current: StrictPressureSample | undefined, window: StrictWindowNumbers | undefined, issues: string[] = [], hostSwapIn = snapshot.swapIn;
  if (strict) {
    const hostCounter = strictCounter(ports.readFile, "/proc/vmstat", "pswpin");
    const hostPswpin = hostCounter.kind === "available" ? hostCounter.value : undefined;
    const after = strictGenerationOf(strict.rawRead);
    if (strict.generation.kind !== "available" || after.kind !== "available") {
      issues.push("strict-observation-generation-unavailable");
      for (const result of [strict.generation, after]) if (result.kind === "unavailable") issues.push(strictReadIssue("generation", result));
    } else if (!sameStrictGeneration(strict.generation.value, after.value)) issues.push("strict-observation-generation-changed");
    else if (!Number.isFinite(now) || now < 0) issues.push("strict-observation-clock-unavailable");
    else if (hostPswpin === undefined || !Number.isSafeInteger(pswpin) || pswpin! < 0 || !Number.isSafeInteger(high) || high! < 0) {
      issues.push("strict-observation-counter-unavailable");
      if (hostCounter.kind === "unavailable") issues.push(strictReadIssue("counter", hostCounter));
    } else current = { version: 1, sampleId: randomUUID(), sampleAt: now, generation: after.value,
      counters: { hostPswpin, containerPswpin: pswpin!, high: high! } };
    if (current) issues.push(...strictWindow(store, current, policy));
    if (issues.length === 0 && current && store.validationObservation) {
      const old = store.validationObservation, seconds = (current.sampleAt - old.sampleAt) / 1000;
      window = { prior: old, elapsedMs: current.sampleAt - old.sampleAt,
        hostPagesPerSec: (current.counters.hostPswpin - old.counters.hostPswpin) / seconds,
        containerPagesPerSec: (current.counters.containerPswpin - old.counters.containerPswpin) / seconds,
        ceilingCrossings: current.counters.high - old.counters.high };
      hostSwapIn = { pagesPerSec: window.hostPagesPerSec };
      swapIn = { pagesPerSec: window.containerPagesPerSec };
      crossings = window.ceilingCrossings;
    } else {
      hostSwapIn = { unmeasured: issues.join("+") };
      swapIn = { unmeasured: issues.join("+") };
      crossings = null;
    }
  }
  const observedSnapshot = strict ? { ...snapshot, swapIn: hostSwapIn } : snapshot;
  const containerPressure: ContainerPressureInput = {
    swapIn,
    psi: "unread" in psi ? psi : { someAvg10: psi.someAvg10, ...(psi.fullAvg10 !== undefined ? { fullAvg10: psi.fullAvg10 } : {}) },
    ceilingCrossings: crossings,
  };
  const history: SwapStallSample[] = store.swap.map(([at, pagesPerSec, stalled]) => ({ at, pagesPerSec, stalled: stalled === 1 }));
  const swapStall = swapStallRelationOf(history, now, policy);
  const containerLift = containerLiftOf(store.container.map(([at, projected, pressed]) => ({
    at, projected: projected === 1, pressed: pressed === 1,
  })), now);
  const hostPsi = "unread" in observedSnapshot.psi ? null : observedSnapshot.psi;
  const stalled = hostPsi !== null && (hostPsi.someAvg10 > policy.psiSomeAvg10Max || (hostPsi.fullAvg10 ?? 0) > policy.psiFullAvg10Max);
  const rate = "pagesPerSec" in observedSnapshot.swapIn ? Math.round(observedSnapshot.swapIn.pagesPerSec) : null;
  const swap = [...store.swap, [now, rate, stalled ? 1 : 0] as [number, number | null, 0 | 1]]
    .filter(([at]) => now - at <= SWAP_STALL_HISTORY_MS).slice(-SWAP_HISTORY_CAP);
  const psiBound = psiStartBoundOf(store.psi.map(([at, fullAvg10, admit, oomKill, fullAvg60]) => ({
    at, fullAvg10, fullAvg60, admitted: admit === 1, oomKill,
  })), now, policy, store.unread === undefined ? undefined : `pressure store unread (${store.unread})`);
  const psiRow: PsiEntry = [now, hostPsi?.fullAvg10 ?? null, admitted ? 1 : 0, readOomKill(ports.readFile), hostPsi?.fullAvg60 ?? null];
  const psiSeries = [...store.psi, psiRow].filter(([at]) => now - at <= SWAP_STALL_HISTORY_MS).slice(-SWAP_HISTORY_CAP);
  // Evaluate the same pure projection as the caller, before storing this outcome; this row cannot train its own lift.
  const numbers = evaluateShadowMemory({ ...observedSnapshot, containerPressure, swapStall, containerLift }, policy).numbers;
  const flagged = numbers.containerProjectedMib !== null && numbers.containerOnsetMib !== null &&
    numbers.containerProjectedMib > numbers.containerOnsetMib;
  const container = [...store.container, [now, flagged ? 1 : 0, numbers.containerPressed ? 1 : 0] as [number, 0 | 1, 0 | 1]]
    .filter(([at]) => now - at <= SWAP_STALL_HISTORY_MS).slice(-SWAP_HISTORY_CAP);
  const marker: StrictPsiTarget | undefined = current ? { sample: current, row: [...psiRow] } : undefined;
  const tags = strict ? current ? { validationObservation: current, validationMarker: marker } : {}
    : { ...(store.validationObservation ? { validationObservation: store.validationObservation } : {}),
      ...(store.validationMarker ? { validationMarker: store.validationMarker } : {}) };
  const next = { prior: { at: now, ...(pswpin !== undefined ? { pswpin } : {}), ...(high !== undefined ? { high } : {}) }, swap, container,
    psi: psiSeries, ...tags };
  let observationWrite: "not-attempted" | "returned" | "unknown" = "not-attempted";
  if (!strict || current) {
    observationWrite = "unknown";
    try {
      ports.writeFile(path, `${JSON.stringify(next)}\n`);
      observationWrite = "returned";
    } catch (error) {
      void error; // A thrown writer may already have replaced the file; strict evidence never calls that persisted.
    }
  }
  if (strict && observationWrite === "unknown") issues.push("strict-observation-write-failed");
  const strictEvidence: StrictPressureEvidence | undefined = !strict ? undefined
    : issues.length === 0 && current && marker && window && observationWrite === "returned"
      ? { kind: "paired", current, marker, ...window, observationWrite }
      : { kind: "unavailable", reasons: issues, ...(current ? { current } : {}), ...(marker ? { marker } : {}), observationWrite };
  return { containerPressure, swapStall, containerLift, psiBound, psiRecordAt: now, swapIn: hostSwapIn,
    ...(strictEvidence ? { strictEvidence } : {}) };
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

/** A daemon container's own memory headroom: min(memory.high, memory.max) less its working set (memory.current less
 *  inactive_file). `unbounded` when neither limit is set; `unread` with the reason when the cgroup cannot be read. */
export type ContainerMemoryHeadroom =
  | { headroomMib: number; ceilingMib: number; workingSetMib: number }
  | { unbounded: true }
  | { unread: string };

/**
 * This container's own headroom, as the container check above measures it: min(memory.high, memory.max) less the
 * working set (memory.current less inactive_file). The dispatch memory floor reads it beside the host's MemAvailable.
 */
export function readContainerMemoryHeadroom(
  read: ShadowMemoryPorts["readFile"] = (path) => readFileSync(path, "utf8"),
): ContainerMemoryHeadroom {
  const container = readContainer(read);
  if ("unread" in container) return container;
  const limits = [container.maxMib, container.highMib ?? null].filter((v): v is number => v !== null);
  if (limits.length === 0) return { unbounded: true };
  const ceilingMib = Math.min(...limits);
  const workingSetMib = Math.max(0, container.currentMib - (container.reclaimableMib ?? 0));
  return { headroomMib: ceilingMib - workingSetMib, ceilingMib, workingSetMib };
}

/** Whether THIS container holds live, unreleased reserved work whose end can free memory. An unreadable reservation
 *  ledger shows none, so the dispatch floor does not wait on work it cannot see: it fails open, and names its tier. */
export function ownContainerWorkLive(
  root: string,
  readLedger: (root: string) => HostMemoryReading | undefined = (r) => readMemoryLedger({ root: r }),
): boolean {
  try {
    return (readLedger(root)?.entries ?? []).some((entry) => entry.status === "owned" && !entry.occupancyReleased);
  } catch (error) {
    void error; // No reading: no live work can be shown, so the container tier admits as nothing-to-wait-for.
    return false;
  }
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

const identityKey = (p: ProcessIdentity): string => `${p.pid}:${p.start}`;

/** One recorded tree's identities (roots first, deduplicated), or why its entry file could not be read. */
function recordedTree(read: ShadowMemoryPorts["readFile"], entryPath: string): { roots: ProcessIdentity[]; tree: ProcessIdentity[] } | { unread: string } {
  try {
    const parsed = JSON.parse(read(entryPath)) as { tree?: ProcessIdentity[]; roots?: ProcessIdentity[] };
    const seen = new Set<string>();
    const tree = [...(parsed.roots ?? []), ...(parsed.tree ?? [])].filter((p) => {
      const key = identityKey(p);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { roots: parsed.roots ?? [], tree };
  } catch (error) {
    const reason = reasonOf(error);
    return { unread: reason };
  }
}

/**
 * Each tree's rss+swap, a process counted ONCE: a tree rooted inside another (a test run inside a worker's tree) is
 * measured first and keeps its processes, so the enclosing tree's resident leaves them out. Pure over `read`.
 * Calibration may additionally request concurrent RSS; the default result keeps the legacy reader contract.
 */
export function residentsOf(
  read: ShadowMemoryPorts["readFile"],
  paths: readonly string[],
  budget: { left: number } = { left: MAX_TREE_PROCESSES },
  options: { includeRss?: boolean } = {},
): ShadowEntryInput["resident"][] {
  const trees = paths.map((path) => recordedTree(read, path));
  const keys = trees.map((t) => new Set("unread" in t ? [] : t.tree.map(identityKey)));
  // How many other trees hold this tree's roots: the deeper a tree is nested, the earlier it is measured.
  const depth = trees.map((t, i) => ("unread" in t ? 0
    : keys.filter((other, j) => j !== i && t.roots.some((root) => other.has(identityKey(root)))).length));
  const order = trees.map((_, i) => i).sort((a, b) => depth[b]! - depth[a]!);
  const counted = new Set<string>();
  const out: ShadowEntryInput["resident"][] = new Array(trees.length);
  for (const i of order) {
    const t = trees[i]!;
    if ("unread" in t) {
      out[i] = t;
      continue;
    }
    const own = t.tree.filter((p) => !counted.has(identityKey(p)));
    for (const p of own) counted.add(identityKey(p));
    out[i] = treeResident(read, own, budget, options.includeRss === true);
  }
  return out;
}

/** rss+swap of one recorded tree, verifying each (pid, start) so a reused pid is never counted. */
function treeResident(
  read: ShadowMemoryPorts["readFile"],
  tree: readonly ProcessIdentity[],
  budget: { left: number },
  includeRss: boolean,
): ShadowEntryInput["resident"] {
  let kb = 0;
  let rssKb = 0;
  let rssComplete = true;
  for (const identity of tree) {
    if (budget.left <= 0) return { mib: kb / 1024, complete: false, reason: `process cap ${MAX_TREE_PROCESSES}` };
    budget.left -= 1;
    try {
      const stat = parseProcStat(read(`/proc/${identity.pid}/stat`));
      if (!stat || stat.zombie || (identity.start !== "unknown" && stat.start !== identity.start)) continue;
      const status = read(`/proc/${identity.pid}/status`);
      const rss = /^VmRSS:\s+(\d+)/m.exec(status)?.[1];
      if (rss === undefined) rssComplete = false;
      else rssKb += Number(rss);
      kb += Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) + Number(/^VmSwap:\s+(\d+)/m.exec(status)?.[1] ?? 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") rssComplete = false;
      void error; // Gone between the listing and the read: it holds nothing now.
    }
  }
  return { mib: kb / 1024, complete: true, ...(includeRss && rssComplete ? { rssMib: rssKb / 1024 } : {}) };
}

interface TailRow { step: string; at: number; bytes?: number; pid?: number }

/** The daemon's memory samples: `daemon.alive` while it works, `daemon.tick` while idle (W1-T7126), the same reading. */
const DAEMON_SAMPLE_STEPS = new Set(["daemon.alive", "daemon.tick"]);

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
    if (!line.includes("\"daemon.alive\"") && !line.includes("\"daemon.tick\"") && !line.includes("\"serve.")) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const at = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
      if (typeof row.step !== "string" || !Number.isFinite(at)) continue;
      const rss = typeof row.rss_bytes === "number" ? row.rss_bytes : undefined;
      const swap = typeof row.vm_swap_bytes === "number" ? row.vm_swap_bytes : 0;
      const pid = typeof row.actor_pid === "number" ? row.actor_pid : undefined;
      rows.push({ step: row.step, at, ...(rss !== undefined ? { bytes: rss + swap } : {}), ...(pid !== undefined ? { pid } : {}) });
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

/**
 * From the main process's rss+swap samples over the last hour (only `pid`'s, when given): its growth back to the peak,
 * max - latest, and the TYPICAL part of it, median - latest (never more than the growth). "Unmeasured" with too few.
 */
export function daemonGrowthOf(
  rows: readonly TailRow[], now: number, minSamples: number, pid?: number,
): SeriesGrowth {
  const recent = rows.filter((r) => DAEMON_SAMPLE_STEPS.has(r.step) && r.bytes !== undefined && now - r.at <= HOUR_MS &&
    (pid === undefined || r.pid === undefined || r.pid === pid));
  return seriesGrowth(recent.map((r) => r.bytes!), minSamples, "daemon sample row(s)");
}

/** The same split over the daemon's persisted footprint: every sample of the last hour, across restarts (a restarted
 *  daemon climbs back toward the instance's footprint, so a prior pid's samples still say what is typical). */
export function footprintGrowthOf(
  samples: readonly FootprintSample[], now: number, minSamples: number, boot?: number,
): SeriesGrowth {
  const recent = samples.filter((s) => s.at <= now && now - s.at <= HOUR_MS);
  // W1-T9982: once the current generation has the samples a split needs, an earlier generation's never size it.
  const own = boot === undefined ? [] : recent.filter((s) => s.boot === boot);
  return seriesGrowth((own.length >= minSamples ? own : recent).map((s) => s.bytes), minSamples, "daemon footprint sample(s)");
}

/** W1-T9982: the generation of the newest sample that names one: the daemon generation now running. */
export function currentBootOf(samples: readonly FootprintSample[]): number | undefined {
  return samples.filter((s) => s.boot !== undefined).sort((a, b) => a.at - b.at).at(-1)?.boot;
}

export type BootPhase =
  | { phase: "boot"; growthMib: number; typicalMib: number; basis: string; typicalBasis: string; earlierBoots: number }
  | { phase: "steady"; phaseBasis: string };

const MIB_BYTES = 1024 * 1024;

/**
 * W1-T9982: what the daemon will still grow while it is inside the boot phase its earlier boots showed. The phase is
 * LEARNED: this generation is in it while its uptime is below the largest peak_uptime_ms among the earlier generations.
 * Within it, the growth is the largest earlier (peak - first) less what this generation has already grown (current
 * rss+swap - its own first reading); the typical part is the median of the same remainders. Anything else is steady.
 */
export function bootPhaseOf(
  store: { samples: readonly FootprintSample[]; boots: readonly BootGrowth[] } | { unread: string },
  now: number, currentMib: number | undefined,
): BootPhase {
  if ("unread" in store) return { phase: "steady", phaseBasis: `steady: the boot record is unread (${store.unread})` };
  const current = currentBootOf(store.samples);
  if (current === undefined) return { phase: "steady", phaseBasis: "steady: no sample names its generation" };
  const earlier = store.boots.filter((b) => b.boot < current);
  if (earlier.length === 0) return { phase: "steady", phaseBasis: "steady: no earlier boot recorded" };
  const uptimeMs = Math.max(0, now - current);
  const phaseMs = Math.max(...earlier.map((b) => b.peak_uptime_ms));
  if (uptimeMs >= phaseMs) {
    return { phase: "steady", phaseBasis: `steady: uptime ${Math.round(uptimeMs / 1000)} s is past the ${Math.round(phaseMs / 1000)} s its ${earlier.length} earlier boot(s) peaked by` };
  }
  const first = store.boots.find((b) => b.boot === current)?.first_bytes ??
    store.samples.filter((s) => s.boot === current).sort((a, b) => a.at - b.at)[0]?.bytes;
  const latest = store.samples.filter((s) => s.boot === current).sort((a, b) => a.at - b.at).at(-1)?.bytes;
  const now_ = currentMib ?? (latest === undefined ? undefined : latest / MIB_BYTES);
  if (first === undefined || now_ === undefined) return { phase: "steady", phaseBasis: "steady: this generation has no reading yet" };
  const grown = Math.max(0, now_ - first / MIB_BYTES);
  const remainders = earlier.map((b) => Math.max(0, b.peak_bytes - b.first_bytes) / MIB_BYTES).sort((a, b) => a - b);
  const mid = remainders.length >> 1;
  const median = remainders.length % 2 === 1 ? remainders[mid]! : (remainders[mid - 1]! + remainders[mid]!) / 2;
  const growthMib = Math.max(0, remainders.at(-1)! - grown);
  return {
    phase: "boot", earlierBoots: earlier.length, growthMib, typicalMib: Math.min(growthMib, Math.max(0, median - grown)),
    basis: `boot-phase: ${earlier.length} earlier boots, +${Math.round(remainders.at(-1)!)} MiB by uptime ${Math.round(phaseMs / 1000)} s`,
    typicalBasis: `median of ${earlier.length} earlier boot(s)' growth, +${Math.round(median)} MiB, less ${Math.round(grown)} MiB already grown`,
  };
}

function seriesGrowth(bytes: readonly number[], minSamples: number, unit: string): SeriesGrowth {
  if (bytes.length < minSamples) return { samples: bytes.length, reason: `${bytes.length} ${unit} in the last hour` };
  const latest = bytes.at(-1)!;
  const sorted = [...bytes].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const peak = Math.max(...bytes);
  const growthMib = Math.max(0, peak - latest) / MIB;
  return { samples: bytes.length, growthMib, typicalMib: Math.min(growthMib, Math.max(0, median - latest) / MIB),
    peakMib: peak / MIB, medianMib: median / MIB, latestMib: latest / MIB };
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

/** One bounded snapshot for one start. `admitted`: its start runs whatever the verdict (a shadow-mode class). */
export function gatherShadowInputs(start: ShadowStart, ports: ShadowMemoryPorts, policy: HostMemoryBudgetPolicy,
  options: { admitted?: boolean; strictEvidence?: boolean } = {}): ShadowInputs {
  const now = ports.clock.now();
  const strict: StrictGather | undefined = options.strictEvidence ? { generation: strictGenerationOf(ports.readFile), rawRead: ports.readFile } : undefined;
  if (strict) {
    const rawRead = ports.readFile, cache = new Map<string, string>();
    ports = { ...ports, readFile: path => { if (!cache.has(path)) cache.set(path, rawRead(path)); return cache.get(path)!; } };
  }
  const ledger = readLedgerState(ports, start.root);
  const recorded = ledger.reading?.entries ?? [];
  const residents = residentsOf(ports.readFile, recorded.map((entry) => entry.path), undefined, { includeRss: true });
  // A measured estimate's class also has a learned median; an unmeasured one claims its whole estimate as typical.
  const typical = (workerClass: WorkerClass, estimateMib: number): { typicalMib?: number } => {
    const median = typicalOf(ports, workerClass);
    return median === undefined ? {} : { typicalMib: Math.min(median, estimateMib) };
  };
  const entries: ShadowEntryInput[] = recorded.map((entry, i): ShadowEntryInput => ({
    id: entry.id,
    owner: entry.owner,
    workerClass: entry.workerClass,
    estimateMib: entry.estimateMib,
    estimateSource: entry.estimateSource,
    status: entry.status,
    walkComplete: entry.walkComplete,
    resident: residents[i]!,
    ageMs: entry.ageMs,
    ...(entry.occupancyReleased ? { occupancyReleased: true } : {}),
    ...(entry.estimateSource.kind === "measured" ? typical(entry.workerClass, entry.estimateMib) : {}),
    ...(entry.estimateSource.kind === "measured" && !entry.occupancyReleased
      ? { survival: survivalOf(ports, entry.workerClass, entry.ageMs) } : {}),
  }));
  const instance = instanceOf(ports, start.root);
  const tail = readTailRows(ports, start.root);
  const own = { ...ownDaemonGrowth(ports, tail, now, policy, start.root), instance, own: true };
  // Another instance's heartbeats live in its own ledger, out of reach from here: named, never assumed flat.
  const others = [...new Set(entries.map((e) => e.owner.split("@")[0]!))].filter((name) => name !== instance)
    .map((name) => ({ instance: name, samples: 0, reason: "its daemon.alive rows are not readable from this instance" }));
  const container = readContainer(ports.readFile);
  const swapIn = strict ? { unmeasured: "strict observation pending" } : readSwapIn(ports.readFile, now, policy.staleReadingMs);
  const psi = readPsi(ports.readFile);
  const inputs: ShadowInputs = {
    memAvailable: readMemAvailable(ports.readFile),
    swapIn,
    psi,
    container,
    ledger: { state: ledger.state, ...(ledger.reading?.dir ? { dir: ledger.reading.dir } : {}), ...(ledger.reason ? { reason: ledger.reason } : {}) },
    entries,
    start: startOf(start, ports, typical),
    daemonGrowth: [own, ...others],
    serve: serveOf(ports, tail, now, start.root),
    reviewEstimateMib: estimateOf(ports, "review"),
  };
  const gathered = { ...inputs, ...readContainerPressure(ports, start.root, now, policy, inputs, options.admitted === true, strict) };
  if (policy.claimModel !== JOINT_MODEL) return gathered;
  if (hostMemoryBudgetModeFor(policy, start.workerClass) === "enforce") {
    if (policy.jointQualification === undefined) throw new Error("joint enforce unavailable: qualification evidence is missing");
    if (!policy.jointQualification.scenarios.includes(inputs.serve.scenario)) throw new Error("joint enforce unavailable: current scenario is not qualified");
  }
  const candidate = jointClaimFor(gathered, ports, policy);
  if (candidate.kind !== "joint") {
    if (hostMemoryBudgetModeFor(policy, start.workerClass) === "enforce") throw new Error(`joint enforce unavailable: ${candidate.reason}`);
    return gathered;
  }
  return { ...gathered, jointClaim: candidate, containerLift: { unlearned: "joint model is not the legacy pressure cohort" } };
}

export function jointClaimFor(inputs: ShadowInputs, ports: ShadowMemoryPorts, policy: HostMemoryBudgetPolicy): JointEstimate {
  if (inputs.ledger.state !== "present") return { kind: "fallback", reason: "reservation ledger unavailable" };
  if (inputs.entries.some(e => e.status === "uncertain" || e.walkComplete === false || "unread" in e.resident ||
      !e.resident.complete || e.resident.rssMib === undefined)) return { kind: "fallback", reason: "incomplete resident RSS evidence" };
  const members = inputs.entries.map(e => ({ workerClass: e.workerClass, residentRssMib: "mib" in e.resident ? e.resident.rssMib! : NaN,
    own: e.status === "owned", released: e.occupancyReleased }));
  if (!inputs.start.reservationId || !inputs.entries.some(e => e.id === inputs.start.reservationId)) {
    members.push({ workerClass: inputs.start.workerClass, residentRssMib: 0, own: true, released: false });
  }
  return jointMemoryClaim(members, ports.calibrationSamples?.(inputs.ledger.dir) ?? [], ports.clock.now(), policy.jointQuantile);
}

/** A shared host store is the authority; one that establishes nothing is UNKNOWN, never local silence as stopped. */
function serveOf(ports: ShadowMemoryPorts, tail: ReturnType<typeof readTailRows>, now: number, root: string): ShadowInputs["serve"] {
  const local = (): ShadowInputs["serve"] => "unread" in tail
    ? { scenario: "unknown", basis: `ledger tail unreadable: ${tail.unread}` }
    : serveScenarioOf(tail.rows, now, tailCoverageMs(tail.earliestMs, rotationOf(ports, root), now));
  if (!ports.readHostServe) return local();
  let reading: HostServeReading;
  try {
    reading = ports.readHostServe(now);
  } catch (error) {
    reading = { state: "unknown", cause: "unreadable", basis: `host serve evidence reader failed: ${reasonOf(error)}` };
  }
  if (reading.state === "present") return { scenario: reading.scenario, basis: reading.basis };
  if (reading.cause === "local-only") return local();
  const fromLedger = local();
  if (fromLedger.scenario === "serve-stopped") {
    return { scenario: "unknown", basis: `host serve evidence ${reading.cause}: ${reading.basis}; local ledger said: ${fromLedger.basis}` };
  }
  return fromLedger.scenario === "unknown"
    ? { scenario: "unknown", basis: `host serve evidence ${reading.cause}: ${reading.basis}; ${fromLedger.basis}` }
    : fromLedger;
}

function instanceOf(ports: ShadowMemoryPorts, root: string): string {
  try {
    return ports.instance(root);
  } catch (error) {
    void error; // An unreadable mount table: the root's own name, as the ledger itself falls back.
    return root.split("/").filter(Boolean).at(-1) ?? root;
  }
}

/** W1-T9762: the start carries its class typical too, so an unseen start's p90 - median competes for the one tail
 *  rather than counting whole. An unmeasured class's median is its prior, the estimate, so it stays whole. */
function startOf(
  start: ShadowStart, ports: ShadowMemoryPorts, typical: (workerClass: WorkerClass, estimateMib: number) => { typicalMib?: number },
): ShadowInputs["start"] {
  const estimateMib = start.estimateMib ?? estimateOf(ports, start.workerClass);
  return {
    ...(start.reservationId ? { reservationId: start.reservationId } : {}),
    ...(start.estimateSource === undefined ? {} : { estimateSource: start.estimateSource }),
    workerClass: start.workerClass, estimateMib, ...typical(start.workerClass, estimateMib),
  };
}

/** The class's survival at a live tree's age, or why it is unmeasured: an unreadable store decays nothing. */
function survivalOf(ports: ShadowMemoryPorts, workerClass: WorkerClass, ageMs: number): Survival {
  if (!ports.survival) return { unmeasured: "no time-to-peak reader" };
  try {
    return ports.survival(workerClass, ageMs);
  } catch (error) {
    return { unmeasured: `time-to-peak store unreadable: ${reasonOf(error)}` };
  }
}

/** The class's learned median, or undefined when the store is unreadable: then no tail is split off the estimate. */
function typicalOf(ports: ShadowMemoryPorts, workerClass: WorkerClass): number | undefined {
  try {
    return ports.typical(workerClass);
  } catch (error) {
    void error; // An unreadable estimate store: the whole estimate stays typical, the conservative reading.
    return undefined;
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

export type SeriesGrowth = {
  samples: number; growthMib?: number; typicalMib?: number; reason?: string; peakMib?: number; medianMib?: number; latestMib?: number;
};

/**
 * The daemon's rss+swap series for this instance: its persisted footprint (daemon-footprint.ts), unless the ledger tail
 * holds more of the last hour (only before the daemon has written a footprint). `footprint` names what the store held.
 */
function daemonSeries(
  ports: ShadowMemoryPorts, tail: ReturnType<typeof readTailRows>, now: number, minSamples: number, root: string, pid?: number,
): { series: SeriesGrowth; basis: string; footprint: string; store: ReturnType<typeof readDaemonFootprint> } {
  const store = readDaemonFootprint(join(root, "state"), ports.readFile);
  const fromStore = "unread" in store ? undefined : footprintGrowthOf(store.samples, now, minSamples, currentBootOf(store.samples));
  const footprint = "unread" in store ? `unread: ${store.unread}` : `${store.source}: ${fromStore!.samples} sample(s) in the last hour`;
  const fromTail = "unread" in tail ? undefined : daemonGrowthOf(tail.rows, now, minSamples, pid);
  if (fromStore && (!fromTail || fromStore.samples >= fromTail.samples)) {
    return { series: fromStore, basis: "daemon footprint", footprint, store };
  }
  if (fromTail) return { series: fromTail, basis: "daemon.alive rows", footprint, store };
  return { series: { samples: 0, reason: `ledger tail unreadable: ${(tail as { unread: string }).unread}` }, basis: "none", footprint, store };
}

/** This instance's daemon growth (W1-T9972): its last-hour series' peak less its current rss+swap (the proc's VmRSS +
 *  VmSwap when readable, else the latest sample); too few samples, the proc's VmHWM - VmRSS; else unmeasured with the
 *  reasons for both. The proc's lifetime figure rides along for comparison. */
function ownDaemonGrowth(
  ports: ShadowMemoryPorts,
  tail: ReturnType<typeof readTailRows>,
  now: number,
  policy: HostMemoryBudgetPolicy,
  root: string,
): Omit<ShadowInputs["daemonGrowth"][number], "instance"> {
  let procReason = "";
  const pid = ports.daemonPid();
  const { series, basis, footprint, store } = daemonSeries(ports, tail, now, policy.daemonGrowthMinSamples, root, pid);
  let proc: { growthMib: number; peakMib: number; residentMib: number; swapMib: number } | undefined;
  if (pid === undefined) procReason = "no daemon pid in this process";
  else {
    try {
      const status = ports.readFile(`/proc/${pid}/status`);
      const measured = daemonGrowthFromStatus(status);
      if (measured) proc = { ...measured, swapMib: Number(/^VmSwap:\s+(\d+)\s+kB/m.exec(status)?.[1] ?? 0) / 1024 };
      else procReason = `proc ${pid}: no VmHWM/VmRSS`;
    } catch (error) {
      // The pid exited or /proc is unreadable: named below, and the sample series is tried instead.
      procReason = `proc ${pid}: ${reasonOf(error)}`;
    }
  }
  const lifetimeBasis = proc && `proc ${pid}: VmHWM ${Math.round(proc.peakMib)} MiB - VmRSS ${Math.round(proc.residentMib)} MiB`;
  const lifetime = proc ? { lifetimePeakGrowthMib: proc.growthMib, lifetimePeakBasis: lifetimeBasis! } : {};
  // W1-T9982: inside the boot phase its earlier boots showed, the daemon is charged what they grew, less what it has.
  const boot = bootPhaseOf(store, now, proc && proc.residentMib + proc.swapMib);
  if (boot.phase === "boot") {
    return {
      samples: boot.earlierBoots, growthMib: Math.max(proc?.growthMib ?? 0, boot.growthMib), typicalMib: boot.typicalMib,
      basis: boot.basis, typicalBasis: boot.typicalBasis, footprint, ...lifetime, phase: "boot",
      phaseBasis: boot.basis,
      currentBasis: proc
        ? `proc ${pid}: VmRSS ${Math.round(proc.residentMib)} MiB + VmSwap ${Math.round(proc.swapMib)} MiB`
        : "the latest sample",
    };
  }
  const steady = { phase: "steady" as const, phaseBasis: boot.phaseBasis };
  if (series.peakMib !== undefined && series.medianMib !== undefined && series.latestMib !== undefined) {
    // The series is rss+swap, so the current reading is too: a swapped-out daemon does not raise its own tail.
    const current = proc ? proc.residentMib + proc.swapMib : series.latestMib;
    const growthMib = Math.max(0, series.peakMib - current);
    const typicalMib = Math.min(growthMib, Math.max(0, series.medianMib - current));
    const unit = basis === "daemon footprint" ? "footprint sample(s)" : "sample row(s)";
    return {
      samples: series.samples, growthMib, typicalMib, basis, footprint, ...lifetime, ...steady,
      currentBasis: proc
        ? `proc ${pid}: VmRSS ${Math.round(proc.residentMib)} MiB + VmSwap ${Math.round(proc.swapMib)} MiB`
        : "the latest sample",
      ...(proc ? { typicalBasis: `median of ${series.samples} ${unit}` } : {}),
    };
  }
  if (proc) {
    return {
      samples: 1, growthMib: proc.growthMib, basis: `${lifetimeBasis} (the lifetime peak: ${series.reason})`,
      typicalBasis: `all typical: ${series.reason}`, footprint, ...lifetime, ...steady,
    };
  }
  return { ...series, reason: `${procReason}; ${series.reason}`, footprint, ...steady };
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

/** W1-T9557: per measured daemon, what its charged growth is: a median split, or all of it with the reason why. */
function daemonGrowthBasisOf(growth: ShadowInputs["daemonGrowth"]): string {
  const measured = growth.filter((g) => g.growthMib !== undefined);
  if (measured.length === 0) return "no daemon growth measured";
  const split = (g: (typeof measured)[number]): string => g.typicalBasis ??
    (g.typicalMib === undefined ? "all typical: no median split" : `median of ${g.samples} samples from the ${g.basis}`);
  return measured.map((g) => `${g.instance}: ${split(g)}`).join("; ");
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
      daemonGrowthChargedMib: verdict.numbers.daemonGrowthTypicalMib,
      daemonGrowthBasis: daemonGrowthBasisOf(inputs.daemonGrowth),
      daemonGrowthPeakMib: verdict.numbers.daemonGrowthLifetimePeakMib ?? verdict.numbers.daemonGrowthMib,
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
    // The new observer follows the SAME read seam as its caller; a partial fixture cannot hit host /proc.
    ports.calibrationObservation = overrides.calibrationObservation ?? (at => kernelMemoryObservation(at, ports!.readFile));
    if (!ports.write) return { kind: "no-sink" };
    const startedNs = ports.nowNs();
    const policy = ports.policy();
    const mode = hostMemoryBudgetModeFor(policy, start.workerClass);
    if (mode === "off") return { kind: "off" };
    const inputs = gatherShadowInputs(start, ports, policy, { admitted: mode === "shadow" });
    const instance = instanceOf(ports, start.root);
    const now = ports.clock.now();
    const waitKey = `${instance}\u0000${start.workerClass}`;
    const waitingSinceMs = wouldWaitSince.get(waitKey) ?? now;
    let verdict = evaluateShadowMemory(inputs, policy);
    let calibration: { model: string; kind: string; reason?: string; quantile?: number } = { model: JOINT_MODEL, kind: "not-measured" };
    let calibrationForecast: MemoryForecast | undefined;
    try {
      const candidate = inputs.jointClaim ?? jointClaimFor(inputs, ports, policy);
      calibration = { ...candidate, model: JOINT_MODEL };
      const candidateVerdict = candidate.kind === "joint" ? evaluateShadowMemory({ ...inputs, jointClaim: candidate,
        containerLift: { unlearned: "joint model is not the legacy pressure cohort" } }, policy) : verdict;
      if (candidate.kind === "joint" && mode === "shadow") verdict = candidateVerdict;
      const observation = ports.calibrationObservation?.(now);
      if (observation?.mib !== null && observation?.mib !== undefined && candidateVerdict.numbers.containerProjectedMib !== null) {
        // Charge compared to charge: working-set prediction gains back the same sampled reclaimable amount.
        const chargePrediction = observation.mib + candidateVerdict.numbers.containerProjectedMib -
          (candidateVerdict.numbers.containerWorkingSetMib ?? candidateVerdict.numbers.containerCurrentMib ?? 0);
        calibrationForecast = { id: start.reservationId ?? `${instance}:${start.workerClass}:${now}`,
          at: now, generation: observation.generation, scenario: verdict.scenario, model: candidate.kind === "joint" ? JOINT_MODEL : "legacy-one-tail-fallback",
          quantile: policy.jointQuantile ?? 0.95, projectedMib: chargePrediction, initialMib: observation.mib, basis: "cgroup-current-mib" };
        ports.publishCalibration?.(join(start.root, "state"), calibrationForecast);
      } else {
        // Keep an explicitly unknown forecast instead of selecting only starts with readable evidence.
        calibrationForecast = { id: start.reservationId ?? `${instance}:${start.workerClass}:${now}`, at: now,
          generation: observation?.generation ?? "unreadable", scenario: "unknown", model: "unavailable",
          quantile: policy.jointQuantile ?? 0.95, projectedMib: 0, initialMib: observation?.mib ?? 0, basis: "cgroup-current-mib" };
        ports.publishCalibration?.(join(start.root, "state"), calibrationForecast);
      }
    } catch (error) { calibration = { model: JOINT_MODEL, kind: "unavailable", reason: reasonOf(error) }; }
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
        mode,
        worker_class: start.workerClass,
        instance,
        reservation_id: start.reservationId ?? null,
        scenario: verdict.scenario,
        scenario_basis: inputs.serve.basis,
        would_admit: verdict.wouldAdmit,
        reasons: verdict.reasons,
        uncertainty: verdict.uncertainty,
        numbers: verdict.numbers,
        claims: verdict.claims,
        calibration,
        calibration_forecast: calibrationForecast ?? null,
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
