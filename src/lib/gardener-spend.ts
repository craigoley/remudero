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
type CallCounts = Record<"assignments" | "matched" | "missing" | "orphan" | "conflicting" | "invalid", number | null>;
type CallBilling = Record<"api" | "subscription" | "unknown", number | null>;
type CallPrices = Record<"reported" | "unreported", number | null>;
interface GardenCalls { name: string; counts: CallCounts; billingModes: CallBilling; priceCoverage: CallPrices }
export interface GardenerWorkerCalls {
  version: "gardener-worker-calls-v1";
  state: "not_collected" | "partial" | "complete";
  reason: "missing_capture" | "invalid_capture" | "scope_mismatch" | "over_budget" | "incomplete_evidence" | "observed";
  observedAt: string | null;
  window: { from: string; through: string } | null;
  counts: CallCounts; billingModes: CallBilling; priceCoverage: CallPrices; gardens: GardenCalls[];
}
interface CallSource { repository: string; daemonRunId: string; value: GardenerWorkerCalls }
export interface GardenerSpendSource {
  runtime?: unknown; reason?: RegistryReason | "ledger_unavailable";
  receipts?: Receipt[]; observedAt?: string; corpusComplete?: boolean;
  compact?: CompactCosts;
  workerCalls?: CallSource | "over_budget";
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
  /** Observed call coverage, never an additional monetary producer or invoice. */
  workerCalls?: GardenerWorkerCalls;
}

export function unavailableGardenerWorkerCalls(reason: GardenerWorkerCalls["reason"]): GardenerWorkerCalls {
  return { version: "gardener-worker-calls-v1", state: "not_collected", reason, observedAt: null, window: null,
    counts: { assignments: null, matched: null, missing: null, orphan: null, conflicting: null, invalid: null },
    billingModes: { api: null, subscription: null, unknown: null }, priceCoverage: { reported: null, unreported: null }, gardens: [] };
}

function callAccumulator(runtime: ReturnType<typeof parseGardenerRuntime>, observedAt: string) {
  type Evidence = { name?: string; passId?: string; valid: boolean; originInvalid: boolean; signature: string; billing: keyof CallBilling; priced: boolean };
  const entries = new Map<string, { assignment?: Evidence; attempt?: Evidence; conflict: boolean }>();
  const seen = new Set<string>();
  let overflow = false, invalid = 0;
  const small = (x: unknown): string | undefined => typeof x === "string" && x.length > 0 && x.length <= 128 ? x : undefined;
  const record = (x: unknown): Record<string, unknown> | undefined => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : undefined;
  const known = (name: unknown) => runtime.gardens.some(g => g.scope === "repository" && g.name === name);
  return {
    add(row: Record<string, unknown>, raw: string) {
      if (overflow) return;
      const identity = fingerprintLedgerLine(raw);
      if (seen.has(identity)) return;
      if (seen.size >= GARDENER_SPEND_MAX_IDENTITIES) { overflow = true; return; }
      seen.add(identity);
      const origin = carrier(row.gardener_origin);
      const attributed = origin?.state === "linked" && known(origin.name);
      const assignment = row.step === "worker.assignment";
      const envelope = record(row.worker_assignment), selected = record(envelope?.selected);
      const candidateId = small(assignment ? envelope?.id : row.selection_assignment_id);
      // Same bounded opaque-token dialect as worker.ts's immutable assignment trailer.
      const id = candidateId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidateId) ? candidateId : undefined;
      const stamp = Date.parse(String(row.ts));
      // Ordinary unrelated workers are not gardener orphans. Keep bounded id-only candidates
      // so a later attributed mate can still expose their missing identity, in either order.
      if (!id) { if (attributed || origin?.state === "invalid") invalid++; return; }
      const valid = attributed && Number.isFinite(stamp) && stamp >= Date.parse(runtime.configuredAt) && stamp <= Date.parse(observedAt) &&
        (row.repository === undefined || row.repository === runtime.repository) &&
        (row.daemon_run_id === undefined || row.daemon_run_id === runtime.daemonRunId) &&
        small(row.run_id) !== undefined && small(row.task_id) !== undefined && (assignment ? small(selected?.provider) !== undefined && small(selected?.model) !== undefined : row.assignment_observed !== false);
      const billing = row.billing_mode === "api" || row.billing_mode === "subscription" ? row.billing_mode : "unknown";
      const priced = Object.hasOwn(row, "total_cost_usd") && typeof row.total_cost_usd === "number" && Number.isFinite(row.total_cost_usd) && row.total_cost_usd >= 0;
      const name = attributed ? origin.name : undefined, passId = attributed ? origin.passId : undefined;
      const signature = JSON.stringify([name, passId, valid ? runtime.repository : small(row.repository), valid ? runtime.daemonRunId : small(row.daemon_run_id), small(row.run_id), small(row.task_id), valid,
        assignment ? [small(selected?.provider), small(selected?.model), small(selected?.effort)] : [billing, priced, priced ? row.total_cost_usd : null]]);
      const evidence: Evidence = { name, passId, valid, originInvalid: origin?.state === "invalid", signature, billing, priced };
      let entry = entries.get(id);
      if (!entry) { entry = { conflict: false }; entries.set(id, entry); }
      const key = assignment ? "assignment" : "attempt";
      if (entry[key] && entry[key].signature !== signature) {
        entry.conflict = true;
        // A conflicted id stays quarantined; deterministic retention avoids archive-order
        // dependent attribution without retaining an unbounded set of restatements.
        if (signature < entry[key].signature) entry[key] = evidence;
      } else entry[key] = evidence;
    },
    finish(hasParent: (name: string, passId: string) => boolean, corpusComplete: boolean): CallSource | "over_budget" {
      if (overflow) return "over_budget";
      const gardens: GardenCalls[] = runtime.gardens.filter(g => g.scope === "repository").map(g => ({ name: g.name,
        counts: { assignments: 0, matched: 0, missing: 0, orphan: 0, conflicting: 0, invalid: 0 },
        billingModes: { api: 0, subscription: 0, unknown: 0 }, priceCoverage: { reported: 0, unreported: 0 } }));
      const value: GardenerWorkerCalls = { version: "gardener-worker-calls-v1", state: "complete", reason: "observed", observedAt,
        window: { from: runtime.configuredAt, through: observedAt }, counts: { assignments: 0, matched: 0, missing: 0, orphan: 0, conflicting: 0, invalid },
        billingModes: { api: 0, subscription: 0, unknown: 0 }, priceCoverage: { reported: 0, unreported: 0 }, gardens };
      const bump = (garden: GardenCalls, key: keyof CallCounts) => { garden.counts[key]!++; value.counts[key]!++; };
      for (const { assignment: a, attempt: t, conflict } of entries.values()) {
        const assignmentGarden = gardens.find(g => g.name === a?.name), attemptGarden = gardens.find(g => g.name === t?.name);
        const garden = assignmentGarden ?? attemptGarden;
        if (!garden) { if (a?.originInvalid || t?.originInvalid) value.counts.invalid!++; continue; }
        const assigned = !!(assignmentGarden && a?.valid && a.passId && hasParent(assignmentGarden.name, a.passId));
        const attempted = !!(attemptGarden && t?.valid && t.passId && hasParent(attemptGarden.name, t.passId));
        if (assigned) bump(assignmentGarden!, "assignments");
        if (conflict) { bump(garden, "conflicting"); continue; }
        if (a && !a.valid || t && !t.valid) bump(garden, "invalid");
        // The origin and immutable id are necessary, not sufficient: a reused id under
        // another run/task, garden or parent pass must never manufacture a joined call.
        const aScope = a?.signature && JSON.parse(a.signature).slice(0, 6);
        const tScope = t?.signature && JSON.parse(t.signature).slice(0, 6);
        const same = assigned && attempted && JSON.stringify(aScope) === JSON.stringify(tScope);
        if (same) {
          bump(garden, "matched"); garden.billingModes[t!.billing]!++; value.billingModes[t!.billing]!++;
          const price = t!.priced ? "reported" : "unreported";
          garden.priceCoverage[price]!++; value.priceCoverage[price]!++;
        } else {
          if (assigned) bump(assignmentGarden!, "missing");
          if (attemptGarden) bump(attemptGarden, "orphan");
          if (a && t && assigned && attempted) bump(garden, "conflicting");
          if (a && !assigned && !t) bump(garden, "invalid");
        }
      }
      if (!corpusComplete || value.counts.missing || value.counts.orphan || value.counts.conflicting || value.counts.invalid) {
        value.state = "partial"; value.reason = "incomplete_evidence";
      }
      return { repository: runtime.repository, daemonRunId: runtime.daemonRunId, value };
    },
  };
}

function foldCalls(source: GardenerSpendSource["workerCalls"], runtime: ReturnType<typeof parseGardenerRuntime>, observedAt: string, corpusComplete: boolean): GardenerWorkerCalls {
  if (!source) return unavailableGardenerWorkerCalls("missing_capture");
  if (source === "over_budget") return unavailableGardenerWorkerCalls("over_budget");
  try {
    if (Buffer.byteLength(JSON.stringify(source)) > GARDENER_SPEND_MAX_BYTES) return unavailableGardenerWorkerCalls("over_budget");
    if (source.repository !== runtime.repository || source.daemonRunId !== runtime.daemonRunId ||
      source.value.window?.from !== runtime.configuredAt || source.value.window.through !== observedAt || source.value.observedAt !== observedAt) return unavailableGardenerWorkerCalls("scope_mismatch");
    const exact = (x: object, keys: string[]) => Object.keys(x).sort().join("|") === [...keys].sort().join("|");
    const value = source.value;
    const countKeys = ["assignments", "matched", "missing", "orphan", "conflicting", "invalid"];
    const validCounts = (x: object, keys: string[]) => exact(x, keys) && Object.values(x).every(n => Number.isSafeInteger(n) && n >= 0);
    const validGroup = (g: Pick<GardenCalls, "counts" | "billingModes" | "priceCoverage">) => validCounts(g.counts, countKeys) &&
      validCounts(g.billingModes, ["api", "subscription", "unknown"]) && validCounts(g.priceCoverage, ["reported", "unreported"]) &&
      g.counts.matched! <= g.counts.assignments! && g.counts.missing! <= g.counts.assignments! - g.counts.matched! &&
      g.counts.assignments! - g.counts.matched! - g.counts.missing! <= g.counts.conflicting! &&
      Object.values(g.billingModes).reduce<number>((sum, n) => sum + n!, 0) === g.counts.matched &&
      Object.values(g.priceCoverage).reduce<number>((sum, n) => sum + n!, 0) === g.counts.matched;
    if (value.version !== "gardener-worker-calls-v1" || !["complete", "partial"].includes(value.state) ||
      !exact(value, ["version", "state", "reason", "observedAt", "window", "counts", "billingModes", "priceCoverage", "gardens"]) ||
      !exact(value.window!, ["from", "through"]) || !validGroup(value) ||
      !Array.isArray(value.gardens) || value.gardens.length !== runtime.gardens.filter(g => g.scope === "repository").length ||
      value.gardens.length > GARDENER_SPEND_MAX_GARDENS || new Set(value.gardens.map(g => g.name)).size !== value.gardens.length ||
      value.gardens.some(g => !exact(g, ["name", "counts", "billingModes", "priceCoverage"]) || !runtime.gardens.some(r => r.name === g.name && r.scope === "repository") || !validGroup(g)) ||
      value.state === "complete" && (value.reason !== "observed" || ["missing", "orphan", "conflicting", "invalid"].some(k => value.counts[k as keyof CallCounts]! > 0)) ||
      value.state === "partial" && value.reason !== "incomplete_evidence") return unavailableGardenerWorkerCalls("invalid_capture");
    for (const key of countKeys) {
      const sum = value.gardens.reduce((n, g) => n + g.counts[key as keyof CallCounts]!, 0);
      if (key === "invalid" ? sum > value.counts.invalid! : sum !== value.counts[key as keyof CallCounts]) return unavailableGardenerWorkerCalls("invalid_capture");
    }
    for (const key of ["billingModes", "priceCoverage"] as const) for (const field of Object.keys(value[key])) {
      if (value.gardens.reduce((n, g) => n + (g[key] as Record<string, number>)[field]!, 0) !== (value[key] as Record<string, number>)[field]) return unavailableGardenerWorkerCalls("invalid_capture");
    }
    return corpusComplete ? value : { ...value, state: "partial", reason: "incomplete_evidence" };
  } catch {
    // Absence is missing_capture above; malformed optional evidence is invalid_capture,
    // never observed zero. Its failure must not erase independently valid money.
    return unavailableGardenerWorkerCalls("invalid_capture");
  }
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
  return { compact, get bytes() { return bytes; }, hasParent(name: string, passId: string) {
    return passes.get(JSON.stringify([name, passId]))?.parent === true;
  }, add(row: Receipt) {
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
    const before = pass && pass.priced + pass.unpriced > 0 ? Buffer.byteLength(JSON.stringify(pass)) : -1;
    if (!pass) {
      pass = { name, passId, parent: false, complete: false, interrupted: false, priced: 0, unpriced: 0, usd: 0 };
      passes.set(key, pass);
    }
    if (parent) {
      pass.parent = true;
      pass.interrupted ||= ["failed", "cancelled"].includes(row.phase ?? "") || row.exit !== undefined && row.exit !== 0;
      pass.complete = !pass.interrupted && (pass.complete || row.phase === "completed" && row.exit === 0 ||
        row.step === "garden.pass" && row.exit === 0);
    } else if (row.cost === undefined || row.cost < 0) pass.unpriced++;
    else { pass.priced++; pass.usd += row.cost; }
    // Retain parent state in the identity-bounded join index, but serialize only cost-bearing
    // passes. Idle/deferred/cancelled parent-only history is not provider cost payload. A later
    // producer (or a later parent) still joins the same exact pass; absent prices remain unknown.
    if (pass.priced + pass.unpriced > 0) {
      if (before < 0) compact.passes.push(pass);
      bytes += Buffer.byteLength(JSON.stringify(pass)) - before;
    }
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

export async function captureGardenerSpendSource(stateDir: string, clock: Clock = systemClock,
  opts: { signal?: AbortSignal; repository?: string } = {}): Promise<GardenerSpendSource> {
  opts.signal?.throwIfAborted();
  let runtime: ReturnType<typeof parseGardenerRuntime>;
  try {
    runtime = await readGardenerRuntime(stateDir);
  } catch (error) {
    opts.signal?.throwIfAborted();
    const missing = error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
    return { reason: missing ? "missing_registry" : error instanceof Error && /bound/.test(error.message)
      ? "over_budget" : "invalid_registry" };
  }
  const observedAt = clock.iso();
  if (opts.repository !== undefined && runtime.repository !== opts.repository ||
    Date.parse(runtime.configuredAt) > Date.parse(observedAt) || Date.parse(runtime.observedAt) > Date.parse(observedAt)) {
    return { reason: "invalid_registry" };
  }
  const cutoff = Date.parse(observedAt);
  const costs = costAccumulator(runtime, observedAt);
  const calls = callAccumulator(runtime, observedAt);
  const seen = new Set<string>();
  let complete = true, liveObserved = false, overflow = false;
  const small = (value: unknown): string | undefined => typeof value === "string" && value.length <= 128 ? value : undefined;
  // Keep canonical raw-line fingerprints, never raw lines or provider/config payloads (W1-T8484).
  const stream = openLedgerUnion(stateDir, { since: runtime.configuredAt, dedupe: false, signal: opts.signal,
    onUnreadArchive: () => { complete = false; }, onUnreadLive: () => { complete = false; },
    onUnreadDirectory: () => { complete = false; },
    onMalformedRow: () => { complete = false; }, onLiveRead: () => { liveObserved = true; },
    onAcceptedRecord: (row, raw) => {
      const callRow = row.step === "worker.assignment" || row.step === "worker.attempt";
      const parent = row.step === "garden.lifecycle" || row.step === "garden.pass";
      if (!callRow && !parent && spendRoleOf(row) !== "produced") return;
      // The declared window is fixed at its cutoff. An ordinary row appended after it but no later
      // than this separately observed read clock belongs to a LATER window: it contributes neither
      // money nor call coverage and cannot invalidate the earlier one. A stamp beyond the read
      // clock is a genuinely future record and falls through to the existing refusals.
      const stamp = Date.parse(String(row.ts));
      if (stamp > cutoff && stamp <= clock.now()) return;
      if (callRow) calls.add(row, raw);
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
    opts.signal?.throwIfAborted();
    if (overflow) return { reason: "over_budget" };
  }
  opts.signal?.throwIfAborted();
  // Counters may advance during collection; identity, generation and enabled inventory may not.
  // Re-read the real registry, rather than certifying a generation that was replaced or revoked.
  const identity = (value: typeof runtime) => JSON.stringify([value.repository, value.daemonRunId,
    value.configuredAt, value.codeSha, value.gardens.map(g => [g.name, g.enabled, g.scope]).sort()]);
  try {
    if (identity(await readGardenerRuntime(stateDir)) !== identity(runtime)) return { reason: "invalid_registry" };
  } catch {
    opts.signal?.throwIfAborted();
    return { reason: "invalid_registry" };
  }
  opts.signal?.throwIfAborted();
  const source: GardenerSpendSource = { runtime, compact: costs.compact, observedAt, corpusComplete: complete && liveObserved,
    workerCalls: calls.finish(costs.hasParent, complete && liveObserved) };
  // Usage has its own bounded index and may never crowd independently valid money out.
  if (Buffer.byteLength(JSON.stringify(source)) > GARDENER_SPEND_MAX_BYTES) source.workerCalls = "over_budget";
  // At the exact old source ceiling even a failure tag may not fit. Omission means
  // unavailable capture (never zero) and preserves the original monetary source.
  if (Buffer.byteLength(JSON.stringify(source)) > GARDENER_SPEND_MAX_BYTES) delete source.workerCalls;
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
    const { workerCalls, ...moneySource } = source;
    const raw = source.runtime as { gardens?: unknown[] } | null | undefined;
    if (Buffer.byteLength(JSON.stringify(moneySource)) > GARDENER_SPEND_MAX_BYTES ||
      (Array.isArray(raw?.gardens) && raw.gardens.length > GARDENER_SPEND_MAX_GARDENS)) return unknown("over_budget");
    const runtime = parseGardenerRuntime(source.runtime);
    if (!repository || runtime.repository !== repository) return unknown("scope_mismatch");
    const result = unknown("correlation_not_available");
    result.observedAt = source.observedAt ?? runtime.observedAt;
    // A registry-only legacy source already says correlation_not_available. Preserve its
    // exact old payload; optional omission is unknown, never an observed zero-call capture.
    if (workerCalls !== undefined || source.compact || source.receipts) {
      result.workerCalls = foldCalls(workerCalls, runtime, result.observedAt, source.corpusComplete === true);
    }
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
      if (source.corpusComplete === false) return { ...unknown("ledger_unavailable"), workerCalls: result.workerCalls };
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
