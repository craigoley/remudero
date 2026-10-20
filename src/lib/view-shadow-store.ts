/** Small transactional counter updates; historical cursor keys are stored once, not copied per sample. */
import { statSync } from "node:fs";
import { openShadowCounterDb, type ReadModelDb } from "./read-model-db.js";

export type ShadowClassification = "legacy_horizon" | "timing" | "dedupe" | "real";

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
  /** Samples not compared because a side said it was not ready, and the latest one's reason. */
  skipped?: number;
  lastSkippedMs?: number;
  lastSkipReason?: string;
  /** What the next summary row reports: counts since `sinceMs`, the last one (or the first sample). */
  summary?: { sinceMs: number; samples: number; skipped: number; diffs: Record<ShadowClassification, number> };
}

export interface ShadowKeyChange { reset: boolean; add?: string }
export const shadowCounterPath = (legacyPath: string): string => `${legacyPath}.sqlite`;

/** Confirmed absence alone permits legacy migration; corrupt, unreadable and foreign stores throw. */
export function readShadowCounters(path: string, includeKeys: boolean): { states: Record<string, ViewShadowState>; keyCounts: Map<string, number> } | undefined {
  const target = shadowCounterPath(path);
  try { statSync(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const db = openShadowCounterDb(target, true);
  try {
    db.exec("BEGIN");
    if (db.meta("shadow_migrated") !== "1") throw new Error("shadow counter migration is not committed");
    const states = Object.fromEntries(db.prepare("SELECT view, state FROM shadow_counter").all()
      .map(row => [String(row.view), JSON.parse(String(row.state)) as ViewShadowState]));
    const keyCounts = new Map(db.prepare("SELECT view, count(*) AS n FROM shadow_key GROUP BY view").all().map(row => [String(row.view), Number(row.n)]));
    if (includeKeys) for (const [view, state] of Object.entries(states)) {
      if (state.streakKeys !== undefined) state.streakKeys = db.prepare("SELECT key FROM shadow_key WHERE view = ? ORDER BY ordinal").all(view).map(row => String(row.key));
    }
    return { states, keyCounts };
  } finally { db.close(); }
}

function writeCounter(db: ReadModelDb, view: string, state: ViewShadowState): void {
  // An empty marker preserves the difference between absent and measured keys; membership lives in SQL.
  const value = { ...state, ...(state.streakKeys === undefined ? {} : { streakKeys: [] }) };
  db.prepare("INSERT INTO shadow_counter(view,state) VALUES(?,?) ON CONFLICT(view) DO UPDATE SET state=excluded.state").run(view, JSON.stringify(value));
}

function addKey(db: ReadModelDb, view: string, key: string): void {
  db.prepare(`INSERT OR IGNORE INTO shadow_key(view,key,ordinal)
    SELECT ?, ?, COALESCE(MAX(ordinal), -1) + 1 FROM shadow_key WHERE view = ?`).run(view, key, view);
}

/** Caller holds the home projector's write fence before this opens or changes any persistent file. */
export function saveShadowCounter(path: string, legacy: Record<string, ViewShadowState>, view: string, state: ViewShadowState, change?: ShadowKeyChange, connection?: ReadModelDb): void {
  const db = connection ?? openShadowCounterDb(shadowCounterPath(path));
  try {
    db.exec("BEGIN IMMEDIATE");
    if (db.meta("shadow_migrated") !== "1") {
      for (const [key, old] of Object.entries(legacy)) {
        writeCounter(db, key, old);
        for (const member of old.streakKeys ?? []) addKey(db, key, member);
      }
      db.prepare("INSERT INTO meta(k,v) VALUES('shadow_migrated','1')").run();
    }
    writeCounter(db, view, state);
    if (change === undefined || change.reset || state.streakKeys === undefined) {
      db.prepare("DELETE FROM shadow_key WHERE view = ?").run(view);
      for (const key of change === undefined ? state.streakKeys ?? [] : change.add === undefined ? [] : [change.add]) addKey(db, view, key);
    } else if (change.add !== undefined) addKey(db, view, change.add);
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction()) db.exec("ROLLBACK");
    throw error;
  } finally { if (connection === undefined) db.close(); }
}
