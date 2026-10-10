import { createHash } from "node:crypto";

type Row = Record<string, unknown>;
export interface RoutingQuarantineResolution {
  sourceLabel: string;
  rowHash: string;
  kind: "future-timestamp";
  scope: "routing-trials";
  disposition: "irrelevant-cli-invocation";
  reason: "historical-test-clock";
  resolvedAt: string;
}

/** Exact private receipts can qualify one trial input without clearing the raw source warning. */
export function readRoutingQuarantineResolutions(input: unknown, asOf: string, labels: string[]): Map<string, RoutingQuarantineResolution> {
  const result = new Map<string, RoutingQuarantineResolution>();
  if (input === undefined) return result;
  const value = input as Row;
  if (!value || value.version !== "routing-quarantine-resolutions-v1" || !Array.isArray(value.entries)
      || value.entries.length > 200 || !Number.isFinite(Date.parse(asOf))) {
    throw new Error("routing quarantine resolution manifest is invalid");
  }
  for (const entry of value.entries) {
    const row = entry as RoutingQuarantineResolution;
    if (!row || !labels.includes(row.sourceLabel) || !/^[a-f0-9]{64}$/.test(row.rowHash)
        || row.kind !== "future-timestamp" || row.scope !== "routing-trials"
        || row.disposition !== "irrelevant-cli-invocation" || row.reason !== "historical-test-clock"
        || !Number.isFinite(Date.parse(row.resolvedAt)) || Date.parse(row.resolvedAt) > Date.parse(asOf)) {
      throw new Error("routing quarantine resolution entry is invalid");
    }
    const key = `${row.sourceLabel}:${row.rowHash}`;
    if (result.has(key)) throw new Error("routing quarantine resolution identity is repeated");
    result.set(key, row);
  }
  return result;
}

/** CLI rows with any assignment, outcome or billing payload cannot earn this narrow disposition. */
export function resolveRoutingQuarantineRow(
  resolutions: Map<string, RoutingQuarantineResolution>, sourceLabel: string, row: Row, raw: string, asOf: string,
): RoutingQuarantineResolution | undefined {
  if (row.step !== "cli.invoked" || typeof row.ts !== "string"
      || !Number.isFinite(Date.parse(row.ts)) || Date.parse(row.ts) <= Date.parse(asOf) + 5 * 60_000
      || ["selection_assignment_id", "worker_assignment", "tokens", "total_cost_usd", "cost_usd",
        "notional_cost_usd", "billing_mode", "success", "served_model"].some(key => Object.hasOwn(row, key))) return undefined;
  return resolutions.get(`${sourceLabel}:${createHash("sha256").update(raw).digest("hex")}`);
}
