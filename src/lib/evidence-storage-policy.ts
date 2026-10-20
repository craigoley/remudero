import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const STORAGE_IDLE_MS = 6 * 60 * 60 * 1000;
export const STORAGE_OBSERVATION_MAX_AGE_MS = 60_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const record = (x: unknown): Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
const bytes = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

/** A truncated capture can never turn back into complete evidence. */
export class BoundedStorageCapture {
  private readonly storage: Buffer;
  private readonly limit: number;
  private used = 0;
  private exceeded = false;
  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MANIFEST_BYTES) throw new Error('invalid storage capture bound');
    this.limit = limit;
    this.storage = Buffer.alloc(limit);
  }
  append(chunk: Buffer): void {
    const remaining = this.limit - this.used;
    if (chunk.length > remaining) this.exceeded = true;
    const kept = chunk.subarray(0, remaining);
    kept.copy(this.storage, this.used); this.used += kept.length;
  }
  finish(): { bytes: Buffer; complete: boolean } {
    return { bytes: Buffer.from(this.storage.subarray(0, this.used)), complete: !this.exceeded };
  }
}

/** Read only an explicit account-private, bounded manifest; never walk its artifact paths. */
export function readStorageObservation(path: string): unknown {
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) || realpathSync(dirname(path)) !== resolve(dirname(path))) throw new Error('unverified observation directory');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid?.() || before.nlink !== 1 || (before.mode & 0o077) || before.size > MAX_MANIFEST_BYTES) throw new Error('unverified observation file');
    const capture = new BoundedStorageCapture(MAX_MANIFEST_BYTES), buffer = Buffer.alloc(8192);
    let offset = 0;
    // Bound reads even if a concurrent writer continually grows the file.
    while (offset <= before.size) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, before.size + 1 - offset), offset);
      if (!n) break;
      capture.append(buffer.subarray(0, n)); offset += n;
    }
    const after = fstatSync(fd), named = lstatSync(path), result = capture.finish();
    if (!result.complete || offset !== before.size || [after, named].some(s => s.dev !== before.dev || s.ino !== before.ino || s.size !== before.size || s.mtimeMs !== before.mtimeMs || s.ctimeMs !== before.ctimeMs)) throw new Error('observation changed during bounded read');
    return JSON.parse(result.bytes.toString('utf8')) as unknown;
  } finally { closeSync(fd); }
}

export interface StorageRetentionProposal {
  version: 1;
  state: 'complete-proposal' | 'unknown';
  enabled: boolean;
  destructiveActionAllowed: false;
  automaticPromotionAllowed: false;
  decisions: { id: string; disposition: 'KEEP' | 'ELIGIBLE_FOR_FRESH_RECHECK'; reason: string; estimatedBytes: number | null }[];
  producer: { disposition: 'FIT_PROPOSAL' | 'REFUSE' | 'UNKNOWN'; reason: string; estimatedBytes: number | null };
  observedFreeBytesDelta: number | null;
}

/** Proposal only: immutable evidence and uncertainty never become deletion authority. */
export function evaluateStorageRetention(input: unknown, nowMs: number): StorageRetentionProposal {
  const packet = record(input);
  const result: StorageRetentionProposal = {
    version: 1, state: 'unknown', enabled: packet.enabled === true,
    destructiveActionAllowed: false, automaticPromotionAllowed: false, decisions: [],
    producer: { disposition: 'UNKNOWN', reason: 'no verified producer budget', estimatedBytes: null },
    observedFreeBytesDelta: null,
  };
  const fresh = bytes(nowMs) && bytes(packet.observedAtMs) && packet.observedAtMs <= nowMs && nowMs - packet.observedAtMs <= STORAGE_OBSERVATION_MAX_AGE_MS;
  if (packet.version !== 1 || !fresh || !Array.isArray(packet.rows) || packet.rows.length > 1000) return result;
  result.state = 'complete-proposal';
  const ids = new Set<string>();
  for (let i = 0; i < packet.rows.length; i++) {
    const row = record(packet.rows[i]);
    const validId = typeof row.id === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(row.id) && !ids.has(row.id);
    const id = validId ? row.id as string : `unknown-row-${i}`;
    ids.add(id);
    const decision: StorageRetentionProposal['decisions'][number] = { id, disposition: 'KEEP', reason: 'unverified artifact metadata', estimatedBytes: null };
    result.decisions.push(decision);
    if (!validId) continue;
    if (row.kind === 'durable-evidence' || row.outcome !== 'passed') { decision.reason = 'retain durable, failed, refused or incomplete evidence'; continue; }
    if (!result.enabled) { decision.reason = 'policy default-off'; continue; }
    if (row.kind === 'dependency-generation') { decision.reason = 'administrator-wide fresh recheck required'; continue; }
    if (row.kind !== 'regenerable-cache' || !bytes(row.mtimeMs) || !bytes(row.ctimeMs) || !bytes(row.sizeBytes)) continue;
    if (nowMs - row.mtimeMs < STORAGE_IDLE_MS || nowMs - row.ctimeMs < STORAGE_IDLE_MS) { decision.reason = 'mtime and ctime must both be six hours stale'; continue; }
    if ([row.ownerVerified, row.closed, row.unusedVerified, row.unreferencedVerified, row.regenerableVerified].some(x => x !== true)) continue;
    decision.disposition = 'ELIGIBLE_FOR_FRESH_RECHECK'; decision.reason = 'closed regenerable cache; executor must repeat all safety checks'; decision.estimatedBytes = row.sizeBytes;
  }
  const p = record(packet.producer);
  if ([p.availableBytes, p.reservedBytes, p.estimatedScratchBytes, p.estimatedOutputBytes, p.minimumReserveBytes, p.maxCaptureBytes].every(bytes)) {
    const available = p.availableBytes as number, reserved = p.reservedBytes as number;
    const scratch = p.estimatedScratchBytes as number, output = p.estimatedOutputBytes as number;
    const total = scratch + output + reserved + (p.minimumReserveBytes as number);
    if (Number.isSafeInteger(total)) result.producer = output > (p.maxCaptureBytes as number) || total > available
      ? { disposition: 'REFUSE', reason: 'priced scratch/output/reserve exceeds available capacity or capture limit', estimatedBytes: scratch + output }
      : { disposition: 'FIT_PROPOSAL', reason: 'estimates fit; native admission and existing reserve policy still required', estimatedBytes: scratch + output };
  }
  const m = record(packet.measurement);
  if (m.kind === 'observed' && m.positiveControlPassed === true && typeof m.source === 'string' && m.source.length > 0 && m.source.length <= 160 && bytes(m.beforeFreeBytes) && bytes(m.afterFreeBytes)) result.observedFreeBytesDelta = m.afterFreeBytes - m.beforeFreeBytes;
  return result;
}
