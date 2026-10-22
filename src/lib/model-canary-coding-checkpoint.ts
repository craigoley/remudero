/** Durable execution facts only. A checkpoint is never native containment or model efficacy. */
import { codingCaseRequests, type CodingCaseId } from "./model-canary-coding.js";
import { codingIsolationPlan } from "./model-canary-coding-isolation.js";
import type { CanarySlot } from "./model-canary-schedule.js";

export interface CodingCheckpoint {
  version: "canary-coding-checkpoint-v1";
  phase: "prepared" | "create-intent" | "created" | "execution-intent" | "cleanup-intent" | "cleanup-confirmed";
  nonce: string;
  image: string;
  directory: string;
  containerId: string | null;
}

export const isCodingCase = (id: string) => codingCaseRequests().some(r => r.id === id);

export function codingSlotCase(slot: CanarySlot): CodingCaseId {
  const request = codingCaseRequests().find(r => r.id === slot.caseId);
  if (!request || slot.pin.suiteHash !== request.suiteHash || slot.pin.billing !== "subscription"
      || slot.context !== undefined || slot.retention !== undefined)
    throw new Error("coding-owner-slot-contract-invalid");
  return request.id;
}

/** Each transition records intent before the real external operation. Exact identity cannot
 * change on a later event. Unknown create/removal has no cleanup-confirmed transition.
 */
export function validateCodingCheckpoint(next: CodingCheckpoint, prior: CodingCheckpoint | null): void {
  if (!next || Object.keys(next).sort().join(",") !== "containerId,directory,image,nonce,phase,version"
      || next.version !== "canary-coding-checkpoint-v1"
      || !["prepared", "create-intent", "created", "execution-intent", "cleanup-intent", "cleanup-confirmed"].includes(next.phase)
      || (next.containerId !== null && !/^[a-f0-9]{64}$/.test(next.containerId)))
    throw new Error("coding-owner-checkpoint-invalid");
  codingIsolationPlan(next.image, next.directory, next.nonce);
  if (!prior) {
    if (next.phase !== "prepared" || next.containerId !== null) throw new Error("coding-owner-first-checkpoint-invalid");
    return;
  }
  if (next.nonce !== prior.nonce || next.image !== prior.image || next.directory !== prior.directory
      || (prior.containerId !== null && next.containerId !== prior.containerId))
    throw new Error("coding-owner-checkpoint-identity-conflict");
  const allowed = prior.phase === "prepared" ? ["create-intent", "cleanup-confirmed"]
    : prior.phase === "create-intent" ? ["created", "cleanup-intent"]
    : prior.phase === "created" ? ["execution-intent", "cleanup-intent"]
    : prior.phase === "execution-intent" ? ["cleanup-intent"]
    : prior.phase === "cleanup-intent" ? ["cleanup-confirmed"] : [];
  if (!allowed.includes(next.phase) || (["created", "execution-intent", "cleanup-intent"].includes(next.phase) && next.containerId === null)
      || (next.phase === "create-intent" && next.containerId !== null)
      || (next.phase === "cleanup-confirmed" && prior.phase === "prepared" && next.containerId !== null))
    throw new Error("coding-owner-checkpoint-transition-invalid");
}
