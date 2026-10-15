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
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixedClock } from "./clock.js";

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
/** W1-T9627: the launcher names its revival log here when it asks for a verdict. */
export const REVIVAL_LOG_ENV = "RMD_REVIVAL_LOG";
/** bound kind: physical — the revival-log tail one verdict reads (~3,000 lines, days of 5-minute revives); the log is append-only for the host's life. */
export const REVIVAL_LOG_TAIL_BYTES = 256 * 1024;

export interface ProgressWatchdogVerdict {
  state: ProgressWatchdogState;
  action: ProgressWatchdogAction;
  /** Age of the newest progress row, or null when none was read. */
  progressAgeMs: number | null;
  /** W1-T6598: the boot that started the current generation, when it is newer than every progress row. */
  generationBootMs?: number | null;
  failedBoots15m: number;
  /** W1-T9627: the trailing run of revived containers that died before node wrote `daemon.paths`. */
  preNodeDeaths?: number;
  reason: string;
}

export interface ProgressWatchdogInput {
  rows: ReadonlyArray<Record<string, unknown>>;
  nowMs: number;
  /** The open-PR count (the newest `sweep.pass` row's `enumerated`), or undefined when unknown. */
  openPrCount: number | undefined;
  /** W1-T9627: the revival log's text. Absent, the file named by RMD_REVIVAL_LOG is read (the
   *  launcher sets it), so the verb needs no new argument; neither present reads as no revivals. */
  revivalLog?: string;
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

/**
 * W1-T9627 — 2026-10-15, A DAEMON THAT DIED BEFORE NODE STARTED WAS INVISIBLE HERE. From 08:22Z every
 * core boot died in deploy/entrypoint.sh about a second in (`cannot check out main`), so no container
 * wrote `daemon.paths` or `daemon.boot`. failedBootTimes counts only boots that logged `daemon.paths`,
 * so failedBoots15m stayed 0 and the verdict said STALLED action=recycle -- which the launcher's down
 * arm never acts on -- for two hours and 25 revives.
 *
 * THE REVIVAL LOG IS THE EVIDENCE THE LEDGER CANNOT HOLD. The launcher writes one `revive` line per
 * revive, carrying the previous container's status and exit code. Revive j therefore reports how the
 * container revive j-1 started ended: it is a PRE-NODE DEATH when that line says it exited non-zero
 * and no `daemon.paths` row lies between the two revives. This returns the trailing run of them,
 * newest first, ended by anything that is not one: a container that reached node, an exit of 0 or
 * `none` (a clean stop, or nothing to revive), a host boot, a `crash-loop-release` (the input
 * changed, so earlier deaths judged other code), or a revive older than the ledger rows read (no
 * row can vouch for that interval). No new bound: the run's own contiguity is the window, and it is
 * held to CRASH_LOOP_BOOTS like a failed boot.
 */
export function preNodeDeathRun(
  revivalLog: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): { count: number; lastExit: string } {
  type Event = { ms: number; release: true } | { ms: number; release: false; boot: string; status: string; exit: string };
  const events: Event[] = [];
  for (const line of revivalLog.split("\n")) {
    const revive = /^(\S+) revive boot=(\S+) prev_status=(\S+) prev_exit=(\S+)/.exec(line);
    const release = /^(\S+) crash-loop-release /.exec(line);
    const ms = Date.parse((revive ?? release)?.[1] ?? "");
    if (Number.isNaN(ms)) continue;
    events.push(revive ? { ms, release: false, boot: revive[2], status: revive[3], exit: revive[4] } : { ms, release: true });
  }
  let coverageMs = Infinity;
  const pathsMs: number[] = [];
  for (const row of rows) {
    const ms = rowMs(row);
    if (ms === undefined) continue;
    coverageMs = Math.min(coverageMs, ms);
    if (row.step === "daemon.paths") pathsMs.push(ms);
  }
  const reachedNodeIn = (from: number, to: number): boolean => pathsMs.some((ms) => ms >= from && ms < to);
  const newest = events.at(-1);
  if (!newest || newest.release || reachedNodeIn(newest.ms, Infinity)) return { count: 0, lastExit: "" };
  let count = 0;
  // File order, not timestamps: a release and the revive it lets through share a second.
  for (let j = events.length - 1; j >= 1; j -= 1) {
    const seen = events[j];
    const started = events[j - 1];
    if (seen.release || started.release) break;
    const died = seen.boot === "0" && (seen.status === "exited" || seen.status === "dead") && seen.exit !== "0" && seen.exit !== "none";
    if (!died || started.ms < coverageMs || reachedNodeIn(started.ms, seen.ms)) break;
    count += 1;
  }
  return { count, lastExit: count > 0 ? newest.exit : "" };
}

/** The revival log's bounded tail, or `""` when no log is named or it cannot be read (no evidence). */
export function readRevivalLogTail(path: string | undefined): string {
  if (!path) return "";
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, REVIVAL_LOG_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const text = buf.toString("utf8");
    // A tail cut mid-line keeps only whole lines.
    return length < size ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return ""; // an unreadable log is no evidence of a death, never a crash loop
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
  // A generation's stall is aged from its OWN boot, never from the dead generation's last progress row.
  const generationBootMs = generationBootMsFromRows(rows, nowMs, newestProgressMs);
  const preNode = preNodeDeathRun(input.revivalLog ?? readRevivalLogTail(process.env[REVIVAL_LOG_ENV]), rows);
  const verdict = (state: ProgressWatchdogState, action: ProgressWatchdogAction, reason: string): ProgressWatchdogVerdict =>
    ({ state, action, progressAgeMs, generationBootMs, failedBoots15m, preNodeDeaths: preNode.count, reason });

  if (failedBoots15m >= CRASH_LOOP_BOOTS) {
    return verdict("CRASH_LOOP", "hold-revive", `${failedBoots15m} boots in 15 min logged daemon.paths and never reached daemon.boot`);
  }
  if (preNode.count >= CRASH_LOOP_BOOTS) {
    return verdict(
      "CRASH_LOOP",
      "hold-revive",
      `${preNode.count} revived containers in a row exited ${preNode.lastExit} before node started (no daemon.paths row from any of them): ` +
        "the container dies in deploy/entrypoint.sh, before the daemon boots",
    );
  }
  if (rows.length === 0) return verdict("UNKNOWN", "none", "no ledger rows were read");
  if (openPrCount === undefined) return verdict("UNKNOWN", "none", "the open-PR count is unknown (no sweep.pass row with an enumerated count)");
  if (openPrCount === 0) return verdict("IDLE", "none", "no open PRs, so no progress is owed");
  if (generationBootMs !== null) {
    // Bounded startup allowance: the existing STALL_* bounds, run from this generation's own boot.
    const bootAgeMs = Math.max(0, nowMs - generationBootMs);
    const said = `this generation booted ${Math.floor(bootAgeMs / 60_000)} min ago and has written no progress row`;
    if (bootAgeMs > STALL_RECYCLE_AFTER_MS) return verdict("STALLED", "recycle", `${said}, with ${openPrCount} open PR(s)`);
    if (bootAgeMs > STALL_DIAGNOSE_AFTER_MS) return verdict("STALLED", "capture-diagnostics", `${said}, with ${openPrCount} open PR(s)`);
    return verdict("PROGRESSING", "none", `${said} yet; its first pass is owed ${STALL_RECYCLE_AFTER_MS / 60_000} min after boot`);
  }
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
  return fixedClock(ms).iso().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Parses `progress-YYYYMMDDTHHMMSSZ` back to epoch ms, or undefined for any other name. */
export function bundleDirMs(name: string): number | undefined {
  const m = /^progress-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : undefined;
}

/**
 * Writes one bundle under <stateDir>/diagnostics/progress-<ts>/ — ledger tail, `docker ps -a`, each
 * tenant's `docker logs --tail` (running or exited), and the verdict — unless one was written within the last 15 min.
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
  // W1-T9627: `-a`, because a dead daemon is the one whose log matters, and `docker ps` lists only
  // running containers -- the 2026-10-15 bundle held serve's log and not the crash-looping core's.
  const ps = attempt("docker", ["ps", "-a", "--format", "{{.Names}}\t{{.Status}}"]);
  writeFileSync(join(dir, "docker-ps.txt"), ps);
  const tenants = ps.startsWith("#") ? [] : ps.split("\n").map((s) => s.trim().split(/\s+/)[0] ?? "").filter((name) => /remudero/i.test(name));
  tenants.forEach((name, index) => {
    writeFileSync(join(dir, `docker-logs-${index}.txt`), `# ${name}\n` + attempt("docker", ["logs", "--tail", "200", name]));
  });
  return { written: true, dir };
}

export function renderProgressWatchdogVerdict(verdict: ProgressWatchdogVerdict): string {
  const age = verdict.progressAgeMs === null ? "none" : `${Math.floor(verdict.progressAgeMs / 60_000)} min`;
  return `progress-watchdog: ${verdict.state} action=${verdict.action} progress_age=${age} failed_boots_15m=${verdict.failedBoots15m} — ${verdict.reason}`;
}
