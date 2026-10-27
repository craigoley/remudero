import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";

import { runDaemon, type DaemonFreshness } from "#src/lib/daemon.js";
import { defaultInstance } from "#src/lib/host-memory-ledger.js";
import { loadPlan } from "#src/lib/plan.js";
import {
  adoptRunChildren, DETACHED_WORK_INVENTORY, DETACHED_WORK_KINDS, detachedWorkPlacement, measureDrainCosts, readWorkSpec,
  type DetachedWorkEvidence, type DetachedWorkKind, type DetachedWorkSpec,
} from "#src/lib/run-child.js";
import { childIdentity, RUN_CHILD_SCHEMA, writeSpec, writeStatus, type RunChildStatus } from "#src/lib/run-child-contract.js";
import type { RunResult } from "#src/lib/run-result.js";
import { adoptChildWork, childWorkCount, childWorkLeftRunning, resetChildWork, reviewAdmissionBound, type DetachedActionKind } from "#src/lib/sweep.js";

const result = (id: string): RunResult => ({ taskId: id, runId: id, merged: false, verdict: "no_pr", costUsd: 0 });

function fixture() {
  resetChildWork();
  const root = mkdtempSync(join(tmpdir(), "rmd-detached-children-"));
  const stateRoot = join(root, "state");
  const rows: Array<Record<string, unknown>> = [];
  const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); };
  const identity = childIdentity(process.pid)!;
  const add = (id: string, work: DetachedWorkSpec, over: Partial<RunChildStatus> = {}, taskId = "A") => {
    const dir = join(stateRoot, "runs", id);
    writeSpec(dir, { schema: RUN_CHILD_SCHEMA, runId: id, taskId, instance: "fixture", engine: { sha: "abc", sourceHash: "hash" },
      planSnapshotPath: join(stateRoot, "plan.json"), reservationId: "", options: {} });
    const specPath = join(dir, "spec.json");
    writeFileSync(specPath, `${JSON.stringify({ ...JSON.parse(readFileSync(specPath, "utf8")) as object, work })}\n`);
    const status: RunChildStatus = { schema: RUN_CHILD_SCHEMA, runId: id, identity, engineSha: "abc", entryKind: "bundle",
      phase: "review", heartbeatAt: Date.now(), state: "running", ...over };
    writeStatus(dir, status);
    return { dir, status };
  };
  const adopt = () => adoptRunChildren({ stateRoot, instance: "fixture", log,
    settledRunIds: new Set(rows.filter((r) => r.step === "run_child.settled").map((r) => String(r.run_id))) }, { pollMs: 5, watch: false });
  return { root, stateRoot, rows, log, add, adopt, cleanup: () => { resetChildWork(); rmSync(root, { recursive: true, force: true }); } };
}

const review: DetachedWorkSpec = { kind: "review", prNumber: 7, headSha: "h".repeat(40), reviewKey: "review-key-7" };
const fix: DetachedWorkSpec = { kind: "fix-dispatch", prNumber: 8, headSha: "g".repeat(40), fixKey: "fix-key-8" };

test("W1-T9114: the inventory moves a kind only on a measured drain cost", () => {
  const everyKind: Record<DetachedActionKind, true> = {
    "fix-dispatch": true, retro: true, "auto-triage": true, "ci-learning": true, "measurement-cadence": true, "benchmark-cohort": true,
    "light-pass-action": true,
  };
  assert.deepEqual([...DETACHED_WORK_KINDS].sort(), [...Object.keys(everyKind), "review"].sort(), "the table classifies every kind and the review registry");
  for (const kind of DETACHED_WORK_KINDS) assert.ok(DETACHED_WORK_INVENTORY[kind].holds.length > 0, `${kind} says what it holds`);

  // The cost comes from the ledger rows a drain writes: a settled review, an abandoned fix, a released retro.
  const measured = measureDrainCosts([
    JSON.stringify({ step: "daemon.freshness_drain.completed", duration_ms: 9_000, in_flight_reviews: 1, waited_on: [
      { what: "review", kind: "review", settled_after_ms: 4_000 },
      { what: "detached", kind: "fix-dispatch", abandoned: true },
      { what: "detached", kind: "retro", released: true },
    ] }),
    "{ torn line",
    { step: "daemon.detached_action_abandoned", action_kind: "fix-dispatch", age_ms: 1_500 },
    { step: "daemon.memory_drain.completed", duration_ms: 2_000, in_flight_reviews: 0, detached_sweep_actions: 1 },
  ]);
  assert.deepEqual(measured.review, { drains: 1, waitedMs: 4_000, abandoned: 0 });
  assert.deepEqual(measured["fix-dispatch"], { drains: 2, waitedMs: 9_000 + 1_500, abandoned: 2 });
  assert.equal(measured.retro, undefined, "a released unit was never waited on");

  const hosted = new Set<DetachedWorkKind>(DETACHED_WORK_KINDS);
  const on = (over: Partial<DetachedWorkEvidence> = {}): DetachedWorkEvidence => ({ mode: "on", hosted, measured, ...over });
  const moved = (evidence: DetachedWorkEvidence) => DETACHED_WORK_KINDS.filter((k) => detachedWorkPlacement(k, evidence).placement === "child");
  assert.deepEqual(moved(on()).sort(), ["fix-dispatch", "review"]);
  assert.deepEqual(moved(on({ measured: {} })), [], "no measured drain cost, nothing moves");
  assert.deepEqual(moved(on({ measured: { review: { drains: 3, waitedMs: 0, abandoned: 0 } } })), [], "a zero wait is no cost");
  assert.deepEqual(moved(on({ mode: "off" })), []);
  assert.deepEqual(moved(on({ mode: "shadow" })), []);
  assert.deepEqual(moved(on({ hosted: new Set() })), [], "a kind no entry hosts stays in process");
  // A kind the design keeps in process says why, even when the ledger measured a wait for it.
  const retro = detachedWorkPlacement("retro", on({ measured: { retro: { drains: 1, waitedMs: 5_000, abandoned: 0 } } }));
  assert.equal(retro.placement, "process");
  assert.match(retro.reason, /runAutomatedRetroSubprocess/);
  assert.equal(detachedWorkPlacement("not-a-kind", on()).placement, "process");
});

test("W1-T9114: a spec that cannot be read is malformed, never a build run", () => {
  const f = fixture();
  try {
    const torn = join(f.root, "torn");
    mkdirSync(torn, { recursive: true });
    assert.equal(readWorkSpec(torn), "malformed", "a missing spec.json is malformed");
    writeFileSync(join(torn, "spec.json"), '{ "work": { "kind": "rev');
    assert.equal(readWorkSpec(torn), "malformed", "a torn spec.json is malformed");
    writeFileSync(join(torn, "spec.json"), "{}");
    assert.equal(readWorkSpec(torn), undefined, "a spec without work is a build run");
  } finally { f.cleanup(); }
});

test("W1-T9114: a boot adopts a live review child", async () => {
  const f = fixture();
  try {
    const child = f.add("work-review-A-1", review);
    f.add("run-B-1", { kind: "fix-dispatch", fixKey: "fix-key-B" }, {}, "B");
    assert.deepEqual(readWorkSpec(child.dir), review);
    const planPath = join(f.root, "tasks.yaml");
    writeFileSync(planPath, `- id: A\n  title: A\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n  files: [src/A.ts]\n`);
    let stop = false;
    const started: string[] = [];
    const run = runDaemon(loadPlan(planPath), {
      adoptRunChildren: f.adopt, refreshMerged: () => () => false, openPrCount: () => 0,
      checkStop: () => stop ? "done" : undefined,
      sweep: async () => {}, gardens: [() => ({ stop() {} })],
      runOne: async (id) => { started.push(id); return result(id); },
      log: (step, fields) => { f.log(step, fields); if (step === "dispatch.settled_set") stop = true; },
      sleep: async () => { await flush(); },
    }, { laneCount: 2, wipLimit: 1, pollIntervalMs: 5 });
    await flush();
    assert.equal(f.rows.filter((r) => r.step === "run_child.adopted").length, 2);
    assert.equal(childWorkCount("review"), 1, "the live review child is registered with the sweep");
    assert.equal(childWorkCount("fix-dispatch"), 1);
    assert.deepEqual(reviewAdmissionBound(3), { bound: 2, inFlight: 1 }, "it keeps its review slot, and counts in the width");
    assert.equal(reviewAdmissionBound(1).bound, 0, "the PR is not re-admitted while the child runs");
    await run;
    assert.deepEqual(started, ["A"], "a review child holds a slot and never the lane of the task it judges");
    assert.equal(childWorkCount("review"), 1, "the daemon's exit left the child running");

    // The child ends: its slot is released and the next light pass re-admits the PR.
    writeStatus(child.dir, { ...child.status, state: "done", result: result("A") });
    for (let i = 0; i < 400 && childWorkCount("review") > 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(childWorkCount("review"), 0);
    assert.equal(reviewAdmissionBound(1).bound, 1);
  } finally { f.cleanup(); }
});

test("W1-T9114: a terminal review child settles once", async () => {
  const f = fixture();
  try {
    f.add("work-review-A-2", review, { state: "done", result: result("A") });
    const settledRows = () => f.rows.filter((r) => r.step === "daemon.child_work_settled");
    const boot = async () => {
      const adopted = f.adopt();
      await Promise.all(adopted.map((child) => adoptChildWork({ ...child, work: child.work! }, f.log)));
      return adopted;
    };
    const first = await boot();
    assert.equal(first.length, 1);
    assert.equal(first[0]!.work?.kind, "review");
    assert.equal(settledRows().length, 1);
    assert.deepEqual({ outcome: settledRows()[0]!.outcome, first: settledRows()[0]!.first_settlement, pr: settledRows()[0]!.pr },
      { outcome: "terminal", first: true, pr: 7 });
    assert.equal(f.rows.filter((r) => r.step === "run_child.settled").length, 1);
    assert.deepEqual(childWorkLeftRunning(), {});

    // The same process adopting the same child again claims, posts and acknowledges nothing.
    await adoptChildWork({ ...first[0]!, work: first[0]!.work! }, f.log);
    assert.equal(settledRows().length, 1);
    // A second boot reads the receipt and adopts nothing: no second verdict.
    assert.deepEqual(await boot(), []);
    assert.equal(settledRows().length, 1);
    assert.equal(f.rows.filter((r) => r.step === "run_child.settled").length, 1);
  } finally { f.cleanup(); }
});

test("W1-T9114: a restart does not drain child reviews or fix dispatches", async () => {
  const f = fixture();
  try {
    const reviewDir = f.add("work-review-A-3", review);
    f.add("work-fix-A-3", fix);
    const planPath = join(f.root, "tasks.yaml");
    writeFileSync(planPath, `- id: A\n  title: A\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n  files: [src/A.ts]\n`);
    // The ledger the placement reads: a review drain that waited, and a fix dispatch the drain had to abandon.
    const ledger = [JSON.stringify({ step: "daemon.freshness_drain.completed", duration_ms: 186_000, in_flight_reviews: 1, waited_on: [
      { what: "review", kind: "review", settled_after_ms: 120_000 }, { what: "detached", kind: "fix-dispatch", abandoned: true },
    ] })];
    const drive = (mode: "on" | "off", bound?: number) => {
      const rows: Array<Record<string, unknown>> = [];
      const daemon = runDaemon(loadPlan(planPath), {
        adoptRunChildren: f.adopt, refreshMerged: () => () => true, openPrCount: () => 0,
        runOne: async (id) => result(id), sleep: async () => { await flush(); },
        log: (step, fields) => { rows.push({ step, ...fields }); f.log(step, fields); },
        checkFreshness: (): DaemonFreshness => ({ stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40) }),
        sweep: async () => {}, sleepUntilSweepWake: async () => { await flush(); return "timeout"; }, sweepLight: async () => {},
        readLedgerLines: () => ledger,
        detachedWorkMode: () => mode, detachedWorkHosts: () => new Set<DetachedWorkKind>(["review", "fix-dispatch"]),
      }, { laneCount: 1, wipLimit: 1, pollIntervalMs: 5, ...(bound === undefined ? {} : { sweepWallClockBoundMs: bound }) });
      return { daemon, rows };
    };
    const moved = drive("on");
    const summary = await moved.daemon;
    assert.equal(summary.stopReason, "stale", "the restart returned while both children still ran");
    const completed = moved.rows.find((r) => r.step === "daemon.freshness_drain.completed");
    assert.ok(completed, "the drain row is written for children alone");
    assert.deepEqual(completed.detached_children_left_running, { review: 1, "fix-dispatch": 1 });
    assert.equal(completed.in_flight_reviews, 0);
    assert.equal(completed.abandoned_in_flight_reviews, 0);
    assert.equal(completed.abandoned_detached_sweep_actions, 0);
    assert.equal((completed.detached_work_placement as Record<string, string>).review, "child");
    assert.equal((completed.detached_work_placement as Record<string, string>)["fix-dispatch"], "child");
    assert.equal((completed.detached_work_placement as Record<string, string>).retro, "process");
    assert.equal(childWorkCount(), 2, "neither child was settled, aborted or waited for by the exit");
    assert.equal(JSON.parse(readFileSync(join(reviewDir.dir, "status.json"), "utf8")).state, "running");

    // Control: the same boot with the mode off reads every kind as in process, and a child adopted earlier is still left running and named.
    const off = drive("off");
    assert.equal((await off.daemon).stopReason, "stale");
    const offRow = off.rows.find((r) => r.step === "daemon.freshness_drain.completed");
    assert.equal((offRow?.detached_work_placement as Record<string, string>).review, "process");
    assert.deepEqual(offRow?.detached_children_left_running, { review: 1, "fix-dispatch": 1 });
  } finally { f.cleanup(); }
});
