/** Small transactional counter updates; historical cursor keys are stored once, not copied per sample. */
import { statSync } from "node:fs";
import { systemClock } from "./clock.js";
import { openShadowCounterDb, type ReadModelDb } from "./read-model-db.js";

export type ShadowClassification = "legacy_horizon" | "timing" | "dedupe" | "real";

/** The completed producer owns routing bindings; counters use only their scoped logical identities. */
export interface ShadowPopulation {
  policy: string;
  generation: string;
  snapshotKey: string;
  scope: { instance: string; repository: string };
  pages: Array<{ key: string; logicalKey: string; incarnation: string; section: string; index: number }>;
}

export interface ShadowPopulationEvidence {
  generation: string;
  scope: ShadowPopulation["scope"];
  pages: Array<{ logicalKey: string; incarnation: string; samples: number; sinceMs: number | null; lastSampleMs: number | null }>;
}

export interface ViewShadowState {
  /** Qualified states coexist with the untouched, older per-view counters in the same native store. */
  view?: string;
  qualificationGeneration?: string;
  /** A mismatched producer blocks current qualification without erasing any measured streak. */
  qualificationRefusal?: string;
  requests: number;
  firstRequestMs: number | null;
  samples: number;
  diffs: Record<ShadowClassification, number>;
  /** Samples since the last `real` diff, and when that run began. */
  streakSamples: number;
  streakSinceMs: number | null;
  lastRealMs: number | null;
  /** The keys sampled since the streak began; absent in a state persisted before it was counted. */
  streakKeys?: string[];
  /** Current membership only. Retired population records remain in their own qualification namespace. */
  population?: ShadowPopulationEvidence;
  /** Samples not compared because a side said it was not ready, and the latest one's reason. */
  skipped?: number;
  lastSkippedMs?: number;
  lastSkipReason?: string;
  /** What the next summary row reports: counts since `sinceMs`, the last one (or the first sample). */
  summary?: { sinceMs: number; samples: number; skipped: number; diffs: Record<ShadowClassification, number> };
}

/** `atMs` is when the change was sampled. It stamps each key it touches and retires keys a day older (W1-T11330). */
export interface ShadowKeyChange { reset: boolean; add?: string; replace?: readonly string[]; atMs?: number }

/** A streak key unsampled for the cadence's own day owes no more samples and leaves the membership (W1-T11330). */
export const SHADOW_KEY_RETIRE_MS = 24 * 60 * 60_000;
/** The load reads per-view membership counts from this maintained table, never a GROUP BY over shadow_key. */
export const SHADOW_KEY_COUNT_SQL = "SELECT view, n FROM shadow_key_count";
const SHADOW_KEY_TIMES = "shadow_key_times";
export const shadowCounterPath = (legacyPath: string): string => `${legacyPath}.sqlite`;

/** Confirmed absence alone permits legacy migration; corrupt, unreadable and foreign stores throw. */
/** `loadedAtMs` stamps the keys of a store saved before W1-T11330, which carry no sample time: its upgrade uses the same time. */
export function readShadowCounters(path: string, includeKeys: boolean, activeQualifications?: Readonly<Record<string, string>>, loadedAtMs?: number): { states: Record<string, ViewShadowState>; keyCounts: Map<string, number>; keyTimes: Map<string, Map<string, number>> } | undefined {
  const target = shadowCounterPath(path);
  try { statSync(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const db = openShadowCounterDb(target, true);
  try {
    db.exec("BEGIN");
    if (db.meta("shadow_migrated") !== "1") throw new Error("shadow counter migration is not committed");
    const states = Object.fromEntries(db.prepare("SELECT view, state FROM shadow_counter").all()
      .map(row => [String(row.view), JSON.parse(String(row.state)) as ViewShadowState]));
    const active = activeQualifications === undefined ? undefined : Object.entries(states).filter(([key, state]) => {
      const generation = activeQualifications[state.view ?? key];
      return generation === undefined || state.qualificationGeneration === generation;
    }).map(([key]) => key);
    // A store not yet saved since W1-T11330 has no count table: it counts once the old way until its first save.
    const timed = db.meta(SHADOW_KEY_TIMES) === "1";
    const counted = timed ? new Map(db.prepare(SHADOW_KEY_COUNT_SQL).all().map(row => [String(row.view), Number(row.n)])) : undefined;
    const keyCounts = counted !== undefined
      ? (active === undefined ? counted : new Map(active.map(view => [view, counted.get(view) ?? 0])))
      : active === undefined
        ? new Map(db.prepare("SELECT view, count(*) AS n FROM shadow_key GROUP BY view").all().map(row => [String(row.view), Number(row.n)]))
        : new Map(active.map(view => [view, Number(db.prepare("SELECT count(*) AS n FROM shadow_key WHERE view = ?").get(view)?.n ?? 0)]));
    const keyTimes = new Map<string, Map<string, number>>();
    if (includeKeys) for (const [view, state] of Object.entries(states)) {
      const current = activeQualifications?.[state.view ?? view];
      // Archived membership stays in SQL. A current qualified comparator never needs to hydrate it.
      if (current !== undefined && state.qualificationGeneration !== current) continue;
      if (state.streakKeys === undefined) continue;
      const rows = db.prepare(`SELECT key${timed ? ", last_ms" : ""} FROM shadow_key WHERE view = ? ORDER BY ordinal`).all(view);
      state.streakKeys = rows.map(row => String(row.key));
      if (timed) keyTimes.set(view, new Map(rows.map(row => [String(row.key), Number(row.last_ms)] as const).sort((a, b) => a[1] - b[1])));
      else if (loadedAtMs !== undefined) keyTimes.set(view, new Map(rows.map(row => [String(row.key), loadedAtMs] as const)));
    }
    return { states, keyCounts, keyTimes };
  } finally { db.close(); }
}

function writeCounter(db: ReadModelDb, view: string, state: ViewShadowState): void {
  // An empty marker preserves the difference between absent and measured keys; membership lives in SQL.
  const value = { ...state, ...(state.streakKeys === undefined ? {} : { streakKeys: [] }) };
  db.prepare("INSERT INTO shadow_counter(view,state) VALUES(?,?) ON CONFLICT(view) DO UPDATE SET state=excluded.state").run(view, JSON.stringify(value));
}

/** Stamps `key` as sampled at `atMs`; a key new to the view also raises its maintained count. Returns the keys added. */
function addKey(db: ReadModelDb, view: string, key: string, atMs: number): number {
  const added = db.prepare(`INSERT OR IGNORE INTO shadow_key(view,key,ordinal,last_ms)
    SELECT ?, ?, COALESCE(MAX(ordinal), -1) + 1, ? FROM shadow_key WHERE view = ?`).run(view, key, atMs, view).changes;
  if (added > 0) countKeys(db, view, added);
  else db.prepare("UPDATE shadow_key SET last_ms = ? WHERE view = ? AND key = ? AND last_ms < ?").run(atMs, view, key, atMs);
  return added;
}

function countKeys(db: ReadModelDb, view: string, delta: number): void {
  db.prepare("INSERT INTO shadow_key_count(view,n) VALUES(?,?) ON CONFLICT(view) DO UPDATE SET n = n + excluded.n").run(view, delta);
}

function clearKeys(db: ReadModelDb, view: string): void {
  db.prepare("DELETE FROM shadow_key WHERE view = ?").run(view);
  db.prepare("DELETE FROM shadow_key_count WHERE view = ?").run(view);
}

/**
 * W1-T11330: the one-time upgrade of a store whose keys carry no sample time. Existing keys are stamped with the time
 * the store was loaded (the design's load time), so none retires before a day after the load, and a save more than a
 * day later prunes them. The per-view counts are taken once here.
 */
function migrateKeyTimes(db: ReadModelDb, atMs: number): void {
  if (db.meta(SHADOW_KEY_TIMES) === "1") return;
  const columns = db.prepare("PRAGMA table_info(shadow_key)").all().map(row => String(row.name));
  if (!columns.includes("last_ms")) db.exec(`ALTER TABLE shadow_key ADD COLUMN last_ms INTEGER NOT NULL DEFAULT ${Math.trunc(atMs)}`);
  db.exec(`CREATE INDEX IF NOT EXISTS shadow_key_sampled ON shadow_key(view, last_ms);
    CREATE TABLE IF NOT EXISTS shadow_key_count(view TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID;
    DELETE FROM shadow_key_count;
    INSERT INTO shadow_key_count(view,n) SELECT view, count(*) FROM shadow_key GROUP BY view;`);
  db.prepare(`INSERT INTO meta(k,v) VALUES('${SHADOW_KEY_TIMES}','1')`).run();
}

/**
 * Retires keys of `view` unsampled for {@link SHADOW_KEY_RETIRE_MS}, in batches derived from the view's own data.
 * Every live key was stamped by a save within the last day, so `live` is a floor on the saves the next day brings, and
 * `expired / live` is the backlog's share of them: the backlog drains within about a day of the view's own traffic,
 * however sparse. A batch also always exceeds this save's own `inserted` keys, so the backlog strictly shrinks on every
 * save until the stored set is the keys sampled in the last day. The batch is never larger than max(live, expired/live).
 */
export function shadowKeyRetireBatch(live: number, expired: number, inserted: number): number {
  return Math.max(live, inserted + 1, Math.ceil(expired / Math.max(1, live)));
}

function retireKeys(db: ReadModelDb, view: string, atMs: number, inserted: number): void {
  const cutoff = atMs - SHADOW_KEY_RETIRE_MS;
  const expired = Number(db.prepare("SELECT count(*) AS n FROM shadow_key WHERE view = ? AND last_ms <= ?").get(view, cutoff)?.n ?? 0);
  if (expired === 0) return;
  const live = Number(db.prepare("SELECT count(*) AS n FROM shadow_key WHERE view = ? AND last_ms > ?").get(view, cutoff)?.n ?? 0);
  const retired = db.prepare(`DELETE FROM shadow_key WHERE view = ? AND key IN
    (SELECT key FROM shadow_key WHERE view = ? AND last_ms <= ? ORDER BY last_ms LIMIT ?)`).run(view, view, cutoff, shadowKeyRetireBatch(live, expired, inserted)).changes;
  if (retired > 0) countKeys(db, view, -retired);
}

/**
 * Caller holds the home projector's write fence before this opens or changes any persistent file. `keysLoadedAtMs`
 * is when the caller loaded the store: keys an older build left without a sample time are stamped with it (W1-T11330).
 */
export function saveShadowCounter(path: string, legacy: Record<string, ViewShadowState>, view: string, state: ViewShadowState, change?: ShadowKeyChange, connection?: ReadModelDb, keysLoadedAtMs?: number): void {
  const db = connection ?? openShadowCounterDb(shadowCounterPath(path));
  try {
    db.exec("BEGIN IMMEDIATE");
    const atMs = change?.atMs ?? systemClock.now();
    const loadedAtMs = keysLoadedAtMs ?? atMs;
    migrateKeyTimes(db, loadedAtMs);
    if (db.meta("shadow_migrated") !== "1") {
      for (const [key, old] of Object.entries(legacy)) {
        writeCounter(db, key, old);
        for (const member of old.streakKeys ?? []) addKey(db, key, member, loadedAtMs);
      }
      db.prepare("INSERT INTO meta(k,v) VALUES('shadow_migrated','1')").run();
    }
    writeCounter(db, view, state);
    let inserted = 0;
    if (change === undefined || change.reset || change.replace !== undefined || state.streakKeys === undefined) {
      clearKeys(db, view);
      for (const key of change?.replace ?? (change === undefined ? state.streakKeys ?? [] : change.add === undefined ? [] : [change.add])) inserted += addKey(db, view, key, atMs);
    } else if (change.add !== undefined) inserted += addKey(db, view, change.add, atMs);
    if (change?.atMs !== undefined) retireKeys(db, view, change.atMs, inserted);
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction()) db.exec("ROLLBACK");
    throw error;
  } finally { if (connection === undefined) db.close(); }
}
