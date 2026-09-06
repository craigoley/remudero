import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
import type { BoardIssueRest, BoardPrRest } from "./open-prs-rest.js";

const SNAPSHOT_SCHEMA = 1;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 100_000;
const DEFAULT_MAX_LINE_BYTES = 512 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

const defaultIo: BoardSnapshotIo = {
  stat(path) {
    const st = fs.statSync(path);
    return { size: st.size, isFile: st.isFile() };
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

function sameVersions<T extends { number: number; updatedAt: string }>(current: ReadonlyMap<number, T> | undefined, rows: readonly T[]): boolean {
  return current?.size === rows.length && rows.every((row) => current.get(row.number)?.updatedAt === row.updatedAt);
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
    boundedString(row.updatedAt, maxStringBytes)
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

export function createBoardSnapshotCache(root: string, owner: string, repo: string, options: SnapshotOptions = {}): BoardSnapshotCache {
  const io = options.io ?? defaultIo;
  const emit = options.log ?? (() => {});
  const repository = `${owner}/${repo}`;
  const path = boardSnapshotPath(root, owner, repo);
  const maxBytes = options.bounds?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRows = options.bounds?.maxRows ?? DEFAULT_MAX_ROWS;
  const maxLineBytes = options.bounds?.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxStringBytes = Math.max(1, maxLineBytes - 256);
  let state: SnapshotState = {};

  const log = (
    event: string,
    channel: keyof SnapshotRows | "snapshot",
    rows: number,
    bytes: number,
    reason?: keyof SnapshotReasons,
  ): void => {
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
        ...(header.channels.issues.complete ? { issues } : {}),
      };
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

  state = load();

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
      log("board_snapshot.unchanged", channel, rows.length, 0);
      return true;
    }

    const nextState: SnapshotState =
      channel === "closed"
        ? { ...state, closed: nextRows as Map<number, BoardPrRest> }
        : { ...state, issues: nextRows as Map<number, BoardIssueRest> };
    const header: SnapshotHeader = {
      type: "board-snapshot",
      schema: SNAPSHOT_SCHEMA,
      repository,
      channels: {
        closed: { complete: nextState.closed !== undefined, count: nextState.closed?.size ?? 0 },
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
    try {
      io.mkdir(dirname(path), 0o700);
      fd = io.openWrite(stage, 0o600);
      for (const record of records()) {
        const buffer = lineBuffer(record, maxLineBytes);
        writeFully(io, fd, buffer);
        writtenBytes += buffer.length;
      }
      io.fsync(fd);
      io.close(fd);
      fd = undefined;
      io.rename(stage, path);
      state = nextState;
      log("board_snapshot.committed", channel, rows.length, writtenBytes);
      return true;
    } catch {
      safeClose(io, fd);
      safeUnlink(io, stage);
      log("board_snapshot.commit_refused", channel, rows.length, writtenBytes, "write_failed");
      return false;
    }
  };

  return {
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
}

export interface BoardSnapshotIo {
  stat(path: string): { size: number; isFile: boolean };
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
  closedSeed(): Map<number, BoardPrRest> | undefined;
  issueSeed(): Map<number, BoardIssueRest> | undefined;
  commitClosed(rows: readonly BoardPrRest[]): boolean;
  commitIssues(rows: readonly BoardIssueRest[]): boolean;
}

interface SnapshotOptions {
  io?: BoardSnapshotIo;
  log?: (event: string, extra?: Record<string, unknown>) => void;
  bounds?: { maxBytes?: number; maxRows?: number; maxLineBytes?: number };
}

interface SnapshotHeader {
  type: "board-snapshot";
  schema: number;
  repository: string;
  channels: {
    closed: { complete: boolean; count: number };
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
}

interface SnapshotState {
  closed?: Map<number, BoardPrRest>;
  issues?: Map<number, BoardIssueRest>;
}
