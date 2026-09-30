/**
 * `rmd read-model rebuild|status|switch` (Phase 1 design §1.5, §5; P1-04).
 *
 * - rebuild: projects the whole ledger into a side file, runs the consistency oracle against that
 *   file, and swaps it in only when the oracle agrees. The swap takes the live file's writer lease
 *   first, so a running worker's next write is fenced off (`lease_lost`) instead of landing in a
 *   file that is about to be replaced.
 * - status: per-instance checkpoint lag, row counts, quarantine count, DB size and lease holder.
 * - switch: writes `read-model/switches.json` atomically and appends a `read_model.switch` row.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { flagValue, unknownArgError } from "./cli-args.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { loadConfig } from "./config.js";
import { appendLedger } from "./ledger.js";
import { LEDGER_FILENAME, ledgerPathFor } from "./ledger-path.js";
import { LEDGER_PROJECTOR_SCHEMA_VERSION, createLedgerProjector, openProjectorReadModel } from "./ledger-projector.js";
import { ORACLE_DEFAULT_WINDOW_MS, ReadModelConsistencyError, runConsistencyCheck } from "./read-model-consistency.js";
import { PROJECTOR_LEASE_NAME, READ_MODEL_DIRNAME, READ_MODEL_LEASE_TTL_MS, acquireLease, openReadModel, readModelPath, releaseLease, type ReadModelDb } from "./read-model-db.js";
import { writeAtomic } from "./fs-race-safe.js";

export const READ_MODEL_SWITCHES_FILENAME = "switches.json";
export const READ_MODEL_SWITCH_STEP = "read_model.switch";
export const READ_MODEL_REBUILT_STEP = "read_model.rebuilt";
const VIEW_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const DB_FILE = /^(.+)\.v(\d+)\.sqlite$/;

export type ProjectorSwitch = "on" | "off";
export type ViewSwitch = "serve" | "shadow" | "off";

/** The kill-switch file serve re-reads on mtime change (design §5). */
export interface ReadModelSwitches {
  projector: ProjectorSwitch;
  views: Record<string, ViewSwitch>;
}

export interface ReadModelCliOptions {
  /** Core's state dir: it holds the read model for every instance, and core's ledger. */
  stateDir?: string;
  clock?: Clock;
  out?: (line: string) => void;
  error?: (line: string) => void;
}

export function readModelSwitchesPath(stateDir: string): string {
  return join(stateDir, READ_MODEL_DIRNAME, READ_MODEL_SWITCHES_FILENAME);
}

/** The switches in force: an absent file means everything on, as shipped. A malformed one throws. */
export function readReadModelSwitches(stateDir: string): ReadModelSwitches {
  const path = readModelSwitchesPath(stateDir);
  if (!existsSync(path)) return { projector: "on", views: {} };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ReadModelSwitches>;
  return { projector: raw.projector === "off" ? "off" : "on", views: { ...(raw.views ?? {}) } };
}

const USAGE = "usage: rmd read-model rebuild [--instance <id>] [--ledger-dir <dir>] [--window-days <n>] | status [--json] | switch <projector|<view>> <mode>";

export function readModelCommand(rest: string[], opts: ReadModelCliOptions = {}): number {
  const out = opts.out ?? console.log;
  const error = opts.error ?? console.error;
  const [verb, ...args] = rest;
  const valueFlags = verb === "rebuild" ? ["--instance", "--ledger-dir", "--window-days"] : [];
  const boolFlags = verb === "status" ? ["--json"] : [];
  const positional = verb === "switch" ? 2 : 0;
  const badArg = verb === "rebuild" || verb === "status" || verb === "switch"
    ? unknownArgError(`read-model ${verb}`, args.slice(positional), valueFlags, boolFlags)
    : `rmd read-model: unknown subcommand ${JSON.stringify(verb ?? "")}`;
  if (badArg) {
    error(badArg);
    error(USAGE);
    return 2;
  }
  const stateDir = opts.stateDir ?? dirname(ledgerPathFor(loadConfig()));
  const clock = opts.clock ?? systemClock;
  if (verb === "switch") return switchCommand(stateDir, args, out, error);
  if (verb === "status") return statusCommand(stateDir, clock, args.includes("--json"), out);
  return rebuildCommand(stateDir, clock, args, out, error);
}

function switchCommand(stateDir: string, args: string[], out: (l: string) => void, error: (l: string) => void): number {
  const [target = "", mode = ""] = args;
  const projector = target === "projector" && (mode === "on" || mode === "off");
  const view = target !== "projector" && VIEW_NAME.test(target) && (mode === "serve" || mode === "shadow" || mode === "off");
  if (!projector && !view) {
    error(`rmd read-model switch: ${JSON.stringify(target)} ${JSON.stringify(mode)} is not a switch; projector takes on|off, a view takes serve|shadow|off`);
    return 2;
  }
  let switches: ReadModelSwitches;
  try {
    switches = readReadModelSwitches(stateDir);
  } catch (err) {
    error(`rmd read-model switch: ${readModelSwitchesPath(stateDir)} is unreadable (${(err as Error).message}); fix or delete it first`);
    return 1;
  }
  const previous = projector ? switches.projector : switches.views[target] ?? "serve";
  if (projector) switches.projector = mode as ProjectorSwitch;
  else switches.views[target] = mode as ViewSwitch;
  writeAtomic(readModelSwitchesPath(stateDir), `${JSON.stringify(switches, null, 2)}\n`);
  appendLedger(join(stateDir, LEDGER_FILENAME), { run_id: "read-model-cli", task_id: "READ-MODEL", step: READ_MODEL_SWITCH_STEP, target, mode, previous });
  out(`read-model switch ${target}: ${previous} -> ${mode}`);
  return 0;
}

export interface InstanceStatus {
  instance: string;
  schemaVersion: number;
  /** False for a file built under another schema version: it is never read, only reported. */
  current: boolean;
  dbBytes: number;
  rows?: { seen: number; fact: number; quarantine: number };
  generation?: number;
  newestAppliedTs?: string;
  lagMs?: number;
  liveBytesBehind?: number;
  lease?: { holder: string; pid: number; host: string; expiresMs: number; live: boolean };
  lastCheck?: { atMs: number; outcome: string };
}

function fileBytes(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function instanceStatus(stateDir: string, instance: string, version: number, now: number): InstanceStatus {
  const path = readModelPath(stateDir, instance, version);
  const status: InstanceStatus = { instance, schemaVersion: version, current: version === LEDGER_PROJECTOR_SCHEMA_VERSION, dbBytes: fileBytes(path) + fileBytes(`${path}-wal`) };
  if (!status.current) return status;
  const db = openReadModel({ stateDir, instance, schemaVersion: version, readOnly: true });
  try {
    const n = (table: string): number => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
    status.rows = { seen: n("seen"), fact: n("fact"), quarantine: n("quarantine") };
    status.generation = Number(db.meta("generation"));
    const newest = db.prepare("SELECT max(ts_ms) AS m FROM seen WHERE ts_ms <= ?").get(now)?.m;
    if (typeof newest === "number") {
      status.newestAppliedTs = fixedClock(newest).iso();
      status.lagMs = now - newest;
    }
    // Only core's own ledger is known here; another instance's lives in its daemon's state tree.
    const live = db.prepare("SELECT off FROM source_file WHERE name = ?").get(LEDGER_FILENAME);
    if (instance === "core" && live) status.liveBytesBehind = Math.max(0, fileBytes(join(stateDir, LEDGER_FILENAME)) - Number(live.off));
    const lease = db.prepare("SELECT holder, pid, host, expires_ms FROM lease WHERE name = ?").get(PROJECTOR_LEASE_NAME);
    if (lease) status.lease = { holder: String(lease.holder), pid: Number(lease.pid), host: String(lease.host), expiresMs: Number(lease.expires_ms), live: Number(lease.expires_ms) > now };
    const hasRuns = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'consistency_run'").get();
    const last = hasRuns ? db.prepare("SELECT at_ms, outcome FROM consistency_run ORDER BY id DESC LIMIT 1").get() : undefined;
    if (last) status.lastCheck = { atMs: Number(last.at_ms), outcome: String(last.outcome) };
  } finally {
    db.close();
  }
  return status;
}

export function readModelStatus(stateDir: string, clock: Clock = systemClock): InstanceStatus[] {
  const dir = join(stateDir, READ_MODEL_DIRNAME);
  const names = existsSync(dir) ? readdirSync(dir) : [];
  const now = clock.now();
  return names.flatMap((name) => {
    const m = DB_FILE.exec(name);
    return m ? [instanceStatus(stateDir, m[1]!, Number(m[2]), now)] : [];
  });
}

function statusCommand(stateDir: string, clock: Clock, json: boolean, out: (l: string) => void): number {
  const all = readModelStatus(stateDir, clock);
  if (json) {
    out(JSON.stringify({ stateDir, instances: all }, null, 2));
    return 0;
  }
  if (all.length === 0) out(`no read model under ${join(stateDir, READ_MODEL_DIRNAME)}`);
  for (const s of all) {
    if (!s.current) {
      out(`${s.instance} v${s.schemaVersion}: not the current schema (v${LEDGER_PROJECTOR_SCHEMA_VERSION}), ${s.dbBytes} bytes`);
      continue;
    }
    const lease = s.lease ? `${s.lease.holder} pid ${s.lease.pid} on ${s.lease.host}${s.lease.live ? "" : " (expired)"}` : "none";
    out(`${s.instance} v${s.schemaVersion}: seen ${s.rows?.seen} fact ${s.rows?.fact} quarantine ${s.rows?.quarantine}, ${s.dbBytes} bytes, generation ${s.generation}`);
    out(`  lag ${s.lagMs === undefined ? "n/a (empty)" : `${Math.round(s.lagMs / 1000)} s`} (newest ${s.newestAppliedTs ?? "none"})${s.liveBytesBehind === undefined ? "" : `, live file ${s.liveBytesBehind} bytes behind`}`);
    out(`  lease ${lease}; last check ${s.lastCheck ? `${s.lastCheck.outcome} at ${fixedClock(s.lastCheck.atMs).iso()}` : "never"}`);
  }
  return 0;
}

/**
 * Takes the live file's lease, from a running worker if need be. The fence makes that safe: the
 * old holder's next transaction finds another holder and rolls back with `lease_lost`.
 */
function takeLease(db: ReadModelDb, holder: string, clock: Clock): string | undefined {
  const got = acquireLease(db, { holder, clock });
  if (got.ok) return undefined;
  db.exec("BEGIN IMMEDIATE");
  db.prepare("UPDATE lease SET holder = ?, pid = ?, host = ?, acquired_ms = ?, expires_ms = ? WHERE name = ?")
    .run(holder, process.pid, hostname(), clock.now(), clock.now() + READ_MODEL_LEASE_TTL_MS, PROJECTOR_LEASE_NAME);
  db.exec("COMMIT");
  return got.heldBy;
}

/** Replaces the live file with the checked side file. Returns the lease holder it displaced. */
function swapIn(stateDir: string, instance: string, sidePath: string, holder: string, clock: Clock): string | undefined {
  const finalPath = readModelPath(stateDir, instance, LEDGER_PROJECTOR_SCHEMA_VERSION);
  let displaced: string | undefined;
  if (existsSync(finalPath)) {
    const live = openProjectorReadModel(stateDir, instance, clock);
    try {
      displaced = takeLease(live, holder, clock);
      // A TRUNCATE checkpoint leaves the WAL empty, so nothing of the old file can be replayed into the new one.
      const ckpt = live.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (Number(ckpt?.busy) !== 0) {
        live.prepare("DELETE FROM lease WHERE name = ? AND holder = ?").run(PROJECTOR_LEASE_NAME, holder);
        throw new Error(`the live file ${finalPath} could not be checkpointed (a reader holds it), so its lease was handed back`);
      }
    } finally {
      live.close();
    }
  }
  renameSync(sidePath, finalPath);
  return displaced;
}

function rebuildCommand(stateDir: string, clock: Clock, args: string[], out: (l: string) => void, error: (l: string) => void): number {
  const instance = flagValue(args, "--instance") ?? "core";
  const ledgerDir = flagValue(args, "--ledger-dir") ?? (instance === "core" ? stateDir : undefined);
  const days = Number(flagValue(args, "--window-days") ?? ORACLE_DEFAULT_WINDOW_MS / 86_400_000);
  if (!ledgerDir || !Number.isFinite(days) || days <= 0) {
    error("rmd read-model rebuild: a non-core instance needs --ledger-dir, and --window-days must be a positive number");
    return 2;
  }
  const started = clock.now();
  const sideRoot = join(stateDir, READ_MODEL_DIRNAME, `rebuild-${instance}-${started}`);
  mkdirSync(sideRoot, { recursive: true });
  const holder = `rebuild-${process.pid}-${started}`;
  try {
    const side = openProjectorReadModel(sideRoot, instance, clock);
    const sidePath = side.path;
    let run: ReturnType<typeof runConsistencyCheck>;
    let tick: ReturnType<ReturnType<typeof createLedgerProjector>["tick"]>;
    try {
      const got = acquireLease(side, { holder, clock });
      if (!got.ok) throw new Error(`the side file ${sidePath} is already leased by ${got.heldBy}`);
      tick = createLedgerProjector({ ledgerDir, db: side, lease: got.lease, clock }).tick();
      if (tick.unread.length > 0) throw new Error(`archives were unreadable: ${tick.unread.join("; ")}`);
      run = runConsistencyCheck({ db: side, ledgerDir, instance, metricLedgerPath: join(stateDir, LEDGER_FILENAME), clock, windowMs: days * 86_400_000 });
      releaseLease(side, got.lease);
      side.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      side.close();
    }
    if (run.outcome !== "agree") {
      error(`rmd read-model rebuild: the rebuilt ${instance} file failed its own consistency check (${run.outcome}: ${JSON.stringify(run.mismatches)}); the live file was not touched`);
      for (const s of run.sample) error(`  ${s.slice(0, 200)}`);
      return 1;
    }
    const displaced = swapIn(stateDir, instance, sidePath, holder, clock);
    appendLedger(join(stateDir, LEDGER_FILENAME), {
      run_id: "read-model-cli", task_id: "READ-MODEL", step: READ_MODEL_REBUILT_STEP, instance, rows: tick.fresh, facts: tick.facts,
      quarantined: tick.quarantined, checked_rows: run.ledgerRows, elapsed_ms: clock.now() - started, ...(displaced ? { displaced_lease: displaced } : {}),
    });
    out(`rebuilt ${instance}: ${tick.fresh} rows (${tick.facts} facts, ${tick.quarantined} quarantined), consistency agreed over ${run.ledgerRows} rows, swapped in${displaced ? ` (took the lease from ${displaced})` : ""}`);
    return 0;
  } catch (err) {
    const blind = err instanceof ReadModelConsistencyError ? " (the oracle could not see its corpus; an idle instance needs a wider --window-days)" : "";
    error(`rmd read-model rebuild: refused${blind}: ${(err as Error).message}; the live file was not touched`);
    return 1;
  } finally {
    rmSync(sideRoot, { recursive: true, force: true });
  }
}
