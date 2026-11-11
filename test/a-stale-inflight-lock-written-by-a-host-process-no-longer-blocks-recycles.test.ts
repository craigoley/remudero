/**
 * W1-T12316. A host-level `rmd run-task W1-T12114` (pid 3861824, host "Remudero") hung, and its
 * lock in `state/inflight/` made every image recycle wait and refuse for hours. After the process
 * was stopped the lock still counted, because nothing tested a pid that a host process wrote:
 * the recycle script asked docker only about container-shaped hosts, and the daemon in its
 * container cannot read the host's pid table.
 *
 * The rule every case below holds: a lock whose process is alive is never reclaimed, whatever
 * its age. Only host-side code (deploy/recycle-container.sh and deploy/rmd-host-cleanup.sh)
 * reclaims a lock this host wrote, and only when its pid is dead or was used again. The daemon
 * only reports. Each script is driven as the real script, with `hostname`, `docker` and `date`
 * answered from PATH shims; the only process probed alive is a `sleep` this suite starts.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sweepInflightLocksWithReceipts } from "#src/lib/benchmark-run.js";
import { buildStatusBoard, renderStatusBoardText } from "#src/lib/status-board.js";
import { fixture, run as runJanitor } from "#test/helpers/host-cleanup-fixture.js";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");
/** The host name every shimmed `hostname` answers, and the `host` a host process writes. */
const HOST = "rmd-fixture-host";
/** Above every pid_max a kernel allows, so no real process can hold it. */
const DEAD_PID = 2147483646;
const THIRTY_DAYS_S = 30 * 24 * 3600;

const DECLARED_RUNTIME_ENV_LINES = [
  "GH_TOKEN=captured-token-value",
  "RMD_RESTART_THROTTLE_S=300",
  "RMD_FRESHNESS_RESTART_MAX=100",
  "GH_APP_ID=app-id-fixture",
  "GH_APP_INSTALLATION_ID=install-id-fixture",
  "GH_APP_PRIVATE_KEY_PATH=/path/to/key.pem",
];

function hostnameShim(name = HOST): string {
  return ghShim([{ when: "", stdout: name }], { command: "hostname", kind: "t12316-hostname" }).dir;
}

/** A `date` that reads the clock 30 days ahead and passes every parse (`-d`, `-j`, `-r`) through. */
function dateShiftShim(): string {
  const real = spawnSync("sh", ["-c", "command -v date"], { encoding: "utf8" }).stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), "rmd-t12316-date-"));
  writeFileSync(join(dir, "date"), [
    "#!/bin/sh",
    `for a in "$@"; do case "$a" in -d|-j|-r|-d*) exec ${real} "$@" ;; esac; done`,
    `now=$(${real} -u +%s)`,
    `exec ${real} -d "@$((now + ${THIRTY_DAYS_S}))" "$@" 2>/dev/null || exec ${real} -r "$((now + ${THIRTY_DAYS_S}))" "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  return dir;
}

function dockerShim(state: string, claude: string): string {
  const routes: GhShimRoute[] = [
    { when: "image inspect", stdout: "sha256:PULLEDID" },
    { when: "Config.Image", stdout: "test-registry/remudero:old" },
    { when: "Config.Env", stdout: `${DECLARED_RUNTIME_ENV_LINES.join("\n")}\n` },
    { when: "Mounts", stdout: `${state}\t/home/node/Remudero\ttrue\n${claude}\t/home/node/.claude\ttrue` },
    { when: ".Image}}", stdout: "sha256:PULLEDID" },
    { when: "State.Running", exit: 1 },
    { when: "pull", stdout: "Status: Downloaded newer image" },
  ];
  return ghShim(routes, { command: "docker", kind: "t12316-docker" }).dir;
}

interface Lock { pid: number; run_id: string; host: string; startedAt: string }

function stateWithLock(taskId: string, lock: Lock): { state: string; inflight: string; lockPath: string } {
  const state = mkdtempSync(join(tmpdir(), "rmd-t12316-state-"));
  const inflight = join(state, "state", "inflight");
  mkdirSync(inflight, { recursive: true });
  const lockPath = join(inflight, `${taskId}.lock`);
  writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  return { state, inflight, lockPath };
}

function recycle(state: string, extraPath: string[] = []) {
  const claude = mkdtempSync(join(tmpdir(), "rmd-t12316-claude-"));
  const scratch = mkdtempSync(join(tmpdir(), "rmd-t12316-run-"));
  const cashKeyPath = join(scratch, "openweight-api-key");
  writeFileSync(cashKeyPath, "fixture-cash-key\n", { mode: 0o600 });
  const path = [...extraPath, hostnameShim(), dockerShim(state, claude), process.env.PATH ?? ""].join(":");
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: path,
      RMD_STATE_DIR: state,
      RMD_CLAUDE_DIR: claude,
      RMD_CODEX_DIR: join(scratch, "no-codex"),
      RMD_CONTAINER_CONFIG_DIR: join(scratch, "no-config"),
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      RMD_RECYCLE_FIRST_BOOT: "1",
      GH_TOKEN: "",
      RMD_OPENWEIGHT_API_KEY_PATH: cashKeyPath,
      RMD_RECYCLE_DOCKERENV_PATH: join(scratch, "no-such-dockerenv-marker"),
    },
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

function reclaimedEntries(inflight: string): string[] {
  const dir = join(inflight, "reclaimed");
  return existsSync(dir) ? readdirSync(dir) : [];
}

function reasonText(inflight: string): string {
  const reason = reclaimedEntries(inflight).find((e) => e.endsWith(".reason"));
  assert.ok(reason, `a .reason file sits beside the moved lock: ${reclaimedEntries(inflight).join(", ")}`);
  return readFileSync(join(inflight, "reclaimed", reason), "utf8");
}

function rowsIn(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A `sleep` this suite owns: its pid is alive and started now. */
function liveChild(): { child: ChildProcess; startedAt: string } {
  const startedAt = new Date().toISOString();
  const child = spawn("sleep", ["120"], { stdio: "ignore" });
  assert.ok(child.pid, "the live child has a pid");
  return { child, startedAt };
}

const iso = (ms: number) => new Date(ms).toISOString();

// ── the recycle script ─────────────────────────────────────────────────────────────────────────

test("W1-T12316 criterion 1: a lock this host wrote, whose pid is dead, is moved aside with a reason and the recycle goes on", () => {
  const lock = { pid: DEAD_PID, run_id: "W1-T12114-1794380024000", host: HOST, startedAt: "2026-11-11T09:13:44.000Z" };
  const { state, inflight, lockPath } = stateWithLock("W1-T12114", lock);

  const r = recycle(state);

  assert.equal(r.status, 0, `the recycle goes on: ${r.stderr}`);
  assert.equal(existsSync(lockPath), false, "the lock left inflight/");
  assert.match(r.stderr, /slot W1-T12114 run W1-T12114-1794380024000: pid 2147483646 is dead/);
  assert.match(r.stdout, /no in-flight workers — safe to proceed/);
  const moved = reclaimedEntries(inflight).find((e) => e.startsWith("W1-T12114.lock.recycle-") && !e.endsWith(".reason"));
  assert.ok(moved, "the lock is moved to inflight/reclaimed/, never deleted");
  assert.deepEqual(JSON.parse(readFileSync(join(inflight, "reclaimed", moved), "utf8")), lock);
  const reason = reasonText(inflight);
  assert.match(reason, new RegExp(`host: ${HOST}`));
  assert.match(reason, /pid-dead/);
});

test("W1-T12316 criterion 2: a lock this host wrote, whose pid is alive but started after the lock, is reclaimed with both start times", () => {
  const { child } = liveChild();
  try {
    const startedAt = iso(Date.now() - 3600_000);
    const lock = { pid: child.pid!, run_id: "W1-T12114-r2", host: HOST, startedAt };
    const { state, inflight, lockPath } = stateWithLock("W1-T12114", lock);

    const r = recycle(state);

    assert.equal(r.status, 0, `the recycle goes on: ${r.stderr}`);
    assert.equal(existsSync(lockPath), false, "a pid used again does not hold the lock");
    assert.match(r.stderr, new RegExp(`pid ${child.pid} was used again`));
    const reason = reasonText(inflight);
    assert.match(reason, /pid-reused/);
    assert.match(reason, new RegExp(`lock startedAt: ${startedAt.replace(/[.]/g, "\\.")}`));
    assert.match(reason, /process start epoch: \d{10}/);
  } finally {
    child.kill();
  }
});

test("W1-T12316 criterion 3: a lock whose process is alive with the lock's start time stays, even 30 days old, and the recycle refuses", () => {
  const { child, startedAt } = liveChild();
  try {
    const lock = { pid: child.pid!, run_id: "W1-T12114-r3", host: HOST, startedAt };
    const { state, inflight, lockPath } = stateWithLock("W1-T12114", lock);
    const old = new Date(Date.now() - THIRTY_DAYS_S * 1000);
    utimesSync(lockPath, old, old);
    const before = readFileSync(lockPath, "utf8");

    // The clock reads 30 days ahead, so the lock is 30 days old to every age the script reads.
    const r = recycle(state, [dateShiftShim()]);

    assert.notEqual(r.status, 0, "a live holder still refuses the recycle");
    assert.match(r.stderr, /REFUSING — 1 lane-holding/);
    assert.equal(readFileSync(lockPath, "utf8"), before, "the live lock stays, byte for byte");
    assert.equal(reclaimedEntries(inflight).length, 0, "nothing is moved");
    assert.equal(rowsIn(join(state, "state", "ledger.ndjson")).some((row) => row.step === "recycle.inflight_reclaimed"), false);
  } finally {
    child.kill();
  }
});

test("W1-T12316 criterion 4: each reclaim by the recycle script writes one recycle.inflight_reclaimed row", () => {
  const lock = { pid: DEAD_PID, run_id: "W1-T12114-r4", host: HOST, startedAt: "2026-11-11T09:13:44.000Z" };
  const { state } = stateWithLock("W1-T12114", lock);

  const r = recycle(state);
  assert.equal(r.status, 0, r.stderr);

  const rows = rowsIn(join(state, "state", "ledger.ndjson")).filter((row) => row.step === "recycle.inflight_reclaimed");
  assert.equal(rows.length, 1, "one row per reclaim");
  assert.equal(rows[0]!.task_id, "W1-T12114");
  assert.equal(rows[0]!.run_id, "W1-T12114-r4");
  assert.equal(rows[0]!.pid, DEAD_PID);
  assert.equal(rows[0]!.host, HOST);
  assert.equal(rows[0]!.verdict, "pid-dead");
  assert.match(String(rows[0]!.evidence), /pid 2147483646 is dead/);
});

test("W1-T12316: a lock of another named host still refuses the recycle and is never tested", () => {
  const { state, lockPath } = stateWithLock("W1-T900", { pid: DEAD_PID, run_id: "W1-T900-r", host: "prod-box-3", startedAt: "2026-08-18T22:00:00Z" });
  const r = recycle(state);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /REFUSING — 1 lane-holding/);
  assert.ok(existsSync(lockPath));
});

// ── the daemon: report only ────────────────────────────────────────────────────────────────────

/** A state dir with one host-written lock and a ledger: another run's closed 1 h gap is the bound. */
function daemonState(lockRunRows: number[], extraRows: Array<Record<string, unknown>> = [], otherGapMs = 3600_000) {
  const now = Date.now();
  const root = mkdtempSync(join(tmpdir(), "rmd-t12316-daemon-"));
  const stateDir = join(root, "state");
  const inflight = join(stateDir, "inflight");
  mkdirSync(inflight, { recursive: true });
  // A host name no test machine carries: the daemon never tests this pid, whatever it is.
  const lock = { pid: DEAD_PID, run_id: "W1-T12114-1794380024000", host: "rmd-host-process-fixture", startedAt: iso(now - 6 * 3600_000) };
  const lockPath = join(inflight, "W1-T12114.lock");
  writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  const rows: Array<Record<string, unknown>> = [
    ...lockRunRows.map((ago) => ({ ts: iso(now - ago), run_id: lock.run_id, task_id: "W1-T12114", step: "implement.preopen_gate" })),
    ...(otherGapMs > 0
      ? [{ ts: iso(now - 5 * 3600_000), run_id: "W1-T1-r", task_id: "W1-T1", step: "worker.state" },
         { ts: iso(now - 5 * 3600_000 + otherGapMs), run_id: "W1-T1-r", task_id: "W1-T1", step: "worker.state" }]
      : [{ ts: iso(now - 5 * 3600_000), run_id: "W1-T1-r", task_id: "W1-T1", step: "worker.state" }]),
    ...extraRows,
  ];
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { root, inflight, lockPath, ledgerPath, lock, now };
}

const silentRows = (ledgerPath: string) => rowsIn(ledgerPath).filter((r) => r.step === "daemon.inflight_host_lock_silent");

test("W1-T12316 criterion 5: the daemon's sweep reports a host-written lock silent past the bound and leaves it in place", () => {
  const f = daemonState([3.5 * 3600_000, 3 * 3600_000]);
  const before = readFileSync(f.lockPath, "utf8");

  const swept = sweepInflightLocksWithReceipts(f.inflight, f.ledgerPath);

  assert.deepEqual(swept.unverifiableForeignHost, ["W1-T12114"]);
  const rows = silentRows(f.ledgerPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.task_id, "W1-T12114");
  assert.equal(rows[0]!.run_id, f.lock.run_id);
  assert.equal(rows[0]!.newest_row_ts, iso(f.now - 3 * 3600_000));
  assert.equal(rows[0]!.bound_ms, 3600_000);
  assert.equal(rows[0]!.bound_source, "observed_quiet_gaps");
  assert.equal(typeof rows[0]!.bound_samples, "number");
  assert.equal(readFileSync(f.lockPath, "utf8"), before, "the lock stays, byte for byte");
  assert.equal(existsSync(join(f.inflight, "reclaimed")), false, "nothing is written to inflight/reclaimed/");
});

test("W1-T12316 criterion 6: at most one row per bound of silence, and a run that wrote inside the bound gets none", () => {
  const f = daemonState([3.5 * 3600_000, 3 * 3600_000]);
  sweepInflightLocksWithReceipts(f.inflight, f.ledgerPath);
  sweepInflightLocksWithReceipts(f.inflight, f.ledgerPath);
  assert.equal(silentRows(f.ledgerPath).length, 1, "a second poll inside the bound writes no row");

  // One more bound of silence has passed since the first report: the next row is due.
  const rows = rowsIn(f.ledgerPath).map((r) =>
    r.step === "daemon.inflight_host_lock_silent" ? { ...r, ts: iso(f.now - 3600_000 - 60_000) } : r);
  writeFileSync(f.ledgerPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  sweepInflightLocksWithReceipts(f.inflight, f.ledgerPath);
  assert.equal(silentRows(f.ledgerPath).length, 2, "one more bound of silence writes one more row");

  const busy = daemonState([5.5 * 3600_000, 10 * 60_000]);
  const swept = sweepInflightLocksWithReceipts(busy.inflight, busy.ledgerPath);
  assert.equal(silentRows(busy.ledgerPath).length, 0, "a run that wrote inside the bound is not silent");
  assert.deepEqual(swept.unverifiableForeignHost, ["W1-T12114"]);
  assert.ok(existsSync(busy.lockPath));
});

test("W1-T12316 criterion 7: with no closed quiet gap in the window the daemon writes no row and keeps the lock", () => {
  const f = daemonState([], [], 0);
  const old = { ...f.lock, startedAt: iso(f.now - THIRTY_DAYS_S * 1000) };
  writeFileSync(f.lockPath, JSON.stringify(old, null, 2));

  const swept = sweepInflightLocksWithReceipts(f.inflight, f.ledgerPath);

  assert.equal(silentRows(f.ledgerPath).length, 0, "no fixed time stands in for the measured bound");
  assert.deepEqual(swept.unverifiableForeignHost, ["W1-T12114"]);
  assert.ok(existsSync(f.lockPath));
});

// ── rmd status ─────────────────────────────────────────────────────────────────────────────────

test("W1-T12316 criterion 8: rmd status shows a silent host-written lock as a host_lock_silent blocker", () => {
  const f = daemonState([3.5 * 3600_000, 3 * 3600_000]);
  const model = buildStatusBoard(f.root, f.ledgerPath, {
    queryService: () => ({ running: false, pid: null }),
    repoDir: join(f.root, "no-repo"),
    resolveOriginMainSha: () => undefined,
    readPushedRunBranches: () => "",
    readSharedPauseState: () => "absent",
    readDispatchClaims: () => ({ status: "clear" }),
  });

  const row = model.blockers.rows.find((r) => r.kind === "host_lock_silent");
  assert.ok(row && row.kind === "host_lock_silent", JSON.stringify(model.blockers.rows));
  assert.equal(row.taskId, "W1-T12114");
  assert.equal(row.runId, f.lock.run_id);
  assert.ok(row.silentMs >= 3 * 3600_000 && row.silentMs < 4 * 3600_000, String(row.silentMs));
  assert.equal(row.boundMs, 3600_000);
  assert.match(renderStatusBoardText(model), /host_lock_silent: W1-T12114 run W1-T12114-1794380024000 — silent 3h/);
});

// ── the host janitor ───────────────────────────────────────────────────────────────────────────

function janitorWithLock(lock: Lock) {
  const fx = fixture();
  const inflight = join(fx.home, "rmd-state2", "state", "inflight");
  mkdirSync(inflight, { recursive: true });
  const lockPath = join(inflight, "W1-T12114.lock");
  writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  return { fx, inflight, lockPath, ledgerPath: join(fx.home, "rmd-state2", "state", "ledger.ndjson") };
}

test("W1-T12316 criterion 9: the janitor reclaims a dead or reused lock of its own host in its six-hour and hourly passes", () => {
  for (const onlyTmp of ["0", "1"]) {
    const j = janitorWithLock({ pid: DEAD_PID, run_id: `W1-T12114-r9-${onlyTmp}`, host: HOST, startedAt: "2026-11-11T09:13:44.000Z" });
    const r = runJanitor(j.fx, { RMD_CLEANUP_ONLY_TMP: onlyTmp, PATH: `${hostnameShim()}:${process.env.PATH ?? ""}` });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(j.lockPath), false, `pass ONLY_TMP=${onlyTmp} reclaims: ${r.stdout}`);
    assert.ok(reclaimedEntries(j.inflight).some((e) => e.startsWith("W1-T12114.lock.host-cleanup-") && !e.endsWith(".reason")));
    assert.match(reasonText(j.inflight), /lock owner uid: \d+/);
    const rows = rowsIn(j.ledgerPath).filter((row) => row.step === "host_cleanup.inflight_reclaimed");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.task_id, "W1-T12114");
    assert.equal(rows[0]!.verdict, "pid-dead");
  }

  const { child } = liveChild();
  try {
    const j = janitorWithLock({ pid: child.pid!, run_id: "W1-T12114-r9", host: HOST, startedAt: iso(Date.now() - 3600_000) });
    const r = runJanitor(j.fx, { RMD_CLEANUP_ONLY_TMP: "1", PATH: `${hostnameShim()}:${process.env.PATH ?? ""}` });
    assert.equal(existsSync(j.lockPath), false, r.stdout);
    assert.match(reasonText(j.inflight), /verdict: pid-reused/);
  } finally {
    child.kill();
  }
});

test("W1-T12316 criterion 10: the janitor keeps a live lock whatever its age and any other host's lock; DRY_RUN=1 moves nothing", () => {
  const { child, startedAt } = liveChild();
  try {
    const live = janitorWithLock({ pid: child.pid!, run_id: "W1-T12114-r10", host: HOST, startedAt });
    const old = new Date(Date.now() - THIRTY_DAYS_S * 1000);
    utimesSync(live.lockPath, old, old);
    const before = readFileSync(live.lockPath, "utf8");
    const r = runJanitor(live.fx, { PATH: `${dateShiftShim()}:${hostnameShim()}:${process.env.PATH ?? ""}` });
    assert.equal(readFileSync(live.lockPath, "utf8"), before, `a live lock stays: ${r.stdout}`);
    assert.equal(reclaimedEntries(live.inflight).length, 0);
  } finally {
    child.kill();
  }

  const other = janitorWithLock({ pid: DEAD_PID, run_id: "W1-T12114-r10b", host: "prod-box-3", startedAt: "2026-11-11T09:13:44.000Z" });
  const kept = runJanitor(other.fx, { PATH: `${hostnameShim()}:${process.env.PATH ?? ""}` });
  assert.ok(existsSync(other.lockPath), kept.stdout);
  assert.match(kept.stdout, /KEEP .*W1-T12114\.lock: written on host prod-box-3, not this host/);

  const dry = janitorWithLock({ pid: DEAD_PID, run_id: "W1-T12114-r10c", host: HOST, startedAt: "2026-11-11T09:13:44.000Z" });
  const r = runJanitor(dry.fx, { DRY_RUN: "1", PATH: `${hostnameShim()}:${process.env.PATH ?? ""}` });
  assert.match(r.stdout, /DRYRUN would: reclaim lock .*W1-T12114\.lock \(slot W1-T12114, run W1-T12114-r10c\)/);
  assert.ok(existsSync(dry.lockPath), "a dry run moves nothing");
  assert.equal(reclaimedEntries(dry.inflight).length, 0);
  assert.equal(rowsIn(dry.ledgerPath).length, 0, "a dry run writes no row");
});
