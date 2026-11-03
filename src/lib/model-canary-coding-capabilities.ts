/** Runtime-leaf registry shared by the durable owner and coding execution adapter. */
export interface CodingControlBindingV1 {
  caseId: string;
  suiteHash: string;
  runId: string;
  slotId: string;
  canaryAttemptId: string;
  workerSpawnAttemptId: string;
  codingExecutionAttemptId: string;
  sourceDigest: string;
}

export interface CodingAttemptConsumptionCapability {
  readonly kind: "canary-coding-attempt-consumed-v1";
  readonly binding: CodingControlBindingV1;
}

const registeredOwners = new WeakSet<object>();
const capabilities = new WeakMap<object, CodingControlBindingV1>();
const consumed = new WeakSet<object>();
export type CodingProviderRequestState = "not-started" | "in-flight" | "closed" | "uncertain";
const providerRequestStates = new WeakMap<object, CodingProviderRequestState>();

/** @internal Called once by CanarySlotOwner after its constructor validates/opens the store. */
export function registerCanarySlotOwner(owner: object): void {
  registeredOwners.add(owner);
}
export function isRegisteredCanarySlotOwner(owner: unknown): owner is object {
  return owner !== null && typeof owner === "object" && registeredOwners.has(owner);
}

/** @internal Production caller is the registered owner's successful durable consume CAS. */
export function issueCodingAttemptConsumption(owner: object,
  binding: CodingControlBindingV1): CodingAttemptConsumptionCapability {
  if (!isRegisteredCanarySlotOwner(owner)) throw new Error("coding-owner-registration-required");
  const capability = Object.freeze({ kind: "canary-coding-attempt-consumed-v1" as const,
    binding: Object.freeze({ ...binding }) });
  capabilities.set(capability, capability.binding);
  return capability;
}

/** Membership lookup used for joins; imported JSON cannot recreate this WeakMap entry. */
export function codingAttemptConsumptionBinding(value: unknown): CodingControlBindingV1 | null {
  if (value === null || typeof value !== "object") return null;
  return capabilities.get(value) ?? null;
}

/** Single-use adapter handoff; a consumed owner receipt cannot mint a second executor authority. */
export function consumeCodingAttemptConsumption(value: unknown): CodingControlBindingV1 | null {
  if (value === null || typeof value !== "object" || consumed.has(value)) return null;
  const binding = capabilities.get(value);
  if (!binding) return null;
  consumed.add(value);
  return binding;
}

/** Internal live-run token; imported JSON cannot establish a provider request's closure state. */
export function createCodingProviderRequestLifecycle(): object {
  const token = Object.freeze(Object.create(null)) as object;
  providerRequestStates.set(token, "not-started");
  return token;
}
export function markCodingProviderRequestStarted(token: unknown): void {
  if (token !== null && typeof token === "object" && providerRequestStates.get(token) === "not-started")
    providerRequestStates.set(token, "in-flight");
}
export function markCodingProviderRequestUncertain(token: unknown): void {
  if (token !== null && typeof token === "object" && providerRequestStates.get(token) === "in-flight")
    providerRequestStates.set(token, "uncertain");
}
export function markCodingProviderRequestClosed(token: unknown): void {
  if (token !== null && typeof token === "object") {
    const state = providerRequestStates.get(token);
    if (state === "in-flight" || state === "uncertain") providerRequestStates.set(token, "closed");
  }
}
export function codingProviderRequestState(token: unknown): CodingProviderRequestState | null {
  return token !== null && typeof token === "object" ? providerRequestStates.get(token) ?? null : null;
}
