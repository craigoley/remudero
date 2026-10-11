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
 */

import { join } from "node:path";

import { daemonOwnedProcess, openLearnedReservation, type LearnedReservation } from "./host-memory-learning.js";
import { MemoryAdmissionLockBusyError, withMemoryAdmissionLock, type WorkerClass } from "./host-memory-ledger.js";
import { rankDemand } from "./host-memory-priority.js";
import {
  defaultShadowMemoryPorts,
  evaluateShadowMemory,
  gatherShadowInputs,
  type ShadowInputs,
  type ShadowMemoryPorts,
  type ShadowVerdict,
} from "./host-memory-shadow.js";
import { LEDGER_FILENAME } from "./ledger-path.js";

export const ENFORCE_WAIT_STEP = "memory_budget.enforce_wait";
export const ENFORCE_ADMIT_STEP = "memory_budget.enforce_admit";
export const ENFORCE_ERROR_STEP = "memory_budget.enforce_error";

/** PROPOSALS for the back-off schedule: the first re-read after 5 s, doubling to one re-read a minute. */
export const ADMISSION_BACKOFF = { baseMs: 5_000, maxMs: 60_000, jitter: 0.2 } as const;

export type AdmissionTier = "fits" | "uncertain" | "shortfall";

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
  /** The state root, or how to read it: resolved only under "enforce", so the shipped mode pays nothing for it. */
  root: string | (() => string);
  runId?: string;
  taskId?: string;
  /** A caller with an existing reservation seam supplies it here; the same handle goes to its spawn. */
  reserve?: () => LearnedReservation | undefined;
}

export type AdmissionOutcome =
  | { kind: "not-enforced"; why: string }
  | { kind: "admitted"; tier: AdmissionTier | "nothing-to-wait-for"; waitedMs: number; attempts: number; reservation?: LearnedReservation }
  | { kind: "error"; reason: string; reservation?: LearnedReservation; reservationAttempted?: true };

export interface AdmissionPorts extends ShadowMemoryPorts {
  sleep: (ms: number) => Promise<void>;
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

export function resetMemoryAdmissionStateForTests(): void {
  waiting.length = 0;
}

/** Starts waiting in this process right now, for diagnostics and tests. */
export function waitingStarts(): ReadonlyArray<Readonly<Waiter>> {
  return [...waiting];
}

function defaultAdmissionPorts(): AdmissionPorts {
  return {
    ...defaultShadowMemoryPorts(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: Math.random,
    enforceHere: () => daemonOwnedProcess(),
    withLock: withMemoryAdmissionLock,
    openReservation: openLearnedReservation,
  };
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
  try {
    const policy = ports.policy();
    if (policy.mode !== "enforce") return { kind: "not-enforced", why: `mode ${policy.mode}` };
    if (!ports.enforceHere()) return { kind: "not-enforced", why: "not a daemon-owned process" };
    const root = typeof request.root === "string" ? request.root : request.root();
    ledgerPath = join(root, "state", LEDGER_FILENAME);
    const clock = ports.clock;
    const startedAt = clock.now();
    waiter = { instance: root, workerClass: request.workerClass, waitingSinceMs: startedAt };
    waiting.push(waiter);
    let attempt = 0;
    let noted = false;
    for (;;) {
      const now = clock.now();
      const head = rankDemand(waiting, ports.priorityPolicy(), now)[0];
      if (head === waiter) {
        try {
          const { inputs, verdict, tier, admitAs } = ports.withLock(() => {
            const inputs = gatherShadowInputs({ ...request, root }, ports, policy);
            const verdict = evaluateShadowMemory(inputs, policy);
            const tier = admissionTier(verdict);
            const admitAs: AdmissionTier | "nothing-to-wait-for" | undefined = tier === "fits" ? "fits"
              : tier === "uncertain" && attempt > 0 ? "uncertain"
                : tier === "shortfall" && !reservedWorkRunning(inputs) ? "nothing-to-wait-for"
                  : undefined;
            if (admitAs !== undefined) {
              if (admitAs === "fits" && inputs.ledger.state !== "present") throw new Error(`admission-ledger-${inputs.ledger.state}`);
              reservationAttempted = true;
              reservation = request.reserve ? request.reserve() : ports.openReservation({ workerClass: request.workerClass, root });
              if (!reservation?.published || reservation.id === undefined) throw new Error("admission-reservation-unpublished");
              if (reservation.estimateMib !== inputs.start.estimateMib) throw new Error("admission-estimate-changed");
              const visible = ports.readLedger(root);
              if (visible?.state !== "present") throw new Error(`admission-ledger-${visible?.state ?? "unreadable"}`);
              if (!visible.entries.some(entry => entry.id === reservation!.id)) throw new Error("admission-reservation-not-visible");
            }
            return { inputs, verdict, tier, admitAs };
          });
          if (admitAs !== undefined) {
            const waitedMs = now - startedAt;
            if (noted || admitAs !== "fits") {
              write({ step: ENFORCE_ADMIT_STEP, worker_class: request.workerClass, tier: admitAs, waited_ms: waitedMs,
                attempts: attempt, reasons: verdict.reasons, numbers: verdict.numbers });
            }
            return { kind: "admitted", tier: admitAs, waitedMs, attempts: attempt, ...(reservation ? { reservation } : {}) };
          }
          if (!noted) {
            noted = true;
            write({ step: ENFORCE_WAIT_STEP, worker_class: request.workerClass, tier, reasons: verdict.reasons,
              uncertainty: verdict.uncertainty, numbers: verdict.numbers, scenario: verdict.scenario,
              waiting: waiting.length });
          }
        } catch (error) {
          if (!(error instanceof MemoryAdmissionLockBusyError)) throw error;
          if (!noted) {
            noted = true;
            write({ step: ENFORCE_WAIT_STEP, worker_class: request.workerClass, tier: "uncertain", reasons: ["admission-lock-held"], waiting: waiting.length });
          }
        }
      }
      await ports.sleep(backoffMs(attempt, ports.random()));
      attempt += 1;
    }
  } catch (error) {
    const reason = reasonOf(error);
    write({ step: ENFORCE_ERROR_STEP, worker_class: request.workerClass, reason, admitted: true });
    return { kind: "error", reason, ...(reservation ? { reservation } : reservationAttempted ? { reservationAttempted: true as const } : {}) };
  } finally {
    if (waiter) waiting.splice(waiting.indexOf(waiter), 1);
  }
}
