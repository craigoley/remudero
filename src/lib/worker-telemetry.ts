import type { SpawnWorkerArgs, WorkerSelectionAssignment, WorkerStreamEvent } from "./worker.js";

/** Fill an activity event with the metadata for the spawn that produced it. A routed assignment
 *  is stronger than the mount default; fields already present on the event remain authoritative.
 *  In particular, a selected model is not a provider receipt, so it must never become servedModel. */
export function enrichWorkerStreamEvent(
  event: WorkerStreamEvent,
  spawn: Pick<SpawnWorkerArgs, "model" | "mountProvider">,
  assignment?: Pick<WorkerSelectionAssignment, "requested" | "selected">,
): WorkerStreamEvent {
  const provider = event.provider ?? assignment?.selected.provider ?? spawn.mountProvider;
  const requestedModel = event.requestedModel ?? assignment?.requested.model ?? spawn.model;
  return {
    ...event,
    ...(provider ? { provider } : {}),
    ...(requestedModel ? { requestedModel } : {}),
  };
}
