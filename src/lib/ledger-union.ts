import { createReadStream, existsSync as nodeExistsSync, readFileSync as nodeReadFileSync, readdirSync as nodeReaddirSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip, gunzipSync as nodeGunzipSync } from "node:zlib";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { NEVER_ROTATE_FILENAME } from "./log-rotation.js";

export interface LedgerGrepFsDeps {
  readdirSync: (dir: string) => string[];
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => Buffer;
  gunzipSync: (buf: Buffer) => Buffer;
}

const realLedgerFs: LedgerGrepFsDeps = {
  readdirSync: (dir) => nodeReaddirSync(dir),
  existsSync: (path) => nodeExistsSync(path),
  readFileSync: (path) => nodeReadFileSync(path),
  gunzipSync: (buf) => nodeGunzipSync(buf),
};

export interface LedgerUnionResult {
  stateDir: string;
  archiveFiles: string[];
  archiveCount: number;
  liveFileRead: boolean;
  unread: string[];
  unclassified?: string[];
  ok: boolean;
  matches: string[];
}

export interface LedgerUnionOptions {
  since?: string;
  sinceTs?: string;
  step?: string | readonly string[];
}

export type LedgerFileForm = "gzip" | "plain";

export interface LedgerCorpusEntry {
  path: string;
  form: LedgerFileForm;
}

export function ledgerLivePath(stateDir: string): string {
  return join(stateDir, LEDGER_FILENAME);
}

export function ledgerRotationEntries(names: string[], stateDir: string): LedgerCorpusEntry[] {
  return names
    .filter((n) => n.startsWith("ledger.") && n !== NEVER_ROTATE_FILENAME)
    .map((n): LedgerCorpusEntry | undefined => {
      if (n.endsWith(".ndjson.gz")) return { path: join(stateDir, n), form: "gzip" };
      if (n.endsWith(".ndjson")) return { path: join(stateDir, n), form: "plain" };
      return undefined;
    })
    .filter((e): e is LedgerCorpusEntry => e !== undefined)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function rotationStampIso(name: string): string | undefined {
  const m = /^ledger\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.ndjson(?:\.gz)?$/.exec(name);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : undefined;
}

const MAX_PATTERN_LENGTH = 200;

function sanitizeRegExp(pattern: string): string {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`rmd ledger-grep: pattern too long (${pattern.length} chars, max ${MAX_PATTERN_LENGTH})`);
  }
  if (/\([^()]*[+*][^()]*\)[+*]/.test(pattern)) {
    throw new Error(
      "rmd ledger-grep: pattern rejected — nested quantifiers like (a+)+ can cause catastrophic backtracking",
    );
  }
  return pattern;
}

function listedLedgerFiles(stateDir: string, fsDeps: Pick<LedgerGrepFsDeps, "readdirSync">): { rotations: LedgerCorpusEntry[]; unclassified: string[] } {
  let names: string[];
  try {
    names = fsDeps.readdirSync(stateDir);
  } catch {
    names = [];
  }
  const rotations = ledgerRotationEntries(names, stateDir);
  const rotationPaths = new Set(rotations.map((e) => e.path));
  const unclassified = names
    .filter((n) => n.startsWith("ledger.") && n !== NEVER_ROTATE_FILENAME)
    .map((n) => join(stateDir, n))
    .filter((p) => !rotationPaths.has(p));
  return { rotations, unclassified };
}

function sinceMs(opts: LedgerUnionOptions): number | undefined {
  const raw = opts.sinceTs ?? opts.since;
  if (raw === undefined) return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function rotationBeforeWindow(entry: LedgerCorpusEntry, minimumTs: number | undefined): boolean {
  if (minimumTs === undefined) return false;
  const stamp = rotationStampIso(basename(entry.path));
  if (stamp === undefined) return false;
  const stampMs = Date.parse(stamp);
  return !Number.isNaN(stampMs) && stampMs < minimumTs;
}

function recordMatchesFilters(row: Record<string, unknown>, opts: LedgerUnionOptions, minimumTs: number | undefined): boolean {
  if (minimumTs !== undefined) {
    const ts = row.ts;
    if (typeof ts !== "string" || Date.parse(ts) < minimumTs) return false;
  }
  if (opts.step !== undefined) {
    const step = row.step;
    if (typeof step !== "string") return false;
    if (typeof opts.step === "string") {
      if (step !== opts.step) return false;
    } else if (!opts.step.includes(step)) {
      return false;
    }
  }
  return true;
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  const parsed: unknown = JSON.parse(raw);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

export interface OpenLedgerUnionOptions extends LedgerUnionOptions {
  dedupe?: boolean;
}

export async function* openLedgerUnion(
  stateDir: string,
  opts: OpenLedgerUnionOptions = {},
): AsyncGenerator<Record<string, unknown>> {
  const { rotations } = listedLedgerFiles(stateDir, realLedgerFs);
  const livePath = ledgerLivePath(stateDir);
  const entries = [...rotations, { path: livePath, form: "plain" as const }];
  const seen = new Set<string>();
  const minimumTs = sinceMs(opts);

  for (const entry of entries) {
    if (entry.path === livePath && !nodeExistsSync(entry.path)) continue;
    if (rotationBeforeWindow(entry, minimumTs)) continue;
    const input = entry.form === "gzip" ? createReadStream(entry.path).pipe(createGunzip()) : createReadStream(entry.path);
    const rl = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const raw of rl) {
        const line = String(raw).trim();
        if (!line) continue;
        if (opts.dedupe !== false) {
          if (seen.has(line)) continue;
          seen.add(line);
        }
        let parsed: Record<string, unknown> | undefined;
        try {
          parsed = parseObject(line);
        } catch {
          continue;
        }
        if (parsed !== undefined && recordMatchesFilters(parsed, opts, minimumTs)) yield parsed;
      }
    } catch {
      // Console-style readers are best effort; audit-style refusal is handled by resolveLedgerUnion.
    }
  }
}

export async function readLedgerUnionRecords(
  stateDir: string,
  opts: OpenLedgerUnionOptions = {},
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for await (const row of openLedgerUnion(stateDir, opts)) rows.push(row);
  return rows;
}

export interface LedgerUnionRawReadOptions extends LedgerUnionOptions {
  order?: "oldest-first" | "newest-first";
  liveFirst?: boolean;
  maxRotations?: number;
  pattern?: RegExp;
  dedupe?: boolean;
  requireArchives?: boolean;
  refuseIncomplete?: boolean;
}

export interface LedgerUnionRawRead {
  stateDir: string;
  archiveFiles: string[];
  archiveCount: number;
  liveFileRead: boolean;
  unread: string[];
  unclassified: string[];
  ok: boolean;
  rawLines: string[];
  filesRead: number;
}

function orderedEntries(rotations: LedgerCorpusEntry[], opts: LedgerUnionRawReadOptions): LedgerCorpusEntry[] {
  const ordered = opts.order === "newest-first"
    ? [...rotations].sort((a, b) => (a.path < b.path ? 1 : a.path > b.path ? -1 : 0))
    : rotations;
  return opts.maxRotations === undefined ? ordered : ordered.slice(0, opts.maxRotations);
}

export function readLedgerUnionRawLinesSync(
  stateDir: string,
  opts: LedgerUnionRawReadOptions = {},
  fsDeps: LedgerGrepFsDeps = realLedgerFs,
): LedgerUnionRawRead {
  const { rotations, unclassified } = listedLedgerFiles(stateDir, fsDeps);
  const archiveFiles = rotations.map((e) => e.path);
  const livePath = ledgerLivePath(stateDir);
  const liveFileRead = fsDeps.existsSync(livePath);
  const minimumTs = sinceMs(opts);
  const seen = new Set<string>();
  const rawLines: string[] = [];
  const unread: string[] = [];
  let filesRead = 0;

  const addText = (text: string): void => {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (opts.pattern && !opts.pattern.test(line)) continue;
      if (opts.dedupe !== false) {
        if (seen.has(line)) continue;
        seen.add(line);
      }
      rawLines.push(Buffer.from(line, "utf8").toString("utf8"));
    }
  };

  const readEntry = (entry: LedgerCorpusEntry): void => {
    if (rotationBeforeWindow(entry, minimumTs)) return;
    try {
      const buf = fsDeps.readFileSync(entry.path);
      filesRead += 1;
      addText((entry.form === "gzip" ? fsDeps.gunzipSync(buf) : buf).toString("utf8"));
    } catch {
      unread.push(entry.path);
    }
  };

  const readLive = (): void => {
    if (!liveFileRead) return;
    try {
      filesRead += 1;
      addText(fsDeps.readFileSync(livePath).toString("utf8"));
    } catch {
      // Best-effort live read, matching the prior union readers' behavior.
    }
  };

  if (opts.requireArchives && archiveFiles.length === 0) {
    return { stateDir, archiveFiles, archiveCount: 0, liveFileRead, unread, unclassified, ok: false, rawLines: [], filesRead };
  }

  const rotationsToRead = orderedEntries(rotations, opts);
  if (opts.liveFirst) readLive();
  for (const entry of rotationsToRead) readEntry(entry);
  if (!opts.liveFirst) readLive();

  const ok = !(opts.refuseIncomplete && unread.length > 0);
  return {
    stateDir,
    archiveFiles,
    archiveCount: archiveFiles.length,
    liveFileRead,
    unread,
    unclassified,
    ok,
    rawLines: ok ? rawLines : [],
    filesRead,
  };
}

export interface LedgerUnionRecordReadOptions extends LedgerUnionRawReadOptions {
  readLiveRecords?: (path: string) => Iterable<Record<string, unknown>>;
  onRecord?: (row: Record<string, unknown>) => void;
  satisfied?: (stepsSeen: ReadonlySet<string>) => boolean;
}

export interface LedgerUnionRecordRead extends Omit<LedgerUnionRawRead, "rawLines"> {
  rows: Array<Record<string, unknown>>;
  torn: number;
}

export function readLedgerUnionRecordsSync(
  stateDir: string,
  opts: LedgerUnionRecordReadOptions = {},
  fsDeps: LedgerGrepFsDeps = realLedgerFs,
): LedgerUnionRecordRead {
  const { rotations, unclassified } = listedLedgerFiles(stateDir, fsDeps);
  const archiveFiles = rotations.map((e) => e.path);
  const livePath = ledgerLivePath(stateDir);
  const liveFileRead = opts.readLiveRecords !== undefined ? true : fsDeps.existsSync(livePath);
  const minimumTs = sinceMs(opts);
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  const unread: string[] = [];
  const stepsSeen = new Set<string>();
  let torn = 0;
  let filesRead = 0;

  const addRecord = (row: Record<string, unknown>, raw: string): boolean => {
    if (!recordMatchesFilters(row, opts, minimumTs)) return false;
    if (opts.dedupe !== false) {
      if (seen.has(raw)) return false;
      seen.add(raw);
    }
    opts.onRecord?.(row);
    rows.push(row);
    if (typeof row.step === "string") stepsSeen.add(row.step);
    return opts.satisfied?.(stepsSeen) ?? false;
  };

  const addText = (text: string): boolean => {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (opts.pattern && !opts.pattern.test(line)) continue;
      try {
        const parsed = parseObject(line);
        if (parsed !== undefined && addRecord(parsed, line)) return true;
      } catch {
        torn += 1;
      }
    }
    return false;
  };

  const readLive = (): boolean => {
    if (opts.readLiveRecords !== undefined) {
      filesRead += 1;
      for (const row of opts.readLiveRecords(livePath)) {
        if (addRecord(row, JSON.stringify(row))) return true;
      }
      return false;
    }
    if (!liveFileRead) return false;
    try {
      filesRead += 1;
      return addText(fsDeps.readFileSync(livePath).toString("utf8"));
    } catch {
      return false;
    }
  };

  const readEntry = (entry: LedgerCorpusEntry): boolean => {
    if (rotationBeforeWindow(entry, minimumTs)) return false;
    try {
      const buf = fsDeps.readFileSync(entry.path);
      filesRead += 1;
      return addText((entry.form === "gzip" ? fsDeps.gunzipSync(buf) : buf).toString("utf8"));
    } catch {
      unread.push(entry.path);
      return false;
    }
  };

  if (opts.requireArchives && archiveFiles.length === 0) {
    return { stateDir, archiveFiles, archiveCount: 0, liveFileRead, unread, unclassified, ok: false, rows: [], torn, filesRead };
  }

  const rotationsToRead = orderedEntries(rotations, opts);
  let stopped = opts.liveFirst ? readLive() : false;
  for (const entry of rotationsToRead) {
    if (stopped) break;
    stopped = readEntry(entry);
  }
  if (!opts.liveFirst && !stopped) readLive();

  const ok = !(opts.refuseIncomplete && unread.length > 0);
  return {
    stateDir,
    archiveFiles,
    archiveCount: archiveFiles.length,
    liveFileRead,
    unread,
    unclassified,
    ok,
    rows: ok ? rows : [],
    torn,
    filesRead,
  };
}

export function resolveLedgerUnion(
  stateDir: string,
  pattern: string | RegExp,
  fsDeps: LedgerGrepFsDeps = realLedgerFs,
  opts: LedgerUnionOptions = {},
): LedgerUnionResult {
  const re = pattern instanceof RegExp ? pattern : new RegExp(sanitizeRegExp(pattern));
  const read = readLedgerUnionRawLinesSync(
    stateDir,
    { ...opts, pattern: re, requireArchives: true, refuseIncomplete: true },
    fsDeps,
  );
  return {
    stateDir: read.stateDir,
    archiveFiles: read.archiveFiles,
    archiveCount: read.archiveCount,
    liveFileRead: read.liveFileRead,
    unread: read.unread,
    unclassified: read.unclassified,
    ok: read.ok,
    matches: read.rawLines,
  };
}
