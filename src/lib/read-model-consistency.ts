/**
 * The read model's consistency oracle (Phase 1 design §4; P1-05). The ledger stays authoritative:
 * this recomputes a CLOSED window from the ledger union and compares it with what the projector
 * holds, row for row, then answers drift with a tiered, self-healing response.
 *
 * - Positive control: the union read must have opened every rotation form the directory holds for
 *   the window, and the window must hold at least one ledger row. A blind read throws; it never
 *   reports agreement.
 * - Drift the projector owns (a missing identity, a missing or corrupted fact) is rechecked, then
 *   healed by rebuilding the window's rows from the ledger, then escalated if it survives the
 *   rebuild or recurs after an earlier one.
 * - A row the projector holds but the ledger lost is never "fixed": it is the first evidence of a
 *   real ledger loss (the rotation rename sliver, or a power loss), so it escalates (risk 4).
 */
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { tryEscalate, type EscalateDeps, type Escalation } from "./escalate.js";
import { appendLedger } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { isFactStep, ledgerLineIdentity } from "./ledger-projector.js";
import { ledgerRotationEntries, readLedgerUnionRawLinesSync, realLedgerFs, rotationStampIso, type LedgerGrepFsDeps } from "./ledger-union.js";
import { withWriteTransaction, type ReadModelDb, type ReadModelLease } from "./read-model-db.js";

export const READ_MODEL_CONSISTENCY_STEP = "read_model.consistency";
export const READ_MODEL_SELF_HEALED_STEP = "read_model.self_healed";
/** The window closes this long before now, so only the documented late rows can still move it. */
export const ORACLE_CLOSED_LAG_MS = 10 * 60_000;
export const ORACLE_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** A drift that comes back within this long after a self-heal is a projection bug, not a blip. */
export const ORACLE_RECURRENCE_MS = 24 * 60 * 60_000;
const SAMPLE_LIMIT = 5;

const CONSISTENCY_DDL = `CREATE TABLE IF NOT EXISTS consistency_run(id INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL,
  t0 INTEGER NOT NULL, t1 INTEGER NOT NULL, outcome TEXT NOT NULL, ledger_rows INTEGER NOT NULL, missing INTEGER NOT NULL,
  ledger_lost INTEGER NOT NULL, fact_missing INTEGER NOT NULL, fact_corrupt INTEGER NOT NULL, healed INTEGER NOT NULL, lost_fp TEXT)`;

export class ReadModelConsistencyError extends RmdError {
  constructor(message: string, details: Record<string, unknown>) {
    super("read-model", GENERIC_EXIT_CODE, `read model oracle_blind: ${message}`, { reason: "oracle_blind", ...details });
  }
}

export type LedgerForm = "gzip" | "plain" | "live";

export interface OracleFormRead {
  form: LedgerForm;
  /** Files of this form the oracle's own listing says could hold rows in the window. */
  expected: number;
  read: number;
  lines: number;
}

export interface OracleWindow {
  t0: number;
  t1: number;
}

interface IdentityKey {
  tsMs: number;
  h: bigint;
}

export interface WindowComparison {
  window: OracleWindow;
  forms: OracleFormRead[];
  ledgerRows: number;
  storeRows: number;
  expectedFacts: number;
  /** In the ledger, absent from the projection. */
  missing: string[];
  /** Held by the projection, absent from every rotation form of the ledger (risk 4). */
  ledgerLost: string[];
  factMissing: string[];
  /** `fact.seq` of rows whose body or derived columns no ledger row explains. */
  factCorrupt: number[];
  lines: Map<string, string>;
  ids: Map<string, IdentityKey>;
}

function isoAt(ms: number): string {
  return fixedClock(ms).iso();
}

function keyOf(id: IdentityKey): string {
  return `${id.tsMs}:${id.h}`;
}

function newlines(buf: Buffer): number {
  let n = 0;
  for (let at = buf.indexOf(0x0a); at >= 0; at = buf.indexOf(0x0a, at + 1)) n++;
  return n;
}

function formOf(path: string): LedgerForm {
  if (basename(path) === LEDGER_FILENAME) return "live";
  return path.endsWith(".gz") ? "gzip" : "plain";
}

/** The fact columns the projector derives from one line, or undefined when it keeps no fact. */
export function factColumns(line: string, factStep: (step: string) => boolean): { step: string; task: string | null; run: string | null } | undefined {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    // deliberate: an unparseable line is never a fact, exactly as the projector counts it torn.
    return undefined;
  }
  const r = row as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || typeof r.step !== "string" || !factStep(r.step)) return undefined;
  const task = typeof r.task_id === "string" ? r.task_id : typeof r.task === "string" ? r.task : null;
  return { step: r.step, task, run: typeof r.run_id === "string" ? r.run_id : null };
}

/**
 * Reads the window from the ledger union and compares it with the store. Throws
 * {@link ReadModelConsistencyError} when the positive control fails: a form the directory holds
 * went unread, or the window read zero ledger rows.
 */
export function compareWindow(
  db: ReadModelDb,
  ledgerDir: string,
  window: OracleWindow,
  opts: { factStep?: (step: string) => boolean; fs?: LedgerGrepFsDeps } = {},
): WindowComparison {
  const factStep = opts.factStep ?? isFactStep;
  const base = opts.fs ?? realLedgerFs;
  // The control's own listing, independent of the reader's seam: what SHOULD be read.
  const listing = readdirSync(ledgerDir);
  const expected = ledgerRotationEntries(listing, ledgerDir)
    .filter((entry) => {
      const stamp = rotationStampIso(basename(entry.path));
      return stamp === undefined || Date.parse(stamp) >= window.t0;
    })
    .map((entry) => entry.path);
  if (listing.includes(LEDGER_FILENAME)) expected.push(join(ledgerDir, LEDGER_FILENAME));
  const read = new Set<string>();
  const lineCount: Record<LedgerForm, number> = { gzip: 0, plain: 0, live: 0 };
  const probe: LedgerGrepFsDeps = {
    readdirSync: base.readdirSync,
    existsSync: base.existsSync,
    readFileSync: (path) => {
      const buf = base.readFileSync(path);
      read.add(path);
      if (formOf(path) !== "gzip") lineCount[formOf(path)] += newlines(buf);
      return buf;
    },
    gunzipSync: (buf) => {
      const out = base.gunzipSync(buf);
      lineCount.gzip += newlines(out);
      return out;
    },
  };
  const union = readLedgerUnionRawLinesSync(ledgerDir, { since: isoAt(window.t0) }, probe);
  const forms = (["gzip", "plain", "live"] as const).map((form): OracleFormRead => ({
    form,
    expected: expected.filter((p) => formOf(p) === form).length,
    read: [...read].filter((p) => formOf(p) === form).length,
    lines: lineCount[form],
  }));
  // A file that vanished since the listing (compaction moved it aside) was not skipped by the reader.
  const unread = expected.filter((p) => !read.has(p) && base.existsSync(p)).concat(union.unread);
  if (unread.length > 0) {
    const blind = [...new Set(unread.map(formOf))];
    throw new ReadModelConsistencyError(`the union read left the ${blind.join(" and ")} form unread: ${unread.slice(0, SAMPLE_LIMIT).map((p) => basename(p)).join(", ")}`, { forms, unread });
  }
  const lines = new Map<string, string>();
  const ids = new Map<string, IdentityKey>();
  for (const line of union.rawLines) {
    const id = ledgerLineIdentity(line);
    if (id.tsMs < window.t0 || id.tsMs > window.t1) continue;
    const key = keyOf(id);
    lines.set(key, line);
    ids.set(key, { tsMs: id.tsMs, h: id.h });
  }
  if (lines.size === 0) {
    throw new ReadModelConsistencyError(`the window ${isoAt(window.t0)}..${isoAt(window.t1)} read zero ledger rows`, { forms });
  }
  const stored = new Set<string>();
  for (const row of db.prepare("SELECT ts_ms, h FROM seen WHERE ts_ms BETWEEN ? AND ?", { bigInts: true }).iterate(window.t0, window.t1)) {
    stored.add(keyOf({ tsMs: Number(row.ts_ms), h: row.h as bigint }));
  }
  const quarantined = new Set<string>();
  for (const row of db.prepare("SELECT ts_ms, h FROM quarantine WHERE ts_ms BETWEEN ? AND ?", { bigInts: true }).iterate(window.t0, window.t1)) {
    quarantined.add(keyOf({ tsMs: Number(row.ts_ms), h: row.h as bigint }));
  }
  const missing = [...lines.keys()].filter((key) => !stored.has(key));
  const ledgerLost = [...stored].filter((key) => !lines.has(key));
  const lost = new Set(ledgerLost);
  const wantFacts = new Map<string, string>();
  for (const [key, line] of lines) {
    if (!quarantined.has(key) && factColumns(line, factStep)) wantFacts.set(key, line);
  }
  const matched = new Set<string>();
  const factCorrupt: number[] = [];
  const facts = db.prepare("SELECT seq, ts, step, task_id, run_id, body FROM fact WHERE ts_ms BETWEEN ? AND ?").iterate(window.t0, window.t1);
  for (const row of facts) {
    const body = String(row.body);
    const id = ledgerLineIdentity(body);
    const key = keyOf(id);
    const cols = factColumns(body, factStep);
    const exact = wantFacts.get(key) === body && !matched.has(key) && cols !== undefined && row.ts === id.ts
      && row.step === cols.step && row.task_id === cols.task && row.run_id === cols.run;
    if (exact) matched.add(key);
    else if (!lost.has(key)) factCorrupt.push(Number(row.seq));
  }
  const factMissing = [...wantFacts.keys()].filter((key) => !matched.has(key));
  return { window, forms, ledgerRows: lines.size, storeRows: stored.size, expectedFacts: wantFacts.size, missing, ledgerLost, factMissing, factCorrupt, lines, ids };
}

function projectionDrift(c: WindowComparison): number {
  return c.missing.length + c.factMissing.length + c.factCorrupt.length;
}

/** Rebuilds the window's projector rows from the ledger: inserts what is missing, deletes what no
 *  ledger row explains. Rows the ledger lost are left in place as evidence. */
function healWindow(db: ReadModelDb, lease: ReadModelLease, c: WindowComparison, factStep: (step: string) => boolean): number {
  return withWriteTransaction(db, lease, () => {
    const drop = db.prepare("DELETE FROM fact WHERE seq = ?");
    const seen = db.prepare("INSERT OR IGNORE INTO seen(ts_ms, h) VALUES(?, ?)");
    const fact = db.prepare("INSERT INTO fact(ts, ts_ms, step, task_id, run_id, body) VALUES(?, ?, ?, ?, ?, ?)");
    let changed = 0;
    for (const seq of c.factCorrupt) changed += drop.run(seq).changes;
    for (const key of c.missing) {
      const id = c.ids.get(key)!;
      changed += seen.run(id.tsMs, id.h).changes;
    }
    for (const key of c.factMissing) {
      const line = c.lines.get(key)!;
      const cols = factColumns(line, factStep)!;
      fact.run(ledgerLineIdentity(line).ts, c.ids.get(key)!.tsMs, cols.step, cols.task, cols.run, line);
      changed++;
    }
    db.prepare("UPDATE meta SET v = CAST(v AS INTEGER) + 1 WHERE k = 'generation'").run();
    return changed;
  });
}

export type ConsistencyOutcome = "agree" | "transient" | "healed" | "drift" | "escalated" | "ledger_lost_known";

export interface ConsistencyRun {
  instance: string;
  outcome: ConsistencyOutcome;
  window: OracleWindow;
  forms: OracleFormRead[];
  ledgerRows: number;
  /** The comparison the outcome rests on: after the recheck, before any heal. */
  mismatches: { missing: number; ledgerLost: number; factMissing: number; factCorrupt: number };
  healedRows: number;
  escalationReasons: string[];
  /** The issue URL, null when escalation failed or no escalation path was supplied. */
  issueUrl: string | null;
  sample: string[];
  elapsedMs: number;
}

export interface ConsistencyCheckOptions {
  db: ReadModelDb;
  ledgerDir: string;
  instance: string;
  /** Where the metric rows go: core's ledger (serve never writes into another daemon's state tree). */
  metricLedgerPath: string;
  /** Only a lease holder heals and keeps the recurrence history; without one the check reports. */
  lease?: ReadModelLease;
  escalation?: EscalateDeps;
  clock?: Clock;
  windowMs?: number;
  factStep?: (step: string) => boolean;
  fs?: LedgerGrepFsDeps;
}

function lostFingerprint(keys: string[]): string {
  return createHash("sha1").update([...keys].sort().join("\n")).digest("hex").slice(0, 16);
}

function history(db: ReadModelDb): Array<{ atMs: number; outcome: string; healed: number; lostFp: string | null }> {
  const exists = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'consistency_run'").get();
  if (!exists) return [];
  return db.prepare("SELECT at_ms, outcome, healed, lost_fp FROM consistency_run ORDER BY id").all()
    .map((row) => ({ atMs: Number(row.at_ms), outcome: String(row.outcome), healed: Number(row.healed), lostFp: row.lost_fp === null ? null : String(row.lost_fp) }));
}

/** The schedule hook's two tiers: hourly after an agreement, sooner while the last run found anything. */
export const ORACLE_AGREE_INTERVAL_MS = 60 * 60_000;
export const ORACLE_DRIFT_INTERVAL_MS = 10 * 60_000;

/**
 * WHERE THE ORACLE RUNS. Serve's read-model worker asks this after each tick, per instance, and
 * runs {@link runConsistencyCheck} with its lease and the DEFAULT window when it answers true. On a
 * copy of the host's core ledger a 7-day window (~670k rows) held that worker tick 5-9 s on a Mac
 * and added ~660 MB RSS; a 1-day window took 0.5-1 s. It never touches serve's main thread. The
 * full corpus (10.1 s, 730 MB RSS on the same copy) runs only by hand, as the check inside
 * `rmd read-model rebuild --window-days <n>`. Due when no run is recorded, an hour after an
 * agreement, and ten minutes after any other outcome, so a drift is rechecked sooner.
 */
export function consistencyCheckDue(db: ReadModelDb, now: number): boolean {
  const last = history(db).at(-1);
  if (!last) return true;
  return now - last.atMs >= (last.outcome === "agree" ? ORACLE_AGREE_INTERVAL_MS : ORACLE_DRIFT_INTERVAL_MS);
}

function escalationFor(run: ConsistencyRun, detail: string[]): Escalation {
  return {
    class: "MANUAL",
    taskId: metricBase(run.instance).task_id,
    summary: `read model ${run.instance} disagrees with its ledger`,
    detail: [`${run.escalationReasons.join("; ")}.`, ...detail].join("\n\n"),
    options: [
      { label: "investigate the ledger", detail: "A row the read model holds is absent from every rotation form: find the loss (the rotation rename sliver, a power loss) before any rebuild erases the evidence.", kind: { type: "operator-only" } },
      { label: "rebuild the read model", detail: "Run `rmd read-model rebuild` to rebuild the store from the ledger; the views keep serving the old file until the new one passes its own check.", kind: { type: "operator-only" } },
    ],
    recommendation: run.mismatches.ledgerLost > 0 ? "investigate the ledger" : "rebuild the read model",
    consequence: "The views keep serving the drifting projection, and the read-model source stays marked stale until this is resolved.",
  };
}

/**
 * One oracle run. Tiers, by recurrence: a clean window agrees; a mismatch is rechecked (a late row
 * or the rename sliver); drift that persists is healed by rebuilding the window (lease holders
 * only); drift that survives the heal, or recurs within {@link ORACLE_RECURRENCE_MS} of an earlier
 * heal, escalates. A row the ledger lost escalates once per distinct set, and is never healed.
 */
export function runConsistencyCheck(opts: ConsistencyCheckOptions): ConsistencyRun {
  try {
    return runOnce(opts);
  } catch (error) {
    // A blind oracle still leaves its metric row, then fails loudly: it never reports agreement.
    if (error instanceof ReadModelConsistencyError) {
      appendLedger(opts.metricLedgerPath, { ...metricBase(opts.instance), step: READ_MODEL_CONSISTENCY_STEP, check: "ingestion", outcome: "blind", reason: error.message });
    }
    throw error;
  }
}

function metricBase(instance: string): { run_id: string; task_id: string; instance: string } {
  return { run_id: `read-model-${instance}`, task_id: `READ-MODEL-${instance.toUpperCase()}`, instance };
}

function runOnce(opts: ConsistencyCheckOptions): ConsistencyRun {
  const clock = opts.clock ?? systemClock;
  const factStep = opts.factStep ?? isFactStep;
  const started = clock.now();
  const t1 = started - ORACLE_CLOSED_LAG_MS;
  const window = { t0: t1 - (opts.windowMs ?? ORACLE_DEFAULT_WINDOW_MS), t1 };
  const compare = (): WindowComparison => compareWindow(opts.db, opts.ledgerDir, window, { factStep, ...(opts.fs ? { fs: opts.fs } : {}) });
  let c = compare();
  let outcome: ConsistencyOutcome = "agree";
  let healedRows = 0;
  const reasons: string[] = [];
  const clean = (x: WindowComparison): boolean => projectionDrift(x) === 0 && x.ledgerLost.length === 0;
  if (!clean(c)) {
    c = compare();
    outcome = clean(c) ? "transient" : "drift";
  }
  const past = history(opts.db);
  const lostFp = c.ledgerLost.length > 0 ? lostFingerprint(c.ledgerLost) : null;
  if (outcome === "drift" && lostFp !== null) {
    if (past.some((row) => row.lostFp === lostFp)) outcome = "ledger_lost_known";
    else reasons.push(`${c.ledgerLost.length} row(s) the projector holds are absent from every ledger rotation form`);
  }
  if (outcome !== "transient" && projectionDrift(c) > 0 && opts.lease) {
    healedRows = healWindow(opts.db, opts.lease, c, factStep);
    outcome = "healed";
    const after = compare();
    if (projectionDrift(after) > 0) reasons.push(`${projectionDrift(after)} projection mismatch(es) survived a rebuild of the window`);
    else if (past.some((row) => row.healed > 0 && row.atMs >= started - ORACLE_RECURRENCE_MS)) reasons.push("the projection drifted again within 24 h of an earlier self-heal");
  }
  if (reasons.length > 0) outcome = "escalated";
  const sample = [...c.missing, ...c.ledgerLost, ...c.factMissing].slice(0, SAMPLE_LIMIT).map((key) => c.lines.get(key) ?? `seen ${key}`)
    .concat(c.factCorrupt.slice(0, SAMPLE_LIMIT).map((seq) => `fact seq ${seq}`));
  const run: ConsistencyRun = {
    instance: opts.instance, outcome, window, forms: c.forms, ledgerRows: c.ledgerRows,
    mismatches: { missing: c.missing.length, ledgerLost: c.ledgerLost.length, factMissing: c.factMissing.length, factCorrupt: c.factCorrupt.length },
    healedRows, escalationReasons: reasons, issueUrl: null, sample, elapsedMs: 0,
  };
  if (reasons.length > 0 && opts.escalation) run.issueUrl = tryEscalate(escalationFor(run, sample.map((s) => `\`${s.slice(0, 300)}\``)), opts.escalation);
  if (opts.lease) {
    // A lost set is remembered only once an issue names it, so a failed escalation is retried next run.
    const escalatedFp = outcome === "ledger_lost_known" || run.issueUrl !== null ? lostFp : null;
    withWriteTransaction(opts.db, opts.lease, () => {
      opts.db.exec(CONSISTENCY_DDL);
      opts.db.prepare(`INSERT INTO consistency_run(at_ms, t0, t1, outcome, ledger_rows, missing, ledger_lost, fact_missing, fact_corrupt, healed, lost_fp)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(started, window.t0, window.t1, outcome, c.ledgerRows, c.missing.length,
        c.ledgerLost.length, c.factMissing.length, c.factCorrupt.length, healedRows, escalatedFp);
    });
  }
  run.elapsedMs = clock.now() - started;
  const metric = metricBase(opts.instance);
  appendLedger(opts.metricLedgerPath, {
    ...metric, step: READ_MODEL_CONSISTENCY_STEP, check: "ingestion", outcome, window: [isoAt(window.t0), isoAt(window.t1)],
    compared: c.ledgerRows, mismatches: run.mismatches, forms: c.forms, elapsed_ms: run.elapsedMs, sample: sample.map((s) => s.slice(0, 200)),
    ...(run.issueUrl ? { issue_url: run.issueUrl } : {}),
  });
  if (healedRows > 0) appendLedger(opts.metricLedgerPath, { ...metric, step: READ_MODEL_SELF_HEALED_STEP, window: [window.t0, window.t1], healed_rows: healedRows });
  return run;
}
