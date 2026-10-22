import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RmdError } from "./errors.js";

export class LedgerExactDedupeError extends RmdError {
  constructor(readonly reason: "ledger-dedupe-storage-bound" | "ledger-dedupe-unavailable", options?: ErrorOptions) {
    super("read-model", 1, reason);
    if (options && "cause" in options) this.cause = options.cause;
  }
}

/** Exact UTF-16 identities on private disk, with a finite SQLite page/cache budget.
 * No hash collision, replay-window eviction, corpus-sized JS Set or persistent raw-row cache.
 * The bound is a refusal: callers must report an incomplete scan, never count unknown replays.
 */
export function createLedgerExactDedupe(maxBytes = 128 * 1024 ** 2) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 16_384 || maxBytes > 128 * 1024 ** 2)
    throw new TypeError("exact ledger dedupe budget must be 16 KiB through 128 MiB");
  const directory = mkdtempSync(join(tmpdir(), "rmd-ledger-exact-dedupe-"));
  chmodSync(directory, 0o700);
  let db: DatabaseSync | undefined;
  let closed = false;
  let accepted = 0, replayed = 0;
  let failureReason: LedgerExactDedupeError["reason"] | undefined;
  const pageLimit = Math.floor(maxBytes / 4096);
  try {
    db = new DatabaseSync(join(directory, "seen.sqlite"), { allowExtension: false });
    chmodSync(join(directory, "seen.sqlite"), 0o600);
    db.exec(`PRAGMA page_size=4096; PRAGMA max_page_count=${pageLimit}; PRAGMA cache_size=-2048;
      PRAGMA mmap_size=0; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
      CREATE TABLE seen (raw BLOB PRIMARY KEY NOT NULL) WITHOUT ROWID;`);
    const insert = db.prepare("INSERT OR IGNORE INTO seen(raw) VALUES (?)");
    const observed = db.prepare("PRAGMA page_count");
    const limit = db.prepare("PRAGMA max_page_count").get()!;
    if (limit.max_page_count !== pageLimit) throw new Error("native page bound was not applied");
    // One ephemeral transaction avoids a flush for every row. Any write failure seals it;
    // the database is never reopened or rolled back for reuse, and close removes all bytes.
    db.exec("BEGIN");
    return {
      add(raw: string): boolean {
        if (closed || failureReason) throw new LedgerExactDedupeError(failureReason ?? "ledger-dedupe-unavailable");
        // Every UTF-16 code unit needs two BLOB bytes. A key larger than the
        // entire existing page budget cannot fit, so refuse before allocating it.
        if (raw.length > pageLimit * 2048) {
          failureReason = "ledger-dedupe-storage-bound";
          throw new LedgerExactDedupeError(failureReason);
        }
        try {
          // UTF-16 preserves JS string identity even for distinct unpaired surrogates.
          const fresh = insert.run(Buffer.from(raw, "utf16le")).changes === 1;
          if (fresh) accepted++; else replayed++;
          return fresh;
        } catch (error) {
          const code = (error as { errcode?: unknown }).errcode;
          failureReason = code === 13 ? "ledger-dedupe-storage-bound" : "ledger-dedupe-unavailable";
          throw new LedgerExactDedupeError(failureReason);
        }
      },
      evidence() {
        if (closed) throw new LedgerExactDedupeError("ledger-dedupe-unavailable");
        return { method: "exact-utf16-sqlite-bounded-pages" as const, accepted, replayed,
          maxBytes: pageLimit * 4096, pageBytes: failureReason ? null : Number(observed.get()!.page_count) * 4096,
          complete: failureReason === undefined, failureReason: failureReason ?? null,
          cacheTargetBytes: 2 * 1024 ** 2, mmapBytes: 0,
          databaseMode: statSync(join(directory, "seen.sqlite")).mode & 0o777,
          directoryMode: statSync(directory).mode & 0o777 };
      },
      close() {
        if (closed) return;
        closed = true;
        try { db!.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    try { db?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
    throw new LedgerExactDedupeError("ledger-dedupe-unavailable", { cause: error });
  }
}
