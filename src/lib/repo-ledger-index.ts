/**
 * The repository portfolio's incremental ledger index: the only rows the per-repo telemetry reads, kept
 * compact and de-duplicated in memory so a refresh re-reads only what changed since the last one.
 *
 * - A dated rotation is immutable once written, so it is parsed once (re-parsed only if its size moves).
 *   A rotation named older than the window plus a day holds no row the window can count, so it is skipped.
 * - The live file is read from the last complete line onward; a live file SHORTER than the last read was
 *   rotated, so it is read again from the start.
 * - The same row sits in many rotations (compaction keeps each step's newest rows live and archives them
 *   again), so every kept row is keyed by a hash of its text and counted once. MEASURED 2026-09-29 on the
 *   core ledger: 844,433 rows in the seven-day union, 653,773 distinct; `verdict.merged` 5,421 vs 348.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

type Row = Record<string, unknown>;

/** Substrings a kept row's text must carry; every other line skips its parse. */
const KEPT_STEP_MARKERS = ['"step":"run.start"', '"step":"verdict', '"step":"worker.assignment"', '"billing_mode":"'];
const DAEMON_MARKER = '"step":"daemon.';
const KEPT_FIELDS = [
  "ts", "step", "run_id", "task_id", "repo", "verdict", "billing_mode", "total_cost_usd", "tokens",
  "served_model",
] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const HEAD_BYTES = 512;

export interface RepoLedgerIndexFs {
  readdir: (dir: string) => string[];
  size: (path: string) => number | undefined;
  readAll: (path: string) => Buffer;
  readFrom: (path: string, offset: number, length: number) => Buffer;
}

export const realRepoLedgerIndexFs: RepoLedgerIndexFs = {
  readdir: (dir) => readdirSync(dir),
  size: (path) => {
    try {
      return statSync(path).size;
    } catch (err) {
      // An absent file is a measured "no rows", not a failure: the caller reads `undefined` as absent.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  },
  readAll: (path) => readFileSync(path),
  readFrom: (path, offset, length) => {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(length);
      const n = readSync(fd, buf, 0, length, offset);
      return buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  },
};

export interface RepoLedgerIndexPass {
  /** False when the live ledger does not exist: the caller reports every ledger field unknown. */
  present: boolean;
  /** The kept, de-duplicated rows inside the window. */
  rows: Row[];
  /** The newest `daemon.*` heartbeat seen, epoch ms; undefined when none was ever read. */
  lastDaemonMs: number | undefined;
  filesRead: number;
  bytesRead: number;
}

/** A rotation's own timestamp from `ledger.<ISO with dashes>.ndjson[.gz]`; undefined for any other name. */
export function rotationStampMs(name: string): number | undefined {
  const m = /^ledger\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.ndjson(\.gz)?$/.exec(name);
  if (!m) return undefined;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

function isRotationName(name: string, liveName: string): boolean {
  return name !== liveName && /^ledger\..+\.ndjson(\.gz)?$/.test(name);
}

/** An assignment row's canonical selected model and every provider window reading it carried. A row the index
 *  already compacted carries both as its own fields. */
export function assignmentFacts(row: Row): { model?: string; windows: Row[] } {
  if (Array.isArray(row.windows) || typeof row.assigned_model === "string") {
    return { ...(typeof row.assigned_model === "string" ? { model: row.assigned_model } : {}), windows: Array.isArray(row.windows) ? (row.windows as Row[]) : [] };
  }
  const assignment = row.worker_assignment as { selected?: { model?: unknown }; candidates?: unknown } | undefined;
  const windows: Row[] = [];
  for (const candidate of Array.isArray(assignment?.candidates) ? (assignment.candidates as Row[]) : []) {
    for (const w of Array.isArray(candidate?.windows) ? (candidate.windows as Row[]) : []) {
      windows.push({ provider: candidate.provider, name: w?.name, usedPercent: w?.usedPercent, resetsAt: w?.resetsAt });
    }
  }
  return { ...(typeof assignment?.selected?.model === "string" ? { model: assignment.selected.model } : {}), windows };
}

function compact(row: Row): Row {
  const out: Row = {};
  for (const key of KEPT_FIELDS) if (row[key] !== undefined) out[key] = row[key];
  if (row.step !== "worker.assignment") return out;
  const facts = assignmentFacts(row);
  if (facts.model !== undefined) out.assigned_model = facts.model;
  if (facts.windows.length > 0) out.windows = facts.windows;
  return out;
}

type ProjectionDb = { prepare(sql: string): { run(...params: Array<string | number | bigint | null>): unknown } };

const repoRowStatements = new WeakMap<object, { row: { run(...params: Array<string | number | bigint | null>): unknown }; beat: { run(...params: Array<string | number | bigint | null>): unknown } }>();

/**
 * The same rows as a read-model projection (Phase 1 P1-08): `repo_row` holds each kept row compacted as
 * {@link createRepoLedgerIndex} keeps it, and `instance_heartbeat` the newest `daemon.*` stamp. The ledger
 * projector applies it to each fresh line inside the transaction that checkpoints the line, so a row lands once.
 */
export const REPO_ROW_PROJECTION = {
  name: "repo_row",
  version: 1,
  tables: ["repo_row", "instance_heartbeat"],
  ddl: `CREATE TABLE IF NOT EXISTS repo_row(ts_ms INTEGER NOT NULL, h INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(ts_ms, h)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS instance_heartbeat(k TEXT PRIMARY KEY, last_ms INTEGER NOT NULL) WITHOUT ROWID;`,
  markers: [...KEPT_STEP_MARKERS, DAEMON_MARKER],
  apply(db: ProjectionDb, line: string, id: { h: bigint }, parse: () => Row | undefined): void {
    const row = parse();
    const tsMs = Date.parse(typeof row?.ts === "string" ? row.ts : "");
    if (row === undefined || !Number.isFinite(tsMs)) return;
    let sql = repoRowStatements.get(db);
    if (!sql) {
      sql = {
        row: db.prepare("INSERT OR IGNORE INTO repo_row(ts_ms, h, body) VALUES(?, ?, ?)"),
        beat: db.prepare("INSERT INTO instance_heartbeat(k, last_ms) VALUES('daemon', ?) ON CONFLICT(k) DO UPDATE SET last_ms = max(last_ms, excluded.last_ms)"),
      };
      repoRowStatements.set(db, sql);
    }
    if (typeof row.step === "string" && row.step.startsWith("daemon.")) sql.beat.run(tsMs);
    else if (KEPT_STEP_MARKERS.some((marker) => line.includes(marker))) sql.row.run(tsMs, id.h, JSON.stringify(compact(row)));
  },
};

export interface RepoLedgerIndex {
  refresh(ledgerPath: string, nowMs: number): RepoLedgerIndexPass;
}

export function createRepoLedgerIndex(windowMs: number, fs: RepoLedgerIndexFs = realRepoLedgerIndexFs): RepoLedgerIndex {
  const rotations = new Map<string, number>();
  const kept = new Map<string, { tsMs: number; row: Row }>();
  let liveOffset = 0;
  let liveHead = "";
  let lastDaemonMs: number | undefined;

  const ingest = (text: string): void => {
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      const daemon = line.includes(DAEMON_MARKER);
      if (!daemon && !KEPT_STEP_MARKERS.some((marker) => line.includes(marker))) continue;
      let row: Row;
      try {
        row = JSON.parse(line) as Row;
      } catch {
        continue; // A torn line counts toward nothing; the union reader reports torn rows, this index does not.
      }
      const tsMs = Date.parse(typeof row.ts === "string" ? row.ts : "");
      if (!Number.isFinite(tsMs)) continue;
      if (daemon && typeof row.step === "string" && row.step.startsWith("daemon.")) {
        if (lastDaemonMs === undefined || tsMs > lastDaemonMs) lastDaemonMs = tsMs;
        continue;
      }
      const key = createHash("sha1").update(line).digest("base64");
      if (!kept.has(key)) kept.set(key, { tsMs, row: compact(row) });
    }
  };

  return {
    refresh(ledgerPath, nowMs) {
      const dir = dirname(ledgerPath);
      const liveName = basename(ledgerPath);
      // A run.start before the window still names the repository of a verdict inside it.
      const oldestMs = nowMs - 2 * windowMs;
      let filesRead = 0;
      let bytesRead = 0;
      const liveSize = fs.size(ledgerPath);
      if (liveSize === undefined) return { present: false, rows: [], lastDaemonMs, filesRead, bytesRead };
      for (const name of fs.readdir(dir)) {
        if (!isRotationName(name, liveName)) continue;
        const stamp = rotationStampMs(name);
        if (stamp !== undefined && stamp < oldestMs - DAY_MS) continue;
        const path = join(dir, name);
        const size = fs.size(path);
        if (size === undefined || rotations.get(name) === size) continue;
        const raw = fs.readAll(path);
        const text = (name.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
        ingest(text);
        rotations.set(name, size);
        filesRead += 1;
        bytesRead += raw.length;
      }
      // A rotation rewrites the live file, which may already have regrown past the last offset: compare its head.
      const head = fs.readFrom(ledgerPath, 0, Math.min(HEAD_BYTES, liveSize)).toString("utf8");
      if (liveSize < liveOffset || !head.startsWith(liveHead)) liveOffset = 0;
      liveHead = head;
      if (liveSize > liveOffset) {
        const chunk = fs.readFrom(ledgerPath, liveOffset, liveSize - liveOffset);
        const end = chunk.lastIndexOf(0x0a) + 1;
        ingest(chunk.subarray(0, end).toString("utf8"));
        liveOffset += end;
        filesRead += end > 0 ? 1 : 0;
        bytesRead += end;
      }
      for (const [key, entry] of kept) if (entry.tsMs < oldestMs) kept.delete(key);
      return { present: true, rows: [...kept.values()].map((entry) => entry.row), lastDaemonMs, filesRead, bytesRead };
    },
  };
}
