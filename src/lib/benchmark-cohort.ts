import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { systemClock } from "./clock.js";
import { fingerprintLedgerLine, ledgerLivePath, ledgerRotationEntries, openLedgerUnion } from "./ledger-union.js";

export const BENCHMARK_COHORT_VERSION = "benchmark-cohort-v1" as const;

type Form = "gzip" | "plain" | "live";
type EvidenceRow = { fingerprint: string; bytes: number; row: Record<string, unknown> };
type SourceRecord = {
  name: string;
  form: Form;
  size: number;
  mtimeMs: number;
  sha256: string;
  rows: EvidenceRow[];
};
type SourceFault = { name: string; form: Form; size: number; mtimeMs: number; reason: string };
type Checkpoint = {
  version: typeof BENCHMARK_COHORT_VERSION;
  sources: SourceRecord[];
  sourceFaults?: SourceFault[];
  baselineSources?: SourceRecord[];
  lastGood?: BenchmarkCohortSnapshot;
};

export interface BenchmarkCohort {
  dimensions: { day: string | null; taskClass: string | null; provider: string | null; model: string | null; harnessRevision: string | null };
  assignments: number;
  joinedAttempts: number;
  joinedTerminals: number;
  workerCallSuccess: number;
  workerCallFailure: number;
  servedModelObserved: number;
  apiCostUsd: number;
  subscriptionNotionalUsd: number;
}

export interface CohortFieldCoverage {
  denominator: number;
  observed: number;
  noAttempt: number;
  notRecorded: number;
}

type CoverageField = "taskClass" | "selectedModel" | "harnessRevision" | "workerCall" | "servedModel" | "billingMode" | "cost";

export interface BenchmarkCohortSnapshot {
  version: typeof BENCHMARK_COHORT_VERSION;
  state: "observed" | "unavailable";
  reason?: string;
  asOf: string | null;
  lastGoodAt?: string;
  sourceLineage: { name: string; form: Form; sha256: string; bytes: number }[];
  /** The live file can grow after this audited, newline-terminated byte prefix. */
  liveWatermark?: { prefixBytes: number; tailPendingBytes: number };
  sourceRows: { assignments: number; attempts: number; terminals: number; unmatchedAttempts: number;
    unmatchedTerminals: number; invalidAssignmentRows: number; attemptRowsWithoutAssignmentId: number;
    terminalRowsWithoutAssignmentId: number; conflictingAssignments: number; duplicateRows: number };
  cohorts: BenchmarkCohort[];
  coverage: Record<CoverageField, CohortFieldCoverage>;
  verifiedTaskOutcome: "unavailable-no-github-verification-join";
  experimentEffect: "unavailable-no-randomized-allocation";
  pressure: {
    sourceBytes: number; auditedSourceBytes: number; derivedBytes: number; snapshotGrowthBytes: number | null;
    sourceToDerivedRatio: number | null; evidenceBytesByDay: { day: string; bytes: number }[];
    eventsPerAssignment: number | null; eventsPerRun: number | null; runsWithId: number;
    dimensionCardinality: number; rebuiltPartitions: number; rebuildMs: number;
  };
}

export interface BenchmarkCohortPassResult {
  state: "partial" | "complete" | "unavailable";
  snapshot: BenchmarkCohortSnapshot;
  scannedSources: number;
  pendingSources: number;
  tailPendingBytes?: number;
  checkpointBytes?: number;
}

type ManifestEntry = { name: string; path: string; form: Form; size: number; mtimeMs: number };

function validSources(value: unknown): value is SourceRecord[] {
  return Array.isArray(value) && value.every((source) => source && typeof source.name === "string"
    && ["gzip", "plain", "live"].includes(source.form) && Number.isSafeInteger(source.size) && source.size >= 0
    && typeof source.mtimeMs === "number" && Number.isFinite(source.mtimeMs)
    && typeof source.sha256 === "string" && /^[a-f0-9]{64}$/.test(source.sha256)
    && Array.isArray(source.rows) && source.rows.every((entry: EvidenceRow) => entry
      && typeof entry.fingerprint === "string" && /^[a-f0-9]{64}$/.test(entry.fingerprint)
      && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && object(entry.row)));
}

function validFaults(value: unknown): value is SourceFault[] {
  return Array.isArray(value) && value.every((fault) => fault && typeof fault.name === "string"
    && ["gzip", "plain", "live"].includes(fault.form) && Number.isSafeInteger(fault.size) && fault.size >= 0
    && typeof fault.mtimeMs === "number" && Number.isFinite(fault.mtimeMs)
    && typeof fault.reason === "string" && fault.reason.length > 0);
}

function validLastGood(value: unknown, sources: SourceRecord[]): value is BenchmarkCohortSnapshot {
  const snapshot = object(value);
  return snapshot?.version === BENCHMARK_COHORT_VERSION && snapshot.state === "observed"
    && typeof snapshot.asOf === "string" && Array.isArray(snapshot.cohorts)
    && Array.isArray(snapshot.sourceLineage)
    && JSON.stringify(snapshot.sourceLineage.map((item: { name: string; sha256: string }) => [item.name, item.sha256]))
      === JSON.stringify(sources.map((source) => [source.name, source.sha256]))
    && object(snapshot.sourceRows) !== undefined && object(snapshot.coverage) !== undefined
    && object(snapshot.pressure) !== undefined;
}

function manifest(stateDir: string): ManifestEntry[] {
  const rotations = ledgerRotationEntries(readdirSync(stateDir), stateDir);
  const live = ledgerLivePath(stateDir);
  return [...rotations, ...(existsSync(live) ? [{ path: live, form: "live" as const }] : [])]
    .map((entry) => {
      const stat = statSync(entry.path);
      return { name: basename(entry.path), path: entry.path, form: entry.form, size: stat.size, mtimeMs: stat.mtimeMs };
    });
}

function checkpointPath(stateDir: string): string {
  return join(stateDir, "benchmark-cohort-v1.json");
}

function readCheckpoint(stateDir: string): Checkpoint {
  try {
    const parsed = JSON.parse(readFileSync(checkpointPath(stateDir), "utf8")) as Partial<Checkpoint>;
    if (parsed.version === BENCHMARK_COHORT_VERSION && validSources(parsed.sources)
      && (parsed.baselineSources === undefined || validSources(parsed.baselineSources))
      && (parsed.sourceFaults === undefined || validFaults(parsed.sourceFaults))) {
      const lastGoodSources = parsed.baselineSources ?? parsed.sources;
      return { version: BENCHMARK_COHORT_VERSION, sources: parsed.sources,
        ...(parsed.sourceFaults ? { sourceFaults: parsed.sourceFaults } : {}),
        ...(parsed.baselineSources ? { baselineSources: parsed.baselineSources } : {}),
        ...(validLastGood(parsed.lastGood, lastGoodSources) ? { lastGood: parsed.lastGood } : {}) };
    }
  } catch { /* A missing or damaged checkpoint is a full replay, never a healthy empty cohort. */ }
  return { version: BENCHMARK_COHORT_VERSION, sources: [] };
}

function writeCheckpoint(stateDir: string, checkpoint: Checkpoint): number {
  const encoded = JSON.stringify(checkpoint);
  const destination = checkpointPath(stateDir);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, encoded);
  renameSync(temporary, destination);
  return Buffer.byteLength(encoded);
}

async function sourceHashes(path: string, prefixBytes?: number, throughBytes?: number): Promise<{ full: string; prefix?: string }> {
  const full = createHash("sha256");
  const prefix = prefixBytes === undefined ? undefined : createHash("sha256");
  let seen = 0;
  for await (const chunk of throughBytes === 0 ? [] : createReadStream(path,
    throughBytes === undefined ? undefined : { end: throughBytes - 1 })) {
    const bytes = chunk as Buffer;
    full.update(bytes);
    if (prefix) prefix.update(bytes.subarray(0, Math.max(0, Math.min(bytes.length, prefixBytes! - seen))));
    seen += bytes.length;
  }
  return { full: full.digest("hex"), ...(prefix ? { prefix: prefix.digest("hex") } : {}) };
}

/** Find a durable newline boundary at or before the manifest's byte watermark. A writer may be
 * appending while we scan; the unfinished line belongs to the next pass, never this denominator. */
function completeLivePrefix(path: string, size: number): number {
  if (size === 0) return 0;
  const fd = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunk.length);
      const bytes = readSync(fd, chunk, 0, end - start, start);
      if (bytes !== end - start) throw new Error("ledger-live-truncated-before-watermark");
      const newline = chunk.subarray(0, bytes).lastIndexOf(0x0a);
      if (newline >= 0) return start + newline + 1;
      end = start;
    }
    return 0;
  } finally { closeSync(fd); }
}

function relevant(row: Record<string, unknown>): boolean {
  return row.step === "worker.assignment" || row.step === "worker.attempt" || row.step === "verdict";
}

function projectRow(row: Record<string, unknown>): Record<string, unknown> {
  if (row.step === "worker.assignment") {
    const assignment = object(row.worker_assignment);
    const selected = object(assignment?.selected);
    const receipt = object(row.benchmark_run);
    const work = object(receipt?.work);
    const stack = object(receipt?.stack);
    return {
      ts: row.ts, run_id: row.run_id, step: row.step,
      worker_assignment: { id: assignment?.id, selected: { provider: selected?.provider, model: selected?.model } },
      benchmark_run: { work: { taskClass: work?.taskClass }, stack: { harnessRevision: stack?.harnessRevision } },
    };
  }
  return {
    ts: row.ts, run_id: row.run_id, step: row.step, selection_assignment_id: row.selection_assignment_id,
    success: row.success, served_model: row.served_model, billing_mode: row.billing_mode,
    total_cost_usd: row.total_cost_usd, evidence_action: row.evidence_action,
  };
}

async function scanSource(entry: ManifestEntry, precedingRotation: string | undefined, prior?: SourceRecord,
  onLiveWatermark?: () => void): Promise<SourceRecord> {
  const prefixBytes = entry.form === "live" ? completeLivePrefix(entry.path, entry.size) : entry.size;
  if (entry.form === "live") onLiveWatermark?.();
  const hashes = await sourceHashes(entry.path, entry.form === "live" ? prior?.size : undefined,
    entry.form === "live" ? prefixBytes : undefined);
  const appendOnly = entry.form === "live" && prior !== undefined && prefixBytes >= prior.size
    && hashes.prefix === prior.sha256;
  const rows: EvidenceRow[] = appendOnly ? [...prior.rows] : [];
  let malformedReason: string | undefined;
  let unread = 0;
  const sourceOptions = entry.form === "live"
    ? { afterRotation: precedingRotation, includeLive: true, ...(appendOnly ? { liveStartOffset: prior!.size } : {}) }
    : { afterRotation: precedingRotation, throughRotation: entry.name, includeLive: false };
  const sourceIO = entry.form === "live" ? {
    readdirSync, existsSync,
    createReadStream: (path: string, options?: { start?: number }) => createReadStream(path,
      path === entry.path ? { ...options, end: prefixBytes - 1 } : options),
  } : undefined;
  const noNewLiveLine = entry.form === "live" && (prefixBytes === 0
    || (appendOnly && prefixBytes === prior!.size));
  for await (const _row of noNewLiveLine ? [] : openLedgerUnion(dirname(entry.path), {
    ...sourceOptions,
    dedupe: false,
    onAcceptedRecord: (row, raw) => {
      if (relevant(row)) rows.push({ fingerprint: fingerprintLedgerLine(raw), bytes: Buffer.byteLength(raw), row: projectRow(row) });
    },
    onMalformedRow: (finding) => { malformedReason = finding.kind === "live-torn-tail" ? "ledger-live-torn-tail" : "ledger-source-malformed"; },
    onUnreadArchive: () => { unread += 1; },
    onUnreadLive: () => { unread += 1; },
  }, sourceIO)) {
    void _row;
  }
  const after = statSync(entry.path);
  const stable = entry.form === "live"
    ? after.size >= prefixBytes && (await sourceHashes(entry.path, undefined, prefixBytes)).full === hashes.full
    : after.size === entry.size && after.mtimeMs === entry.mtimeMs
      && (await sourceHashes(entry.path)).full === hashes.full;
  if (unread > 0 || malformedReason || !stable) {
    throw new Error(unread > 0 ? entry.form === "live" ? "ledger-live-unreadable" : "ledger-source-unreadable"
      : malformedReason ?? "ledger-source-changed-during-scan");
  }
  return { name: entry.name, form: entry.form, size: prefixBytes, mtimeMs: entry.mtimeMs, sha256: hashes.full, rows };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function observedString(value: unknown): string | null {
  const evidence = object(value);
  return evidence?.state === "observed" && typeof evidence.value === "string" && evidence.value.length > 0
    ? evidence.value : null;
}

function finiteCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function emptySnapshot(reason: string, lastGood?: BenchmarkCohortSnapshot): BenchmarkCohortSnapshot {
  return lastGood ? { ...lastGood, state: "unavailable", reason, lastGoodAt: lastGood.asOf ?? undefined } : {
    version: BENCHMARK_COHORT_VERSION, state: "unavailable", reason, asOf: null,
    sourceLineage: [], sourceRows: { assignments: 0, attempts: 0, terminals: 0,
      unmatchedAttempts: 0, unmatchedTerminals: 0, invalidAssignmentRows: 0,
      attemptRowsWithoutAssignmentId: 0, terminalRowsWithoutAssignmentId: 0,
      conflictingAssignments: 0, duplicateRows: 0 },
    cohorts: [], coverage: blankCoverage(0),
    verifiedTaskOutcome: "unavailable-no-github-verification-join",
    experimentEffect: "unavailable-no-randomized-allocation",
    pressure: { sourceBytes: 0, auditedSourceBytes: 0, derivedBytes: 0, snapshotGrowthBytes: null,
      sourceToDerivedRatio: null, evidenceBytesByDay: [], eventsPerAssignment: null, eventsPerRun: null,
      runsWithId: 0, dimensionCardinality: 0, rebuiltPartitions: 0, rebuildMs: 0 },
  };
}

function blankCoverage(denominator: number): Record<CoverageField, CohortFieldCoverage> {
  const field = (): CohortFieldCoverage => ({ denominator, observed: 0, noAttempt: 0, notRecorded: 0 });
  return {
    taskClass: field(), selectedModel: field(), harnessRevision: field(), workerCall: field(),
    servedModel: field(), billingMode: field(), cost: field(),
  };
}

function indexEvidence(sources: SourceRecord[]): {
  assignments: Map<string, Record<string, unknown>>;
  attempts: Map<string, Record<string, unknown>>;
  terminals: Map<string, Record<string, unknown>>;
  invalidAssignmentRows: number;
  attemptRowsWithoutAssignmentId: number;
  terminalRowsWithoutAssignmentId: number;
  conflictingAssignments: number;
  duplicateRows: number;
} {
  const fingerprints = new Set<string>();
  const assignments = new Map<string, Record<string, unknown>>();
  const attempts = new Map<string, Record<string, unknown>>();
  const terminals = new Map<string, Record<string, unknown>>();
  let duplicateRows = 0;
  let invalidAssignmentRows = 0;
  let attemptRowsWithoutAssignmentId = 0;
  let terminalRowsWithoutAssignmentId = 0;
  let conflictingAssignments = 0;
  for (const source of sources) for (const evidence of source.rows) {
    if (fingerprints.has(evidence.fingerprint)) { duplicateRows += 1; continue; }
    fingerprints.add(evidence.fingerprint);
    const row = evidence.row;
    if (row.step === "worker.assignment") {
      const id = object(row.worker_assignment)?.id;
      if (typeof id === "string" && id) {
        const prior = assignments.get(id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(row)) conflictingAssignments += 1;
        assignments.set(id, row);
      } else invalidAssignmentRows += 1;
    } else if (row.step === "worker.attempt") {
      if (typeof row.selection_assignment_id === "string" && row.selection_assignment_id.length > 0) {
        if (row.evidence_action === "retract") attempts.delete(row.selection_assignment_id);
        else attempts.set(row.selection_assignment_id, row);
      } else attemptRowsWithoutAssignmentId += 1;
    } else if (row.step === "verdict") {
      if (typeof row.selection_assignment_id === "string" && row.selection_assignment_id.length > 0) {
        if (row.evidence_action === "retract") terminals.delete(row.selection_assignment_id);
        else terminals.set(row.selection_assignment_id, row);
      } else terminalRowsWithoutAssignmentId += 1;
    }
  }
  return { assignments, attempts, terminals, invalidAssignmentRows, attemptRowsWithoutAssignmentId,
    terminalRowsWithoutAssignmentId, conflictingAssignments, duplicateRows };
}

function dimensionsOf(row: Record<string, unknown>): BenchmarkCohort["dimensions"] {
  const assignment = object(row.worker_assignment);
  const selected = object(assignment?.selected);
  const receipt = object(row.benchmark_run);
  const work = object(receipt?.work);
  const stack = object(receipt?.stack);
  return {
    day: typeof row.ts === "string" && Number.isFinite(Date.parse(row.ts)) ? row.ts.slice(0, 10) : null,
    taskClass: observedString(work?.taskClass),
    provider: typeof selected?.provider === "string" ? selected.provider : null,
    model: typeof selected?.model === "string" ? selected.model : null,
    harnessRevision: observedString(stack?.harnessRevision),
  };
}

function affectedKeys(baseline: SourceRecord[], current: SourceRecord[]): Set<string> {
  const old = new Map(baseline.map((source) => [source.name, source]));
  const next = new Map(current.map((source) => [source.name, source]));
  const changedIds = new Set<string>();
  for (const name of new Set([...old.keys(), ...next.keys()])) {
    const before = old.get(name);
    const after = next.get(name);
    if (before?.sha256 === after?.sha256 && before?.form === after?.form) continue;
    for (const source of [before, after]) for (const evidence of source?.rows ?? []) {
      const row = evidence.row;
      const id = row.step === "worker.assignment" ? object(row.worker_assignment)?.id : row.selection_assignment_id;
      if (typeof id === "string") changedIds.add(id);
    }
  }
  const before = indexEvidence(baseline);
  const after = indexEvidence(current);
  const keys = new Set<string>();
  for (const id of changedIds) {
    if (JSON.stringify(before.assignments.get(id)) === JSON.stringify(after.assignments.get(id))
      && JSON.stringify(before.attempts.get(id)) === JSON.stringify(after.attempts.get(id))
      && JSON.stringify(before.terminals.get(id)) === JSON.stringify(after.terminals.get(id))) continue;
    for (const row of [before.assignments.get(id), after.assignments.get(id)]) {
      if (row) keys.add(JSON.stringify(dimensionsOf(row)));
    }
  }
  return keys;
}

function deriveSnapshot(
  sources: SourceRecord[], asOf: string, auditedSourceBytes: number, prior?: BenchmarkCohortSnapshot,
  dirtyKeys?: Set<string>, liveWatermark?: { prefixBytes: number; tailPendingBytes: number },
): BenchmarkCohortSnapshot {
  const started = systemClock.now();
  const { assignments, attempts, terminals, invalidAssignmentRows, attemptRowsWithoutAssignmentId,
    terminalRowsWithoutAssignmentId, conflictingAssignments, duplicateRows } = indexEvidence(sources);
  const fingerprints = new Set<string>();
  const evidenceBytesByDay = new Map<string, number>();
  const runs = new Map<string, number>();
  for (const source of sources) for (const evidence of source.rows) {
    if (fingerprints.has(evidence.fingerprint)) continue;
    fingerprints.add(evidence.fingerprint);
    const day = typeof evidence.row.ts === "string" && Number.isFinite(Date.parse(evidence.row.ts))
      ? evidence.row.ts.slice(0, 10) : "unavailable";
    evidenceBytesByDay.set(day, (evidenceBytesByDay.get(day) ?? 0) + evidence.bytes);
    const runId = evidence.row.run_id;
    if (typeof runId === "string" && runId.length > 0) runs.set(runId, (runs.get(runId) ?? 0) + 1);
  }
  const groups = new Map<string, BenchmarkCohort>();
  if (prior && dirtyKeys) for (const cohort of prior.cohorts) {
    const key = JSON.stringify(cohort.dimensions);
    if (!dirtyKeys.has(key)) groups.set(key, cohort);
  }
  const coverage = blankCoverage(assignments.size);
  for (const [id, row] of assignments) {
    const dimensions = dimensionsOf(row);
    for (const [field, observed] of [
      ["taskClass", dimensions.taskClass !== null],
      ["selectedModel", dimensions.model !== null],
      ["harnessRevision", dimensions.harnessRevision !== null],
    ] as const) {
      if (observed) coverage[field].observed += 1;
      else coverage[field].notRecorded += 1;
    }
    const key = JSON.stringify(dimensions);
    const attempt = attempts.get(id);
    const terminal = terminals.get(id);
    const call = attempt ?? terminal;
    if (prior && dirtyKeys && !dirtyKeys.has(key)) {
      for (const [field, observed] of [
        ["workerCall", typeof call?.success === "boolean"],
        ["servedModel", typeof call?.served_model === "string" && call.served_model.length > 0],
        ["billingMode", call?.billing_mode === "api" || call?.billing_mode === "subscription"],
        ["cost", finiteCost(call?.total_cost_usd) !== null],
      ] as const) {
        if (!call) coverage[field].noAttempt += 1;
        else if (observed) coverage[field].observed += 1;
        else coverage[field].notRecorded += 1;
      }
      continue;
    }
    const group = groups.get(key) ?? {
      dimensions, assignments: 0, joinedAttempts: 0, joinedTerminals: 0, workerCallSuccess: 0, workerCallFailure: 0,
      servedModelObserved: 0, apiCostUsd: 0, subscriptionNotionalUsd: 0,
    };
    group.assignments += 1;
    if (attempt) group.joinedAttempts += 1;
    if (terminal) group.joinedTerminals += 1;
    if (call) {
      if (call.success === true) group.workerCallSuccess += 1;
      if (call.success === false) group.workerCallFailure += 1;
      if (typeof call.served_model === "string" && call.served_model.length > 0) group.servedModelObserved += 1;
      const cost = finiteCost(call.total_cost_usd);
      if (cost !== null && call.billing_mode === "api") group.apiCostUsd += cost;
      if (cost !== null && call.billing_mode === "subscription") group.subscriptionNotionalUsd += cost;
      for (const [field, observed] of [
        ["workerCall", typeof call.success === "boolean"],
        ["servedModel", typeof call.served_model === "string" && call.served_model.length > 0],
        ["billingMode", call.billing_mode === "api" || call.billing_mode === "subscription"],
        ["cost", cost !== null],
      ] as const) {
        if (observed) coverage[field].observed += 1;
        else coverage[field].notRecorded += 1;
      }
    } else {
      for (const field of ["workerCall", "servedModel", "billingMode", "cost"] as const) coverage[field].noAttempt += 1;
    }
    groups.set(key, group);
  }
  const cohorts = [...groups.values()].sort((a, b) => JSON.stringify(a.dimensions).localeCompare(JSON.stringify(b.dimensions)));
  const snapshot: BenchmarkCohortSnapshot = {
    version: BENCHMARK_COHORT_VERSION, state: "observed", asOf,
    sourceLineage: sources.map(({ name, form, sha256, size }) => ({ name, form, sha256, bytes: size })),
    ...(liveWatermark ? { liveWatermark } : {}),
    sourceRows: { assignments: assignments.size, attempts: attempts.size, terminals: terminals.size,
      unmatchedAttempts: [...attempts.keys()].filter((id) => !assignments.has(id)).length,
      unmatchedTerminals: [...terminals.keys()].filter((id) => !assignments.has(id)).length,
      invalidAssignmentRows, attemptRowsWithoutAssignmentId, terminalRowsWithoutAssignmentId,
      conflictingAssignments, duplicateRows },
    cohorts,
    coverage,
    verifiedTaskOutcome: "unavailable-no-github-verification-join",
    experimentEffect: "unavailable-no-randomized-allocation",
    pressure: { sourceBytes: sources.reduce((sum, source) => sum + source.size, 0), auditedSourceBytes,
      derivedBytes: 0, snapshotGrowthBytes: prior ? 0 : null, sourceToDerivedRatio: null,
      evidenceBytesByDay: [...evidenceBytesByDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, bytes]) => ({ day, bytes })),
      eventsPerAssignment: assignments.size > 0 ? (assignments.size + attempts.size + terminals.size) / assignments.size : null,
      eventsPerRun: runs.size > 0 ? [...runs.values()].reduce((sum, count) => sum + count, 0) / runs.size : null,
      runsWithId: runs.size, dimensionCardinality: cohorts.length,
      rebuiltPartitions: prior && dirtyKeys ? dirtyKeys.size : cohorts.length,
      rebuildMs: systemClock.now() - started },
  };
  snapshot.pressure.derivedBytes = Buffer.byteLength(JSON.stringify(snapshot));
  snapshot.pressure.snapshotGrowthBytes = prior ? snapshot.pressure.derivedBytes - prior.pressure.derivedBytes : null;
  snapshot.pressure.sourceToDerivedRatio = snapshot.pressure.derivedBytes > 0
    ? snapshot.pressure.sourceBytes / snapshot.pressure.derivedBytes : null;
  snapshot.pressure.derivedBytes = Buffer.byteLength(JSON.stringify(snapshot));
  return snapshot;
}

/** One source per ordinary pass by default; a failed projection never changes daemon work. */
export async function runBenchmarkCohortPass(
  stateDir: string,
  opts: { maxSources?: number; nowIso?: string; onLiveWatermark?: () => void } = {},
): Promise<BenchmarkCohortPassResult> {
  const maxSources = opts.maxSources ?? 1;
  if (!Number.isInteger(maxSources) || maxSources < 1) throw new TypeError("maxSources must be a positive integer");
  const checkpoint = readCheckpoint(stateDir);
  let current: ManifestEntry[];
  try { current = manifest(stateDir); }
  catch {
    // An unreadable ledger directory is not an observed empty cohort; preserve the last good snapshot.
    return { state: "unavailable", snapshot: emptySnapshot("ledger-source-unreadable", checkpoint.lastGood), scannedSources: 0, pendingSources: 0 };
  }
  if (current.length === 0) return { state: "unavailable", snapshot: emptySnapshot("ledger-source-missing", checkpoint.lastGood), scannedSources: 0, pendingSources: 0 };
  const known = new Map(checkpoint.sources.map((source) => [source.name, source]));
  const faults = new Map((checkpoint.sourceFaults ?? []).map((fault) => [fault.name, fault]));
  const changed = current.filter((entry) => {
    const prior = known.get(entry.name);
    if (prior) return prior.size !== entry.size || prior.mtimeMs !== entry.mtimeMs || prior.form !== entry.form;
    const fault = faults.get(entry.name);
    return !fault || fault.size !== entry.size || fault.mtimeMs !== entry.mtimeMs || fault.form !== entry.form;
  });
  if (changed.length === 0 && faults.size === 0 && checkpoint.lastGood && !checkpoint.baselineSources
    && checkpoint.sources.length === current.length) {
    return { state: "complete", snapshot: checkpoint.lastGood, scannedSources: 0, pendingSources: 0 };
  }
  if (!checkpoint.baselineSources && checkpoint.sources.length > 0
    && (checkpoint.lastGood || checkpoint.sources.some((source) => !current.some((entry) => entry.name === source.name)))) {
    checkpoint.baselineSources = checkpoint.sources;
  }
  let scannedSources = 0;
  let auditedSourceBytes = 0;
  const scannedNames = new Set<string>();
  for (const entry of changed.slice(0, maxSources)) {
    const rotations = current.filter((candidate) => candidate.form !== "live");
    const index = rotations.findIndex((candidate) => candidate.name === entry.name);
    const precedingRotation = entry.form === "live" ? rotations.at(-1)?.name : rotations[index - 1]?.name;
    try {
      known.set(entry.name, await scanSource(entry, precedingRotation, known.get(entry.name), opts.onLiveWatermark));
      scannedNames.add(entry.name);
      faults.delete(entry.name);
      scannedSources += 1;
      auditedSourceBytes += entry.size;
    } catch (error) {
      known.delete(entry.name);
      faults.set(entry.name, { name: entry.name, form: entry.form, size: entry.size,
        mtimeMs: entry.mtimeMs, reason: String((error as Error)?.message ?? error) });
    }
  }
  checkpoint.sources = current.flatMap((entry) => { const source = known.get(entry.name); return source ? [source] : []; });
  checkpoint.sourceFaults = current.flatMap((entry) => { const fault = faults.get(entry.name); return fault ? [fault] : []; });
  const pendingSources = current.filter((entry) => {
    const source = known.get(entry.name);
    if (source) return entry.form === "live" && scannedNames.has(entry.name) ? false
      : source.size !== entry.size || source.mtimeMs !== entry.mtimeMs || source.form !== entry.form;
    const fault = faults.get(entry.name);
    return !fault || fault.size !== entry.size || fault.mtimeMs !== entry.mtimeMs || fault.form !== entry.form;
  }).length;
  if (pendingSources > 0) {
    const checkpointBytes = writeCheckpoint(stateDir, checkpoint);
    return { state: "partial", snapshot: emptySnapshot("scan-incomplete", checkpoint.lastGood), scannedSources, pendingSources, checkpointBytes };
  }
  if (checkpoint.sourceFaults.length > 0) {
    const checkpointBytes = writeCheckpoint(stateDir, checkpoint);
    return { state: "unavailable", snapshot: emptySnapshot(checkpoint.sourceFaults[0].reason, checkpoint.lastGood),
      scannedSources, pendingSources: 0, checkpointBytes };
  }
  const live = checkpoint.sources.find((source) => source.form === "live");
  const liveManifest = current.find((entry) => entry.form === "live");
  let tailPendingBytes = 0;
  if (live && liveManifest) {
    try {
      const size = statSync(liveManifest.path).size;
      if (size < live.size || (await sourceHashes(liveManifest.path, undefined, live.size)).full !== live.sha256)
        throw new Error("ledger-live-changed-after-scan");
      tailPendingBytes = size - live.size;
    } catch (error) {
      const reason = error instanceof Error && error.message === "ledger-live-changed-after-scan"
        ? "ledger-live-changed-after-scan" : "ledger-live-unreadable-after-scan";
      const checkpointBytes = writeCheckpoint(stateDir, checkpoint);
      return { state: "partial", snapshot: emptySnapshot(reason, checkpoint.lastGood),
        scannedSources, pendingSources: 1, checkpointBytes };
    }
  }
  if (checkpoint.baselineSources) {
    const successorFingerprints = new Set(checkpoint.sources.flatMap((source) => source.rows.map((row) => row.fingerprint)));
    if (checkpoint.baselineSources.some((source) => source.rows.some((row) => !successorFingerprints.has(row.fingerprint)))) {
      const checkpointBytes = writeCheckpoint(stateDir, checkpoint);
      return { state: "unavailable", snapshot: emptySnapshot("retired-source-evidence-not-reconciled", checkpoint.lastGood),
        scannedSources, pendingSources: 0, checkpointBytes };
    }
  }
  const dirtyKeys = checkpoint.baselineSources ? affectedKeys(checkpoint.baselineSources, checkpoint.sources) : undefined;
  const snapshot = deriveSnapshot(checkpoint.sources, opts.nowIso ?? systemClock.iso(), auditedSourceBytes,
    checkpoint.lastGood, dirtyKeys, live ? { prefixBytes: live.size, tailPendingBytes } : undefined);
  if (snapshot.sourceRows.conflictingAssignments > 0) {
    const checkpointBytes = writeCheckpoint(stateDir, checkpoint);
    return { state: "unavailable", snapshot: emptySnapshot("conflicting-assignment-ids", checkpoint.lastGood),
      scannedSources, pendingSources: 0, checkpointBytes };
  }
  checkpoint.lastGood = snapshot;
  delete checkpoint.baselineSources;
  const checkpointBytes = writeCheckpoint(stateDir, checkpoint);
  return { state: "complete", snapshot, scannedSources, pendingSources: 0, tailPendingBytes, checkpointBytes };
}

/** Direct, internal maintenance entrypoint: no new public `rmd` verb or model worker. */
export async function runBenchmarkCohortIdlePass(
  stateDir: string, run: typeof runBenchmarkCohortPass = runBenchmarkCohortPass,
): Promise<number> {
  try {
    const result = await run(stateDir, { maxSources: 4 });
    console.log(JSON.stringify({ event: "benchmark_cohort.idle_pass", state: result.state,
      scanned_sources: result.scannedSources, pending_sources: result.pendingSources,
      tail_pending_bytes: result.tailPendingBytes ?? 0, reason: result.snapshot.reason ?? null }));
    return 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    const errorClass = code === "ENOENT" || code === "EACCES" || code === "EPERM" ? code
      : error instanceof TypeError ? "type-error" : error instanceof SyntaxError ? "syntax-error" : "other-error";
    console.error(JSON.stringify({ event: "benchmark_cohort.idle_pass_failed", reason: "projection-failed",
      error_class: errorClass }));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stateDir = process.argv[2];
  if (!stateDir || process.argv.length !== 3) {
    console.error("usage: node --import tsx src/lib/benchmark-cohort.ts <state-dir>");
    process.exitCode = 2;
  } else {
    void runBenchmarkCohortIdlePass(stateDir).then((code) => { process.exitCode = code; });
  }
}
