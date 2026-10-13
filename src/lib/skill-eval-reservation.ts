/** Offline scheduler qualification, NOT an authority or a dispatch capability.
 * Reservation-backed evals are default-off. The live command remains quiet-only
 * until a consumer validates the referenced receipts and owns the full-run boundary.
 */
/** PRIMARY CONTROL: the v1 operator-approved contract, not a silent migration to future eval sizes.
 * Conformance tests bind these values to the existing executor. Keep this offline planner free of
 * worker/config/ledger imports; qualifying evidence must not initialize those production modules.
 */
export const RESERVED_EVAL_V1_POLICY = { readyEscalationMs: 60 * 60_000, attempts: 12, perAttemptMaxUsd: 15 } as const;

/** PRIMARY CONTROL: only a fresh resource observation can price admission; tested at both boundary sides. */
export const EVAL_CAPACITY_MAX_AGE_MS = 10_000;
/** PRIMARY CONTROL: closed timing evidence expires as the host workload drifts, independent of grant age. */
export const EVAL_CALIBRATION_MAX_AGE_MS = 24 * 60 * 60_000;

/** All inputs that can change cost, timing, held-out leakage or the paired comparison. */
export interface ReservedEvalBinding {
  proposalId: string;
  draftSha256: string;
  heldOutSetHash: string;
  stackHash: string;
  sourceHead: string;
  nodeVersion: string;
  lockSha256: string;
  host: string;
  commandSha256: string;
}
export interface ReservedEvalReady {
  requestId: string;
  readyAtMs: number;
  expiresAtMs: number;
  /** Read from immutable terminal history, not reset by a new producer. */
  terminal?: "released" | "escalated";
}
export interface ReservedEvalGrant {
  id: string;
  requestId: string;
  binding: ReservedEvalBinding;
  readyAtMs: number;
  approvedAtMs: number;
  admitByMs: number;
  finishByMs: number;
  minWorkers: number;
  maxCostUsd: number;
  perAttemptBudgetUsd: number;
  state: "fresh" | "consumed" | "revoked";
}
export interface ReservedEvalCalibration {
  binding: ReservedEvalBinding;
  receiptSha256: string;
  observedAtMs: number;
  workers: number;
  /** Upper bound for the ENTIRE paired run, including setup and grading. No linear scaling. */
  fullRunUpperBoundMs: number;
  shutdownReserveMs: number;
  perWorkerPeakBytes: number;
  peakDiskBytes: number;
  attempts: number;
  perAttemptBudgetUsd: number;
  state: "closed-native";
}
export interface ReservedEvalCapacity {
  observedAtMs: number;
  host: string;
  cpuFreeWorkers: number;
  memoryFreeBytes: number;
  diskFreeBytes: number;
  /** A READY hold is NOT a worker lease. Already acquired, owned runtime capacity is separate. */
  lease?: { id: string; owned: boolean; workers: number; heldThroughMs: number };
}
export interface ReservedEvalSafeguards {
  holdScope: "NEW-implement-only";
  /** Same-account backend and the actual consumer must have been verified, not inferred from source merge. */
  reservationConsumerVerified: boolean;
  independentReadyDeadlineVerified: boolean;
  durableEscalationAckVerified: boolean;
  wholeRunTerminationVerified: boolean;
  atomicGrantConsumptionVerified: boolean;
  ownLeaseReleaseVerified: boolean;
}
export interface ReservedEvalQualificationInput {
  mode?: "quiet-only" | "reservation-backed";
  nowMs: number;
  binding: ReservedEvalBinding;
  ready: ReservedEvalReady;
  grant?: ReservedEvalGrant;
  calibration?: ReservedEvalCalibration;
  capacity?: ReservedEvalCapacity;
  safeguards?: ReservedEvalSafeguards;
}
export type ReservedEvalQualification = {
  schema: "skill-eval-reservation-v1";
  /** Every state is observational. Never feed this bit to a dispatcher as permission. */
  dispatchAllowed: false;
  state: "inert" | "refused" | "waiting" | "escalate" | "closed" | "qualified";
  reason: string;
  readyDeadlineMs?: number;
  admissionDeadlineMs?: number;
  finishDeadlineMs?: number;
  workers?: number;
  worstCaseCostUsd?: number;
  requiredRuntimeMs?: number;
};

const integer = (value: number, min = 0): boolean => Number.isSafeInteger(value) && value >= min;
const positive = (value: number): boolean => Number.isFinite(value) && value > 0;
const digest = (value: string): boolean => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const atom = (value: string): boolean => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,512}$/.test(value);
function validBinding(b: ReservedEvalBinding): boolean {
  return atom(b.proposalId) && digest(b.draftSha256) && digest(b.heldOutSetHash) && atom(b.stackHash)
    && /^[a-f0-9]{40}$/.test(b.sourceHead) && /^v?\d+\.\d+\.\d+$/.test(b.nodeVersion)
    && digest(b.lockSha256) && atom(b.host) && digest(b.commandSha256);
}
const BINDING_FIELDS: readonly (keyof ReservedEvalBinding)[] = ["proposalId", "draftSha256", "heldOutSetHash", "stackHash",
  "sourceHead", "nodeVersion", "lockSha256", "host", "commandSha256"];
const sameBinding = (a: ReservedEvalBinding, b: ReservedEvalBinding): boolean =>
  BINDING_FIELDS.every((key) => a[key] === b[key]) && validBinding(a);
const fresh = (at: number, now: number, age: number): boolean => integer(at) && at <= now && now - at <= age;

/** Read no files, take no leases, change no fleet flags and spend nothing.
 * The independent deadline service must escalate READY even when nobody invokes this planner.
 * Waiting results are bounded by the ORIGINAL READY/admission deadline, never now + a new window.
 */
export function qualifyReservedSkillEval(input: ReservedEvalQualificationInput): ReservedEvalQualification {
  const result = (state: ReservedEvalQualification["state"], reason: string,
    fields: Partial<ReservedEvalQualification> = {}): ReservedEvalQualification =>
    ({ schema: "skill-eval-reservation-v1", dispatchAllowed: false, state, reason, ...fields });
  // Default-off must not even inspect getters for grant, capacity, READY or clock.
  if (input.mode !== "reservation-backed") return result("inert", "reservation-mode-disabled");
  const { ready, nowMs } = input;
  if (!integer(nowMs) || !digest(ready.requestId) || !integer(ready.readyAtMs)
    || ready.expiresAtMs !== ready.readyAtMs + RESERVED_EVAL_V1_POLICY.readyEscalationMs || !integer(ready.expiresAtMs))
    return result("refused", "invalid-original-ready");
  const deadline = { readyDeadlineMs: ready.expiresAtMs };
  if (ready.terminal !== undefined) {
    if (!["released", "escalated"].includes(ready.terminal)) return result("refused", "invalid-terminal-history", deadline);
    return result("closed", `ready-${ready.terminal}`, deadline);
  }
  if (nowMs < ready.readyAtMs) return result("refused", "clock-before-original-ready", deadline);
  // Missing/revoked grants and stale telemetry cannot hide an overdue READY obligation.
  if (nowMs >= ready.expiresAtMs) return result("escalate", "original-ready-deadline-reached", deadline);
  if (!validBinding(input.binding)) return result("refused", "invalid-workload-binding", deadline);
  const grant = input.grant;
  if (!grant) return result("refused", "separate-live-grant-required", deadline);
  if (!atom(grant.id) || grant.requestId !== ready.requestId || !sameBinding(grant.binding, input.binding) || grant.readyAtMs !== ready.readyAtMs)
    return result("refused", "grant-workload-or-ready-mismatch", deadline);
  if (grant.state !== "fresh") return result("refused", "grant-not-fresh", deadline);
  if (!integer(grant.approvedAtMs) || grant.approvedAtMs > nowMs || !integer(grant.admitByMs)
    || grant.admitByMs <= grant.approvedAtMs || grant.admitByMs > ready.expiresAtMs
    || !integer(grant.finishByMs) || grant.finishByMs <= grant.admitByMs || !integer(grant.minWorkers, 1)
    || !positive(grant.maxCostUsd) || !positive(grant.perAttemptBudgetUsd)
    || grant.perAttemptBudgetUsd > RESERVED_EVAL_V1_POLICY.perAttemptMaxUsd)
    return result("refused", "invalid-fixed-grant", deadline);
  const bounds = { ...deadline, admissionDeadlineMs: grant.admitByMs, finishDeadlineMs: grant.finishByMs };
  if (nowMs >= grant.admitByMs) return result("escalate", "fixed-admission-deadline-reached", bounds);
  const safeguards = input.safeguards;
  if (!safeguards || safeguards.holdScope !== "NEW-implement-only" || safeguards.reservationConsumerVerified !== true
    || safeguards.independentReadyDeadlineVerified !== true || safeguards.durableEscalationAckVerified !== true
    || safeguards.wholeRunTerminationVerified !== true || safeguards.atomicGrantConsumptionVerified !== true || safeguards.ownLeaseReleaseVerified !== true)
    return result("refused", "runtime-safeguards-unverified", bounds);
  const calibration = input.calibration;
  const attempts = RESERVED_EVAL_V1_POLICY.attempts;
  if (!calibration || calibration.state !== "closed-native" || !digest(calibration.receiptSha256)
    || !sameBinding(calibration.binding, input.binding) || !fresh(calibration.observedAtMs, nowMs, EVAL_CALIBRATION_MAX_AGE_MS)
    || !integer(calibration.workers, 1) || calibration.workers < grant.minWorkers
    || !integer(calibration.fullRunUpperBoundMs, 1) || !integer(calibration.shutdownReserveMs, 1)
    || !integer(calibration.perWorkerPeakBytes, 1) || !integer(calibration.peakDiskBytes, 1)
    || calibration.attempts !== attempts || calibration.perAttemptBudgetUsd !== grant.perAttemptBudgetUsd)
    return result("refused", "native-calibration-unverified", bounds);
  const worstCaseCostUsd = attempts * grant.perAttemptBudgetUsd;
  const requiredRuntimeMs = calibration.fullRunUpperBoundMs + calibration.shutdownReserveMs;
  const priced = { ...bounds, workers: calibration.workers, worstCaseCostUsd, requiredRuntimeMs };
  if (!Number.isFinite(worstCaseCostUsd) || worstCaseCostUsd > grant.maxCostUsd)
    return result("refused", "approved-spend-does-not-fit", priced);
  if (!integer(requiredRuntimeMs, 1) || requiredRuntimeMs > grant.finishByMs - nowMs)
    return result("refused", "fixed-runtime-does-not-fit", priced);
  const capacity = input.capacity;
  if (!capacity || capacity.host !== input.binding.host || !fresh(capacity.observedAtMs, nowMs, EVAL_CAPACITY_MAX_AGE_MS)
    || !integer(capacity.cpuFreeWorkers) || !integer(capacity.memoryFreeBytes) || !integer(capacity.diskFreeBytes))
    return result("waiting", "capacity-unmeasured-or-stale", priced);
  const memoryWorkers = Math.floor(capacity.memoryFreeBytes / calibration.perWorkerPeakBytes);
  const lease = capacity.lease;
  if (!lease || !atom(lease.id) || lease.owned !== true || !integer(lease.workers, 1)
    || !integer(lease.heldThroughMs) || lease.heldThroughMs < grant.finishByMs
    || Math.min(capacity.cpuFreeWorkers, memoryWorkers, lease.workers) < calibration.workers
    || capacity.diskFreeBytes < calibration.peakDiskBytes)
    return result("waiting", "owned-runtime-capacity-does-not-fit", priced);
  return result("qualified", "offline-qualified-not-authorized", priced);
}
