/**
 * lib/host-memory-admission.ts — the ENFORCE mode of the host memory budget (W1-T7094's verdict, acted on).
 *
 * Under `sweep.hostMemoryBudget.mode: "enforce"` a start first asks {@link awaitMemoryAdmission}, which reads the SAME
 * snapshot the shadow verdict reads (host-memory-shadow.ts) and, when the start would not fit, waits. The shipped mode is
 * "shadow", which returns at once and changes nothing; promoting to "enforce" is an operator ruling.
 *
 * TIERED, never a hard stop:
 *   - fits: admitted at once.
 *   - uncertain (only the widened margin tipped it): one back-off step for a fresher reading, then admitted and named.
 *   - shortfall (measured headroom, swap-in, PSI or the container ceiling): waits with exponential back-off while this
 *     instance or another still runs reserved work that can free memory. With NOTHING live to wait for, waiting cannot
 *     help, so the start is admitted and named: the budget never wedges the fleet on memory it does not account for.
 * PRIORITY: waiting starts in one process are evaluated one at a time, highest class weight times aged wait first
 *   (host-memory-priority.ts `rankDemand`), so an older build eventually outranks a newer review and nothing starves.
 * FAIL-OPEN AND NAMED: an error admits the start and writes memory_budget.enforce_error; it never holds work hostage.
 *
 * PER CLASS (operator 2026-10-14): `sweep.hostMemoryBudget.classModes` overrides `mode` for one worker class, so garden
 * children enforce while builds, fixes and reviews stay in shadow until W1-T8472 lands. A caller that runs again on its
 * own schedule (a garden pass) asks `onShortfall: "defer"`: where an enforced start would wait out a shortfall, it is
 * instead DEFERRED, named in one memory_budget.enforce_defer row, and the caller's next pass asks again. Nothing is
 * dropped: the deferred pass records no pacing, so it stays due.
 * AGED RUNG (W1-T9761): a "defer" caller's wait is its DEFERRAL STREAK, kept here per instance and caller key, so a
 * re-ask is ranked from the streak's start rather than from zero. Once the streak is at least the caller's own pass
 * cadence, it ranks first among this process's open streaks, no other aged child runs, and the shortfall is projected
 * rather than measured (not memory-available, not a sighted container ceiling), it is admitted on the "aged" tier.
 * A RESTART SEED (the caller's dueSinceMs) joins the streak only at this process's first observed deferral: it keeps a
 * restart from resetting the wait, but alone it never admits a first ask, and the aged row reports the queueing wait
 * this process observed (waited_ms) apart from the age the seed carried in (seeded_ms).
 * OWN-TAIL RUNG (W1-T10069): a shortfall whose one tail allowance is the start's own, with every other claim decayed and
 * no earlier own-tail start still inside its time-to-peak, is admitted on "own-tail" when its typical peak clears the
 * reserve. psi, swap-in, memory-available and a sighted container ceiling still refuse. A wait is ledgered at its first
 * attempt and whenever its reasons change, and the admit row splits the waiting time by reason.
 * W1-T10085: "psi" is named past the LEARNED full avg10 bound, and every admitted start, on any tier, is marked admitted
 * in the PSI record under the admission lock, so the bound learns from the starts it let through.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { fixedClock } from "./clock.js";

import { daemonOwnedProcess, openLearnedReservation, readValidationClassEstimate, type LearnedReservation, type ValidationClassEstimate } from "./host-memory-learning.js";
import { MEMORY_ADMISSION_LOCK_BUSY, ownedMemoryRunBinding, withMemoryAdmissionLock, type HostMemoryReading, type WorkerClass } from "./host-memory-ledger.js";
import { rankDemand, type HostMemoryPriorityPolicy } from "./host-memory-priority.js";
import {
  defaultShadowMemoryPorts,
  evaluateShadowMemory,
  gatherShadowInputs,
  hostMemoryBudgetModeFor,
  markPsiStartAdmitted,
  markStrictPsiStartAdmitted,
  type ShadowInputs,
  type ShadowMemoryPorts,
  type ShadowReason,
  type ShadowVerdict,
  type StrictPsiStartMark,
} from "./host-memory-shadow.js";
import { LEDGER_FILENAME } from "./ledger-path.js";

export const ENFORCE_WAIT_STEP = "memory_budget.enforce_wait";
export const ENFORCE_QUEUE_STEP = "memory_budget.enforce_queue";
export const ENFORCE_ADMIT_STEP = "memory_budget.enforce_admit";
export const ENFORCE_ERROR_STEP = "memory_budget.enforce_error";
/** A start that asked to be deferred rather than wait was deferred to its caller's next pass. */
export const ENFORCE_DEFER_STEP = "memory_budget.enforce_defer";

/** PROPOSALS for the back-off schedule: the first re-read after 5 s, doubling to one re-read a minute. */
export const ADMISSION_BACKOFF = { baseMs: 5_000, maxMs: 60_000, jitter: 0.2 } as const;

export type AdmissionTier = "fits" | "uncertain" | "shortfall";

/** Why the aged rung did not admit a deferred start; each defer row names one. */
export type AgedBlock = "no-cadence" | "younger-than-cadence" | "unobserved-seed" | "outranked" | "aged-child-running"
  | "memory-available" | "container-sighted";

/** Why the own-tail rung did not admit a shortfall: a refusing reason, or the rung's own condition that failed. */
export type OwnTailBlock = Exclude<ShadowReason, "unrealized-reservations"> | "container-sighted" | "joint-claim"
  | "tail-not-the-start's" | "own-tail-start-running" | "other-claim-undecayed" | "typical-short";

/** Which tier a verdict is in. Pure. */
export function admissionTier(verdict: Pick<ShadowVerdict, "wouldAdmit" | "reasons">): AdmissionTier {
  if (verdict.wouldAdmit) return "fits";
  return verdict.reasons.every((reason) => reason === "uncertainty") ? "uncertain" : "shortfall";
}

/** The k-th wait: base * 2^k, at most max, spread by +/- jitter so waiting instances do not re-read in lockstep. Pure. */
export function backoffMs(attempt: number, random: number, schedule: typeof ADMISSION_BACKOFF = ADMISSION_BACKOFF): number {
  const raw = Math.min(schedule.maxMs, schedule.baseMs * 2 ** Math.max(0, attempt));
  return Math.round(raw * (1 + schedule.jitter * (2 * random - 1)));
}

/** True when some live reservation, here or in another container, still holds work whose end can free memory. Pure. */
export function reservedWorkRunning(inputs: Pick<ShadowInputs, "entries">): boolean {
  return inputs.entries.some((entry) => !entry.occupancyReleased && entry.status !== "uncertain");
}

export interface AdmissionRequest {
  workerClass: WorkerClass;
  signal?: AbortSignal;
  sinceMs?: number;
  /** The state root, or how to read it: resolved only under "enforce", so the shipped mode pays nothing for it. */
  root: string | (() => string);
  runId?: string;
  taskId?: string;
  /** A caller with an existing reservation seam supplies it here; the same handle goes to its spawn. */
  reserve?: () => LearnedReservation | undefined;
  /** What an enforced start does about a shortfall it could wait out: "wait" (default) backs off in place; "defer"
   *  returns `deferred` at once, for a caller whose next scheduled pass asks again. */
  onShortfall?: "wait" | "defer";
  /** A "defer" caller's own pass cadence, and when it was last due if this process has not asked before (a restart).
   *  The due time seeds the streak at this process's first observed deferral, never a first ask's admission. */
  deferral?: { cadenceMs: number; cadenceBasis: "measured" | "carried" | "scheduled"; samples?: number; dueSinceMs?: number };
}

export type AdmissionOutcome =
  | { kind: "abandoned"; reason: "admission-abandoned"; waitedMs: number; attempts: number }
  | { kind: "not-enforced"; why: string }
  | { kind: "deferred"; reasons: ShadowVerdict["reasons"] }
  | { kind: "admitted"; tier: AdmissionTier | "nothing-to-wait-for" | "aged" | "own-tail"; waitedMs: number; attempts: number; reservation?: LearnedReservation;
    /** Only on the aged tier: call when the admitted child ends, so the next aged start may run. */
    endAged?: () => void }
  | { kind: "error"; reason: string; reservation?: LearnedReservation; reservationAttempted?: true };

export interface AdmissionPorts extends ShadowMemoryPorts {
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  /** Only the daemon and the processes it starts share the ledger the budget reads; anything else is never held. */
  enforceHere: () => boolean;
  withLock: <T>(action: () => T) => T;
  openReservation: (input: { workerClass: WorkerClass; root: string }) => LearnedReservation | undefined;
}

export type ValidationWorkerClass = Extract<WorkerClass, "test" | "check-proof" | "push-gate">;
export type ValidationAdmissionRequest = Omit<AdmissionRequest, "workerClass" | "onShortfall" | "deferral" | "reserve"> & { workerClass: ValidationWorkerClass };
export interface ValidationAdmissionPorts extends AdmissionPorts {
  validationEstimate: (workerClass: ValidationWorkerClass) => ValidationClassEstimate;
  ownedBinding: (id: string, root: string) => ReturnType<typeof ownedMemoryRunBinding>;
}
type ValidationPsiMark = StrictPsiStartMark | { kind: "not-attempted" };
export type ValidationAdmissionOutcome =
  | { kind: "ready"; tier: "fits"; reservation: LearnedReservation; waitedMs: number; attempts: number;
      basis: "legacy-compatible-tree-peaks"; samples: number; psiMark: Extract<StrictPsiStartMark, { kind: "recorded" }> }
  | { kind: "not-started"; reason: "budget-unavailable" | "unsafe-without-live-work" | "admission-error" | "abandoned";
      details: string[]; waitedMs: number; attempts: number; cleanup: "none" | "release-requested" | "held-unknown"; psiMark: ValidationPsiMark }
  | Extract<AdmissionOutcome, { kind: "not-enforced" }>;

type ValidationPorts = Pick<ValidationAdmissionPorts, "validationEstimate" | "ownedBinding">;
type ValidationFailure = Pick<Extract<ValidationAdmissionOutcome, { kind: "not-started" }>, "reason" | "details">;
interface AdmissionEvaluation {
  inputs: ShadowInputs; verdict: ShadowVerdict; tier: AdmissionTier;
  admitAs?: Extract<AdmissionOutcome, { kind: "admitted" }>["tier"];
  agedBlock?: AgedBlock; ownTail?: OwnTailRung;
  validationFailure?: ValidationFailure; validationBasis?: ValidationClassEstimate;
}
/** Strict evidence is emitted by the maintained reader from actual tagged history, never reconstructed here. */
function validationSnapshot(request: AdmissionRequest, root: string, ports: AdmissionPorts, validation: ValidationPorts,
  policy: ReturnType<AdmissionPorts["policy"]>): {
    inputs: ShadowInputs; issues: string[]; basis: ValidationClassEstimate;
  } {
  const issues: string[] = [];
  const basis = validation.validationEstimate(request.workerClass as ValidationWorkerClass);
  let ledger: HostMemoryReading | undefined;
  const inputs = gatherShadowInputs({ ...request, root, ...(basis.kind === "measured" ? {
    estimateMib: basis.estimateMib, estimateSource: { kind: "measured" as const, samples: basis.samples },
  } : {}) }, { ...ports,
    readLedger: r => { ledger = ports.readLedger(r); return ledger; },
    typical: cls => cls === request.workerClass && basis.kind === "measured" ? basis.typicalMib : ports.typical(cls),
  }, policy, { strictEvidence: true });
  const evidence = inputs.strictEvidence;
  if (!evidence) issues.push("strict-observation-unavailable");
  else if (evidence.kind === "unavailable") issues.push(...evidence.reasons);
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (!ledger || ledger.state !== "present" || ledger.scope !== "host" || ledger.counts.uncertain !== 0 ||
      ledger.counts.incompleteWalk !== 0 || ledger.counts.localScope !== 0 || ledger.counts.unreadable !== 0 ||
      ledger.entries.some(e => e.status === "uncertain" || e.walkComplete !== true)) issues.push("ledger-incomplete");
  if (basis.kind !== "measured") issues.push(basis.reason);
  else if (!finite(basis.estimateMib) || basis.estimateMib === 0 || !finite(basis.typicalMib) ||
      basis.typicalMib > basis.estimateMib || !Number.isSafeInteger(basis.samples) || basis.samples <= 0 ||
      inputs.start.estimateSource?.kind !== "measured" || inputs.start.estimateSource.samples !== basis.samples) issues.push("class-basis-incomplete");
  if (!("mib" in inputs.memAvailable) || !finite(inputs.memAvailable.mib)) issues.push("host-memory-unavailable");
  if (!("pagesPerSec" in inputs.swapIn) || !finite(inputs.swapIn.pagesPerSec)) issues.push("host-swap-unavailable");
  if ("unread" in inputs.psi || !finite(inputs.psi.someAvg10) || !finite(inputs.psi.someAvg60) ||
      !finite(inputs.psi.fullAvg10) || !finite(inputs.psi.fullAvg60)) issues.push("host-pressure-incomplete");
  if ("unread" in inputs.container || !finite(inputs.container.currentMib) || inputs.container.highMib === undefined ||
      (inputs.container.maxMib !== null && !finite(inputs.container.maxMib)) ||
      (inputs.container.highMib !== null && !finite(inputs.container.highMib)) || !finite(inputs.container.reclaimableMib)) issues.push("container-memory-incomplete");
  const pressure = inputs.containerPressure;
  if (!pressure || "unread" in pressure || "unread" in pressure.psi || !finite(pressure.psi.someAvg10) ||
      !finite(pressure.psi.fullAvg10) || "unmeasured" in pressure.swapIn || !finite(pressure.swapIn.pagesPerSec) ||
      !finite(pressure.ceilingCrossings)) issues.push("container-pressure-incomplete");
  if (inputs.serve.scenario === "unknown") issues.push("serve-scenario-unknown");
  if (inputs.daemonGrowth.length === 0 || inputs.daemonGrowth.some(g => g.samples < policy.daemonGrowthMinSamples ||
      !finite(g.growthMib) || !finite(g.typicalMib) || !g.basis || !g.currentBasis || g.currentBasis === "the latest sample")) issues.push("daemon-allowance-incomplete");
  return { inputs, issues, basis };
}

interface Waiter {
  instance: string;
  workerClass: WorkerClass;
  waitingSinceMs: number;
}

const waiting: Waiter[] = [];

/** One open deferral streak: the waiter it ranks as (its start, a restart seed included), when this process first
 *  asked in it, and how many deferrals it holds. */
interface Streak extends Waiter {
  runId: string;
  askedSinceMs: number;
  deferrals: number;
}

const streaks = new Map<string, Streak>();
/** The key of the one aged start of this process still running, if any. */
let agedRunning: string | undefined;
/** Per state root, the reservation of this process's latest own-tail start, until it is past its time-to-peak. */
const ownTailRunning = new Map<string, string>();

export function resetMemoryAdmissionStateForTests(): void {
  waiting.length = 0;
  streaks.clear();
  agedRunning = undefined;
  ownTailRunning.clear();
}

/** Deferral streaks open in this process, for diagnostics and tests. */
export function openDeferralStreaks(): ReadonlyArray<Readonly<Streak>> {
  return [...streaks.values()];
}

/** A caller that no longer asks (its pass is not due) ends its streak, in every instance. */
export function endDeferralStreak(runId: string): void {
  for (const [key, streak] of streaks) if (streak.runId === runId) streaks.delete(key);
}

/** Whether the aged rung admits this deferred start, or why not. Pure but for the streaks it ranks against. */
function agedRungBlock(key: string, self: Waiter, deferral: AdmissionRequest["deferral"], verdict: ShadowVerdict,
  ranking: HostMemoryPriorityPolicy, now: number, seededSinceMs: number | undefined): AgedBlock | undefined {
  if (deferral === undefined) return "no-cadence";
  if (now - self.waitingSinceMs < deferral.cadenceMs) {
    return seededSinceMs !== undefined && now - seededSinceMs >= deferral.cadenceMs ? "unobserved-seed" : "younger-than-cadence";
  }
  const others = [...streaks].filter(([other]) => other !== key).map(([, streak]) => streak as Waiter);
  if (rankDemand([...others, self], ranking, now)[0] !== self) return "outranked";
  if (agedRunning !== undefined) return "aged-child-running";
  if (verdict.reasons.includes("memory-available")) return "memory-available";
  if (verdict.reasons.includes("container-ceiling") && verdict.numbers.containerSighted) return "container-sighted";
  return undefined;
}

interface OwnTailRung {
  block?: OwnTailBlock;
  startTypicalMib: number;
  startTailMib: number;
  otherClaimsChargedMib: number;
  /** MemAvailable less the daemons' typical growth, the cold-start reserve, every typical claim and the margin. */
  typicalHeadroomMib: number | null;
}

/** Whether the own-tail rung admits this shortfall, or why not. Pure but for this process's own-tail start. */
function ownTailRung(root: string, inputs: ShadowInputs, verdict: ShadowVerdict, policy: { hostReserveMib: number }): OwnTailRung {
  const n = verdict.numbers;
  const startTypicalMib = Math.min(inputs.start.typicalMib ?? inputs.start.estimateMib, inputs.start.estimateMib);
  const typicalHeadroomMib = n.memAvailableMib === null ? null
    : n.memAvailableMib - n.daemonGrowthTypicalMib - n.coldStartReserveMib - n.hostTypicalMib - n.marginMib;
  const rung: OwnTailRung = { startTypicalMib, startTailMib: n.hostTailMib,
    otherClaimsChargedMib: Math.max(0, n.hostTypicalMib - startTypicalMib), typicalHeadroomMib };
  const blocked = (block: OwnTailBlock): OwnTailRung => ({ ...rung, block });
  if (inputs.jointClaim) return blocked("joint-claim");
  for (const reason of verdict.reasons) {
    if (reason === "container-ceiling") { if (n.containerSighted) return blocked("container-sighted"); }
    else if (reason !== "unrealized-reservations") return blocked(reason);
  }
  if (!verdict.reasons.includes("unrealized-reservations")) return blocked("container-ceiling");
  if (n.hostTailOwner !== "start") return blocked("tail-not-the-start's");
  const live = inputs.entries.filter(entry => entry.occupancyReleased !== true && entry.id !== inputs.start.reservationId);
  const previous = ownTailRunning.get(root);
  if (previous !== undefined) {
    const entry = live.find(candidate => candidate.id === previous);
    const survival = entry?.survival;
    if (entry !== undefined && (survival === undefined || "unmeasured" in survival || survival.factor > 0)) return blocked("own-tail-start-running");
    ownTailRunning.delete(root);
  }
  // Undecayed (factor 1 or unmeasured): younger than every measured time to peak, so its growth is all ahead of it.
  if (live.some(entry => entry.survival === undefined || "unmeasured" in entry.survival || entry.survival.factor >= 1)) {
    return blocked("other-claim-undecayed");
  }
  if (typicalHeadroomMib === null || typicalHeadroomMib < policy.hostReserveMib) return blocked("typical-short");
  return rung;
}

/** Starts waiting in this process right now, for diagnostics and tests. */
export function waitingStarts(): ReadonlyArray<Readonly<Waiter>> {
  return [...waiting];
}

function defaultAdmissionPorts(): AdmissionPorts {
  return {
    ...defaultShadowMemoryPorts(),
    sleep: (ms, signal) => delay(ms, undefined, { signal }),
    random: Math.random,
    enforceHere: () => daemonOwnedProcess(),
    withLock: withMemoryAdmissionLock,
    openReservation: openLearnedReservation,
  };
}

function ownTailRow(rung: OwnTailRung): Record<string, number | null> {
  return { start_typical_mib: rung.startTypicalMib, start_tail_mib: rung.startTailMib,
    other_claims_charged_mib: rung.otherClaimsChargedMib, typical_headroom_mib: rung.typicalHeadroomMib };
}

function reasonOf(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? String((error as Error)?.message ?? error).slice(0, 120);
}

/**
 * Wait, under "enforce", until the start fits (see the module doc for the tiers). Returns at once in any other mode.
 * NEVER throws: an error is an admission, named.
 */
export async function awaitMemoryAdmission(
  request: AdmissionRequest,
  overrides: Partial<AdmissionPorts> = {},
): Promise<AdmissionOutcome> {
  return admissionLoop(request, { ...defaultAdmissionPorts(), ...overrides });
}

/** Shared prerequisite ONLY: no launcher uses this entry and no policy mode is promoted here. */
export async function awaitValidationMemoryAdmission(
  request: ValidationAdmissionRequest, overrides: Partial<ValidationAdmissionPorts> = {},
): Promise<ValidationAdmissionOutcome> {
  const ports = { ...defaultAdmissionPorts(), enforceHere: () => process.env.GITHUB_ACTIONS !== "true" && daemonOwnedProcess(),
    validationEstimate: readValidationClassEstimate,
    ownedBinding: (id: string, root: string) => ownedMemoryRunBinding(id, { root }), ...overrides };
  return admissionLoop(request, ports, ports);
}

function admissionLoop(request: AdmissionRequest, ports: AdmissionPorts): Promise<AdmissionOutcome>;
function admissionLoop(request: ValidationAdmissionRequest, ports: AdmissionPorts, validation: ValidationPorts): Promise<ValidationAdmissionOutcome>;
async function admissionLoop(request: AdmissionRequest, ports: AdmissionPorts, validation?: ValidationPorts): Promise<AdmissionOutcome | ValidationAdmissionOutcome> {
  let ledgerPath: string | undefined;
  const base = { run_id: request.runId ?? "memory-budget-enforce", task_id: request.taskId ?? "MEMORY-BUDGET" };
  const write = (row: { step: string } & Record<string, unknown>): void => {
    try {
      if (ledgerPath !== undefined) ports.write?.(ledgerPath, { ...base, ...row });
      else ports.stderr(JSON.stringify({ ...base, ...row }));
    } catch (error) {
      if (!validation) ports.stderr(JSON.stringify({ event: row.step, error: reasonOf(error) }));
      else { try { ports.stderr(JSON.stringify({ event: row.step, error: reasonOf(error) })); } catch { /* Refusal survives a failed diagnostic. */ } }
    }
  };
  let waiter: Waiter | undefined;
  let reservation: LearnedReservation | undefined;
  let reservationAttempted = false;
  let streakKey: string | undefined;
  let startedAt: number | undefined;
  let finishQueueObservation: (() => void) | undefined;
  let attempt = 0;
  let lastAt: number | undefined;
  let validationRoot: string | undefined;
  const effects: { psiMark: ValidationPsiMark } = { psiMark: { kind: "not-attempted" } };
  const refuse = (failure: ValidationFailure): Extract<ValidationAdmissionOutcome, { kind: "not-started" }> => {
    let cleanup: Extract<ValidationAdmissionOutcome, { kind: "not-started" }>['cleanup'] = "none";
    if (reservation) {
      cleanup = "held-unknown";
      try {
        if (reservation.id && validationRoot && validation?.ownedBinding(reservation.id, validationRoot).state === "fresh") {
          cleanup = "release-requested";
          reservation.releaseOccupancy();
        }
      } catch { /* A failed best-effort request or unknown ownership is never verified release. */ }
    }
    const result = { kind: "not-started" as const, ...failure, waitedMs: startedAt === undefined || lastAt === undefined ? 0 : Math.max(0, lastAt - startedAt), attempts: attempt, cleanup, psiMark: effects.psiMark };
    write({ step: "memory_budget.validation_not_started", worker_class: request.workerClass, admitted: false, ...result });
    return result;
  };
  const abandoned = (): AdmissionOutcome | ValidationAdmissionOutcome => validation ? refuse({ reason: "abandoned", details: ["admission-abandoned"] })
    : { kind: "abandoned", reason: "admission-abandoned", waitedMs: startedAt === undefined ? 0 : Math.max(0, ports.clock.now() - startedAt), attempts: attempt };
  try {
    if (request.signal?.aborted) return abandoned();
    if (validation && !(["test", "check-proof", "push-gate"] as readonly string[]).includes(request.workerClass)) {
      return refuse({ reason: "budget-unavailable", details: ["unsupported-validation-class"] });
    }
    const policy = ports.policy();
    const mode = hostMemoryBudgetModeFor(policy, request.workerClass);
    const defers = !validation && request.onShortfall === "defer";
    if (mode !== "enforce") {
      if (defers) endDeferralStreak(request.runId ?? request.workerClass);
      return { kind: "not-enforced", why: `mode ${mode}` };
    }
    if (!ports.enforceHere()) return { kind: "not-enforced", why: "not a daemon-owned process" };
    const root = typeof request.root === "string" ? request.root : request.root();
    validationRoot = root;
    ledgerPath = join(root, "state", LEDGER_FILENAME);
    const clock = ports.clock;
    startedAt = clock.now();
    lastAt = startedAt;
    const runId = request.runId ?? request.workerClass;
    const key = streakKey = `${root}\u0000${runId}`;
    const due = request.deferral?.dueSinceMs;
    const open = defers ? streaks.get(key) : undefined;
    // A restart seed waits for this process to observe a deferral: it joins the streak when one opens, below.
    const since = open?.waitingSinceMs ?? Math.min(startedAt, request.sinceMs ?? startedAt);
    const askedSince = open?.askedSinceMs ?? startedAt;
    const seededSince = open === undefined && due !== undefined ? Math.min(startedAt, due) : undefined;
    waiter = { instance: root, workerClass: request.workerClass, waitingSinceMs: since };
    waiting.push(waiter);
    const ownRunId = typeof request.runId === "string" && request.runId.trim() ? request.runId : undefined;
    const ownTaskId = typeof request.taskId === "string" && request.taskId.trim() ? request.taskId : undefined;
    const ownClass = request.workerClass;
    const missingIdentity = [...(ownRunId === undefined ? ["run_id"] : []), ...(ownTaskId === undefined ? ["task_id"] : [])];
    let observationId: string | undefined;
    let sampledAt = startedAt;
    const observedPhases = new Set<"queued-behind-rank" | "evaluating-head" | "settled">();
    const observeQueue = (phase: "queued-behind-rank" | "evaluating-head" | "settled", position: number | null,
      size: number | null, ahead: WorkerClass | null): void => {
      if (observedPhases.has(phase)) return;
      observedPhases.add(phase);
      try {
        observationId ??= randomUUID();
        const row = { step: ENFORCE_QUEUE_STEP, run_id: ownRunId ?? "unknown", task_id: ownTaskId ?? "unknown",
          worker_class: ownClass, identity_state: missingIdentity.length === 0 ? "supplied" : "unknown",
          missing_identity: missingIdentity, admission_id: observationId, phase, phase_basis: "first-observation-per-phase",
          worker_assignment: "not-observed", queue_position: position, queue_size: size, ahead_worker_class: ahead,
          wait_start_ms: since, observed_start_ms: startedAt, sampled_at_ms: sampledAt,
          waited_ms: Math.max(0, sampledAt - startedAt!), timing_basis: "existing-admission-sample",
          ...(phase === "settled" ? { cancelled: request.signal?.aborted === true } : {}) };
        if (ports.write === undefined) ports.stderr(JSON.stringify(row));
        else write(row);
      } catch {
        // Deliberate diagnostic loss: even allocation or a failing stderr fallback must not admit, reserve or block.
      }
    };
    finishQueueObservation = () => { if (observationId !== undefined) observeQueue("settled", null, null, null); };
    let noted = false;
    let ledgeredKey: string | undefined;
    let lastKey = "queued";
    const waitedByReason: Record<string, number> = {};
    for (;;) {
      if (request.signal?.aborted) return abandoned();
      const now = clock.now();
      lastAt = now;
      const ranked = rankDemand(waiting, ports.priorityPolicy(), now);
      const head = ranked[0];
      sampledAt = now;
      if (head !== waiter) {
        lastKey = "queued";
        observeQueue("queued-behind-rank", ranked.indexOf(waiter) + 1, ranked.length, head?.workerClass ?? null);
      } else if (observationId !== undefined) observeQueue("evaluating-head", 1, ranked.length, null);
      // Diagnostic sinks may synchronously cancel this strict invocation before evaluation.
      if (validation && request.signal?.aborted) return abandoned();
      if (head === waiter) {
        try {
          const { inputs, verdict, tier, admitAs, agedBlock, ownTail, validationFailure, validationBasis } = ports.withLock<AdmissionEvaluation>(() => {
            const strict = validation ? validationSnapshot(request, root, ports, validation, policy) : undefined;
            const validationBasis = strict?.basis;
            let validationFailure: ValidationFailure | undefined;
            const inputs = strict?.inputs ?? gatherShadowInputs({ ...request, root }, ports, policy);
            const verdict = evaluateShadowMemory(inputs, policy);
            const tier = admissionTier(verdict);
            if (strict) {
              const issues = [...strict.issues, ...verdict.uncertainty.filter(u =>
                // The positively measured start is included by the evaluator BEFORE its atomic publication.
                !(u.kind === "start-unrecorded" && u.count === 1 && u.marginMib === 0)).map(u => u.kind)];
              if (policy.claimModel && policy.claimModel !== "legacy-one-tail") issues.push("unsupported-validation-claim-model");
              if (issues.length > 0) validationFailure = { reason: "budget-unavailable", details: [...new Set(issues)] };
              else if (tier !== "fits" && !reservedWorkRunning(inputs)) validationFailure = { reason: "unsafe-without-live-work", details: verdict.reasons };
            }
            const agedBlock = defers && tier === "shortfall"
              ? agedRungBlock(key, waiter!, request.deferral, verdict, ports.priorityPolicy(), now, seededSince) : undefined;
            let ownTail: OwnTailRung | undefined;
            const admitAs: AdmissionTier | "nothing-to-wait-for" | "aged" | "own-tail" | undefined = validation
              ? validationFailure === undefined && tier === "fits" ? "fits" : undefined
              : tier === "fits" ? "fits"
              : tier === "uncertain" && attempt > 0 ? "uncertain"
                : tier === "shortfall" && !reservedWorkRunning(inputs) ? "nothing-to-wait-for"
                  : defers && tier === "shortfall" && agedBlock === undefined ? "aged"
                    : tier === "shortfall" && (ownTail = ownTailRung(root, inputs, verdict, policy)).block === undefined ? "own-tail"
                      : undefined;
            if (admitAs !== undefined) {
              if (admitAs === "fits" && inputs.ledger.state !== "present") throw new Error(`admission-ledger-${inputs.ledger.state}`);
              reservationAttempted = true;
              reservation = !validation && request.reserve ? request.reserve() : ports.openReservation({ workerClass: request.workerClass, root });
              if (reservation === undefined || reservation.id === undefined) throw new Error("admission-reservation-unavailable");
              if (reservation.published !== true) throw new Error("admission-reservation-unpublished");
              if (reservation.estimateMib !== inputs.start.estimateMib) throw new Error("admission-estimate-changed");
              if (validation && (reservation.estimateSource.kind !== "measured" || validationBasis?.kind !== "measured" ||
                  reservation.estimateSource.samples !== validationBasis.samples)) throw new Error("admission-measurement-changed");
              const visible = ports.readLedger(root);
              if (visible?.state !== "present") throw new Error(`admission-ledger-${visible?.state ?? "unreadable"}`);
              if (!visible.entries.some(entry => entry.id === reservation!.id)) throw new Error("admission-reservation-not-visible");
              if (validation && (visible.scope !== "host" || visible.counts.uncertain !== 0 || visible.counts.incompleteWalk !== 0 ||
                  visible.counts.localScope !== 0 || visible.counts.unreadable !== 0 ||
                  validation.ownedBinding(reservation.id, root).state !== "fresh")) throw new Error("admission-not-fresh-owned");
              if (validation && request.signal?.aborted) validationFailure = { reason: "abandoned", details: ["admission-abandoned"] };
              if (validationFailure) return { inputs, verdict, tier, admitAs: undefined, agedBlock, ownTail, validationFailure, validationBasis };
              if (validation) {
                if (inputs.strictEvidence?.kind !== "paired") validationFailure = { reason: "admission-error", details: ["psi-mark-missing"] };
                else {
                  const mark = markStrictPsiStartAdmitted(ports, root, inputs.strictEvidence.marker);
                  effects.psiMark = mark;
                  if (mark.kind !== "recorded") validationFailure = { reason: "admission-error", details: [`psi-mark-${mark.reason}`] };
                }
                if (request.signal?.aborted) validationFailure = { reason: "abandoned", details: ["admission-abandoned"] };
              } else if (inputs.psiRecordAt !== undefined) markPsiStartAdmitted(ports, root, inputs.psiRecordAt);
            }
            return { inputs, verdict, tier, admitAs, agedBlock, ownTail, validationFailure, validationBasis };
          });
          if (validation && request.signal?.aborted) return abandoned();
          if (validationFailure) return refuse(validationFailure);
          lastKey = verdict.reasons.join("+") || tier;
          if (validation && admitAs !== undefined) {
            const psiMark = effects.psiMark;
            if (admitAs !== "fits" || !reservation || validationBasis?.kind !== "measured" || psiMark.kind !== "recorded") throw new Error("validation-admission-invariant");
            if (noted) write({ step: ENFORCE_ADMIT_STEP, worker_class: request.workerClass, tier: "fits", validation: true,
              waited_ms: now - startedAt, attempts: attempt, reasons: verdict.reasons, waited_ms_by_reason: waitedByReason, numbers: verdict.numbers });
            // Settle diagnostics before the final strict check, not after a computed ready return.
            finishQueueObservation?.();
            if (request.signal?.aborted) return abandoned();
            return { kind: "ready", tier: "fits", reservation, waitedMs: now - startedAt, attempts: attempt,
              basis: validationBasis.basis, samples: validationBasis.samples, psiMark };
          }
          if (admitAs !== undefined) {
            const streak = streaks.get(key);
            if (defers) streaks.delete(key);
            if (admitAs === "aged") {
              // The queueing wait this process observed, apart from the age a restart seed carried into the streak.
              const waitedMs = now - askedSince;
              agedRunning = key;
              write({ step: ENFORCE_ADMIT_STEP, worker_class: request.workerClass, tier: "aged", waited_ms: waitedMs,
                seeded_ms: askedSince - since, deferred_since: fixedClock(since).iso(),
                deferrals: streak?.deferrals ?? 0, cadence_ms: request.deferral!.cadenceMs, cadence_basis: request.deferral!.cadenceBasis, cadence_samples: request.deferral!.samples ?? 0,
                reasons: verdict.reasons, overrode: verdict.reasons, attempts: attempt, waited_ms_by_reason: waitedByReason,
                numbers: verdict.numbers });
              const endAged = (): void => { if (agedRunning === key) agedRunning = undefined; };
              return { kind: "admitted", tier: admitAs, waitedMs, attempts: attempt, ...(reservation ? { reservation } : {}), endAged };
            }
            const waitedMs = now - startedAt;
            if (admitAs === "own-tail") ownTailRunning.set(root, reservation!.id!);
            if (noted || admitAs !== "fits") {
              write({ step: ENFORCE_ADMIT_STEP, worker_class: request.workerClass, tier: admitAs, waited_ms: waitedMs,
                attempts: attempt, reasons: verdict.reasons, waited_ms_by_reason: waitedByReason,
                ...(admitAs === "own-tail" ? { own_tail: ownTailRow(ownTail!) } : {}), numbers: verdict.numbers });
            }
            return { kind: "admitted", tier: admitAs, waitedMs, attempts: attempt, ...(reservation ? { reservation } : {}) };
          }
          if (tier === "shortfall" && defers) {
            const streak = streaks.get(key) ?? { instance: root, workerClass: request.workerClass, waitingSinceMs: seededSince ?? since,
              askedSinceMs: askedSince, runId, deferrals: 0 };
            streak.deferrals += 1;
            streaks.set(key, streak);
            write({ step: ENFORCE_DEFER_STEP, worker_class: request.workerClass, tier, reasons: verdict.reasons,
              uncertainty: verdict.uncertainty, numbers: verdict.numbers, scenario: verdict.scenario, attempts: attempt,
              waited_ms: now - startedAt, deferred_since: fixedClock(streak.waitingSinceMs).iso(),
              seeded_ms: streak.askedSinceMs - streak.waitingSinceMs, deferrals: streak.deferrals,
              cadence_ms: request.deferral?.cadenceMs ?? null, cadence_basis: request.deferral?.cadenceBasis ?? null,
              cadence_samples: request.deferral === undefined ? null : request.deferral.samples ?? 0, aged_blocked: agedBlock });
            return { kind: "deferred", reasons: verdict.reasons };
          }
          // The first attempt and every change of reasons are ledgered, so the waiting time splits by cause.
          const waitKey = `${lastKey}|${ownTail?.block ?? ""}`;
          if (waitKey !== ledgeredKey) {
            noted = true;
            ledgeredKey = waitKey;
            write({ step: ENFORCE_WAIT_STEP, worker_class: request.workerClass, tier, reasons: verdict.reasons,
              uncertainty: verdict.uncertainty, numbers: verdict.numbers, scenario: verdict.scenario,
              waiting: waiting.length, attempt, waited_ms: now - startedAt,
              ...(ownTail ? { own_tail_blocked: ownTail.block, own_tail: ownTailRow(ownTail) } : {}) });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== MEMORY_ADMISSION_LOCK_BUSY) throw error;
          if (validation) return refuse({ reason: "budget-unavailable", details: ["admission-lock-held"] });
          lastKey = "admission-lock-held";
          if (!noted) {
            noted = true;
            write({ step: ENFORCE_WAIT_STEP, worker_class: request.workerClass, tier: "uncertain", reasons: ["admission-lock-held"], waiting: waiting.length });
          }
        }
      }
      const ms = backoffMs(attempt, ports.random());
      waitedByReason[lastKey] = (waitedByReason[lastKey] ?? 0) + ms;
      attempt += 1;
      const signal = request.signal;
      if (!signal) await ports.sleep(ms);
      else {
        let wake!: () => void;
        const cancelled = new Promise<void>(resolve => { wake = resolve; });
        signal.addEventListener("abort", wake, { once: true });
        try {
          if (!signal.aborted) await Promise.race([ports.sleep(ms, signal), cancelled]);
        } finally {
          signal.removeEventListener("abort", wake);
        }
      }
    }
  } catch (error) {
    if (request.signal?.aborted) return abandoned();
    const reason = reasonOf(error);
    if (validation) return refuse({ reason: "admission-error", details: [reason] });
    if (streakKey !== undefined && request.onShortfall === "defer") streaks.delete(streakKey); // fail-open is an admission
    write({ step: ENFORCE_ERROR_STEP, worker_class: request.workerClass, reason, admitted: true });
    return { kind: "error", reason, ...(reservation ? { reservation } : reservationAttempted ? { reservationAttempted: true as const } : {}) };
  } finally {
    if (waiter) waiting.splice(waiting.indexOf(waiter), 1);
    finishQueueObservation?.();
  }
}
