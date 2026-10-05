/**
 * W1-T5687 — a stalled sweep is named from outside the daemon by its PROGRESS, not its pulse.
 *
 * Every other liveness reader keys on the `daemon.` step prefix, which a crash-looping daemon writes
 * on every boot (`daemon.paths`, `daemon.target`) and a wedged one writes on a timer (`daemon.pulse`,
 * `daemon.loop_lag`). Progress is something only a working sweep writes: a `sweep.pass`, a
 * `review.posted` or a `verdict.merged`. `daemon.*` and `runtime.*` rows are NEVER progress here.
 *
 * `decideProgressWatchdog` is pure; the verb in run-task.ts reads the ledger union and prints it.
 * Acting on `recycle` / `hold-revive` is W1-T5688's, not this module's.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ProgressWatchdogState = "PROGRESSING" | "IDLE" | "STALLED" | "CRASH_LOOP" | "UNKNOWN";
export type ProgressWatchdogAction = "none" | "capture-diagnostics" | "recycle" | "hold-revive";

/** The steps that count as progress. `daemon.*` / `runtime.*` are deliberately absent. */
export const PROGRESS_STEPS: ReadonlySet<string> = new Set(["sweep.pass", "review.posted", "verdict.merged"]);
/** Steps the verb must read from the ledger union to feed the verdict. */
export const PROGRESS_WATCHDOG_READ_STEPS: readonly string[] = [...PROGRESS_STEPS, "daemon.paths", "daemon.boot"];

/** bound kind: calibrated — progress older than this captures a diagnostics bundle (the 45-min and 51-min gaps all pass it). */
export const STALL_DIAGNOSE_AFTER_MS = 15 * 60_000;
/** bound kind: calibrated — progress older than this asks for a recycle. */
export const STALL_RECYCLE_AFTER_MS = 30 * 60_000;
/** bound kind: calibrated — the window in which failed boots are counted. */
export const CRASH_LOOP_WINDOW_MS = 15 * 60_000;
/** bound kind: calibrated — failed boots inside the window that make a crash loop. */
export const CRASH_LOOP_BOOTS = 3;
/** bound kind: physical — a newest `daemon.paths` row younger than this may still be mid-boot (plan sync runs before `daemon.boot`). */
export const BOOT_GRACE_MS = 60_000;
/** bound kind: calibrated — at most one diagnostics bundle per this interval. */
export const DIAGNOSTICS_MIN_INTERVAL_MS = 15 * 60_000;

export interface ProgressWatchdogVerdict {
  state: ProgressWatchdogState;
  action: ProgressWatchdogAction;
  /** Age of the newest progress row, or null when none was read. */
  progressAgeMs: number | null;
  failedBoots15m: number;
  reason: string;
}

export interface ProgressWatchdogInput {
  rows: ReadonlyArray<Record<string, unknown>>;
  nowMs: number;
  /** The open-PR count (the newest `sweep.pass` row's `enumerated`), or undefined when unknown. */
  openPrCount: number | undefined;
}

function rowMs(row: Record<string, unknown>): number | undefined {
  if (typeof row.ts !== "string") return undefined;
  const ms = Date.parse(row.ts);
  return Number.isNaN(ms) ? undefined : ms;
}

/** The newest `sweep.pass` row's `enumerated`, or undefined when there is none or it is not a count. */
export function openPrCountFromRows(rows: ReadonlyArray<Record<string, unknown>>): number | undefined {
  let newestMs = -Infinity;
  let count: number | undefined;
  for (const row of rows) {
    if (row.step !== "sweep.pass") continue;
    const ms = rowMs(row);
    if (ms === undefined || ms < newestMs) continue;
    newestMs = ms;
    count = typeof row.enumerated === "number" && Number.isFinite(row.enumerated) && row.enumerated >= 0 ? row.enumerated : undefined;
  }
  return count;
}

/** `daemon.paths` boots with no `daemon.boot` under the same run_id: superseded by a later `daemon.paths`, or older than the grace. */
export function failedBootTimes(rows: ReadonlyArray<Record<string, unknown>>, nowMs: number): number[] {
  const booted = new Set<string>();
  const paths: Array<{ ms: number; runId: string }> = [];
  for (const row of rows) {
    const runId = typeof row.run_id === "string" ? row.run_id : "";
    if (row.step === "daemon.boot") booted.add(runId);
    else if (row.step === "daemon.paths") {
      const ms = rowMs(row);
      if (ms !== undefined) paths.push({ ms, runId });
    }
  }
  paths.sort((a, b) => a.ms - b.ms);
  const failed: number[] = [];
  paths.forEach((boot, index) => {
    if (booted.has(boot.runId)) return;
    const superseded = index < paths.length - 1;
    if (superseded || nowMs - boot.ms > BOOT_GRACE_MS) failed.push(boot.ms);
  });
  return failed;
}

export function decideProgressWatchdog(input: ProgressWatchdogInput): ProgressWatchdogVerdict {
  const { rows, nowMs, openPrCount } = input;
  const failedBoots15m = failedBootTimes(rows, nowMs).filter((ms) => nowMs - ms <= CRASH_LOOP_WINDOW_MS).length;
  let newestProgressMs: number | undefined;
  for (const row of rows) {
    if (typeof row.step !== "string" || !PROGRESS_STEPS.has(row.step)) continue;
    const ms = rowMs(row);
    if (ms !== undefined && (newestProgressMs === undefined || ms > newestProgressMs)) newestProgressMs = ms;
  }
  const progressAgeMs = newestProgressMs === undefined ? null : Math.max(0, nowMs - newestProgressMs);
  const verdict = (state: ProgressWatchdogState, action: ProgressWatchdogAction, reason: string): ProgressWatchdogVerdict =>
    ({ state, action, progressAgeMs, failedBoots15m, reason });

  if (failedBoots15m >= CRASH_LOOP_BOOTS) {
    return verdict("CRASH_LOOP", "hold-revive", `${failedBoots15m} boots in 15 min logged daemon.paths and never reached daemon.boot`);
  }
  if (rows.length === 0) return verdict("UNKNOWN", "none", "no ledger rows were read");
  if (openPrCount === undefined) return verdict("UNKNOWN", "none", "the open-PR count is unknown (no sweep.pass row with an enumerated count)");
  if (openPrCount === 0) return verdict("IDLE", "none", "no open PRs, so no progress is owed");
  if (progressAgeMs === null) return verdict("UNKNOWN", "none", "no sweep.pass, review.posted or verdict.merged row was read");
  const minutes = Math.floor(progressAgeMs / 60_000);
  if (progressAgeMs > STALL_RECYCLE_AFTER_MS) {
    return verdict("STALLED", "recycle", `newest progress row is ${minutes} min old with ${openPrCount} open PR(s); daemon.* rows are not progress`);
  }
  if (progressAgeMs > STALL_DIAGNOSE_AFTER_MS) {
    return verdict("STALLED", "capture-diagnostics", `newest progress row is ${minutes} min old with ${openPrCount} open PR(s); daemon.* rows are not progress`);
  }
  return verdict("PROGRESSING", "none", `newest progress row is ${minutes} min old`);
}

export interface DiagnosticsExec {
  /** Runs a command and returns its stdout, or throws. */
  run(file: string, args: string[]): string;
}

export interface DiagnosticsBundleResult {
  written: boolean;
  dir?: string;
  skippedReason?: string;
}

function bundleStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Parses `progress-YYYYMMDDTHHMMSSZ` back to epoch ms, or undefined for any other name. */
export function bundleDirMs(name: string): number | undefined {
  const m = /^progress-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : undefined;
}

/**
 * Writes one bundle under <stateDir>/diagnostics/progress-<ts>/ — ledger tail, `docker ps`, the
 * tenant's `docker logs --tail`, and the verdict — unless one was written within the last 15 min.
 * A failing docker call is recorded INSIDE the bundle file it would have filled, never swallowed.
 */
export function captureDiagnosticsBundle(
  stateDir: string,
  nowMs: number,
  verdict: ProgressWatchdogVerdict,
  rows: ReadonlyArray<Record<string, unknown>>,
  exec: DiagnosticsExec,
): DiagnosticsBundleResult {
  const root = join(stateDir, "diagnostics");
  const existing = existsSync(root) ? readdirSync(root) : [];
  const newest = Math.max(-Infinity, ...existing.map((name) => bundleDirMs(name) ?? -Infinity));
  if (nowMs - newest < DIAGNOSTICS_MIN_INTERVAL_MS) {
    return { written: false, skippedReason: `a diagnostics bundle was written ${Math.floor((nowMs - newest) / 60_000)} min ago (at most one per 15 min)` };
  }
  const dir = join(root, `progress-${bundleStamp(nowMs)}`);
  mkdirSync(dir, { recursive: true });
  const attempt = (file: string, args: string[]): string => {
    try {
      return exec.run(file, args);
    } catch (err) {
      return `# ${file} ${args.join(" ")} failed: ${err instanceof Error ? err.message : String(err)}\n`;
    }
  };
  writeFileSync(join(dir, "verdict.json"), JSON.stringify({ ...verdict, at: new Date(nowMs).toISOString() }, null, 2) + "\n");
  writeFileSync(join(dir, "ledger-tail.ndjson"), rows.slice(-200).map((row) => JSON.stringify(row)).join("\n") + "\n");
  const ps = attempt("docker", ["ps", "--format", "{{.Names}}"]);
  writeFileSync(join(dir, "docker-ps.txt"), ps);
  const tenants = ps.startsWith("#") ? [] : ps.split("\n").map((s) => s.trim()).filter((name) => /remudero/i.test(name));
  tenants.forEach((name, index) => {
    writeFileSync(join(dir, `docker-logs-${index}.txt`), `# ${name}\n` + attempt("docker", ["logs", "--tail", "200", name]));
  });
  return { written: true, dir };
}

export function renderProgressWatchdogVerdict(verdict: ProgressWatchdogVerdict): string {
  const age = verdict.progressAgeMs === null ? "none" : `${Math.floor(verdict.progressAgeMs / 60_000)} min`;
  return `progress-watchdog: ${verdict.state} action=${verdict.action} progress_age=${age} failed_boots_15m=${verdict.failedBoots15m} — ${verdict.reason}`;
}
