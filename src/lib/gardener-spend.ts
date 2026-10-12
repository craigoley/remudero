import { parseGardenerRuntime, readGardenerRuntime } from "./gardener-runtime.js";

export const GARDENER_SPEND_VERSION = "gardener-spend-v1";
/** BACKSTOP: optional evidence cannot consume the ordinary Analytics response budget. */
export const GARDENER_SPEND_MAX_BYTES = 64 * 1024;
/** BACKSTOP: matches the registered runtime inventory's maximum population. */
export const GARDENER_SPEND_MAX_GARDENS = 32;
type RegistryReason = "missing_registry" | "invalid_registry" | "over_budget";
export interface GardenerSpendSource { runtime?: unknown; reason?: RegistryReason }
export interface GardenerSpend {
  version: typeof GARDENER_SPEND_VERSION;
  state: "not_collected";
  reason: RegistryReason | "missing_materialization" | "scope_mismatch" | "correlation_not_available";
  observedAt: string | null;
  materializedAt: string | null;
  totalUsd: null;
  pricedSubtotalUsd: null;
  counts: { priced: null; unpriced: null; unlinked: null };
  window: null;
  coverage: { retainedCorpus: "not_collected"; truncated: null };
  gardens: Array<{ name: string; enabled: boolean; scope: "repository" | "host" | "fleet";
    totalUsd: null; pricedSubtotalUsd: null }>;
}

export async function captureGardenerSpendSource(stateDir: string): Promise<GardenerSpendSource> {
  try {
    return { runtime: await readGardenerRuntime(stateDir) };
  } catch (error) {
    const missing = error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
    return { reason: missing ? "missing_registry" : error instanceof Error && /bound/.test(error.message)
      ? "over_budget" : "invalid_registry" };
  }
}

export function foldGardenerSpend(source: GardenerSpendSource | undefined, repository: string | undefined,
  materializedAt: string | null): GardenerSpend {
  const unknown = (reason: GardenerSpend["reason"]): GardenerSpend => ({ version: GARDENER_SPEND_VERSION,
    state: "not_collected", reason, observedAt: null, materializedAt, totalUsd: null, pricedSubtotalUsd: null,
    counts: { priced: null, unpriced: null, unlinked: null }, window: null,
    coverage: { retainedCorpus: "not_collected", truncated: null }, gardens: [] });
  if (!source) return unknown("missing_materialization");
  if (source.reason !== undefined) return unknown(["missing_registry", "invalid_registry", "over_budget"].includes(source.reason)
    ? source.reason : "invalid_registry");
  try {
    const raw = source.runtime as { gardens?: unknown[] } | null | undefined;
    if (Buffer.byteLength(JSON.stringify(source.runtime) ?? "") > GARDENER_SPEND_MAX_BYTES ||
      (Array.isArray(raw?.gardens) && raw.gardens.length > GARDENER_SPEND_MAX_GARDENS)) return unknown("over_budget");
    const runtime = parseGardenerRuntime(source.runtime);
    if (!repository || runtime.repository !== repository) return unknown("scope_mismatch");
    // W1-T8484: no versioned child carrier is installed. Runtime attempts cannot price historical work.
    const result = unknown("correlation_not_available");
    result.observedAt = runtime.observedAt;
    result.gardens = runtime.gardens.map(({ name, enabled, scope }) => ({ name, enabled, scope,
      totalUsd: null, pricedSubtotalUsd: null }));
    return result;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return unknown("invalid_registry");
  }
}
