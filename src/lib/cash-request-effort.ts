export type CashRequestTransport = "chat-completions" | "responses" | "foundry-messages";

/** The parameter passed to fetch, never a claim about the provider's internal effort. */
export interface CashRequestEffort {
  provenance: "adapter-fetch-call";
  transport: CashRequestTransport;
  parameter: "reasoning_effort" | "reasoning.effort" | "output_config.effort";
  state: "parameter-present" | "parameter-omitted" | "parameter-unreadable";
  value: string | null;
  providerEffectiveEffort: null;
}

export interface CashRequestEffortCount extends CashRequestEffort { requests: number }

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Read only the bounded effort scalar from the serialized request. No prompt or credential escapes. */
export function cashRequestEffort(body: string, transport: CashRequestTransport): CashRequestEffort {
  const parameter = transport === "chat-completions" ? "reasoning_effort"
    : transport === "responses" ? "reasoning.effort" : "output_config.effort";
  const result = (state: CashRequestEffort["state"], value: string | null = null): CashRequestEffort =>
    ({ provenance: "adapter-fetch-call", transport, parameter, state, value, providerEffectiveEffort: null });
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch { return result("parameter-unreadable"); }
  if (!object(parsed)) return result("parameter-unreadable");
  let value: unknown;
  if (transport === "chat-completions") {
    if (!Object.hasOwn(parsed, "reasoning_effort")) return result("parameter-omitted");
    value = parsed.reasoning_effort;
  } else {
    const parent = transport === "responses" ? "reasoning" : "output_config";
    if (!Object.hasOwn(parsed, parent)) return result("parameter-omitted");
    const nested = parsed[parent];
    if (!object(nested)) return result("parameter-unreadable");
    if (!Object.hasOwn(nested, "effort")) return result("parameter-omitted");
    value = nested.effort;
  }
  return typeof value === "string" && EFFORTS.has(value)
    ? result("parameter-present", value) : result("parameter-unreadable");
}

/** At most 27 known transport/state/value tuples, even during a long tool conversation. */
export function recordCashRequestEffort(entries: CashRequestEffortCount[], body: string, transport: CashRequestTransport): void {
  const observed = cashRequestEffort(body, transport);
  const existing = entries.find(entry => entry.transport === observed.transport
    && entry.state === observed.state && entry.value === observed.value);
  if (existing) existing.requests++;
  else entries.push({ ...observed, requests: 1 });
}

export type CashRequestEffortEvidence =
  | { state: "observed"; entries: CashRequestEffortCount[] }
  | { state: "unavailable"; reason: "missing" | "invalid" | "conflicting" };

/** Validate persisted counts independently of the adapter; never retain arbitrary ledger fields. */
export function readCashRequestEfforts(value: unknown): CashRequestEffortEvidence {
  if (value === undefined) return { state: "unavailable", reason: "missing" };
  if (!Array.isArray(value) || value.length > 27) return { state: "unavailable", reason: "invalid" };
  const entries: CashRequestEffortCount[] = [];
  const keys = new Set<string>();
  let total = 0;
  for (const row of value) {
    if (!object(row) || row.provenance !== "adapter-fetch-call" || row.providerEffectiveEffort !== null
      || typeof row.transport !== "string" || !["chat-completions", "responses", "foundry-messages"].includes(row.transport)
      || !Number.isSafeInteger(row.requests) || (row.requests as number) <= 0)
      return { state: "unavailable", reason: "invalid" };
    const transport = row.transport as CashRequestTransport;
    const parameter = transport === "chat-completions" ? "reasoning_effort"
      : transport === "responses" ? "reasoning.effort" : "output_config.effort";
    if (row.parameter !== parameter
      || (row.state === "parameter-present"
        ? typeof row.value !== "string" || !EFFORTS.has(row.value)
        : typeof row.state !== "string" || !["parameter-omitted", "parameter-unreadable"].includes(row.state) || row.value !== null))
      return { state: "unavailable", reason: "invalid" };
    const key = `${transport}:${row.state}:${row.value}`;
    total += row.requests as number;
    if (keys.has(key) || !Number.isSafeInteger(total)) return { state: "unavailable", reason: "invalid" };
    keys.add(key);
    entries.push({ provenance: "adapter-fetch-call", transport, parameter,
      state: row.state as CashRequestEffort["state"], value: row.value as string | null,
      providerEffectiveEffort: null, requests: row.requests as number });
  }
  entries.sort((a, b) => `${a.transport}:${a.state}:${a.value}`.localeCompare(`${b.transport}:${b.state}:${b.value}`));
  return { state: "observed", entries };
}

/** Repeated attempt/verdict snapshots count once; incompatible receipts stay unavailable. */
export function mergeCashRequestEfforts(prior: CashRequestEffortEvidence | undefined, value: unknown): CashRequestEffortEvidence {
  const next = readCashRequestEfforts(value);
  return prior === undefined || JSON.stringify(prior) === JSON.stringify(next)
    ? next : { state: "unavailable", reason: "conflicting" };
}

export function summarizeCashRequestEfforts(receipts: (CashRequestEffortEvidence | undefined)[]) {
  const observed = receipts.filter((receipt): receipt is Extract<CashRequestEffortEvidence, { state: "observed" }> => receipt?.state === "observed");
  const counts = { attemptedRequests: 0, parameterPresentRequests: 0, parameterOmittedRequests: 0, parameterUnreadableRequests: 0 };
  const parameters: CashRequestEffortCount[] = [];
  for (const receipt of observed) {
    for (const entry of receipt.entries) {
      counts.attemptedRequests += entry.requests;
      if (entry.state === "parameter-present") counts.parameterPresentRequests += entry.requests;
      else if (entry.state === "parameter-omitted") counts.parameterOmittedRequests += entry.requests;
      else counts.parameterUnreadableRequests += entry.requests;
      const prior = parameters.find(row => row.transport === entry.transport && row.state === entry.state && row.value === entry.value);
      if (prior) prior.requests += entry.requests;
      else parameters.push({ ...entry });
    }
  }
  const overflow = !Object.values(counts).every(Number.isSafeInteger);
  const unavailable = overflow || observed.length === 0;
  return {
    state: unavailable ? "unavailable" : observed.length === receipts.length ? "observed" : "partial",
    assignments: receipts.length,
    reportedAssignments: observed.length,
    missingAssignments: receipts.filter(receipt => receipt === undefined || (receipt.state === "unavailable" && receipt.reason === "missing")).length,
    invalidAssignments: receipts.filter(receipt => receipt?.state === "unavailable" && receipt.reason === "invalid").length,
    conflictingAssignments: receipts.filter(receipt => receipt?.state === "unavailable" && receipt.reason === "conflicting").length,
    noRequestAssignments: observed.filter(receipt => receipt.entries.length === 0).length,
    attemptedRequests: unavailable ? null : counts.attemptedRequests,
    parameterPresentRequests: unavailable ? null : counts.parameterPresentRequests,
    parameterOmittedRequests: unavailable ? null : counts.parameterOmittedRequests,
    parameterUnreadableRequests: unavailable ? null : counts.parameterUnreadableRequests,
    parameters: unavailable ? null : parameters,
    countsOverflow: overflow,
    providerEffectiveEffort: null,
  };
}
