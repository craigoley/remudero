/** Same-process bridge from the scheduled app runner to the existing owner and qualified host backend. */
import type { CanarySlotOwner } from "./model-canary-owner.js";
import type { CanarySlot } from "./model-canary-schedule.js";
import { codingAttemptConsumptionBinding, isRegisteredCanarySlotOwner } from "./model-canary-coding-capabilities.js";
import { registerQualifiedCodingExecutionPort } from "./model-canary-coding-port-capability.js";
import { bindCodingExecutionAuthority, executeCodingCandidate, parseCodingCandidate,
  refuseCodingBeforeHost, unavailableCodingAttempt, type CodingRunnerResult } from "./model-canary-coding.js";
import { createSystemdBwrapCodingExecutor, getQualifiedLinuxCodingBounds,
  isQualifiedLinuxCodingProfile, type QualifiedLinuxCodingProfile } from "./model-canary-systemd-bwrap-backend.js";
import type { CanaryExecutionPorts } from "./model-canary-runner.js";

type ExecuteCodingInput = NonNullable<CanaryExecutionPorts["executeCoding"]> extends (input: infer I) => Promise<CodingRunnerResult> ? I : never;
/**
 * Requires the actual existing slot owner and native-issued Linux profile capability. This factory
 * never constructs a profile from config or launches a second owner; absent these native inputs it
 * returns null, allowing the schedule to defer before provider admission.
 */
export function createCodingCanaryExecutionPort(input: {
  slot: CanarySlot;
  owner: CanarySlotOwner;
  profile: QualifiedLinuxCodingProfile | null;
}): NonNullable<CanaryExecutionPorts["executeCoding"]> | null {
  if (!isRegisteredCanarySlotOwner(input.owner) || !isQualifiedLinuxCodingProfile(input.profile)) return null;
  const configured = getQualifiedLinuxCodingBounds(input.profile);
  if (!configured) return null;
  const execute = createSystemdBwrapCodingExecutor(input.profile);
  const port: NonNullable<CanaryExecutionPorts["executeCoding"]> = async (request: ExecuteCodingInput) => {
    if (request.slotId !== input.slot.id || request.caseId !== input.slot.caseId
      || request.suiteHash !== input.slot.pin.suiteHash || !request.runId || !request.canaryAttemptId
      || !request.workerSpawnAttemptId || !/^[a-f0-9]{64}$/.test(request.sourceDigest))
      return refuseCodingBeforeHost("coding-case-binding-mismatch");
    let candidate: ReturnType<typeof parseCodingCandidate>;
    try { candidate = parseCodingCandidate(request.responseText); }
    catch { // A malformed worker response is explicitly refused before host execution.
      return refuseCodingBeforeHost("coding-response-invalid"); }
    if (candidate.sourceDigest !== request.sourceDigest)
      return refuseCodingBeforeHost("coding-case-binding-mismatch");
    const consumed = input.owner.consumeCodingAttempt(input.slot, { runId: request.runId,
      canaryAttemptId: request.canaryAttemptId, workerSpawnAttemptId: request.workerSpawnAttemptId,
      sourceDigest: candidate.sourceDigest });
    if (consumed.state === "already-consumed") return unavailableCodingAttempt("owner-attempt-already-consumed");
    if (consumed.state !== "consumed") return refuseCodingBeforeHost("owner-profile-unavailable");
    const binding = codingAttemptConsumptionBinding(consumed.capability);
    if (!binding || binding.runId !== request.runId || binding.slotId !== request.slotId
      || binding.caseId !== request.caseId || binding.suiteHash !== request.suiteHash
      || binding.canaryAttemptId !== request.canaryAttemptId
      || binding.workerSpawnAttemptId !== request.workerSpawnAttemptId
      || binding.sourceDigest !== candidate.sourceDigest)
      return unavailableCodingAttempt("owner-attempt-already-consumed");
    const authority = bindCodingExecutionAuthority({ binding, configured,
      execute: nativeInput => execute(nativeInput), consumption: consumed.capability });
    return executeCodingCandidate({ binding, fixture: request.fixture, responseText: request.responseText,
      authority, signal: request.signal });
  };
  return registerQualifiedCodingExecutionPort(port);
}
