import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync, readSync, realpathSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { systemClock } from "./clock.js";
import { readPidNamespace, testSlotProcessFacts } from "./test-slot.js";

/** Human-approved READY-to-escalation SLA. A repair/restart never renews it. */
export const HEAVY_READY_ESCALATION_MS = 60 * 60_000;
const HEAVY_RECORD_BYTES = 4096;
const HEAVY_MAX_DIRECTORY_ENTRIES = 16_384;
const HEAVY_MAX_ACTIVE = 256;

export interface HeavyBuildReservation {
  version: 2; id: string; label: string; readyAtMs: number; expiresAtMs: number;
  owner: { nonce: string; pid: number; start: string; host: string; namespace: string };
}
export interface HeavyReservationHandle { dir: string; request: HeavyBuildReservation; owned: boolean }
export interface HeavyBuildHold {
  deferred: true; requestId: string; readyAtMs: number; expiresAtMs: number; detail: string;
}
interface HeavyReadyClosure { version: 2; requestHash: string; nonce: string; kind: "released" | "escalated"; atMs: number }
type HeavyReadyLog = (step: string, fields: Record<string, unknown>) => unknown;
export type HeavyReservationReading =
  | { state: "clear"; observed: number; pendingEscalations: number }
  | { state: "held"; observed: number; pendingEscalations: number; hold: HeavyBuildHold }
  | { state: "unavailable"; reason: string };
const heavyRecordDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const heavyRecordPath = (dir: string, id: string, suffix = ""): string => join(dir, `heavy-build-${id}${suffix}.json`, "record.json");
const heavyErrorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

// This v2 backend is explicitly single-account, host-local. Nonces/hashes correlate receipts;
// they are NOT authentication on a writable shared directory. Never default to the 0777 slot dir.
function heavyDirectoryIdentity(dir: string): { dev: number; ino: number } {
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || process.getuid?.() !== st.uid || (st.mode & 0o077) !== 0 ||
      realpathSync(dir) !== resolve(dir)) throw new Error("heavy READY directory must be canonical, private and owned by this account");
  if (process.platform === "linux" && ![0xef53, 0x58465342].includes(statfsSync(dir).type)) {
    throw new Error("heavy READY Linux backend requires a verified local ext4/XFS filesystem");
  }
  return { dev: st.dev, ino: st.ino };
}
function assertHeavyDirectoryIdentity(dir: string, before: { dev: number; ino: number }): void {
  const after = heavyDirectoryIdentity(dir);
  if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("heavy READY directory identity changed");
}
function readHeavyRecordBounded(fd: number): string {
  const before = fstatSync(fd);
  if (!before.isFile() || before.size > HEAVY_RECORD_BYTES || before.nlink !== 1 ||
      before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0) throw new Error("heavy READY record must be private, regular, single-link and bounded");
  const buffer = Buffer.alloc(HEAVY_RECORD_BYTES + 1);
  let used = 0;
  while (used < buffer.length) {
    const count = readSync(fd, buffer, used, buffer.length - used, used);
    if (count === 0) break;
    used += count;
  }
  const after = fstatSync(fd);
  if (used > HEAVY_RECORD_BYTES || used !== before.size || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("heavy READY record changed during descriptor read");
  return buffer.subarray(0, used).toString("utf8");
}
function openHeavyRecord(path: Parameters<typeof openSync>[0]): number {
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") throw new Error("safe heavy READY reads unavailable");
  return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
}
function readOptionalHeavyRecord(path: string): unknown {
  try { heavyDirectoryIdentity(dirname(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  let fd: number;
  try { fd = openHeavyRecord(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("published heavy READY envelope is incomplete");
    throw error;
  }
  try { return JSON.parse(readHeavyRecordBounded(fd)); } finally { closeSync(fd); }
}
function flushHeavyDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function publishHeavyRecord(path: string, record: unknown): { created: boolean; value: unknown } {
  const raw = JSON.stringify(record);
  if (Buffer.byteLength(raw) > HEAVY_RECORD_BYTES) throw new Error("heavy READY record exceeds bound");
  const existing = readOptionalHeavyRecord(path);
  if (existing !== undefined) return { created: false, value: existing };
  const envelope = dirname(path), parent = dirname(envelope);
  const stage = mkdtempSync(join(parent, ".heavy-ready-stage-"));
  try {
    writeFileSync(join(stage, "record.json"), raw, { mode: 0o600, flag: "wx", flush: true });
    flushHeavyDirectory(stage);
    try { renameSync(stage, envelope); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // POSIX rename refuses a nonempty target directory. Cooperative writers publish ONLY
      // complete nonempty envelopes, never final-path claims; the first complete record wins.
      return { created: false, value: readOptionalHeavyRecord(path) };
    }
    flushHeavyDirectory(parent);
    return { created: true, value: record };
  } finally { rmSync(stage, { recursive: true, force: true }); } // Our unique stage only, never another owner's record.
}
function validateHeavyRequest(value: unknown): HeavyBuildReservation {
  const r = value as HeavyBuildReservation | undefined;
  if (!r || r.version !== 2 || typeof r.id !== "string" || !/^[a-f0-9]{64}$/.test(r.id) || typeof r.label !== "string" || !r.label || r.label.length > 512 ||
      !Number.isSafeInteger(r.readyAtMs) || r.readyAtMs < 0 || !Number.isSafeInteger(r.expiresAtMs) ||
      r.expiresAtMs !== r.readyAtMs + HEAVY_READY_ESCALATION_MS || !r.owner ||
      typeof r.owner.nonce !== "string" || !r.owner.nonce || !Number.isSafeInteger(r.owner.pid) || r.owner.pid <= 0 ||
      typeof r.owner.start !== "string" || !r.owner.start || typeof r.owner.host !== "string" || !r.owner.host ||
      typeof r.owner.namespace !== "string" || !r.owner.namespace) throw new Error("malformed heavy READY request");
  return r;
}
function validateHeavyClosure(value: unknown, request: HeavyBuildReservation): HeavyReadyClosure | undefined {
  if (value === undefined) return undefined;
  const c = value as HeavyReadyClosure;
  if (c.version !== 2 || c.requestHash !== heavyRecordDigest(request) || c.nonce !== request.owner.nonce ||
      !["released", "escalated"].includes(c.kind) || !Number.isSafeInteger(c.atMs) || c.atMs < request.readyAtMs ||
      (c.kind === "released" ? c.atMs >= request.expiresAtMs : c.atMs !== request.expiresAtMs)) throw new Error("foreign or malformed heavy READY closure");
  return c;
}
function closeHeavyRequest(dir: string, request: HeavyBuildReservation, now: number): HeavyReadyClosure {
  const existing = validateHeavyClosure(readOptionalHeavyRecord(heavyRecordPath(dir, request.id, "-closed")), request);
  if (existing) return existing;
  const kind = now >= request.expiresAtMs ? "escalated" : "released";
  const closure: HeavyReadyClosure = { version: 2, requestHash: heavyRecordDigest(request), nonce: request.owner.nonce,
    kind, atMs: kind === "escalated" ? request.expiresAtMs : now };
  // One immutable terminal file: release and expiry cannot publish contradictory terminal states.
  return validateHeavyClosure(publishHeavyRecord(heavyRecordPath(dir, request.id, "-closed"), closure).value, request)!;
}
function heavyOwnerIdentity(): HeavyBuildReservation["owner"] {
  const start = testSlotProcessFacts(process.pid)?.start;
  const namespace = readPidNamespace() ?? (process.platform === "linux" ? undefined : "native-host");
  if (!start || !namespace) throw new Error("heavy READY owner identity unavailable");
  return { nonce: randomUUID(), pid: process.pid, start, host: hostname(), namespace };
}

/** Explicit directory only. Immutable request history survives release, expiry and producer retry. */
export function reserveHeavyNewBuilds(logicalId: string, label: string, opts: { dir: string; now?: number }): HeavyReservationHandle {
  const now = opts.now ?? systemClock.now();
  if (!logicalId || logicalId.length > 512 || !Number.isSafeInteger(now) || now < 0) throw new Error("invalid heavy READY identity/time");
  mkdirSync(opts.dir, { mode: 0o700, recursive: true });
  const identity = heavyDirectoryIdentity(opts.dir), id = heavyRecordDigest(logicalId);
  const candidate = validateHeavyRequest({ version: 2, id, label, readyAtMs: now, expiresAtMs: now + HEAVY_READY_ESCALATION_MS, owner: heavyOwnerIdentity() });
  const result = publishHeavyRecord(heavyRecordPath(opts.dir, id), candidate), request = validateHeavyRequest(result.value);
  if (request.id !== id || request.label !== label) throw new Error("heavy READY request identity changed");
  assertHeavyDirectoryIdentity(opts.dir, identity);
  return { dir: opts.dir, request, owned: result.created };
}

/** Only the actual minting process can release. Late completion records escalation, not success. */
export function releaseHeavyNewBuilds(handle: HeavyReservationHandle, opts: { now?: number } = {}): boolean {
  if (!handle.owned) return false;
  const now = opts.now ?? systemClock.now(), identity = heavyDirectoryIdentity(handle.dir);
  const current = validateHeavyRequest(readOptionalHeavyRecord(heavyRecordPath(handle.dir, handle.request.id)));
  const actual = heavyOwnerIdentity();
  if (heavyRecordDigest(current) !== heavyRecordDigest(handle.request) || current.owner.pid !== actual.pid || current.owner.start !== actual.start ||
      current.owner.host !== actual.host || current.owner.namespace !== actual.namespace) return false;
  if (!Number.isSafeInteger(now) || now < current.readyAtMs) throw new Error("invalid heavy READY release time");
  closeHeavyRequest(handle.dir, current, now);
  assertHeavyDirectoryIdentity(handle.dir, identity);
  return true;
}

function censusHeavyRecords(dir: string): string[] {
  const directory = opendirSync(dir, { bufferSize: 32 }), requests = new Set<string>(), receipts = new Set<string>();
  let entries = 0;
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      if (++entries > HEAVY_MAX_DIRECTORY_ENTRIES) throw new Error("heavy READY directory census incomplete at bounded entry limit; governed archival required");
      if (!entry.name.startsWith("heavy-build-")) continue;
      const match = /^heavy-build-([a-f0-9]{64})(-(?:closed|delivered))?\.json$/.exec(entry.name);
      if (!match || !entry.isDirectory()) throw new Error("malformed or nonregular heavy READY directory entry");
      (match[2] ? receipts : requests).add(match[1]!);
    }
    for (const id of receipts) if (!requests.has(id)) throw new Error("orphan heavy READY receipt; census unavailable");
    return [...requests].sort();
  } finally { directory.closeSync(); }
}

/** A terminal record is an outbox entry. Delivery is at-least-once, with a stable event id. */
function deliverHeavyEscalation(dir: string, request: HeavyBuildReservation, closure: HeavyReadyClosure, log?: HeavyReadyLog): boolean {
  const ackPath = heavyRecordPath(dir, request.id, "-delivered"), ack = readOptionalHeavyRecord(ackPath);
  const expected = { version: 2, closureHash: heavyRecordDigest(closure), eventId: `${request.id}:escalated` };
  if (ack !== undefined) {
    if (heavyRecordDigest(ack) !== heavyRecordDigest(expected)) throw new Error("foreign heavy READY delivery acknowledgement");
    return true;
  }
  if (!log) return false;
  try {
    const accepted = log("heavy_ready.escalated", { event_id: expected.eventId, request_id: request.id,
      ready_at_ms: request.readyAtMs, expires_at_ms: request.expiresAtMs, scope: "NEW-implement-only" });
    if (accepted !== null && (typeof accepted === "object" || typeof accepted === "function") &&
        typeof (accepted as { then?: unknown }).then === "function") {
      void Promise.resolve(accepted).catch(() => {
        // Async acceptance is already refused below: resolution AND rejection leave the same
        // durable outbox pending for a supported sink. Consume only its late process rejection,
        // never turn it into acknowledgement, delivery success or a finished gate.
      });
      throw new Error("heavy READY delivery requires synchronous durable acceptance");
    }
    if (heavyRecordDigest(publishHeavyRecord(ackPath, expected).value) !== heavyRecordDigest(expected)) throw new Error("foreign heavy READY delivery acknowledgement");
    return true;
  } catch { return false; /* No acknowledgement: restart/next read retries. Never reopens admission. */ }
}

/** Unknown never means clear. Closed records are not active-capacity occupants, including on rollback. */
export function readHeavyNewBuildHold(opts: { dir: string; now?: number; log?: HeavyReadyLog }): HeavyReservationReading {
  try {
    const now = opts.now ?? systemClock.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid heavy READY read time");
    const identity = heavyDirectoryIdentity(opts.dir), ids = censusHeavyRecords(opts.dir);
    let hold: HeavyBuildHold | undefined, active = 0, pendingEscalations = 0;
    for (const id of ids) {
      const request = validateHeavyRequest(readOptionalHeavyRecord(heavyRecordPath(opts.dir, id)));
      if (request.id !== id) throw new Error("heavy READY filename identity mismatch");
      let closure = validateHeavyClosure(readOptionalHeavyRecord(heavyRecordPath(opts.dir, id, "-closed")), request);
      if (closure?.kind !== "escalated" && readOptionalHeavyRecord(heavyRecordPath(opts.dir, id, "-delivered")) !== undefined) {
        throw new Error("heavy READY delivery acknowledgement has no escalated closure");
      }
      // Terminal before wall-clock validation: clock rollback never resurrects a closed request.
      if (!closure && request.readyAtMs > now) throw new Error("heavy READY time is in the future; clock/provenance unavailable");
      if (!closure && now >= request.expiresAtMs) closure = closeHeavyRequest(opts.dir, request, now);
      if (closure) {
        if (closure.kind === "escalated" && !deliverHeavyEscalation(opts.dir, request, closure, opts.log)) pendingEscalations++;
        continue;
      }
      if (++active > HEAVY_MAX_ACTIVE) throw new Error("heavy READY active census exceeds bounded capacity");
      if (!hold || request.readyAtMs < hold.readyAtMs || (request.readyAtMs === hold.readyAtMs && id < hold.requestId)) {
        hold = { deferred: true, requestId: id, readyAtMs: request.readyAtMs, expiresAtMs: request.expiresAtMs,
          detail: "bounded heavy READY request reserves NEW implement admissions only" };
      }
    }
    assertHeavyDirectoryIdentity(opts.dir, identity);
    return hold ? { state: "held", observed: ids.length, pendingEscalations, hold } : { state: "clear", observed: ids.length, pendingEscalations };
  } catch (error) { return { state: "unavailable", reason: heavyErrorMessage(error) }; }
}

/** Opt-in composition-root adapter. An absent directory disables it; a configured missing one is UNKNOWN. */
export function heavyNewBuildGate(log: HeavyReadyLog, opts: { dir?: string } = {}): () => HeavyBuildHold | undefined {
  return () => {
    const dir = opts.dir;
    if (dir === undefined) return undefined;
    const reading = readHeavyNewBuildHold({ dir, log });
    if (reading.state === "unavailable") {
      const diagnostic = log("heavy_ready.unavailable", { reason: reading.reason, scope: "NEW-implement-only" });
      if (diagnostic !== null && (typeof diagnostic === "object" || typeof diagnostic === "function") &&
          typeof (diagnostic as { then?: unknown }).then === "function") {
        void Promise.resolve(diagnostic).catch(() => {
          // Diagnostic acceptance is unsupported and cannot clear UNKNOWN: both late resolution
          // and rejection keep the named observation refusal below, without an orphan rejection.
        });
      }
      throw new Error(`heavy READY observation unavailable: ${reading.reason}`);
    }
    return reading.state === "held" ? reading.hold : undefined;
  };
}
