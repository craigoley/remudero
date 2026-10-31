/** W1-T10954: unknown cash stays reserved; a receipt settles only its exact attempt once. */
export interface CashRequestIdentity {
  requestId: string;
  attemptId: string;
  provider: "cash";
  deployment: string;
  endpoint: string;
}

export interface CashReservation {
  reservedUsd: number;
  settledUsd: number | null;
  settledReason?: string;
  heldReason?: string;
  deployment?: string;
  identity?: CashRequestIdentity;
  accountingState?: "held-unknown" | "usage-rated" | "known-unbilled";
  usageEstimateUsd?: number | null;
  billedUsd?: number | null;
  heldUsd?: number;
}

export interface CashAccountingEvidence {
  identity?: CashRequestIdentity;
  actualUsd?: number;
  reason?: string;
  unbilled?: boolean;
}

export function cashEndpointIdentity(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.origin}${url.pathname}`;
}

export function validCashIdentity(value: unknown): value is CashRequestIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as CashRequestIdentity;
  return identity.provider === "cash" && [identity.requestId, identity.attemptId, identity.deployment, identity.endpoint]
    .every(part => typeof part === "string" && part.length > 0);
}

export function cashIdentityMatches(a: CashRequestIdentity, b: CashRequestIdentity | undefined): boolean {
  return validCashIdentity(b) && a.requestId === b.requestId && a.attemptId === b.attemptId &&
    a.provider === b.provider && a.deployment === b.deployment && a.endpoint === b.endpoint;
}

export function recordCashAccounting(row: CashReservation, evidence: CashAccountingEvidence): CashReservation {
  if (row.settledUsd !== null || !row.identity || !cashIdentityMatches(row.identity, evidence.identity)) return row;
  if (evidence.actualUsd !== undefined && (!Number.isFinite(evidence.actualUsd) || evidence.actualUsd < 0)) return row;
  if (evidence.unbilled && evidence.actualUsd !== 0) return row;
  const settledUsd = evidence.actualUsd === undefined ? null : Math.min(evidence.actualUsd, row.reservedUsd);
  return { ...row, settledUsd,
    accountingState: settledUsd === null ? "held-unknown" : evidence.unbilled ? "known-unbilled" : "usage-rated",
    usageEstimateUsd: settledUsd === null || evidence.unbilled ? null : settledUsd,
    billedUsd: evidence.unbilled ? 0 : null,
    heldUsd: settledUsd === null ? row.reservedUsd : 0,
    ...(evidence.reason === undefined ? {} : settledUsd === null ? { heldReason: evidence.reason } : { settledReason: evidence.reason }),
  };
}
