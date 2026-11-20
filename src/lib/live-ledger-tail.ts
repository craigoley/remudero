import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * W1-T11210: the live ledger's rows as `readLedgerLines` would return them, kept across calls so each call
 * parses only the bytes appended since the last one.
 *
 * Serve's minute-tick incident-invariants monitor re-read and re-parsed the whole live ledger on its main
 * thread every minute (`parseLedgerContent` under `readLedgerLines`). The parse rules are the same: split on
 * newlines, skip blank lines, drop and report an unparseable complete line. A file whose identity (dev:ino)
 * changed, as a rotation's rename does, that shrank below what was read, or whose first or last-read bytes
 * differ from what was read (a rewrite in place), is read again from its start.
 * W1-T13367: a call whose fstat shows the same identity, size, mtime and ctime as the last full read reads no
 * byte. Any other call reads once, from the 64-byte anchor before `offset` to the end, and takes the next head and
 * anchor from those bytes; it reads the head again only when the file did not grow.
 * A trailing line with no newline yet is parsed for this call but not consumed; while its bytes are unchanged,
 * later calls reuse that parse, including when the newline arrives. A missing file reads as no
 * rows. Any other read error clears the state and is rethrown, so the next call starts over.
 * Rows timed before `nowMs - retainMs`, or with no parseable `ts`, are dropped: no window can reach them.
 * W1-T11260: `keepUntimed` keeps a row with no parseable `ts`, so a tail with an infinite `retainMs` returns
 * every row `readLedgerLines` returns. The sweep's light pass folds rows such as `fix.dispatch` written without one.
 * A returned array is never changed afterwards: a call over no new bytes returns the same array, and new rows
 * yield a new one, so a caller holds a stable snapshot without copying.
 */
export type LiveLedgerTail = (nowMs: number) => ReadonlyArray<Record<string, unknown>>;

const NEWLINE = 0x0a;
const ANCHOR_BYTES = 64;

/** W1-T13828: each retained row's parsed time, so the retention pass parses a row's time once, not once a call. */
const rowTimes = new WeakMap<object, number | null>();
function rowMs(row: Record<string, unknown>): number | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const held = rowTimes.get(row);
  if (held !== undefined) return held ?? undefined;
  const parsed = typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
  const ms = Number.isFinite(parsed) ? parsed : null;
  rowTimes.set(row, ms);
  return ms ?? undefined;
}

function retained(row: Record<string, unknown>, cutoff: number, keepUntimed: boolean): boolean {
  const t = rowMs(row);
  return t === undefined ? keepUntimed : t > cutoff;
}

function lineFilter(pattern: RegExp): (line: string) => boolean {
  if (!pattern.global && !pattern.sticky) return (line) => pattern.test(line);
  return (line) => {
    const lastIndex = pattern.lastIndex;
    try {
      pattern.lastIndex = 0;
      return pattern.test(line);
    } finally {
      pattern.lastIndex = lastIndex;
    }
  };
}

function parseLines(path: string, text: string, out: Array<Record<string, unknown>>, keepLine?: (line: string) => boolean): void {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // W1-T13828: a caller that reads only some steps skips every other line before it is parsed.
    if (keepLine && !keepLine(line)) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      console.error(`ledger: dropping unparseable line in ${path}: ${line}`);
    }
  }
}

function tentativeRow(text: string, keepLine?: (line: string) => boolean): Record<string, unknown> | undefined {
  const line = text.trim();
  if (!line || (keepLine && !keepLine(line))) return undefined;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    // A line still being written is not torn yet: it is skipped this call and parsed once its newline lands.
    return undefined;
  }
}

export function createLiveLedgerTail(path: string, retainMs: number, opts: { keepUntimed?: boolean; keepLine?: RegExp } = {}): LiveLedgerTail {
  const keepUntimed = opts.keepUntimed === true;
  const keepLine = opts.keepLine && lineFilter(opts.keepLine);
  let identity: string | undefined;
  // W1-T13367: the size and times of the last fstat whose bytes were all read; undefined after a short read or a reset.
  let seenStat: { size: number; mtimeMs: number; ctimeMs: number } | undefined;
  let offset = 0;
  let head: Buffer = Buffer.alloc(0);
  let anchor: Buffer = Buffer.alloc(0);
  let rows: ReadonlyArray<Record<string, unknown>> = [];
  // W1-T11260: the last unterminated trailing line, its parse, and the array returned with it.
  let pendingBytes: Buffer = Buffer.alloc(0);
  let pendingRow: Record<string, unknown> | undefined;
  let withPending: ReadonlyArray<Record<string, unknown>> | undefined;
  const reset = (): void => {
    identity = undefined;
    seenStat = undefined;
    offset = 0;
    head = Buffer.alloc(0);
    anchor = Buffer.alloc(0);
    rows = [];
    pendingBytes = Buffer.alloc(0);
    pendingRow = undefined;
    withPending = undefined;
  };
  const bytesAt = (fd: number, from: number, length: number): Buffer => {
    const out = Buffer.alloc(length);
    return out.subarray(0, length === 0 ? 0 : readSync(fd, out, 0, length, from));
  };
  return (nowMs) => {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (error) {
      reset();
      // A missing live ledger reads as no rows, as readLedgerLines' existsSync check returns; anything else is rethrown.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      const seen = `${stat.dev}:${stat.ino}`;
      // The bytes after `offset`: complete lines not yet parsed, then the pending line.
      let chunk: Buffer;
      const unchanged = seen === identity && seenStat !== undefined && stat.size === seenStat.size &&
        stat.mtimeMs === seenStat.mtimeMs && stat.ctimeMs === seenStat.ctimeMs && stat.size === offset + pendingBytes.length;
      if (unchanged) {
        // W1-T13367: the same file, size and times as the last full read: no byte is read again.
        chunk = pendingBytes;
      } else {
        let from = 0;
        let read: Buffer | undefined;
        if (seen === identity && stat.size >= offset) {
          // One read from the anchor to the end. The anchor's bytes must be unchanged; the head is read again only
          // when the file did not grow, as a rewrite in place of the same or a smaller size can leave it so.
          from = offset - anchor.length;
          read = bytesAt(fd, from, stat.size - from);
          const grew = stat.size > offset + pendingBytes.length;
          const sameHead = from === 0 || grew || bytesAt(fd, 0, head.length).equals(head);
          if (read.length < anchor.length || !read.subarray(0, anchor.length).equals(anchor) || !sameHead) read = undefined;
        }
        if (read === undefined) {
          reset();
          identity = seen;
          from = 0;
          read = bytesAt(fd, 0, stat.size);
        }
        chunk = read.subarray(offset - from);
        const next = offset + chunk.lastIndexOf(NEWLINE) + 1;
        // The new head and anchor come from the bytes just read: the read starts at most ANCHOR_BYTES before `offset`.
        const guard = Math.min(ANCHOR_BYTES, next);
        if (from === 0) head = Buffer.from(read.subarray(0, guard));
        anchor = Buffer.from(read.subarray(next - from - guard, next - from));
        seenStat = from + read.length === stat.size ? { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } : undefined;
      }
      const end = chunk.lastIndexOf(NEWLINE) + 1;
      const appended: Array<Record<string, unknown>> = [];
      let start = 0;
      if (pendingRow && chunk[pendingBytes.length] === NEWLINE &&
          chunk.subarray(0, pendingBytes.length).equals(pendingBytes)) {
        appended.push(pendingRow);
        start = pendingBytes.length + 1;
      }
      parseLines(path, chunk.subarray(start, end).toString("utf8"), appended, keepLine);
      offset += end;
      const cutoff = nowMs - retainMs;
      // Nothing can age out of an unbounded tail that keeps untimed rows, so an unchanged read allocates nothing.
      const dropsNone = cutoff === Number.NEGATIVE_INFINITY && keepUntimed;
      const before = rows;
      if (appended.length > 0) rows = rows.concat(appended);
      if (!dropsNone) {
        const kept = rows.filter((row) => retained(row, cutoff, keepUntimed));
        if (kept.length !== rows.length) rows = kept;
      }
      const tailBytes = chunk.subarray(end);
      if (end > 0 || !tailBytes.equals(pendingBytes)) {
        pendingBytes = Buffer.from(tailBytes);
        pendingRow = tentativeRow(tailBytes.toString("utf8"), keepLine);
        withPending = undefined;
      }
      if (!pendingRow || !retained(pendingRow, cutoff, keepUntimed)) return rows;
      if (!withPending || rows !== before) withPending = [...rows, pendingRow];
      return withPending;
    } catch (error) {
      reset();
      throw error;
    } finally {
      closeSync(fd);
    }
  };
}
