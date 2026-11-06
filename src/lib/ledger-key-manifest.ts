/**
 * W1-T11423 — which keys each rotated ledger archive holds, so a keyed question opens only the archives
 * that can answer it.
 *
 * OBSERVED 2026-11-05: core aborted at its heap limit every ~25 min (29 boots in nine hours) because
 * dep-review's proposalProgress materialised every row of ~394 archives (~9 million rows) to filter about
 * a dozen by task_id. A rotated archive never changes, so the set of task ids, PR numbers, run ids and
 * steps it holds, and its time range, can be learned ONCE and kept beside it. The manifest lives in the
 * same durable store as the per-reader rotation digests (cache/rotation-digests/<holder>/<archive>.json),
 * keyed the same way (archive name, size, mtime, reducer version), and a stale, damaged or foreign one is
 * rebuilt, never trusted.
 */
import { createReadStream, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createGunzip, gunzipSync } from "node:zlib";

/** The reserved holder name in the rotation-digests store; no reader's digest may use it. */
export const LEDGER_KEY_MANIFEST_HOLDER = "ledger-key-manifest";
/** Bump whenever {@link ledgerRowKeys} or the manifest's shape changes: every manifest is then rebuilt. */
export const LEDGER_KEY_MANIFEST_VERSION = "2";

export interface LedgerKeyManifest {
  /** Earliest and latest parseable `ts` strings; undefined when none were parseable. */
  minTs?: string;
  maxTs?: string;
  hasInvalidStringTs: boolean;
  taskIds: string[];
  prNumbers: number[];
  runIds: string[];
  steps: string[];
  rows: number;
}

export interface LedgerKeyQuery {
  taskIds?: readonly string[];
  prNumbers?: readonly number[];
  runIds?: readonly string[];
  steps?: readonly string[];
  since?: string;
}

export interface LedgerManifestEntry {
  path: string;
  form: "gzip" | "plain";
}

export type LedgerKeyManifestRead =
  | { kind: "hit"; manifest: LedgerKeyManifest }
  | { kind: "built"; manifest: LedgerKeyManifest; rebuiltBecause: "missing" | "stale" | "damaged" | "foreign" | "version"; writeFailed: boolean }
  | { kind: "unbuildable"; error: string };

const PR_URL = /\/pull\/(\d+)(?:$|[/?#])/;

function prNumberOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

/** The PR numbers a row names, by any of the fields the fleet writes them in. */
export function ledgerRowPrNumbers(row: Record<string, unknown>): number[] {
  const out = new Set<number>();
  for (const value of [row.pr_number, row.pr]) {
    const n = prNumberOf(value);
    if (n !== undefined) out.add(n);
  }
  if (typeof row.pr_url === "string") {
    const match = PR_URL.exec(row.pr_url);
    if (match) out.add(Number(match[1]));
  }
  return [...out];
}

/** The keys one row contributes to its archive's manifest. */
export function ledgerRowKeys(row: Record<string, unknown>): { taskId?: string; runId?: string; step?: string; prNumbers: number[]; ts?: string } {
  return {
    ...(typeof row.task_id === "string" ? { taskId: row.task_id } : {}),
    ...(typeof row.run_id === "string" ? { runId: row.run_id } : {}),
    ...(typeof row.step === "string" ? { step: row.step } : {}),
    ...(typeof row.ts === "string" ? { ts: row.ts } : {}),
    prNumbers: ledgerRowPrNumbers(row),
  };
}

/** Whether a query names any key at all (a steps-only or since-only query names none). */
export function ledgerQueryIsKeyed(query: LedgerKeyQuery): boolean {
  return (query.taskIds?.length ?? 0) > 0 || (query.prNumbers?.length ?? 0) > 0 || (query.runIds?.length ?? 0) > 0;
}

/** The row-level form of a query's KEYS: true when the row names a requested task id, PR number or run id,
 *  or when the query names no key. Steps and since are the union's own filters, applied beside this one. */
export function ledgerRowMatchesKeys(row: Record<string, unknown>, query: LedgerKeyQuery): boolean {
  if (!ledgerQueryIsKeyed(query)) return true;
  if (query.taskIds?.length && typeof row.task_id === "string" && query.taskIds.includes(row.task_id)) return true;
  if (query.runIds?.length && typeof row.run_id === "string" && query.runIds.includes(row.run_id)) return true;
  if (query.prNumbers?.length) {
    for (const n of ledgerRowPrNumbers(row)) if (query.prNumbers.includes(n)) return true;
  }
  return false;
}

/** Whether an archive with this manifest can hold a row the query keeps. Exact: the key sets are complete. */
export function ledgerManifestMayHold(manifest: LedgerKeyManifest, query: LedgerKeyQuery): boolean {
  if (query.since !== undefined) {
    const since = Date.parse(query.since);
    // The union retains invalid strings (NaN < since is false), but rejects missing/non-string stamps.
    if (!Number.isNaN(since) && !manifest.hasInvalidStringTs &&
        (manifest.maxTs === undefined || Date.parse(manifest.maxTs) < since)) return false;
  }
  if (query.steps?.length && !query.steps.some((step) => manifest.steps.includes(step))) return false;
  if (!ledgerQueryIsKeyed(query)) return true;
  return (query.taskIds ?? []).some((id) => manifest.taskIds.includes(id)) ||
    (query.runIds ?? []).some((id) => manifest.runIds.includes(id)) ||
    (query.prNumbers ?? []).some((n) => manifest.prNumbers.includes(n));
}

class ManifestBuilder {
  private readonly taskIds = new Set<string>();
  private readonly prNumbers = new Set<number>();
  private readonly runIds = new Set<string>();
  private readonly steps = new Set<string>();
  private minTs: string | undefined;
  private maxTs: string | undefined;
  private minMs = Number.POSITIVE_INFINITY;
  private maxMs = Number.NEGATIVE_INFINITY;
  private hasInvalidStringTs = false;
  private rows = 0;

  line(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      // deliberate: a torn line names no verifiable key, so no keyed query can ever keep it.
      return;
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) return;
    this.rows += 1;
    const keys = ledgerRowKeys(row as Record<string, unknown>);
    if (keys.taskId !== undefined) this.taskIds.add(keys.taskId);
    if (keys.runId !== undefined) this.runIds.add(keys.runId);
    if (keys.step !== undefined) this.steps.add(keys.step);
    for (const n of keys.prNumbers) this.prNumbers.add(n);
    if (keys.ts !== undefined) {
      const ms = Date.parse(keys.ts);
      if (!Number.isNaN(ms)) {
        if (ms < this.minMs) { this.minMs = ms; this.minTs = keys.ts; }
        if (ms > this.maxMs) { this.maxMs = ms; this.maxTs = keys.ts; }
      } else this.hasInvalidStringTs = true;
    }
  }

  done(): LedgerKeyManifest {
    return {
      ...(this.minTs !== undefined ? { minTs: this.minTs } : {}),
      ...(this.maxTs !== undefined ? { maxTs: this.maxTs } : {}),
      hasInvalidStringTs: this.hasInvalidStringTs,
      taskIds: [...this.taskIds].sort(),
      prNumbers: [...this.prNumbers].sort((a, b) => a - b),
      runIds: [...this.runIds].sort(),
      steps: [...this.steps].sort(),
      rows: this.rows,
    };
  }
}

function buildFromBuffer(buf: Buffer): LedgerKeyManifest {
  const builder = new ManifestBuilder();
  let start = 0;
  // Scan, never split: one archive's decoded text is held once, not as an array of every line.
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end < 0) end = buf.length;
    builder.line(buf.toString("utf8", start, end));
    start = end + 1;
  }
  return builder.done();
}

async function buildStreamed(entry: LedgerManifestEntry): Promise<LedgerKeyManifest> {
  const builder = new ManifestBuilder();
  const source = createReadStream(entry.path);
  const input = entry.form === "gzip" ? source.pipe(createGunzip()) : source;
  const decoder = new StringDecoder("utf8");
  let carry = "";
  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      const text = carry + decoder.write(chunk);
      let start = 0;
      for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
        builder.line(text.slice(start, end));
        start = end + 1;
      }
      carry = text.slice(start);
    }
    carry += decoder.end();
    if (carry) builder.line(carry);
  } finally {
    input.destroy();
    source.destroy();
  }
  return builder.done();
}

export interface LedgerKeyManifestFs {
  readFileSync: (path: string) => Buffer;
  writeFileSync: (path: string, data: string, opts: { flag: string; mode: number }) => void;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (path: string) => void;
  mkdirSync: (path: string, opts: { recursive: true; mode: number }) => void;
  readdirSync: (path: string) => string[];
  statSync: (path: string) => { size: number; mtimeMs: number };
  gunzipSync: (buf: Buffer) => Buffer;
}

export const realLedgerKeyManifestFs: LedgerKeyManifestFs = {
  readFileSync: (path) => readFileSync(path),
  writeFileSync: (path, data, opts) => writeFileSync(path, data, opts),
  renameSync: (from, to) => renameSync(from, to),
  unlinkSync: (path) => unlinkSync(path),
  mkdirSync: (path, opts) => { mkdirSync(path, opts); },
  readdirSync: (path) => readdirSync(path),
  statSync: (path) => statSync(path),
  gunzipSync: (buf) => gunzipSync(buf),
};

/** Where an archive's manifest lives: the rotation-digests store, under the reserved holder. */
export function ledgerKeyManifestDirectory(stateDir: string): string {
  return join(stateDir, "cache", "rotation-digests", encodeURIComponent(LEDGER_KEY_MANIFEST_HOLDER).replaceAll(".", "%2E"));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validManifest(value: unknown): value is LedgerKeyManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  return isStringArray(m.taskIds) && isStringArray(m.runIds) && isStringArray(m.steps) &&
    typeof m.hasInvalidStringTs === "boolean" &&
    Array.isArray(m.prNumbers) && m.prNumbers.every((n) => Number.isSafeInteger(n)) &&
    Number.isSafeInteger(m.rows) && (m.minTs === undefined || typeof m.minTs === "string") &&
    (m.maxTs === undefined || typeof m.maxTs === "string");
}

type CachedVerdict = { kind: "hit"; manifest: LedgerKeyManifest } | { kind: "missing" | "stale" | "damaged" | "foreign" | "version" };

function readCached(path: string, archive: string, key: string, fs: LedgerKeyManifestFs): CachedVerdict {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(path);
  } catch {
    // deliberate: no manifest yet (or an unreadable one) is a miss, and the archive itself is read.
    return { kind: "missing" };
  }
  let digest: Record<string, unknown>;
  try {
    digest = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  } catch {
    // deliberate: a torn manifest is rebuilt from the archive, never trusted.
    return { kind: "damaged" };
  }
  if (digest === null || typeof digest !== "object" || digest.schema !== 1) return { kind: "damaged" };
  if (digest.holder !== LEDGER_KEY_MANIFEST_HOLDER || digest.archive !== archive) return { kind: "foreign" };
  if (digest.reducerVersion !== LEDGER_KEY_MANIFEST_VERSION) return { kind: "version" };
  if (digest.key !== key) return { kind: "stale" };
  return validManifest(digest.manifest) ? { kind: "hit", manifest: digest.manifest } : { kind: "damaged" };
}

function writeManifest(directory: string, path: string, archive: string, key: string, manifest: LedgerKeyManifest, fs: LedgerKeyManifestFs): boolean {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, JSON.stringify({ schema: 1, holder: LEDGER_KEY_MANIFEST_HOLDER, reducerVersion: LEDGER_KEY_MANIFEST_VERSION,
      archive, key, manifest }), { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, path);
    return true;
  } catch {
    // deliberate: an unwritable manifest costs the next lookup one more build, never this one its answer.
    try { fs.unlinkSync(temp); } catch { /* deliberate: no temp file was left */ }
    return false;
  }
}

function identity(entry: LedgerManifestEntry, stateDir: string, fs: LedgerKeyManifestFs): { directory: string; path: string; archive: string; key: string } {
  const stat = fs.statSync(entry.path);
  const archive = basename(entry.path);
  const directory = ledgerKeyManifestDirectory(stateDir);
  return { directory, path: join(directory, `${archive}.json`), archive, key: `${stat.size}:${stat.mtimeMs}` };
}

/** The manifest of one rotated archive: read from the store when it is current, else built from the
 *  archive (streamed) and stored for every later lookup. An archive that cannot be read is `unbuildable`,
 *  and the caller must read it in full rather than skip it. */
export async function readLedgerKeyManifest(
  stateDir: string,
  entry: LedgerManifestEntry,
  fs: LedgerKeyManifestFs = realLedgerKeyManifestFs,
): Promise<LedgerKeyManifestRead> {
  let id: ReturnType<typeof identity>;
  try {
    id = identity(entry, stateDir, fs);
  } catch (error) {
    return { kind: "unbuildable", error: (error as NodeJS.ErrnoException).code ?? (error as Error).name };
  }
  const cached = readCached(id.path, id.archive, id.key, fs);
  if (cached.kind === "hit") return cached;
  let manifest: LedgerKeyManifest;
  try {
    manifest = await buildStreamed(entry);
  } catch (error) {
    return { kind: "unbuildable", error: (error as NodeJS.ErrnoException).code ?? (error as Error).name };
  }
  const written = writeManifest(id.directory, id.path, id.archive, id.key, manifest, fs);
  return { kind: "built", manifest, rebuiltBecause: cached.kind, writeFailed: !written };
}

/** {@link readLedgerKeyManifest} for a synchronous reader: the archive is decoded whole, one at a time. */
export function readLedgerKeyManifestSync(
  stateDir: string,
  entry: LedgerManifestEntry,
  fs: LedgerKeyManifestFs = realLedgerKeyManifestFs,
): LedgerKeyManifestRead {
  let id: ReturnType<typeof identity>;
  try {
    id = identity(entry, stateDir, fs);
  } catch (error) {
    return { kind: "unbuildable", error: (error as NodeJS.ErrnoException).code ?? (error as Error).name };
  }
  const cached = readCached(id.path, id.archive, id.key, fs);
  if (cached.kind === "hit") return cached;
  let manifest: LedgerKeyManifest;
  try {
    const buf = fs.readFileSync(entry.path);
    manifest = buildFromBuffer(entry.form === "gzip" ? fs.gunzipSync(buf) : buf);
  } catch (error) {
    return { kind: "unbuildable", error: (error as NodeJS.ErrnoException).code ?? (error as Error).name };
  }
  const written = writeManifest(id.directory, id.path, id.archive, id.key, manifest, fs);
  return { kind: "built", manifest, rebuiltBecause: cached.kind, writeFailed: !written };
}

/** Removes manifests of archives that no longer exist; returns how many it removed. */
export function pruneLedgerKeyManifests(stateDir: string, liveArchives: ReadonlySet<string>, fs: LedgerKeyManifestFs = realLedgerKeyManifestFs): number {
  const directory = ledgerKeyManifestDirectory(stateDir);
  let pruned = 0;
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    // deliberate: no manifest directory yet leaves nothing to prune.
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(".json") || liveArchives.has(name.slice(0, -".json".length))) continue;
    try {
      fs.unlinkSync(join(directory, name));
      pruned += 1;
    } catch {
      // deliberate: a manifest another process already removed is not this prune's failure.
    }
  }
  return pruned;
}
