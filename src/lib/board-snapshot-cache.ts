import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
import type { BoardIssueRest, BoardPrRest } from "./open-prs-rest.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";

const SNAPSHOT_SCHEMA = 1;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 100_000;
const DEFAULT_MAX_LINE_BYTES = 512 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const OPEN_SNAPSHOT_SCHEMA = 1;
export const OPEN_SNAPSHOT_RESAVE_MS = 60_000;
const OBSERVATION_SCHEMA = 1;
/** BACKSTOP: an observation is one small record; a larger sidecar is not one this module wrote. */
const OBSERVATION_MAX_BYTES = 4096;

/** CADENCE: successful board reads are rolled up every five minutes (W1-T4480). */
export const BOARD_REFRESH_ROLLUP_MS = 5 * 60_000;
type BoardLog = (event: string, extra?: Record<string, unknown>) => void;
type BoardRefreshCounts = {
  fetch_ok: Record<string, number>;
  fetch: Record<string, { n: number; rest_calls: number; bytes: number; truncated: number }>;
  snapshot_unchanged: Record<string, number>;
};
const emptyRefreshCounts = (): BoardRefreshCounts => ({ fetch_ok: {}, fetch: {}, snapshot_unchanged: {} });
const pendingRefreshRollups = new Set<{ flush(): void }>();
process.once("exit", () => { for (const rollup of pendingRefreshRollups) rollup.flush(); });
const refreshRollups = new WeakMap<BoardLog, ReturnType<typeof createBoardRefreshRollup>>();

/** Share one window across the gateways and snapshot caches writing to the same ledger. */
export function boardRefreshRollup(log?: BoardLog): ReturnType<typeof createBoardRefreshRollup> | undefined {
  if (!log) return undefined;
  let rollup = refreshRollups.get(log);
  if (!rollup) {
    rollup = createBoardRefreshRollup(log);
    refreshRollups.set(log, rollup);
  }
  return rollup;
}

function createBoardRefreshRollup(log: BoardLog) {
  let counts = emptyRefreshCounts();
  let start: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    timer ??= setTimeout(() => {
      timer = undefined;
      flush();
      if (start !== undefined) arm();
    }, BOARD_REFRESH_ROLLUP_MS);
    timer.unref();
  };
  const begin = (): void => {
    start ??= systemClock.now();
    pendingRefreshRollups.add(rollup);
    arm();
  };
  const flush = (): void => {
    if (start === undefined) return;
    try {
      log("board_gateway.rollup", { window_start: fixedClock(start).iso(), window_end: fixedClock(systemClock.now()).iso(), ...counts });
    } catch (error) {
      console.error(`board_gateway.rollup: flush failed, counts retained: ${String(error)}`);
      return;
    }
    counts = emptyRefreshCounts();
    start = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
    pendingRefreshRollups.delete(rollup);
  };
  const rollup = {
    flush,
    fetchOk(channel: string): void {
      begin();
      counts.fetch_ok[channel] = (counts.fetch_ok[channel] ?? 0) + 1;
    },
    fetch(half: string, mode: string, restCalls: number, bytes: number, truncated: boolean): void {
      begin();
      const row = counts.fetch[`${half}/${mode}`] ??= { n: 0, rest_calls: 0, bytes: 0, truncated: 0 };
      row.n++;
      row.rest_calls += restCalls;
      row.bytes += bytes;
      row.truncated += Number(truncated);
    },
    snapshotUnchanged(channel: string): void {
      begin();
      counts.snapshot_unchanged[channel] = (counts.snapshot_unchanged[channel] ?? 0) + 1;
    },
  };
  return rollup;
}

const defaultIo: BoardSnapshotIo = {
  stat(path) {
    const st = fs.statSync(path);
    return { size: st.size, isFile: st.isFile(), mtimeMs: st.mtimeMs, ino: st.ino };
  },
  mkdir(path, mode) {
    fs.mkdirSync(path, { recursive: true, mode });
  },
  openRead(path) {
    return fs.openSync(path, "r");
  },
  openWrite(path, mode) {
    return fs.openSync(path, "wx", mode);
  },
  read(fd, buffer, offset, length) {
    return fs.readSync(fd, buffer, offset, length, null);
  },
  write(fd, buffer, offset, length) {
    return fs.writeSync(fd, buffer, offset, length);
  },
  fsync(fd) {
    fs.fsyncSync(fd);
  },
  close(fd) {
    fs.closeSync(fd);
  },
  rename(from, to) {
    fs.renameSync(from, to);
  },
  unlink(path) {
    fs.unlinkSync(path);
  },
};

function sameVersions<T extends { number: number; updatedAt: string; createdAt?: string; mergedAt?: string; authorLogin?: string; authorType?: string }>(current: ReadonlyMap<number, T> | undefined, rows: readonly T[]): boolean {
  return current?.size === rows.length && rows.every((row) => {
    const held = current.get(row.number);
    return held?.updatedAt === row.updatedAt && held.createdAt === row.createdAt && held.mergedAt === row.mergedAt && held.authorLogin === row.authorLogin && held.authorType === row.authorType;
  });
}

class SnapshotRefusal extends Error {
  constructor(readonly reason: keyof SnapshotReasons) {
    super(reason);
  }
}

function safeClose(io: BoardSnapshotIo, fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    io.close(fd);
  } catch {
    // The original read/write refusal remains authoritative.
  }
}

function safeUnlink(io: BoardSnapshotIo, path: string): void {
  try {
    io.unlink(path);
  } catch {
    // A never-renamed stage is disposable. The next write uses a fresh UUID.
  }
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function boundedInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isClosedDiskRow(value: unknown, maxStringBytes: number): value is ClosedDiskRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    boundedInteger(row.number) &&
    boundedString(row.url, maxStringBytes) &&
    boundedString(row.state, maxStringBytes) &&
    row.state !== "OPEN" &&
    boundedString(row.headRefName, maxStringBytes) &&
    boundedString(row.headRefOid, maxStringBytes) &&
    boundedString(row.body, maxStringBytes) &&
    boundedString(row.title, maxStringBytes) &&
    boundedString(row.updatedAt, maxStringBytes) &&
    (row.createdAt === undefined || boundedString(row.createdAt, maxStringBytes)) &&
    (row.mergedAt === undefined || boundedString(row.mergedAt, maxStringBytes)) &&
    (row.authorLogin === undefined || boundedString(row.authorLogin, maxStringBytes)) &&
    (row.authorType === undefined || boundedString(row.authorType, maxStringBytes))
  );
}

function isIssueRow(value: unknown, maxStringBytes: number): value is BoardIssueRest {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    boundedInteger(row.number) &&
    boundedString(row.url, maxStringBytes) &&
    boundedString(row.state, maxStringBytes) &&
    (row.title === undefined || boundedString(row.title, maxStringBytes)) &&
    boundedString(row.updatedAt, maxStringBytes)
  );
}

function closedForDisk(row: BoardPrRest): ClosedDiskRow {
  return {
    number: row.number,
    url: row.url,
    state: row.state,
    headRefName: row.headRefName,
    headRefOid: row.headRefOid,
    body: row.body,
    title: row.title,
    updatedAt: row.updatedAt,
    ...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }),
    ...(row.mergedAt === undefined ? {} : { mergedAt: row.mergedAt }),
    ...(row.authorLogin === undefined ? {} : { authorLogin: row.authorLogin }),
    ...(row.authorType === undefined ? {} : { authorType: row.authorType }),
  };
}

function parseHeader(value: unknown, repository: string): SnapshotHeader {
  if (!value || typeof value !== "object") throw new SnapshotRefusal("invalid_schema");
  const v = value as Partial<SnapshotHeader>;
  if (typeof v.schema === "number" && v.schema > SNAPSHOT_SCHEMA) throw new SnapshotRefusal("future_version");
  if (v.type !== "board-snapshot" || v.schema !== SNAPSHOT_SCHEMA || !v.channels) throw new SnapshotRefusal("invalid_schema");
  if (v.repository !== repository) throw new SnapshotRefusal("wrong_repository");
  for (const channel of [v.channels.closed, v.channels.issues]) {
    if (!channel || typeof channel.complete !== "boolean" || !boundedInteger(channel.count)) {
      throw new SnapshotRefusal("invalid_schema");
    }
    if (!channel.complete && channel.count !== 0) throw new SnapshotRefusal("invalid_schema");
  }
  return v as SnapshotHeader;
}

function parseFooter(value: unknown, repository: string): SnapshotFooter {
  if (!value || typeof value !== "object") throw new SnapshotRefusal("partial");
  const v = value as Partial<SnapshotFooter>;
  if (
    v.type !== "complete" ||
    v.schema !== SNAPSHOT_SCHEMA ||
    v.repository !== repository ||
    !v.counts ||
    !boundedInteger(v.counts.closed) ||
    !boundedInteger(v.counts.issues)
  ) {
    throw new SnapshotRefusal("partial");
  }
  return v as SnapshotFooter;
}

function writeFully(io: BoardSnapshotIo, fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = io.write(fd, buffer, offset, buffer.length - offset);
    if (!Number.isSafeInteger(written) || written <= 0) throw new SnapshotRefusal("write_failed");
    offset += written;
  }
}

function lineBuffer(value: unknown, maxLineBytes: number): Buffer {
  const buffer = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (buffer.length > maxLineBytes) throw new SnapshotRefusal("line_too_large");
  return buffer;
}

export function boardSnapshotPath(root: string, owner: string, repo: string): string {
  const repository = `${owner}/${repo}`;
  const safe = repository.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  const digest = createHash("sha256").update(repository).digest("hex").slice(0, 16);
  return join(root, "state", "cache", "board", `${safe}-${digest}.ndjson`);
}

export function boardOpenSnapshotPath(root: string, owner: string, repo: string): string {
  return boardSnapshotPath(root, owner, repo).replace(/\.ndjson$/, ".open.json");
}

/** W1-T8912: the closed channel's last successful unchanged source read, bound to one data file's content. */
export function boardObservationPath(root: string, owner: string, repo: string): string {
  return boardSnapshotPath(root, owner, repo).replace(/\.ndjson$/, ".observed.json");
}

export function boardClosedCollectionPath(root: string, owner: string, repo: string): string {
  return boardSnapshotPath(root, owner, repo).replace(/\.ndjson$/, ".collection.json");
}

export interface BoardClosedCollectionReceipt {
  version: 1; repository: string; lastAttemptAt: string; lastSuccessAt: string | null;
  state: "complete" | "partial" | "unavailable"; reason: "fetch_failed" | "truncated" | "snapshot_unavailable" | null;
  rowsDigest: string | null;
}

/** A closed-row identity survives unrelated issue updates in the shared snapshot file. */
export function boardClosedRowsDigest(rows: Iterable<BoardPrRest>): string {
  const digest = createHash("sha256");
  for (const row of [...rows].sort((a, b) => a.number - b.number)) digest.update(JSON.stringify(closedForDisk(row)) + "\n");
  return digest.digest("hex");
}

export function readBoardClosedCollectionReceipt(root: string, owner: string, repo: string, rows: Iterable<BoardPrRest>):
  { ok: true; receipt: BoardClosedCollectionReceipt } | { ok: false; reason: string } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(boardClosedCollectionPath(root, owner, repo), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > OBSERVATION_MAX_BYTES) return { ok: false, reason: "collection receipt is not a bounded regular file" };
    const value = JSON.parse(fs.readFileSync(fd, "utf8")) as BoardClosedCollectionReceipt;
    if (!value || value.version !== 1 || value.repository !== `${owner}/${repo}` || stampMs(value.lastAttemptAt) === undefined ||
        !(value.lastSuccessAt === null || stampMs(value.lastSuccessAt) !== undefined && value.lastSuccessAt <= value.lastAttemptAt) ||
        !["complete", "partial", "unavailable"].includes(value.state) || ![null, "fetch_failed", "truncated", "snapshot_unavailable"].includes(value.reason) ||
        value.rowsDigest !== boardClosedRowsDigest(rows) || value.state === "complete" && (value.lastSuccessAt === null || value.reason !== null)) return { ok: false, reason: "collection receipt does not certify these saved rows" };
    return { ok: true, receipt: value };
  } catch (error) {
    return { ok: false, reason: `collection receipt unavailable (${(error as NodeJS.ErrnoException).code ?? "invalid data"})` };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function stampMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && fixedClock(ms).iso() === value ? ms : undefined;
}

const reobservers = new WeakMap<BoardSnapshotCache, () => SharedBoardSnapshotRows>();

export interface OpenBoardSnapshot {
  repository: string;
  savedAt: string;
  rows: BoardPrRest[];
}

function isOpenDiskRow(value: unknown, maxStringBytes: number): value is BoardPrRest {
  const row = value as Record<string, unknown> | null;
  return !!row && typeof row === "object" && boundedInteger(row.number) && row.state === "OPEN" &&
    ["url", "headRefName", "headRefOid", "body", "title", "updatedAt"].every((k) => boundedString(row[k], maxStringBytes)) &&
    ["authorLogin", "authorType"].every(k => row[k] === undefined || boundedString(row[k], maxStringBytes));
}

export function readOpenBoardSnapshot(
  root: string,
  owner: string,
  repo: string,
  read: (path: string) => string = (path) => {
    const fd = fs.openSync(path, "r");
    try {
      // Check and read the same opened object; a renamed/replaced path cannot change the input.
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new SnapshotRefusal("invalid_schema");
      if (stat.size > DEFAULT_MAX_BYTES) throw new SnapshotRefusal("oversized");
      const chunks: Buffer[] = [];
      let bytes = 0;
      for (;;) {
        // BACKSTOP: include one sentinel byte to refuse growth after fstat, without unbounded allocation.
        const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, DEFAULT_MAX_BYTES - bytes + 1));
        const n = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (n === 0) return Buffer.concat(chunks, bytes).toString("utf8");
        bytes += n;
        if (bytes > DEFAULT_MAX_BYTES) throw new SnapshotRefusal("oversized");
        chunks.push(chunk.subarray(0, n));
      }
    } finally {
      fs.closeSync(fd);
    }
  },
): { ok: true; snapshot: OpenBoardSnapshot } | { ok: false; reason: string } {
  const repository = `${owner}/${repo}`;
  let parsed: Partial<OpenBoardSnapshot> & { type?: unknown; schema?: unknown };
  try {
    parsed = JSON.parse(read(boardOpenSnapshotPath(root, owner, repo))) as typeof parsed;
  } catch (error) {
    return { ok: false, reason: `open snapshot unreadable: ${(error as Error).message}` };
  }
  if (parsed.type !== "board-open-snapshot" || parsed.schema !== OPEN_SNAPSHOT_SCHEMA || parsed.repository !== repository) {
    return { ok: false, reason: "open snapshot has another schema or repository" };
  }
  if (!Array.isArray(parsed.rows)) return { ok: false, reason: "open snapshot is incomplete" };
  if (parsed.rows.length > DEFAULT_MAX_ROWS) return { ok: false, reason: "open snapshot exceeds row bound" };
  const rows = parsed.rows;
  if (typeof parsed.savedAt !== "string" || !rows.every((row) => isOpenDiskRow(row, DEFAULT_MAX_LINE_BYTES))) {
    return { ok: false, reason: "open snapshot holds an invalid row" };
  }
  return { ok: true, snapshot: { repository, savedAt: parsed.savedAt, rows } };
}

export function createBoardSnapshotCache(root: string, owner: string, repo: string, options: SnapshotOptions = {}): BoardSnapshotCache {
  const io = options.io ?? defaultIo;
  const emit = options.log ?? (() => {});
  const rollup = boardRefreshRollup(options.log);
  const unchangedWritten = new Set<string>();
  const repository = `${owner}/${repo}`;
  const path = boardSnapshotPath(root, owner, repo);
  const maxBytes = options.bounds?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRows = options.bounds?.maxRows ?? DEFAULT_MAX_ROWS;
  const maxLineBytes = options.bounds?.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxStringBytes = Math.max(1, maxLineBytes - 256);
  const clock = options.clock ?? systemClock;
  const observationPath = boardObservationPath(root, owner, repo);
  let state: SnapshotState = {};
  // W1-T8912: the content identity of the data file this instance last read or wrote, and that file's own clock.
  let dataIdentity: SnapshotIdentity | undefined;
  let headerObservedAt: string | undefined;

  const log = (
    event: string,
    channel: keyof SnapshotRows | "snapshot" | "open",
    rows: number,
    bytes: number,
    reason?: keyof SnapshotReasons,
  ): void => {
    if (event === "board_snapshot.committed" || event.endsWith("_refused")) unchangedWritten.delete(channel);
    emit(event, {
      schema: SNAPSHOT_SCHEMA,
      repository,
      channel,
      rows,
      bytes,
      ...(reason ? { reason } : {}),
    });
  };

  const load = (): SnapshotState => {
    let size = 0;
    try {
      const st = io.stat(path);
      size = st.size;
      if (!st.isFile) throw new SnapshotRefusal("not_file");
      if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) throw new SnapshotRefusal("oversized");
    } catch (error) {
      const reason = error instanceof SnapshotRefusal ? error.reason : "missing";
      log("board_snapshot.load_refused", "snapshot", 0, size, reason);
      return {};
    }

    let fd: number | undefined;
    let bytes = 0;
    const digest = createHash("sha256");
    let pending = Buffer.alloc(0);
    let header: SnapshotHeader | undefined;
    let footer: SnapshotFooter | undefined;
    const closed = new Map<number, BoardPrRest>();
    const issues = new Map<number, BoardIssueRest>();
    let sawFooter = false;

    const consume = (raw: Buffer): void => {
      if (raw.length > maxLineBytes) throw new SnapshotRefusal("line_too_large");
      let value: unknown;
      try {
        value = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new SnapshotRefusal("invalid_json");
      }
      if (!header) {
        header = parseHeader(value, repository);
        if (header.channels.closed.count + header.channels.issues.count > maxRows) throw new SnapshotRefusal("row_limit");
        return;
      }
      if (sawFooter) throw new SnapshotRefusal("partial");
      if ((value as { type?: unknown })?.type === "complete") {
        footer = parseFooter(value, repository);
        sawFooter = true;
        return;
      }
      const record = value as { type?: unknown; row?: unknown };
      if (record.type === "closed") {
        if (!header.channels.closed.complete || !isClosedDiskRow(record.row, maxStringBytes)) {
          throw new SnapshotRefusal("invalid_row");
        }
        if (closed.has(record.row.number)) throw new SnapshotRefusal("duplicate_row");
        closed.set(record.row.number, { ...record.row, autoMergeRequest: null });
      } else if (record.type === "issues") {
        if (!header.channels.issues.complete || !isIssueRow(record.row, maxStringBytes)) {
          throw new SnapshotRefusal("invalid_row");
        }
        if (issues.has(record.row.number)) throw new SnapshotRefusal("duplicate_row");
        issues.set(record.row.number, { ...record.row });
      } else {
        throw new SnapshotRefusal("invalid_row");
      }
      if (closed.size + issues.size > maxRows) throw new SnapshotRefusal("row_limit");
    };

    try {
      fd = io.openRead(path);
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, maxLineBytes)));
      for (;;) {
        const n = io.read(fd, chunk, 0, chunk.length);
        if (!Number.isSafeInteger(n) || n < 0 || n > chunk.length) throw new SnapshotRefusal("read_failed");
        if (n === 0) break;
        bytes += n;
        if (bytes > maxBytes) throw new SnapshotRefusal("oversized");
        digest.update(chunk.subarray(0, n));
        pending = pending.length === 0 ? Buffer.from(chunk.subarray(0, n)) : Buffer.concat([pending, chunk.subarray(0, n)]);
        if (pending.length > maxLineBytes && pending.indexOf(0x0a) < 0) throw new SnapshotRefusal("line_too_large");
        let newline = pending.indexOf(0x0a);
        while (newline >= 0) {
          consume(pending.subarray(0, newline));
          pending = pending.subarray(newline + 1);
          newline = pending.indexOf(0x0a);
        }
      }
      if (pending.length !== 0 || !header || !footer) throw new SnapshotRefusal("partial");
      if (footer.counts.closed !== closed.size || footer.counts.issues !== issues.size ||
          header.channels.closed.count !== closed.size || header.channels.issues.count !== issues.size) {
        throw new SnapshotRefusal("count_mismatch");
      }
      const loaded: SnapshotState = {
        ...(header.channels.closed.complete ? { closed } : {}),
        ...(typeof header.channels.closed.observedAt === "string" ? { closedObservedAt: header.channels.closed.observedAt } : {}),
        ...(header.channels.issues.complete ? { issues } : {}),
      };
      dataIdentity = { sha256: digest.digest("hex"), bytes };
      headerObservedAt = loaded.closedObservedAt;
      log("board_snapshot.loaded", "snapshot", closed.size + issues.size, bytes);
      return loaded;
    } catch (error) {
      const reason = error instanceof SnapshotRefusal ? error.reason : fd === undefined ? "open_failed" : "read_failed";
      log("board_snapshot.load_refused", "snapshot", 0, bytes, reason);
      return {};
    } finally {
      safeClose(io, fd);
    }
  };

  /** Certify the held data with its sidecar, or fall back to the data's own clock: never a later or foreign one. */
  const readObservation = (): string | undefined => {
    if (!dataIdentity || !state.closed) return headerObservedAt;
    let size: number;
    let isFile: boolean;
    try {
      ({ size, isFile } = io.stat(observationPath));
    } catch {
      // deliberate: no sidecar is the ordinary uncertified state of a legacy or freshly written snapshot.
      return headerObservedAt;
    }
    let fd: number | undefined;
    let bytes = 0;
    try {
      if (!isFile) throw new SnapshotRefusal("not_file");
      if (!Number.isSafeInteger(size) || size > OBSERVATION_MAX_BYTES) throw new SnapshotRefusal("oversized");
      fd = io.openRead(observationPath);
      // BACKSTOP: one sentinel byte past the bound refuses growth after the stat.
      const buffer = Buffer.alloc(OBSERVATION_MAX_BYTES + 1);
      for (;;) {
        const n = io.read(fd, buffer, bytes, buffer.length - bytes);
        if (!Number.isSafeInteger(n) || n < 0 || n > buffer.length - bytes) throw new SnapshotRefusal("read_failed");
        if (n === 0) break;
        bytes += n;
        if (bytes > OBSERVATION_MAX_BYTES) throw new SnapshotRefusal("oversized");
      }
      let value: Partial<ObservationRecord> & { schema?: unknown };
      try {
        value = JSON.parse(buffer.subarray(0, bytes).toString("utf8")) as typeof value;
      } catch {
        throw new SnapshotRefusal("invalid_json");
      }
      if (!value || typeof value !== "object") throw new SnapshotRefusal("invalid_schema");
      if (typeof value.schema === "number" && value.schema > OBSERVATION_SCHEMA) throw new SnapshotRefusal("future_version");
      if (value.type !== "board-snapshot-observation" || value.schema !== OBSERVATION_SCHEMA) throw new SnapshotRefusal("invalid_schema");
      if (value.repository !== repository) throw new SnapshotRefusal("wrong_repository");
      if (value.channel !== "closed") throw new SnapshotRefusal("wrong_channel");
      if (value.snapshot?.sha256 !== dataIdentity.sha256 || value.snapshot?.bytes !== dataIdentity.bytes) {
        throw new SnapshotRefusal("foreign_snapshot");
      }
      const observedMs = stampMs(value.observedAt);
      if (observedMs === undefined) throw new SnapshotRefusal("invalid_schema");
      if (observedMs > clock.now()) throw new SnapshotRefusal("future_observation");
      const floor = stampMs(headerObservedAt);
      if (floor !== undefined && observedMs < floor) throw new SnapshotRefusal("stale_observation");
      return value.observedAt;
    } catch (error) {
      const reason = error instanceof SnapshotRefusal ? error.reason : fd === undefined ? "open_failed" : "read_failed";
      log("board_snapshot.observation_refused", "closed", 0, bytes, reason);
      return headerObservedAt;
    } finally {
      safeClose(io, fd);
    }
  };

  const reobserve = (): SnapshotState => {
    const observedAt = readObservation();
    const { closedObservedAt: _previous, ...rest } = state;
    state = observedAt === undefined ? rest : { ...rest, closedObservedAt: observedAt };
    return state;
  };

  state = load();
  reobserve();

  /** A successful complete read that matched the held rows: persist WHEN it was seen, never the rows again. */
  const observeUnchangedClosed = (): void => {
    if (!dataIdentity || !state.closed) return;
    const rows = state.closed.size;
    const nowMs = clock.now();
    const prior = stampMs(state.closedObservedAt);
    // CADENCE: coalesced on the open snapshot's resave interval; a rolled-back clock never moves it backwards.
    if (prior !== undefined && !(nowMs - prior >= OPEN_SNAPSHOT_RESAVE_MS)) return;
    const observedAt = fixedClock(nowMs).iso();
    const record: ObservationRecord = { type: "board-snapshot-observation", schema: OBSERVATION_SCHEMA, repository,
      channel: "closed", snapshot: dataIdentity, observedAt };
    const body = Buffer.from(JSON.stringify(record), "utf8");
    const stage = `${observationPath}.tmp-${process.pid}-${randomUUID()}`;
    let fd: number | undefined;
    try {
      if (body.length > OBSERVATION_MAX_BYTES) throw new SnapshotRefusal("oversized");
      io.mkdir(dirname(observationPath), 0o700);
      fd = io.openWrite(stage, 0o600);
      writeFully(io, fd, body);
      io.fsync(fd);
      io.close(fd);
      fd = undefined;
      io.rename(stage, observationPath);
      state = { ...state, closedObservedAt: observedAt };
    } catch (error) {
      safeClose(io, fd);
      safeUnlink(io, stage);
      const reason = error instanceof SnapshotRefusal ? error.reason : "write_failed";
      log("board_snapshot.observation_refused", "closed", rows, body.length, reason);
    }
  };

  const commit = (channel: keyof SnapshotRows, rows: readonly (BoardPrRest | BoardIssueRest)[]): boolean => {
    let nextRows: Map<number, BoardPrRest> | Map<number, BoardIssueRest>;
    try {
      if (rows.length > maxRows) throw new SnapshotRefusal("row_limit");
      if (channel === "closed") {
        const closed = rows as readonly BoardPrRest[];
        for (const row of closed) {
          if (!isClosedDiskRow(closedForDisk(row), maxStringBytes)) throw new SnapshotRefusal("invalid_row");
        }
        nextRows = new Map(closed.map((row) => [row.number, { ...row }]));
      } else {
        const issues = rows as readonly BoardIssueRest[];
        for (const row of issues) if (!isIssueRow(row, maxStringBytes)) throw new SnapshotRefusal("invalid_row");
        nextRows = new Map(issues.map((row) => [row.number, { ...row }]));
      }
      if (nextRows.size !== rows.length) throw new SnapshotRefusal("duplicate_row");
    } catch (error) {
      const reason = error instanceof SnapshotRefusal ? error.reason : "invalid_row";
      log("board_snapshot.commit_refused", channel, rows.length, 0, reason);
      return false;
    }

    if (channel === "closed" ? sameVersions(state.closed, rows as readonly BoardPrRest[]) : sameVersions(state.issues, rows as readonly BoardIssueRest[])) {
      rollup?.snapshotUnchanged(channel);
      if (!unchangedWritten.has(channel)) {
        log("board_snapshot.unchanged", channel, rows.length, 0);
        unchangedWritten.add(channel);
      }
      if (channel === "closed") observeUnchangedClosed();
      return true;
    }

    const nextState: SnapshotState =
      channel === "closed"
        ? { ...state, closed: nextRows as Map<number, BoardPrRest>, closedObservedAt: clock.iso() }
        : { ...state, issues: nextRows as Map<number, BoardIssueRest> };
    const header: SnapshotHeader = {
      type: "board-snapshot",
      schema: SNAPSHOT_SCHEMA,
      repository,
      channels: {
        closed: { complete: nextState.closed !== undefined, count: nextState.closed?.size ?? 0,
          ...(nextState.closedObservedAt === undefined ? {} : { observedAt: nextState.closedObservedAt }) },
        issues: { complete: nextState.issues !== undefined, count: nextState.issues?.size ?? 0 },
      },
    };
    const footer: SnapshotFooter = {
      type: "complete",
      schema: SNAPSHOT_SCHEMA,
      repository,
      counts: { closed: nextState.closed?.size ?? 0, issues: nextState.issues?.size ?? 0 },
    };

    const records = function* (): Generator<unknown> {
      yield header;
      for (const row of nextState.closed?.values() ?? []) yield { type: "closed", row: closedForDisk(row) };
      for (const row of nextState.issues?.values() ?? []) yield { type: "issues", row };
      yield footer;
    };

    let expectedBytes = 0;
    try {
      for (const record of records()) {
        expectedBytes += lineBuffer(record, maxLineBytes).length;
        if (expectedBytes > maxBytes) throw new SnapshotRefusal("oversized");
      }
    } catch (error) {
      const reason = error instanceof SnapshotRefusal ? error.reason : "invalid_row";
      log("board_snapshot.commit_refused", channel, rows.length, expectedBytes, reason);
      return false;
    }

    const stage = `${path}.tmp-${process.pid}-${randomUUID()}`;
    let fd: number | undefined;
    let writtenBytes = 0;
    const digest = createHash("sha256");
    try {
      io.mkdir(dirname(path), 0o700);
      fd = io.openWrite(stage, 0o600);
      for (const record of records()) {
        const buffer = lineBuffer(record, maxLineBytes);
        writeFully(io, fd, buffer);
        digest.update(buffer);
        writtenBytes += buffer.length;
      }
      io.fsync(fd);
      io.close(fd);
      fd = undefined;
      io.rename(stage, path);
      state = nextState;
      // A replaced data file is a new identity: no earlier sidecar can certify it.
      dataIdentity = { sha256: digest.digest("hex"), bytes: writtenBytes };
      headerObservedAt = nextState.closedObservedAt;
      // Retire the stale sidecar only after the replacement is published; a failed publication keeps it.
      try {
        io.unlink(observationPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          log("board_snapshot.observation_refused", "closed", rows.length, 0, "write_failed");
        }
      }
      log("board_snapshot.committed", channel, rows.length, writtenBytes);
      return true;
    } catch {
      safeClose(io, fd);
      safeUnlink(io, stage);
      log("board_snapshot.commit_refused", channel, rows.length, writtenBytes, "write_failed");
      return false;
    }
  };

  let openSaved: { key: string; atMs: number } | undefined;
  const commitOpen = (rows: readonly BoardPrRest[], fetchedAtMs: number): boolean => {
    const key = rows.map((row) => `${row.number}:${row.updatedAt}:${row.headRefOid}`).sort().join(",");
    if (openSaved?.key === key && fetchedAtMs - openSaved.atMs < OPEN_SNAPSHOT_RESAVE_MS) return true;
    const openRows = rows.filter((row) => row.state === "OPEN");
    const body = Buffer.from(JSON.stringify({ type: "board-open-snapshot", schema: OPEN_SNAPSHOT_SCHEMA, repository,
      savedAt: fixedClock(fetchedAtMs).iso(), rows: openRows }), "utf8");
    const openPath = boardOpenSnapshotPath(root, owner, repo);
    if (body.length > maxBytes || !openRows.every((row) => isOpenDiskRow(row, maxStringBytes))) {
      log("board_snapshot.commit_refused", "open", rows.length, body.length, body.length > maxBytes ? "oversized" : "invalid_row");
      return false;
    }
    const stage = `${openPath}.tmp-${process.pid}-${randomUUID()}`;
    let fd: number | undefined;
    try {
      io.mkdir(dirname(openPath), 0o700);
      fd = io.openWrite(stage, 0o600);
      writeFully(io, fd, body);
      io.fsync(fd);
      io.close(fd);
      fd = undefined;
      io.rename(stage, openPath);
      openSaved = { key, atMs: fetchedAtMs };
      log("board_snapshot.committed", "open", openRows.length, body.length);
      return true;
    } catch {
      safeClose(io, fd);
      safeUnlink(io, stage);
      log("board_snapshot.commit_refused", "open", rows.length, 0, "write_failed");
      return false;
    }
  };

  let collectionSuccessAt = state.closedObservedAt ?? null;
  let digestRows: ReadonlyMap<number, BoardPrRest> | undefined;
  let rowsDigest: string | null = null;
  const cache: BoardSnapshotCache = {
    recordClosedAttempt(outcome) {
      const at = clock.iso(), complete = outcome.ok && outcome.truncated !== true && outcome.persisted === true && state.closed !== undefined;
      if (complete) collectionSuccessAt = at;
      if (state.closed !== digestRows) {
        digestRows = state.closed;
        rowsDigest = digestRows ? boardClosedRowsDigest(digestRows.values()) : null;
      }
      const receipt: BoardClosedCollectionReceipt = { version: 1, repository, lastAttemptAt: at, lastSuccessAt: collectionSuccessAt,
        state: complete ? "complete" : outcome.ok && outcome.truncated ? "partial" : "unavailable",
        reason: complete ? null : !outcome.ok ? "fetch_failed" : outcome.truncated ? "truncated" : "snapshot_unavailable", rowsDigest };
      const target = boardClosedCollectionPath(root, owner, repo), stage = `${target}.tmp-${process.pid}-${randomUUID()}`;
      let fd: number | undefined;
      try {
        io.mkdir(dirname(target), 0o700); fd = io.openWrite(stage, 0o600);
        writeFully(io, fd, Buffer.from(JSON.stringify(receipt))); io.fsync(fd); io.close(fd); fd = undefined;
        io.rename(stage, target);
      } catch {
        safeClose(io, fd); safeUnlink(io, stage);
        emit("board_snapshot.collection_receipt_failed", { repository, channel: "closed", reason: "write_failed" });
      }
    },
    commitOpen,
    rows: () => state,
    closedSeed() {
      return state.closed ? new Map([...state.closed].map(([number, row]) => [number, { ...row }])) : undefined;
    },
    issueSeed() {
      return state.issues ? new Map([...state.issues].map(([number, row]) => [number, { ...row }])) : undefined;
    },
    commitClosed(rows) {
      return commit("closed", rows);
    },
    commitIssues(rows) {
      return commit("issues", rows);
    },
  };
  reobservers.set(cache, reobserve);
  return cache;
}

interface SnapshotRows {
  closed: BoardPrRest;
  issues: BoardIssueRest;
}
interface SnapshotReasons {
  missing: never;
  not_file: never;
  oversized: never;
  open_failed: never;
  read_failed: never;
  line_too_large: never;
  invalid_json: never;
  invalid_schema: never;
  future_version: never;
  wrong_repository: never;
  partial: never;
  row_limit: never;
  invalid_row: never;
  duplicate_row: never;
  count_mismatch: never;
  write_failed: never;
  wrong_channel: never;
  foreign_snapshot: never;
  future_observation: never;
  stale_observation: never;
}

export interface BoardSnapshotIo {
  stat(path: string): { size: number; isFile: boolean; mtimeMs?: number; ino?: number };
  mkdir(path: string, mode: number): void;
  openRead(path: string): number;
  openWrite(path: string, mode: number): number;
  read(fd: number, buffer: Buffer, offset: number, length: number): number;
  write(fd: number, buffer: Buffer, offset: number, length: number): number;
  fsync(fd: number): void;
  close(fd: number): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
}

export interface BoardSnapshotCache {
  recordClosedAttempt?(outcome: { ok: boolean; truncated?: boolean; persisted?: boolean }): void;
  closedSeed(): Map<number, BoardPrRest> | undefined;
  issueSeed(): Map<number, BoardIssueRest> | undefined;
  commitClosed(rows: readonly BoardPrRest[]): boolean;
  commitIssues(rows: readonly BoardIssueRest[]): boolean;
  commitOpen?(rows: readonly BoardPrRest[], fetchedAtMs: number): boolean;
  rows?(): SharedBoardSnapshotRows;
}

export interface SharedBoardSnapshotRows {
  readonly closed?: ReadonlyMap<number, BoardPrRest>;
  readonly closedObservedAt?: string;
  readonly issues?: ReadonlyMap<number, BoardIssueRest>;
}

/** One parse per file identity (inode, mtime, size; no mtime, no reuse), shared read-only by every caller in the thread (E33).
 *  W1-T8912: a changed observation sidecar alone is re-validated against the held content identity; history is not re-parsed. */
export function createBoardSnapshotReader(options: SnapshotOptions = {}): (root: string, owner: string, repo: string) => SharedBoardSnapshotRows {
  const io = options.io ?? defaultIo;
  const held = new Map<string, { identity: string; observation: string | undefined; cache: BoardSnapshotCache; rows: SharedBoardSnapshotRows }>();
  const identityOf = (path: string): string | undefined => {
    try {
      const st = io.stat(path);
      return st.mtimeMs === undefined ? undefined : `${st.ino ?? "-"}:${st.mtimeMs}:${st.size}`;
    } catch {
      // deliberate: an absent file is an identity of its own; the load below logs the refusal with its reason.
      return "missing";
    }
  };
  return (root, owner, repo) => {
    const path = boardSnapshotPath(root, owner, repo);
    const identity = identityOf(path);
    const observation = identityOf(boardObservationPath(root, owner, repo));
    const hit = held.get(path);
    if (hit && hit.identity === identity) {
      if (observation === undefined || hit.observation !== observation) {
        hit.rows = reobservers.get(hit.cache)!();
        hit.observation = observation;
      }
      return hit.rows;
    }
    const cache = createBoardSnapshotCache(root, owner, repo, options);
    const rows = cache.rows!();
    if (identity === undefined) held.delete(path);
    else held.set(path, { identity, observation, cache, rows });
    return rows;
  };
}

interface SnapshotOptions {
  clock?: Clock;
  io?: BoardSnapshotIo;
  log?: (event: string, extra?: Record<string, unknown>) => void;
  bounds?: { maxBytes?: number; maxRows?: number; maxLineBytes?: number };
}

interface SnapshotHeader {
  type: "board-snapshot";
  schema: number;
  repository: string;
  channels: {
    closed: { complete: boolean; count: number; observedAt?: string };
    issues: { complete: boolean; count: number };
  };
}

interface SnapshotFooter {
  type: "complete";
  schema: number;
  repository: string;
  counts: { closed: number; issues: number };
}

interface ClosedDiskRow {
  number: number;
  url: string;
  state: string;
  headRefName: string;
  headRefOid: string;
  body: string;
  title: string;
  updatedAt: string;
  createdAt?: string;
  mergedAt?: string;
  authorLogin?: string;
  authorType?: string;
}

interface SnapshotIdentity {
  sha256: string;
  bytes: number;
}

interface ObservationRecord {
  type: "board-snapshot-observation";
  schema: number;
  repository: string;
  channel: "closed";
  snapshot: SnapshotIdentity;
  observedAt: string;
}

interface SnapshotState {
  closed?: Map<number, BoardPrRest>;
  closedObservedAt?: string;
  issues?: Map<number, BoardIssueRest>;
}
