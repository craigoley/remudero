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
 * A trailing line with no newline yet is parsed for this call but not consumed. A missing file reads as no
 * rows. Any other read error clears the state and is rethrown, so the next call starts over.
 * Rows timed before `nowMs - retainMs`, or with no parseable `ts`, are dropped: no window can reach them.
 */
export type LiveLedgerTail = (nowMs: number) => ReadonlyArray<Record<string, unknown>>;

const NEWLINE = 0x0a;
const ANCHOR_BYTES = 64;

function rowMs(row: Record<string, unknown>): number | undefined {
  const parsed = typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseLines(path: string, text: string, out: Array<Record<string, unknown>>): void {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      console.error(`ledger: dropping unparseable line in ${path}: ${line}`);
    }
  }
}

function tentativeRow(text: string): Record<string, unknown> | undefined {
  const line = text.trim();
  if (!line) return undefined;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    // A line still being written is not torn yet: it is skipped this call and parsed once its newline lands.
    return undefined;
  }
}

export function createLiveLedgerTail(path: string, retainMs: number): LiveLedgerTail {
  let identity: string | undefined;
  let offset = 0;
  let head: Buffer = Buffer.alloc(0);
  let anchor: Buffer = Buffer.alloc(0);
  let rows: Array<Record<string, unknown>> = [];
  const reset = (): void => {
    identity = undefined;
    offset = 0;
    head = Buffer.alloc(0);
    anchor = Buffer.alloc(0);
    rows = [];
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
      const rewritten = offset > 0 && (!bytesAt(fd, 0, head.length).equals(head) ||
        !bytesAt(fd, offset - anchor.length, anchor.length).equals(anchor));
      if (seen !== identity || stat.size < offset || rewritten) {
        reset();
        identity = seen;
      }
      const buffer = Buffer.alloc(stat.size - offset);
      const read = buffer.length === 0 ? 0 : readSync(fd, buffer, 0, buffer.length, offset);
      const chunk = buffer.subarray(0, read);
      const end = chunk.lastIndexOf(NEWLINE) + 1;
      parseLines(path, chunk.subarray(0, end).toString("utf8"), rows);
      offset += end;
      if (offset > 0) {
        head = bytesAt(fd, 0, Math.min(ANCHOR_BYTES, offset));
        anchor = bytesAt(fd, offset - Math.min(ANCHOR_BYTES, offset), Math.min(ANCHOR_BYTES, offset));
      }
      const cutoff = nowMs - retainMs;
      rows = rows.filter((row) => {
        const t = rowMs(row);
        return t !== undefined && t > cutoff;
      });
      const pending = tentativeRow(chunk.subarray(end).toString("utf8"));
      return pending ? [...rows, pending] : rows;
    } catch (error) {
      reset();
      throw error;
    } finally {
      closeSync(fd);
    }
  };
}
