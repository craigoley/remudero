import { closeSync, createReadStream, existsSync, fstatSync, mkdtempSync, openSync, read as readFd, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { ledgerLivePath, listedLedgerFiles, openLedgerUnion } from "./ledger-union.js";

type Row = Record<string, unknown>;

export interface PrOwnerLedgerProjection {
  archiveFiles: string[];
  liveFileRead: boolean;
  filesRead: number;
  unread: string[];
  ok: boolean;
  corpusNewestTs?: string;
  latestFix?: Row;
  latestSweep?: Row;
  relatedClaimKeys: string[];
}

function prNumber(row: Row): number | undefined {
  if (typeof row.pr_number === "number" && Number.isInteger(row.pr_number) && row.pr_number > 0) return row.pr_number;
  if (typeof row.pr_url !== "string") return undefined;
  const match = /\/pull\/(\d+)(?:[/?#].*)?$/.exec(row.pr_url);
  return match ? Number(match[1]) : undefined;
}

type PinnedLive = { kind: "opened"; fd: number; size: number }
  | { kind: "missing" }
  | { kind: "unreadable"; error: unknown };

function pinLivePrefix(path: string): PinnedLive {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    return { kind: "opened", fd, size: fstatSync(fd).size };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" } : { kind: "unreadable", error };
  }
}

/** Read only the ledger/claims; exact replay and legacy task joins use owned, finally-removed
 * temporary disk scratch, never a retained corpus array or a whole expanded gzip buffer.
 * The prefix is observational, not an atomic filesystem snapshot: later appends are outside it. */
export async function readPrOwnerLedgerProjection(
  stateDir: string,
  targetPr: number,
  readClaimKeys: () => string[],
): Promise<PrOwnerLedgerProjection> {
  const result: PrOwnerLedgerProjection = {
    archiveFiles: [], liveFileRead: false, filesRead: 0, unread: [], ok: false, relatedClaimKeys: [],
  };
  const livePath = ledgerLivePath(stateDir);
  let liveFd: number | undefined;
  let liveSize = 0;
  let liveBytes = 0;
  let scratch: string | undefined;
  let db: DatabaseSync | undefined;
  try {
    // Pin before listing: a concurrent rotation may also list this inode as an archive;
    // exact replay dedupe handles that overlap. Do not reopen a replacement live pathname.
    const pinned = pinLivePrefix(livePath);
    if (pinned.kind === "opened") {
      liveFd = pinned.fd;
      liveSize = pinned.size;
      result.liveFileRead = true;
    } else if (pinned.kind === "unreadable") {
      result.unread.push(livePath);
    }
    const names = readdirSync(stateDir);
    const manifest = listedLedgerFiles(stateDir, { readdirSync: () => names, readFileSync });
    result.archiveFiles = manifest.rotations.map((entry) => entry.path);
    // Match the original requireArchives early refusal, including its live-presence receipt.
    if (result.archiveFiles.length === 0) return result;
    scratch = mkdtempSync(join(tmpdir(), "rmd-pr-owner-projection-"));
    const databasePath = join(scratch, "projection.sqlite");
    closeSync(openSync(databasePath, "wx", 0o600));
    db = new DatabaseSync(databasePath);
    db.exec(`
      PRAGMA temp_store=FILE;
      CREATE TABLE evidence(raw TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, kind TEXT NOT NULL,
        ms REAL, task TEXT, head TEXT, direct INTEGER NOT NULL);
      CREATE TABLE newest_ties(raw TEXT PRIMARY KEY);
      BEGIN;
    `);
    const addEvidence = db.prepare("INSERT OR IGNORE INTO evidence VALUES (?, ?, ?, ?, ?, ?, ?)");
    const addTie = db.prepare("INSERT OR IGNORE INTO newest_ties VALUES (?)");
    const clearTies = db.prepare("DELETE FROM newest_ties");
    let newestMs = Number.NEGATIVE_INFINITY;
    let ordinal = 0;
    let projectionFailure: unknown;
    for await (const _row of openLedgerUnion(stateDir, {
      dedupe: false,
      onUnreadDirectory: (path) => result.unread.push(path),
      onUnreadArchive: (path) => result.unread.push(path),
      onUnreadLive: (path) => result.unread.push(path),
      onAcceptedRecord: (row, raw) => {
        try {
          ordinal += 1;
          const ms = typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
          if (Number.isFinite(ms) && ms >= newestMs) {
            if (ms > newestMs) {
              clearTies.run();
              newestMs = ms;
            }
            // Only first sightings compete in a timestamp tie. A replay A after B must not
            // replace B, including equal parsed dates with different original ts spellings.
            if (addTie.run(raw).changes > 0) result.corpusNewestTs = row.ts as string;
          }
          const kind = row.step;
          if (kind !== "fix.dispatch" && !(kind === "sweep.disposed" && prNumber(row) === targetPr)) return;
          addEvidence.run(raw, ordinal, kind, Number.isFinite(ms) ? ms : null,
            typeof row.task_id === "string" ? row.task_id : null,
            typeof row.head_sha === "string" ? row.head_sha : null,
            prNumber(row) === targetPr ? 1 : 0);
        } catch (error) {
          // openLedgerUnion reports a failed callback as unread source; preserve the underlying
          // scratch error too, and refuse the entire projection rather than using partial facts.
          projectionFailure = error;
          throw error;
        }
      },
    }, {
      readdirSync: () => names,
      readFileSync,
      existsSync: (path) => path === livePath ? liveFd !== undefined : existsSync(path),
      createReadStream: (path) => {
        let source: Readable;
        if (path === livePath) {
          const fd = liveFd;
          if (fd === undefined) throw new Error("pinned live ledger unavailable");
          source = liveSize === 0 ? Readable.from([])
            : createReadStream(path, { fd, autoClose: false, start: 0, end: liveSize - 1,
              // The union destroys each stream; only this function owns the pinned descriptor.
              fs: { read: readFd, close: (_fd, done) => done(null) },
            });
          source.on("data", (chunk: Buffer | string) => { liveBytes += Buffer.byteLength(chunk); });
          result.filesRead += 1;
        } else {
          source = createReadStream(path);
          source.once("open", () => { result.filesRead += 1; });
        }
        return source;
      },
    })) {
      // Rows are projected in the raw-line callback and released on each generator advance.
    }
    if (projectionFailure !== undefined) throw projectionFailure;
    if (liveFd !== undefined && !result.unread.includes(livePath) && (liveBytes !== liveSize || fstatSync(liveFd).size < liveSize)) {
      result.unread.push(livePath);
    }
    db.exec("COMMIT");
    // Invalid-time rows still contribute task/head associations and claim joins.
    const eligibleFix = `kind='fix.dispatch' AND (direct=1 OR (
      task IN (SELECT task FROM evidence WHERE kind='sweep.disposed' AND task<>'' AND task<>'SWEEP')
      AND (head IS NULL OR NOT EXISTS(SELECT 1 FROM evidence WHERE kind='sweep.disposed' AND head<>'')
        OR head IN (SELECT head FROM evidence WHERE kind='sweep.disposed' AND head<>''))))`;
    const latest = (where: string): Row | undefined => {
      const found = db!.prepare(`SELECT raw FROM evidence WHERE ${where} AND ms IS NOT NULL ORDER BY ms DESC, ordinal DESC LIMIT 1`).get();
      return found ? JSON.parse(found.raw as string) as Row : undefined;
    };
    const claimKeys = readClaimKeys();
    const related = new Set<string>();
    for (const row of db.prepare(`SELECT DISTINCT task FROM evidence WHERE task<>'' AND
      ((kind='sweep.disposed' AND task<>'SWEEP') OR (${eligibleFix}))`).iterate()) {
      for (const key of claimKeys) if (key.includes(`run-${row.task as string}-`)) related.add(key);
    }
    result.ok = result.unread.length === 0;
    if (result.ok) {
      result.latestFix = latest(`(${eligibleFix})`);
      result.latestSweep = latest("kind='sweep.disposed'");
      result.relatedClaimKeys = [...related];
    } else {
      // The synchronous strict reader discards all rows, including its newest timestamp.
      delete result.corpusNewestTs;
    }
    return result;
  } catch (error) {
    delete result.latestFix;
    delete result.latestSweep;
    result.relatedClaimKeys = [];
    result.unread.push(String((error as Error)?.message ?? error));
    delete result.corpusNewestTs;
    return { ...result, ok: false };
  } finally {
    try { db?.close(); } finally {
      try { if (liveFd !== undefined) closeSync(liveFd); } finally {
        if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
      }
    }
  }
}
