import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FileTail {
  state: "complete" | "truncated" | "unreadable" | "malformed" | "absent";
  text: string;
  bytesRead: number;
  fileBytes?: number;
  reason?: string;
}

const reasonOf = (error: unknown): string => String((error as Error)?.message ?? error).slice(0, 240);

/** Reads at most maxBytes from one descriptor; a tail never attests to the omitted prefix. */
export function readBoundedFileTail(path: string, maxBytes: number): FileTail {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("invalid byte bound");
  let fd: number | undefined;
  let result: FileTail = { state: "unreadable", text: "", bytesRead: 0 };
  try {
    fd = fs.openSync(path, "r");
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error("report is not a regular file");
    result.fileBytes = before.size;
    const length = Math.min(maxBytes, before.size);
    const offset = before.size - length;
    const buf = Buffer.alloc(length);
    while (result.bytesRead < length) {
      const count = fs.readSync(fd, buf, result.bytesRead, length - result.bytesRead, offset + result.bytesRead);
      if (count === 0) throw new Error("short read: report changed while reading");
      result.bytesRead += count;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("report changed while reading");
    let start = 0;
    if (offset > 0) while (start < Math.min(3, buf.length) && (buf[start]! & 0xc0) === 0x80) start++;
    try {
      result.text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf.subarray(start));
      result.state = offset > 0 ? "truncated" : "complete";
    } catch (error) {
      result = { ...result, state: "malformed", reason: reasonOf(error) };
    }
  } catch (error) {
    result = { ...result,
      state: fd === undefined && (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "unreadable",
      reason: reasonOf(error) };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); }
      catch (error) { result = { ...result, state: "unreadable", reason: reasonOf(error) }; }
    }
  }
  return result;
}

/** Small streams stay in memory; larger streams spill to disposable scratch before a bounded read. */
export class BoundedOutput {
  private chunks: string[] = [];
  private bytes = 0;
  private dir?: string;
  private failure?: string;
  private finished?: { chunks: string[]; evidence: Omit<FileTail, "text"> };

  constructor(private readonly maxBytes: number, private readonly separator = "") {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("invalid byte bound");
  }

  push(text: string): void {
    if (this.finished || this.failure || !text) return;
    const prefix = this.bytes > 0 ? this.separator : "";
    this.bytes += Buffer.byteLength(prefix) + Buffer.byteLength(text);
    if (!this.dir && this.bytes <= this.maxBytes) {
      this.chunks.push(text);
      return;
    }
    try {
      if (!this.dir) {
        this.dir = fs.mkdtempSync(join(tmpdir(), "rmd-worker-output-"));
        this.append(this.chunks.join(this.separator));
        this.chunks = [];
      }
      this.append(prefix);
      this.append(text);
    } catch (error) {
      const reason = reasonOf(error);
      this.failure = reason;
      this.chunks = [];
    }
  }

  private append(text: string): void {
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 8192, text.length);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
      fs.appendFileSync(join(this.dir!, "output"), text.slice(start, end), { mode: 0o600 });
      start = end;
    }
  }

  finish(read: typeof readBoundedFileTail = readBoundedFileTail): { chunks: string[]; evidence: Omit<FileTail, "text"> } {
    if (this.finished) return this.finished;
    let tail: FileTail = this.failure
      ? { state: "unreadable", text: "", bytesRead: 0, reason: this.failure }
      : this.dir ? read(join(this.dir, "output"), this.maxBytes)
      : { state: "complete", text: "", bytesRead: this.bytes, fileBytes: this.bytes };
    if (this.dir) {
      try { fs.rmSync(this.dir, { recursive: true, force: true }); }
      catch (error) { tail = { ...tail, state: "unreadable", reason: reasonOf(error) }; }
    }
    const { text, ...evidence } = tail;
    const chunks = this.dir || this.failure ? (text ? [text] : []) : this.chunks;
    this.chunks = [];
    this.finished = { chunks, evidence };
    return this.finished;
  }
}
