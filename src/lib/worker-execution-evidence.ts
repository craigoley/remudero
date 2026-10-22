/** Evidence emitted at the actual adapter, SDK or CLI boundary. A selected provider is insufficient. */
export type WorkerExecutionTransport = "chat-completions" | "responses" | "foundry-messages" | "claude-sdk" | "codex-cli";

export interface WorkerRequestedEffort {
  provenance: "sdk-options" | "cli-argv";
  parameter: "effort" | "model_reasoning_effort";
  state: "parameter-present" | "parameter-omitted" | "parameter-unreadable";
  value: string | null;
  providerEffectiveEffort: null;
}

const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function requested(provenance: WorkerRequestedEffort["provenance"], values: unknown[]): WorkerRequestedEffort {
  const state = values.length === 0 ? "parameter-omitted"
    : values.length === 1 && typeof values[0] === "string" && efforts.has(values[0]) ? "parameter-present" : "parameter-unreadable";
  return { provenance, parameter: provenance === "sdk-options" ? "effort" : "model_reasoning_effort", state,
    value: state === "parameter-present" ? values[0] as string : null, providerEffectiveEffort: null };
}

export function sdkRequestedEffort(options: object): WorkerRequestedEffort {
  return requested("sdk-options", Object.hasOwn(options, "effort") ? [(options as Record<string, unknown>).effort] : []);
}

/** Inspect only the exact effort configuration arguments; no prompt or arbitrary argv is retained. */
export function codexRequestedEffort(argv: readonly string[]): WorkerRequestedEffort {
  const values: unknown[] = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== "-c" || !argv[i + 1]!.startsWith("model_reasoning_effort=")) continue;
    try { values.push(JSON.parse(argv[i + 1]!.slice("model_reasoning_effort=".length))); }
    catch { values.push({ unreadable: "invalid-effort-json" }); }
  }
  return requested("cli-argv", values);
}

export function readWorkerRequestedEffort(value: unknown): WorkerRequestedEffort | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if ((row.provenance !== "sdk-options" && row.provenance !== "cli-argv") || row.providerEffectiveEffort !== null
    || row.parameter !== (row.provenance === "sdk-options" ? "effort" : "model_reasoning_effort")
    || (row.state !== "parameter-present" && row.state !== "parameter-omitted" && row.state !== "parameter-unreadable")
    || (row.state === "parameter-present" ? typeof row.value !== "string" || !efforts.has(row.value) : row.value !== null)) return undefined;
  return { provenance: row.provenance as WorkerRequestedEffort["provenance"], parameter: row.parameter as WorkerRequestedEffort["parameter"],
    state: row.state as WorkerRequestedEffort["state"], value: row.value as string | null, providerEffectiveEffort: null };
}

export type IdentityObservation<T extends string> =
  | { state: "observed"; value: T }
  | { state: "unavailable"; reason: "missing" | "invalid" | "conflicting" };

/** Missing duplicates cannot erase a known identity. Invalid and contradictory identities never pick a preferred event. */
export function mergeWorkerIdentity<T extends string>(prior: IdentityObservation<T> | undefined, value: unknown, allowed: readonly T[]): IdentityObservation<T> {
  const next: IdentityObservation<T> = value === undefined ? { state: "unavailable", reason: "missing" }
    : typeof value === "string" && allowed.includes(value as T) ? { state: "observed", value: value as T }
    : { state: "unavailable", reason: "invalid" };
  if (prior === undefined || (prior.state === "unavailable" && prior.reason === "missing")) return next;
  if (next.state === "unavailable" && next.reason === "missing") return prior;
  if ((prior.state === "unavailable" && prior.reason === "invalid") || (next.state === "unavailable" && next.reason === "invalid"))
    return { state: "unavailable", reason: "invalid" };
  if (prior.state === "unavailable") return prior;
  return next.state === "observed" && prior.value === next.value ? prior : { state: "unavailable", reason: "conflicting" };
}

export function mergeServedModel(prior: IdentityObservation<string> | undefined, value: unknown): IdentityObservation<string> {
  return mergeWorkerIdentity(prior, value === null ? undefined : value,
    typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 ? [value] : []);
}
