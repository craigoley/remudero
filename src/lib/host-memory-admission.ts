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
 *     instance or another still runs reserved work that can free memory. With NOTHING live to wait for, a projected
 *     shortfall may admit one named progress start. Observed host pressure or a sighted container ceiling NEVER takes
 *     that escape: defer callers stay due; wait callers remain cancellable by their caller's existing deadline.
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

import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { fixedClock } from "./clock.js";

import { daemonOwnedProcess, openLearnedReservation, type LearnedReservation } from "./host-memory-learning.js";
import { MEMORY_ADMISSION_LOCK_BUSY, withMemoryAdmissionLock, type WorkerClass } from "./host-memory-ledger.js";
import { rankDemand, type HostMemoryPriorityPolicy } from "./host-memory-priority.js";
import {
  defaultShadowMemoryPorts,
  evaluateShadowMemory,
  gatherShadowInputs,
  hostMemoryBudgetModeFor,
  markPsiStartAdmitted,
  type ShadowInputs,
  type ShadowMemoryPorts,
  type ShadowReason,
  type ShadowVerdict,
} from "./host-memory-shadow.js";
import { LEDGER_FILENAME } from "./ledger-path.js";

export const ENFORCE_WAIT_STEP = "memory_budget.enforce_wait";
export const ENFORCE_ADMIT_STEP = "memory_budget.enforce_admit";
export const ENFORCE_ERROR_STEP = "memory_budget.enforce_error";
/** A start that asked to be deferred rather than wait was deferred to its caller's next pass. */
export const ENFORCE_DEFER_STEP = "memory_budget.enforce_defer";

/** PROPOSALS for the back-off schedule: the first re-read after 5 s, doubling to one re-read a minute. */
export const ADMISSION_BACKOFF = { baseMs: 5_000, maxMs: 60_000, jitter: 0.2 } as const;

export type AdmissionTier = "fits" | "uncertain" | "shortfall";

/** Why the aged rung did not admit a deferred start; each defer row names one. */
export type AgedBlock = "no-cadence" | "younger-than-cadence" | "unobserved-seed" | "outranked" | "aged-child-running"
  | "memory-available" | "container-sighted" | "swap-in" | "psi";

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

/** An observed pressure reason cannot become capacity merely because no reservation can be waited out.
 * Projected container claims are deliberately excluded: the existing minimum-progress escape still applies. */
function observedMemoryShortfall(verdict: Pick<ShadowVerdict, "reasons" | "numbers">):
  "memory-available" | "container-sighted" | "swap-in" | "psi" | undefined {
  for (const reason of verdict.reasons) {
    if (reason === "memory-available" || reason === "swap-in" || reason === "psi") return reason;
    if (reason === "container-ceiling" && verdict.numbers.containerSighted) return "container-sighted";
  }
  return undefined;
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
  deferral?: { cadenceMs: number; cadenceBasis: "measured" | "scheduled"; dueSinceMs?: number };
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
  return observedMemoryShortfall(verdict);
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
  const ports: AdmissionPorts = { ...defaultAdmissionPorts(), ...overrides };
  let ledgerPath: string | undefined;
  const base = { run_id: request.runId ?? "memory-budget-enforce", task_id: request.taskId ?? "MEMORY-BUDGET" };
  const write = (row: { step: string } & Record<string, unknown>): void => {
    try {
      if (ledgerPath !== undefined) ports.write?.(ledgerPath, { ...base, ...row });
      else ports.stderr(JSON.stringify({ ...base, ...row }));
    } catch (error) {
      ports.stderr(JSON.stringify({ event: row.step, error: reasonOf(error) }));
    }
  };
  let waiter: Waiter | undefined;
  let reservation: LearnedReservation | undefined;
  let reservationAttempted = false;
  let streakKey: string | undefined;
  let startedAt: number | undefined;
  let attempt = 0;
  const abandoned = (): AdmissionOutcome => ({ kind: "abandoned", reason: "admission-abandoned",
    waitedMs: startedAt === undefined ? 0 : Math.max(0, ports.clock.now() - startedAt), attempts: attempt });
  try {
    if (request.signal?.aborted) return abandoned();
    const policy = ports.policy();
    const mode = hostMemoryBudgetModeFor(policy, request.workerClass);
    const defers = request.onShortfall === "defer";
    if (mode !== "enforce") {
      if (defers) endDeferralStreak(request.runId ?? request.workerClass);
      return { kind: "not-enforced", why: `mode ${mode}` };
    }
    if (!ports.enforceHere()) return { kind: "not-enforced", why: "not a daemon-owned process" };
    const root = typeof request.root === "string" ? request.root : request.root();
    ledgerPath = join(root, "state", LEDGER_FILENAME);
    const clock = ports.clock;
    startedAt = clock.now();
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
    let noted = false;
    let ledgeredKey: string | undefined;
    let lastKey = "queued";
    const waitedByReason: Record<string, number> = {};
    for (;;) {
      if (request.signal?.aborted) return abandoned();
      const now = clock.now();
      const head = rankDemand(waiting, ports.priorityPolicy(), now)[0];
      if (head !== waiter) lastKey = "queued";
      if (head === waiter) {
        try {
          const { inputs, verdict, tier, admitAs, agedBlock, ownTail } = ports.withLock(() => {
            const inputs = gatherShadowInputs({ ...request, root }, ports, policy);
            const verdict = evaluateShadowMemory(inputs, policy);
            const tier = admissionTier(verdict);
            const agedBlock = defers && tier === "shortfall"
              ? agedRungBlock(key, waiter!, request.deferral, verdict, ports.priorityPolicy(), now, seededSince) : undefined;
            let ownTail: OwnTailRung | undefined;
            const admitAs: AdmissionTier | "nothing-to-wait-for" | "aged" | "own-tail" | undefined = tier === "fits" ? "fits"
              : tier === "uncertain" && attempt > 0 ? "uncertain"
                : tier === "shortfall" && !reservedWorkRunning(inputs) && observedMemoryShortfall(verdict) === undefined
                  ? "nothing-to-wait-for"
                  : defers && tier === "shortfall" && agedBlock === undefined ? "aged"
                    : tier === "shortfall" && (ownTail = ownTailRung(root, inputs, verdict, policy)).block === undefined ? "own-tail"
                      : undefined;
            if (admitAs !== undefined) {
              if (admitAs === "fits" && inputs.ledger.state !== "present") throw new Error(`admission-ledger-${inputs.ledger.state}`);
              reservationAttempted = true;
              reservation = request.reserve ? request.reserve() : ports.openReservation({ workerClass: request.workerClass, root });
              if (reservation === undefined || reservation.id === undefined) throw new Error("admission-reservation-unavailable");
              if (reservation.published !== true) throw new Error("admission-reservation-unpublished");
              if (reservation.estimateMib !== inputs.start.estimateMib) throw new Error("admission-estimate-changed");
              const visible = ports.readLedger(root);
              if (visible?.state !== "present") throw new Error(`admission-ledger-${visible?.state ?? "unreadable"}`);
              if (!visible.entries.some(entry => entry.id === reservation!.id)) throw new Error("admission-reservation-not-visible");
              if (inputs.psiRecordAt !== undefined) markPsiStartAdmitted(ports, root, inputs.psiRecordAt);
            }
            return { inputs, verdict, tier, admitAs, agedBlock, ownTail };
          });
          lastKey = verdict.reasons.join("+") || tier;
          if (admitAs !== undefined) {
            const streak = streaks.get(key);
            if (defers) streaks.delete(key);
            if (admitAs === "aged") {
              // The queueing wait this process observed, apart from the age a restart seed carried into the streak.
              const waitedMs = now - askedSince;
              agedRunning = key;
              write({ step: ENFORCE_ADMIT_STEP, worker_class: request.workerClass, tier: "aged", waited_ms: waitedMs,
                seeded_ms: askedSince - since, deferred_since: fixedClock(since).iso(),
                deferrals: streak?.deferrals ?? 0, cadence_ms: request.deferral!.cadenceMs, cadence_basis: request.deferral!.cadenceBasis,
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
              cadence_ms: request.deferral?.cadenceMs ?? null, cadence_basis: request.deferral?.cadenceBasis ?? null, aged_blocked: agedBlock });
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
    if (streakKey !== undefined && request.onShortfall === "defer") streaks.delete(streakKey); // fail-open is an admission
    write({ step: ENFORCE_ERROR_STEP, worker_class: request.workerClass, reason, admitted: true });
    return { kind: "error", reason, ...(reservation ? { reservation } : reservationAttempted ? { reservationAttempted: true as const } : {}) };
  } finally {
    if (waiter) waiting.splice(waiting.indexOf(waiter), 1);
  }
}
