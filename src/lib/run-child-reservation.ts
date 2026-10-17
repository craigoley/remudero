import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { awaitMemoryAdmission, type AdmissionPorts } from "./host-memory-admission.js";
import {
  adoptLearnedReservation, openLearnedReservation, workerClassOfLane,
  type LearnedReservation, type LearnedReservationOptions,
} from "./host-memory-learning.js";
import {
  censusRunDirs, classifyRunDir, readSpec,
  type RunChildEntryKind, type RunChildProbe, type RunChildSpec,
} from "./run-child-contract.js";

/** Admission and reservation happen in the daemon, before it spawns and binds the run child's pid. */
export async function reserveRunChild(
  input: { lane: string; root: string; runId?: string; taskId?: string; entryKind: RunChildEntryKind; signal?: AbortSignal; sinceMs?: number },
  deps: LearnedReservationOptions & { admission?: Partial<AdmissionPorts> } = {},
): Promise<LearnedReservation> {
  const workerClass = workerClassOfLane(input.lane);
  const reserve = () => openLearnedReservation({ workerClass, root: input.root, entryKind: input.entryKind }, deps);
  const admission = await awaitMemoryAdmission({ ...input, workerClass, reserve }, deps.admission);
  // W1-T10000: an aborted wait opens no reservation; the caller that aborted it reads the abandonment off its own signal.
  if (admission.kind === "abandoned") throw new Error(`the run child's memory admission was abandoned after ${admission.waitedMs} ms`);
  return ("reservation" in admission ? admission.reservation : undefined) ?? reserve();
}

/** The boot adoption caller reclaims only a child whose contract and process identity still agree. */
export function adoptRunChildReservation(
  dir: string, deps: LearnedReservationOptions = {}, probe?: RunChildProbe,
): LearnedReservation | undefined {
  const classified = classifyRunDir(dir, probe);
  const spec = readSpec(dir);
  if (classified.kind !== "live" || !classified.status || !spec.ok ||
      spec.value.runId !== classified.status.runId || !spec.value.reservationId) return undefined;
  const identity = classified.status.identity;
  return adoptLearnedReservation(spec.value.reservationId, {
    pid: identity.pid, start: identity.startTicks, generation: identity.containerGeneration,
  }, { ...deps, ledger: { ...deps.ledger, root: deps.ledger?.root ?? loadConfig().root } });
}

/** Read the contract's identity census each time: terminal, lost and reused pids never occupy a lane. */
export function liveRunChildCount(
  stateRoot = join(loadConfig().root, "state"), probe?: RunChildProbe,
): number {
  return censusRunDirs(stateRoot, probe).live;
}

const childReservation = new AsyncLocalStorage<RunChildSpec>();

/** The child entry wraps its run with its spec; nested worker calls and provider retries inherit this context. */
export function withRunChildReservation<T>(spec: RunChildSpec, operation: () => T): T {
  return childReservation.run(spec, operation);
}

export function currentRunChildReservationId(): string | undefined {
  return childReservation.getStore()?.reservationId || undefined;
}
