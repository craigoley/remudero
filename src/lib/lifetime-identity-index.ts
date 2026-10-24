import { DatabaseSync } from "node:sqlite";
import type { LifetimeDispatchTally } from "./status.js";

// Proposed private policy: 32 MiB of main-database pages; rollback journal stays in memory.
export const LIFETIME_INDEX_PAGE_BYTES = 4_096;
export const LIFETIME_INDEX_MAX_PAGES = 8_192;
// SQLite's cache_size is an advisory page-cache target, not a hard RSS ceiling.
export const LIFETIME_INDEX_CACHE_KIB = 256;

type Unavailable = "start_identity_missing" | "start_identity_ceiling" | "identity_index_unavailable";
export interface LifetimeIndexFailure { reason: Unavailable; detail?: string }
type StoredIdentity = { task_id: string; run_id: string; started: number; terminal: number | null; charged: number };

function statements(db: DatabaseSync) {
  return {
    identity: db.prepare("SELECT task_id, run_id, started, terminal, charged FROM identities WHERE identity = ?"),
    task: db.prepare("SELECT identity_count FROM tasks WHERE task_id = ?"),
    ensureTask: db.prepare("INSERT OR IGNORE INTO tasks(task_id) VALUES (?)"),
    addIdentity: db.prepare("INSERT INTO identities VALUES (?, ?, ?, ?, ?, ?)"),
    countIdentity: db.prepare("UPDATE tasks SET identity_count = identity_count + 1 WHERE task_id = ?"),
    terminal: db.prepare("UPDATE identities SET terminal = ?, charged = ? WHERE identity = ?"),
    pending: db.prepare("SELECT identity, run_id, charged FROM identities WHERE task_id = ? AND started = 1 AND terminal IS NULL"),
    pendingCharge: db.prepare("UPDATE identities SET charged = ? WHERE identity = ?"),
  };
}

/** Exact, disposable identity storage. The caller supplies the existing identity/refusal semantics.
 * A per-task or resident-join overflow invalidates the whole history, as does any index I/O failure.
 * The anonymous temporary database is rebuilt from the ledger and never reused after failure.
 */
export function createIndexedLifetimeAccounting(
  identitiesPerTask: number,
  options: { maxPages?: number; database?: () => DatabaseSync; onUnavailable?: (failure: LifetimeIndexFailure) => void } = {},
) {
  let db: DatabaseSync | undefined;
  let sql: ReturnType<typeof statements> | undefined;
  let unavailable: Unavailable | undefined;
  let lastError: string | undefined;
  // The resident join budget still covers task tallies and terminal decisions awaiting a start.
  // All started identity keys live in the bounded exact index, including distant replays.
  const tallies = new Map<string, LifetimeDispatchTally>();
  const earlyVerdicts = new Map<string, boolean>();
  const residentKeys = () => tallies.size + earlyVerdicts.size;
  let notified: string | undefined;
  const notify = () => {
    if (unavailable === undefined) return;
    const key = JSON.stringify([unavailable, lastError]);
    if (key === notified) return;
    notified = key;
    try { options.onUnavailable?.({ reason: unavailable, ...(lastError === undefined ? {} : { detail: lastError }) }); }
    catch { /* Observation failure never restores a partially measured history. */ }
  };
  const close = (): boolean => {
    tallies.clear();
    earlyVerdicts.clear();
    if (db === undefined) { notify(); return true; }
    const owned = db;
    db = undefined;
    sql = undefined;
    try { owned.close(); notify(); return true; }
    catch (error) {
      unavailable ??= "identity_index_unavailable";
      const cleanup = String(error);
      lastError = lastError === undefined ? cleanup : `${lastError}; cleanup failed: ${cleanup}`;
      notify();
      return false;
    }
  };
  const fail = (error: unknown) => {
    unavailable ??= "identity_index_unavailable";
    lastError = String(error);
    close();
  };
  try {
    const maxPages = options.maxPages ?? LIFETIME_INDEX_MAX_PAGES;
    if (!Number.isSafeInteger(identitiesPerTask) || identitiesPerTask < 1 ||
        !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > LIFETIME_INDEX_MAX_PAGES) throw new Error("invalid lifetime index policy");
    db = (options.database ?? (() => new DatabaseSync("")))();
    db.exec(`PRAGMA page_size=${LIFETIME_INDEX_PAGE_BYTES}; PRAGMA max_page_count=${maxPages};
      PRAGMA cache_size=-${LIFETIME_INDEX_CACHE_KIB}; PRAGMA journal_mode=MEMORY;`);
    if (Number(db.prepare("PRAGMA page_size").get()?.page_size) !== LIFETIME_INDEX_PAGE_BYTES ||
        Number(db.prepare("PRAGMA max_page_count").get()?.max_page_count) !== maxPages ||
        Number(db.prepare("PRAGMA cache_size").get()?.cache_size) !== -LIFETIME_INDEX_CACHE_KIB ||
        db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "memory") throw new Error("lifetime index policy was not applied");
    db.exec(`CREATE TABLE tasks(task_id TEXT PRIMARY KEY, identity_count INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
      CREATE TABLE identities(identity TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL,
      started INTEGER NOT NULL, terminal INTEGER, charged INTEGER NOT NULL) WITHOUT ROWID;
      CREATE INDEX pending_by_task ON identities(task_id, started, terminal);`);
    sql = statements(db);
  } catch (error) { fail(error); }
  const admit = (taskId: string): boolean => {
    if (!sql) return false;
    sql.ensureTask.run(taskId);
    if (Number(sql.task.get(taskId)?.identity_count ?? 0) < identitiesPerTask) return true;
    unavailable = "start_identity_ceiling";
    lastError = `per-task start identity budget reached (${identitiesPerTask})`;
    close();
    return false;
  };
  const tallyForRecordedTask = (taskId: string): LifetimeDispatchTally | undefined => {
    const prior = tallies.get(taskId);
    if (prior) return prior;
    if (residentKeys() >= identitiesPerTask) {
      unavailable = "start_identity_ceiling";
      lastError = `resident task/terminal key budget reached (${identitiesPerTask})`;
      close();
      return undefined;
    }
    const tally = { starts: 0, capacityBlocked: 0 };
    tallies.set(taskId, tally);
    return tally;
  };
  return {
    close,
    unavailableReason: () => unavailable,
    error: () => lastError,
    resources() {
      if (!db || unavailable) return undefined;
      try {
        return { pages: Number(db.prepare("PRAGMA page_count").get()?.page_count),
          maxPages: Number(db.prepare("PRAGMA max_page_count").get()?.max_page_count),
          pageBytes: Number(db.prepare("PRAGMA page_size").get()?.page_size),
          cacheKiBHint: -Number(db.prepare("PRAGMA cache_size").get()?.cache_size),
          residentKeys: residentKeys(), residentLimit: identitiesPerTask };
      } catch (error) { fail(error); return undefined; }
    },
    record(row: Record<string, unknown>, identity: string | undefined, excluded: boolean) {
      if (!sql || unavailable) return;
      try {
        if (row.step === "daemon.spawn_infra_blocked") {
          if (typeof row.task === "string") {
            const tally = tallyForRecordedTask(row.task);
            if (tally) tally.capacityBlocked += 1;
          }
          return;
        }
        if (identity === undefined || typeof row.task_id !== "string" || typeof row.run_id !== "string") {
          if (row.step === "run.start") { unavailable = "start_identity_missing"; lastError = "run.start lacks a string task/run identity"; close(); }
          return;
        }
        const taskId = row.task_id;
        const prior = sql.identity.get(identity) as StoredIdentity | undefined;
        if (row.step === "verdict") {
          if (prior?.started === 1) {
            if (prior.terminal === null) {
              const tally = tallyForRecordedTask(prior.task_id);
              if (!tally || !sql) return;
              tally.starts += Number(!excluded) - prior.charged;
              sql.terminal.run(Number(excluded), Number(!excluded), identity);
            }
          } else {
            if (!earlyVerdicts.has(identity) && residentKeys() >= identitiesPerTask) {
              unavailable = "start_identity_ceiling";
              lastError = `resident task/terminal key budget reached (${identitiesPerTask})`;
              close(); return;
            }
            earlyVerdicts.set(identity, excluded);
          }
          return;
        }
        if (row.step !== "run.start" || prior?.started === 1) return;
        const terminal = earlyVerdicts.get(identity);
        earlyVerdicts.delete(identity);
        const tally = tallyForRecordedTask(taskId);
        if (!tally || !admit(taskId) || !sql) return;
        const charged = Number(terminal !== true);
        // Preserve the existing identity-key interpretation even for embedded NUL bytes.
        const runId = identity.slice(identity.indexOf("\u0000") + 1);
        sql.addIdentity.run(identity, taskId, runId, 1, terminal === undefined ? null : Number(terminal), charged);
        sql.countIdentity.run(taskId);
        tally.starts += charged;
      } catch (error) { fail(error); }
    },
    tallyFor(taskId: string, visible: ReadonlySet<unknown>, orphans: ReadonlySet<string>): LifetimeDispatchTally | undefined {
      if (!sql || unavailable) return undefined;
      try {
        for (const run of sql.pending.all(taskId)) {
          if (!visible.has(run.run_id)) continue;
          const charged = Number(!orphans.has(String(run.run_id)));
          const tally = tallies.get(taskId);
          if (!tally) throw new Error("indexed start has no resident task tally");
          tally.starts += charged - Number(run.charged);
          sql.pendingCharge.run(charged, run.identity!);
        }
        return { ...(tallies.get(taskId) ?? { starts: 0, capacityBlocked: 0 }) };
      } catch (error) { fail(error); return undefined; }
    },
  };
}
