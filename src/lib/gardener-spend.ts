import { parseGardenerRuntime, readGardenerRuntime } from "./gardener-runtime.js";
import { fingerprintLedgerLine, openLedgerUnion } from "./ledger-union.js";
import { spendAmountUsd, spendRoleOf } from "./spend-rows.js";
import { GARDENER_ORIGIN_ENV, readGardenerOrigin, type GardenerOrigin } from "./worker-containment.js";

export const GARDENER_SPEND_VERSION = "gardener-spend-v1";
/** BACKSTOP: optional evidence cannot consume the ordinary Analytics response budget. */
export const GARDENER_SPEND_MAX_BYTES = 64 * 1024;
/** BACKSTOP: matches the registered runtime inventory's maximum population. */
export const GARDENER_SPEND_MAX_GARDENS = 32;
type RegistryReason = "missing_registry" | "invalid_registry" | "over_budget";
interface Receipt {
  identity: string; ts: string; step: string; name?: string; passId?: string;
  repository?: string; daemonRunId?: string; phase?: string; exit?: number;
  origin?: GardenerOrigin; cost?: number; runId?: string; taskId?: string;
}
export interface GardenerSpendSource {
  runtime?: unknown; reason?: RegistryReason | "ledger_unavailable";
  receipts?: Receipt[]; observedAt?: string; corpusComplete?: boolean;
}
export interface GardenerSpend {
  version: typeof GARDENER_SPEND_VERSION;
  state: "not_collected" | "partial" | "complete";
  reason: RegistryReason | "missing_materialization" | "scope_mismatch" | "correlation_not_available" |
    "ledger_unavailable" | "incomplete_evidence" | "priced_receipts";
  observedAt: string | null;
  materializedAt: string | null;
  totalUsd: number | null;
  pricedSubtotalUsd: number | null;
  counts: { priced: number | null; unpriced: number | null; unlinked: number | null };
  window: { from: string; through: string } | null;
  coverage: { retainedCorpus: "not_collected" | "partial" | "complete"; truncated: boolean | null };
  gardens: Array<{ name: string; enabled: boolean; scope: "repository" | "host" | "fleet";
    totalUsd: number | null; pricedSubtotalUsd: number | null }>;
}

function carrier(raw: unknown): GardenerOrigin | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { state: "invalid", reason: "malformed" };
  const value = raw as Record<string, unknown>;
  if (value.state !== "linked" || Object.keys(value).length !== 4) return { state: "invalid", reason: "malformed" };
  return readGardenerOrigin({ [GARDENER_ORIGIN_ENV]: JSON.stringify({ version: value.version, name: value.name, passId: value.passId }) });
}

export async function captureGardenerSpendSource(stateDir: string): Promise<GardenerSpendSource> {
  let runtime: ReturnType<typeof parseGardenerRuntime>;
  try {
    runtime = await readGardenerRuntime(stateDir);
  } catch (error) {
    const missing = error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
    return { reason: missing ? "missing_registry" : error instanceof Error && /bound/.test(error.message)
      ? "over_budget" : "invalid_registry" };
  }
  const observedAt = new Date().toISOString();
  const receipts: Receipt[] = [];
  const seen = new Set<string>();
  let complete = true, liveObserved = false, bytes = Buffer.byteLength(JSON.stringify(runtime));
  const small = (value: unknown): string | undefined => typeof value === "string" && value.length <= 128 ? value : undefined;
  // Keep canonical raw-line fingerprints, never raw lines or provider/config payloads (W1-T8484).
  const stream = openLedgerUnion(stateDir, { since: runtime.configuredAt, dedupe: false,
    onUnreadArchive: () => { complete = false; }, onUnreadLive: () => { complete = false; },
    onMalformedRow: () => { complete = false; }, onLiveRead: () => { liveObserved = true; },
    onAcceptedRecord: (row, raw) => {
      const parent = row.step === "garden.lifecycle" || row.step === "garden.pass";
      if (!parent && spendRoleOf(row) !== "produced") return;
      const identity = fingerprintLedgerLine(raw);
      if (seen.has(identity) || bytes > GARDENER_SPEND_MAX_BYTES) return;
      if (!Number.isFinite(Date.parse(String(row.ts))) || Date.parse(String(row.ts)) > Date.parse(observedAt)) complete = false;
      const receipt: Receipt = { identity, ts: small(row.ts) ?? "", step: small(row.step) ?? "",
        repository: small(row.repository), daemonRunId: small(row.daemon_run_id),
        ...(parent ? { name: small(row.name), passId: small(row.passId), phase: small(row.phase),
          exit: typeof row.exit === "number" ? row.exit : undefined }
          : { origin: (row.repository !== undefined && small(row.repository) === undefined ||
              row.daemon_run_id !== undefined && small(row.daemon_run_id) === undefined)
              ? { state: "invalid", reason: "malformed" } : carrier(row.gardener_origin), cost: spendAmountUsd(row),
            runId: small(row.run_id), taskId: small(row.task_id) }) };
      bytes += Buffer.byteLength(JSON.stringify(receipt));
      seen.add(identity);
      receipts.push(receipt);
    } });
  for await (const row of stream) {
    void row;
    if (bytes > GARDENER_SPEND_MAX_BYTES) return { reason: "over_budget" };
  }
  return { runtime, receipts, observedAt, corpusComplete: complete && liveObserved };
}

export function foldGardenerSpend(source: GardenerSpendSource | undefined, repository: string | undefined,
  materializedAt: string | null): GardenerSpend {
  const unknown = (reason: GardenerSpend["reason"]): GardenerSpend => ({ version: GARDENER_SPEND_VERSION,
    state: "not_collected", reason, observedAt: null, materializedAt, totalUsd: null, pricedSubtotalUsd: null,
    counts: { priced: null, unpriced: null, unlinked: null }, window: null,
    coverage: { retainedCorpus: "not_collected", truncated: reason === "over_budget" ? true : null }, gardens: [] });
  if (!source) return unknown("missing_materialization");
  if (source.reason !== undefined) return unknown(source.reason);
  try {
    const raw = source.runtime as { gardens?: unknown[] } | null | undefined;
    if (Buffer.byteLength(JSON.stringify(source)) > GARDENER_SPEND_MAX_BYTES ||
      (Array.isArray(raw?.gardens) && raw.gardens.length > GARDENER_SPEND_MAX_GARDENS)) return unknown("over_budget");
    const runtime = parseGardenerRuntime(source.runtime);
    if (!repository || runtime.repository !== repository) return unknown("scope_mismatch");
    const result = unknown("correlation_not_available");
    result.observedAt = source.observedAt ?? runtime.observedAt;
    result.gardens = runtime.gardens.map(({ name, enabled, scope }) => ({ name, enabled, scope,
      totalUsd: null, pricedSubtotalUsd: null }));
    if (!source.receipts) return result;
    if (!source.receipts.some(row => row.origin !== undefined)) {
      if (source.corpusComplete === false) return unknown("ledger_unavailable");
      return result;
    }
    const from = Date.parse(runtime.configuredAt), through = Date.parse(result.observedAt);
    const seen = new Set<string>();
    const rows = source.receipts.filter(row => {
      const stamp = Date.parse(row.ts);
      if (seen.has(row.identity)) return false;
      seen.add(row.identity);
      return Number.isFinite(stamp) && stamp >= from && stamp <= through;
    });
    const parents = new Map<string, { complete: boolean; interrupted: boolean }>();
    for (const row of rows) {
      if ((row.step !== "garden.lifecycle" && row.step !== "garden.pass") ||
        row.repository !== repository || row.daemonRunId !== runtime.daemonRunId || !row.name || !row.passId) continue;
      const key = JSON.stringify([row.name, row.passId]);
      const previous = parents.get(key);
      const terminal = row.phase === "completed" && row.exit === 0 || row.step === "garden.pass" && row.exit === 0;
      const interrupted = ["failed", "cancelled"].includes(row.phase ?? "") || row.exit !== undefined && row.exit !== 0;
      const broken = interrupted || previous?.interrupted === true;
      parents.set(key, { complete: !broken && (terminal || previous?.complete === true), interrupted: broken });
    }
    const stats = new Map(runtime.gardens.map(g => [g.name, { priced: 0, unpriced: 0, usd: 0, passes: new Set<string>() }]));
    let unlinked = 0;
    for (const row of rows) {
      if (row.step === "garden.lifecycle" || row.step === "garden.pass") continue;
      const origin = row.origin;
      const garden = origin?.state === "linked" ? runtime.gardens.find(g => g.name === origin.name) : undefined;
      const parent = origin?.state === "linked" ? parents.get(JSON.stringify([origin.name, origin.passId])) : undefined;
      if (!garden || !parent || row.repository !== undefined && row.repository !== repository ||
        row.daemonRunId !== undefined && row.daemonRunId !== runtime.daemonRunId) { unlinked++; continue; }
      if (garden.scope !== "repository") continue;
      const stat = stats.get(garden.name)!;
      if (origin?.state === "linked") stat.passes.add(origin.passId);
      if (row.cost === undefined || row.cost < 0) stat.unpriced++;
      else { stat.priced++; stat.usd += row.cost; }
    }
    let priced = 0, unpriced = 0, subtotal = 0;
    for (const garden of result.gardens) {
      if (garden.scope !== "repository") continue;
      const stat = stats.get(garden.name)!;
      const entry = runtime.gardens.find(g => g.name === garden.name)!;
      priced += stat.priced; unpriced += stat.unpriced; subtotal += stat.usd;
      garden.pricedSubtotalUsd = stat.priced > 0 ? stat.usd : null;
      const complete = source.corpusComplete === true && unlinked === 0 && stat.unpriced === 0 &&
        stat.priced > 0 && stat.passes.size === entry.attempts && entry.attempts === entry.completions &&
        [...stat.passes].every(id => parents.get(JSON.stringify([garden.name, id]))?.complete === true);
      garden.totalUsd = complete ? stat.usd : null;
    }
    const repositoryGardens = result.gardens.filter(g => g.scope === "repository");
    const complete = repositoryGardens.length > 0 && repositoryGardens.every(g => g.totalUsd !== null);
    result.state = complete ? "complete" : "partial";
    result.reason = complete ? "priced_receipts" : "incomplete_evidence";
    result.totalUsd = complete ? subtotal : null;
    result.pricedSubtotalUsd = priced > 0 ? subtotal : null;
    result.counts = { priced, unpriced, unlinked };
    result.window = { from: runtime.configuredAt, through: result.observedAt };
    result.coverage = { retainedCorpus: source.corpusComplete === true ? "complete" : "partial", truncated: false };
    return Number.isFinite(subtotal) ? result : unknown("over_budget");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return unknown("invalid_registry");
  }
}
