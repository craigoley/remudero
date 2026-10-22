/** Read a bounded tail without allocating the entire history or following a link. */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export function readBoundedFileTail(path: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("tail byte bound must be a positive integer");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error("tail source must be a regular file");
    const length = Math.min(file.size, maxBytes), start = file.size - length;
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, bytes, offset, length - offset, start + offset);
      if (count === 0) throw Object.assign(new Error("tail source truncated during read"), { code: "EIO" });
      offset += count;
    }
    const text = bytes.toString("utf8");
    if (start === 0) return text;
    const firstNewline = text.indexOf("\n");
    return firstNewline < 0 ? "" : text.slice(firstNewline + 1);
  } finally {
    closeSync(fd);
  }
}
