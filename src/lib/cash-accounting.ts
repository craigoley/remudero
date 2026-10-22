/** Cash usage prices and conservative holds are separate from an invoice receipt. */
export interface CashAccountingEvidence {
  version: 1;
  state: "complete" | "held";
  usagePricedUsd: number;
  heldUsd: number;
  usagePricedRequests: number;
  heldRequests: number;
  noChargeRequests: number;
  invoiceCashUsd: null;
}

export function cashAccountingEvidence(): CashAccountingEvidence {
  return { version: 1, state: "complete", usagePricedUsd: 0, heldUsd: 0,
    usagePricedRequests: 0, heldRequests: 0, noChargeRequests: 0, invoiceCashUsd: null };
}

/** A missing, fractional or invalid count cannot be a reported zero. */
export function cashTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export interface CashUsageTuple {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Read normalized Chat/Responses usage without completing a partial tuple. */
export function cashUsageTuple(value: unknown, requiresCacheRead: boolean, requiresCacheCreation: boolean): CashUsageTuple | undefined {
  if (!object(value) || !cashTokenCount(value.prompt_tokens) || !cashTokenCount(value.completion_tokens)) return undefined;
  const details = value.prompt_tokens_details;
  if (details !== undefined && !object(details)) return undefined;
  const nested = object(details) ? details.cached_tokens : undefined;
  const direct = value.cached_tokens;
  if ((direct !== undefined && !cashTokenCount(direct)) || (nested !== undefined && !cashTokenCount(nested))) return undefined;
  if (nested !== undefined && direct !== undefined && nested !== direct) return undefined;
  const cached = direct ?? nested;
  const written = value.cache_creation_tokens;
  if ((cached !== undefined && !cashTokenCount(cached)) || (written !== undefined && !cashTokenCount(written))
    || (requiresCacheRead && !cashTokenCount(cached)) || (requiresCacheCreation && !cashTokenCount(written))) return undefined;
  const cacheRead = cached === undefined ? 0 : cached as number;
  const cacheCreation = written === undefined ? 0 : written as number;
  if (cacheRead + cacheCreation > value.prompt_tokens) return undefined;
  return { input: value.prompt_tokens, output: value.completion_tokens, cacheRead, cacheCreation };
}

/** Anthropic's cache counts are additional input categories; both must be explicit. */
export function foundryUsageTuple(value: unknown): CashUsageTuple | undefined {
  if (!object(value) || !cashTokenCount(value.input_tokens) || !cashTokenCount(value.output_tokens)
    || !cashTokenCount(value.cache_read_input_tokens) || !cashTokenCount(value.cache_creation_input_tokens)) return undefined;
  return { input: value.input_tokens, output: value.output_tokens,
    cacheRead: value.cache_read_input_tokens, cacheCreation: value.cache_creation_input_tokens };
}

/** The adapter calls this once for each reservation's final accounting decision. */
export function recordCashAccounting(evidence: CashAccountingEvidence, state: "usage-priced" | "held" | "no-charge", usd: number): void {
  if (!Number.isFinite(usd) || usd < 0 || (state === "no-charge" && usd !== 0)) throw new Error("invalid cash accounting amount");
  const total = evidence.usagePricedRequests + evidence.heldRequests + evidence.noChargeRequests + 1;
  if (!Number.isSafeInteger(total) || !Number.isFinite(evidence.usagePricedUsd + evidence.heldUsd + usd))
    throw new Error("cash accounting aggregate overflow");
  if (state === "held") {
    evidence.state = "held";
    evidence.heldUsd += usd;
    evidence.heldRequests++;
  } else if (state === "usage-priced") {
    evidence.usagePricedUsd += usd;
    evidence.usagePricedRequests++;
  } else {
    evidence.noChargeRequests++;
  }
}

export type CashAccountingObservation =
  | { state: "observed"; evidence: CashAccountingEvidence }
  | { state: "unavailable"; reason: "missing" | "invalid" | "conflicting" };

/** Persisted evidence is validated independently; a legacy cost scalar is insufficient. */
export function readCashAccounting(value: unknown): CashAccountingObservation {
  if (value === undefined) return { state: "unavailable", reason: "missing" };
  if (!object(value) || value.version !== 1 || (value.state !== "complete" && value.state !== "held")
    || value.invoiceCashUsd !== null || ![value.usagePricedUsd, value.heldUsd].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)
    || ![value.usagePricedRequests, value.heldRequests, value.noChargeRequests].every(cashTokenCount)
    || !Number.isSafeInteger((value.usagePricedRequests as number) + (value.heldRequests as number) + (value.noChargeRequests as number))
    || !Number.isFinite((value.usagePricedUsd as number) + (value.heldUsd as number))
    || (value.state === "held") !== ((value.heldRequests as number) > 0)
    || (value.heldRequests === 0 && value.heldUsd !== 0)
    || (value.usagePricedRequests === 0 && value.usagePricedUsd !== 0)) return { state: "unavailable", reason: "invalid" };
  return { state: "observed", evidence: { version: 1, state: value.state as CashAccountingEvidence["state"],
    usagePricedUsd: value.usagePricedUsd as number, heldUsd: value.heldUsd as number,
    usagePricedRequests: value.usagePricedRequests as number, heldRequests: value.heldRequests as number,
    noChargeRequests: value.noChargeRequests as number, invoiceCashUsd: null } };
}

/** Missing repeats do not erase a receipt; conflicting/invalid evidence remains unavailable in either order. */
export function mergeCashAccounting(prior: CashAccountingObservation | undefined, value: unknown): CashAccountingObservation {
  const next = readCashAccounting(value);
  if (prior === undefined || (prior.state === "unavailable" && prior.reason === "missing")) return next;
  if (next.state === "unavailable" && next.reason === "missing") return prior;
  if ((prior.state === "unavailable" && prior.reason === "invalid") || (next.state === "unavailable" && next.reason === "invalid"))
    return { state: "unavailable", reason: "invalid" };
  if (prior.state === "unavailable") return prior;
  if (next.state === "unavailable") return next;
  return JSON.stringify(prior.evidence) === JSON.stringify(next.evidence) ? prior : { state: "unavailable", reason: "conflicting" };
}

/** Totals cover qualified observations only; missing rows do not contribute invented zeroes. */
export function summarizeCashAccounting(values: (CashAccountingObservation | undefined)[]) {
  const known = values.filter((value): value is Extract<CashAccountingObservation, { state: "observed" }> => value?.state === "observed");
  const usagePricedUsd = known.reduce((sum, value) => sum + value.evidence.usagePricedUsd, 0);
  const heldUsd = known.reduce((sum, value) => sum + value.evidence.heldUsd, 0);
  const readable = known.length > 0 && Number.isFinite(usagePricedUsd) && Number.isFinite(heldUsd);
  return { state: !readable ? "unavailable" : known.length < values.length ? "partial" : "observed",
    assignments: values.length, reportedAssignments: known.length,
    heldAssignments: known.filter(value => value.evidence.state === "held").length,
    missingAssignments: values.filter(value => value === undefined || (value.state === "unavailable" && value.reason === "missing")).length,
    invalidAssignments: values.filter(value => value?.state === "unavailable" && value.reason === "invalid").length,
    conflictingAssignments: values.filter(value => value?.state === "unavailable" && value.reason === "conflicting").length,
    usagePricedUsd: readable ? usagePricedUsd : null, heldUsd: readable ? heldUsd : null,
    invoiceCashUsd: null, basis: "qualified-usage-prices-and-held-allowance" };
}
