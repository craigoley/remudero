import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { realDeployDeps, runDeployCycle, type DeployDeps, type DeployResult, type RefusalStreak } from "#src/lib/deployer.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// W1-T12294. A recycle that does not fit its deploy step waits for a tick at which it fits. The fixture is the
// one of W1-T12247: 20 observed runs of 20 to 39 minutes and one run in flight that is 600 s old.

const MIN = 60_000;
/** The run in flight is 600 s old; of the 20 observed runs its remainder is 1,680 s. */
const DERIVED_WAIT_S = 1680;
/** No `recycle.ended` row in the fixture ledger: the deployer's named constant applies. */
const REST_FALLBACK_S = 760;
/** The longest observed run (39 minutes) plus the time outside the wait. */
const OBSERVED_BOUND_S = 39 * 60 + REST_FALLBACK_S;
const HANDOFF_SHELL = 'export RMD_RECYCLE_WAIT_S="$1"; shift; exec bash "$@"';

interface Row {
  step: string;
  data: Record<string, unknown>;
}

interface Harness {
  root: string;
  script: string;
  rows: Row[];
  scripts: string[][];
  alerts: string[];
  escalations: number;
  /** A new `realDeployDeps` object on the same state directory, as a new tick's process makes. */
  real(): DeployDeps;
  /** Make the fake script runner refuse, as `deploy/recycle-container.sh` does when workers remain. */
  refuse(message: string | undefined): void;
  endRuns(): void;
  rowsOf(step: string): Array<Record<string, unknown>>;
  file(name: string): string;
}

function harness(t: TestContext, opts: { history?: boolean; ledgerRows?: Record<string, unknown>[] } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fit-deferral-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state", "inflight"), { recursive: true });
  mkdirSync(join(root, "deploy"), { recursive: true });
  const script = join(root, "deploy", "recycle-container.sh");
  writeFileSync(script, "#!/usr/bin/env bash\n");
  const ledger = join(root, "state", "ledger.ndjson");
  const runs = opts.history === false
    ? []
    : Array.from({ length: 20 }, (_, i) => ({ step: "implement.done", worker_duration_ms: (20 + i) * MIN }));
  writeFileSync(ledger, [{ step: "boot" }, ...runs, ...(opts.ledgerRows ?? [])].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const lock = join(root, "state", "inflight", "W1-T9001.lock");
  writeFileSync(lock, JSON.stringify({ pid: 1, run_id: "run-9001", host: "h", startedAt: new Date(Date.now() - 600_000).toISOString() }));
  let refusal: string | undefined;
  const h: Harness = {
    root,
    script,
    rows: [],
    scripts: [],
    alerts: [],
    escalations: 0,
    real: () =>
      realDeployDeps({
        installPath: root,
        stateRoot: root,
        daemonLabel: "com.remudero.daemon",
        serveLabel: "com.remudero.serve",
        servePort: 4317,
        uid: 501,
        ledgerPath: ledger,
        log: (step, data) => h.rows.push({ step, data: data ?? {} }),
        sleep: () => {},
        escalateRefusal: () => {
          h.escalations += 1;
          return "https://example.invalid/issues/1";
        },
        execFile: (cmd, args) => {
          if (cmd === "launchctl") throw Object.assign(new Error("spawnSync launchctl ENOENT"), { code: "ENOENT" });
          if (cmd === "bash") {
            h.scripts.push(args);
            if (refusal !== undefined) throw new Error(refusal);
          }
          return "";
        },
      }),
    refuse: (message) => {
      refusal = message;
    },
    endRuns: () => unlinkSync(lock),
    rowsOf: (step) => h.rows.filter((r) => r.step === step).map((r) => r.data),
    file: (name) => join(root, "state", name),
  };
  return h;
}

function stepEndsIn(t: TestContext, seconds: number): void {
  const before = process.env.RMD_DEPLOY_STEP_ENDS_AT;
  const wait = process.env.RMD_RECYCLE_WAIT_S;
  delete process.env.RMD_RECYCLE_WAIT_S;
  process.env.RMD_DEPLOY_STEP_ENDS_AT = String(Math.floor(Date.now() / 1000) + seconds);
  t.after(() => {
    if (before === undefined) delete process.env.RMD_DEPLOY_STEP_ENDS_AT;
    else process.env.RMD_DEPLOY_STEP_ENDS_AT = before;
    if (wait !== undefined) process.env.RMD_RECYCLE_WAIT_S = wait;
  });
}

/** One watchdog tick: `runDeployCycle` over a new `realDeployDeps` object. Only the git, container and health
 *  sensors are faked; every state file, the backend and its fit check are the shipped ones. */
function tick(h: Harness, o: { fleet?: "default" | "core"; upToDate?: boolean; laterMs?: number } = {}): DeployResult {
  const real = h.real();
  if (o.fleet === "core") writeFileSync(h.file("DEPLOY_AUTO"), "");
  const deps = {
    ...real,
    now: () => Date.now() + (o.laterMs ?? 0),
    fetch: () => {},
    installHead: () => "newhead",
    runningHead: () => "newhead",
    originMain: () => "newhead",
    markerPresent: () => false,
    dirtyFiles: () => [],
    incomingFiles: () => [],
    pullFf: () => {},
    resetHard: () => {},
    probeIdle: () => ({ workers: 1, inflightLocks: 1, worktreeLocks: 1 }),
    kickstart: () => {},
    waitBootHealth: () => ({ bootObserved: true, crashCount: 0 }),
    clearMarker: () => {},
    daemonAlive: () => true,
    stopPresent: () => false,
    imageBakedCommitsBehind: () => (o.upToDate === true ? 0 : 3),
    newestBakedSha: () => "abcdef0123456789",
    imagePublished: () => true,
    imageRecycleManual: () => false,
    alert: (message: string, failedHead: string, kind: Parameters<DeployDeps["alert"]>[2]) => {
      h.alerts.push(message);
      real.alert(message, failedHead, kind);
    },
  } as unknown as DeployDeps;
  for (const absent of ["pendingChanges", "resourcePolicyDrift", "mountPlanDrift", "dispatchImageBuild", "imageBuildInFlight",
    "restartConsole", "sameAsIncoming", "discardLocal"] as const) {
    delete (deps as unknown as Record<string, unknown>)[absent];
  }
  return runDeployCycle(deps, { imageDriftOnly: true });
}

function record(h: Harness): { since_ms: number } | undefined {
  return h.real().fitDeferral?.();
}

function writeRecord(h: Harness, sinceMs: number): void {
  writeFileSync(h.file("DEPLOY_FIT_DEFERRAL"), JSON.stringify({ since_ms: sinceMs }));
}

test("W1-T12294: a recycle that does not fit is deferred and not refused", (t) => {
  const h = harness(t);
  stepEndsIn(t, 2000);
  const result = tick(h);
  assert.equal(h.rowsOf("deploy.recycle_wait_fit").at(-1)?.fits, false, "the recycle did not fit");
  assert.equal(result.deployed, false);
  assert.match(result.reason, /^restart-deferred-fit: recycle not started: it does not fit the deploy step/);
  assert.equal(result.pulledPendingRestart, true);
  assert.equal(h.alerts.length, 0, "no alert");
  assert.equal(existsSync(h.file("DEPLOY_FAILED")), false, "no DEPLOY_FAILED marker");
  assert.equal(existsSync(h.file("DEPLOY_LAST_FAILED")), false, "no DEPLOY_LAST_FAILED file");
  assert.equal(h.rowsOf("deploy.restart_refused").length, 0);
  assert.equal(h.scripts.length, 0, "no script ran, so no pause was written");
});

test("W1-T12294: a deferral never counts toward the refusal streak", (t) => {
  const h = harness(t);
  const other: RefusalStreak = { key: "pull failed: image not found", count: 2, firstAtMs: 1_000, lastAtMs: 2_000, failedHead: "oldhead" };
  writeFileSync(h.file("DEPLOY_REFUSAL_STREAK"), JSON.stringify(other));
  for (const left of [2000, 1500, 1234, 900, 77]) {
    stepEndsIn(t, left);
    assert.match(tick(h).reason, /^restart-deferred-fit:/);
  }
  assert.equal(h.rowsOf("deploy.recycle_deferred_fit").length, 5);
  assert.equal(h.rowsOf("deploy.refusal_persisting").length, 0);
  assert.equal(h.rowsOf("deploy.refusal_escalated").length, 0);
  assert.equal(h.escalations, 0, "escalateRefusal was never called");
  assert.deepEqual(h.real().refusalStreak?.(), other, "the streak of another reason is as it was");
});

test("W1-T12294: the next tick tries the recycle again with no back-off", (t) => {
  for (const fleet of ["default", "core"] as const) {
    const h = harness(t);
    stepEndsIn(t, 2000);
    assert.match(tick(h, { fleet }).reason, /^restart-deferred-fit:/, `${fleet}: first tick`);
    // Five minutes later, on the same origin/main head.
    const next = tick(h, { fleet, laterMs: 5 * MIN });
    assert.match(next.reason, /^restart-deferred-fit:/, `${fleet}: the next tick reached the recycle again`);
    assert.equal(h.rowsOf("deploy.recycle_wait_fit").length, 2, `${fleet}: the fit check ran on both ticks`);
    assert.equal(h.rowsOf("deploy.skip").length, 0, `${fleet}: no tick was held back`);
    // A tick with room runs the recycle.
    stepEndsIn(t, 3600);
    assert.equal(tick(h, { fleet, laterMs: 10 * MIN }).deployed, true, `${fleet}: the third tick recycles`);
    assert.equal(h.scripts.length, 1);
  }
});

test("W1-T12294: the recycle starts on the first tick at which it fits", (t) => {
  // The runs in flight end: no wait is counted, and the script gets the derived wait.
  const ended = harness(t);
  stepEndsIn(t, 2000);
  assert.match(tick(ended).reason, /^restart-deferred-fit:/);
  assert.match(tick(ended).reason, /^restart-deferred-fit:/);
  assert.equal(ended.scripts.length, 0);
  ended.endRuns();
  const result = tick(ended);
  assert.equal(result.deployed, true);
  assert.equal(ended.rowsOf("deploy.recycle_wait_fit").at(-1)?.fits, true);
  assert.deepEqual(ended.scripts, [["-c", 'export RMD_RECYCLE_WAIT_S="${RMD_RECYCLE_WAIT_S:-$1}"; shift; exec bash "$@"',
    "recycle-wait", String(38 * 60), ended.script]]);
  // The predicted remainder plus the time outside the wait fits the time left.
  const room = harness(t);
  stepEndsIn(t, DERIVED_WAIT_S + REST_FALLBACK_S - 10);
  assert.match(tick(room).reason, /^restart-deferred-fit:/);
  stepEndsIn(t, DERIVED_WAIT_S + REST_FALLBACK_S + 10);
  assert.equal(tick(room).deployed, true);
  assert.equal(room.scripts.length, 1);
  assert.equal(room.scripts[0]![3], String(DERIVED_WAIT_S), "the script gets the derived wait, as in W1-T12247");
});

test("W1-T12294: each deferral writes a row with deferred_since", async (t) => {
  const h = harness(t);
  for (const left of [2000, 1800, 1600]) {
    stepEndsIn(t, left);
    tick(h);
    await delay(20);
  }
  const rows = h.rowsOf("deploy.recycle_deferred_fit");
  assert.equal(rows.length, 3, "one row per deferral");
  const since = record(h)!.since_ms;
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ["bound_s", "bound_source", "counted_wait_s", "deferred_s", "deferred_since", "kind",
      "rest_s", "runs_in_flight", "step_left_s", "to"]);
    assert.equal(row.kind, "restart-deferred-fit");
    assert.equal(row.deferred_since, new Date(since).toISOString(), "the time of the first deferral, on each tick");
    assert.equal(typeof row.deferred_s, "number");
    assert.equal(row.bound_s, OBSERVED_BOUND_S);
    assert.equal(row.bound_source, "observed");
    assert.equal(row.counted_wait_s, DERIVED_WAIT_S);
    assert.equal(row.rest_s, REST_FALLBACK_S);
    assert.equal(row.runs_in_flight, 1);
  }
  assert.deepEqual(rows.map((r) => typeof r.step_left_s === "number" && r.step_left_s <= 2000), [true, true, true]);
  // A record that is older is kept, not reset: the row counts from it.
  writeRecord(h, Date.now() - 1_000_000);
  const older = record(h)!.since_ms;
  tick(h);
  const last = h.rowsOf("deploy.recycle_deferred_fit").at(-1)!;
  assert.equal(last.deferred_since, new Date(older).toISOString());
  assert.ok(Number(last.deferred_s) >= 1000 && Number(last.deferred_s) < OBSERVED_BOUND_S, `deferred_s was ${String(last.deferred_s)}`);
  assert.equal(record(h)!.since_ms, older);
});

test("W1-T12294: the bound is the longest observed run plus the time outside the wait", (t) => {
  const observed = harness(t);
  stepEndsIn(t, 2000);
  tick(observed);
  assert.equal(observed.rowsOf("deploy.recycle_deferred_fit")[0]!.bound_s, OBSERVED_BOUND_S);
  assert.equal(observed.rowsOf("deploy.recycle_deferred_fit")[0]!.bound_source, "observed");
  // The time outside the wait comes from the ledger when it shows a recycle that replaced its container.
  const at = (s: number): string => new Date(Date.parse("2026-11-10T20:00:00Z") + s * 1000).toISOString();
  const rest = harness(t, { ledgerRows: [
    { ts: at(0), run_id: "RECYCLE-12", step: "recycle.invoked" },
    { ts: at(900), run_id: "RECYCLE-12", step: "recycle.ended", outcome: "replaced", waited_s: 50 },
  ] });
  tick(rest);
  assert.equal(rest.rowsOf("deploy.recycle_deferred_fit")[0]!.bound_s, 39 * 60 + 850);
  assert.equal(rest.rowsOf("deploy.recycle_deferred_fit")[0]!.rest_s, 850);
  // With no run history: the script fallback wait plus the time outside the wait.
  const none = harness(t, { history: false });
  tick(none);
  const row = none.rowsOf("deploy.recycle_deferred_fit")[0]!;
  assert.equal(row.bound_s, 3000 + REST_FALLBACK_S);
  assert.equal(row.bound_source, "no_history_fallback");
});

test("W1-T12294: past the bound the recycle takes a drain handoff with the wait the step allows", (t) => {
  const h = harness(t);
  stepEndsIn(t, 2000);
  // Within the bound: deferred, no script.
  writeRecord(h, Date.now() - (OBSERVED_BOUND_S - 100) * 1000);
  assert.match(tick(h).reason, /^restart-deferred-fit:/);
  assert.equal(h.scripts.length, 0);
  // Past the bound: the script runs with the time the step has left less the time outside the wait.
  const since = Date.now() - (OBSERVED_BOUND_S + 100) * 1000;
  writeRecord(h, since);
  const result = tick(h);
  assert.equal(result.deployed, true);
  const handoff = h.rowsOf("deploy.recycle_bounded_handoff");
  assert.equal(handoff.length, 1);
  const wait = Number(handoff[0]!.wait_s);
  assert.equal(handoff[0]!.rest_s, REST_FALLBACK_S);
  assert.equal(handoff[0]!.bound_s, OBSERVED_BOUND_S);
  assert.equal(handoff[0]!.deferred_since, new Date(since).toISOString());
  assert.equal(wait, Number(handoff[0]!.step_left_s) - REST_FALLBACK_S);
  assert.ok(wait + REST_FALLBACK_S <= Number(handoff[0]!.step_left_s) && wait > 1200 && wait < DERIVED_WAIT_S, `wait_s was ${wait}`);
  assert.deepEqual(h.scripts, [["-c", HANDOFF_SHELL, "recycle-wait", String(wait), h.script]]);
  // A step with no time left for a wait defers again.
  const late = harness(t);
  stepEndsIn(t, REST_FALLBACK_S + 3);
  writeRecord(late, since);
  assert.match(tick(late).reason, /^restart-deferred-fit:/);
  assert.equal(late.scripts.length, 0);
  assert.equal(late.rowsOf("deploy.recycle_bounded_handoff").length, 0);
});

test("W1-T12294: a refusal of the bounded handoff takes the existing refusal path", (t) => {
  const h = harness(t);
  stepEndsIn(t, 2000);
  const since = Date.now() - (OBSERVED_BOUND_S + 100) * 1000;
  writeRecord(h, since);
  h.refuse("recycle refused: 1 worker(s) still running after the wait");
  const result = tick(h);
  assert.match(result.reason, /^restart-refused: recycle refused: 1 worker/);
  assert.equal(h.rowsOf("deploy.restart_refused").length, 1);
  assert.equal(h.alerts.length, 1);
  assert.equal((JSON.parse(readFileSync(h.file("DEPLOY_FAILED"), "utf8")) as { kind?: string }).kind, "restart-refused");
  assert.equal(h.real().refusalStreak?.()?.count, 1, "the refusal counts toward the streak");
  assert.equal(h.rowsOf("deploy.recycle_deferred_fit").length, 0);
  assert.equal(record(h)?.since_ms, since, "the deferral record stays");
  // The next attempt is again a bounded drain handoff.
  h.refuse(undefined);
  h.real().restartBackends!().find((b) => b.name === "recycle-container")!.restart();
  assert.equal(h.rowsOf("deploy.recycle_bounded_handoff").length, 2);
  assert.equal(h.scripts.length, 2);
  assert.equal(h.scripts[1]![1], HANDOFF_SHELL);
});

test("W1-T12294: a verified recycle ends the deferral", async (t) => {
  const h = harness(t);
  stepEndsIn(t, 2000);
  tick(h);
  const first = h.rowsOf("deploy.recycle_deferred_fit")[0]!.deferred_since;
  assert.equal(existsSync(h.file("DEPLOY_FIT_DEFERRAL")), true);
  stepEndsIn(t, 3600);
  assert.equal(tick(h).deployed, true);
  assert.ok(h.rows.some((r) => r.step === "deploy.ok"));
  assert.equal(existsSync(h.file("DEPLOY_FIT_DEFERRAL")), false, "a verified recycle clears the record");
  await delay(20);
  stepEndsIn(t, 2000);
  tick(h);
  const second = h.rowsOf("deploy.recycle_deferred_fit")[1]!.deferred_since;
  assert.ok(String(second) > String(first), `a new deferral has a new deferred_since (${String(first)}, ${String(second)})`);
  // A skip that finds the daemon up to date ends it too.
  const skip = tick(h, { upToDate: true });
  assert.match(skip.reason, /^up-to-date/);
  assert.equal(existsSync(h.file("DEPLOY_FIT_DEFERRAL")), false, "the up-to-date skip clears the record");
});

test("W1-T12294: the deferral record survives from one tick to the next", async (t) => {
  const h = harness(t);
  stepEndsIn(t, 2000);
  tick(h);
  const stored = JSON.parse(readFileSync(h.file("DEPLOY_FIT_DEFERRAL"), "utf8")) as { since_ms: number };
  assert.equal(typeof stored.since_ms, "number");
  await delay(20);
  // A second cycle with a new deps object reads the record back.
  tick(h);
  const rows = h.rowsOf("deploy.recycle_deferred_fit");
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.deferred_since, new Date(stored.since_ms).toISOString());
  assert.deepEqual(record(h), stored);
});
