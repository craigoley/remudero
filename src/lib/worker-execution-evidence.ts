/** Private, attempt-keyed normalization of worker results. It never upgrades assignment or estimates to provider or invoice evidence. */
import { billingMode, type BillingMode } from "./env.js";
import type { CashRequestEffortCount } from "./cash-request-effort.js";
import type { WorkerProviderId } from "./config.js";

export type WorkerEvidence<T> =
  | { readonly state: "observed"; readonly value: T }
  | { readonly state: "unavailable"; readonly reason: string };

export interface WorkerExecutionTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

export type WorkerTokenUsageEvidence =
  | { readonly state: "observed" | "partial"; readonly value: WorkerExecutionTokens }
  | { readonly state: "unavailable"; readonly reason: string };

export interface SdkRequestEvidence {
  readonly model: WorkerEvidence<string>;
  readonly effort: WorkerEvidence<string>;
}

/** The result fields consumed by this normalizer. Kept structural to avoid a worker/helper import cycle. */
export interface WorkerExecutionInput {
  readonly provider?: WorkerProviderId;
  readonly childEnvKeys?: readonly string[];
  readonly model?: string;
  readonly routedModel?: string;
  readonly servedModel?: string | null;
  readonly servedModelReason?: string;
  readonly sdkRequest?: SdkRequestEvidence;
  readonly notStarted?: "admission-abandoned";
  readonly usageRefusal?: unknown;
  readonly budgetRefused?: boolean;
  readonly isError?: boolean;
  readonly workerDurationMs?: number;
  readonly workerFirstTextMs?: number | null;
  readonly workerFirstTextReason?: string;
  readonly tokenUsageState?: "observed" | "partial" | "unavailable";
  readonly tokens: WorkerExecutionTokens;
  readonly requestEfforts?: readonly CashRequestEffortCount[];
  readonly usageEstimateUsd?: number | null;
  readonly sdkReportedUsageRatedUsd?: number;
  readonly notionalCostUsd?: number;
  readonly billedUsd?: number | null;
  readonly budgetReservedUsd?: number;
  readonly budgetSettledUsd?: number;
  readonly budgetHeldUsd?: number;
}

/** Capture the final SDK option itself; `WorkerResult.effort` is only a configured input label. */
export function sdkRequestedEffort(options: { readonly effort?: unknown }): WorkerEvidence<string> {
  return observedString(options.effort, "sdk-effort-option-omitted");
}

/** Capture the final SDK model option without treating it as provider-reported serving identity. */
export function sdkRequestedModel(options: { readonly model?: unknown }): WorkerEvidence<string> {
  return observedString(options.model, "sdk-model-option-omitted");
}

export interface WorkerExecutionEvidenceV1<Assignment = unknown> {
  readonly version: "worker-execution-evidence-v1";
  readonly attemptId: string;
  readonly unit: "worker-spawn";
  readonly measurementScope: "returned-terminal-result";
  readonly assignment: WorkerEvidence<Readonly<Assignment>>;
  readonly providerInvoked: WorkerEvidence<boolean>;
  readonly identity: {
    readonly provider: WorkerEvidence<WorkerProviderId>;
    readonly configuredModel: WorkerEvidence<string>;
    readonly routedModel: WorkerEvidence<string>;
    readonly sdkRequestedModel: WorkerEvidence<string>;
    readonly sdkRequestedEffort: WorkerEvidence<string>;
    readonly servedModel: WorkerEvidence<string>;
  };
  readonly execution: {
    readonly terminal: WorkerEvidence<"success" | "error" | "refused">;
    readonly durationMs: WorkerEvidence<number>;
    readonly firstTextMs: WorkerEvidence<number>;
    readonly tokenUsage: WorkerTokenUsageEvidence;
    readonly requestEfforts: WorkerEvidence<readonly CashRequestEffortCount[]>;
    readonly invocationCount: WorkerEvidence<number>;
    readonly fallbackCoverage: WorkerEvidence<"complete">;
    readonly peakRssBytes: WorkerEvidence<number>;
  };
  readonly accounting: {
    readonly billingMode: WorkerEvidence<BillingMode>;
    readonly apiUsageRatedUsd: WorkerEvidence<number>;
    readonly subscriptionNotionalUsd: WorkerEvidence<number>;
    readonly billedCashUsd: WorkerEvidence<number>;
    readonly invoiceUsd: WorkerEvidence<number>;
    readonly cashBudget: {
      readonly reservedUsd: WorkerEvidence<number>;
      readonly settledUsd: WorkerEvidence<number>;
      readonly heldUsd: WorkerEvidence<number>;
    };
  };
}

const unavailable = <T = never>(reason: string): WorkerEvidence<T> => ({ state: "unavailable", reason });
const observedString = (value: unknown, absentReason: string): WorkerEvidence<string> =>
  typeof value === "string" && value.trim().length > 0 ? { state: "observed", value } : unavailable(absentReason);
const observedNumber = (value: unknown, absentReason: string): WorkerEvidence<number> =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? { state: "observed", value }
    : unavailable(absentReason);

function validAttemptId(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 200)
    throw new Error("worker-execution-attempt-id-invalid");
  return value;
}

/**
 * Normalize one actual returned worker result under an explicit caller-minted attempt id.
 * The unit is one spawn's returned terminal result: it does not claim one provider request,
 * no fallback, or complete per-invocation cost when the provider walk has multiple calls.
 */
export function workerExecutionEvidence<Assignment = unknown>(
  attemptId: string,
  result: WorkerExecutionInput,
  assignment?: Readonly<Assignment>,
): WorkerExecutionEvidenceV1<Assignment> {
  validAttemptId(attemptId);
  const assigned = assignment
    ? { state: "observed" as const, value: structuredClone(assignment) }
    : unavailable<Readonly<Assignment>>("selection-assignment-not-observed");
  const sdkRequest = result.sdkRequest;
  const cashProviderUnavailableReason = result.provider === undefined ? "provider-not-recorded" : "not-cash-provider";
  const billing = result.provider === "cash"
    ? { state: "observed" as const, value: "api" as const }
    : result.provider === undefined
      ? unavailable<BillingMode>("billing-mode-not-recorded")
      : !Array.isArray(result.childEnvKeys) || !result.childEnvKeys.every(key => typeof key === "string")
        ? unavailable<BillingMode>("billing-environment-not-recorded")
        : { state: "observed" as const, value: billingMode(result.childEnvKeys) };
  const tokenUsage: WorkerTokenUsageEvidence = result.tokenUsageState === "observed" || result.tokenUsageState === "partial"
    ? { state: result.tokenUsageState, value: structuredClone(result.tokens) }
    : result.tokenUsageState === "unavailable"
      ? { state: "unavailable", reason: "provider-reported-token-usage-unavailable" }
      : { state: "unavailable", reason: "token-usage-state-not-recorded" };
  const apiUsageRatedUsd = billing.state === "observed" && billing.value === "api"
    ? observedNumber(result.provider === "cash" ? result.usageEstimateUsd : result.sdkReportedUsageRatedUsd,
      result.provider === "cash" ? "usage-rating-not-reported" : "sdk-usage-rating-not-reported")
    : unavailable<number>(billing.state === "unavailable" ? billing.reason : "not-api-billing");
  const subscriptionNotionalUsd = billing.state === "observed" && billing.value === "subscription"
    ? observedNumber(result.provider === "claude" ? result.sdkReportedUsageRatedUsd : result.notionalCostUsd,
      result.provider === "claude" ? "sdk-usage-rating-not-reported" : "subscription-notional-not-reported")
    : unavailable<number>(billing.state === "unavailable" ? billing.reason : "not-subscription-billing");

  return {
    version: "worker-execution-evidence-v1",
    attemptId,
    unit: "worker-spawn",
    measurementScope: "returned-terminal-result",
    assignment: assigned,
    providerInvoked: result.notStarted === "admission-abandoned"
      ? { state: "observed", value: false }
      : unavailable("provider-invocation-not-individually-observed"),
    identity: {
      provider: result.provider === undefined ? unavailable("provider-not-recorded") : { state: "observed", value: result.provider },
      configuredModel: observedString(result.model, "configured-model-not-recorded"),
      routedModel: observedString(result.routedModel, "routed-model-not-recorded"),
      sdkRequestedModel: sdkRequest?.model ?? unavailable("sdk-model-option-not-observed"),
      sdkRequestedEffort: sdkRequest?.effort ?? unavailable("sdk-effort-option-not-observed"),
      servedModel: observedString(result.servedModel, result.servedModelReason ?? "served-model-not-recorded"),
    },
    execution: {
      terminal: result.notStarted === "admission-abandoned"
        ? unavailable("worker-not-started-after-admission-refusal")
        : result.usageRefusal || result.budgetRefused
        ? { state: "observed", value: "refused" }
        : typeof result.isError === "boolean"
        ? { state: "observed", value: result.isError ? "error" : "success" }
        : unavailable("terminal-status-not-recorded"),
      durationMs: observedNumber(result.workerDurationMs, "worker-duration-not-recorded"),
      firstTextMs: observedNumber(result.workerFirstTextMs,
        result.workerFirstTextReason ?? "first-text-timing-not-recorded"),
      tokenUsage,
      requestEfforts: Array.isArray(result.requestEfforts)
        ? { state: "observed", value: structuredClone(result.requestEfforts) }
        : unavailable("provider-request-efforts-not-recorded"),
      invocationCount: unavailable("provider-invocation-count-not-attempt-scoped"),
      fallbackCoverage: unavailable("fallback-attempts-not-joined-to-this-result"),
      peakRssBytes: unavailable("worker-result-does-not-report-process-peak"),
    },
    accounting: {
      billingMode: billing,
      apiUsageRatedUsd,
      subscriptionNotionalUsd,
      billedCashUsd: result.provider === "cash"
        ? observedNumber(result.billedUsd, "cash-billing-receipt-unavailable")
        : unavailable(result.provider === undefined ? "provider-not-recorded" : "not-cash-billing"),
      invoiceUsd: unavailable("worker-result-is-not-an-invoice"),
      cashBudget: {
        reservedUsd: result.provider === "cash"
          ? observedNumber(result.budgetReservedUsd, "cash-reservation-not-recorded")
          : unavailable(cashProviderUnavailableReason),
        settledUsd: result.provider === "cash"
          ? observedNumber(result.budgetSettledUsd, "cash-settlement-not-recorded")
          : unavailable(cashProviderUnavailableReason),
        heldUsd: result.provider === "cash"
          ? observedNumber(result.budgetHeldUsd, "cash-held-reservation-not-recorded")
          : unavailable(cashProviderUnavailableReason),
      },
    },
  };
}
