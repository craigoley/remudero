/**
 * W1-T11327 — A STALLED DAEMON WHOSE LOOP IS ALIVE IS RESTARTED IN PLACE BEFORE A RECYCLE.
 *
 * OBSERVED 2026-11-04: the watchdog's 13:04:08Z recycle read "STALLED progressAgeMs=2595011" while the daemon wrote rows
 * at 13:04:09Z and 13:34:13Z; the recycle paused the fleet until 14:00:25Z and refused. A live loop is asked to leave
 * through its own freshness exit first (`restart-in-place`); a recycle follows when that request goes unanswered by a
 * newer boot past RESTART_REQUEST_GRACE_MS, when the restart it answered wrote no progress, or at once when the loop is
 * frozen. These tests replay rows of that shape.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";

import { peekRestartInPlace, restartInPlaceVerb } from "#src/lib/fleet-control.js";
import {
  PROGRESS_WATCHDOG_READ_STEPS, RESTART_IN_PLACE_ACTION, RESTART_REQUEST_GRACE_MS, RESTART_REQUESTED_STEP, STALL_DIAGNOSE_AFTER_MS,
  decideProgressWatchdog, openPrCountReadingFromRows,
} from "#src/lib/progress-watchdog.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = Record<string, unknown>;
const MIN = 60_000;
const PID = 4_101_327;
const NEXT_PID = 4_101_999;
const HOST = "remudero-core";
const BOOT = Date.parse("2026-11-04T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

const boot = (ms: number, pid = PID): Row[] => [
  { ts: iso(ms - 1_000), step: "daemon.paths", run_id: `DAEMON-${pid}`, actor_pid: pid, host: HOST },
  { ts: iso(ms), step: "daemon.boot", run_id: `DAEMON-${pid}`, actor_pid: pid, host: HOST },
];
const progress = (ms: number, pid = PID): Row =>
  ({ ts: iso(ms), step: "sweep.pass", run_id: `DAEMON-${pid}`, actor_pid: pid, host: HOST, enumerated: 9, surface: "full" });
const loopLag = (ms: number, pid = PID): Row =>
  ({ ts: iso(ms), step: "daemon.loop_lag", run_id: `DAEMON-${pid}`, actor_pid: pid, host: HOST, phase: "dispatch", lag_ms: 9_000 });
const pulse = (ms: number, pid = PID): Row =>
  ({ ts: iso(ms), step: "daemon.pulse", run_id: `DAEMON-${pid}`, actor_pid: pid, host: HOST, quiet_ms: 300_000 });
const requested = (ms: number): Row =>
  ({ ts: iso(ms), step: RESTART_REQUESTED_STEP, run_id: "PROGRESS-WATCHDOG", origin: "progress-watchdog", requested_at: iso(ms) });

/** Boot, one progress row 3 min later, then a loop that keeps pulsing every 4 min up to `liveUntil`. A fresh
 *  `daemon.loop_lag` newer than progress already reads RECOVERING (W1-T9516), so past progress the pulse is the signal. */
function stalledRows(liveUntil: number, extra: Row[] = []): Row[] {
  const rows = [...boot(BOOT), progress(BOOT + 3 * MIN)];
  for (let ms = BOOT + 4 * MIN; ms <= liveUntil; ms += 4 * MIN) rows.push(pulse(ms));
  return [...rows, ...extra].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

function decide(rows: Row[], nowMs: number) {
  const count = openPrCountReadingFromRows(rows);
  return decideProgressWatchdog({ rows, nowMs, openPrCount: count.count, openPrCountSource: count.source, revivalLog: "" });
}

test("W1-T11327 criterion 2: a stall it would recycle is restarted in place while the loop is alive", () => {
  assert.equal(RESTART_REQUEST_GRACE_MS, 15 * MIN);
  assert.ok(PROGRESS_WATCHDOG_READ_STEPS.includes(RESTART_REQUESTED_STEP), "the verb reads the request rows");
  const now = BOOT + 40 * MIN;
  const verdict = decide(stalledRows(now - MIN), now);
  assert.deepEqual([verdict.state, verdict.action], ["STALLED", RESTART_IN_PLACE_ACTION], verdict.reason);
  assert.equal(RESTART_IN_PLACE_ACTION, "restart-in-place");
  assert.match(verdict.reason, /newest progress row is 37 min old/);
  assert.match(verdict.reason, /loop is alive/);

  // Before its first progress row, a generation's `daemon.loop_lag` is the loop's signal too.
  const lagged = [...boot(BOOT), loopLag(BOOT + 31 * MIN - MIN)];
  const first = decide([...lagged, progress(BOOT - 60 * MIN)], BOOT + 31 * MIN);
  assert.equal(first.action, RESTART_IN_PLACE_ACTION, first.reason);
});

test("W1-T11327 criterion 2: a frozen loop is recycled at once", () => {
  const now = BOOT + 40 * MIN;
  const frozen = decide(stalledRows(now - STALL_DIAGNOSE_AFTER_MS - MIN), now);
  assert.deepEqual([frozen.state, frozen.action], ["STALLED", "recycle"], frozen.reason);
  assert.match(frozen.reason, /loop is frozen/);

  // A row from another process is not this generation's loop.
  const foreign = [...boot(BOOT), progress(BOOT + 3 * MIN), loopLag(now - MIN, NEXT_PID)];
  assert.equal(decide(foreign, now).action, "recycle");

  // A generation whose rows carry no actor_pid cannot be shown to be this loop, as W1-T9516 reads a resume.
  const unstamped = stalledRows(now - MIN).map(({ actor_pid: _pid, ...row }) => row);
  assert.equal(decide(unstamped, now).action, "recycle");
});

test("W1-T11327 criterion 2: a pending request is waited on inside its grace and recycled past it", () => {
  const askedAt = BOOT + 40 * MIN;
  const within = askedAt + 5 * MIN;
  const waiting = decide(stalledRows(within - MIN, [requested(askedAt)]), within);
  assert.deepEqual([waiting.state, waiting.action], ["STALLED", "capture-diagnostics"], waiting.reason);
  assert.match(waiting.reason, /restart in place was requested 5 min ago/);
  assert.deepEqual(waiting.restartRequest, { requestedMs: askedAt, answeredByBootMs: null });

  const past = askedAt + RESTART_REQUEST_GRACE_MS + MIN;
  const lapsed = decide(stalledRows(past - MIN, [requested(askedAt)]), past);
  assert.deepEqual([lapsed.state, lapsed.action], ["STALLED", "recycle"], lapsed.reason);
  assert.match(lapsed.reason, /no newer boot/);

  // A frozen loop does not wait out the grace.
  const frozenNow = askedAt + 5 * MIN;
  const frozen = decide([...boot(BOOT), progress(BOOT + 3 * MIN), requested(askedAt)], frozenNow);
  assert.equal(frozen.action, "recycle", frozen.reason);
});

test("W1-T11327 criterion 2: a request followed by a newer boot reads as answered", () => {
  const askedAt = BOOT + 40 * MIN;
  const reboot = askedAt + 2 * MIN;
  const answered = [...stalledRows(askedAt, [requested(askedAt)]), ...boot(reboot, NEXT_PID)];

  // The restarted generation progressed, then stalled again with its loop alive: a fresh in-place restart.
  const later = reboot + 5 * MIN + 40 * MIN;
  const again = [...answered, progress(reboot + 5 * MIN, NEXT_PID), pulse(later - MIN, NEXT_PID)];
  const verdict = decide(again, later);
  assert.equal(verdict.action, RESTART_IN_PLACE_ACTION, verdict.reason);
  assert.deepEqual(verdict.restartRequest, { requestedMs: askedAt, answeredByBootMs: reboot });

  // The restart it answered wrote no progress: the generation's own allowance runs out and it is recycled.
  const noProgress = reboot + 31 * MIN;
  const stuck = decide([...answered, loopLag(noProgress - MIN, NEXT_PID)], noProgress);
  assert.deepEqual([stuck.state, stuck.action], ["STALLED", "recycle"], stuck.reason);
  assert.match(stuck.reason, /answered by the boot at 2026-11-04T12:42:00\.000Z/);

  // Without a request, the same new-generation stall is restarted in place.
  const fresh = decide([...boot(reboot, NEXT_PID), progress(BOOT), loopLag(noProgress - MIN, NEXT_PID)], noProgress);
  assert.equal(fresh.action, RESTART_IN_PLACE_ACTION, fresh.reason);
});

const scratch: string[] = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

test("W1-T11327 criterion 2: the verb writes the daemon's request and ledgers it for the next verdict", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t11327-verb-`));
  scratch.push(root);
  const stateDir = join(root, "state");
  const out: string[] = [];
  assert.equal(restartInPlaceVerb(stateDir, (line) => { out.push(line); }), 0);
  const marker = peekRestartInPlace(root);
  assert.equal(marker?.origin, "progress-watchdog", "the daemon's one-shot marker is written under the state root");
  const rows = readFileSync(join(stateDir, "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row);
  const row = rows.find((r) => r.step === RESTART_REQUESTED_STEP);
  assert.equal(row?.requested_at, marker?.requestedAt, "the ledger row names the same request");
  assert.match(out.join("\n"), /restart in place requested/);
});

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

/** Renders the launcher against a fixture host whose progress-watchdog prints `verdict` (and whose
 *  `--request-restart` succeeds unless `requestFails`), runs one tick, and reports what it did. */
function tickWith(t: TestContext, verdict: Record<string, unknown>, requestFails = false) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t11327-launcher-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state-root");
  for (const dir of ["bin", "tmp", "state-root/state/inflight", "state-root/daemon-install/deploy", "state-root/remudero/bin"]) mkdirSync(join(root, dir), { recursive: true });
  const recycled = join(root, "recycled");
  const requestArgs = join(root, "request-args");
  executable(join(state, "daemon-install/deploy/recycle-container.sh"), `printf ran > '${recycled}'`);
  executable(join(state, "remudero/bin/rmd"), [
    'if [ "$1" = progress-watchdog ]; then',
    '  case " $* " in',
    `    *" --request-restart "*) ${requestFails ? "exit 3" : `printf '%s' "$*" > '${requestArgs}'; echo 'progress-watchdog: restart in place requested at 2026-11-04T13:04:08.000Z'`} ;;`,
    `    *) echo '${JSON.stringify(verdict)}' ;;`,
    "  esac",
    "fi",
  ].join("\n"));
  executable(join(root, "bin/docker"), 'case "$1" in ps) echo fixture-container ;; inspect) echo 1 ;; esac');
  executable(join(root, "bin/findmnt"), "exit 0");
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(base)) if (key.startsWith("RMD_RECYCLE_") || key === "RMD_SELF_SYNC_DONE") delete base[key];
  Object.assign(base, { PATH: `${join(root, "bin")}:${process.env.PATH}`, TMPDIR: join(root, "tmp"), GH_TOKEN: "fixture-token" });
  const launcher = join(root, "launcher.sh");
  const revivals = join(root, "revivals");
  const rendered = spawnSync("bash", [join(REPO_ROOT, "deploy/install-host-units.sh"), "--install"], {
    encoding: "utf8",
    env: { ...base, RMD_STATE_DIR: state, RMD_UNIT_DIR: join(root, "units"), RMD_BIN_DIR: join(root, "unitbin"), RMD_LAUNCHER_PATH: launcher,
      RMD_REVIVAL_LOG: revivals, RMD_NODE_MAX_OLD_SPACE_MB: "8192" },
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  const tick = spawnSync("bash", [launcher], { encoding: "utf8", timeout: 60_000, env: base });
  assert.equal(tick.status, 0, tick.stdout + tick.stderr);
  return {
    recycled: existsSync(recycled),
    requestArgs: existsSync(requestArgs) ? readFileSync(requestArgs, "utf8") : undefined,
    revivals: existsSync(revivals) ? readFileSync(revivals, "utf8") : "",
    output: tick.stdout + tick.stderr,
    stateDir: join(state, "state"),
  };
}

test("W1-T11327 criterion 2: the launcher writes the request instead of recycling, and recycles when it cannot", (t) => {
  const asked = tickWith(t, { state: "STALLED", action: "restart-in-place", progressAgeMs: 2_595_011 });
  assert.equal(asked.recycled, false, `a restart-in-place tick runs no recycle\n${asked.output}`);
  assert.equal(asked.requestArgs, `progress-watchdog --request-restart --state-root ${asked.stateDir}`, asked.output);
  assert.match(asked.revivals, /watchdog-restart-in-place state=STALLED progress-watchdog: restart in place requested at 2026-11-04T13:04:08\.000Z/);

  const failed = tickWith(t, { state: "STALLED", action: "restart-in-place", progressAgeMs: 2_595_011 }, true);
  assert.equal(failed.recycled, true, `an unwritten request falls back to this tick's recycle\n${failed.output}`);

  const recycle = tickWith(t, { state: "STALLED", action: "recycle", progressAgeMs: 2_595_011 });
  assert.equal(recycle.requestArgs, undefined, "a recycle verdict writes no request");
  assert.equal(recycle.recycled, true);
});
