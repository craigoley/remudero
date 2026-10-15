import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  DRAIN_BLOCKERS_PREFIX,
  IMAGE_RECYCLE_FAILURE_BACKOFF_MS,
  RECYCLE_WAIT_FALLBACK_S,
  decideDeployTrigger,
  deployFailedAlertPath,
  deriveRecycleWait,
  parseDrainBlockers,
  readImplementDurationsMs,
  realDeployDeps,
  refusalReasonKey,
  runDeployCycle,
  unsettledDrainBlockers,
  type DeployDeps,
  type DrainBlocker,
  type DrainBlockerEvidence,
  type RefusalStreak,
  type TriggerInputs,
} from "../src/lib/deployer.js";

// 2026-10-11 (core daemon, live ledger): a recycle PAUSE held every lane from about 16:16Z and was refused at
// 17:08:02Z ("still in flight after 3000s"; oldest in-flight work 3292s). The next attempt came on the hour's
// back-off, whether or not the same lane was still running, and re-paused the fleet for another fixed 3000s.
// A drain-wait refusal now names its blockers and retries when they settle; the wait it asks for is read from
// the observed run lengths and the lanes' ages.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");
const NOW = Date.parse("2026-10-11T17:20:00.000Z");
const MIN = 60_000;

const tick: TriggerInputs = {
  markerPresent: false,
  autoMode: false,
  installHead: "cccccccccccccccccccccccccccccccccccccccc",
  originMain: "cccccccccccccccccccccccccccccccccccccccc",
  runningHead: "cccccccccccccccccccccccccccccccccccccccc",
  daemonAlive: true,
  stopPresent: false,
  imageDriftOnly: true,
  imageBakedCommitsBehind: 1,
  newestBakedSha: "a0548a6bd3a461b6598bb9e8580b1c92152a97ca",
  imagePublished: true,
  nowMs: NOW,
};

const LOCK_BLOCKER: DrainBlocker = { kind: "lock", task_id: "W1-T1111", run_id: "run-W1-T1111-1" };
const WORKER_BLOCKER: DrainBlocker = { kind: "worker", pid: 4242, worker_kind: "retro", args: "node run-task.ts retro W1-T2222" };
const BLOCKERS = [LOCK_BLOCKER, WORKER_BLOCKER];

/** Evidence in which both blockers are still there: the lock is held by the named run, the pid by the named command. */
const RUNNING: DrainBlockerEvidence = {
  rows: [],
  liveLocks: [{ task_id: "W1-T1111", run_id: "run-W1-T1111-1" }],
  livePidArgs: new Map([[4242, "node run-task.ts retro W1-T2222"]]),
};
/** Evidence in which the lane has a verdict and the worker's pid is gone. */
const SETTLED: DrainBlockerEvidence = {
  rows: [{ step: "verdict", run_id: "run-W1-T1111-1" }],
  liveLocks: [{ task_id: "W1-T1111", run_id: "run-W1-T1111-1" }],
  livePidArgs: new Map(),
};

function decide(failedAgoMs: number, ev: DrainBlockerEvidence, extra: Partial<TriggerInputs> = {}) {
  return decideDeployTrigger({
    ...tick,
    lastFailedAtMs: NOW - failedAgoMs,
    lastFailedDrainBlockers: BLOCKERS,
    unsettledDrainBlockers: unsettledDrainBlockers(BLOCKERS, ev),
    ...extra,
  });
}

test("W1-T8138: a refused recycle retries once its blockers settle", () => {
  // Ten minutes after the refusal, every named blocker has finished: the old back-off would decline here.
  const d = decide(10 * MIN, SETTLED);
  assert.equal(d.deploy, true, d.reason);
  assert.equal(d.recycle, "image");
  // The create-drift path reads the same evidence.
  const drift = decide(10 * MIN, SETTLED, {
    imageBakedCommitsBehind: 0,
    newestBakedSha: undefined,
    resourcePolicyDrift: [{ field: "Memory", expected: 2, actual: 1 }],
  });
  assert.equal(drift.deploy, true, drift.reason);
  assert.equal(drift.recycle, "create-drift");
  // Each way a blocker settles, on its own: a handoff row, a yield that ended the round, the lock gone, the pid gone.
  for (const settle of [
    { ...RUNNING, rows: [{ step: "run.freshness_handoff", run_id: "run-W1-T1111-1" }] },
    { ...RUNNING, rows: [{ step: "worker.recycle_yield", run_id: "run-W1-T1111-1", decision: "acted" }] },
    { ...RUNNING, liveLocks: [] },
    { ...RUNNING, liveLocks: [{ task_id: "W1-T1111", run_id: "run-W1-T1111-2" }] },
  ]) {
    assert.deepEqual(unsettledDrainBlockers([LOCK_BLOCKER], settle), []);
  }
  assert.deepEqual(unsettledDrainBlockers([WORKER_BLOCKER], { ...RUNNING, livePidArgs: new Map() }), []);
  assert.deepEqual(unsettledDrainBlockers([WORKER_BLOCKER], { ...RUNNING, livePidArgs: new Map([[4242, "sleep 1"]]) }), [], "a reused pid is not the worker");
});

test("W1-T8138: a refused recycle waits while a blocker still runs", () => {
  // Two hours after the refusal the old back-off has long expired; the lane is still there.
  const d = decide(2 * 60 * MIN, RUNNING);
  assert.equal(d.deploy, false);
  assert.match(d.reason, /lock W1-T1111 \(run run-W1-T1111-1\)/);
  assert.match(d.reason, /retro worker pid 4242/);
  // One blocker finishing is not enough.
  const half = decide(2 * 60 * MIN, { ...RUNNING, livePidArgs: new Map() });
  assert.equal(half.deploy, false);
  assert.match(half.reason, /lock W1-T1111/);
  assert.doesNotMatch(half.reason, /retro worker/);
  // An unreadable lock directory or container is UNKNOWN: still unsettled.
  assert.equal(unsettledDrainBlockers(BLOCKERS, { rows: [], liveLocks: undefined, livePidArgs: undefined }).length, 2);
  // A yield whose round end FAILED does not settle the lane.
  assert.equal(
    unsettledDrainBlockers([LOCK_BLOCKER], { ...RUNNING, rows: [{ step: "worker.recycle_yield", run_id: "run-W1-T1111-1", decision: "action_failed" }] }).length,
    1,
  );
  // And image recycles read the same evidence.
  assert.equal(decide(2 * 60 * MIN, RUNNING, { imageBakedCommitsBehind: 1 }).deploy, false);
});

test("W1-T8138: the drain wait follows observed run lengths and lane ages", () => {
  const lane = (age_s: number) => ({ task_id: "W1-T1111", run_id: "run-W1-T1111-1", age_s });
  const base = { laneLessWorkers: 0, endedRunIds: new Set<string>(), failedEndRunIds: new Set<string>() };
  const fast = deriveRecycleWait({ ...base, durationsMs: Array(20).fill(120_000), lanes: [lane(100)] });
  const slow = deriveRecycleWait({ ...base, durationsMs: Array(20).fill(5_400_000), lanes: [lane(100)] });
  assert.equal(fast.source, "observed_distribution");
  assert.equal(fast.waitS, 20);
  assert.equal(slow.waitS, 5300);
  // The same population, an older lane: only the runs at least that old count, so the remainder follows age.
  const mixed = Array(10).fill(120_000).concat(Array(10).fill(3_600_000));
  assert.equal(deriveRecycleWait({ ...base, durationsMs: mixed, lanes: [lane(60)] }).waitS, 3540);
  assert.equal(deriveRecycleWait({ ...base, durationsMs: mixed, lanes: [lane(3000)] }).waitS, 600);
  // The most demanding lane sets the wait, and each lane's inputs are reported.
  const two = deriveRecycleWait({ ...base, durationsMs: mixed, lanes: [lane(3000), lane(60)] });
  assert.equal(two.waitS, 3540);
  assert.deepEqual(two.lanes.map((l) => l.remaining_s), [600, 3540]);
  assert.equal(two.samples, 20);
  // A lane older than every observed run, and a population with no history at all, say so.
  assert.equal(deriveRecycleWait({ ...base, durationsMs: mixed, lanes: [lane(9000)] }).lanes[0].basis, "older_than_every_observed_run");
  assert.equal(deriveRecycleWait({ ...base, durationsMs: mixed, lanes: [lane(9000)] }).waitS, RECYCLE_WAIT_FALLBACK_S);
  const none = deriveRecycleWait({ ...base, durationsMs: [], lanes: [lane(100)] });
  assert.deepEqual([none.source, none.waitS, none.samples], ["no_history_fallback", RECYCLE_WAIT_FALLBACK_S, 0]);
  // A lane-less worker, or an idle fleet, is read as a run just begun.
  assert.equal(deriveRecycleWait({ ...base, durationsMs: Array(20).fill(120_000), lanes: [], laneLessWorkers: 1 }).waitS, 120);
  assert.equal(deriveRecycleWait({ ...base, durationsMs: Array(20).fill(120_000), lanes: [] }).waitS, 120);
});

test("W1-T8138: a lane whose round the watchdog ended is not waited for", () => {
  const durationsMs = Array(20).fill(3_600_000);
  const lanes = [
    { task_id: "W1-T1", run_id: "run-ended", age_s: 100 },
    { task_id: "W1-T2", run_id: "run-failed", age_s: 2000 },
  ];
  const waits = (ended: string[], failed: string[]) =>
    deriveRecycleWait({ durationsMs, lanes, laneLessWorkers: 0, endedRunIds: new Set(ended), failedEndRunIds: new Set(failed) });
  // Neither ended: the younger lane governs.
  assert.equal(waits([], []).waitS, 3500);
  // The younger lane\'s round was ended: only the other lane is waited for.
  const ended = waits(["run-ended"], []);
  assert.equal(ended.waitS, 1600);
  assert.equal(ended.lanes[0].remaining_s, 0);
  assert.equal(ended.lanes[0].basis, "round_ended");
  // A round end that FAILED is waited for, for the lane\'s own expected remainder.
  const failed = waits(["run-ended"], ["run-ended"]);
  assert.equal(failed.waitS, 3500);
  assert.equal(failed.lanes[0].basis, "round_end_failed");
  // Both ended: nothing to wait for but a run just begun.
  assert.equal(waits(["run-ended", "run-failed"], []).lanes.every((l) => l.remaining_s === 0), true);
});

test("W1-T8138: a non-drain failure keeps its back-off", () => {
  // A pull, smoke or health failure names no blockers: ten minutes in, it still backs off; after the hour it retries.
  const noBlockers = { ...tick, lastFailedAtMs: NOW - 10 * MIN };
  const held = decideDeployTrigger(noBlockers);
  assert.equal(held.deploy, false);
  assert.match(held.reason, /a deploy failed under an hour ago — the automatic image recycle backs off/);
  assert.equal(decideDeployTrigger({ ...noBlockers, lastFailedAtMs: NOW - IMAGE_RECYCLE_FAILURE_BACKOFF_MS - 1 }).deploy, true);
  // A drain refusal whose settle evidence could not be read is not trusted either.
  assert.equal(decideDeployTrigger({ ...noBlockers, lastFailedDrainBlockers: BLOCKERS }).deploy, false);
  // An empty blocker list is no evidence.
  assert.equal(decideDeployTrigger({ ...noBlockers, lastFailedDrainBlockers: [], unsettledDrainBlockers: [] }).deploy, false);
  // The create-drift recycle keeps the same wording.
  const drift = decideDeployTrigger({ ...noBlockers, imageBakedCommitsBehind: 0, resourcePolicyDrift: [{ field: "Memory", expected: 2, actual: 1 }] });
  assert.match(drift.reason, /a deploy failed under an hour ago — the automatic recycle backs off$/);
});

test("W1-T8138: the blocker list parses, and a torn or empty one names nothing", () => {
  const line = `${DRAIN_BLOCKERS_PREFIX}${JSON.stringify({ wait_s: 3000, blockers: BLOCKERS })}`;
  assert.deepEqual(parseDrainBlockers(`recycle-container: REFUSING\n${line}\nmore`), BLOCKERS);
  assert.equal(parseDrainBlockers("recycle-container: REFUSING — nothing named"), undefined);
  assert.equal(parseDrainBlockers(`${DRAIN_BLOCKERS_PREFIX}{"blockers":[`), undefined);
  assert.equal(parseDrainBlockers(`${DRAIN_BLOCKERS_PREFIX}{"blockers":[]}`), undefined);
  assert.equal(parseDrainBlockers(`${DRAIN_BLOCKERS_PREFIX}{"blockers":{}}`), undefined);
});

test("W1-T8138: the refusal escalation counts consecutive refused attempts whichever lanes it names", () => {
  const refusal = (blockers: DrainBlocker[], n: number, wait: number) =>
    [
      `recycle-container: REFUSING — ${n} lane-holding and 0 lane-less worker(s) still in flight after ${wait}s.`,
      `  W1-T${n}.lock:`,
      `${DRAIN_BLOCKERS_PREFIX}${JSON.stringify({ blockers })}`,
    ].join("\n");
  const first = refusalReasonKey(refusal([LOCK_BLOCKER], 1, 3000));
  assert.equal(refusalReasonKey(refusal([WORKER_BLOCKER, LOCK_BLOCKER], 2, 5300)), first);
  // A different refusal is a different reason, and an unlabelled one keeps its whole-text key.
  assert.notEqual(refusalReasonKey("recycle-container: pull failed"), first);

  const streaks: Array<RefusalStreak | undefined> = [undefined];
  let clock = NOW;
  const deps = {
    log: () => {},
    now: () => (clock += 10 * MIN),
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
    probeIdle: () => ({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }),
    kickstart: () => {},
    restartBackends: () => [
      {
        name: "recycle-container",
        probe: () => true,
        describe: () => "recycle-container",
        restart: () => {
          throw new Error(refusal([LOCK_BLOCKER], 1 + streaks.length, 3000 + streaks.length));
        },
      },
    ],
    waitBootHealth: () => ({ bootObserved: true, crashCount: 0 }),
    alert: (_m: string, _h: string, _k: string, named?: DrainBlocker[]) => alerts.push(named),
    clearMarker: () => {},
    kickstartConsole: () => {},
    consolePid: () => 1,
    waitConsoleUp: () => true,
    alertConsoleOnly: () => {},
    refusalInstance: () => "core",
    refusalStreak: () => streaks[streaks.length - 1],
    setRefusalStreak: (s: RefusalStreak | undefined) => {
      streaks.push(s);
    },
  } as unknown as DeployDeps;
  const alerts: Array<DrainBlocker[] | undefined> = [];
  for (let i = 0; i < 3; i++) runDeployCycle(deps, {});
  assert.deepEqual(streaks.slice(1).map((s) => s?.count), [1, 2, 3], "three refused attempts, ten minutes apart, are one streak of three");
  assert.deepEqual(alerts, [[LOCK_BLOCKER], [LOCK_BLOCKER], [LOCK_BLOCKER]], "each refusal records the blockers it named");
});

// ── The script and the supervisor, end to end ───────────────────────────────────────────────────

function writeStubs(dir: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    'rec() { printf "%s" "docker" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "$a" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"; }',
    'rec "$@"',
    'case "$1" in',
    "  image)",
    '    if [ "$2" = "inspect" ]; then',
    "      shift 2",
    '      fmt=""',
    '      if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '      case "$fmt" in',
    '        *Config.Env*) echo ""; exit 0 ;;',
    '        *) echo "sha256:PULLEDID"; exit 0 ;;',
    "      esac",
    "    fi",
    "    exit 0 ;;",
    "  inspect)",
    "    shift",
    '    fmt=""',
    '    if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '    if [ -z "$fmt" ]; then [ "${STUB_CONTAINER_EXISTS:-1}" = "1" ] && exit 0; exit 1; fi',
    '    case "$fmt" in',
    '      *Config.Image*) echo "test-registry/remudero:old"; exit 0 ;;',
    '      *Config.Env*) echo "GH_TOKEN=captured-token-value"; echo ""; exit 0 ;;',
    '      *Mounts*)',
    '        printf "%s\\t/home/node/Remudero\\ttrue\\n" "${RMD_STATE_DIR:-$HOME/rmd-state2}"',
    '        printf "%s\\t/home/node/.claude\\ttrue\\n" "${RMD_CLAUDE_DIR:-$HOME/.claude}"',
    '        codex="${RMD_CODEX_DIR:-$HOME/.codex}"; [ ! -d "$codex" ] || printf "%s\\t/home/node/.codex\\ttrue\\n" "$codex"',
    '        config="${RMD_CONTAINER_CONFIG_DIR:-$HOME/.config/remudero-container}"; [ ! -d "$config" ] || printf "%s\\t/home/node/.config/remudero\\ttrue\\n" "$config"',
    "        exit 0 ;;",
    '      *.Image}}*) echo "sha256:PULLEDID"; exit 0 ;;',
    "    esac",
    "    exit 0 ;;",
    "  pull)",
    '    echo "Status: Downloaded newer image"; exit 0 ;;',
    "  exec)",
    "    shift",
    '    while [ $# -gt 0 ] && [ "${1#-}" != "$1" ]; do shift; done',
    "    shift 2>/dev/null || true",
    '    case "$1" in',
    "      ps)",
    // A LANE-LESS "dispatch"-shaped worker (no sweep-fix-settings- in its args), present on calls
    // 1..STUB_CLEAR_AFTER_CALLS and gone afterwards — lets a single stub simulate "still running"
    // vs. "finished on its own" purely by call count, with zero real elapsed time.
    '        count_file="$STUB_REC/ps_calls"',
    '        count=0',
    '        [ -f "$count_file" ] && count="$(cat "$count_file")"',
    "        count=$((count + 1))",
    '        echo "$count" > "$count_file"',
    '        clear_after="${STUB_CLEAR_AFTER_CALLS:-999999}"',
    '        if [ "$count" -le "$clear_after" ]; then',
    '          echo "  90210     10 /usr/local/bin/claude --output-format stream-json --settings /home/node/Remudero/tmp/run-settings-W1-T2598-1787173796831.json"',
    "        fi",
    "        exit 0 ;;",
    "    esac",
    "    exit 0 ;;",
    "  stop|rm|run) exit 0 ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");

  const az = [
    "#!/usr/bin/env bash",
    'printf "%s" "az" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "$a" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"',
    "exit 0",
    "",
  ].join("\n");

  // NO-OP SLEEP — the whole point of this suite. `waited` in the script accumulates real seconds via
  // `sleep "${POLL_INTERVAL_S}"` followed by `waited=$((waited + POLL_INTERVAL_S))`; stubbing sleep
  // to return instantly lets the loop reach production-scale WAIT_SECONDS values (3000s and up)
  // without this suite actually blocking for them.
  const sleepStub = ["#!/usr/bin/env bash", "exit 0", ""].join("\n");

  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  writeFileSync(join(dir, "az"), az, { mode: 0o755 });
  writeFileSync(join(dir, "sleep"), sleepStub, { mode: 0o755 });
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "az"), 0o755);
  chmodSync(join(dir, "sleep"), 0o755);
}


function runScript(state: string, extraEnv: Record<string, string>): { status: number; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recycle-blockers-stub-`));
  const rec = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recycle-blockers-rec-`));
  const cashKeyPath = join(state, "openweight-api-key");
  writeFileSync(cashKeyPath, "fixture-durable-openweight-key\n", { mode: 0o600 });
  writeStubs(dir);
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      RMD_STATE_DIR: state,
      RMD_OPENWEIGHT_API_KEY_PATH: cashKeyPath,
      RMD_RECYCLE_FIRST_BOOT: "1",
      GH_TOKEN: "",
      GH_APP_ID: "",
      GH_APP_INSTALLATION_ID: "",
      GH_APP_PRIVATE_KEY_PATH: "",
      RMD_RECYCLE_DOCKERENV_PATH: join(tmpdir(), "recycle-blockers-test-no-such-dockerenv-marker"),
      STUB_CLEAR_AFTER_CALLS: "0",
      RMD_RECYCLE_WAIT_S: "",
      RMD_RECYCLE_WAIT_SOURCE: "",
      ...extraEnv,
    },
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}

function writeLock(state: string, taskId: string): void {
  const inflightDir = join(state, "state", "inflight");
  mkdirSync(inflightDir, { recursive: true });
  writeFileSync(
    join(inflightDir, `${taskId}.lock`),
    JSON.stringify({ pid: 1, run_id: `run-${taskId}`, host: "fixture-host-not-hex", startedAt: "2020-01-01T00:00:00Z" }),
  );
}

test("W1-T8138: the script's refusal names its blockers and where its wait came from", () => {
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recycle-blockers-state-`));
  writeLock(state, "W1-T8138-held");
  const derived = runScript(state, { RMD_RECYCLE_WAIT_S: "1", RMD_RECYCLE_POLL_S: "1", RMD_RECYCLE_WAIT_SOURCE: "observed_distribution", STUB_CLEAR_AFTER_CALLS: "999999" });
  assert.notEqual(derived.status, 0);
  assert.match(derived.stderr, /WAIT_SECONDS=1 was derived by the deploy supervisor from the observed run lengths/);
  const named = parseDrainBlockers(derived.stderr);
  assert.ok(named, `expected a blocker list in:\n${derived.stderr}`);
  assert.deepEqual(named!.find((b) => b.kind === "lock"), { kind: "lock", task_id: "W1-T8138-held", run_id: "run-W1-T8138-held" });
  const worker = named!.find((b) => b.kind === "worker");
  assert.equal(worker?.pid, 90210);
  assert.equal(worker?.worker_kind, "unknown");
  assert.match(worker?.args ?? "", /^\/usr\/local\/bin\/claude --output-format stream-json/);
  // The recorded args are the ones the supervisor compares a live pid against.
  assert.deepEqual(
    unsettledDrainBlockers([worker!], { rows: [], liveLocks: [], livePidArgs: new Map([[90210, "/usr/local/bin/claude --output-format stream-json --settings /home/node/Remudero/tmp/run-settings-W1-T2598-1787173796831.json"]]) }),
    [worker],
  );
  const wait = JSON.parse(derived.stderr.split("\n").find((l) => l.startsWith(DRAIN_BLOCKERS_PREFIX))!.slice(DRAIN_BLOCKERS_PREFIX.length)) as Record<string, unknown>;
  assert.equal(wait.wait_source, "observed_distribution");

  // With no wait from a caller the script keeps 3000s and labels it the no-history fallback; a hand override says so too.
  const fallback = runScript(state, { RMD_RECYCLE_POLL_S: "1000" });
  assert.match(fallback.stderr, /still in flight after 3000s/);
  assert.match(fallback.stderr, /source: no_history_fallback\./);
  const hand = runScript(state, { RMD_RECYCLE_WAIT_S: "1", RMD_RECYCLE_POLL_S: "1" });
  assert.match(hand.stderr, /WAIT_SECONDS=1 was sized against 115 implement\.done rows.*source: operator\./);
});

function supervisor(root: string, calls: Array<{ cmd: string; args: string[] }>, logged: Array<{ step: string; data?: Record<string, unknown> }>) {
  return realDeployDeps({
    installPath: root,
    stateRoot: root,
    daemonLabel: "com.remudero.daemon",
    serveLabel: "com.remudero.serve",
    servePort: 4317,
    uid: 501,
    ledgerPath: join(root, "ledger.ndjson"),
    log: (step, data) => {
      logged.push({ step, data });
    },
    sleep: () => {},
    instance: "core",
    execFile: (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "pgrep") return "";
      if (cmd === "docker" && args[0] === "exec") return "  4242 node run-task.ts retro W1-T2222\n";
      return "";
    },
  });
}

function row(step: string, extra: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date(NOW).toISOString(), run_id: "r", task_id: "t", step, ...extra });
}

test("W1-T8138: the supervisor hands the script a wait read from the ledger and the locks", () => {
  const saved = process.env.RMD_RECYCLE_WAIT_S;
  delete process.env.RMD_RECYCLE_WAIT_S;
  try {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recycle-wait-derive-`));
    mkdirSync(join(root, "state", "inflight"), { recursive: true });
    const started = (ageS: number) => new Date(Date.now() - ageS * 1000).toISOString();
    const lock = (task: string, run: string, ageS: number) =>
      writeFileSync(join(root, "state", "inflight", `${task}.lock`), JSON.stringify({ pid: 1, run_id: run, host: "h", startedAt: started(ageS) }));
    lock("W1-T1", "run-live", 600);
    lock("W1-T2", "run-ended", 100);
    writeFileSync(join(root, "state", "inflight", "W1-T3.lock"), "{ not json");
    const durations = Array(10).fill(0).map(() => row("implement.done", { worker_duration_ms: 1_800_000 }));
    writeFileSync(
      join(root, "state", "ledger.ndjson"),
      [
        ...durations,
        "{ torn",
        row("worker.recycle_yield", { run_id: "run-ended", decision: "acted" }),
        row("worker.quiet_judged", { run_id: "run-live", action: "none", decision: "left_alone" }),
        row("worker.quiet_judged", { run_id: "run-live", action: "end_round", decision: "action_failed" }),
        "",
      ].join("\n"),
    );
    // One rotated, gzipped sibling joins the population.
    writeFileSync(join(root, "state", "ledger.2026-10-01.ndjson.gz"), gzipSync(row("implement.done", { worker_duration_ms: 600_000 })));
    assert.equal(readImplementDurationsMs(join(root, "state", "ledger.ndjson")).length, 11);

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const logged: Array<{ step: string; data?: Record<string, unknown> }> = [];
    const backend = supervisor(root, calls, logged).restartBackends!().find((b) => b.name === "recycle-container")!;
    backend.restart();
    const run = calls.find((c) => c.cmd === "env")!;
    assert.ok(run, "the script runs under the derived wait");
    const waitS = Number(/^RMD_RECYCLE_WAIT_S=(\d+)$/.exec(run.args[0])![1]);
    // A lock that will not parse has no readable age, so it is read as a run just begun: the whole 1800s governs.
    assert.equal(waitS, 1800);
    assert.equal(run.args[1], "RMD_RECYCLE_WAIT_SOURCE=observed_distribution");
    assert.deepEqual(run.args.slice(2, 4), ["bash", join(root, "deploy", "recycle-container.sh")]);
    const derived = logged.find((l) => l.step === "deploy.recycle_wait_derived")!.data!;
    assert.equal(derived.wait_s, waitS);
    assert.equal(derived.samples, 11);
    const lanes = derived.lanes as Array<{ task_id: string; basis: string; remaining_s: number }>;
    assert.equal(lanes.find((l) => l.task_id === "W1-T2")!.basis, "round_ended");
    // run-live is 600s old on runs that mostly last 1800s: about 1200s remain, and its failed round end does not excuse it.
    const live = lanes.find((l) => l.task_id === "W1-T1")!;
    assert.equal(live.basis, "round_end_failed");
    assert.ok(live.remaining_s >= 1190 && live.remaining_s <= 1230, `remaining ${live.remaining_s}`);

    // An operator's own RMD_RECYCLE_WAIT_S is left alone: the script runs bare.
    process.env.RMD_RECYCLE_WAIT_S = "77";
    calls.length = 0;
    backend.restart();
    assert.equal(calls[0].cmd, "bash");
  } finally {
    if (saved === undefined) delete process.env.RMD_RECYCLE_WAIT_S;
    else process.env.RMD_RECYCLE_WAIT_S = saved;
  }
});

test("W1-T8138: with no run lengths on record the script runs bare and keeps its labelled fallback", () => {
  const saved = process.env.RMD_RECYCLE_WAIT_S;
  delete process.env.RMD_RECYCLE_WAIT_S;
  try {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recycle-wait-nohistory-`));
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const logged: Array<{ step: string; data?: Record<string, unknown> }> = [];
    supervisor(root, calls, logged).restartBackends!().find((b) => b.name === "recycle-container")!.restart();
    assert.equal(calls[0].cmd, "bash");
    assert.equal(logged.some((l) => l.step === "deploy.recycle_wait_derived"), false);
    assert.deepEqual(readImplementDurationsMs(join(root, "nothing.ndjson")), []);
  } finally {
    if (saved === undefined) delete process.env.RMD_RECYCLE_WAIT_S;
    else process.env.RMD_RECYCLE_WAIT_S = saved;
  }
});

test("W1-T8138: the marker keeps the named blockers and the supervisor reads them back against the ledger and the lanes", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recycle-marker-`));
  mkdirSync(join(root, "state", "inflight"), { recursive: true });
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const deps = supervisor(root, calls, []);
  assert.equal(deps.lastFailedDrainBlockers!(), undefined, "no marker, no blockers");
  deps.alert("refused", "headsha", "restart-refused", BLOCKERS);
  assert.deepEqual(JSON.parse(readFileSync(deployFailedAlertPath(root), "utf8")).drainBlockers, BLOCKERS);
  assert.deepEqual(deps.lastFailedDrainBlockers!(), BLOCKERS);
  // The lane still holds its lock and the worker\'s pid answers with its command line: both unsettled.
  writeFileSync(join(root, "state", "inflight", "W1-T1111.lock"), JSON.stringify({ pid: 1, run_id: "run-W1-T1111-1", host: "h", startedAt: "2026-10-11T00:00:00Z" }));
  assert.deepEqual(deps.unsettledDrainBlockers!(BLOCKERS), BLOCKERS);
  // A verdict row for the run settles the lane; the worker\'s pid is still there.
  writeFileSync(join(root, "state", "ledger.ndjson"), row("verdict", { run_id: "run-W1-T1111-1" }) + "\n");
  assert.deepEqual(deps.unsettledDrainBlockers!(BLOCKERS), [WORKER_BLOCKER]);
  // A later failure that names no blockers replaces them: its back-off applies.
  deps.alert("pull failed", "headsha", "restart-refused");
  assert.equal(deps.lastFailedDrainBlockers!(), undefined);
  // An unreadable container leaves a worker blocker unsettled.
  const down = realDeployDeps({
    installPath: root, stateRoot: root, daemonLabel: "d", serveLabel: "s", servePort: 1, uid: 1, ledgerPath: join(root, "ledger.ndjson"),
    log: () => {}, sleep: () => {}, instance: "core",
    execFile: () => {
      throw new Error("docker unreachable");
    },
  });
  assert.deepEqual(down.unsettledDrainBlockers!([WORKER_BLOCKER]), [WORKER_BLOCKER]);
});
