import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { acquireInflightLock, parseInflightLockInfo, type InflightLockHandle } from "./inflight-lock.js";
import { isHolderStale, reclaimStaleLock, writeAtomic } from "./fs-race-safe.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { systemClock } from "./clock.js";
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
export type CodeHealthSnapshotRead = { state: "observed"; snapshot: CodeHealthStoredSnapshot } | { state: "not_collected" | "unavailable"; reason: string };
const CODE_HEALTH_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const evidenceDigest = (value: unknown): string => createHash("sha256").update(canonicalCodeHealthJson(value)).digest("hex");
function boundedEvidenceJson(path: string, maxBytes: number): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
    return { state: "observed", snapshot };
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
    } catch { return false; }
  };
}
function syncEvidenceDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function publishCodeHealthSnapshot(opts: { stateDir: string; input: CodeHealthProjectionInput; expectedSnapshotId: string | null; clock?: import("./clock.js").Clock }):
  { state: "published" | "duplicate"; snapshotId: string } | { state: "busy" | "superseded" | "unavailable"; reason: string } {
  let lock: InflightLockHandle | undefined, owns: (() => boolean) | undefined;
  try {
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
      if (!writeAtomic(path, serialized, { mode: 0o600, beforeRename: owns })) throw new Error("Code health publication ownership changed.");
      syncEvidenceDirectory(dir);
    }
    const pointer: EvidencePointer = { version: "code-health-pointer-v1", repository, snapshotId, attemptAt };
    if (!writeAtomic(join(root, "latest.json"), JSON.stringify(pointer), { mode: 0o600, beforeRename: () => owns!() &&
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
