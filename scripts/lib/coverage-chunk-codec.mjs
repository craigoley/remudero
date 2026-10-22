import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { constants as zlibConstants, gzipSync, gunzipSync } from 'node:zlib';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Compress only when it reduces bytes. The decoded length and digest bind the original JSON. */
export function encodeCoverageChunk(source) {
  const original = Buffer.from(source);
  const compressed = gzipSync(original, { level: zlibConstants.Z_BEST_SPEED });
  const data = compressed.length < original.length ? compressed : original;
  return { data, encoding: data === compressed ? 'gzip' : 'identity',
    decodedBytes: original.length, sha256: digest(original) };
}

export function validCoverageChunkEncoding(chunk, limit) {
  return ['gzip', 'identity'].includes(chunk?.encoding) && Number.isSafeInteger(chunk.decodedBytes) &&
    chunk.decodedBytes > 0 && chunk.decodedBytes <= limit && /^[a-f0-9]{64}$/.test(chunk.sha256);
}

/** Pin a regular file, read no more than its declared bound, and reject replacement or mutation. */
export function readCoverageChunkBytes(path, expectedBytes, limit, { read = readSync } = {}) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > limit) {
    throw new Error(`${path} has an invalid coverage chunk byte bound`);
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size !== expectedBytes) throw new Error(`${path} has a coverage chunk size mismatch`);
    const data = Buffer.alloc(expectedBytes);
    let offset = 0;
    while (offset < data.length) {
      const count = read(fd, data, offset, Math.min(64 * 1024, data.length - offset), offset);
      if (count === 0) throw new Error(`${path} has a truncated coverage chunk`);
      offset += count;
    }
    const after = fstatSync(fd), current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino ||
        current.uid !== before.uid || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs) throw new Error(`${path} has a changed coverage chunk`);
    return data;
  } finally { closeSync(fd); }
}

/** The decompressor cannot allocate past the declared decoded bound, even for a valid gzip bomb. */
export function decodeCoverageChunk(data, chunk, limit) {
  if (!validCoverageChunkEncoding(chunk, limit)) throw new Error('invalid coverage chunk encoding metadata');
  const original = chunk.encoding === 'gzip' ? gunzipSync(data, { maxOutputLength: chunk.decodedBytes }) : data;
  if (original.length !== chunk.decodedBytes || digest(original) !== chunk.sha256) {
    throw new Error('coverage chunk decoded size or checksum mismatch');
  }
  return original.toString('utf8');
}
