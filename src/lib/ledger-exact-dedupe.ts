import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RmdError } from "./errors.js";

export interface LedgerExactDedupeOptions {
  scratchDir?: string;
  maxDiskBytes?: number;
  cacheBytes?: number;
  maxRowBytes?: number;
}

export class LedgerExactDedupeLimitError extends RmdError {
  constructor(public readonly reason: string, options?: ErrorOptions) {
    super("read-model", 1, reason);
    this.cause = options?.cause;
    this.name = "LedgerExactDedupeLimitError";
  }
}

export function createLedgerExactDedupe(options: LedgerExactDedupeOptions = {}) {
  const { maxDiskBytes = 256 * 1024 * 1024, cacheBytes = 2 * 1024 * 1024,
    maxRowBytes = 1024 * 1024 } = options;
  for (const [name, value, minimum] of [["disk", maxDiskBytes, 12288], ["cache", cacheBytes, 1024], ["row", maxRowBytes, 1]] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`invalid ledger ${name} byte bound`);
  }
  let dir: string | undefined;
  let db: DatabaseSync | undefined;
  try {
    dir = mkdtempSync(join(options.scratchDir ?? tmpdir(), "rmd-ledger-exact-"));
    db = new DatabaseSync(join(dir, "seen.sqlite"));
    db.exec(`PRAGMA page_size = 4096; PRAGMA max_page_count = ${Math.floor(maxDiskBytes / 4096)};
      PRAGMA cache_size = -${Math.floor(cacheBytes / 1024)}; PRAGMA mmap_size = 0;
      PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY;
      CREATE TABLE seen (raw BLOB PRIMARY KEY) WITHOUT ROWID; BEGIN`);
    const insert = db.prepare("INSERT OR IGNORE INTO seen VALUES (?)");
    let rows = 0;
    let failure: LedgerExactDedupeLimitError | undefined;
    return {
      isError: (error: unknown): error is LedgerExactDedupeLimitError => error instanceof LedgerExactDedupeLimitError,
      rowLimitError: () => new LedgerExactDedupeLimitError("ledger-row-byte-bound"),
      add(raw: string): boolean {
        if (failure) throw failure;
        if (raw.length * 2 > maxRowBytes) throw new LedgerExactDedupeLimitError("ledger-row-byte-bound");
        try {
          // UTF-8 replaces lone surrogates. UTF-16 code units preserve exact JS string identity.
          const added = insert.run(Buffer.from(raw, "utf16le")).changes !== 0;
          if (added) rows++;
          return added;
        } catch (error) {
          const full = (error as { errcode?: number }).errcode === 13;
          failure = new LedgerExactDedupeLimitError(full ? "ledger-dedupe-disk-bound" : "ledger-dedupe-index-failed", { cause: error });
          throw failure;
        }
      },
      stats() {
        const pages = db!.prepare("PRAGMA page_count").get() as { page_count: number };
        return { rows, diskBytes: statSync(join(dir!, "seen.sqlite")).size, allocatedBytes: pages.page_count * 4096,
          maxDiskBytes, cacheTargetBytes: Math.floor(cacheBytes / 1024) * 1024, maxRowBytes,
          state: failure ? "partial" : "observed", reason: failure?.reason ?? null };
      },
      close() {
        try { db?.close(); db = undefined; }
        finally { rmSync(dir!, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    try { db?.close(); }
    finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
    throw new LedgerExactDedupeLimitError("ledger-dedupe-index-unavailable", { cause: error });
  }
}
