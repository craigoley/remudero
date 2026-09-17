/**
 * W1-T3729 — WHAT AZURE ACTUALLY BILLED, read from Azure rather than inferred from our own
 * reservations.
 *
 * INVARIANT: `openWeightCommittedUsd` charges `settledUsd ?? reservedUsd`, so a request that never
 * settles counts at its conservative CEILING for the rest of the UTC day, which can read as ~3x the
 * amount Azure actually billed. This module reads Azure Monitor's per-deployment token counters
 * (not Cost Management -- that reports dollars, lags hours, and is heavily throttled) via the
 * host's SystemAssigned managed identity over IMDS, so no secret is ever written to disk.
 *
 * TRAP: a refusal is not a zero. Returning `0` for "could not reach Azure" would authorise the
 * entire day's budget the moment the network blinked, so {@link CashActuals} forces callers to
 * handle "unavailable" separately from a real reading.
 *
 * Why: docs/forensics/cash-actuals.md (the $0.96 vs $2.68 measurement, the Cost Management
 * throttling numbers, and the IMDS/managed-identity rationale).
 *
 * FALSIFIER: test/the-cash-cap-can-read-what-azure-billed.test.ts. Citations: W1-T3729, W1-T3728.
 */
import type { Config } from "./config-schema.js";
import { OPENWEIGHT_PRICES } from "./worker-provider.js";

/** The Foundry account whose metrics are read. An ARM resource id, not a hostname: the endpoint in
 *  `workerProviders.cashEndpoint` is a DATA-plane URL and names no subscription or resource group,
 *  so it cannot be converted into one. Absent => this reading is simply unavailable, never guessed. */
export const CASH_METRICS_RESOURCE_ENV = "RMD_CASH_METRICS_RESOURCE_ID";

/** IMDS, the link-local address every Azure VM answers on. Not configurable: a redirectable metadata
 *  endpoint is a credential-theft primitive, and nothing legitimate needs to move it. */
export const IMDS_TOKEN_URL =
  "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://management.azure.com/";

/** PRIMARY CONTROL (W1-T1266). Bounds BOTH hops. A spend reading is advisory, so a slow metrics
 *  endpoint must never become a dispatch stall -- the caller degrades to "unavailable" instead. */
export const CASH_ACTUALS_TIMEOUT_MS = 15_000;

/**
 * A REFUSAL IS NOT A ZERO, and this type exists so a caller cannot read one as the other.
 *
 * The whole defect being corrected is a number that looked authoritative and was not. Returning
 * `0` for "could not reach Azure" would rebuild that defect on the other side: a cap comparing
 * against a fabricated zero would authorise the entire day's budget the moment the network blinked.
 */
export type CashActuals =
  | { kind: "read"; usd: number; byDeployment: Record<string, { inputTokens: number; outputTokens: number; usd: number }>; unpriced: readonly string[]; observedAtIso: string }
  | { kind: "unavailable"; reason: string };

/** UTC day bounds for a metrics `timespan`, from the SAME clock reading the allowance file uses --
 *  a cap that compares Azure's day against a differently-derived local day compares two things. */
export function utcDayTimespan(atIso: string): { from: string; to: string } {
  const day = atIso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`cash actuals: unreadable clock reading ${JSON.stringify(atIso)}`);
  return { from: `${day}T00:00:00Z`, to: `${day}T23:59:59Z` };
}

/**
 * Price Azure's OWN token counts with the table the adapter already bills against.
 *
 * A DEPLOYMENT WITH NO PRICE ROW IS NAMED, NEVER PRICED AT ZERO. Azure reports every deployment on
 * the account, including ones this fleet does not route to; silently costing those at $0 would make
 * the total read low exactly when someone else is spending on the same resource.
 */
export function priceTokenCounts(
  byDeployment: Record<string, { inputTokens: number; outputTokens: number }>,
): { usd: number; priced: Record<string, { inputTokens: number; outputTokens: number; usd: number }>; unpriced: string[] } {
  const priced: Record<string, { inputTokens: number; outputTokens: number; usd: number }> = {};
  const unpriced: string[] = [];
  let usd = 0;
  for (const [deployment, counts] of Object.entries(byDeployment)) {
    if (counts.inputTokens === 0 && counts.outputTokens === 0) continue;
    const price = OPENWEIGHT_PRICES[deployment];
    if (price === undefined) { unpriced.push(deployment); continue; }
    const cost =
      (counts.inputTokens * price.inputUsdPerMillion + counts.outputTokens * price.outputUsdPerMillion) / 1_000_000;
    priced[deployment] = { ...counts, usd: cost };
    usd += cost;
  }
  return { usd, priced, unpriced: unpriced.sort() };
}

/** The metrics response shape this reads, narrowed to what it uses. */
interface MetricsResponse {
  value?: Array<{
    name?: { value?: unknown };
    timeseries?: Array<{
      metadatavalues?: Array<{ value?: unknown }>;
      data?: Array<{ total?: unknown }>;
    }>;
  }>;
}

/** Fold one metrics payload into per-deployment totals. Exported so the parse is testable without
 *  a transport: the shape, not the network, is where this is most likely to be wrong. */
export function foldMetrics(payload: MetricsResponse): Record<string, { inputTokens: number; outputTokens: number }> {
  const out: Record<string, { inputTokens: number; outputTokens: number }> = {};
  for (const metric of payload.value ?? []) {
    const name = typeof metric.name?.value === "string" ? metric.name.value : "";
    const field = name === "InputTokens" ? "inputTokens" : name === "OutputTokens" ? "outputTokens" : undefined;
    if (field === undefined) continue;
    for (const series of metric.timeseries ?? []) {
      const deployment = series.metadatavalues?.[0]?.value;
      if (typeof deployment !== "string" || deployment === "") continue;
      const total = (series.data ?? []).reduce(
        (sum, point) => sum + (typeof point.total === "number" ? point.total : 0),
        0,
      );
      const row = out[deployment] ?? { inputTokens: 0, outputTokens: 0 };
      row[field] += total;
      out[deployment] = row;
    }
  }
  return out;
}

/** Build the ARM metrics URL for one resource and timespan. Separated so a test can assert the
 *  query without a network: a wrong `$filter` returns HTTP 200 with EMPTY series, which reads
 *  exactly like a quiet day (MEASURED 2026-09-17 -- an unfiltered call answered 0 while the
 *  resource really had traffic, and only a positive control over a known-busy day caught it). */
export function metricsUrl(resourceId: string, span: { from: string; to: string }): string {
  // BUILT WITH encodeURIComponent, NOT URLSearchParams, and that is not a style choice:
  // URLSearchParams encodes a space as `+`, and the only request shape MEASURED against the live
  // account (2026-09-17) used `%20`. `+`-as-space is a form-encoding convention rather than a URI
  // one, so whether ARM's $filter parser honours it is an assumption -- and an unhonoured filter
  // does not error, it returns HTTP 200 with empty series, which reads exactly like a quiet day.
  const q = [
    "api-version=2018-01-01",
    "metricnames=InputTokens,OutputTokens",
    `timespan=${encodeURIComponent(`${span.from}/${span.to}`)}`,
    "interval=P1D",
    "aggregation=Total",
    `$filter=${encodeURIComponent("ModelDeploymentName eq '*'")}`,
  ].join("&");
  return `https://management.azure.com${resourceId}/providers/microsoft.insights/metrics?${q}`;
}

export interface CashActualsDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  clock?: { iso: () => string };
  /** IMDS cache bypass. Azure caches a managed-identity token, and a token minted BEFORE a role
   *  grant keeps answering 403 long after the grant lands -- MEASURED 2026-09-17: a fresh
   *  Monitoring Reader assignment still 403'd for 15 minutes until the cache was bypassed, and the
   *  error body says so in words ("If access was recently granted, please refresh your
   *  credentials"). Left ON so a first run after a grant works rather than looking broken. */
  bypassTokenCache?: boolean;
}

/**
 * Read what Azure billed this UTC day for the cash deployments, in USD.
 *
 * NEVER THROWS. Every failure becomes `{ kind: "unavailable", reason }` so a caller can degrade --
 * see {@link CashActuals} for why a zero would be the more dangerous answer.
 */
export async function readCashActuals(config: Config, deps: CashActualsDeps = {}): Promise<CashActuals> {
  const env = deps.env ?? process.env;
  const clock = deps.clock ?? { iso: () => new Date().toISOString() };
  const doFetch = deps.fetchImpl ?? fetch;
  const resourceId = env[CASH_METRICS_RESOURCE_ENV];
  if (typeof resourceId !== "string" || resourceId.trim() === "") {
    return { kind: "unavailable", reason: `${CASH_METRICS_RESOURCE_ENV} is unset, so no Azure account is named to read` };
  }
  if (config.workerProviders === undefined) {
    return { kind: "unavailable", reason: "no workerProviders block, so nothing bills to cash" };
  }
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), CASH_ACTUALS_TIMEOUT_MS);
  try {
    const tokenUrl = deps.bypassTokenCache === false ? IMDS_TOKEN_URL : `${IMDS_TOKEN_URL}&bypass_cache=true`;
    const tokenRes = await doFetch(tokenUrl, { headers: { Metadata: "true" }, signal: abort.signal });
    if (!tokenRes.ok) return { kind: "unavailable", reason: `IMDS returned HTTP ${tokenRes.status}` };
    const token = (await tokenRes.json() as { access_token?: unknown }).access_token;
    if (typeof token !== "string" || token === "") return { kind: "unavailable", reason: "IMDS returned no access_token" };

    const res = await doFetch(metricsUrl(resourceId.trim(), utcDayTimespan(clock.iso())), {
      headers: { Authorization: `Bearer ${token}` },
      signal: abort.signal,
    });
    if (!res.ok) return { kind: "unavailable", reason: `Azure metrics returned HTTP ${res.status}` };
    const { usd, priced, unpriced } = priceTokenCounts(foldMetrics(await res.json() as MetricsResponse));
    return { kind: "read", usd, byDeployment: priced, unpriced, observedAtIso: clock.iso() };
  } catch (error) {
    const aborted = abort.signal.aborted;
    return {
      kind: "unavailable",
      reason: aborted
        ? `the reading did not complete within ${CASH_ACTUALS_TIMEOUT_MS}ms`
        : `the reading failed: ${String((error as Error)?.message ?? error)}`,
    };
  } finally {
    clearTimeout(deadline);
  }
}
