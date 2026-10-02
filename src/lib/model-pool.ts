/**
 * W1-T3958: BENCHMARK-READY ROUTING POOLS (`routing-pool-v1`).
 *
 * A pool is one task class plus capability tier, a set of provider/model/effort candidates with
 * their benchmark provenance and aggregates, and one fixed reviewed baseline. Selection admits only
 * `ready` candidates whose evidence is comparable, fresh, joined, complete, within budget and
 * capable, and it is a pure function of its inputs. Anything else falls back to the baseline or
 * refuses by name. A missing number stays `null`; it is never read as zero.
 *
 * This layers over class policy (W1-T167/W1-T250), probe evidence (W1-T3576) and assignment
 * telemetry (W1-T3762) and replaces none of them. Writing a pool, or promoting a candidate into
 * it, is reviewed work. A benchmark run never does it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seedOf } from "./knowledge-value.js";

export const ROUTING_POOL_VERSION = "routing-pool-v1" as const;
export const ROUTING_POOL_READINESS_STATES = ["benchmarking", "ready", "failed", "unavailable"] as const;
export type RoutingPoolReadiness = (typeof ROUTING_POOL_READINESS_STATES)[number];

/** PRIMARY CONTROL: evidence older than this is stale. It stays visible and is never admitted. */
export const ROUTING_POOL_MAX_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60_000;

export interface RoutingPoolCorpus {
  id: string;
  version: string;
}

/** Benchmark aggregates. `null` means not measured, and an unmeasured value is never imputed. */
export interface RoutingPoolAggregates {
  samples: number;
  /** Samples whose assignment joined a terminal outcome. Fewer than `samples` means unjoined evidence. */
  joinedSamples: number;
  successRate: number | null;
  quality: number | null;
  costUsdPerTask: number | null;
  latencyMsP50: number | null;
}

export interface RoutingPoolCandidate {
  id: string;
  provider: string;
  model: string;
  effort: string;
  adapter: string;
  toolProfile: string;
  corpus: RoutingPoolCorpus | null;
  lastProbeAt: string | null;
  /** The review that promoted this candidate. A `ready` candidate without one is not admitted. */
  promotedBy: string | null;
  capabilities: string[];
  aggregates: RoutingPoolAggregates;
  readiness: RoutingPoolReadiness;
}

export interface RoutingPoolBaseline {
  provider: string;
  model: string;
  effort: string;
  reviewedBy: string;
}

export interface RoutingPoolRecord {
  taskClass: string;
  capabilityTier: string;
  corpus: RoutingPoolCorpus;
  baseline: RoutingPoolBaseline;
  candidates: RoutingPoolCandidate[];
}

export interface RoutingPoolSnapshot {
  version: typeof ROUTING_POOL_VERSION;
  state: "observed" | "unavailable";
  reason?: string;
  revision: string | null;
  generatedAt: string | null;
  pools: RoutingPoolRecord[];
}

export type RoutingPoolIneligibleReason =
  | `not-ready:${Exclude<RoutingPoolReadiness, "ready">}`
  | "not-promoted"
  | "corpus-incomparable"
  | "stale-evidence"
  | "unjoined-evidence"
  | "evidence-missing"
  | "over-budget"
  | "capability-missing";

export interface RoutingPoolCandidateAssessment {
  id: string;
  provider: string;
  model: string;
  effort: string;
  readiness: RoutingPoolReadiness;
  corpus: RoutingPoolCorpus | null;
  lastProbeAt: string | null;
  quality: number | null;
  costUsdPerTask: number | null;
  eligible: boolean;
  reason?: RoutingPoolIneligibleReason;
}

export interface RoutingPoolRoute {
  candidateId?: string;
  provider: string;
  model: string;
  effort: string;
}

export interface RoutingPoolPin extends RoutingPoolRoute {
  poolRevision: string;
}

export interface RoutingPoolRequest {
  sessionId: string;
  taskClass: string;
  capabilityTier: string;
  budgetUsd: number;
  requiredCapabilities: readonly string[];
  nowMs: number;
  /** The assignment id that joins this decision to its terminal receipt. */
  terminalJoinKey: string;
  maxEvidenceAgeMs?: number;
  /** The route this session already holds. It stays unless a declared refusal moves it. */
  pinned?: RoutingPoolPin;
  /** A declared capacity or safety refusal. This is the only thing that moves a session. */
  refusal?: { kind: "capacity" | "safety"; detail: string };
}

/** The route receipt. Each field is written whatever the outcome, so a reader sees the whole decision. */
export interface RoutingPoolDecision {
  version: typeof ROUTING_POOL_VERSION;
  sessionId: string;
  taskClass: string;
  capabilityTier: string;
  poolRevision: string | null;
  pinnedFromRevision?: string;
  outcome: "pool" | "pinned" | "baseline" | "refused";
  reason: string;
  candidates: RoutingPoolCandidateAssessment[];
  chosen: RoutingPoolRoute | null;
  fallback: { used: boolean; baseline: RoutingPoolBaseline | null };
  terminalJoinKey: string;
  evidence: { quality: number | "unavailable"; costUsdPerTask: number | "unavailable" };
}

export function unavailableRoutingPool(reason: string): RoutingPoolSnapshot {
  return { version: ROUTING_POOL_VERSION, state: "unavailable", reason, revision: null, generatedAt: null, pools: [] };
}

/** The committed pool file. Only a review writes it. */
export function routingPoolPath(root: string): string {
  return join(root, ".remudero", "routing-pool.json");
}

/** Read the committed pool. If the file is absent or malformed, the result is an unavailable snapshot and nothing throws. */
export function readRoutingPoolSnapshot(root: string): RoutingPoolSnapshot {
  let text: string;
  try {
    text = readFileSync(routingPoolPath(root), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === "ENOENT" ? "routing-pool-not-configured" : `routing-pool-unreadable:${code ?? "unknown"}`;
    return unavailableRoutingPool(reason);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof SyntaxError ? "routing-pool-malformed" : "routing-pool-unparseable";
    return unavailableRoutingPool(reason);
  }
  return parseRoutingPoolSnapshot(raw);
}

class PoolShapeError extends Error {}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PoolShapeError(`${where} is not an object`);
  return value as Record<string, unknown>;
}

function label(value: unknown, where: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:#/@+-]{1,128}$/.test(value)) throw new PoolShapeError(`${where} is not a label`);
  return value;
}

function nullableLabel(value: unknown, where: string): string | null {
  return value === null || value === undefined ? null : label(value, where);
}

function instant(value: unknown, where: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new PoolShapeError(`${where} is not a timestamp`);
  return value;
}

function measured(value: unknown, where: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new PoolShapeError(`${where} is not a measurement`);
  return value;
}

function count(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new PoolShapeError(`${where} is not a count`);
  return value;
}

function corpus(value: unknown, where: string): RoutingPoolCorpus {
  const raw = record(value, where);
  return { id: label(raw.id, `${where}.id`), version: label(raw.version, `${where}.version`) };
}

function parseCandidate(value: unknown, where: string): RoutingPoolCandidate {
  const raw = record(value, where);
  const readiness = raw.readiness;
  if (!ROUTING_POOL_READINESS_STATES.includes(readiness as RoutingPoolReadiness)) {
    throw new PoolShapeError(`${where}.readiness is not one of ${ROUTING_POOL_READINESS_STATES.join("|")}`);
  }
  const aggregates = record(raw.aggregates ?? {}, `${where}.aggregates`);
  const capabilities = raw.capabilities ?? [];
  if (!Array.isArray(capabilities)) throw new PoolShapeError(`${where}.capabilities is not a list`);
  return {
    id: label(raw.id, `${where}.id`),
    provider: label(raw.provider, `${where}.provider`),
    model: label(raw.model, `${where}.model`),
    effort: label(raw.effort, `${where}.effort`),
    adapter: label(raw.adapter, `${where}.adapter`),
    toolProfile: label(raw.toolProfile, `${where}.toolProfile`),
    corpus: raw.corpus === null || raw.corpus === undefined ? null : corpus(raw.corpus, `${where}.corpus`),
    lastProbeAt: instant(raw.lastProbeAt, `${where}.lastProbeAt`),
    promotedBy: nullableLabel(raw.promotedBy, `${where}.promotedBy`),
    capabilities: capabilities.map((entry, index) => label(entry, `${where}.capabilities[${index}]`)),
    aggregates: {
      samples: count(aggregates.samples ?? 0, `${where}.aggregates.samples`),
      joinedSamples: count(aggregates.joinedSamples ?? 0, `${where}.aggregates.joinedSamples`),
      successRate: measured(aggregates.successRate, `${where}.aggregates.successRate`),
      quality: measured(aggregates.quality, `${where}.aggregates.quality`),
      costUsdPerTask: measured(aggregates.costUsdPerTask, `${where}.aggregates.costUsdPerTask`),
      latencyMsP50: measured(aggregates.latencyMsP50, `${where}.aggregates.latencyMsP50`),
    },
    readiness: readiness as RoutingPoolReadiness,
  };
}

function parsePool(value: unknown, where: string): RoutingPoolRecord {
  const raw = record(value, where);
  const baseline = record(raw.baseline, `${where}.baseline`);
  if (!Array.isArray(raw.candidates)) throw new PoolShapeError(`${where}.candidates is not a list`);
  return {
    taskClass: label(raw.taskClass, `${where}.taskClass`),
    capabilityTier: label(raw.capabilityTier, `${where}.capabilityTier`),
    corpus: corpus(raw.corpus, `${where}.corpus`),
    baseline: {
      provider: label(baseline.provider, `${where}.baseline.provider`),
      model: label(baseline.model, `${where}.baseline.model`),
      effort: label(baseline.effort, `${where}.baseline.effort`),
      reviewedBy: label(baseline.reviewedBy, `${where}.baseline.reviewedBy`),
    },
    candidates: raw.candidates.map((entry, index) => parseCandidate(entry, `${where}.candidates[${index}]`)),
  };
}

/** Validate a raw pool document. A shape error yields an unavailable snapshot with a reason; nothing is coerced. */
export function parseRoutingPoolSnapshot(value: unknown): RoutingPoolSnapshot {
  try {
    const raw = record(value, "pool");
    if (raw.version !== ROUTING_POOL_VERSION) return unavailableRoutingPool(`routing-pool-version-unsupported:${String(raw.version)}`);
    if (!Array.isArray(raw.pools)) throw new PoolShapeError("pool.pools is not a list");
    return {
      version: ROUTING_POOL_VERSION,
      state: "observed",
      revision: label(raw.revision, "pool.revision"),
      generatedAt: instant(raw.generatedAt, "pool.generatedAt"),
      pools: raw.pools.map((entry, index) => parsePool(entry, `pool.pools[${index}]`)),
    };
  } catch (error) {
    if (error instanceof PoolShapeError) return unavailableRoutingPool(`routing-pool-invalid: ${error.message}`);
    throw error;
  }
}

function fresh(at: string | null, nowMs: number, maxAgeMs: number): boolean {
  if (at === null) return false;
  const age = nowMs - Date.parse(at);
  return age >= 0 && age <= maxAgeMs;
}

/** Apply each admission gate in order. The first failing gate names the reason. */
export function assessPoolCandidates(
  pool: RoutingPoolRecord,
  gate: { budgetUsd: number; requiredCapabilities: readonly string[]; nowMs: number; maxEvidenceAgeMs?: number },
): RoutingPoolCandidateAssessment[] {
  const maxAgeMs = gate.maxEvidenceAgeMs ?? ROUTING_POOL_MAX_EVIDENCE_AGE_MS;
  return pool.candidates.map((candidate) => {
    const { aggregates } = candidate;
    const reason: RoutingPoolIneligibleReason | undefined = candidate.readiness !== "ready"
      ? `not-ready:${candidate.readiness}`
      : candidate.promotedBy === null
        ? "not-promoted"
        : candidate.corpus === null || candidate.corpus.id !== pool.corpus.id || candidate.corpus.version !== pool.corpus.version
          ? "corpus-incomparable"
          : !fresh(candidate.lastProbeAt, gate.nowMs, maxAgeMs)
            ? "stale-evidence"
            : aggregates.samples === 0 || aggregates.joinedSamples < aggregates.samples
              ? "unjoined-evidence"
              : aggregates.quality === null || aggregates.costUsdPerTask === null || aggregates.successRate === null
                ? "evidence-missing"
                : aggregates.costUsdPerTask > gate.budgetUsd
                  ? "over-budget"
                  : !gate.requiredCapabilities.every((capability) => candidate.capabilities.includes(capability))
                    ? "capability-missing"
                    : undefined;
    return {
      id: candidate.id,
      provider: candidate.provider,
      model: candidate.model,
      effort: candidate.effort,
      readiness: candidate.readiness,
      corpus: candidate.corpus,
      lastProbeAt: candidate.lastProbeAt,
      quality: aggregates.quality,
      costUsdPerTask: aggregates.costUsdPerTask,
      eligible: reason === undefined,
      ...(reason ? { reason } : {}),
    };
  });
}

const NO_EVIDENCE = { quality: "unavailable", costUsdPerTask: "unavailable" } as const;

function evidenceOf(entry: RoutingPoolCandidateAssessment | undefined): RoutingPoolDecision["evidence"] {
  if (!entry || entry.quality === null || entry.costUsdPerTask === null) return { ...NO_EVIDENCE };
  return { quality: entry.quality, costUsdPerTask: entry.costUsdPerTask };
}

function routeOf(entry: RoutingPoolCandidateAssessment): RoutingPoolRoute {
  return { candidateId: entry.id, provider: entry.provider, model: entry.model, effort: entry.effort };
}

function isBaseline(route: RoutingPoolRoute, baseline: RoutingPoolBaseline): boolean {
  return route.candidateId === undefined && route.provider === baseline.provider &&
    route.model === baseline.model && route.effort === baseline.effort;
}

/**
 * Choose a route for one session from a pool snapshot. The result depends only on the arguments.
 * Ready, admitted candidates are ranked by quality (higher first) and then cost (lower first). An
 * exact tie goes to a hash keyed on the session and candidate id, so the input order never matters.
 */
export function selectFromRoutingPool(snapshot: RoutingPoolSnapshot, request: RoutingPoolRequest): RoutingPoolDecision {
  const base = {
    version: ROUTING_POOL_VERSION,
    sessionId: request.sessionId,
    taskClass: request.taskClass,
    capabilityTier: request.capabilityTier,
    poolRevision: snapshot.revision,
    terminalJoinKey: request.terminalJoinKey,
    ...(request.pinned ? { pinnedFromRevision: request.pinned.poolRevision } : {}),
  };
  const refuse = (reason: string, candidates: RoutingPoolCandidateAssessment[] = [], baseline: RoutingPoolBaseline | null = null): RoutingPoolDecision => ({
    ...base, outcome: "refused", reason, candidates, chosen: null,
    fallback: { used: baseline !== null, baseline }, evidence: { ...NO_EVIDENCE },
  });
  if (snapshot.state !== "observed") return refuse(`pool-unavailable:${snapshot.reason ?? "unknown"}`);
  const pool = snapshot.pools.find((entry) => entry.taskClass === request.taskClass && entry.capabilityTier === request.capabilityTier);
  if (!pool) return refuse("no-pool-for-class");

  const candidates = assessPoolCandidates(pool, request);
  const toBaseline = (reason: string): RoutingPoolDecision => ({
    ...base, outcome: "baseline", reason, candidates,
    chosen: { provider: pool.baseline.provider, model: pool.baseline.model, effort: pool.baseline.effort },
    fallback: { used: true, baseline: pool.baseline }, evidence: { ...NO_EVIDENCE },
  });
  const pinned = request.pinned;
  if (request.refusal) {
    if (pinned && isBaseline(pinned, pool.baseline)) return refuse(`baseline-refused:${request.refusal.kind}`, candidates, pool.baseline);
    return toBaseline(`refusal:${request.refusal.kind}`);
  }
  if (pinned) {
    const held = pinned.candidateId === undefined ? undefined : candidates.find((entry) => entry.id === pinned.candidateId);
    if (pinned.candidateId !== undefined && (held === undefined || !held.eligible)) return toBaseline(`pin-ineligible:${held?.reason ?? "candidate-removed"}`);
    const { poolRevision: _revision, ...route } = pinned;
    return { ...base, outcome: "pinned", reason: "session-pinned", candidates, chosen: route,
      fallback: { used: false, baseline: pool.baseline }, evidence: evidenceOf(held) };
  }
  if (!fresh(snapshot.generatedAt, request.nowMs, request.maxEvidenceAgeMs ?? ROUTING_POOL_MAX_EVIDENCE_AGE_MS)) {
    return toBaseline("pool-stale");
  }
  const tieBreak = (entry: RoutingPoolCandidateAssessment) => seedOf(`${request.sessionId}\u0000${entry.id}`);
  const ranked = candidates.filter((entry) => entry.eligible).sort((a, b) =>
    b.quality! - a.quality! || a.costUsdPerTask! - b.costUsdPerTask! || tieBreak(a) - tieBreak(b) || a.id.localeCompare(b.id));
  const best = ranked[0];
  if (!best) return toBaseline("no-ready-candidate");
  return { ...base, outcome: "pool", reason: "ready-candidate", candidates, chosen: routeOf(best),
    fallback: { used: false, baseline: pool.baseline }, evidence: evidenceOf(best) };
}

/** The read projection for a candidate: its record plus whether it can be admitted without a request-specific budget or capability gate. */
export interface RoutingPoolProjectionCandidate extends RoutingPoolCandidate {
  admissible: boolean;
  reason?: RoutingPoolIneligibleReason;
}

export interface RoutingPoolProjection extends Omit<RoutingPoolSnapshot, "pools"> {
  asOf: string;
  stale: boolean;
  pools: Array<Omit<RoutingPoolRecord, "candidates"> & { readyCandidates: number; candidates: RoutingPoolProjectionCandidate[] }>;
}

/** Shape a snapshot for the console. Every candidate is shown, including ones that cannot be admitted, and each carries its reason. */
export function buildRoutingPoolProjection(snapshot: RoutingPoolSnapshot, nowMs: number): RoutingPoolProjection {
  const { pools, ...head } = snapshot;
  const gate = { budgetUsd: Number.POSITIVE_INFINITY, requiredCapabilities: [], nowMs };
  return {
    ...head,
    asOf: new Date(nowMs).toISOString(),
    stale: snapshot.state === "observed" && !fresh(snapshot.generatedAt, nowMs, ROUTING_POOL_MAX_EVIDENCE_AGE_MS),
    pools: pools.map((pool) => {
      const assessed = assessPoolCandidates(pool, gate);
      const candidates = pool.candidates.map((candidate, index) => ({
        ...candidate,
        admissible: assessed[index].eligible,
        ...(assessed[index].reason ? { reason: assessed[index].reason } : {}),
      }));
      return { ...pool, readyCandidates: candidates.filter((entry) => entry.admissible).length, candidates };
    }),
  };
}
