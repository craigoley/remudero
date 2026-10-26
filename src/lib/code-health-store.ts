import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { validateRepositoryEvidenceInventory, type RepositoryEvidenceInventory } from "./daily-progress-contract.js";
import { parseProposalRegistryResult } from "./inbox.js";
import { inboxThreadId } from "./inbox-thread.js";
import { OPPORTUNITY_EVIDENCE_FILE, OPPORTUNITY_EVIDENCE_MAX_BYTES, projectGardenerOpportunityEvidence } from "./gardener-opportunity-evidence.js";

class CodeHealthInventoryNotReady extends RmdError {
  constructor(message: string) { super("read-model", GENERIC_EXIT_CODE, message); }
}

export const CODE_HEALTH_INTERVAL_MS = 86_400_000;
export interface CodeHealthSavedWork { repository: string; proposalId: string; taskId?: string; prUrl?: string; threadId?: string }
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { acquireInflightLock, parseInflightLockInfo, type InflightLockHandle } from "./inflight-lock.js";
import { isHolderStale, reclaimStaleLock, writeAtomic } from "./fs-race-safe.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { fixedClock, systemClock } from "./clock.js";
import { projectCodeHealth, validateCodeHealthProvenance, type CodeHealthProjectionInput, type CodeHealthScan, type CodeHealthSourceProvenance } from "./code-health-projection.js";

function canonicalCodeHealthValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalCodeHealthValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => [key, canonicalCodeHealthValue(child)]));
  return value;
}
const canonicalCodeHealthJson = (value: unknown): string => JSON.stringify(canonicalCodeHealthValue(value));
const orderedCodeHealthValues = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => {
  const left = canonicalCodeHealthJson(a), right = canonicalCodeHealthJson(b); return left < right ? -1 : left > right ? 1 : 0;
});

/** V1 identity seals source facts and declared policy, independently of today's projection. Keep v1 normalization compatible. */
function evidenceSnapshotId(input: CodeHealthProjectionInput): string {
  const normalizedScans = (scans: readonly CodeHealthScan[]) => orderedCodeHealthValues(scans.map(scan => ({ ...scan,
    checks: orderedCodeHealthValues(scan.checks), exclusions: [...scan.exclusions].sort(),
    ...(scan.componentIds === undefined ? {} : { componentIds: [...scan.componentIds].sort() }),
    findings: orderedCodeHealthValues([...new Map(scan.findings.map(finding => [canonicalCodeHealthJson(finding), finding])).values()]),
  })));
  const { observedAt: _observedAt, nextDueAt: _nextDueAt, ...facts } = input;
  const evidence = { ...facts, registry: { ...input.registry, checks: orderedCodeHealthValues(input.registry.checks) }, scans: normalizedScans(input.scans),
    baseline: input.baseline ? { ...input.baseline, scans: normalizedScans(input.baseline.scans) } : null,
    ...(input.retainedEvidence === undefined ? {} : { retainedEvidence: orderedCodeHealthValues(input.retainedEvidence.map(entry => ({ ...entry, scan: normalizedScans([entry.scan])[0] }))) }) };
  return createHash("sha256").update(canonicalCodeHealthJson({ version: "code-health-evidence-input-v1", evidence })).digest("hex");
}

export function codeHealthEvidenceSnapshotId(input: CodeHealthProjectionInput): string {
  projectCodeHealth(input); // New publication must meet current validation; reading old sealed facts does not re-assess them.
  return evidenceSnapshotId(input);
}

export interface CodeHealthStoredSnapshot {
  version: "code-health-snapshot-v1";
  snapshotId: string;
  contentHash: string;
  previousSnapshotId: string | null;
  input: CodeHealthProjectionInput;
}
export type CodeHealthSnapshotRead = { state: "observed"; snapshot: CodeHealthStoredSnapshot; latestAttemptAt: string | null } | { state: "not_collected" | "unavailable"; reason: string };
const CODE_HEALTH_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const evidenceDigest = (value: unknown): string => createHash("sha256").update(canonicalCodeHealthJson(value)).digest("hex");
function boundedEvidenceJson(path: string, maxBytes: number): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new Error("Invalid code health evidence file.");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0, count: number;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    const after = fstatSync(fd);
    if (length > maxBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error("Code health evidence changed during its bounded read.");
    return JSON.parse(buffer.toString("utf8", 0, length));
  } finally { closeSync(fd); }
}
interface EvidencePointer { version: "code-health-pointer-v1"; repository: string; snapshotId: string; attemptAt: string }
function evidencePointer(stateDir: string): EvidencePointer | null {
  let value: unknown;
  try { value = boundedEvidenceJson(join(stateDir, "code-health", "latest.json"), 4096); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const p = value as EvidencePointer;
  if (!p || Object.keys(p).sort().join(",") !== "attemptAt,repository,snapshotId,version" || p.version !== "code-health-pointer-v1" ||
      typeof p.repository !== "string" || !/^[a-f0-9]{64}$/.test(p.snapshotId) || !Number.isFinite(Date.parse(p.attemptAt)))
    throw new Error("The code health publication pointer is invalid.");
  return p;
}
export function readCodeHealthSnapshot(stateDir: string, repository: string, snapshotId?: string): CodeHealthSnapshotRead {
  try {
    if (snapshotId !== undefined && !/^[a-f0-9]{64}$/.test(snapshotId)) throw new Error("Invalid code health snapshot identity.");
    const pointer = snapshotId === undefined ? evidencePointer(stateDir) : null;
    if (snapshotId === undefined && pointer === null) return { state: "not_collected", reason: "Code health has not been collected." };
    if (pointer && pointer.repository !== repository.toLowerCase()) throw new Error("Code health repository does not match.");
    const id = snapshotId ?? pointer!.snapshotId;
    const snapshot = boundedEvidenceJson(join(stateDir, "code-health", "snapshots", `${id}.json`), CODE_HEALTH_SNAPSHOT_MAX_BYTES) as CodeHealthStoredSnapshot;
    const { contentHash, ...sealed } = snapshot;
    if (!snapshot || Object.keys(snapshot).sort().join(",") !== "contentHash,input,previousSnapshotId,snapshotId,version" || snapshot.version !== "code-health-snapshot-v1" ||
        snapshot.snapshotId !== id || !(snapshot.previousSnapshotId === null || /^[a-f0-9]{64}$/.test(snapshot.previousSnapshotId) && snapshot.previousSnapshotId !== id) || snapshot.input?.repository.toLowerCase() !== repository.toLowerCase() ||
        contentHash !== evidenceDigest(sealed) || evidenceSnapshotId(snapshot.input) !== id) throw new Error("Code health evidence identity or integrity does not match.");
    return { state: "observed", snapshot, latestAttemptAt: pointer?.attemptAt ?? null };
  } catch { return { state: "unavailable", reason: "Saved code health evidence is unavailable, invalid, or belongs to another repository." }; }
}

/** Independent publication lock, never task dispatch admission. Native stale-holder proof is retained. */
function codeHealthPublicationLock(stateDir: string): InflightLockHandle | undefined {
  const dir = join(stateDir, "code-health", "locks"), path = join(dir, "publication.lock");
  const acquire = () => acquireInflightLock(dir, "publication", { run_id: `code-health:${randomUUID()}`, reclaim: false });
  try { return acquire(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) return undefined;
  const result = reclaimStaleLock(path, {
    // Non-null wrapper preserves an unparseable lock as unknown, rather than reclaiming it.
    parseHolder: raw => ({ info: parseInflightLockInfo(raw) }),
    isStale: held => held.info !== null && Number.isSafeInteger(held.info.pid) && held.info.pid > 0 && typeof held.info.host === "string" &&
      Number.isFinite(Date.parse(held.info.startedAt)) && isHolderStale(held.info, { isPidAlive: defaultIsPidAlive }),
  });
  if (result.outcome !== "missing" && result.outcome !== "reclaimed") return undefined;
  try { return acquire(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined; throw error; }
}
function codeHealthPublicationOwnership(lock: InflightLockHandle): () => boolean {
  const held = lstatSync(lock.path), identity = { ...lock.info }, lockPath = lock.path;
  return () => {
    try {
      const now = lstatSync(lockPath), info = boundedEvidenceJson(lockPath, 4096);
      return now.isFile() && now.dev === held.dev && now.ino === held.ino && evidenceDigest(info) === evidenceDigest(identity);
    } catch {
      // An unreadable, replaced or malformed lock cannot prove ownership. False refuses every write
      // until ownership is established again; none of these failures means the lock is free.
      return false;
    }
  };
}
function syncEvidenceDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function publishCodeHealthSnapshot(opts: { stateDir: string; input: CodeHealthProjectionInput; expectedSnapshotId: string | null; clock?: import("./clock.js").Clock; mayPublish?: () => boolean }):
  { state: "published" | "duplicate"; snapshotId: string } | { state: "busy" | "superseded" | "unavailable"; reason: string } {
  let lock: InflightLockHandle | undefined, owns: (() => boolean) | undefined;
  try {
    const mayPublish = opts.mayPublish ?? (() => true);
    if (!mayPublish()) return { state: "superseded", reason: "Code health publication ownership changed." };
    const snapshotId = codeHealthEvidenceSnapshotId(opts.input), repository = opts.input.repository.toLowerCase();
    const attemptAt = (opts.clock ?? systemClock).iso();
    if (!Number.isFinite(Date.parse(attemptAt)) || Date.parse(opts.input.observedAt) > Date.parse(attemptAt)) throw new Error("Code health measurement is later than its collection attempt.");
    if (opts.expectedSnapshotId !== null && !/^[a-f0-9]{64}$/.test(opts.expectedSnapshotId)) throw new Error("Invalid expected code health snapshot.");
    const sealed = { version: "code-health-snapshot-v1" as const, snapshotId, previousSnapshotId: opts.expectedSnapshotId, input: opts.input };
    const snapshot: CodeHealthStoredSnapshot = { ...sealed, contentHash: evidenceDigest(sealed) };
    const serialized = JSON.stringify(snapshot);
    if (Buffer.byteLength(serialized) > CODE_HEALTH_SNAPSHOT_MAX_BYTES) throw new Error("Code health snapshot exceeds its bound.");
    lock = codeHealthPublicationLock(opts.stateDir);
    if (!lock) return { state: "busy", reason: "Another code health run is saving evidence, or its ownership is not yet known." };
    owns = codeHealthPublicationOwnership(lock);
    const prior = evidencePointer(opts.stateDir);
    if (prior && prior.repository !== repository) throw new Error("The publication belongs to another repository.");
    if ((prior?.snapshotId ?? null) !== opts.expectedSnapshotId) return { state: "superseded", reason: "A newer code health result was saved while this run was collecting evidence." };
    if (prior) {
      const saved = readCodeHealthSnapshot(opts.stateDir, repository, prior.snapshotId);
      if (saved.state !== "observed") throw new Error("The saved baseline is unavailable.");
      const known = [...saved.snapshot.input.scans, ...(saved.snapshot.input.baseline?.scans ?? [])];
      if (opts.input.scans.some(scan => scan.state === "complete" && known.some(previous => previous.kind === scan.kind && previous.state === "complete" &&
          Date.parse(previous.observedAt) > Date.parse(scan.observedAt)))) return { state: "superseded", reason: "Saved evidence includes a newer analysis than this collection returned." };
    }
    if (prior && Date.parse(prior.attemptAt) > Date.parse(attemptAt)) return { state: "superseded", reason: "A later code health collection attempt has already been saved." };
    const root = join(opts.stateDir, "code-health"), dir = join(root, "snapshots"), path = join(dir, `${snapshotId}.json`);
    mkdirSync(dir, { recursive: true });
    let duplicate = false;
    try {
      lstatSync(path);
      if (readCodeHealthSnapshot(opts.stateDir, repository, snapshotId).state !== "observed") throw new Error("An existing immutable snapshot is invalid.");
      duplicate = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!writeAtomic(path, serialized, { mode: 0o600, beforeRename: () => owns!() && mayPublish() })) throw new Error("Code health publication ownership changed.");
      syncEvidenceDirectory(dir);
    }
    const pointer: EvidencePointer = { version: "code-health-pointer-v1", repository, snapshotId, attemptAt };
    if (!writeAtomic(join(root, "latest.json"), JSON.stringify(pointer), { mode: 0o600, beforeRename: () => owns!() && mayPublish() &&
        (evidencePointer(opts.stateDir)?.snapshotId ?? null) === opts.expectedSnapshotId })) throw new Error("Code health publication was superseded.");
    syncEvidenceDirectory(root);
    syncEvidenceDirectory(opts.stateDir);
    return { state: duplicate ? "duplicate" : "published", snapshotId };
  } catch { return { state: "unavailable", reason: "Code health evidence could not be saved safely; prior snapshots were retained." }; }
  finally { if (lock && owns?.()) lock.release(); }
}


export type CodeHealthCoverageRead = { state: "observed"; provenance: CodeHealthSourceProvenance }
  | { state: "not_collected" | "unavailable"; reason: string };
const COVERAGE_SOURCE_MAX_BYTES = 128 * 1024;

/** A bounded cache of the artifact already validated by the existing coverage intake. */
export function readCodeHealthCoverageSource(stateDir: string, repository: string): CodeHealthCoverageRead {
  try {
    const raw = boundedEvidenceJson(join(stateDir, "code-health", "coverage-source.json"), COVERAGE_SOURCE_MAX_BYTES) as
      { version: string; provenance: CodeHealthSourceProvenance; contentHash: string };
    if (!raw || Object.keys(raw).sort().join(",") !== "contentHash,provenance,version" || raw.version !== "code-health-coverage-cache-v1") throw new Error("Invalid coverage source cache.");
    const { contentHash, ...sealed } = raw;
    if (contentHash !== evidenceDigest(sealed)) throw new Error("Coverage source cache integrity does not match.");
    const provenance = validateCodeHealthProvenance(raw.provenance, { repository, analyzedSha: raw.provenance.analyzedSha, runId: raw.provenance.runId, kind: "coverage" });
    return { state: "observed", provenance };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "not_collected", reason: "Coverage source evidence has not been saved." }
      : { state: "unavailable", reason: "Saved coverage source evidence is invalid, unavailable, or belongs to another repository." };
  }
}

export function saveCodeHealthCoverageSource(opts: { stateDir: string; repository: string; provenance: unknown; clock?: import("./clock.js").Clock }):
  { state: "published" | "duplicate" } | { state: "busy" | "superseded" | "unavailable"; reason: string } {
  let lock: InflightLockHandle | undefined, owns: (() => boolean) | undefined;
  try {
    const raw = opts.provenance as CodeHealthSourceProvenance;
    const provenance = validateCodeHealthProvenance(raw, { repository: opts.repository.toLowerCase(), analyzedSha: raw.analyzedSha, runId: raw.runId, kind: "coverage" });
    if (Date.parse(provenance.observedAt) > (opts.clock ?? systemClock).now()) throw new Error("Coverage evidence is later than this collection attempt.");
    const sealed = { version: "code-health-coverage-cache-v1", provenance }, serialized = JSON.stringify({ ...sealed, contentHash: evidenceDigest(sealed) });
    if (Buffer.byteLength(serialized) > COVERAGE_SOURCE_MAX_BYTES) throw new Error("Coverage source evidence exceeds its bound.");
    lock = codeHealthPublicationLock(opts.stateDir);
    if (!lock) return { state: "busy", reason: "Another code health publication is active or its ownership is unknown." };
    owns = codeHealthPublicationOwnership(lock);
    const prior = readCodeHealthCoverageSource(opts.stateDir, opts.repository);
    if (prior.state === "unavailable") throw new Error("Prior coverage source evidence is unavailable.");
    if (prior.state === "observed") {
      if (prior.provenance.scanId === provenance.scanId) {
        if (evidenceDigest(prior.provenance) !== evidenceDigest(provenance)) throw new Error("The same coverage measurement identity returned different facts.");
        return { state: "duplicate" };
      }
      if (Date.parse(prior.provenance.observedAt) >= Date.parse(provenance.observedAt)) return { state: "superseded", reason: "Saved coverage evidence is newer than this collection." };
    }
    const root = join(opts.stateDir, "code-health");
    if (!writeAtomic(join(root, "coverage-source.json"), serialized, { mode: 0o600, beforeRename: owns })) throw new Error("Coverage source publication ownership changed.");
    syncEvidenceDirectory(root); syncEvidenceDirectory(opts.stateDir);
    return { state: "published" };
  } catch { return { state: "unavailable", reason: "Coverage source evidence could not be saved safely; prior evidence was retained." }; }
  finally { if (lock && owns?.()) lock.release(); }
}

/** Original-output metadata uses the same bounded no-follow reader as sealed evidence. */
export function readCodeHealthArtifactJson(path: string, maxBytes = 128 * 1024): unknown {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > CODE_HEALTH_SNAPSHOT_MAX_BYTES) throw new RangeError("Invalid code health file bound.");
  return boundedEvidenceJson(path, maxBytes);
}

export type CodeHealthCollectionFailureRead = { state: "none" }
  | { state: "failed"; startedAt: string; finishedAt: string; snapshotId: string | null; reason: string; failureKind?: import("./ops.js").CodeScanningReadFailureKind }
  | { state: "unavailable"; reason: string };

interface CodeHealthCollectionFailure {
  version: "code-health-collection-failure-v1";
  failureKind?: import("./ops.js").CodeScanningReadFailureKind;
  repository: string;
  snapshotId: string | null;
  startedAt: string;
  finishedAt: string;
  reason: string;
}
const codeHealthFailureTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && fixedClock(Date.parse(value)).iso() === value;

export function readCodeHealthCollectionFailure(stateDir: string, repository: string): CodeHealthCollectionFailureRead {
  try {
    const raw = boundedEvidenceJson(join(stateDir, "code-health", "collection-failure.json"), 4096) as CodeHealthCollectionFailure & { contentHash: string };
    const { contentHash, ...sealed } = raw;
    if (!raw || Object.keys(raw).filter(key => key !== "failureKind").sort().join(",") !== "contentHash,finishedAt,reason,repository,snapshotId,startedAt,version" ||
        raw.failureKind !== undefined && !["unauthorized", "rate_limited", "unavailable"].includes(raw.failureKind) ||
        raw.version !== "code-health-collection-failure-v1" || raw.repository !== repository.toLowerCase() || contentHash !== evidenceDigest(sealed) ||
        !(raw.snapshotId === null || /^[a-f0-9]{64}$/.test(raw.snapshotId)) || !codeHealthFailureTime(raw.startedAt) || !codeHealthFailureTime(raw.finishedAt) ||
        Date.parse(raw.startedAt) > Date.parse(raw.finishedAt) || typeof raw.reason !== "string" || !raw.reason || raw.reason.length > 2048 || raw.reason.includes("\0"))
      throw new Error("Code health refresh status is invalid.");
    const pointer = evidencePointer(stateDir);
    if (pointer && pointer.repository !== repository.toLowerCase()) throw new Error("Code health refresh status belongs to another repository.");
    if ((pointer?.snapshotId ?? null) !== raw.snapshotId || pointer && Date.parse(pointer.attemptAt) > Date.parse(raw.startedAt)) return { state: "none" };
    return { state: "failed", startedAt: raw.startedAt, finishedAt: raw.finishedAt, snapshotId: raw.snapshotId, reason: raw.reason, failureKind: raw.failureKind ?? "unavailable" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "none" }
      : { state: "unavailable", reason: "The latest refresh status could not be read. Saved code check results were retained." };
  }
}

/** A failed refresh is operational status. It never replaces, renews, or erases measured evidence. */
export function recordCodeHealthCollectionFailure(opts: { stateDir: string; repository: string; expectedSnapshotId: string | null; startedAt: string; reason: string; failureKind?: import("./ops.js").CodeScanningReadFailureKind; clock?: import("./clock.js").Clock }):
  { state: "recorded" } | { state: "busy" | "superseded" | "unavailable"; reason: string } {
  let lock: InflightLockHandle | undefined, owns: (() => boolean) | undefined;
  try {
    const finishedAt = (opts.clock ?? systemClock).iso();
    if (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(opts.repository) ||
        !(opts.expectedSnapshotId === null || /^[a-f0-9]{64}$/.test(opts.expectedSnapshotId)) || !codeHealthFailureTime(opts.startedAt) ||
        !codeHealthFailureTime(finishedAt) || Date.parse(opts.startedAt) > Date.parse(finishedAt) ||
        opts.failureKind !== undefined && !["unauthorized", "rate_limited", "unavailable"].includes(opts.failureKind) || !opts.reason || opts.reason.length > 2048 || opts.reason.includes("\0")) throw new Error("Invalid code health refresh status.");
    lock = codeHealthPublicationLock(opts.stateDir);
    if (!lock) return { state: "busy", reason: "Another code health publication is active or its ownership is unknown." };
    owns = codeHealthPublicationOwnership(lock);
    const pointer = evidencePointer(opts.stateDir);
    if (pointer && pointer.repository !== opts.repository.toLowerCase()) throw new Error("Code health publication belongs to another repository.");
    if ((pointer?.snapshotId ?? null) !== opts.expectedSnapshotId || pointer && Date.parse(pointer.attemptAt) > Date.parse(opts.startedAt))
      return { state: "superseded", reason: "A newer successful refresh already saved its results." };
    const prior = readCodeHealthCollectionFailure(opts.stateDir, opts.repository);
    if (prior.state === "unavailable") throw new Error("Previous refresh status is unavailable.");
    if (prior.state === "failed" && Date.parse(prior.startedAt) > Date.parse(opts.startedAt)) return { state: "superseded", reason: "A newer collection attempt already reported its outcome." };
    const sealed: CodeHealthCollectionFailure = { version: "code-health-collection-failure-v1", repository: opts.repository.toLowerCase(), snapshotId: opts.expectedSnapshotId,
      startedAt: opts.startedAt, finishedAt, reason: opts.reason, failureKind: opts.failureKind ?? "unavailable" };
    const root = join(opts.stateDir, "code-health");
    if (!writeAtomic(join(root, "collection-failure.json"), JSON.stringify({ ...sealed, contentHash: evidenceDigest(sealed) }), { mode: 0o600, beforeRename: owns })) throw new Error("Code health refresh status ownership changed.");
    syncEvidenceDirectory(root); syncEvidenceDirectory(opts.stateDir);
    return { state: "recorded" };
  } catch { return { state: "unavailable", reason: "The failed refresh status could not be saved safely. Earlier evidence was retained." }; }
  finally { if (lock && owns?.()) lock.release(); }
}

/** Qualified repository identities share one fleet root without sharing a publication pointer. */
export function codeHealthRepositoryStateDir(fleetStateDir: string, repository: string): string {
  const qualified = repository.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/.test(qualified) || [".", ".."].includes(qualified.split("/")[1]!)) throw new RangeError("Invalid code health repository.");
  return join(fleetStateDir, "code-health-repositories", createHash("sha256").update(qualified).digest("hex"));
}


/** The existing outcome lifecycle's derived repository/instance namespace. Native Inbox and
 * gardener files remain at their original instance root and are never written through this path. */
export function improvementOutcomeStateDir(fleetStateDir: string, repository: string, instance: string): string {
  if (!/^[A-Za-z0-9._/-]{1,128}$/.test(instance) || instance.split("/").some(part => !part || part === "." || part === "..")) throw new RangeError("Invalid improvement instance.");
  return join(codeHealthRepositoryStateDir(fleetStateDir, repository), "improvement-effects",
    createHash("sha256").update(JSON.stringify([repository.toLowerCase(), instance])).digest("hex"));
}

export const isCodeHealthRepository = (value: string): boolean => /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/.test(value) && ![".", ".."].includes(value.split("/")[1]!);
function repositoryPullRequestUrl(value: unknown, repository: string): value is string {
  const prefix = `https://github.com/${repository}/pull/`;
  return typeof value === "string" && value.slice(0, prefix.length).toLowerCase() === prefix && /^[1-9][0-9]*$/.test(value.slice(prefix.length));
}
/** Server-owned roster; absent configuration never becomes an empty measured portfolio. */
export function readCodeHealthInventory(stateDir: string): RepositoryEvidenceInventory {
  const raw = readCodeHealthArtifactJson(join(stateDir, "read-model", "repositories-sources.json"), 2 * 1024 * 1024) as { improvementEvidence?: RepositoryEvidenceInventory };
  const checked = validateRepositoryEvidenceInventory(raw?.improvementEvidence);
  if (!checked.ok || !checked.value.repositories.length || checked.value.repositories.length > 256 || checked.value.unresolvedInstances.length > 256 ||
      checked.value.repositories.some(repo => !isCodeHealthRepository(repo.repository))) throw new CodeHealthInventoryNotReady("Code health is waiting for the configured repository list.");
  return checked.value;
}
export function readCodeHealthRelatedWork(stateDir: string, inventory: RepositoryEvidenceInventory, repository: string, now: number): {
  state: "reported" | "partial" | "stale" | "unavailable" | "not_collected"; asOf: string | null; work: CodeHealthSavedWork[]; reason: string | null;
} {
  const work: CodeHealthSavedWork[] = [], clocks: string[] = []; let missing = 0, invalid = 0, stale = false;
  const member = inventory.repositories.find(repo => repo.repository === repository)!;
  try {
    const publisher = readCodeHealthArtifactJson(join(stateDir, "read-model", "repositories-sources.json"), 2 * 1024 * 1024) as { instances?: Array<{ instanceId: string; options?: { ledgerPath?: string; controlRoot?: string } }> };
    if (publisher === null || publisher === undefined || !Array.isArray(publisher.instances) || publisher.instances.length > 256) throw new Error("Saved work scope is unavailable.");
    for (const instanceId of member.instanceIds) {
      const instances = publisher.instances.filter(instance => instance?.instanceId === instanceId), path = instances[0]?.options?.ledgerPath;
      if (instances.length !== 1 || typeof path !== "string" || path.length > 4096 || path.includes("\0") || !isAbsolute(path)) { missing++; continue; }
      const options = instances[0]!.options;
      if (typeof options?.controlRoot === "string" && options.controlRoot.length <= 4096 && !options.controlRoot.includes("\0") && isAbsolute(options.controlRoot)) {
        try {
          const raw = readCodeHealthArtifactJson(join(options.controlRoot, "state", "inbox-proposals.json"), 2 * 1024 * 1024), parsed = parseProposalRegistryResult(JSON.stringify(raw));
          if (parsed.kind !== "ok" || parsed.proposals.length > 2048) throw new Error("Saved planning links are unavailable.");
          for (const row of parsed.proposals) {
            const saved = (row as unknown as { improvement?: { version?: string; repository?: string; instance?: string; opportunityId?: string; snapshotId?: string; requestId?: string; goalDigest?: string; conversationReady?: boolean; threadId?: string } }).improvement;
            if (!saved || saved.version !== "improvement-thread-v1" || saved.conversationReady !== true || saved.repository !== repository || saved.instance !== instanceId ||
                typeof saved.opportunityId !== "string" || !saved.opportunityId.startsWith(`${repository}/codeql-quality:`) || saved.opportunityId.length > 1024 ||
                ![saved.snapshotId, saved.requestId, saved.goalDigest].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) continue;
            const proposalId = saved.opportunityId.slice(repository.length + 1), expectedId = `improvement:${createHash("sha256").update(JSON.stringify([repository, instanceId, proposalId])).digest("hex")}`;
            if (row.id === expectedId && saved.threadId === inboxThreadId(expectedId)) work.push({ repository, proposalId, threadId: saved.threadId });
          }
          // Existence is useful for navigation. Neither a read time nor file mtime refreshes the chat's source clock.
        } catch (error) {
          // Missing chats remain uncollected; unreadable or malformed chats make link completeness unavailable.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") missing++; else invalid++;
        }
      }
      const savedPaths = [join(dirname(path), OPPORTUNITY_EVIDENCE_FILE), join(improvementOutcomeStateDir(stateDir, repository, instanceId), OPPORTUNITY_EVIDENCE_FILE)];
      for (const [index, savedPath] of savedPaths.entries()) try {
        const raw = readCodeHealthArtifactJson(savedPath, OPPORTUNITY_EVIDENCE_MAX_BYTES);
        const evidence = projectGardenerOpportunityEvidence(raw, repository, fixedClock(now));
        if (evidence.state !== "reported") { invalid++; continue; }
        if (!evidence.oldestReconciledAt) { if (index === 0) missing++; continue; }
        clocks.push(evidence.oldestReconciledAt);
        stale ||= now - Date.parse(evidence.oldestReconciledAt) > CODE_HEALTH_INTERVAL_MS;
        for (const row of raw as Array<{ proposalId: string; candidate: { repo: string; key: string }; task?: { repo?: string; key?: string; id?: string }; pr?: { repo?: string; taskId?: string; url?: string }; improvement?: { repository?: string; opportunityId?: string; threadId?: string; snapshotId?: string; taskIds?: string[]; sourceVerified?: boolean } }>) {
          const source = row.improvement;
          if (source && source.sourceVerified !== false && source.repository === repository && typeof source.opportunityId === "string" && source.opportunityId.startsWith(`${repository}/codeql-quality:`) && source.opportunityId.length <= 1024 &&
              typeof source.snapshotId === "string" && /^[a-f0-9]{64}$/.test(source.snapshotId) && typeof source.threadId === "string" && /^thread:[A-Za-z0-9:._/-]{1,500}$/.test(source.threadId) &&
              Array.isArray(source.taskIds) && source.taskIds.length <= 64 && source.taskIds.every(id => /^[A-Z][A-Z0-9]*-T[0-9]+[A-Za-z]?$/.test(id))) {
            const proposalId = source.opportunityId.slice(repository.length + 1), tasks = source.taskIds.length ? source.taskIds : [undefined];
            for (const taskId of tasks) work.push({ repository, proposalId, threadId: source.threadId, ...(taskId ? { taskId } : {}),
              ...(row.pr?.repo?.toLowerCase() === repository && row.pr.taskId === taskId && repositoryPullRequestUrl(row.pr.url, repository) ? { prUrl: row.pr.url } : {}) });
            continue;
          }
          if (!row.task || row.task.repo?.toLowerCase() !== repository || row.task.key !== row.candidate.key || typeof row.task.id !== "string") continue;
          work.push({ repository, proposalId: row.proposalId, taskId: row.task.id,
            ...(row.pr?.repo?.toLowerCase() === repository && row.pr.taskId === row.task.id && repositoryPullRequestUrl(row.pr.url, repository) ? { prUrl: row.pr.url } : {}) });
        }
      } catch (error) {
        // Older publishers do not have the derived projection yet. Its absence does not erase native links.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { if (index === 0) missing++; } else invalid++;
      }
    }
  } catch {
    // deliberate: failed scope reads withhold related-work completeness; they never certify no existing work.
    return { state: "unavailable", asOf: null, work: [], reason: "The configured sources for saved work could not be read or verified." };
  }
  return { state: invalid ? clocks.length ? "partial" : "unavailable" : missing ? clocks.length ? "partial" : "not_collected" : stale ? "stale" : "reported", asOf: clocks.sort()[0] ?? null, work: [...new Map(work.map(row => [JSON.stringify(row), row])).values()],
    reason: invalid ? "Some saved work could not be read or verified. These links may be incomplete." : missing ? "Some saved work has not been collected. These links may be incomplete." : stale ? "Saved work links have not been checked within the daily cadence." : null };
}
