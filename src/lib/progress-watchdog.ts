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
import { fixedClock } from "./clock.js";

export type ProgressWatchdogState = "PROGRESSING" | "IDLE" | "STALLED" | "CRASH_LOOP" | "UNKNOWN";
export type ProgressWatchdogAction = "none" | "capture-diagnostics" | "recycle" | "hold-revive";
/** W1-T9702: where the open-PR count came from. A light pass writes one `sweep.pass` per PR, so only a full one counts. */
export type OpenPrCountSource = "full_pass" | "full_pass_raised" | "max_over_window";

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
  /** W1-T6598: the boot that started the current generation, when it is newer than every progress row. */
  generationBootMs?: number | null;
  failedBoots15m: number;
  openPrCountSource?: OpenPrCountSource;
  reason: string;
}

export interface ProgressWatchdogInput {
  rows: ReadonlyArray<Record<string, unknown>>;
  nowMs: number;
  /** The open-PR count ({@link openPrCountReadingFromRows}), or undefined when unknown. */
  openPrCount: number | undefined;
  openPrCountSource?: OpenPrCountSource;
}

function rowMs(row: Record<string, unknown>): number | undefined {
  if (typeof row.ts !== "string") return undefined;
  const ms = Date.parse(row.ts);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * W1-T9702: the newest FULL pass's `enumerated`, raised by any newer pass that saw more. With no full row
 * read (rows written before the surface field), the largest `enumerated` among the rows read.
 */
export function openPrCountReadingFromRows(rows: ReadonlyArray<Record<string, unknown>>):
  { count: number | undefined; source: OpenPrCountSource | undefined } {
  const passes: Array<{ ms: number; count: number; full: boolean }> = [];
  for (const row of rows) {
    const ms = row.step === "sweep.pass" ? rowMs(row) : undefined;
    const count = row.enumerated;
    if (ms === undefined || typeof count !== "number" || !Number.isFinite(count) || count < 0) continue;
    passes.push({ ms, count, full: row.surface === "full" });
  }
  if (passes.length === 0) return { count: undefined, source: undefined };
  const full = passes.filter((pass) => pass.full).reduce<(typeof passes)[number] | undefined>(
    (newest, pass) => (newest === undefined || pass.ms >= newest.ms ? pass : newest), undefined);
  if (full === undefined) return { count: Math.max(...passes.map((pass) => pass.count)), source: "max_over_window" };
  const newer = Math.max(...passes.filter((pass) => pass.ms > full.ms).map((pass) => pass.count));
  return newer > full.count ? { count: newer, source: "full_pass_raised" } : { count: full.count, source: "full_pass" };
}

/** The open-PR count {@link openPrCountReadingFromRows} reads, or undefined when unknown. */
export function openPrCountFromRows(rows: ReadonlyArray<Record<string, unknown>>): number | undefined {
  return openPrCountReadingFromRows(rows).count;
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

/**
 * W1-T6598 — the boot that started the current generation, when it is NEWER than every progress row:
 * the newest `daemon.boot`, or a `daemon.paths` still inside BOOT_GRACE_MS with no `daemon.boot` yet
 * (plan sync runs before `daemon.boot`, so a just-recycled daemon is mid-boot for tens of seconds).
 * A failed boot (past the grace, never booted) starts nothing: it is CRASH_LOOP's evidence.
 */
export function generationBootMsFromRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  nowMs: number,
  newestProgressMs: number | undefined,
): number | null {
  const booted = new Set<string>();
  for (const row of rows) if (row.step === "daemon.boot") booted.add(typeof row.run_id === "string" ? row.run_id : "");
  let newest: number | undefined;
  for (const row of rows) {
    const ms = rowMs(row);
    if (ms === undefined) continue;
    const runId = typeof row.run_id === "string" ? row.run_id : "";
    const starts = row.step === "daemon.boot"
      || (row.step === "daemon.paths" && !booted.has(runId) && nowMs - ms <= BOOT_GRACE_MS);
    if (starts && (newest === undefined || ms > newest)) newest = ms;
  }
  if (newest === undefined) return null;
  return newestProgressMs === undefined || newest > newestProgressMs ? newest : null;
}

export function decideProgressWatchdog(input: ProgressWatchdogInput): ProgressWatchdogVerdict {
  const { rows, nowMs, openPrCount, openPrCountSource } = input;
  const failedBoots15m = failedBootTimes(rows, nowMs).filter((ms) => nowMs - ms <= CRASH_LOOP_WINDOW_MS).length;
  let newestProgressMs: number | undefined;
  for (const row of rows) {
    if (typeof row.step !== "string" || !PROGRESS_STEPS.has(row.step)) continue;
    const ms = rowMs(row);
    if (ms !== undefined && (newestProgressMs === undefined || ms > newestProgressMs)) newestProgressMs = ms;
  }
  const progressAgeMs = newestProgressMs === undefined ? null : Math.max(0, nowMs - newestProgressMs);
  // A generation's stall is aged from its OWN boot, never from the dead generation's last progress row.
  const generationBootMs = generationBootMsFromRows(rows, nowMs, newestProgressMs);
  const verdict = (state: ProgressWatchdogState, action: ProgressWatchdogAction, reason: string): ProgressWatchdogVerdict =>
    ({ state, action, progressAgeMs, generationBootMs, failedBoots15m, ...(openPrCountSource ? { openPrCountSource } : {}), reason });

  if (failedBoots15m >= CRASH_LOOP_BOOTS) {
    return verdict("CRASH_LOOP", "hold-revive", `${failedBoots15m} boots in 15 min logged daemon.paths and never reached daemon.boot`);
  }
  if (rows.length === 0) return verdict("UNKNOWN", "none", "no ledger rows were read");
  if (openPrCount === undefined) return verdict("UNKNOWN", "none", "the open-PR count is unknown (no sweep.pass row with an enumerated count)");
  const counted = openPrCountSource ? ` (count: ${openPrCountSource})` : "";
  if (openPrCount === 0) return verdict("IDLE", "none", `no open PRs${counted}, so no progress is owed`);
  if (generationBootMs !== null) {
    // Bounded startup allowance: the existing STALL_* bounds, run from this generation's own boot.
    const bootAgeMs = Math.max(0, nowMs - generationBootMs);
    const said = `this generation booted ${Math.floor(bootAgeMs / 60_000)} min ago and has written no progress row`;
    if (bootAgeMs > STALL_RECYCLE_AFTER_MS) return verdict("STALLED", "recycle", `${said}, with ${openPrCount} open PR(s)${counted}`);
    if (bootAgeMs > STALL_DIAGNOSE_AFTER_MS) return verdict("STALLED", "capture-diagnostics", `${said}, with ${openPrCount} open PR(s)${counted}`);
    return verdict("PROGRESSING", "none", `${said} yet; its first pass is owed ${STALL_RECYCLE_AFTER_MS / 60_000} min after boot`);
  }
  if (progressAgeMs === null) return verdict("UNKNOWN", "none", "no sweep.pass, review.posted or verdict.merged row was read");
  const minutes = Math.floor(progressAgeMs / 60_000);
  if (progressAgeMs > STALL_RECYCLE_AFTER_MS) {
    return verdict("STALLED", "recycle", `newest progress row is ${minutes} min old with ${openPrCount} open PR(s)${counted}; daemon.* rows are not progress`);
  }
  if (progressAgeMs > STALL_DIAGNOSE_AFTER_MS) {
    return verdict("STALLED", "capture-diagnostics", `newest progress row is ${minutes} min old with ${openPrCount} open PR(s)${counted}; daemon.* rows are not progress`);
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
  return fixedClock(ms).iso().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
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
  writeFileSync(join(dir, "verdict.json"), JSON.stringify({ ...verdict, at: fixedClock(nowMs).iso() }, null, 2) + "\n");
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
