/**
 * test/liveness-distinguishes-absent-sensor-from-dead-service.test.ts — W1-T2450.
 *
 * THE DEFECT: `queryLaunchdService`'s bare `catch { return { loaded: false, pid: null } }`
 * could not tell "launchctl itself is absent" (every non-macOS host — MEASURED on the
 * observation container: `command -v launchctl` absent) from "launchctl ran and said the
 * service is not loaded" — so `daemon`/`deploy-supervisor` read confidently DEAD on any
 * non-launchd host, in the SAME render that prints a ledger-derived `boot <age> ago` for the
 * process it just called not running. Separately, `detectDaemonCrashLoop` took a bare
 * `readonly string[]` of boot timestamps with no way to see WHY a boot happened, so six
 * routine `exit 75` freshness restarts (W1-T126) read identically to six real crashes.
 *
 * Every scenario below is a plain object/array in, a plain object out (Rule 18) — no real
 * launchctl, no real ledger file beyond a seeded ndjson fixture, no real wall clock.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildStatusBoard,
  livenessState,
  renderStatusBoardText,
  type ServiceLivenessRow,
  type ServiceName,
  type StatusBoardDeps,
} from "../src/lib/status-board.js";
import { DEFAULT_CRASHLOOP_WINDOW, detectDaemonCrashLoop, type DaemonBootTimestamp } from "../src/lib/daemon.js";
import { queryLaunchdListStatusSensed, queryLaunchdServiceSensed } from "../src/run-task.js";

const NOW_ISO = "2026-08-28T23:42:51.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "liveness-sensor-"));
}

function ledgerPath(lines: Record<string, unknown>[]): string {
  const p = join(mkdtempSync(join(tmpdir(), "liveness-sensor-ledger-")), "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify({ run_id: "R1", task_id: "daemon", ...l })).join("\n") + "\n");
  return p;
}

function baseDeps(queryService: StatusBoardDeps["queryService"], overrides: Partial<StatusBoardDeps> = {}): StatusBoardDeps {
  return {
    queryService,
    repoDir: "/nonexistent/repo/for/tests",
    now: () => NOW_MS,
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    ...overrides,
  };
}

function enoent(): never {
  const e = new Error("spawn launchctl ENOENT") as NodeJS.ErrnoException;
  e.code = "ENOENT";
  throw e;
}

// ── queryLaunchdServiceSensed / queryLaunchdListStatusSensed: the sensor bit itself ─────────

test("queryLaunchdServiceSensed: launchctl absent (ENOENT) reports sensed:false, never a fabricated loaded:false-with-confidence", () => {
  const state = queryLaunchdServiceSensed("com.remudero.daemon", 501, enoent);
  assert.deepEqual(state, { loaded: false, pid: null, sensed: false });
});

test("queryLaunchdServiceSensed: launchctl present but the label is not bootstrapped reports sensed:true — a REAL not-loaded answer", () => {
  const exec = (): string => {
    throw new Error('Could not find service "com.remudero.daemon" in domain for gui/501');
  };
  const state = queryLaunchdServiceSensed("com.remudero.daemon", 501, exec);
  assert.deepEqual(state, { loaded: false, pid: null, sensed: true });
});

test("queryLaunchdServiceSensed: a loaded, running service reports sensed:true alongside its pid", () => {
  const exec = () => "com.remudero.daemon = {\n\tpid = 61234\n}";
  const state = queryLaunchdServiceSensed("com.remudero.daemon", 501, exec);
  assert.deepEqual(state, { loaded: true, pid: 61234, sensed: true });
});

test("queryLaunchdListStatusSensed: launchctl absent (ENOENT) reports sensed:false", () => {
  const state = queryLaunchdListStatusSensed("com.remudero.supervisor", enoent);
  assert.deepEqual(state, { pid: null, lastExitCode: undefined, sensed: false });
});

test("queryLaunchdListStatusSensed: launchctl present, a healthy last exit, reports sensed:true", () => {
  const exec = () => "-\t0\tcom.remudero.supervisor\n";
  const state = queryLaunchdListStatusSensed("com.remudero.supervisor", exec);
  assert.deepEqual(state, { pid: null, lastExitCode: 0, sensed: true });
});

// ── ACCEPTANCE 1: an absent launchd sensor reads as unknown, never as a stopped service ──────

test("livenessState: sensed:false reads unknown for a resident service, never the old fabricated stopped", () => {
  const row: ServiceLivenessRow = { service: "daemon", running: false, pid: null, sensed: false };
  assert.equal(livenessState(row), "unknown");
});

test("buildStatusBoard/renderStatusBoardText: a non-launchd host's daemon row renders 'unknown', names the missing sensor, and never says 'not running'", () => {
  const queryService = (): { running: boolean; pid: number | null; sensed: boolean } => ({ running: false, pid: null, sensed: false });
  const model = buildStatusBoard(tmpRoot(), join(tmpdir(), "does-not-exist.ndjson"), baseDeps(queryService));

  const daemonRow = model.liveness.services.find((s) => s.service === "daemon")!;
  assert.equal(livenessState(daemonRow), "unknown");

  const text = renderStatusBoardText(model);
  assert.match(text, /daemon\s*:\s*unknown.*no launchd sensor/);
  assert.doesNotMatch(text, /daemon\s*:\s*not running/);
  // the next action must not send the operator chasing a process that was never actually asked
  // about — "rmd up" is advice for a REAL stopped service, not an unasked question.
  assert.doesNotMatch(text, /rmd up.*resume the fleet/);
  assert.match(model.liveness.nextAction ?? "", /no launchd sensor/);
});

// ── ACCEPTANCE 2: a genuinely stopped service on a launchd host still reads stopped ──────────

test("livenessState: sensed:true (or omitted) with running:false still reads stopped — unknown is not a blanket amnesty", () => {
  const sensedTrue: ServiceLivenessRow = { service: "daemon", running: false, pid: null, sensed: true };
  const sensedOmitted: ServiceLivenessRow = { service: "daemon", running: false, pid: null };
  assert.equal(livenessState(sensedTrue), "stopped");
  assert.equal(livenessState(sensedOmitted), "stopped");
});

test("buildStatusBoard/renderStatusBoardText: a real launchd host reporting a genuinely stopped daemon still renders 'not running' and the rmd up next action", () => {
  const queryService = (): { running: boolean; pid: number | null; sensed: boolean } => ({ running: false, pid: null, sensed: true });
  const model = buildStatusBoard(tmpRoot(), join(tmpdir(), "does-not-exist.ndjson"), baseDeps(queryService));

  const daemonRow = model.liveness.services.find((s) => s.service === "daemon")!;
  assert.equal(livenessState(daemonRow), "stopped");
  assert.match(renderStatusBoardText(model), /daemon\s*:\s*not running/);
  assert.match(model.liveness.nextAction ?? "", /rmd up/);
});

// ── ACCEPTANCE 3: a daemon row carrying a boot heartbeat cannot simultaneously assert the
// process is not running ─────────────────────────────────────────────────────────────────────

test("buildStatusBoard: a recent daemon.boot heartbeat next to an unsensed query reads 'unknown — boot <age> ago', never the self-contradicting 'not running — boot <age> ago'", () => {
  const path = ledgerPath([
    { step: "daemon.boot", ts: "2026-08-28T21:58:00.000Z", head_sha: "a".repeat(40) },
  ]);
  const queryService = (): { running: boolean; pid: number | null; sensed: boolean } => ({ running: false, pid: null, sensed: false });
  const model = buildStatusBoard(tmpRoot(), path, baseDeps(queryService));

  const daemonRow = model.liveness.services.find((s) => s.service === "daemon")!;
  assert.equal(daemonRow.bootedAt, "2026-08-28T21:58:00.000Z"); // the boot heartbeat still renders
  assert.equal(livenessState(daemonRow), "unknown"); // never "stopped" — no contradiction with the boot fact

  const text = renderStatusBoardText(model);
  assert.match(text, /daemon\s*:\s*unknown.*boot 1h44m ago/);
  assert.doesNotMatch(text, /not running.*boot/); // the exact self-contradiction the recon observed
});

// ── ACCEPTANCE 4: the deploy-supervisor row separates no sensor from no tick observed ────────

test("buildStatusBoard: deploy-supervisor with an unsensed query reads 'unknown — no launchd sensor', not 'overdue'", () => {
  const queryService = (service: ServiceName): { running: boolean; pid: number | null; sensed: boolean } =>
    service === "deploy-supervisor" ? { running: false, pid: null, sensed: false } : { running: false, pid: null, sensed: true };
  const model = buildStatusBoard(tmpRoot(), join(tmpdir(), "does-not-exist.ndjson"), baseDeps(queryService));

  const row = model.liveness.services.find((s) => s.service === "deploy-supervisor")!;
  assert.equal(livenessState(row), "unknown");
  assert.match(renderStatusBoardText(model), /deploy-supervisor\s*:\s*unknown.*no launchd sensor/);
});

test("buildStatusBoard: deploy-supervisor SENSED but with no tick ever observed still reads 'overdue — no tick observed yet' — a real answer, not amnestied", () => {
  const queryService = (service: ServiceName): { running: boolean; pid: number | null; sensed: boolean } =>
    service === "deploy-supervisor" ? { running: false, pid: null, sensed: true } : { running: false, pid: null, sensed: true };
  const model = buildStatusBoard(tmpRoot(), join(tmpdir(), "does-not-exist.ndjson"), baseDeps(queryService));

  const row = model.liveness.services.find((s) => s.service === "deploy-supervisor")!;
  assert.equal(livenessState(row), "overdue");
  assert.match(renderStatusBoardText(model), /deploy-supervisor\s*:\s*overdue.*no tick observed yet/);
});

// ── ACCEPTANCE 5+6: detectDaemonCrashLoop can see (and discount) a freshness restart ─────────

/** `n` timestamps spaced `stepMs` apart, starting at `startIso`. */
function bootSeries(startIso: string, stepMs: number, n: number): string[] {
  const start = Date.parse(startIso);
  return Array.from({ length: n }, (_, i) => new Date(start + i * stepMs).toISOString());
}

test("detectDaemonCrashLoop: a boot labeled priorExitReason:'freshness' is excluded from the window — distinguishable from an unlabeled (crash-eligible) boot", () => {
  const ts = "2026-08-28T22:00:00.000Z";
  const freshnessBoot: DaemonBootTimestamp = { ts, priorExitReason: "freshness" };
  const crashBoot: DaemonBootTimestamp = { ts };
  // A lone freshness boot contributes nothing to any window (it's filtered before windowing).
  const freshnessVerdict = detectDaemonCrashLoop([freshnessBoot], DEFAULT_CRASHLOOP_WINDOW);
  assert.deepEqual(freshnessVerdict.windowBoots, []);
  // The identical timestamp, unlabeled, counts exactly as before.
  const crashVerdict = detectDaemonCrashLoop([crashBoot], DEFAULT_CRASHLOOP_WINDOW);
  assert.deepEqual(crashVerdict.windowBoots, [ts]);
});

test("detectDaemonCrashLoop: a window of freshness restarts does not breach; the identical spacing with no freshness label still does", () => {
  const stamps = bootSeries("2026-08-28T22:00:00.000Z", 60_000, 7); // 7 boots, 1/min — the crash-loop shape
  const freshnessBoots: DaemonBootTimestamp[] = stamps.map((s) => ({ ts: s, priorExitReason: "freshness" }));
  const freshnessVerdict = detectDaemonCrashLoop(freshnessBoots);
  assert.equal(freshnessVerdict.breached, false);
  assert.equal(freshnessVerdict.windowBoots.length, 0);

  // Plain strings (no reason attached at all — the shape every pre-existing caller/test still
  // passes) breach exactly as before: an absent reason is never a blanket amnesty.
  const crashVerdict = detectDaemonCrashLoop(stamps);
  assert.equal(crashVerdict.breached, true);
  assert.equal(crashVerdict.windowBoots.length, 7);
});

test("detectDaemonCrashLoop: a MIX of freshness and unlabeled boots only counts the unlabeled ones toward the breach", () => {
  const stamps = bootSeries("2026-08-28T22:00:00.000Z", 60_000, 7);
  // Every OTHER boot is a real (unlabeled) event; the rest are freshness restarts — only 4 of
  // the 7 should ever count, which does not breach the default maxBoots:5 window.
  const mixed: DaemonBootTimestamp[] = stamps.map((ts, i) => (i % 2 === 0 ? { ts } : { ts, priorExitReason: "freshness" }));
  const verdict = detectDaemonCrashLoop(mixed);
  assert.equal(verdict.windowBoots.length, 4);
  assert.equal(verdict.breached, false);
});

test("buildStatusBoard: LIVENESS — a daemon.boot burst where every boot follows a daemon.summary stale stop (freshness restarts) never renders as a crash-loop", () => {
  const start = Date.parse("2026-08-28T21:50:00.000Z");
  const lines: Record<string, unknown>[] = [];
  for (let i = 0; i < 7; i++) {
    const bootTs = new Date(start + i * 60_000).toISOString();
    if (i > 0) {
      // the PRECEDING boot's own process logged this stale stop just before restarting.
      lines.push({ step: "daemon.summary", ts: new Date(start + i * 60_000 - 5_000).toISOString(), stopReason: "stale" });
    }
    lines.push({ step: "daemon.boot", ts: bootTs });
  }
  const path = ledgerPath(lines);
  const model = buildStatusBoard(tmpRoot(), path, baseDeps(() => ({ running: false, pid: null, sensed: true })));

  assert.equal(model.liveness.crashLoop.breached, false);
  assert.doesNotMatch(renderStatusBoardText(model), /crash-loop.*BREACHED/i);
});

test("buildStatusBoard: LIVENESS — the IDENTICAL daemon.boot burst with no preceding stale daemon.summary still renders as a crash-loop", () => {
  const start = Date.parse("2026-08-28T21:50:00.000Z");
  const lines = Array.from({ length: 7 }, (_, i) => ({ step: "daemon.boot", ts: new Date(start + i * 60_000).toISOString() }));
  const path = ledgerPath(lines);
  const model = buildStatusBoard(tmpRoot(), path, baseDeps(() => ({ running: false, pid: null, sensed: true })));

  assert.equal(model.liveness.crashLoop.breached, true);
  assert.match(renderStatusBoardText(model), /crash-loop.*BREACHED/i);
});

test("buildStatusBoard: LIVENESS — a daemon.summary stopReason OTHER than 'stale' (a real blocked/error stop) still counts its following boot toward the crash-loop", () => {
  const start = Date.parse("2026-08-28T21:50:00.000Z");
  const lines: Record<string, unknown>[] = [];
  for (let i = 0; i < 7; i++) {
    const bootTs = new Date(start + i * 60_000).toISOString();
    if (i > 0) {
      lines.push({ step: "daemon.summary", ts: new Date(start + i * 60_000 - 5_000).toISOString(), stopReason: "error" });
    }
    lines.push({ step: "daemon.boot", ts: bootTs });
  }
  const path = ledgerPath(lines);
  const model = buildStatusBoard(tmpRoot(), path, baseDeps(() => ({ running: false, pid: null, sensed: true })));

  assert.equal(model.liveness.crashLoop.breached, true);
});
