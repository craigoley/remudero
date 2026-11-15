import assert from "node:assert/strict";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { Config } from "#src/lib/config.js";
import type { AdmissionPorts } from "#src/lib/host-memory-admission.js";
import { requestPause, requestStop } from "#src/lib/fleet-control.js";
import { RUN_CHILD_SCHEMA, type RunChildSpec } from "#src/lib/run-child-contract.js";
import { withRunChildReservation } from "#src/lib/run-child-reservation.js";
import {
  buildFixDispatchEnvelope, runFixDispatchChild, type FixDispatchChildPorts, type OpenPrView,
} from "#src/lib/sweep.js";
import { createClaudeExecutableCache, spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const FIX_TASK = "W1-T11168";
const FIX_HEAD = "5d1e2a7b9c";
const UNMET = [{ claim: "a criterion", proof: "unit test: x", met: false, reason: "not done", proof_exec: "not_executable" as const }];
const PR: OpenPrView = {
  prNumber: 18281, prUrl: "https://github.com/craigoley/remudero/pull/18281", taskId: FIX_TASK, reviewState: "failure",
  checksState: "green", unmetCriteria: UNMET, priorStrikes: 0, lastActivityAt: "2026-11-13T11:00:00Z", headSha: FIX_HEAD,
  headRefName: `run-${FIX_TASK}-1794568000000`, autoMergeArmed: false,
};
const envelope = buildFixDispatchEnvelope(PR, { unmetCriteria: UNMET },
  { fixKey: `${FIX_TASK}@${FIX_HEAD}`, decidedAtMs: 1, planContextDigest: "digest-1" });
const inputs = (): Record<string, unknown> => ({ envelope: JSON.parse(JSON.stringify(envelope)) });

type HoldAnswer = string | undefined | Error;

/** The child's ports; `holdAt(k)` answers the k-th hold read (0 is the recheck's read). */
function childPorts(holdAt: (read: number) => HoldAnswer, over: Partial<FixDispatchChildPorts> = {}) {
  const events: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  let reads = 0;
  let granted = 0;
  let dispatched = 0;
  const ports: FixDispatchChildPorts = {
    hold: () => {
      const answer = holdAt(reads++);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    readLivePr: async () => { events.push("pr"); return { state: "OPEN", merged: false, headSha: FIX_HEAD }; },
    readTask: () => { events.push("task"); return { found: true, merged: false, retired: false, contextDigest: "digest-1" }; },
    claimFixAdmission: () => {
      events.push("claim");
      granted++;
      return { admitted: true, release: () => { events.push("release"); granted--; } };
    },
    dispatcher: () => {
      events.push("dispatcher");
      return { dispatchFix: async () => { events.push("dispatch"); dispatched++; } };
    },
    log: (step, extra) => { rows.push({ step, ...extra }); },
    ...over,
  };
  return { ports, events, rows, reads: () => reads, granted: () => granted, dispatched: () => dispatched };
}

function refusal(rows: Array<Record<string, unknown>>): string {
  const row = rows.find(r => r.step === "sweep.fix.child_refused");
  assert.ok(row, "the refusal is logged as sweep.fix.child_refused");
  return String(row.reason);
}

test("W1-T12497 criterion 1: a PAUSE written while the child reads its task refuses before the admission grant", async () => {
  let pause: string | undefined;
  const h = childPorts(() => pause, {
    readTask: () => { pause = "PAUSE: recycle requested"; return { found: true, merged: false, retired: false, contextDigest: "digest-1" }; },
  });
  await assert.rejects(runFixDispatchChild(inputs(), h.ports), /fix dispatch refused: worker admission is held: PAUSE: recycle requested/);
  assert.match(refusal(h.rows), /worker admission is held: PAUSE/);
  assert.equal(h.reads(), 2, "the recheck read the hold, and the child read it again after the slow reads");
  assert.equal(h.events.includes("claim"), false, "no admission grant");
  assert.equal(h.events.includes("dispatcher"), false, "no dispatcher is built");
  assert.equal(h.dispatched(), 0, "dispatchFix is not called, so no fix-branch claim and no worker");
});

test("W1-T12497 criterion 2: a PAUSE or STOP written after the grant refuses before dispatchFix and releases the grant", async () => {
  for (const hold of ["PAUSE: recycle requested", "STOP: operator stop"]) {
    let current: string | undefined;
    const h = childPorts(() => current);
    const claim = h.ports.claimFixAdmission;
    h.ports.claimFixAdmission = (pr) => { const grant = claim(pr); current = hold; return grant; };
    await assert.rejects(runFixDispatchChild(inputs(), h.ports), new RegExp(`worker admission is held: ${hold}`), hold);
    assert.match(refusal(h.rows), new RegExp(`worker admission is held: ${hold.split(":")[0]}`));
    assert.equal(h.reads(), 3, `${hold}: the hold was read directly before dispatchFix`);
    assert.equal(h.dispatched(), 0, `${hold}: dispatchFix is not called`);
    assert.equal(h.granted(), 0, `${hold}: the grant is released`);
    assert.deepEqual(h.events, ["pr", "task", "claim", "dispatcher", "release"]);
  }
});

test("W1-T12497 criterion 3: a hold reader that throws at either new read refuses the child", async () => {
  for (const failing of [1, 2]) {
    const h = childPorts(read => read === failing ? new Error("flag dir unreadable") : undefined);
    await assert.rejects(runFixDispatchChild(inputs(), h.ports), /fix dispatch refused: the fleet hold could not be read .*\(flag dir unreadable\)/);
    assert.match(refusal(h.rows), /the fleet hold could not be read (before the admission grant|before the fix dispatch) \(flag dir unreadable\)/);
    assert.equal(h.dispatched(), 0, `read ${failing}: dispatchFix is not called`);
    assert.equal(h.granted(), 0, `read ${failing}: no grant is left held`);
    assert.equal(h.events.includes("claim"), failing === 2, `read ${failing}: the grant is taken only after the read before it passed`);
  }
});

function runChildSpec(): RunChildSpec {
  return { schema: RUN_CHILD_SCHEMA, taskId: FIX_TASK, runId: "work-fix-dispatch-W1-T11168-fixture", instance: "fixture",
    engine: { sourceHash: "fixture", sha: "fixture" }, planSnapshotPath: "/unused/plan.json", reservationId: "run-child-fixture",
    options: {} };
}

function workerResult(): WorkerResult {
  return { provider: "codex", sessionId: "fixture-session", text: "done", blocks: [], stderr: "", isError: false,
    apiError: false, subtype: "success", costUsd: 0, numTurns: 1, permissionDenials: [], childEnvKeys: [],
    model: "fixture", effort: "low", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false };
}

function workerStart(t: TestContext, workerClass: "fix" | "review") {
  const root = ownedFixtureDir(t, "fix-child-hold").dir;
  const config: Config = { root, claudeBin: "/unused", dailyCapUsd: 25,
    workerProviders: { enabled: ["claude", "codex", "cash"], cashFallbackWhenBlocked: true,
      cashEndpoint: "https://foundry.example.test/" } };
  let spawns = 0;
  const rows: Array<Record<string, unknown>> = [];
  const args: SpawnWorkerArgs = {
    cwd: root, permissionMode: "bypassPermissions", settingsFile: join(REPO_ROOT, "settings/worker.json"),
    config, model: "haiku", effort: "low", tools: ["Read", "Write", "Edit"], workerClass,
    memoryShadow: {} satisfies Partial<AdmissionPorts>, mountProvider: "codex", prompt: "fixture work",
    logWorkerSpawnWithheld: row => rows.push(row),
    providerRouting: { writeStatus: () => {}, spawnCodex: async () => { spawns++; return workerResult(); } },
    claudeExecutable: { cache: createClaudeExecutableCache(), deps: {
      env: { RMD_CLAUDE_BIN: "/fixture/claude" }, home: root, exists: () => true,
      which: () => "/fixture/claude", canExecute: () => true, locations: [],
    } },
    keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({
      claudeAiOauth: { accessToken: "fixture-only", expiresAt: Date.now() + 3_600_000 },
    }) },
    taskId: FIX_TASK, runId: "work-fix-dispatch-W1-T11168-fixture",
  };
  return { root, args, rows, spawns: () => spawns };
}

test("W1-T12497 criterion 4: a fix start inside a run child reads the real PAUSE flag and spawns nothing", async t => {
  const f = workerStart(t, "fix");
  requestPause(f.root, "recycle requested");
  const result = await withRunChildReservation(runChildSpec(), () => spawnWorker(f.args));
  assert.equal(f.spawns(), 0, "the held fix start never invokes the provider spawn");
  assert.equal(result.notStarted, "admission-abandoned");
  assert.equal(result.subtype, "admission_abandoned");
  assert.equal(f.rows[0]?.step, "worker.spawn_withheld");
  assert.match(String(f.rows[0]?.hold), /^fleet PAUSE hold: PAUSE requested: recycle requested/);
});

test("W1-T12497 criterion 4: a run-child start of another class does not read this hold and starts as before", async t => {
  const f = workerStart(t, "review");
  requestPause(f.root, "recycle requested");
  let reads = 0;
  f.args.readWorkerAdmissionHold = () => { reads++; return { control: "PAUSE", detail: "recycle requested" }; };
  const result = await withRunChildReservation(runChildSpec(), () => spawnWorker(f.args));
  assert.equal(reads, 0, "a review start does not read the fix-start hold");
  assert.equal(f.spawns(), 1);
  assert.equal(result.notStarted, undefined);
  assert.equal(f.rows.length, 0);
});

test("W1-T12497 criterion 5: with no hold at any read the child dispatches once and releases its grant, as today", async () => {
  const h = childPorts(() => undefined);
  await runFixDispatchChild(inputs(), h.ports);
  assert.equal(h.reads(), 3, "the recheck read and the two new reads");
  assert.equal(h.dispatched(), 1);
  assert.equal(h.granted(), 0);
  assert.deepEqual(h.events, ["pr", "task", "claim", "dispatcher", "dispatch", "release"]);
  assert.equal(h.rows.some(r => r.step === "sweep.fix.child_refused"), false);
});

test("W1-T12497 criterion 6: a fix child never passes a STOP or PAUSE at the read directly before a step", async t => {
  for (const hold of ["STOP: operator stop", "PAUSE: recycle requested"]) {
    for (const [read, stepAfter] of [[0, "claim"], [1, "claim"], [2, "dispatch"]] as const) {
      const h = childPorts(k => k === read ? hold : undefined);
      await assert.rejects(runFixDispatchChild(inputs(), h.ports), /worker admission is held/, `${hold} at read ${read}`);
      assert.equal(h.events.includes(stepAfter), false, `${hold} at read ${read}: ${stepAfter} never runs`);
      assert.equal(h.dispatched(), 0);
      assert.equal(h.granted(), 0);
    }
  }
  const f = workerStart(t, "fix");
  requestStop(f.root, "operator stop");
  const result = await withRunChildReservation(runChildSpec(), () => spawnWorker(f.args));
  assert.equal(f.spawns(), 0, "a fix worker never starts past a STOP in a run child");
  assert.equal(result.notStarted, "admission-abandoned");
  const clear = workerStart(t, "fix");
  const started = await withRunChildReservation(runChildSpec(), () => spawnWorker(clear.args));
  assert.equal(clear.spawns(), 1, "a clear hold starts the run-child fix worker as before");
  assert.equal(started.notStarted, undefined);
});
