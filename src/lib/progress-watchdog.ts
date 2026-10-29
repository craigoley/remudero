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

export type ProgressWatchdogState = "PROGRESSING" | "IDLE" | "STALLED" | "IN_PASS" | "RECOVERING" | "CRASH_LOOP" | "UNKNOWN";
export type ProgressWatchdogAction = "none" | "capture-diagnostics" | "recycle" | "hold-revive";
/** W1-T9702: where the open-PR count came from. A light pass writes one `sweep.pass` per PR, so only a full one counts. */
export type OpenPrCountSource = "full_pass" | "full_pass_raised" | "max_over_window";

/** The steps that count as progress. `daemon.*` / `runtime.*` are deliberately absent. */
export const PROGRESS_STEPS: ReadonlySet<string> = new Set(["sweep.pass", "review.posted", "verdict.merged"]);
/** W1-T9779: the daemon's own full-pass marker (runGatedSweep, daemon.ts) and its loop's pulse. */
export const PASS_MARKER_STEPS: readonly string[] = ["daemon.sweep.started", "daemon.sweep.settled", "daemon.sweep.abandoned", "daemon.pulse"];
/** W1-T9516: the row the daemon's loop writes on the first tick after a block clears (daemon.ts reportLoopLag). */
export const LOOP_RESUME_STEP = "daemon.loop_lag";
/** Steps the verb must read from the ledger union to feed the verdict. */
export const PROGRESS_WATCHDOG_READ_STEPS: readonly string[] =
  [...PROGRESS_STEPS, "daemon.paths", "daemon.boot", ...PASS_MARKER_STEPS, LOOP_RESUME_STEP];

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
  /** W1-T9516: the current generation's newest loop resume, when it is newer than every progress row. */
  loopResumedMs?: number | null;
  failedBoots15m: number;
  /** W1-T9627: the trailing run of revived containers that died before node wrote `daemon.paths`. */
  preNodeDeaths?: number;
  openPrCountSource?: OpenPrCountSource;
  reason: string;
}

export interface ProgressWatchdogInput {
  rows: ReadonlyArray<Record<string, unknown>>;
  nowMs: number;
  /** The open-PR count ({@link openPrCountReadingFromRows}), or undefined when unknown. */
  openPrCount: number | undefined;
  /** W1-T9627: the revival log's text. Absent, the file named by RMD_REVIVAL_LOG is read (the
   *  launcher sets it), so the verb needs no new argument; neither present reads as no revivals. */
  revivalLog?: string;
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

/**
 * W1-T9779 — 2026-10-16 06:45:28Z, A PASS WAITING ON MEMORY ADMISSION WAS RECYCLED AS STALLED. The full pass that
 * logged `daemon.sweep.started` at 06:10:59Z wrote no progress row for 30 min while two reviews and a fix waited for
 * memory, and it settled at 07:00:42Z, after the recycle had begun. The newest started row is IN FLIGHT when it
 * belongs to this generation (no boot after it), nothing ended it (no settled or abandoned row with its run_id), it
 * is still inside its own learned bound_ms (W1-T9563), and its daemon pulsed within STALL_DIAGNOSE_AFTER_MS, so a
 * frozen loop never reads as a waiting pass. No new bound. Returns the pass's start and bound, or undefined.
 */
export function inFlightPass(rows: ReadonlyArray<Record<string, unknown>>, nowMs: number):
  { startedMs: number; boundMs: number } | undefined {
  let started: { ms: number; runId: unknown; boundMs: unknown } | undefined;
  for (const row of rows) {
    const ms = row.step === "daemon.sweep.started" ? rowMs(row) : undefined;
    if (ms !== undefined && (started === undefined || ms >= started.ms)) started = { ms, runId: row.run_id, boundMs: row.bound_ms };
  }
  if (started === undefined || typeof started.boundMs !== "number" || !Number.isFinite(started.boundMs) || started.boundMs <= 0) return undefined;
  if (nowMs - started.ms > started.boundMs) return undefined;
  const pulseFloorMs = Math.max(started.ms, nowMs - STALL_DIAGNOSE_AFTER_MS);
  let pulsed = false;
  for (const row of rows) {
    const ms = rowMs(row);
    if (ms === undefined) continue;
    if ((row.step === "daemon.boot" || row.step === "daemon.paths") && ms > started.ms) return undefined;
    if ((row.step === "daemon.sweep.settled" || row.step === "daemon.sweep.abandoned") && row.run_id === started.runId && ms >= started.ms) return undefined;
    if (row.step === "daemon.pulse" && row.run_id === started.runId && ms > pulseFloorMs) pulsed = true;
  }
  return pulsed ? { startedMs: started.ms, boundMs: started.boundMs } : undefined;
}

/**
 * W1-T9516 — 2026-10-14 05:35:56Z, A DAEMON WHOSE LOOP HAD RESUMED WAS RECYCLED AS STALLED. pid 3182622's loop was
 * blocked for 45.7 min; at 05:35:46Z it wrote `daemon.loop_lag` lag_ms 2,742,587, the row its loop writes on the first
 * tick after a block clears. Ten seconds later the verdict read the 46.8-min-old progress row and asked for a recycle,
 * which replaced a daemon that was posting reviews again.
 *
 * A RESUME is a `daemon.loop_lag` row newer than the newest progress row, written by the current generation (the
 * `actor_pid`, and `host` when stamped, of the newest `daemon.boot`), carrying a positive lag_ms. The block's start
 * does not affect eligibility: even a block that began after progress was stale has now ended. The existing
 * STALL_* bounds run from the newest resume, so a second silence still exhausts the allowance. No new bound.
 */
export function loopResumeFromRows(rows: ReadonlyArray<Record<string, unknown>>, newestProgressMs: number | undefined):
  { resumedMs: number; lagMs: number } | undefined {
  if (newestProgressMs === undefined) return undefined;
  let boot: Record<string, unknown> | undefined;
  let bootMs = -Infinity;
  for (const row of rows) {
    const ms = row.step === "daemon.boot" ? rowMs(row) : undefined;
    if (ms !== undefined && ms >= bootMs) [boot, bootMs] = [row, ms];
  }
  if (boot === undefined || typeof boot.actor_pid !== "number") return undefined;
  let resume: { resumedMs: number; lagMs: number } | undefined;
  for (const row of rows) {
    const ms = row.step === LOOP_RESUME_STEP ? rowMs(row) : undefined;
    const lagMs = row.lag_ms;
    if (ms === undefined || ms <= newestProgressMs || ms < bootMs || typeof lagMs !== "number" || !(lagMs > 0)) continue;
    if (row.actor_pid !== boot.actor_pid || (typeof boot.host === "string" && row.host !== boot.host)) continue;
    if (resume === undefined || ms > resume.resumedMs) resume = { resumedMs: ms, lagMs };
  }
  return resume;
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
  // W1-T9516: a resumed loop's stall is aged from its resume, as a generation's is from its boot.
  const resume = loopResumeFromRows(rows, newestProgressMs);
  const loopResumedMs = resume?.resumedMs ?? null;
  const preNode = preNodeDeathRun(input.revivalLog ?? readRevivalLogTail(process.env[REVIVAL_LOG_ENV]), rows);
  const verdict = (state: ProgressWatchdogState, action: ProgressWatchdogAction, reason: string): ProgressWatchdogVerdict =>
    ({ state, action, progressAgeMs, generationBootMs, loopResumedMs, failedBoots15m, preNodeDeaths: preNode.count,
      ...(openPrCountSource ? { openPrCountSource } : {}), reason });

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
  const resumeAgeMs = resume ? Math.max(0, nowMs - resume.resumedMs) : undefined;
  if (resume && resumeAgeMs !== undefined && progressAgeMs > STALL_DIAGNOSE_AFTER_MS && resumeAgeMs <= STALL_RECYCLE_AFTER_MS) {
    const said = `newest progress row is ${minutes} min old, but this generation's loop resumed at ` +
      `${fixedClock(resume.resumedMs).iso()} (${Math.floor(resumeAgeMs / 60_000)} min ago) after a block of lag_ms ${resume.lagMs}`;
    if (resumeAgeMs > STALL_DIAGNOSE_AFTER_MS) return verdict("STALLED", "capture-diagnostics", `${said} and has written no progress row since`);
    return verdict("RECOVERING", "none", `${said}; its progress is owed ${STALL_RECYCLE_AFTER_MS / 60_000} min after the resume`);
  }
  if (progressAgeMs > STALL_RECYCLE_AFTER_MS) {
    const pass = inFlightPass(rows, nowMs);
    if (pass) {
      return verdict("IN_PASS", "capture-diagnostics", `newest progress row is ${minutes} min old, but the full pass started ` +
        `${Math.floor((nowMs - pass.startedMs) / 60_000)} min ago is in flight inside its own learned bound ` +
        `(${Math.floor(pass.boundMs / 60_000)} min) and its daemon is pulsing; not recycled`);
    }
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
