// @source-text-subject: production composition and boot/dispatch ownership are source contracts.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as maintenance from "../src/lib/object-reaper.js";
import { clockFromMillisFn, fixedClock } from "../src/lib/clock.js";
import { gitRepo } from "./helpers/git-repo.js";
import { loadPlan } from "../src/lib/plan.js";
import { runDaemon } from "../src/lib/daemon.js";
import { runRepositoryMaintenanceRung } from "../src/run-task.js";

const policy = { intervalMs: 86400000, probeIntervalMs: 60000, timeoutMs: 300000,
  backoffMs: 60000, maxBackoffMs: 3600000, maxFailures: 3, maxActiveLanes: 1 };
const survey = (marker: string | null = null): maintenance.MaintenanceSurvey => ({ readable: true, looseCount: 6000,
  looseBytes: 12000, gcLog: marker, activeLanes: 0, disk: "healthy" });
const fresh = () => ({ nextEligibleAt: 0, nextSurveyAt: 0, failures: 0, escalated: false });

test("W1-T3116: boot and dispatch never start, await or survey repository maintenance", async () => {
  const source = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const rung = source.slice(source.indexOf("export async function logDiskReclaimRung("),
    source.indexOf("export function planReloader("));
  assert.doesNotMatch(rung, /reapGitObjectsAsync|activeWorkerProbes/);
  const boot = readFileSync(new URL("../deploy/entrypoint.sh", import.meta.url), "utf8");
  assert.doesNotMatch(boot, /rm -f .*gc\.log|gc --prune=now/);
  const daemon = readFileSync(new URL("../src/lib/daemon.ts", import.meta.url), "utf8");
  assert.ok(daemon.includes("scheduleRepositoryMaintenance"));
  const calls: string[] = [];
  const store = gitRepo({ kind: "maintenance-admission" });
  const planPath = join(store.dir, "tasks.yaml");
  writeFileSync(planPath, "- id: W1-T1\n  title: task\n  repo: remudero\n  type: implement\n  status: queued\n  depends_on: []\n");
  let release = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let releaseAdmission = () => {};
  const admittedPending = new Promise<void>((resolve) => { releaseAdmission = resolve; });
  await runDaemon(loadPlan(planPath), {
    refreshMerged: () => () => false,
    sweep: async () => { calls.push("reconcile"); },
    runOne: async (taskId) => { calls.push("admitted"); await admittedPending; return { taskId, runId: taskId,
      merged: true, verdict: "merged", costUsd: 0 }; },
    repositoryMaintenance: async () => { calls.push("maintenance"); releaseAdmission(); await pending; },
    sleep: async () => {}, log: () => {},
  }, { max: 1, pollIntervalMs: 1 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(calls.indexOf("admitted") >= 0);
  assert.ok(calls.indexOf("maintenance") > calls.indexOf("admitted"));
  release();
  assert.equal((source.match(/repositoryMaintenance: \(context\) => runRepositoryMaintenanceRung\(/g) ?? []).length, 1);
});

test("W1-T3116: maintenance runs the installed git maintenance tasks asynchronously at most daily", async () => {
  const store = gitRepo({ kind: "maintenance-real" });
  store.git("maintenance", "run", "--task=gc");
  const statePath = join(store.dir, "maintenance.json");
  const before = await maintenance.surveyRepositoryMaintenance(store.dir, 0, "healthy", policy.timeoutMs);
  assert.equal(before.readable, true);
  let now = 100;
  const rows: string[] = [];
  const run = () => maintenance.runRepositoryMaintenance(store.dir, statePath, policy,
    (step) => rows.push(step), { clock: clockFromMillisFn(() => now), context: () => ({ activeLanes: 0, disk: "healthy" }) });
  await run();
  assert.ok(rows.includes("repository_maintenance.complete"));
  const state = maintenance.readMaintenanceState(statePath);
  assert.equal(state.nextEligibleAt, now + policy.intervalMs);
  assert.equal(state.lastFailure, undefined, "starting a successful attempt is not a failure");
  now++;
  await run();
  assert.equal(rows.filter((s) => s === "repository_maintenance.start").length, 1);
  assert.deepEqual(maintenance.maintenanceArgs("incremental"), ["maintenance", "run",
    "--task=commit-graph", "--task=loose-objects", "--task=incremental-repack"]);
});

test("W1-T3116: full gc is authorized only with a failed-gc marker, no active lanes and a complete survey", () => {
  const decide = (s: ReturnType<typeof survey>) => maintenance.decideRepositoryMaintenance(s, fresh(), policy, 10);
  assert.equal(decide(survey("failure")).verdict, "full-gc-due");
  assert.equal(decide(survey()).verdict, "incremental-due");
  assert.equal(decide({ ...survey("failure"), activeLanes: 1 }).verdict, "deferred");
  assert.equal(decide({ ...survey("failure"), readable: false }).verdict, "deferred");
  assert.equal(decide({ ...survey(), disk: "unknown" }).verdict, "deferred");
  assert.equal(fresh().nextEligibleAt, 0);
});

test("W1-T3116: rmd never writes or removes the gc log and success requires the marker gone", async () => {
  const store = gitRepo({ kind: "maintenance-marker" });
  const marker = join(store.dir, ".git", "gc.log");
  writeFileSync(marker, "failure evidence\n");
  const outcomes: maintenance.MaintenanceChild[] = [{ ok: false, error: "lock held", timedOut: false },
    { ok: false, error: "timeout", timedOut: true }, { ok: true, stdout: "" }];
  for (const [index, outcome] of outcomes.entries()) {
    const statePath = join(store.dir, `maintenance-${index}.json`);
    await maintenance.runRepositoryMaintenance(store.dir, statePath, policy, () => {}, {
      clock: fixedClock(1e8), random: () => 0, context: () => ({ activeLanes: 0, disk: "healthy" }),
      survey: async () => survey("failure evidence\n"), run: async () => outcome,
    });
    assert.equal(readFileSync(marker, "utf8"), "failure evidence\n");
    const state = maintenance.readMaintenanceState(statePath);
    assert.equal(state.failures, 1);
    assert.equal(state.lastOutcome, "fail");
    assert.match(state.lastReason!, outcome.ok ? /marker survives/ : new RegExp(outcome.error));
  }
  const realState = join(store.dir, "real-maintenance.json");
  await maintenance.runRepositoryMaintenance(store.dir, realState, policy, () => {}, {
    context: () => ({ activeLanes: 0, disk: "healthy" }),
  });
  assert.equal(existsSync(marker), false, "Git itself clears the marker on successful explicit maintenance");
  assert.equal(maintenance.readMaintenanceState(realState).lastOutcome, "complete");
});

test("W1-T3116: cadence and backoff survive restarts and repeated failure escalates once", async () => {
  const store = gitRepo({ kind: "maintenance-restart" });
  const statePath = join(store.dir, "maintenance.json");
  let now = 10;
  const rows: string[] = [];
  let attempts = 0;
  const run = () => maintenance.runRepositoryMaintenance(store.dir, statePath, policy,
    (s) => rows.push(s), { clock: clockFromMillisFn(() => now), random: () => 0,
      context: () => ({ activeLanes: 0, disk: "healthy" }), survey: async () => survey("failed"),
      run: async () => { attempts++; return { ok: false, timedOut: false, error: "lock held" }; } });
  for (let i = 0; i < 3; i++) {
    await run();
    const state = maintenance.readMaintenanceState(statePath);
    assert.equal(state.failures, i + 1);
    assert.ok(state.nextEligibleAt > now);
    await run();
    assert.equal(attempts, i + 1);
    now = state.nextEligibleAt;
  }
  await run();
  await run();
  assert.equal(attempts, 3);
  assert.equal(rows.filter((s) => s === "repository_maintenance.escalate").length, 1);
  const cappedPath = join(store.dir, "capped.json");
  await maintenance.runRepositoryMaintenance(store.dir, cappedPath,
    { ...policy, maxBackoffMs: policy.backoffMs }, () => {}, {
      clock: fixedClock(100), random: () => 1, context: () => ({ activeLanes: 0, disk: "healthy" }),
      survey: async () => survey("failed"), run: async () => ({ ok: false, timedOut: false, error: "lock held" }),
    });
  assert.equal(maintenance.readMaintenanceState(cappedPath).nextEligibleAt, 100 + policy.backoffMs,
    "jitter must stay inside the configured maximum backoff");
});

test("W1-T3116: the ledger and status expose object counts, duration, outcome and next retry", async () => {
  const store = gitRepo({ kind: "maintenance-ledger" });
  const rows: Array<Record<string, unknown>> = [];
  const statePath = join(store.dir, "maintenance.json");
  let now = 100;
  await maintenance.runRepositoryMaintenance(store.dir, statePath, policy, (_s, f) => rows.push(f), {
    clock: clockFromMillisFn(() => now), context: () => ({ activeLanes: 0, disk: "healthy" }),
    survey: async () => survey(), run: async () => { now = 175; return { ok: true, stdout: "" }; },
  });
  const row = rows.at(-1)!;
  assert.equal(row.loose_before, 6000);
  assert.equal(row.loose_after, 6000);
  assert.equal(row.bytes_before, 12000);
  assert.equal(row.duration_ms, 75);
  assert.equal(row.outcome, "complete");
  assert.equal(row.last_success, 175);
  assert.equal(row.next_retry, 86400175);
  const status = await import("../src/lib/status-board.js");
  const projection = status.repositoryMaintenanceStatus([{ step: "repository_maintenance.complete", ...row }]);
  assert.equal(projection[0].outcome, "complete");
  assert.equal(projection[0].nextRetry, 86400175);
  assert.equal(projection[0].looseAfter, 6000);
  const board = status.buildStatusBoard(store.dir, join(store.dir, "ledger.ndjson"), {
    repoDir: store.dir, queryService: () => ({ running: false, pid: null }),
    readLedger: () => [{ ts: new Date(100).toISOString(), run_id: "daemon", task_id: "DAEMON",
      step: "repository_maintenance.complete", ...row }], resolveOriginMainSha: () => undefined,
  });
  assert.equal(board.repositoryMaintenance![0].looseAfter, 6000);
  const text = status.renderStatusBoardText(board, { colourEnabled: false });
  assert.match(text, /repository maintenance/);
  assert.match(text, /loose 6000 -> 6000/);
  const heartbeat = readFileSync(new URL("../scripts/fleet-heartbeat.sh", import.meta.url), "utf8");
  assert.ok(heartbeat.includes("gc_verdict=${GC_VERDICT}"));
});

test("unverifiable post-survey and Git's replacement marker each enter durable backoff", async () => {
  const store = gitRepo({ kind: "maintenance-post-verification" });
  for (const [index, after] of [{ ...survey(), readable: false, error: "probe failed" },
    survey("new Git failure"), { ...survey(), looseCount: undefined }].entries()) {
    const statePath = join(store.dir, `post-${index}.json`);
    let probes = 0;
    await maintenance.runRepositoryMaintenance(store.dir, statePath, policy, () => {}, {
      clock: fixedClock(100), context: () => ({ activeLanes: 0, disk: "healthy" }),
      survey: async () => probes++ === 0 ? survey("previous failure") : after,
      run: async () => ({ ok: true, stdout: "" }),
    });
    const state = maintenance.readMaintenanceState(statePath);
    assert.equal(state.lastOutcome, "fail");
    assert.equal(state.failures, 1);
    assert.ok(state.nextEligibleAt > 100);
  }
});

test("Git's database lock refuses a contender and preserves failure evidence", async () => {
  const store = gitRepo({ kind: "maintenance-contender" });
  const marker = join(store.dir, ".git", "gc.log");
  writeFileSync(marker, "original failure\n");
  const lock = join(store.dir, ".git", "objects", "maintenance.lock");
  writeFileSync(lock, "held by another maintainer\n");
  const statePath = join(store.dir, "maintenance.json");
  await maintenance.runRepositoryMaintenance(store.dir, statePath, policy, () => {}, {
    context: () => ({ activeLanes: 0, disk: "healthy" }),
  });
  const state = maintenance.readMaintenanceState(statePath);
  assert.equal(state.lastOutcome, "fail");
  assert.equal(state.failures, 1);
  assert.equal(readFileSync(marker, "utf8"), "original failure\n");
  assert.equal(readFileSync(lock, "utf8"), "held by another maintainer\n");
});

test("a zero-exit maintenance lock skip is never a completed child", async () => {
  const store = gitRepo({ kind: "maintenance-zero-skip" });
  const lock = join(store.dir, ".git", "objects", "maintenance.lock");
  const marker = join(store.dir, ".git", "gc.log");
  writeFileSync(lock, "another maintenance owner\n");
  writeFileSync(marker, "prior failure\n");
  for (const kind of ["gc", "incremental"] as const) {
    const result = await maintenance.runMaintenanceGit(store.dir, maintenance.maintenanceArgs(kind), 5000);
    assert.equal(result.ok, false, `${kind} cannot report a skipped native child as complete`);
    assert.match(!result.ok ? result.error : "", /lock file|already running/);
    assert.equal(readFileSync(lock, "utf8"), "another maintenance owner\n");
    assert.equal(readFileSync(marker, "utf8"), "prior failure\n");
  }
});

test("idle linked worktrees share the surveyed object database and do not refuse full GC", async () => {
  const store = gitRepo({ kind: "maintenance-linked" });
  const linked = join(store.dir, "linked");
  store.git("worktree", "add", "--detach", linked);
  const marker = join(store.dir, ".git", "gc.log");
  writeFileSync(marker, "prior Git failure\n");
  const before = await maintenance.surveyRepositoryMaintenance(linked, 0, "healthy", policy.timeoutMs);
  assert.equal(before.gcLog, "prior Git failure\n");
  assert.equal(maintenance.decideRepositoryMaintenance(before, fresh(), policy, 0).verdict, "full-gc-due");
  await maintenance.runRepositoryMaintenance(store.dir, join(store.dir, "state.json"), policy, () => {}, {
    context: () => ({ activeLanes: 0, disk: "healthy" }),
  });
  assert.equal(existsSync(marker), false);
  assert.equal(maintenance.readMaintenanceState(join(store.dir, "state.json")).lastOutcome, "complete",
    "an actual uncontended native maintenance run still completes");
});

test("an unreadable or incomplete survey never spawns a maintenance child", async () => {
  const store = gitRepo({ kind: "maintenance-unreadable" });
  for (const bad of [{ ...survey(), readable: false, error: "permission denied" },
    { ...survey(), gcLog: undefined }, { ...survey(), looseBytes: undefined },
    { ...survey(), activeLanes: Number.NaN }]) {
    const statePath = join(store.dir, `state-${String(bad.error ?? bad.looseBytes)}-${String(bad.activeLanes)}.json`);
    await maintenance.runRepositoryMaintenance(store.dir, statePath, policy, () => {}, {
      clock: fixedClock(1e8), context: () => ({ activeLanes: bad.activeLanes, disk: "healthy" }),
      survey: async () => bad, run: async () => { assert.fail("incomplete survey authorizes no child"); },
    });
    assert.equal(maintenance.readMaintenanceState(statePath).lastOutcome, "defer");
    assert.equal(maintenance.readMaintenanceState(statePath).nextEligibleAt, 0, "deferral preserves the due episode");
  }
});

test("a lane admitted during the object survey vetoes full GC", async () => {
  const store = gitRepo({ kind: "maintenance-admission-race" });
  let lanes = 0;
  const statePath = join(store.dir, "state.json");
  await maintenance.runRepositoryMaintenance(store.dir, statePath, policy, () => {}, {
    context: () => ({ activeLanes: lanes, disk: "healthy" }),
    survey: async () => { lanes = 1; return survey("failed"); },
    run: async () => { assert.fail("new lane vetoes full GC"); },
  });
  assert.equal(maintenance.readMaintenanceState(statePath).lastOutcome, "defer");
});

test("corrupt durable state refuses maintenance and names the failure", async () => {
  const store = gitRepo({ kind: "maintenance-corrupt" });
  const statePath = join(store.dir, "state.json");
  writeFileSync(statePath, "{broken");
  const rows: Record<string, unknown>[] = [];
  await maintenance.runRepositoryMaintenance(store.dir, statePath, policy, (_s, f) => rows.push(f), {
    context: () => ({ activeLanes: 0, disk: "healthy" }),
    survey: async () => { assert.fail("corrupt state must not trigger probes"); },
  });
  assert.equal(rows[0].outcome, "fail");
  assert.match(String(rows[0].reason), /SyntaxError/);
  assert.equal(readFileSync(statePath, "utf8"), "{broken");
  writeFileSync(statePath, JSON.stringify({ ...fresh(), failures: 0.5 }));
  assert.throws(() => maintenance.readMaintenanceState(statePath), /state invalid/);
  assert.throws(() => maintenance.readMaintenanceState(store.dir), /state unreadable/);
});

test("a restart after the final interrupted attempt escalates without spawning a fourth child", async () => {
  const store = gitRepo({ kind: "maintenance-interrupted" });
  const statePath = join(store.dir, "state.json");
  writeFileSync(statePath, JSON.stringify({ ...fresh(), failures: 3, lastOutcome: "running", lastAttempt: 5 }));
  const rows: string[] = [];
  for (let i = 0; i < 2; i++) await maintenance.runRepositoryMaintenance(store.dir, statePath, policy,
    (s) => rows.push(s), { context: () => ({ activeLanes: 0, disk: "healthy" }),
      survey: async () => { assert.fail("interrupted final attempt exhausts automatic retries"); } });
  assert.equal(rows.filter((s) => s === "repository_maintenance.escalate").length, 1);
  assert.equal(maintenance.readMaintenanceState(statePath).lastFailure, 5);
});

test("a timed-out Git child and its descendants are terminated as one process group", async () => {
  const store = gitRepo({ kind: "maintenance-timeout" });
  const bin = join(store.dir, "bin");
  mkdirSync(bin);
  const survivor = join(store.dir, "survived");
  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, `#!/bin/sh\n(sleep 1; touch '${survivor}') &\nwait\n`);
  chmodSync(fakeGit, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    const result = await maintenance.runMaintenanceGit(store.dir, maintenance.maintenanceArgs("gc"), 50);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.timedOut, true);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(existsSync(survivor), false, "a grandchild cannot survive the maintenance timeout");
  } finally { process.env.PATH = previous; }
});

test("one lifetime cadence continues while a task lane stays occupied", { timeout: 5000 }, async () => {
  const store = gitRepo({ kind: "maintenance-lifetime" });
  const planPath = join(store.dir, "tasks.yaml");
  writeFileSync(planPath, "- id: W1-T1\n  title: task\n  repo: remudero\n  type: implement\n  status: queued\n  depends_on: []\n");
  let release = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let ticks = 0;
  let active = 0;
  await runDaemon(loadPlan(planPath), {
    refreshMerged: () => () => false, log: () => {}, sleep: async () => {},
    runOne: async (taskId) => { await pending; return { taskId, runId: taskId,
      merged: true, verdict: "merged", costUsd: 0 }; },
    repositoryMaintenance: async (context) => {
      ticks++;
      active = context.activeLanes;
      if (ticks === 2) release();
    },
  }, { max: 1, pollIntervalMs: 5 });
  assert.equal(ticks, 2);
  assert.equal(active, 1);
});

test("a rejected maintenance callback logs its reason and cadence retries without failing the task", { timeout: 5000 }, async () => {
  const store = gitRepo({ kind: "maintenance-callback-rejection" });
  const planPath = join(store.dir, "tasks.yaml");
  writeFileSync(planPath, "- id: W1-T1\n  title: task\n  repo: remudero\n  type: implement\n  status: queued\n  depends_on: []\n");
  let release = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const failures: Array<Record<string, unknown> | undefined> = [];
  let ticks = 0;
  try {
    const result = await runDaemon(loadPlan(planPath), {
      refreshMerged: () => () => false, sleep: async () => {},
      log: (step, fields) => { if (step === "repository_maintenance.fail") failures.push(fields); },
      runOne: async (taskId) => { await pending; return { taskId, runId: taskId,
        merged: true, verdict: "merged", costUsd: 0 }; },
      repositoryMaintenance: async () => {
        ticks++;
        if (ticks === 1) throw new Error("maintenance state unavailable");
        release();
      },
    }, { max: 1, pollIntervalMs: 5 });
    assert.deepEqual(failures, [{ reason: "Error: maintenance state unavailable", outcome: "fail" }]);
    assert.equal(ticks, 2, "the failed callback must release the cadence's pending guard");
    assert.deepEqual(result.merged, ["W1-T1"]);
    assert.equal(result.stopReason, "max_reached");
  } finally { release(); }
});

test("default surveys report missing repositories and unreadable markers without healthy zeros", async () => {
  const store = gitRepo({ kind: "maintenance-probe-errors" });
  const missing = await maintenance.surveyRepositoryMaintenance(join(store.dir, "missing"), 0, "healthy", 1000);
  assert.equal(missing.readable, false);
  assert.equal(missing.looseCount, undefined);
  mkdirSync(join(store.dir, ".git", "gc.log"));
  const unreadable = await maintenance.surveyRepositoryMaintenance(store.dir, 0, "healthy", 1000);
  assert.equal(unreadable.readable, false);
  assert.match(unreadable.error!, /EISDIR/);
});

test("the default parser refuses incomplete object output and the default child names spawn errors", async () => {
  const store = gitRepo({ kind: "maintenance-default-errors" });
  const bin = join(store.dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), '#!/bin/sh\ncase "$3" in\nrev-parse) echo .git ;;\ncount-objects) echo "count: 42" ;;\nesac\n');
  chmodSync(join(bin, "git"), 0o755);
  const previous = process.env.PATH;
  try {
    process.env.PATH = bin;
    const incomplete = await maintenance.surveyRepositoryMaintenance(store.dir, 0, "healthy", 1000);
    assert.equal(incomplete.readable, false);
    assert.equal(incomplete.error, "incomplete count-objects output");
    process.env.PATH = join(bin, "missing");
    const result = await maintenance.runMaintenanceGit(store.dir, maintenance.maintenanceArgs("gc"), 1000);
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /ENOENT/);
  } finally { process.env.PATH = previous; }
});

test("the production rung maintains both managed and daemon stores using its default policy and probes", async () => {
  const root = gitRepo({ kind: "maintenance-rung-root" });
  const managed = gitRepo({ kind: "maintenance-rung-managed" });
  const daemon = gitRepo({ kind: "maintenance-rung-daemon" });
  mkdirSync(join(root.dir, "repos"));
  symlinkSync(managed.dir, join(root.dir, "repos", "remudero"), "dir");
  symlinkSync(daemon.dir, join(root.dir, "remudero"), "dir");
  mkdirSync(join(root.dir, "repos", "not-a-repository"));
  for (const store of [managed, daemon]) writeFileSync(join(store.dir, ".git", "gc.log"), "previous failure\n");
  const rows: Array<[string, Record<string, unknown>]> = [];
  await runRepositoryMaintenanceRung({ root: root.dir } as never, (step, fields) => rows.push([step, fields]),
    { activeLanes: 0, disk: "unknown", queueBusy: false });
  assert.equal(rows.filter(([s]) => s === "repository_maintenance.complete").length, 2, JSON.stringify(rows));
  for (const store of [managed, daemon]) assert.equal(existsSync(join(store.dir, ".git", "gc.log")), false);
  const states = readdirSync(join(root.dir, "state")).filter((name) => name.startsWith("repository-maintenance-"));
  assert.equal(states.length, 2);
  for (const name of states) assert.equal(maintenance.readMaintenanceState(join(root.dir, "state", name)).lastOutcome, "complete");
});
