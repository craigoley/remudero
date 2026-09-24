/**
 * The console snapshots, kept across a serve restart. Serve restarts on most merges to main (10 in 3 h
 * measured 2026-09-24), and every restart emptied the in-memory snapshots, so the first console reads
 * after it were cold. Each changed snapshot is written here (tmp + rename; a cache needs no fsync), and
 * a restarted serve answers its first read from the file, labelled with its true age, while it
 * refreshes. A record carries the contract version (a mismatch is ignored) and the code revision that
 * produced it (reported, never trusted as current). Bodies over the size bound are not written.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { systemClock, type Clock } from "./clock.js";

export const CONSOLE_SNAPSHOT_CONTRACT = 1;
export const CONSOLE_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024; // BACKSTOP: the largest live body (inbox) is 1.6 MB
export const CONSOLE_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // BACKSTOP: a restored snapshot is labelled stale at any age

/** A buffered route response as the snapshot cache holds it. */
export interface PersistedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  generatedAtMs: number;
  etag?: string;
  jsonObject?: boolean;
}

export interface RestoredSnapshot {
  key: string;
  cached: PersistedResponse;
  codeRev: string;
}

export interface ConsoleSnapshotStore {
  restore(path: string): Promise<RestoredSnapshot[]>;
  save(path: string, key: string, cached: PersistedResponse): Promise<void>;
}

interface SnapshotRecord {
  contract: number;
  codeRev: string;
  path: string;
  key: string;
  cached: PersistedResponse;
}

function isRecord(value: unknown): value is SnapshotRecord {
  const r = value as SnapshotRecord;
  return !!r && r.contract === CONSOLE_SNAPSHOT_CONTRACT && typeof r.path === "string" && typeof r.key === "string" &&
    !!r.cached && typeof r.cached.body === "string" && typeof r.cached.generatedAtMs === "number" && typeof r.cached.status === "number";
}

export function createConsoleSnapshotStore(options: {
  dir: string;
  codeRev: string;
  clock?: Clock;
  log?: (step: string, extra: Record<string, unknown>) => void;
  maxBytes?: number;
}): ConsoleSnapshotStore {
  const clock = options.clock ?? systemClock;
  const maxBytes = options.maxBytes ?? CONSOLE_SNAPSHOT_MAX_BYTES;
  let all: Promise<SnapshotRecord[]> | undefined;

  const readAll = async (): Promise<SnapshotRecord[]> => {
    let names: string[];
    try {
      names = await readdir(options.dir);
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code ?? String(error);
      if (reason !== "ENOENT") options.log?.("serve.console_snapshot_restore_failed", { reason });
      return [];
    }
    const records: SnapshotRecord[] = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      try {
        const parsed: unknown = JSON.parse(await readFile(join(options.dir, name), "utf8"));
        if (isRecord(parsed) && clock.now() - parsed.cached.generatedAtMs <= CONSOLE_SNAPSHOT_MAX_AGE_MS) records.push(parsed);
      } catch (error) {
        options.log?.("serve.console_snapshot_restore_failed", { file: name, reason: String((error as Error)?.message ?? error) });
      }
    }
    return records;
  };

  return {
    restore: async (path) => {
      all ??= readAll();
      return (await all).filter((r) => r.path === path).map((r) => ({ key: r.key, cached: r.cached, codeRev: r.codeRev }));
    },
    save: async (path, key, cached) => {
      const record: SnapshotRecord = { contract: CONSOLE_SNAPSHOT_CONTRACT, codeRev: options.codeRev, path, key, cached };
      const text = JSON.stringify(record);
      if (Buffer.byteLength(text) > maxBytes) {
        options.log?.("serve.console_snapshot_too_large", { path, bytes: Buffer.byteLength(text), maxBytes });
        return;
      }
      const file = join(options.dir, `${createHash("sha1").update(`${path}\n${key}`).digest("base64url")}.json`);
      const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await mkdir(options.dir, { recursive: true });
        await writeFile(tmp, text, { mode: 0o600 });
        await rename(tmp, file);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {
          // The stage may never have been created (the directory itself is unusable); the save failure below is the report.
        });
        options.log?.("serve.console_snapshot_save_failed", { path, reason: String((error as Error)?.message ?? error) });
      }
    },
  };
}
