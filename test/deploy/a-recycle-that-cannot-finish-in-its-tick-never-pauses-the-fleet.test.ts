import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { realDeployDeps, runDeployCycle, type DeployDeps, type RefusalStreak } from "#src/lib/deployer.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// OBSERVED 2026-11-08 to 2026-11-11 on the core instance: four recycles paused the instance and were ended
// by the TERM of the watchdog tick about 3,580 s after they began. Their derived waits were 3,816 to 8,037 s.

const MIN = 60_000;
const STEP = "deploy.recycle_wait_fit";
/** The fixture's run in flight is 600 s old; of 20 observed runs of 20 to 39 minutes its remainder is 1,680 s. */
const DERIVED_WAIT_S = 1680;
/** No `recycle.ended` row in the fixture ledger: the deployer's named constant applies. */
const REST_FALLBACK_S = 760;

interface Fixture {
  root: string;
  ledger: string;
  pause: string;
  rows: Array<{ step: string; data: Record<string, unknown> }>;
  scripts: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }>;
  real: DeployDeps;
  restart(): void;
  fitRow(): Record<string, unknown> | undefined;
}

/** A state root with run history and, unless `idle`, one run in flight. The fake script runner stands in
 *  for `deploy/recycle-container.sh`: it records its call and writes the pause file, as the script does. */
function fixture(t: TestContext, opts: { idle?: boolean; ledgerRows?: Record<string, unknown>[] } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}wait-fit-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state", "inflight"), { recursive: true });
  mkdirSync(join(root, "deploy"), { recursive: true });
  writeFileSync(join(root, "deploy", "recycle-container.sh"), "#!/usr/bin/env bash\n");
  const ledger = join(root, "state", "ledger.ndjson");
  const runs: Record<string, unknown>[] = Array.from({ length: 20 }, (_, i) => ({ step: "implement.done", worker_duration_ms: (20 + i) * MIN }));
  writeFileSync(ledger, [...runs, ...(opts.ledgerRows ?? [])].map((row) => JSON.stringify(row)).join("\n") + "\n");
  if (opts.idle !== true) {
    writeFileSync(
      join(root, "state", "inflight", "W1-T9001.lock"),
      JSON.stringify({ pid: 1, run_id: "run-9001", host: "h", startedAt: new Date(Date.now() - 600_000).toISOString() }),
    );
  }
  const pause = join(root, "state", "PAUSE");
  const rows: Fixture["rows"] = [];
  const scripts: Fixture["scripts"] = [];
  const real = realDeployDeps({
    installPath: root,
    stateRoot: root,
    daemonLabel: "com.remudero.daemon",
    serveLabel: "com.remudero.serve",
    servePort: 4317,
    uid: 501,
    ledgerPath: ledger,
    log: (step, data) => rows.push({ step, data: data ?? {} }),
    sleep: () => {},
    execFile: (cmd, args, options) => {
      if (cmd === "launchctl") throw Object.assign(new Error("spawnSync launchctl ENOENT"), { code: "ENOENT" });
      if (cmd === "bash") {
        scripts.push({ args, env: options?.env });
        writeFileSync(pause, "recycle\n");
      }
      return "";
    },
  });
  return {
    root, ledger, pause, rows, scripts, real,
    restart: () => real.restartBackends!().find((b) => b.name === "recycle-container")!.restart(),
    fitRow: () => rows.filter((r) => r.step === STEP).at(-1)?.data,
  };
}

/** Set or remove the two environment names for one test, and put the old values back after it. */
function environment(t: TestContext, values: { stepEndsAt?: string; wait?: string }): void {
  const names = { RMD_DEPLOY_STEP_ENDS_AT: values.stepEndsAt, RMD_RECYCLE_WAIT_S: values.wait };
  for (const [name, value] of Object.entries(names)) {
    const before = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
  }
}

const endsIn = (seconds: number): string => String(Math.floor(Date.now() / 1000) + seconds);

/** The step of the deploy cycle around the shipped backend: a busy instance whose idle wait is past its limit. */
function cycle(f: Fixture) {
  let streak: RefusalStreak | undefined;
  let clock = Date.parse("2026-11-11T08:00:00Z");
  const alerts: string[] = [];
  const deps = {
    log: (step: string, data: Record<string, unknown> = {}) => f.rows.push({ step, data }),
    now: () => (clock += 60 * MIN),
    fetch: () => {},
    installHead: () => "oldhead",
    runningHead: () => "oldhead",
    originMain: () => "newhead",
    markerPresent: () => true,
    autoMode: () => false,
    lastFailedHead: () => undefined,
    dirtyFiles: () => [],
    incomingFiles: () => [],
    pullFf: () => {},
    resetHard: () => {},
    probeIdle: () => ({ workers: 1, inflightLocks: 1, worktreeLocks: 1 }),
    deferredSince: () => 0,
    kickstart: () => {},
    restartBackends: () => f.real.restartBackends!(),
    waitBootHealth: () => ({ bootObserved: true, crashCount: 0 }),
    alert: (message: string) => alerts.push(message),
    clearMarker: () => {},
    clearFailure: () => {},
    imageBakedCommitsBehind: () => 3,
    refusalInstance: () => "core",
    refusalStreak: () => streak,
    setRefusalStreak: (s: RefusalStreak | undefined) => {
      streak = s;
    },
    escalateRefusal: () => "https://example.invalid/issues/1",
  } as unknown as DeployDeps;
  return { run: () => runDeployCycle(deps), alerts, streak: () => streak };
}

test("W1-T12247 criterion 1: each derived wait gets one row with the wait, the time left, the time outside the wait and the answer", (t) => {
  const f = fixture(t);
  environment(t, { stepEndsAt: endsIn(3600) });
  f.restart();
  assert.equal(f.rows.filter((r) => r.step === "deploy.recycle_wait_derived").length, 1);
  assert.equal(f.rows.filter((r) => r.step === STEP).length, 1);
  const row = f.fitRow()!;
  assert.equal(row.wait_s, DERIVED_WAIT_S);
  assert.equal(row.wait_source, "derived");
  assert.equal(row.runs_in_flight, 1);
  assert.equal(row.counted_wait_s, DERIVED_WAIT_S);
  assert.equal(row.rest_s, REST_FALLBACK_S);
  assert.equal(row.rest_source, "fallback");
  assert.equal(row.limit, "known");
  assert.ok(Number(row.step_left_s) <= 3600 && Number(row.step_left_s) >= 3590, `step_left_s was ${String(row.step_left_s)}`);
  assert.equal(row.step_ends_at_s, Number(process.env.RMD_DEPLOY_STEP_ENDS_AT));
  assert.equal(row.fits, true);
});

test("W1-T12247 criterion 2: a forced recycle that does not fit runs no script and writes no pause file", (t) => {
  const f = fixture(t);
  environment(t, { stepEndsAt: endsIn(2000) });
  const c = cycle(f);
  const result = c.run();
  assert.ok(f.rows.some((r) => r.step === "deploy.idle_ceiling_forced"), "the cycle reached the restart through the idle limit");
  assert.equal(f.fitRow()?.fits, false);
  assert.equal(f.scripts.length, 0, "the script runner was never called");
  assert.equal(existsSync(f.pause), false, "no pause file exists");
  assert.equal(result.deployed, false);
  // W1-T12294: a recycle that does not fit is deferred to a later tick, not refused.
  assert.match(result.reason, /^restart-deferred-fit: recycle not started: it does not fit the deploy step/);
  assert.match(result.reason, new RegExp(`wait is ${DERIVED_WAIT_S} s`));
  assert.match(result.reason, /step ends in \d+ s/);
  assert.equal(f.rows.some((r) => r.step === "deploy.restart_refused"), false);
  assert.equal(c.alerts.length, 0);
});

test("W1-T12247 criterion 3: a recycle that fits runs the script with the derived wait", (t) => {
  const f = fixture(t);
  environment(t, { stepEndsAt: endsIn(3600) });
  const result = cycle(f).run();
  assert.equal(result.deployed, true);
  assert.equal(f.fitRow()?.fits, true);
  assert.equal(f.scripts.length, 1);
  const args = f.scripts[0]!.args;
  assert.equal(args[0], "-c");
  assert.match(args[1]!, /RMD_RECYCLE_WAIT_S:-\$1/);
  assert.equal(args[3], String(DERIVED_WAIT_S));
  assert.equal(args[4], join(f.root, "deploy", "recycle-container.sh"));
  assert.equal(f.scripts[0]!.env?.RMD_RECYCLE_CALLER, "deploy-tick");
  assert.equal(existsSync(f.pause), true, "control: the fake script runner writes the pause file when it runs");
});

test("W1-T12247 criterion 4: with no limit from the tick, or an unreadable one, the recycle runs as before and the row says unknown", (t) => {
  for (const stepEndsAt of [undefined, "soon", "", "-5", "1e3"]) {
    const f = fixture(t);
    environment(t, { stepEndsAt });
    f.restart();
    const row = f.fitRow()!;
    assert.equal(row.limit, "unknown", `limit for ${String(stepEndsAt)}`);
    assert.equal(row.step_left_s, null);
    assert.equal(row.step_ends_at_s, null);
    assert.equal(row.fits, true);
    assert.equal(row.wait_s, DERIVED_WAIT_S);
    assert.deepEqual(
      f.scripts.map((s) => s.args),
      [["-c", 'export RMD_RECYCLE_WAIT_S="${RMD_RECYCLE_WAIT_S:-$1}"; shift; exec bash "$@"', "recycle-wait", String(DERIVED_WAIT_S),
        join(f.root, "deploy", "recycle-container.sh")]],
    );
  }
  // A wait far longer than any tick still runs when the tick gave no limit.
  const f = fixture(t);
  environment(t, { wait: "90000" });
  f.restart();
  assert.equal(f.fitRow()?.wait_s, 90000);
  assert.equal(f.fitRow()?.fits, true);
  assert.equal(f.scripts.length, 1);
});

test("W1-T12247 criterion 5: a recycle that does not fit tick after tick is reported as persisting, then escalated", (t) => {
  // W1-T12294 reverses this criterion: a recycle that does not fit is deferred, so it never counts toward the
  // refusal streak and never escalates.
  const f = fixture(t);
  environment(t, { stepEndsAt: endsIn(2000) });
  const c = cycle(f);
  for (const left of [2000, 1234, 77]) {
    process.env.RMD_DEPLOY_STEP_ENDS_AT = endsIn(left);
    assert.match(c.run().reason, /^restart-deferred-fit:/);
  }
  assert.equal(f.rows.some((r) => r.step === "deploy.refusal_persisting"), false);
  assert.equal(f.rows.some((r) => r.step === "deploy.refusal_escalated"), false);
  assert.equal(c.streak(), undefined);
  assert.equal(c.alerts.length, 0);
  assert.equal(f.rows.filter((r) => r.step === STEP && r.data.fits === false).length, 3);
  assert.equal(f.scripts.length, 0);
  assert.equal(existsSync(f.pause), false);
});

test("W1-T12247 criterion 7: with no run in flight the recycle runs although the derived wait is longer than the time left", (t) => {
  const f = fixture(t, { idle: true });
  environment(t, { stepEndsAt: endsIn(1000) });
  f.restart();
  const row = f.fitRow()!;
  // No run in flight reads as one that dispatches now: the 0.95 quantile of all 20 runs, 38 minutes.
  assert.equal(row.wait_s, 38 * 60);
  assert.equal(row.runs_in_flight, 0);
  assert.equal(row.counted_wait_s, 0);
  assert.equal(row.fits, true);
  assert.equal(f.scripts.length, 1);
  assert.equal(f.scripts[0]!.args[3], String(38 * 60), "the script still gets the whole derived wait");
  // The time outside the wait still counts: a step with less time left than that is not started.
  const late = fixture(t, { idle: true });
  process.env.RMD_DEPLOY_STEP_ENDS_AT = endsIn(REST_FALLBACK_S - 100);
  assert.throws(() => late.restart(), /does not fit the deploy step/);
  assert.equal(late.scripts.length, 0);
});

test("a wait that the operator set in the environment is checked in the same way", (t) => {
  const f = fixture(t);
  environment(t, { stepEndsAt: endsIn(3600), wait: "5000" });
  assert.throws(() => f.restart(), /wait is 5000 s/);
  assert.equal(f.fitRow()?.wait_source, "environment");
  assert.equal(f.fitRow()?.fits, false);
  assert.equal(f.scripts.length, 0);
  const short = fixture(t);
  process.env.RMD_RECYCLE_WAIT_S = "300";
  short.restart();
  assert.equal(short.fitRow()?.wait_s, 300);
  assert.equal(short.fitRow()?.fits, true);
  assert.equal(short.scripts.length, 1);
});

test("the time outside the wait is the largest one the ledger shows for a recycle that replaced its container", (t) => {
  const at = (s: number): string => new Date(Date.parse("2026-11-10T20:00:00Z") + s * 1000).toISOString();
  const f = fixture(t, {
    ledgerRows: [
      { ts: at(0), run_id: "RECYCLE-11", step: "recycle.invoked" },
      { ts: at(400), run_id: "RECYCLE-11", step: "recycle.ended", outcome: "replaced", waited_s: 100 },
      { ts: at(1000), run_id: "RECYCLE-12", step: "recycle.invoked" },
      { ts: at(1900), run_id: "RECYCLE-12", step: "recycle.ended", outcome: "replaced", waited_s: 50 },
      // Not samples: one that was aborted, and one with no start row.
      { ts: at(5000), run_id: "RECYCLE-13", step: "recycle.invoked" },
      { ts: at(8600), run_id: "RECYCLE-13", step: "recycle.ended", outcome: "aborted", waited_s: 10 },
      { ts: at(9000), run_id: "RECYCLE-14", step: "recycle.ended", outcome: "replaced", waited_s: 0 },
    ],
  });
  environment(t, { stepEndsAt: endsIn(DERIVED_WAIT_S + 850 + 5) });
  f.restart();
  assert.equal(f.fitRow()?.rest_s, 850);
  assert.equal(f.fitRow()?.rest_source, "observed");
  assert.equal(f.fitRow()?.fits, true);
  const tight = fixture(t, { ledgerRows: [
    { ts: at(1000), run_id: "RECYCLE-12", step: "recycle.invoked" },
    { ts: at(1900), run_id: "RECYCLE-12", step: "recycle.ended", outcome: "replaced", waited_s: 50 },
  ] });
  process.env.RMD_DEPLOY_STEP_ENDS_AT = endsIn(DERIVED_WAIT_S + 840);
  assert.throws(() => tight.restart(), /needs 850 s outside its wait/);
});

test("an unreadable ledger counts the fallback wait of the script, and a step with room still runs", (t) => {
  const f = fixture(t);
  rmSync(f.ledger);
  environment(t, { stepEndsAt: endsIn(3600) });
  assert.throws(() => f.restart(), /wait is 3000 s/);
  assert.equal(f.fitRow()?.wait_source, "script_fallback");
  assert.equal(f.fitRow()?.runs_in_flight, null);
  process.env.RMD_DEPLOY_STEP_ENDS_AT = endsIn(4000);
  f.restart();
  assert.equal(f.scripts.length, 1);
  assert.deepEqual(f.scripts[0]!.args, [join(f.root, "deploy", "recycle-container.sh")]);
});

// ── The launcher ─────────────────────────────────────────────────────────────────────────────────

function executable(path: string, text: string): void {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/** Render the core launcher into a scratch root. Only fixture files are installed; nothing touches systemd. */
function renderedLauncher(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}wait-fit-launcher-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state-root");
  const registry = join(root, "instances.yaml");
  writeFileSync(registry, "instances:\n" + ["  core:", "    repo: remudero", `    state_dir: ${state}`,
    "    container_name: remudero-daemon", "    service_user: fixture",
    "    image: example.invalid/remudero:fixture", "    max_old_space_mb: 8192",
    "    service_name: rmd-fleet.service", "    watchdog_service_name: rmd-fleet-watchdog.service",
    "    watchdog_timer_name: rmd-fleet-watchdog.timer", `    launcher_path: ${root}/launcher`,
    `    revival_log: ${root}/revivals.log`, "    gh_app_id: 1234", "    gh_app_installation_id: 5678",
    "    gh_app_private_key_path: /home/node/.claude/fixture.pem", `    claude_dir: ${root}/claude`,
    `    codex_dir: ${root}/codex`, `    container_config_dir: ${root}/config`].join("\n") + "\n");
  const stubs = join(root, "stubs");
  for (const dir of [stubs, join(state, "state"), join(state, "remudero", "bin")]) mkdirSync(dir, { recursive: true });
  const seen = join(root, "seen");
  executable(join(stubs, "docker"), '#!/usr/bin/env bash\ncase "$1" in ps) echo fixture-daemon ;; inspect) echo 1 ;; esac\n');
  // The fixture's `timeout` only runs its command: `timeout -k 30 3600 <command>`.
  executable(join(stubs, "timeout"), '#!/usr/bin/env bash\n[ "$1" != -k ] || shift 2\nshift\nexec "$@"\n');
  executable(join(state, "remudero", "bin", "rmd"), `#!/usr/bin/env bash
case "$1" in
  progress-watchdog) echo '{"state":"PROGRESSING","action":"none"}' ;;
  deploy-run) printf '%s %s\\n' "\${RMD_DEPLOY_STEP_ENDS_AT:-absent}" "$(date +%s)" > "${seen}" ;;
esac
`);
  const env = {
    ...process.env,
    PATH: `${stubs}:${process.env.PATH ?? ""}`,
    RMD_STATE_DIR: state,
    RMD_INSTANCE_REGISTRY: registry,
    RMD_UNIT_DIR: join(root, "units"),
    RMD_BIN_DIR: join(root, "bin"),
    RMD_LAUNCHER_PATH: join(root, "launcher"),
    RMD_REVIVAL_LOG: join(root, "revivals.log"),
    RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_CASH_SECRET_DIR: join(root, "no-secrets"),
    RMD_DEPLOY_STEP_ENDS_AT: undefined,
  };
  const installed = spawnSync("bash", [join(REPO_ROOT, "deploy/install-host-units.sh"), "--install", "--instance", "core"], {
    cwd: REPO_ROOT, env, encoding: "utf8", timeout: 60_000,
  });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  return { launcher: join(root, "launcher"), env, seen };
}

test("W1-T12247 criterion 6: the rendered launcher gives the deploy step the second at which the tick ends it", (t) => {
  const h = renderedLauncher(t);
  const run = spawnSync("bash", [h.launcher], { env: h.env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(existsSync(h.seen), true, `the fake deploy step ran\n${run.stdout}\n${run.stderr}`);
  const [endsAt, sawAt] = readFileSync(h.seen, "utf8").trim().split(" ");
  assert.match(endsAt!, /^\d+$/, "the deploy step has the variable in its environment");
  const left = Number(endsAt) - Number(sawAt);
  assert.ok(left <= 3600 && left >= 3590, `the step ends 3,600 s after it began; the deploy step saw ${left} s left`);
});
