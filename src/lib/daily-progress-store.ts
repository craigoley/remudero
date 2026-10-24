import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateDailyProgressReport, type DailyProgressEvent, type DailyProgressReport } from "./daily-progress-contract.js";
import { withWriteTransaction, type ReadModelDb, type ReadModelLease } from "./read-model-db.js";

export type DailyProgressRecord = Omit<DailyProgressReport, "revision" | "correctionReason" | "events" | "page"> & { events: DailyProgressEvent[] };
export interface DailyProgressRevision { generation: number; report: Omit<DailyProgressReport, "events" | "page">; events: DailyProgressEvent[] }
export interface DailyProgressJob {
  id: string; lastAttemptAt: string; lastSuccessAt: string | null; nextDueAt: string;
  closedThrough: string | null; error: string | null;
}
interface DailyDay { repository: string; timeZone: string; reportDate: string; revisions: string[] }
export interface DailyProgressManifest { version: 1; generation: number; days: Record<string, DailyDay>; jobs: Record<string, DailyProgressJob> }
export interface DailyProgressPublication { baseGeneration: number; manifestBody: string }

/** Durable state deliberately does not resolve RMD_READ_MODEL_DB_DIR. */
export const dailyProgressStorePath = (stateDir: string): string => join(stateDir, "daily-progress", "v1");
const hash = (body: string): string => createHash("sha256").update(body).digest("hex");
export const dailyProgressDayKey = (repository: string, timeZone: string, date: string): string => hash(JSON.stringify([repository.toLowerCase(), timeZone, date]));
const HASH = /^[a-f0-9]{64}$/;
/** BACKSTOP: refuse an oversized durable object; never silently truncate the counted population. */
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;

function read(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_OBJECT_BYTES) throw new Error("daily history object is not a bounded regular file");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function durableWrite(path: string, body: string): void {
  if (Buffer.byteLength(body) > MAX_OBJECT_BYTES) throw new Error("daily history object exceeds its storage bound");
  const stage = `${path}.stage-${randomUUID()}`;
  try {
    const fd = openSync(stage, "wx", 0o600);
    try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(stage, path);
  } finally {
    if (existsSync(stage)) rmSync(stage);
  }
}

export function readDailyProgressManifest(stateDir: string): DailyProgressManifest {
  const path = join(dailyProgressStorePath(stateDir), "manifest.json");
  let body: string;
  try { body = read(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const root = dailyProgressStorePath(stateDir);
      if (existsSync(root) && readdirSync(root).some(name => name.endsWith(".json"))) throw new Error("daily history manifest is missing beside retained evidence; preserved for diagnosis");
      return { version: 1, generation: 0, days: {}, jobs: {} };
    }
    throw error;
  }
  return parseManifest(body);
}

function parseManifest(body: string): DailyProgressManifest {
  // BACKSTOP: a short manifest commit cannot become an unbounded projector transaction.
  if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error("daily manifest exceeds its bounded publication size");
  const m = JSON.parse(body) as DailyProgressManifest;
  if (!m || m.version !== 1 || !Number.isSafeInteger(m.generation) || m.generation < 1 || !m.days || !m.jobs ||
      Array.isArray(m.days) || Array.isArray(m.jobs) || Object.entries(m.days).some(([key, day]) =>
        !day || typeof day.repository !== "string" || typeof day.timeZone !== "string" || typeof day.reportDate !== "string" ||
        key !== dailyProgressDayKey(day.repository, day.timeZone, day.reportDate) || !Array.isArray(day.revisions) ||
        !day.revisions.length || !day.revisions.every(h => typeof h === "string" && HASH.test(h)))) throw new Error("daily history manifest is corrupt; preserved for diagnosis");
  for (const [id, job] of Object.entries(m.jobs)) {
    if (!job || job.id !== id || ![job.lastAttemptAt, job.nextDueAt].every(t => typeof t === "string" && Number.isFinite(Date.parse(t))) ||
        !(job.lastSuccessAt === null || typeof job.lastSuccessAt === "string" && Number.isFinite(Date.parse(job.lastSuccessAt))) ||
        !(job.closedThrough === null || /^\d{4}-\d\d-\d\d$/.test(job.closedThrough)) || !(job.error === null || typeof job.error === "string")) throw new Error("daily job receipt is corrupt; preserved for diagnosis");
  }
  return m;
}

export function readDailyProgressRevision(stateDir: string, day: DailyDay, revision = day.revisions.length): DailyProgressRevision {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > day.revisions.length) throw new RangeError("unknown daily report revision");
  const digest = day.revisions[revision - 1]!;
  const body = read(join(dailyProgressStorePath(stateDir), `${digest}.json`));
  if (hash(body) !== digest) throw new Error("daily history checksum differs; preserved for diagnosis");
  const value = JSON.parse(body) as DailyProgressRevision;
  if (!value || !Number.isSafeInteger(value.generation) || value.generation < 1 || !value.report || !Array.isArray(value.events) || value.report.revision !== revision || value.report.scope.kind !== "repository" ||
      value.report.scope.repository !== day.repository || value.report.timeZone !== day.timeZone || value.report.reportDate !== day.reportDate) throw new Error("daily history identity differs; preserved for diagnosis");
  for (let offset = 0; offset < Math.max(1, value.events.length); offset += 200) {
    const valid = validateDailyProgressReport({ ...value.report, events: value.events.slice(offset, offset + 200), page: { totalEvents: value.events.length, nextCursor: offset + 200 < value.events.length ? "retained" : null } });
    if (!valid.ok) throw new Error(`daily history evidence is corrupt: ${valid.reason}`);
  }
  return value;
}

const eventContent = ({ observedAt: _observedAt, ...event }: DailyProgressEvent): string => JSON.stringify(event);

/** Stage immutable objects before taking the short SQLite ownership fence. Manifest is the authority. */
export function prepareDailyProgressPublication(stateDir: string, records: readonly DailyProgressRecord[], jobs: readonly DailyProgressJob[]): {
  manifest: DailyProgressManifest;
  publication: DailyProgressPublication;
  commit(db: ReadModelDb, lease: ReadModelLease, stillCurrent?: () => boolean): void;
} {
  const base = readDailyProgressManifest(stateDir), manifest = structuredClone(base);
  const root = dailyProgressStorePath(stateDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const seenDays = new Set<string>();
  for (const input of records) {
    if (input.scope.kind !== "repository") throw new Error("canonical daily records must name one repository");
    const repository = input.scope.repository.toLowerCase(), key = dailyProgressDayKey(repository, input.timeZone, input.reportDate);
    if (seenDays.has(key)) throw new Error("duplicate daily publication identity");
    seenDays.add(key);
    const day = manifest.days[key], old = day ? readDailyProgressRevision(stateDir, day) : undefined;
    const events = new Map(old?.events.map(e => [e.id, e]) ?? []);
    const incoming = new Map<string, DailyProgressEvent>();
    for (const event of input.events) {
      if (incoming.has(event.id) && eventContent(incoming.get(event.id)!) !== eventContent(event)) throw new Error("conflicting daily event identity");
      incoming.set(event.id, event);
      const previous = events.get(event.id);
      events.set(event.id, previous && eventContent(previous) === eventContent(event) ? previous : event);
    }
    const { events: _events, ...metadata } = input;
    const all = [...events.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
    const confirmed = all.filter(e => e.kind === "merged" && e.fleetAttribution === "confirmed");
    const tasks = new Set(confirmed.flatMap(e => e.taskIds.map(id => JSON.stringify([e.repository.toLowerCase(), id]))));
    const core = { ...metadata, scope: { kind: "repository" as const, repository }, totals: {
      mergedChanges: { ...metadata.totals.mergedChanges, value: metadata.totals.mergedChanges.precision === "unavailable" ? null : confirmed.length },
      completedTasks: { ...metadata.totals.completedTasks, value: metadata.totals.completedTasks.precision === "unavailable" ? null : tasks.size },
    } };
    if (old) {
      const { revision: _revision, correctionReason: _reason, ...previous } = old.report;
      if (previous.phase === "corrected") previous.phase = "complete";
      if (isDeepStrictEqual(previous, core) && isDeepStrictEqual(old.events, all)) continue;
    }
    const report = { ...core, revision: (day?.revisions.length ?? 0) + 1, correctionReason: old && Date.parse(input.windowEnd) <= Date.parse(input.generatedAt) ? "Source evidence changed after this day ended." : null };
    if (report.correctionReason && report.phase === "complete") report.phase = "corrected";
    const value: DailyProgressRevision = { generation: base.generation + 1, report, events: all };
    // Validate every retained event, not only the first public page.
    for (let offset = 0; offset < Math.max(1, all.length); offset += 200) {
      const valid = validateDailyProgressReport({ ...report, events: all.slice(offset, offset + 200), page: { totalEvents: all.length, nextCursor: offset + 200 < all.length ? "retained" : null } });
      if (!valid.ok) throw new Error(`daily publication refused: ${valid.reason}`);
    }
    const body = JSON.stringify(value), digest = hash(body), path = join(root, `${digest}.json`);
    if (!existsSync(path)) durableWrite(path, body);
    else if (read(path) !== body) throw new Error("daily history checksum collision");
    manifest.days[key] = { repository, timeZone: input.timeZone, reportDate: input.reportDate, revisions: [...day?.revisions ?? [], digest] };
  }
  for (const job of jobs) manifest.jobs[job.id] = structuredClone(job);
  manifest.generation++;
  const publication: DailyProgressPublication = { baseGeneration: base.generation, manifestBody: JSON.stringify(manifest) };
  parseManifest(publication.manifestBody);
  // Immutable objects must be durable before the manifest can name them.
  syncDirectory(root);
  return { manifest, publication, commit: (db, lease, stillCurrent) => commitDailyProgressPublication(stateDir, publication, db, lease, stillCurrent) };
}

/** Called by the owning projector with its already-open DB, never by the HTTP reader. */
export function commitDailyProgressPublication(stateDir: string, publication: DailyProgressPublication, db: ReadModelDb, lease: ReadModelLease, stillCurrent: () => boolean = () => true): void {
  if (!Number.isSafeInteger(publication.baseGeneration) || publication.baseGeneration < 0 ||
      parseManifest(publication.manifestBody).generation !== publication.baseGeneration + 1) throw new Error("invalid staged daily publication generation");
  const root = dailyProgressStorePath(stateDir);
  withWriteTransaction(db, lease, () => {
    if (!stillCurrent()) throw new Error("daily publication lost its source ownership epoch");
    const manifestPath = join(root, "manifest.json");
    const currentGeneration = !existsSync(manifestPath) && publication.baseGeneration === 0 ? 0 : readDailyProgressManifest(stateDir).generation;
    if (currentGeneration !== publication.baseGeneration) throw new Error("daily publication was superseded by another writer");
    durableWrite(manifestPath, publication.manifestBody);
    syncDirectory(root);
  });
}
