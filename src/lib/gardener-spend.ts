import { parseGardenerRuntime, readGardenerRuntime } from "./gardener-runtime.js";
import { fingerprintLedgerLine, openLedgerUnion } from "./ledger-union.js";
import { spendAmountUsd, spendRoleOf } from "./spend-rows.js";
import { GARDENER_ORIGIN_ENV, readGardenerOrigin, type GardenerOrigin } from "./worker-containment.js";
import { systemClock, type Clock } from "./clock.js";

export const GARDENER_SPEND_VERSION = "gardener-spend-v1";
/** BACKSTOP: optional evidence cannot consume the ordinary Analytics response budget. */
export const GARDENER_SPEND_MAX_BYTES = 64 * 1024;
/** BACKSTOP: matches the registered runtime inventory's maximum population. */
export const GARDENER_SPEND_MAX_GARDENS = 32;
/** BACKSTOP: at most 1 MiB of SHA-256 text; refuse when exact replay accounting cannot fit. */
const GARDENER_SPEND_MAX_IDENTITIES = 16384;
type RegistryReason = "missing_registry" | "invalid_registry" | "over_budget";
interface Receipt {
  identity: string; ts: string; step: string; name?: string; passId?: string;
  repository?: string; daemonRunId?: string; phase?: string; exit?: number;
  origin?: GardenerOrigin; cost?: number; runId?: string; taskId?: string;
}
interface PassCost {
  name: string; passId: string; parent: boolean; complete: boolean; interrupted: boolean;
  priced: number; unpriced: number; usd: number;
}
interface CompactCosts {
  version: 1; correlated: boolean; unlinked: number; passes: PassCost[];
  repository: string; daemonRunId: string; from: string; through: string;
}
export interface GardenerSpendSource {
  runtime?: unknown; reason?: RegistryReason | "ledger_unavailable";
  receipts?: Receipt[]; observedAt?: string; corpusComplete?: boolean;
  compact?: CompactCosts;
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

function costAccumulator(runtime: ReturnType<typeof parseGardenerRuntime>, observedAt: string) {
  const compact: CompactCosts = { version: 1, correlated: false, unlinked: 0, passes: [],
    repository: runtime.repository, daemonRunId: runtime.daemonRunId, from: runtime.configuredAt, through: observedAt };
  const passes = new Map<string, PassCost>();
  let bytes = 0;
  const from = Date.parse(runtime.configuredAt), through = Date.parse(observedAt);
  return { compact, get bytes() { return bytes; }, add(row: Receipt) {
    if (row.origin !== undefined) compact.correlated = true;
    const stamp = Date.parse(row.ts);
    if (!Number.isFinite(stamp) || stamp < from || stamp > through) return;
    const parent = row.step === "garden.lifecycle" || row.step === "garden.pass";
    const name = parent ? row.name : row.origin?.state === "linked" ? row.origin.name : undefined;
    const passId = parent ? row.passId : row.origin?.state === "linked" ? row.origin.passId : undefined;
    const scoped = parent ? row.repository === runtime.repository && row.daemonRunId === runtime.daemonRunId
      : (row.repository === undefined || row.repository === runtime.repository) &&
        (row.daemonRunId === undefined || row.daemonRunId === runtime.daemonRunId);
    if (!scoped || !name || !passId || !runtime.gardens.some(g => g.name === name)) {
      if (!parent) compact.unlinked++;
      return;
    }
    const key = JSON.stringify([name, passId]);
    let pass = passes.get(key);
    const before = pass ? Buffer.byteLength(JSON.stringify(pass)) : -1;
    if (!pass) {
      pass = { name, passId, parent: false, complete: false, interrupted: false, priced: 0, unpriced: 0, usd: 0 };
      passes.set(key, pass);
      compact.passes.push(pass);
    }
    if (parent) {
      pass.parent = true;
      pass.interrupted ||= ["failed", "cancelled"].includes(row.phase ?? "") || row.exit !== undefined && row.exit !== 0;
      pass.complete = !pass.interrupted && (pass.complete || row.phase === "completed" && row.exit === 0 ||
        row.step === "garden.pass" && row.exit === 0);
    } else if (row.cost === undefined || row.cost < 0) pass.unpriced++;
    else { pass.priced++; pass.usd += row.cost; }
    bytes += Buffer.byteLength(JSON.stringify(pass)) - before;
    if (!Number.isFinite(pass.usd)) bytes = Infinity;
  } };
}

function validateCompact(compact: CompactCosts): void {
  const count = (n: number) => Number.isSafeInteger(n) && n >= 0;
  const keys = new Set<string>();
  if (compact.version !== 1 || typeof compact.correlated !== "boolean" || !count(compact.unlinked) ||
    !Array.isArray(compact.passes)) throw new Error("malformed compact gardener costs");
  for (const pass of compact.passes) {
    const key = JSON.stringify([pass.name, pass.passId]);
    if (typeof pass.name !== "string" || typeof pass.passId !== "string" || !pass.passId ||
      pass.passId.length > 128 || keys.has(key) || typeof pass.parent !== "boolean" ||
      typeof pass.complete !== "boolean" || typeof pass.interrupted !== "boolean" ||
      pass.complete && (!pass.parent || pass.interrupted) || !count(pass.priced) || !count(pass.unpriced) ||
      !Number.isFinite(pass.usd) || pass.usd < 0) throw new Error("malformed compact gardener pass");
    keys.add(key);
  }
}

export async function captureGardenerSpendSource(stateDir: string, clock: Clock = systemClock): Promise<GardenerSpendSource> {
  let runtime: ReturnType<typeof parseGardenerRuntime>;
  try {
    runtime = await readGardenerRuntime(stateDir);
  } catch (error) {
    const missing = error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
    return { reason: missing ? "missing_registry" : error instanceof Error && /bound/.test(error.message)
      ? "over_budget" : "invalid_registry" };
  }
  const observedAt = clock.iso();
  const costs = costAccumulator(runtime, observedAt);
  const seen = new Set<string>();
  let complete = true, liveObserved = false, overflow = false;
  const small = (value: unknown): string | undefined => typeof value === "string" && value.length <= 128 ? value : undefined;
  // Keep canonical raw-line fingerprints, never raw lines or provider/config payloads (W1-T8484).
  const stream = openLedgerUnion(stateDir, { since: runtime.configuredAt, dedupe: false,
    onUnreadArchive: () => { complete = false; }, onUnreadLive: () => { complete = false; },
    onMalformedRow: () => { complete = false; }, onLiveRead: () => { liveObserved = true; },
    onAcceptedRecord: (row, raw) => {
      const parent = row.step === "garden.lifecycle" || row.step === "garden.pass";
      if (!parent && spendRoleOf(row) !== "produced") return;
      const identity = fingerprintLedgerLine(raw);
      if (seen.has(identity) || overflow) return;
      if (seen.size >= GARDENER_SPEND_MAX_IDENTITIES) { overflow = true; return; }
      if (!Number.isFinite(Date.parse(String(row.ts))) || Date.parse(String(row.ts)) > Date.parse(observedAt)) complete = false;
      const receipt: Receipt = { identity, ts: small(row.ts) ?? "", step: small(row.step) ?? "",
        repository: small(row.repository), daemonRunId: small(row.daemon_run_id),
        ...(parent ? { name: small(row.name), passId: small(row.passId), phase: small(row.phase),
          exit: typeof row.exit === "number" ? row.exit : undefined }
          : { origin: (row.repository !== undefined && small(row.repository) === undefined ||
              row.daemon_run_id !== undefined && small(row.daemon_run_id) === undefined)
              ? { state: "invalid", reason: "malformed" } : carrier(row.gardener_origin), cost: spendAmountUsd(row),
            runId: small(row.run_id), taskId: small(row.task_id) }) };
      seen.add(identity);
      costs.add(receipt);
      overflow = costs.bytes > GARDENER_SPEND_MAX_BYTES;
    } });
  for await (const row of stream) {
    void row;
    if (overflow) return { reason: "over_budget" };
  }
  const source = { runtime, compact: costs.compact, observedAt, corpusComplete: complete && liveObserved };
  return Buffer.byteLength(JSON.stringify(source)) > GARDENER_SPEND_MAX_BYTES ? { reason: "over_budget" } : source;
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
    let compact = source.compact;
    if (!compact && source.receipts) {
      const costs = costAccumulator(runtime, result.observedAt);
      const seen = new Set<string>();
      for (const row of source.receipts) {
        if (seen.has(row.identity)) continue;
        seen.add(row.identity);
        costs.add(row);
      }
      compact = costs.compact;
    }
    if (!compact) return result;
    validateCompact(compact);
    if (compact.repository !== repository || compact.daemonRunId !== runtime.daemonRunId ||
      compact.from !== runtime.configuredAt || compact.through !== result.observedAt) return unknown("scope_mismatch");
    if (!compact.correlated) {
      if (source.corpusComplete === false) return unknown("ledger_unavailable");
      return result;
    }
    const stats = new Map(runtime.gardens.map(g => [g.name,
      { priced: 0, unpriced: 0, usd: 0, passes: 0, complete: true }]));
    let unlinked = compact.unlinked;
    for (const pass of compact.passes) {
      const garden = runtime.gardens.find(g => g.name === pass.name);
      if (!garden || !pass.parent) { unlinked += pass.priced + pass.unpriced; continue; }
      if (garden.scope !== "repository" || pass.priced + pass.unpriced === 0) continue;
      const stat = stats.get(garden.name)!;
      stat.passes++; stat.complete &&= pass.complete;
      stat.priced += pass.priced; stat.unpriced += pass.unpriced; stat.usd += pass.usd;
    }
    let priced = 0, unpriced = 0, subtotal = 0;
    for (const garden of result.gardens) {
      if (garden.scope !== "repository") continue;
      const stat = stats.get(garden.name)!;
      const entry = runtime.gardens.find(g => g.name === garden.name)!;
      priced += stat.priced; unpriced += stat.unpriced; subtotal += stat.usd;
      garden.pricedSubtotalUsd = stat.priced > 0 ? stat.usd : null;
      const complete = source.corpusComplete === true && unlinked === 0 && stat.unpriced === 0 &&
        stat.priced > 0 && stat.passes === entry.attempts && entry.attempts === entry.completions && stat.complete;
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
