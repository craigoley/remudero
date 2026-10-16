import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  IMAGE_RECYCLE_FAILURE_BACKOFF_MS,
  decideDeployTrigger,
  deriveDrainWait,
  parseDrainBlockers,
  readImplementDurationsMs,
  readRunSettlement,
  realDeployDeps,
  refusalReasonKey,
  runDeployCycle,
  type DeployDeps,
  type DrainBlocker,
  type DrainRefusalRecord,
  type TriggerInputs,
} from "../src/lib/deployer.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// MEASURED 2026-10-11 (core): a recycle PAUSE held every lane from ~16:16Z and was refused at 17:08:02Z, "still in
// flight after 3000s"; the drift recycle then waited a fixed hour and re-paused the fleet for another fixed 3000 s
// whether or not its blockers were still there. The retry now follows the blockers' own ledger evidence, and the
// drain wait follows the observed run lengths of the lanes in flight.

const MIN = 60_000;
const HEAD = "c".repeat(40);
const NOW = Date.parse("2026-10-11T18:00:00.000Z");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");

/** The watchdog tick: checkout current, daemon alive, the running image behind a published baked change. */
const tick: TriggerInputs = {
  markerPresent: false,
  autoMode: false,
  installHead: HEAD,
  originMain: HEAD,
  runningHead: HEAD,
  daemonAlive: true,
  stopPresent: false,
  imageDriftOnly: true,
  imageBakedCommitsBehind: 2,
  imagePublished: true,
  newestBakedSha: "d".repeat(40),
  nowMs: NOW,
};

const LOCK: DrainBlocker = { kind: "lock", taskId: "W1-T9001", runId: "run-9001", ageS: 3292 };
const REVIEW: DrainBlocker = { kind: "worker", pid: 77, workerKind: "review", ageS: 900 };

test("W1-T8138: a refused recycle retries once its blockers settle", () => {
  // Ten minutes after the refusal — far inside the old hour — with every named blocker settled.
  const retried = decideDeployTrigger({
    ...tick,
    lastFailedAtMs: NOW - 10 * MIN,
    drainRefusal: { blockers: [LOCK, REVIEW], unsettled: [] },
  });
  assert.equal(retried.deploy, true);
  assert.equal(retried.recycle, "image");
  // The same moment WITHOUT the blocker evidence is today's back-off — proving the drain path is what released it.
  const backedOff = decideDeployTrigger({ ...tick, lastFailedAtMs: NOW - 10 * MIN });
  assert.equal(backedOff.deploy, false);
  assert.match(backedOff.reason, /under an hour ago/);
});

test("W1-T8138: a refused recycle waits while a blocker still runs", () => {
  // Two hours after the refusal, past the old back-off, one lane still running: no retry, and the reason names it.
  const held = decideDeployTrigger({
    ...tick,
    lastFailedAtMs: NOW - 2 * IMAGE_RECYCLE_FAILURE_BACKOFF_MS,
    drainRefusal: { blockers: [LOCK, REVIEW], unsettled: [LOCK] },
  });
  assert.equal(held.deploy, false);
  assert.match(held.reason, /still waits on lock W1-T9001 \(run run-9001\)/);
  assert.doesNotMatch(held.reason, /review/, "a settled blocker is not named");
  // Create-drift recycles hold on the same evidence.
  const drift = decideDeployTrigger({
    ...tick,
    imageBakedCommitsBehind: 0,
    mountPlanDrift: [{ target: "/x", expected: "rw", actual: undefined }] as unknown as TriggerInputs["mountPlanDrift"],
    lastFailedAtMs: NOW - 2 * IMAGE_RECYCLE_FAILURE_BACKOFF_MS,
    drainRefusal: { blockers: [REVIEW], unsettled: [REVIEW] },
  });
  assert.equal(drift.deploy, false);
  assert.match(drift.reason, /worker pid 77 \(review\)/);
});

test("W1-T8138: the drain wait follows observed run lengths and lane ages", () => {
  const lane = [{ runId: "r1", ageS: 600 }];
  const shortRuns = Array.from({ length: 40 }, (_, i) => (10 + i) * MIN / 10); // 1..4.9 min
  const longRuns = Array.from({ length: 40 }, (_, i) => (20 + i) * MIN); // 20..59 min
  const a = deriveDrainWait(shortRuns, [{ runId: "r1", ageS: 30 }]);
  const b = deriveDrainWait(longRuns, lane);
  assert.equal(a.source, "observed");
  assert.equal(b.source, "observed");
  assert.notEqual(a.waitS, b.waitS, "two populations give two waits");
  assert.ok(b.waitS > a.waitS * 5, `long runs wait far longer (${b.waitS}s vs ${a.waitS}s)`);
  // The same population reads a younger lane as needing longer than an older one (conditioned on age).
  const young = deriveDrainWait(longRuns, [{ runId: "y", ageS: 60 }]);
  const old = deriveDrainWait(longRuns, [{ runId: "o", ageS: 50 * 60 }]);
  assert.ok(young.waitS > old.waitS);
  // Over all lanes the largest remainder decides, and each lane's input is reported.
  const both = deriveDrainWait(longRuns, [{ runId: "y", ageS: 60 }, { runId: "o", ageS: 50 * 60 }]);
  assert.equal(both.waitS, young.waitS);
  assert.equal(both.lanes.length, 2);
  assert.equal(both.samples, 40);
  // No history reads as the labelled fallback; a lane older than every observed run falls back for that lane.
  assert.deepEqual(
    { waitS: deriveDrainWait([], lane, 3000).waitS, source: deriveDrainWait([], lane, 3000).source },
    { waitS: 3000, source: "no_history_fallback" },
  );
  const beyond = deriveDrainWait(shortRuns, [{ runId: "b", ageS: 3 * 60 * 60 }], 3000);
  assert.equal(beyond.source, "observed_with_fallback_lane");
  assert.equal(beyond.waitS, 3000);
});

test("W1-T8138: a lane whose round the watchdog ended is not waited for", () => {
  const runs = Array.from({ length: 40 }, (_, i) => (20 + i) * MIN);
  const running = { runId: "r-run", ageS: 120 };
  const alone = deriveDrainWait(runs, [running]);
  const withEnded = deriveDrainWait(runs, [running, { runId: "r-ended", ageS: 1, judged: "ended" }]);
  assert.equal(withEnded.waitS, alone.waitS, "an ended lane adds nothing");
  assert.equal(withEnded.lanes.find((l) => l.run_id === "r-ended")?.basis, "ended");
  const onlyEnded = deriveDrainWait(runs, [{ runId: "r-ended", ageS: 1, judged: "ended" }]);
  assert.ok(onlyEnded.waitS < alone.waitS, "with only an ended lane there is nothing to wait for");
  // A lane whose round end FAILED is waited for its own expected remainder.
  const failed = deriveDrainWait(runs, [{ runId: "r-failed", ageS: 1, judged: "end_failed" }]);
  assert.ok(failed.waitS > alone.waitS);
  assert.equal(failed.lanes[0]!.basis, "conditioned_quantile");
  // The ledger reading that feeds this: an acted yield ends the round; a failed one does not settle the run.
  const ledger = [
    { step: "worker.recycle_yield", run_id: "a", decision: "acted" },
    { step: "worker.recycle_yield", run_id: "b", decision: "action_failed" },
    { step: "verdict", run_id: "c" },
    { step: "run.freshness_handoff", run_id: "d" },
  ].map((r) => JSON.stringify(r)).join("\n");
  const { settled, judged } = readRunSettlement(ledger);
  assert.deepEqual([...settled].sort(), ["a", "c", "d"]);
  assert.equal(judged.get("a"), "ended");
  assert.equal(judged.get("b"), "end_failed");
  assert.deepEqual(readImplementDurationsMs('{"step":"implement.done","worker_duration_ms":1500}\n{"step":"implement.done"}\nnot json'), [1500]);
});

test("W1-T8138: a non-drain failure keeps its back-off", () => {
  // A pull, smoke or health failure carries no blocker list, so no drain state reaches the decision.
  const within = decideDeployTrigger({ ...tick, lastFailedAtMs: NOW - 10 * MIN });
  assert.equal(within.deploy, false);
  assert.match(within.reason, /a deploy failed under an hour ago — the automatic image recycle backs off/);
  const after = decideDeployTrigger({ ...tick, lastFailedAtMs: NOW - IMAGE_RECYCLE_FAILURE_BACKOFF_MS - 1 });
  assert.equal(after.deploy, true);
  // A refusal whose message names no blockers parses to none, so it is not a drain refusal.
  assert.equal(parseDrainBlockers("recycle-container: smoke failed\nsmoke-output|boom"), undefined);
  assert.equal(parseDrainBlockers("recycle-blockers-json: []"), undefined);
  assert.equal(parseDrainBlockers("recycle-blockers-json: not json"), undefined);
});

test("W1-T8138: a refusal's blocker list is parsed and never splits the escalation's reason key", () => {
  const line = (blockers: string) => `REFUSING — 1 lane-holding after 3000s.\n  recycle-blockers-json: ${blockers}\n`;
  const a = line('[{"kind":"lock","task_id":"W1-T1","run_id":"r1","age_s":10},{"kind":"worker","pid":9,"age_s":5,"worker_kind":"retro"}]');
  const b = line('[{"kind":"lock","task_id":"W1-T2","run_id":"r2","age_s":99}]');
  assert.deepEqual(parseDrainBlockers(a), [
    { kind: "lock", taskId: "W1-T1", runId: "r1", ageS: 10 },
    { kind: "worker", pid: 9, workerKind: "retro", ageS: 5 },
  ]);
  assert.equal(refusalReasonKey(a), refusalReasonKey(b), "the same refusal reason across attempts counts as one streak");
});

function cycleHarness(opts: { settled: boolean | undefined }) {
  const rows: Array<{ step: string; data: Record<string, unknown> }> = [];
  let record: DrainRefusalRecord | undefined;
  let kind: "restart-refused" | undefined;
  let now = NOW;
  let refusing = true;
  const message =
    "REFUSING — 1 lane-holding and 0 lane-less worker(s) still in flight after 3000s.\n" +
    'recycle-blockers-json: [{"kind":"lock","task_id":"W1-T9001","run_id":"run-9001","age_s":3292}]';
  const deps = {
    log: (step: string, data: Record<string, unknown> = {}) => rows.push({ step, data }),
    now: () => now,
    fetch: () => {},
    installHead: () => HEAD,
    runningHead: () => HEAD,
    originMain: () => HEAD,
    markerPresent: () => false,
    autoMode: () => false,
    lastFailedHead: () => undefined,
    lastFailedKind: () => kind,
    lastFailedAtMs: () => (kind ? NOW : undefined),
    daemonAlive: () => true,
    stopPresent: () => false,
    imageBakedCommitsBehind: () => 2,
    newestBakedSha: () => "d".repeat(40),
    imagePublished: () => true,
    dirtyFiles: () => [],
    incomingFiles: () => [],
    pullFf: () => {},
    resetHard: () => {},
    probeIdle: () => ({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }),
    kickstart: () => {},
    restartBackends: () => [
      {
        name: "recycle-container",
        drainsItself: true,
        probe: () => true,
        describe: () => "recycle-container",
        restart: () => {
          if (refusing) throw new Error(message);
        },
      },
    ],
    waitBootHealth: () => ({ bootObserved: true, crashCount: 0 }),
    alert: () => {
      kind = "restart-refused";
    },
    clearMarker: () => {},
    clearFailure: () => {
      kind = undefined;
    },
    kickstartConsole: () => {},
    consolePid: () => 1,
    waitConsoleUp: () => true,
    alertConsoleOnly: () => {},
    drainRefusal: () => record,
    setDrainRefusal: (r: DrainRefusalRecord | undefined) => {
      record = r;
    },
    blockerSettled: () => opts.settled,
  } as unknown as DeployDeps;
  return {
    deps,
    rows,
    record: () => record,
    advance: (ms: number) => {
      now += ms;
    },
    stopRefusing: () => {
      refusing = false;
    },
  };
}

test("W1-T8138: the cycle records the refusal's blockers and retries only on their evidence", () => {
  const h = cycleHarness({ settled: false });
  const first = runDeployCycle(h.deps, { imageDriftOnly: true });
  assert.equal(first.deployed, false);
  assert.deepEqual(h.record()?.blockers, [{ kind: "lock", taskId: "W1-T9001", runId: "run-9001", ageS: 3292 }]);
  assert.deepEqual((h.rows.find((r) => r.step === "deploy.restart_refused")?.data.blockers as unknown[]).length, 1);
  // Two hours on, the blocker is still running (or unreadable): no second recycle attempt.
  h.advance(2 * 60 * MIN);
  const before = h.rows.filter((r) => r.step === "deploy.restart_refused").length;
  const held = runDeployCycle(h.deps, { imageDriftOnly: true });
  assert.equal(held.deployed, false);
  assert.equal(h.rows.filter((r) => r.step === "deploy.restart_refused").length, before);

  // Blockers settled ten minutes after the refusal: the very next tick retries.
  const s = cycleHarness({ settled: true });
  runDeployCycle(s.deps, { imageDriftOnly: true });
  s.advance(10 * MIN);
  s.stopRefusing();
  const retried = runDeployCycle(s.deps, { imageDriftOnly: true });
  assert.equal(retried.deployed, true);
  assert.equal(s.record(), undefined, "a verified recycle clears the blocker record");
});

// ── the REAL script and the REAL deps ───────────────────────────────────────────────────────────

/** The declared runtime names (deploy/runtime-env-vars.sh), one fixture value each, to clear the capture check. */
const RUNTIME_ENV = [
  "GH_TOKEN=captured-token-value",
  "RMD_RESTART_THROTTLE_S=300",
  "RMD_FRESHNESS_RESTART_MAX=100",
  "GH_APP_ID=app-id-fixture",
  "GH_APP_INSTALLATION_ID=install-id-fixture",
  "GH_APP_PRIVATE_KEY_PATH=/path/to/key.pem",
];

function writeDockerStub(dir: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    'case "$1" in',
    "  image) if [ \"$2\" = \"inspect\" ]; then echo sha256:PULLEDID; fi; exit 0 ;;",
    "  inspect)",
    "    shift; fmt=''; if [ \"$1\" = '--format' ]; then fmt=\"$2\"; shift 2; fi; name=\"${1:-}\"",
    "    case \"$fmt\" in",
    "      '{{.State.Running}}') [ \"$name\" = 5efb86ede91b ] && { echo true; exit 0; }; exit 1 ;;",
    "      *Config.Image*) echo test-registry/remudero:old; exit 0 ;;",
    "      *Config.Env*)",
    ...RUNTIME_ENV.map((l) => `        echo "${l}"`),
    "        exit 0 ;;",
    "      *Mounts*)",
    '        printf "%s\\t/home/node/Remudero\\ttrue\\n" "${RMD_STATE_DIR:-$HOME/rmd-state2}"',
    '        printf "%s\\t/home/node/.claude\\ttrue\\n" "${RMD_CLAUDE_DIR:-$HOME/.claude}"',
    "        exit 0 ;;",
    "      *.Image}}*) echo sha256:PULLEDID; exit 0 ;;",
    "    esac; exit 0 ;;",
    "  pull) echo 'Status: Downloaded newer image'; exit 0 ;;",
    "  exec) exit 0 ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  writeFileSync(join(dir, "az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  chmodSync(join(dir, "docker"), 0o755);
}

test("W1-T8138: the script's drain refusal names its blockers and says where its wait came from", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}blockers-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stubs = join(root, "stubs");
  const state = join(root, "state");
  mkdirSync(stubs, { recursive: true });
  mkdirSync(join(state, "state", "inflight"), { recursive: true });
  writeDockerStub(stubs);
  writeFileSync(
    join(state, "state", "inflight", "W1-T9001.lock"),
    JSON.stringify({ pid: 123, run_id: "run-9001", host: "5efb86ede91b", startedAt: "2026-10-11T16:00:00Z" }),
  );
  const keyPath = join(root, "openweight-api-key");
  writeFileSync(keyPath, "fixture-cash-key\n", { mode: 0o600 });
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      RMD_STATE_DIR: state,
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      RMD_RECYCLE_FIRST_BOOT: "1",
      GH_TOKEN: "",
      RMD_OPENWEIGHT_API_KEY_PATH: keyPath,
      RMD_RECYCLE_DOCKERENV_PATH: join(root, "no-dockerenv"),
    },
  });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /REFUSING — 1 lane-holding/);
  assert.match(r.stderr, /WAIT_SECONDS=1 — source: caller-supplied RMD_RECYCLE_WAIT_S/);
  const blockers = parseDrainBlockers(r.stderr);
  assert.equal(blockers?.length, 1);
  assert.equal(blockers![0]!.taskId, "W1-T9001");
  assert.equal(blockers![0]!.runId, "run-9001");
  assert.ok(blockers![0]!.ageS > 0);
});

test("W1-T8138: the shipped deps read a lock blocker's settling off the lock and the ledger, and a hung read holds", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}settle-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inflight = join(root, "state", "inflight");
  mkdirSync(inflight, { recursive: true });
  const ledger = join(root, "state", "ledger.ndjson");
  const calls: string[][] = [];
  const deps = realDeployDeps({
    installPath: root,
    stateRoot: root,
    daemonLabel: "com.remudero.daemon",
    serveLabel: "com.remudero.serve",
    servePort: 4317,
    uid: 501,
    ledgerPath: ledger,
    log: () => {},
    sleep: () => {},
    execFile: (_cmd, args) => {
      calls.push(args);
      return args.join(" ").includes("ps -o etimes= -p 77") ? "\ndone\n" : "1000\ndone\n";
    },
  });
  const record: DrainRefusalRecord = { atMs: NOW, toHead: HEAD, blockers: [LOCK] };
  const lockPath = join(inflight, "W1-T9001.lock");
  writeFileSync(ledger, "");
  // Lock still held by the named run, no settling row: unsettled.
  writeFileSync(lockPath, JSON.stringify({ pid: 1, run_id: "run-9001", host: "h", startedAt: "2026-10-11T16:00:00Z" }));
  assert.equal(deps.blockerSettled!(LOCK, record), false);
  // The ledger shows its verdict: settled.
  writeFileSync(ledger, JSON.stringify({ step: "verdict", run_id: "run-9001" }) + "\n");
  assert.equal(deps.blockerSettled!(LOCK, record), true);
  // The lock is gone: settled.
  writeFileSync(ledger, "");
  rmSync(lockPath);
  assert.equal(deps.blockerSettled!(LOCK, record), true);
  // A lane-less worker whose pid ps no longer shows: settled; one still older than it was: not.
  assert.equal(deps.blockerSettled!(REVIEW, record), true);
  assert.equal(deps.blockerSettled!({ ...REVIEW, pid: 78 }, record), false);
  // A younger process under a reused pid is not the blocker.
  assert.equal(deps.blockerSettled!({ ...REVIEW, pid: 78, ageS: 5000 }, record), true);
});

test("W1-T8138: the shipped deps round-trip the refusal record, report a marker that cannot be removed, and hold on unreadable evidence", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}refusal-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inflight = join(root, "state", "inflight");
  mkdirSync(inflight, { recursive: true });
  const ledger = join(root, "state", "ledger.ndjson");
  const rows: Array<{ step: string; data: Record<string, unknown> }> = [];
  const deps = realDeployDeps({
    installPath: root,
    stateRoot: root,
    daemonLabel: "com.remudero.daemon",
    serveLabel: "com.remudero.serve",
    servePort: 4317,
    uid: 501,
    ledgerPath: ledger,
    log: (step, data) => rows.push({ step, data: data ?? {} }),
    sleep: () => {},
    execFile: () => "",
  });
  const marker = join(root, "state", "DEPLOY_DRAIN_REFUSAL");

  // A stored, well-formed record reads back exactly as written; a malformed one reads as none.
  const record: DrainRefusalRecord = { atMs: NOW, toHead: HEAD, blockers: [LOCK, REVIEW] };
  deps.setDrainRefusal!(record);
  assert.deepEqual(deps.drainRefusal!(), record);
  writeFileSync(marker, JSON.stringify({ atMs: "soon", toHead: HEAD, blockers: [] }));
  assert.equal(deps.drainRefusal!(), undefined);

  // Clearing an absent marker is silent; one that cannot be removed is reported, not swallowed.
  rmSync(marker);
  deps.setDrainRefusal!(undefined);
  assert.equal(rows.some((r) => r.step === "deploy.failure_retraction_failed"), false);
  mkdirSync(join(marker, "held"), { recursive: true });
  deps.setDrainRefusal!(undefined);
  const failed = rows.find((r) => r.step === "deploy.failure_retraction_failed");
  assert.equal(failed?.data.marker, "DEPLOY_DRAIN_REFUSAL");
  assert.match(String(failed?.data.error), /EISDIR|EPERM|EACCES/);

  // A held lock whose ledger cannot be read is not proof of settling: undefined, which holds the retry.
  writeFileSync(join(inflight, "W1-T9001.lock"), JSON.stringify({ pid: 1, run_id: "run-9001", host: "h", startedAt: "2026-10-11T16:00:00Z" }));
  assert.equal(deps.blockerSettled!(LOCK, record), undefined);
});

test("W1-T8138: the shipped backend derives its wait from the ledger and passes it to the script", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}derive-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state", "inflight"), { recursive: true });
  mkdirSync(join(root, "deploy"), { recursive: true });
  writeFileSync(join(root, "deploy", "recycle-container.sh"), "#!/usr/bin/env bash\n");
  const ledger = join(root, "state", "ledger.ndjson");
  const runs = Array.from({ length: 20 }, (_, i) => JSON.stringify({ step: "implement.done", worker_duration_ms: (20 + i) * MIN }));
  writeFileSync(ledger, runs.join("\n") + "\n");
  writeFileSync(
    join(root, "state", "inflight", "W1-T9001.lock"),
    JSON.stringify({ pid: 1, run_id: "run-9001", host: "h", startedAt: new Date(Date.now() - 600_000).toISOString() }),
  );
  const rows: Array<{ step: string; data: Record<string, unknown> }> = [];
  const execs: Array<{ cmd: string; args: string[] }> = [];
  const deps = realDeployDeps({
    installPath: root,
    stateRoot: root,
    daemonLabel: "com.remudero.daemon",
    serveLabel: "com.remudero.serve",
    servePort: 4317,
    uid: 501,
    ledgerPath: ledger,
    log: (step, data) => rows.push({ step, data: data ?? {} }),
    sleep: () => {},
    execFile: (cmd, args) => {
      execs.push({ cmd, args });
      return "";
    },
  });
  const backend = deps.restartBackends!().find((b) => b.name === "recycle-container")!;
  backend.restart();
  const derived = rows.find((r) => r.step === "deploy.recycle_wait_derived");
  assert.equal(derived?.data.source, "observed");
  assert.equal(derived?.data.samples, 20);
  const call = execs.find((e) => e.cmd === "bash" && e.args[0] === "-c")!;
  assert.match(call.args[1]!, /RMD_RECYCLE_WAIT_S:-\$1/, "an operator's own RMD_RECYCLE_WAIT_S wins over the derived default");
  assert.match(call.args[3]!, /^\d+$/, "the derived wait is passed as an argument");
  assert.equal(call.args[4], join(root, "deploy", "recycle-container.sh"));
  // No history: the script keeps its labelled fallback, so no override is passed.
  writeFileSync(ledger, "");
  execs.length = 0;
  backend.restart();
  assert.equal(execs.some((e) => e.args[0] === "-c"), false);
  assert.equal(execs.at(-1)?.args[0], join(root, "deploy", "recycle-container.sh"));
  assert.equal(rows.filter((r) => r.step === "deploy.recycle_wait_derived").at(-1)?.data.source, "no_history_fallback");
  // An unreadable ledger is reported, and the fallback applies.
  rmSync(ledger);
  execs.length = 0;
  backend.restart();
  assert.ok(rows.some((r) => r.step === "deploy.recycle_wait_derive_failed"));
  assert.equal(execs.at(-1)?.args[0], join(root, "deploy", "recycle-container.sh"));
});
