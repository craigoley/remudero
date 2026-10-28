import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";

import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { fixedClock } from "#src/lib/clock.js";
import { configPath, type Config } from "#src/lib/config.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { riskJudgePlanContextDigestFor } from "#src/lib/risk-judge.js";
import { runDaemon, type DaemonFreshness } from "#src/lib/daemon.js";
import { defaultInstance } from "#src/lib/host-memory-ledger.js";
import { acquireInflightLock, inflightLockPath, readInflightLock } from "#src/lib/inflight-lock.js";
import { loadMounts, resolveMount } from "#src/lib/mounts.js";
import { loadPlan, type Plan } from "#src/lib/plan.js";
import {
  adoptRunChildren, createDetachedWorkHost, DETACHED_WORK_INVENTORY, DETACHED_WORK_KINDS, detachedWorkModeNow, detachedWorkPlacement,
  HOSTED_DETACHED_WORK_KINDS, measureDrainCosts, readWorkSpec,
  type DetachedWorkEvidence, type DetachedWorkKind, type DetachedWorkSpec, type spawnRunChild, type startRunChildProbe,
} from "#src/lib/run-child.js";
import { childIdentity, readStatus, RUN_CHILD_SCHEMA, writeSpec, writeStatus, type RunChildStatus } from "#src/lib/run-child-contract.js";
import { runChildMain } from "#src/run-child-main.js";
import type { RunResult } from "#src/lib/run-result.js";
import {
  adoptChildWork, buildFixDispatchEnvelope, buildSweepEffects as buildGovernedEffects, childWorkCount, childWorkHoldsReviewKey, childWorkLeftRunning, detachedSweepActionCount, fixBranchClaimKey,
  detachSweepAction, drainDetachedSweepActions, installDetachedWorkHost, readFixDispatchEnvelope, resetChildWork, reviewAdmissionBound, runFixDispatchChild, runSweep,
  type BuildSweepEffectsDeps, type DetachedActionKind, type FixDispatchChildPorts, type FixDispatchEnvelope, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";
import type { SweepCommandHost } from "#src/cli/commands/sweep.js";

// Avoid the argv module's checkout discovery: these fixtures do not need a git executable.
const savedArgv = [...process.argv];
process.argv.push("--repo-root", REPO_ROOT);
const { buildSweepEffects } = await import("#src/cli/commands/sweep.js");
process.argv.splice(0, process.argv.length, ...savedArgv);

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
  assert.deepEqual(moved(on()), ["review", "fix-dispatch"], "the review and the fix dispatch moved: both held a drain over the window");
  assert.equal(detachedWorkPlacement("fix-dispatch", on()).placement, "child");
  assert.deepEqual(moved(on({ measured: { review: measured.review! } })), ["review"], "a fix dispatch that never held a drain stays in process");
  assert.match(detachedWorkPlacement("fix-dispatch", on({ measured: {} })).reason, /never held a drain/, "and the placement says why");
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

  const legacy = (duration: number, age: number) => measureDrainCosts([
    { step: "daemon.freshness_drain.started", ts: "2026-10-12T12:00:00.000Z" },
    { step: "daemon.detached_action_abandoned", ts: new Date(Date.parse("2026-10-12T12:00:00.000Z") + duration).toISOString(),
      action_kind: "fix-dispatch", age_ms: age },
    { step: "daemon.freshness_drain.completed", ts: new Date(Date.parse("2026-10-12T12:00:00.000Z") + duration).toISOString(), duration_ms: duration },
  ]);
  const oldAction = 12_000 * 60_000;
  assert.equal(legacy(0, oldAction)["fix-dispatch"]?.waitedMs, 0, "an old action at a zero-duration drain measured no wait");
  assert.equal(detachedWorkPlacement("fix-dispatch", on({ measured: legacy(0, oldAction) })).placement, "process");
  assert.equal(legacy(2_000, oldAction)["fix-dispatch"]?.waitedMs, 2_000, "only the corresponding drain interval counts");
  assert.equal(legacy(2_000, 500)["fix-dispatch"]?.waitedMs, 500, "an action admitted during the drain costs only its overlap");
  const unrelated = measureDrainCosts([
    { step: "daemon.detached_action_abandoned", ts: "2026-10-12T11:00:00Z", action_kind: "fix-dispatch", age_ms: oldAction },
    { step: "daemon.memory_drain.completed", ts: "2026-10-12T12:00:02Z", duration_ms: 2_000 },
  ]);
  assert.equal(unrelated["fix-dispatch"], undefined, "a row outside this drain cannot move a kind");
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

test("W1-T9114: the run child hosts detached work and maps every ending to a status", async () => {
  const f = fixture();
  try {
    const noSignals = { on() {}, off() {} };
    const base = { env: {}, stderr: () => {}, heartbeatMs: 60_000, loadRunPath: async () => ({}) };
    const read = (dir: string) => {
      const status = readStatus(dir);
      assert.ok(status.ok);
      return status.value;
    };

    // A spec whose work this entry cannot read ends as a contract mismatch, never a build run.
    const bad = f.add("work-bad-1", { kind: "bogus" } as unknown as DetachedWorkSpec);
    assert.equal(await runChildMain(["--run-dir", bad.dir], { ...base, signals: noSignals,
      runTask: async () => { throw new Error("a malformed work spec must not run a build"); } }), 1);
    assert.equal(read(bad.dir).state, "failed");
    assert.equal(read(bad.dir).phase, "spec");

    // Work that finishes: its result is the terminal status, hosted by runDetachedWork with the run id and task.
    const ok = f.add("work-ok-1", review);
    const seen: unknown[] = [];
    assert.equal(await runChildMain(["--run-dir", ok.dir], { ...base, signals: noSignals,
      runDetachedWork: async (work, ctx) => { seen.push(work, { runId: ctx.runId, taskId: ctx.taskId }); return result("A"); } }), 0);
    assert.deepEqual(seen, [review, { runId: "work-ok-1", taskId: "A" }]);
    assert.equal(read(ok.dir).state, "done");
    assert.equal(read(ok.dir).phase, "done");

    // The work's own phase (a fix's admission, worker, CI wait) lands in the owned status.json while it runs: the adopting daemon reads it.
    const phased = f.add("work-phase-1", fix);
    const phases: string[] = [];
    assert.equal(await runChildMain(["--run-dir", phased.dir], { ...base, signals: noSignals,
      runDetachedWork: async (_work, ctx) => {
        for (const phase of ["admission", "worker", "ci-wait"]) { ctx.onPhase!(phase); phases.push(read(phased.dir).phase); }
        assert.equal(read(phased.dir).state, "running");
        return result("A");
      } }), 0);
    assert.deepEqual(phases, ["fix-dispatch:admission", "fix-dispatch:worker", "fix-dispatch:ci-wait"]);
    assert.equal(read(phased.dir).state, "done");

    // Work that throws is a failed status through the closed failure union.
    const boom = f.add("work-boom-1", review);
    assert.equal(await runChildMain(["--run-dir", boom.dir], { ...base, signals: noSignals,
      runDetachedWork: async () => { throw new Error("review blew up"); } }), 1);
    assert.equal(read(boom.dir).state, "failed");

    // A SIGTERM mid-work ends it as aborted at once, without waiting for the work.
    const term = f.add("work-term-1", review);
    const handlers: Array<() => void> = [];
    const signals = { on: (_s: "SIGTERM", h: () => void) => { handlers.push(h); }, off() {} };
    assert.equal(await runChildMain(["--run-dir", term.dir], { ...base, signals,
      runDetachedWork: () => { for (const h of handlers) h(); return new Promise<RunResult>(() => {}); } }), 3);
    assert.equal(read(term.dir).state, "aborted");
    assert.equal(read(term.dir).failure?.class, "aborted");
  } finally { f.cleanup(); }
});

test("W1-T9114: a boot adopts a live review child", async () => {
  const f = fixture();
  try {
    const child = f.add("work-review-A-1", review);
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
    assert.equal(f.rows.filter((r) => r.step === "run_child.adopted").length, 1);
    assert.equal(childWorkCount("review"), 1, "the live review child is registered with the sweep");
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

// The drain half is proved for BOTH moved kinds through the production host factory: a live review child and a live fix-dispatch child
// are adopted, and the restart returns while both still run. The title is the proof's verbatim grep target. The fix child is the one
// the sweep's governed producer spawns (see the producer test below); here it is the adopted half of the same contract.
test("W1-T9114: a restart does not drain child reviews or fix dispatches", async () => {
  await freshChildRestart();
  const f = fixture();
  try {
    const reviewDir = f.add("work-review-A-3", review);
    const fixDir = f.add("work-fix-A-3", fix, { phase: "fix-dispatch:worker" });
    const planPath = join(f.root, "tasks.yaml");
    writeFileSync(planPath, `- id: A\n  title: A\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n  files: [src/A.ts]\n`);
    // The ledger the placement reads: a review drain that waited, and a fix dispatch the drain had to abandon (which still does not move).
    const ledger = [JSON.stringify({ step: "daemon.freshness_drain.completed", duration_ms: 186_000, in_flight_reviews: 1, waited_on: [
      { what: "review", kind: "review", settled_after_ms: 120_000 }, { what: "detached", kind: "fix-dispatch", abandoned: true },
    ] })];
    // No `detachedWorkMode` and no `detachedWorkHosts` reach runDaemon: the placement is read from the host the daemon's sweep builder
    // installs, built here by the same factory production uses, so the drain's evidence has a producer.
    const drive = (mode: "on" | "off", bound?: number) => {
      installDetachedWorkHost(createDetachedWorkHost({
        stateRoot: f.stateRoot, repoDir: f.root, root: f.root, repo: "fixture", log: f.log, readLedger: () => [], readMode: () => mode,
      }));
      const rows: Array<Record<string, unknown>> = [];
      const daemon = runDaemon(loadPlan(planPath), {
        adoptRunChildren: f.adopt, refreshMerged: () => () => true, openPrCount: () => 0,
        runOne: async (id) => result(id), sleep: async () => { await flush(); },
        log: (step, fields) => { rows.push({ step, ...fields }); f.log(step, fields); },
        checkFreshness: (): DaemonFreshness => ({ stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40) }),
        sweep: async () => {}, sleepUntilSweepWake: async () => { await flush(); return "timeout"; }, sweepLight: async () => {},
        readLedgerLines: () => ledger,
      }, { laneCount: 1, wipLimit: 1, pollIntervalMs: 5, ...(bound === undefined ? {} : { sweepWallClockBoundMs: bound }) });
      return { daemon, rows };
    };
    const moved = drive("on");
    const summary = await moved.daemon;
    assert.equal(summary.stopReason, "stale", "the restart returned while the review and fix children still ran");
    const completed = moved.rows.find((r) => r.step === "daemon.freshness_drain.completed");
    assert.ok(completed, "the drain row is written for children alone");
    assert.deepEqual(completed.detached_children_left_running, { review: 1, "fix-dispatch": 1 });
    assert.equal(completed.in_flight_reviews, 0);
    assert.equal(completed.abandoned_in_flight_reviews, 0);
    assert.equal(completed.abandoned_detached_sweep_actions, 0);
    assert.equal((completed.detached_work_placement as Record<string, string>).review, "child");
    assert.equal((completed.detached_work_placement as Record<string, string>)["fix-dispatch"], "child", "the fix dispatch moved: the ledger measured its drain wait");
    assert.equal((completed.detached_work_placement as Record<string, string>).retro, "process");
    assert.equal(childWorkCount(), 2, "neither child was settled, aborted or waited for by the exit");
    assert.equal(childWorkCount("fix-dispatch"), 1);
    assert.equal(JSON.parse(readFileSync(join(reviewDir.dir, "status.json"), "utf8")).state, "running");
    assert.equal(JSON.parse(readFileSync(join(fixDir.dir, "status.json"), "utf8")).state, "running");
    assert.equal(reviewAdmissionBound(3).inFlight, 1, "a fix child holds a fix slot, never a review slot");

    // Control: the same boot with the mode off reads every kind as in process, and children adopted earlier are still left running and named.
    const off = drive("off");
    assert.equal((await off.daemon).stopReason, "stale");
    const offRow = off.rows.find((r) => r.step === "daemon.freshness_drain.completed");
    assert.equal((offRow?.detached_work_placement as Record<string, string>).review, "process");
    assert.equal((offRow?.detached_work_placement as Record<string, string>)["fix-dispatch"], "process");
    assert.deepEqual(offRow?.detached_children_left_running, { review: 1, "fix-dispatch": 1 });

    // Control: with no host installed at all (a daemon whose sweep builder was injected) every kind reads as in process.
    installDetachedWorkHost(undefined);
    const bare: Array<Record<string, unknown>> = [];
    const noHost = await runDaemon(loadPlan(planPath), {
      adoptRunChildren: f.adopt, refreshMerged: () => () => true, openPrCount: () => 0,
      runOne: async (id) => result(id), sleep: async () => { await flush(); },
      log: (step, fields) => { bare.push({ step, ...fields }); f.log(step, fields); },
      checkFreshness: (): DaemonFreshness => ({ stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40) }),
      sweep: async () => {}, sleepUntilSweepWake: async () => { await flush(); return "timeout"; }, sweepLight: async () => {},
      readLedgerLines: () => ledger,
    }, { laneCount: 1, wipLimit: 1, pollIntervalMs: 5 });
    assert.equal(noHost.stopReason, "stale");
    const bareRow = bare.find((r) => r.step === "daemon.freshness_drain.completed");
    assert.equal((bareRow?.detached_work_placement as Record<string, string>).review, "process");
  } finally { installDetachedWorkHost(undefined); f.cleanup(); }
});

test("W1-T9114: the completed drain counts children after settlements and new admissions", async () => {
  const f = fixture();
  let finishReview!: () => void;
  let finishNewReview!: () => void;
  let finishNewFix!: () => void;
  let finishProcess!: () => void;
  const oldReview = adoptChildWork({ runId: "old-review", taskId: "A", work: review,
    settled: new Promise<void>((resolve) => { finishReview = resolve; }) }, f.log);
  const processWork = new Promise<void>((resolve) => { finishProcess = resolve; });
  detachSweepAction(processWork, { actionKind: "fix-dispatch", taskId: "A", phase: "worker" });
  const newChildren: Promise<void>[] = [];
  try {
    const planPath = join(f.root, "tasks.yaml");
    writeFileSync(planPath, "[]");
    const summary = await runDaemon(loadPlan(planPath), {
      now: fixedClock(Date.parse("2026-10-12T12:00:00Z")).date,
      adoptRunChildren: () => [], refreshMerged: () => () => true, openPrCount: () => 0,
      runOne: async (id) => result(id), sleep: async () => { await flush(); },
      checkFreshness: (): DaemonFreshness => ({ stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40) }),
      sweep: async () => {}, sweepLight: async () => {}, sleepUntilSweepWake: async () => "timeout",
      log: (step, fields) => {
        f.log(step, fields);
        if (step !== "daemon.freshness_drain.started") return;
        assert.deepEqual(childWorkLeftRunning(), { review: 1 });
        finishReview();
        newChildren.push(adoptChildWork({ runId: "new-review", taskId: "A", work: { ...review, reviewKey: "new-review-key" },
          settled: new Promise<void>((resolve) => { finishNewReview = resolve; }) }, f.log));
        newChildren.push(adoptChildWork({ runId: "new-fix", taskId: "A", work: fix,
          settled: new Promise<void>((resolve) => { finishNewFix = resolve; }) }, f.log));
        void oldReview.then(finishProcess);
      },
    }, { laneCount: 1, wipLimit: 1, pollIntervalMs: 5 });
    assert.equal(summary.stopReason, "stale");
    const completed = f.rows.find((row) => row.step === "daemon.freshness_drain.completed");
    assert.ok(completed);
    assert.deepEqual(completed.detached_children_left_running, { review: 1, "fix-dispatch": 1 });
    assert.deepEqual(completed.detached_children_left_running, childWorkLeftRunning(), "the completed row describes the exit, not drain admission");
    assert.equal(f.rows.some(row => row.step === "daemon.child_work_settled" && row.run_id === "old-review"), true);
  } finally {
    finishReview(); finishProcess(); finishNewReview?.(); finishNewFix?.();
    await Promise.all([oldReview, ...newChildren]);
    await drainDetachedSweepActions();
    f.cleanup();
  }
});

test("W1-T9114: detached auto mode demotes on lost and misidentified children", async () => {
  const f = fixture();
  try {
    const healthy = [
      { step: "daemon.start", ts: "2026-10-12T12:00:00Z" },
      { step: "run_child.shadow", ts: "2026-10-12T12:01:00Z", contract: "ok", tree_peak_bytes: 100, class_estimate_bytes: 200 },
      { step: "daemon.start", ts: "2026-10-12T12:02:00Z" },
      { step: "run_child.adoption_pass", ts: "2026-10-12T12:02:01Z", live: 1, adopted: 1, misidentified: 0, unreadable: 0 },
    ];
    const mode = (rows: Array<Record<string, unknown>>) => detachedWorkModeNow(f.stateRoot, () => "auto", () => ({ rows, unread: [] }));
    assert.equal(mode(healthy), "on", "the ordinary boot-cycle evidence promotes detached work too");
    const promoted = [...healthy, { step: "run_child.mode_decision", ts: "2026-10-12T12:02:02Z", to: "on" }];
    assert.equal(mode(promoted), "on");
    for (const detail of ["process exited without a terminal status", "pid was reused by another process"]) {
      for (const ts of ["2026-10-12T12:01:30Z", "2026-10-12T12:02:03Z"]) {
        assert.equal(mode([...promoted, { step: "run_child.lost", ts, detail }]), "shadow", detail);
      }
    }
    assert.equal(mode([...promoted, { step: "run_child.adoption_pass", ts: "2026-10-12T12:02:04Z",
      live: 1, adopted: 0, misidentified: 1, unreadable: 0 }]), "shadow", "identity mismatches in adoption also demote");
    for (const detail of ["OOM kill", "container stopped"]) {
      assert.equal(mode([...promoted, { step: "run_child.lost", ts: "2026-10-12T12:02:03Z", detail }]), "on", "outside kills keep their existing classification");
    }
    mkdirSync(f.stateRoot, { recursive: true });
    const ledger = join(f.stateRoot, "ledger.ndjson");
    const writeRows = (rows: Array<Record<string, unknown>>) => writeFileSync(ledger, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const spawned: string[] = [];
    const host = createDetachedWorkHost({ stateRoot: f.stateRoot, repoDir: f.root, root: f.root, repo: "fixture", log: f.log,
      readMode: () => "auto", readLedger: () => [{ step: "daemon.freshness_drain.completed", duration_ms: 1_000, waited_on: [
        { what: "review", kind: "review", settled_after_ms: 1_000 }, { what: "detached", kind: "fix-dispatch", settled_after_ms: 1_000 },
      ] }],
      spawn: (async (input: { work?: DetachedWorkSpec }) => {
        spawned.push(input.work!.kind);
        return { started: true, runId: `auto-${input.work!.kind}`, dir: f.root, pid: 1,
          settled: Promise.resolve(result("A")), abort: async () => ({}) };
      }) as unknown as typeof spawnRunChild,
      probe: (async () => ({ started: false, reason: "fixture probe" })) as unknown as typeof startRunChildProbe,
    });
    const askBoth = async () => [
      await host.spawnReview({ pr: { prNumber: 7, headSha: review.headSha! }, reviewKey: "review-key", reviewAttemptId: undefined }),
      await host.spawnFix({ pr: { prNumber: 8, headSha: fix.headSha! }, fixKey: "fix-key", envelope: {} }),
    ];
    writeRows(promoted);
    assert.equal((await askBoth()).every(child => child !== undefined), true, "the production union admits both child kinds before loss");
    assert.deepEqual(spawned, ["review", "fix-dispatch"]);
    for (const detail of ["process exited without a terminal status", "pid was reused by another process"]) {
      writeRows([...promoted, { step: "run_child.lost", ts: "2026-10-12T12:02:03Z", detail }]);
      assert.equal(host.mode(), "shadow");
      assert.deepEqual(await askBoth(), [undefined, undefined], "neither review nor fix work moves after demotion");
      assert.deepEqual(spawned, ["review", "fix-dispatch"]);
    }
  } finally { f.cleanup(); }
});

test("W1-T9114: the production host starts a review as a child only where the ledger measured a drain wait", async () => {
  const f = fixture();
  try {
    const spawned: Array<{ taskId: string; lane?: string; work?: DetachedWorkSpec }> = [];
    const settled = Promise.resolve(result("A"));
    let spawnOutcome: "started" | "unavailable" = "started";
    const spawn = (async (input: { taskId: string; lane?: string; work?: DetachedWorkSpec }) => {
      spawned.push(input);
      return spawnOutcome === "started"
        ? { started: true, runId: "work-review-A-9", dir: f.root, pid: 1, settled, abort: async () => ({}) }
        : { started: false, reason: "no engine tree has been built yet" };
    }) as unknown as typeof spawnRunChild;
    let probes = 0;
    let endProbe: () => void = () => {};
    const probe = (() => { probes++; return new Promise((resolve) => { endProbe = () => resolve({ started: false, reason: "fixture" }); }); }) as unknown as typeof startRunChildProbe;
    const waited = [{ step: "daemon.freshness_drain.completed", duration_ms: 9_000, in_flight_reviews: 1, waited_on: [{ what: "review", kind: "review", settled_after_ms: 4_000 }] }];
    const host = (mode: "off" | "shadow" | "on", ledger: Array<Record<string, unknown>> = waited) => createDetachedWorkHost({
      stateRoot: f.stateRoot, repoDir: f.root, root: f.root, repo: "fixture", log: f.log, readLedger: () => ledger, readMode: () => mode, spawn, probe,
    });
    const ask = (h: ReturnType<typeof host>) => h.spawnReview({ pr: { prNumber: 7, headSha: "h".repeat(40), taskId: "A", isPlanFiling: true },
      reviewKey: "review-key-7", reviewAttemptId: "review-PR7-attempt" });

    assert.deepEqual([...HOSTED_DETACHED_WORK_KINDS], ["review", "fix-dispatch"], "a review and a fix dispatch have an entry");
    assert.deepEqual([...host("on").hosts], ["review", "fix-dispatch"]);

    const launched = await ask(host("on"));
    assert.equal(launched?.runId, "work-review-A-9");
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0]!.lane, "review", "the child reserves on the review class");
    assert.deepEqual(spawned[0]!.work, { kind: "review", prNumber: 7, headSha: "h".repeat(40), reviewKey: "review-key-7",
      inputs: { repo: "fixture", reviewAttemptId: "review-PR7-attempt", planOnlyFiling: true } });

    assert.equal(await ask(host("on", [])), undefined, "a review that never held a drain stays in process");
    assert.equal(await ask(host("off")), undefined);
    assert.equal(spawned.length, 1, "neither started a child");
    spawnOutcome = "unavailable";
    assert.equal(await ask(host("on")), undefined, "a child that cannot start leaves the review in process");
    assert.equal(spawned.length, 2);

    // Shadow: one probe at a time round-trips the contract; the review itself stays in process.
    const shadow = host("shadow");
    assert.equal(await ask(shadow), undefined);
    assert.equal(await ask(shadow), undefined);
    assert.equal(probes, 1, "a second review does not stack a second probe");
    endProbe();
    await flush();
    assert.equal(await ask(shadow), undefined);
    assert.equal(probes, 2);
    assert.equal(spawned.length, 2, "shadow never starts a work child");
    endProbe();

    // The mode is the policy's, and `auto` is decided on ledger evidence: with none it never reads as on.
    assert.equal(detachedWorkModeNow(f.stateRoot, () => "on"), "on");
    assert.equal(detachedWorkModeNow(f.stateRoot, () => "shadow"), "shadow");
    assert.equal(detachedWorkModeNow(f.stateRoot, () => "off"), "off");
    assert.notEqual(detachedWorkModeNow(f.stateRoot, () => "auto"), "on");
    assert.equal(detachedWorkModeNow(f.stateRoot, () => { throw new Error("policy unreadable"); }), "off");
    // An evidence read that throws under `auto` decides nothing: the work stays in process.
    let readAttempts = 0;
    assert.equal(detachedWorkModeNow(f.stateRoot, () => "auto", () => { readAttempts += 1; throw new Error("ledger union unreadable"); }), "off");
    assert.equal(readAttempts, 1, "the evidence read was attempted and its failure settled as off");

    // A fix dispatch starts as a child on the fix class's reservation, from the envelope alone, only where the ledger measured its wait.
    spawnOutcome = "started";
    const spawnedBefore = spawned.length;
    const fixWaited = [{ step: "daemon.freshness_drain.completed", duration_ms: 9_000, waited_on: [{ what: "detached", kind: "fix-dispatch", settled_after_ms: 6_000 }] }];
    const envelope = { schema: 1, fixKey: "A@" + "g".repeat(40) };
    const askFix = (h: ReturnType<typeof host>) => h.spawnFix({ pr: { prNumber: 8, headSha: "g".repeat(40), taskId: "A" }, fixKey: "A@" + "g".repeat(40), envelope });
    const fixLaunch = await askFix(host("on", fixWaited));
    assert.equal(fixLaunch?.runId, "work-review-A-9");
    assert.equal(spawned.length, spawnedBefore + 1);
    assert.equal(spawned.at(-1)!.lane, "sweep-fix", "the fix child reserves on the fix class");
    assert.deepEqual(spawned.at(-1)!.work, { kind: "fix-dispatch", prNumber: 8, headSha: "g".repeat(40), fixKey: "A@" + "g".repeat(40),
      inputs: { repo: "fixture", envelope } }, "the spec carries the typed envelope, never a claim, a function or a callback");
    assert.equal(await askFix(host("on", waited)), undefined, "a fix that never held a drain stays in process");
    assert.equal(await askFix(host("shadow", fixWaited)), undefined);
    assert.equal(await askFix(host("off", fixWaited)), undefined);
    assert.equal(spawned.length, spawnedBefore + 1, "none of those started a child");
    spawnOutcome = "unavailable";
    assert.equal(await askFix(host("on", fixWaited)), undefined, "a child that cannot start leaves the fix in process");
  } finally { f.cleanup(); }
});

test("W1-T9114: a review the sweep starts as a child is held by the registry and never run in process", async () => {
  const f = fixture();
  try {
    const config = { root: f.root, claudeBin: "/bin/true" } as Config;
    const plan: Plan = { tasks: [], byId: new Map() };
    const gateCalls: unknown[][] = [];
    const noop = (value?: unknown) => () => value;
    const host = {
      USAGE: "fixture usage", buildSweepEffects: noop(), buildInboxDraftHook: noop(), createPlanFilingClassificationTelemetry: noop(),
      buildEscalationTriageRuntime: noop(), refreshEscalationTriageEvidence: noop(), sweepPostFixReverification: noop({ results: [], total: 0, redriven: 0 }),
      tickReadReverificationDeps: noop({}), gitCredentialFixSpawn: noop(() => assert.fail("no fix spawn expected")),
      updatedForWorkflowFromLedger: noop(() => false), buildRereadPrAtAct: noop(), handedOffHeadRiskJudge: noop(), codeScanningJudgeDeps: noop({}),
      sweepEscalationReconcile: noop({}), sweepEscalationTriage: noop(), sweepPrTerminalRung: noop(), runAutomaticBranchReapRung: noop(),
      runTmpSweepRung: noop(), runWorkerTailSweepRung: noop(), runInflightLockSweepRung: noop(), runWorkerStallDetectorRung: noop(),
      runMountRecommenderRung: noop(), fixRungAllowedBesideInFlight: noop(true), inFlightTaskIdsFrom: () => [],
      blockedFixableIsRequeueOnly: () => false, lightPassActionable: () => false, reviewOnlyLightPassDeps: () => ({}),
      freshTreeGit: () => assert.fail("no fresh worktree requested"),
      realDeps: () => ({ reviewWorktree: { addWorktree: () => assert.fail("no review worktree requested") } }),
      buildFreshTreeReviewRunner: () => () => assert.fail("no fresh review requested"),
      buildReviewerCodeFreshnessGate: () => ({ call: (...args: unknown[]) => { gateCalls.push(args); return 17; }, staleThisPass: () => undefined }),
      buildBaseReproductionProbe: () => () => ({ reproduced: false }), buildImportClosureRead: () => () => [],
      buildRequiredFixReviewRunner: () => () => 0, readyDraftViaGh: () => () => {},
    } as unknown as SweepCommandHost & Required<Pick<SweepCommandHost, "freshTreeGit">>;
    const deps: BuildSweepEffectsDeps = {
      owner: "acme", repo: "fixture", localRepoName: "fixture", config, ledgerPath: join(f.root, "state", "ledger.ndjson"),
      runId: "SWEEP-CHILD", plan, log: f.log,
    };
    const effects = buildSweepEffects(host, { ...deps, reviewerCodeFreshnessImpl: () => ({ status: "unreadable", reason: "fixture" }) as never,
      instanceRegistryTextImpl: () => undefined });
    const pr: OpenPrView = {
      prNumber: 9114, prUrl: "https://github.com/acme/fixture/pull/9114", headSha: "a".repeat(40), headRefName: "run-W1-T9114-1",
      taskId: "W1-T9114", reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
      lastActivityAt: new Date().toISOString(),
    };
    let finish!: () => void;
    const settled = new Promise<RunResult>((resolve) => { finish = () => resolve(result("W1-T9114")); });
    const asked: Array<{ reviewKey: string; reviewAttemptId: string | undefined; prNumber: number }> = [];
    installDetachedWorkHost({
      hosts: new Set(["review"]), mode: () => "on",
      spawnReview: async ({ pr: asking, reviewKey, reviewAttemptId }) => {
        asked.push({ reviewKey, reviewAttemptId, prNumber: asking.prNumber });
        return { runId: "work-review-W1-T9114-1", settled };
      },
    });

    await effects.postReview!(pr, { kind: "full-review" }, "review-PR9114-attempt");
    assert.equal(gateCalls.length, 0, "the review did not run in this process");
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.prNumber, 9114);
    assert.equal(asked[0]!.reviewAttemptId, "review-PR9114-attempt");
    assert.equal(childWorkCount("review"), 1, "the registry holds the child's slot");
    assert.equal(childWorkHoldsReviewKey(asked[0]!.reviewKey), true, "and its mutex key, so the PR is not re-admitted under it");
    assert.equal(reviewAdmissionBound(1).bound, 0);
    assert.equal(f.rows.some((r) => r.step === "sweep.post_review.child" && r.child_run_id === "work-review-W1-T9114-1"), true);

    // A reuse review is not a full review: it stays in process and never asks the host.
    await effects.postReview!(pr, { kind: "discriminate-only", judgedHeadSha: "b".repeat(40) });
    assert.equal(asked.length, 1);
    assert.equal(gateCalls.length, 1);

    // The child ends: slot and key are released, and the next pass re-admits the PR.
    finish();
    for (let i = 0; i < 400 && childWorkCount("review") > 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(childWorkCount("review"), 0);
    assert.equal(childWorkHoldsReviewKey(asked[0]!.reviewKey), false);
    assert.equal(reviewAdmissionBound(1).bound, 1);
  } finally { installDetachedWorkHost(undefined); f.cleanup(); }
});

test("W1-T9114: the run path exports runDetachedWork, which refuses work no entry hosts", async () => {
  const f = fixture();
  try {
    // Through the child's entry, with the child's own default loader of the real run path (this suite does not import it): a kind
    // nothing hosts, and a fix whose spec carries no readable envelope, are each a failed status, never a success.
    const argv = [...process.argv];
    process.argv.push("--repo-root", REPO_ROOT);
    const drive = async (id: string, work: DetachedWorkSpec): Promise<{ code: number; status: RunChildStatus }> => {
      const child = f.add(id, work);
      const code = await runChildMain(["--run-dir", child.dir], { env: {}, stderr: () => {}, heartbeatMs: 60_000, signals: { on() {}, off() {} } });
      const status = readStatus(child.dir);
      assert.ok(status.ok);
      return { code, status: status.value };
    };
    try {
      const unhosted = await drive("work-retro-1", { kind: "retro" });
      assert.equal(unhosted.code, 1);
      assert.equal(unhosted.status.state, "failed");
      assert.match(JSON.stringify(unhosted.status), /hosts no detached work of kind retro/);

      const unread = await drive("work-fix-1", fix);
      assert.equal(unread.code, 1, "an unread envelope is a refusal, not a dispatch");
      assert.equal(unread.status.state, "failed");
      assert.match(JSON.stringify(unread.status), /no readable decision envelope/);
    } finally { process.argv.splice(0, process.argv.length, ...argv); }
  } finally { f.cleanup(); }
});

const FIX_TASK = "W1-T5882";
const FIX_HEAD = "9c0fa1b0aa";
const FIX_BRANCH = "run-W1-T5882-1791200000000";
const UNMET = [{ claim: "a criterion", proof: "unit test: x", met: false, reason: "not done", proof_exec: "not_executable" as const }];
const fixPr = (over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: 9379, prUrl: "https://github.com/craigoley/remudero/pull/9379", taskId: FIX_TASK, reviewState: "failure", checksState: "green",
  unmetCriteria: UNMET, priorStrikes: 0, lastActivityAt: "2026-10-05T22:00:00Z", headSha: FIX_HEAD, headRefName: FIX_BRANCH, autoMergeArmed: false, ...over,
});

test("W1-T9114: a fix dispatch the sweep decides is spawned as a child before any claim and held by the registry", async () => {
  resetChildWork();
  const dir = mkdtempSync(join(tmpdir(), "rmd-fix-producer-"));
  try {
    const appended: Array<Record<string, unknown>> = [];
    const logged: Array<Record<string, unknown>> = [];
    // The task's earlier head's dispatch keeps the no-dispatch re-arm from firing, as in the sweep's own detached-dispatch fixtures.
    const seed = [{ step: "fix.dispatch", task_id: FIX_TASK, head_sha: "81c30d80bb" }];
    let inProcess = 0;
    const deps = (over: Partial<SweepDeps> = {}): SweepDeps => ({
      arm: () => {}, close: () => {}, escalate: () => {}, runId: "SWEEP-W1-T9114", now: () => Date.parse("2026-10-05T23:00:00Z"),
      ledgerPath: join(dir, "ledger.ndjson"), readLedger: () => [...seed, ...appended], appendLine: (_path, row) => { appended.push(row); },
      log: (step, extra) => { logged.push({ step, ...extra }); }, detachFixWait: true,
      dispatchFix: () => { inProcess += 1; }, ...over,
    });
    const asked: Array<{ pr: { prNumber: number; headSha: string; taskId?: string }; fixKey: string; envelope: FixDispatchEnvelope }> = [];
    let refuse!: (error: Error) => void;
    const settled = new Promise<RunResult>((_resolve, reject) => { refuse = reject; });
    const spawnFix = async (input: (typeof asked)[number]) => {
      asked.push(input);
      return { runId: "work-fix-W1-T5882-1", settled };
    };
    installDetachedWorkHost({ hosts: new Set(["review", "fix-dispatch"]), mode: () => "on", spawnReview: async () => undefined, spawnFix });

    await runSweep([fixPr()], deps());
    await drainDetachedSweepActions();
    assert.equal(inProcess, 0, "the dispatch did not run in this process, so no fix-branch claim was taken here");
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0]!.pr, { prNumber: 9379, headSha: FIX_HEAD, taskId: FIX_TASK });
    const envelope = asked[0]!.envelope;
    assert.equal(asked[0]!.fixKey, `${FIX_TASK}@${FIX_HEAD}`);
    assert.equal(envelope.fixKey, asked[0]!.fixKey);
    assert.deepEqual(envelope.evidence.unmetCriteria, UNMET, "the judged evidence rides the envelope");
    assert.equal(envelope.pr.headSha, FIX_HEAD);
    assert.equal("progressJudge" in envelope.evidence, false, "no function crosses the boundary");
    assert.deepEqual(JSON.parse(JSON.stringify(envelope)), envelope, "the envelope is plain JSON");
    assert.deepEqual(readFixDispatchEnvelope(JSON.parse(JSON.stringify(envelope))), envelope, "the child's reader takes what the producer built");
    assert.equal(detachedSweepActionCount(), 0, "a restart's drain has nothing in process to wait for");
    assert.deepEqual(childWorkLeftRunning(), { "fix-dispatch": 1 });
    assert.equal(logged.some((r) => r.step === "sweep.fix.child" && r.child_run_id === "work-fix-W1-T5882-1"), true);

    // The registry holds the mutex key: another pass under a fresh ledger is refused the PR while the child runs.
    const other: Array<Record<string, unknown>> = [];
    await runSweep([fixPr()], deps({ readLedger: () => seed, appendLine: (_path, row) => { other.push(row); } }));
    const reason = String(other.filter((r) => r.step === "sweep.disposed").at(-1)?.stand_down_reason);
    assert.match(reason, /duplicate fix-dispatch key/);
    assert.equal(asked.length, 1);
    assert.equal(inProcess, 0);

    // A child that refuses ends as lost: its key is released once, and the dedup is voided exactly as a detached rejection voids it.
    refuse(new Error("fix dispatch refused: the PR head moved"));
    for (let i = 0; i < 400 && childWorkCount("fix-dispatch") > 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(childWorkCount(), 0);
    const failed = logged.filter((r) => r.step === "sweep.fix.dispatch_failed");
    assert.equal(failed.length, 1);
    assert.deepEqual({ pr: failed[0]!.pr_number, head: failed[0]!.head_sha, run: failed[0]!.child_run_id }, { pr: 9379, head: FIX_HEAD, run: "work-fix-W1-T5882-1" });
    assert.match(String(failed[0]!.error), /head moved/);

    // Control: a mode that is not on, or a host that declines, leaves the dispatch in process and in the registry a restart drains.
    installDetachedWorkHost({ hosts: new Set(["review", "fix-dispatch"]), mode: () => "off", spawnReview: async () => undefined, spawnFix });
    await runSweep([fixPr({ headSha: "f00dfacecc" })], deps());
    await drainDetachedSweepActions();
    assert.equal(inProcess, 1);
    installDetachedWorkHost({ hosts: new Set(["review", "fix-dispatch"]), mode: () => "on", spawnReview: async () => undefined, spawnFix: async () => undefined });
    await runSweep([fixPr({ headSha: "0ddba11000" })], deps());
    await drainDetachedSweepActions();
    assert.equal(inProcess, 2, "a child that cannot start leaves the dispatch in process");
  } finally { installDetachedWorkHost(undefined); resetChildWork(); rmSync(dir, { recursive: true, force: true }); }
});

test("W1-T9114: abandoned child fix admission never falls back in process and releases the producer claim", async () => {
  const f = fixture();
  let finish!: (value: RunResult) => void;
  const settled = new Promise<RunResult>((resolve) => { finish = resolve; });
  try {
    const clock = fixedClock(Date.parse("2026-10-05T23:00:00Z"));
    const appended: Array<Record<string, unknown>> = [];
    const seed = [{ step: "fix.dispatch", task_id: FIX_TASK, head_sha: "81c30d80bb" }];
    let inProcess = 0;
    let heldCapacity = 0;
    let releasedCapacity = 0;
    let attempts = 0;
    let hold: "STOP" | "PAUSE" | undefined;
    const spawn = (async () => {
      attempts += 1;
      return hold === undefined
        ? { started: true, runId: "work-fix-admitted", dir: f.root, pid: 1, settled, abort: async () => ({}) }
        : { started: false, abandoned: true, reason: "admission-abandoned", runId: `work-fix-withheld-${hold}`, waitedMs: 23 };
    }) as unknown as typeof spawnRunChild;
    installDetachedWorkHost(createDetachedWorkHost({
      stateRoot: f.stateRoot, repoDir: f.root, root: f.root, repo: "fixture", log: f.log, readMode: () => "on", spawn,
      readLedger: () => [{ step: "daemon.freshness_drain.completed", duration_ms: 1_000,
        waited_on: [{ what: "detached", kind: "fix-dispatch", settled_after_ms: 1_000 }] }],
    }));
    const deps: SweepDeps = {
      arm: () => {}, close: () => {}, escalate: () => {}, runId: "SWEEP-W1-T9114", now: () => clock.now(),
      ledgerPath: join(f.stateRoot, "ledger.ndjson"), readLedger: () => [...seed, ...appended],
      appendLine: (_path, row) => { appended.push(row); }, log: f.log, detachFixWait: true,
      dispatchFix: () => { inProcess += 1; },
      claimFixAdmission: () => {
        assert.equal(heldCapacity, 0, "the previous attempt released its host slot");
        heldCapacity += 1;
        return { admitted: true, release: () => { heldCapacity -= 1; releasedCapacity += 1; } };
      },
    };
    for (const control of ["STOP", "PAUSE"] as const) {
      hold = control;
      await runSweep([fixPr()], deps);
      await drainDetachedSweepActions();
      assert.equal(inProcess, 0, `${control}: withheld child admission cannot authorize an in-process worker`);
      assert.equal(heldCapacity, 0, `${control}: the producer releases its capacity`);
      assert.equal(detachedSweepActionCount(), 0, `${control}: nothing is left for a restart to drain`);
      assert.equal(childWorkCount(), 0, `${control}: no child was registered as successful`);
      const refusal = appended.findLast(row => row.step === "sweep.fix.dispatch_failed");
      assert.equal(refusal?.reason, "admission-abandoned");
      assert.equal(refusal?.head_sha, FIX_HEAD);
      assert.equal(refusal?.admission_waited_ms, 23);
    }
    assert.equal(attempts, 2, "the same head is re-admitted after abandonment, without resetting retry state");
    hold = undefined;
    await runSweep([fixPr()], deps);
    await drainDetachedSweepActions();
    assert.equal(attempts, 3, "lifting the hold re-admits the unchanged head through the production host");
    assert.equal(inProcess, 0);
    assert.equal(releasedCapacity, 3, "both abandoned attempts and the successful handoff release the producer slot");
    assert.equal(childWorkCount("fix-dispatch"), 1);
    assert.equal(detachedSweepActionCount(), 0, "the admitted fix remains a child across a restart");
    assert.equal(appended.some(row => row.step === "fix.dispatch" || row.step === "fix.done"), false,
      "the producer spends no fix round on an abandoned launch");
  } finally {
    finish(result(FIX_TASK));
    await flush();
    installDetachedWorkHost(undefined);
    f.cleanup();
  }
});

test("W1-T9114: the fix child rechecks, dispatches through the sweep's own dispatchFix and refuses what it cannot read", async () => {
  const envelope = buildFixDispatchEnvelope(fixPr(), { unmetCriteria: UNMET, progressJudge: (() => { throw new Error("never serialized"); }) as never },
    { fixKey: `${FIX_TASK}@${FIX_HEAD}`, decidedAtMs: 1, planContextDigest: "digest-1" });
  const live = { state: "OPEN", merged: false, headSha: FIX_HEAD };
  const task = { found: true as const, merged: false, retired: false, contextDigest: "digest-1" };
  const judge = (() => {}) as never;
  const harness = (over: Partial<FixDispatchChildPorts> & { dispatch?: SweepDeps["dispatchFix"] } = {}) => {
    const calls: Array<{ pr: OpenPrView; evidence: Parameters<SweepDeps["dispatchFix"]>[1] }> = [];
    const rows: Array<Record<string, unknown>> = [];
    const phases: string[] = [];
    let built = 0;
    const deps: FixDispatchChildPorts = {
      hold: () => undefined, readLivePr: async () => live, readTask: () => task, log: (step, extra) => { rows.push({ step, ...extra }); },
      onPhase: (phase) => { phases.push(phase); },
      dispatcher: () => { built += 1; return { dispatchFix: over.dispatch ?? (async (pr, evidence, onPhase) => { onPhase?.("admission"); onPhase?.("worker"); calls.push({ pr, evidence }); }), fixProgressJudge: judge }; },
      ...over,
    };
    return { deps, calls, rows, phases, built: () => built };
  };
  const wire = (): Record<string, unknown> => ({ envelope: JSON.parse(JSON.stringify(envelope)) });

  const ok = harness();
  await runFixDispatchChild(wire(), ok.deps);
  assert.equal(ok.calls.length, 1, "the child called the sweep's own dispatchFix once");
  assert.equal(ok.calls[0]!.pr.headSha, FIX_HEAD);
  assert.deepEqual(ok.calls[0]!.evidence.unmetCriteria, UNMET);
  assert.equal(ok.calls[0]!.evidence.progressJudge, judge, "the judge is the child's own, rebuilt there");
  assert.deepEqual(ok.phases, ["admission", "worker"], "the phases reach the owned status sink");
  assert.deepEqual(ok.rows.filter((r) => r.step === "sweep.fix.child_phase").map((r) => r.phase), ["admission", "worker"]);

  const refusals: Array<[string, Partial<FixDispatchChildPorts> & { dispatch?: SweepDeps["dispatchFix"] }, RegExp, Record<string, unknown>?]> = [
    ["a fleet hold", { hold: () => "STOP: operator" }, /admission is held: STOP/],
    ["an unreadable PR", { readLivePr: async () => undefined }, /live state could not be read/],
    ["a merged PR", { readLivePr: async () => ({ ...live, merged: true }) }, /no longer open \(merged\)/],
    ["a closed PR", { readLivePr: async () => ({ ...live, state: "CLOSED" }) }, /no longer open \(CLOSED\)/],
    ["a moved head", { readLivePr: async () => ({ ...live, headSha: "f00dfacecc" }) }, /head moved/],
    ["a merged task", { readTask: () => ({ ...task, merged: true }) }, /already merged/],
    ["a retired task", { readTask: () => ({ ...task, retired: true }) }, /is retired/],
    ["a changed canonical context", { readTask: () => ({ ...task, contextDigest: "digest-2" }) }, /canonical context changed/],
    ["a vanished task", { readTask: () => ({ found: false as const }) }, /canonical context changed/],
    ["an unreadable plan", { readTask: () => { throw new Error("plan unreadable"); } }, /could not read its evidence \(plan unreadable\)/],
    ["a throwing live read", { readLivePr: async () => { throw new Error("gh down"); } }, /could not read its evidence \(gh down\)/],
    ["a reconstruction that throws", { dispatcher: () => { throw new Error("no credentials"); } }, /could not be reconstructed \(no credentials\)/],
    ["a declined claim", { dispatch: () => ({ claimDeclined: true, ownerRecoveryReason: "owner_remove_failed" }) }, /declined at the checkout claim/],
    ["an unread envelope", {}, /no readable decision envelope/, { envelope: { schema: 2 } }],
    ["no envelope", {}, /no readable decision envelope/, {}],
  ];
  for (const [name, over, pattern, inputs] of refusals) {
    const h = harness(over);
    await assert.rejects(runFixDispatchChild(inputs ?? wire(), h.deps), pattern, name);
    assert.equal(h.calls.length, 0, `${name}: nothing was dispatched`);
    if (inputs === undefined && name !== "a reconstruction that throws" && name !== "a declined claim") {
      assert.equal(h.built(), 0, `${name}: the live dependencies were not even rebuilt`);
    }
    if (inputs === undefined && name !== "a declined claim") {
      assert.equal(h.rows.some((r) => r.step === "sweep.fix.child_refused"), true, `${name}: the refusal is ledgered`);
    }
  }
});

test("W1-T9114: the run path maps live PR evidence and reads the canonical task before fix dispatch", async () => {
  const f = fixture();
  const argv = [...process.argv];
  process.argv.push("--repo-root", REPO_ROOT);
  try {
    const { runDetachedWork, GitFetchError } = await import("#src/run-task.js");
    const planPath = join(f.root, "tasks.yaml");
    const task = { id: FIX_TASK, title: "fix child fixture", repo: "remudero", type: "implement", verify: "auto",
      depends_on: [], status: "queued", files: ["src/lib/sweep.ts"], design: "the original canonical design" };
    const writePlan = (over: Record<string, unknown> = {}) => writeFileSync(planPath, JSON.stringify([{ ...task, ...over }]));
    writePlan();
    const envelope = buildFixDispatchEnvelope(fixPr(), { unmetCriteria: UNMET }, {
      fixKey: `${FIX_TASK}@${FIX_HEAD}`, decidedAtMs: 1,
      planContextDigest: riskJudgePlanContextDigestFor(loadPlan(planPath))({ taskId: FIX_TASK }),
    });
    const work: DetachedWorkSpec = { ...fix, inputs: { envelope } };
    const ctx = { taskId: FIX_TASK, runId: "work-fix-runtime-1" };
    const reads: string[][] = [];
    const dispatched: OpenPrView[] = [];
    let built = 0;
    let live: unknown = { state: "OPEN", mergedAt: null, headRefOid: FIX_HEAD };
    let taskMerged = false;
    let boardUnreadable = false;
    const winner = { number: 9380, url: "https://github.com/craigoley/remudero/pull/9380", state: "MERGED" as const, merged: true };
    const github = fakeGitHub({
      findMergedByTrailer: () => taskMerged ? winner : null,
      listMergedHeadBranches: () => taskMerged ? [winner] : [],
      listOpenHeadBranches: () => [],
      headRefName: () => `${FIX_BRANCH}-winner`,
      prBody: () => `Remudero-Task: ${FIX_TASK}`,
      readFailed: () => boardUnreadable,
    });
    let planReads = 0;
    const ports = {
      planPath, planSnapshot: (options: { allowStale?: boolean }) => {
        planReads += 1;
        assert.equal(options.allowStale, false, "a detached fix must refuse when the canonical plan cannot refresh");
        return { plan: loadPlan(planPath), staleDispatch: false };
      },
      config: { root: f.root, claudeBin: "/bin/true" } as Config, github, hold: () => undefined, log: f.log,
      readPr: async (args: string[]) => { reads.push(args); return live; },
      dispatcher: () => {
        built += 1;
        return { dispatchFix: async (pr: OpenPrView) => { dispatched.push(pr); } };
      },
    };

    assert.deepEqual(await runDetachedWork(work, ctx, ports), { ...ctx, merged: false, verdict: "no_pr", costUsd: 0 });
    assert.deepEqual(reads, [["pr", "view", envelope.pr.prUrl, "--json", "state,mergedAt,headRefOid"]]);
    assert.equal(built, 1);
    assert.deepEqual(dispatched, [envelope.pr]);
    assert.equal(planReads, 1, "the dispatcher and recheck share this dispatch's one fresh plan");

    const refused = async (reason: RegExp) => {
      await assert.rejects(runDetachedWork(work, ctx, ports), reason);
      assert.equal(built, 1, "a refused recheck never reconstructs the dispatcher");
      assert.equal(dispatched.length, 1, "a refused recheck never dispatches a fix");
      assert.match(String(f.rows.at(-1)?.reason), reason);
      assert.equal(f.rows.at(-1)?.step, "sweep.fix.child_refused");
    };
    live = { state: "OPEN", mergedAt: "2026-10-01T00:00:00Z", headRefOid: FIX_HEAD };
    await refused(/no longer open \(merged\)/);
    live = { state: "CLOSED", mergedAt: "", headRefOid: FIX_HEAD };
    await refused(/no longer open \(CLOSED\)/);
    live = { state: "OPEN", headRefOid: "new-head" };
    await refused(/head moved from .* to new-head/);
    live = { state: "OPEN", headRefOid: null };
    await refused(/head moved from .* to an unreadable head/);
    live = {};
    await refused(/live state could not be read/);
    live = { state: "OPEN", mergedAt: "", headRefOid: FIX_HEAD };

    boardUnreadable = true;
    await refused(/merge projection is unreadable/);
    boardUnreadable = false;

    writeFileSync(planPath, "[]");
    await refused(/canonical context changed/);
    writePlan({ status: "blocked", retirement: "retired" });
    await refused(/is retired/);
    writePlan({ design: "the canonical design changed after the producer decided" });
    await refused(/canonical context changed/);
    writeFileSync(planPath, "not: [valid yaml");
    await refused(/could not read its evidence/);
    writePlan();
    await assert.rejects(runDetachedWork(work, ctx, { ...ports, readPr: async () => { throw new Error("fixture PR read failed"); } }),
      /could not read its evidence \(fixture PR read failed\)/);
    assert.equal(built, 1);
    assert.equal(dispatched.length, 1);

    await assert.rejects(runDetachedWork(work, ctx, { ...ports, planSnapshot: () => { throw new GitFetchError("fixture plan refresh failed"); } }),
      /could not read its evidence.*fixture plan refresh failed/);
    assert.equal(built, 1);
    assert.equal(dispatched.length, 1);

    for (const status of ["merged", "done"]) {
      writePlan({ status });
      await runDetachedWork(work, ctx, ports);
    }
    assert.equal(dispatched.length, 3, "YAML completion decorations cannot manufacture GitHub merge credit");
    assert.equal(built, 3);
    writePlan();
    taskMerged = true;
    await assert.rejects(runDetachedWork(work, ctx, ports), /already merged/);
    assert.equal(dispatched.length, 3, "another PR's actual merge prevents dispatch");
    assert.equal(built, 3, "a merged task never reconstructs the dispatcher");
    assert.equal(loadPlan(planPath).byId.get(FIX_TASK)?.status, "queued", "the queued YAML cannot overrule another PR's merge credit");
    assert.equal(github.calls.some(call => call.method === "listMergedHeadBranches"), true, "the child refreshed the board-wide merge projection");
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    f.cleanup();
  }
});

test("W1-T9114: the fix run path reads real fleet holds and ledgers each refusal", async () => {
  const f = fixture();
  const savedHome = process.env.HOME;
  const argv = [...process.argv];
  process.argv.push("--repo-root", REPO_ROOT);
  process.env.HOME = f.root;
  try {
    const { runDetachedWork } = await import("#src/run-task.js");
    mkdirSync(join(f.root, ".config", "remudero"), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ root: f.root, claudeBin: "/bin/true" }));
    mkdirSync(f.stateRoot, { recursive: true });
    const requestedAt = "2026-10-12T00:00:00Z";
    writeFileSync(join(f.stateRoot, "STOP"), JSON.stringify({ requestedAt, reason: "stop fixture" }));
    writeFileSync(join(f.stateRoot, "PAUSE"), JSON.stringify({ requestedAt, reason: "pause fixture" }));
    const envelope = buildFixDispatchEnvelope(fixPr(), { unmetCriteria: UNMET }, {
      fixKey: `${FIX_TASK}@${FIX_HEAD}`, decidedAtMs: 1,
    });
    const work: DetachedWorkSpec = { ...fix, inputs: { envelope } };
    let liveReads = 0;
    let dispatchers = 0;
    const ports = {
      readPr: async () => { liveReads += 1; throw new Error("held work must not read the PR"); },
      dispatcher: () => { dispatchers += 1; throw new Error("held work must not reconstruct a dispatcher"); },
    };
    for (const [runId, reason] of [
      ["work-fix-stop", "STOP: STOP requested: stop fixture"],
      ["work-fix-pause", "PAUSE: PAUSE requested: pause fixture; actor: actor unrecorded"],
    ] as const) {
      const ctx = { taskId: FIX_TASK, runId };
      await assert.rejects(runDetachedWork(work, ctx, ports), { message: `fix dispatch refused: worker admission is held: ${reason}` });
      const rows = readFileSync(ledgerPathFor({ root: f.root }), "utf8").trim().split("\n").map(line => JSON.parse(line));
      const row = rows.at(-1);
      assert.equal(rows.length, runId === "work-fix-stop" ? 1 : 2);
      assert.deepEqual({ run_id: row.run_id, task_id: row.task_id, lane: row.lane, step: row.step,
        pr_number: row.pr_number, head_sha: row.head_sha, reason: row.reason }, {
        run_id: runId, task_id: FIX_TASK, lane: "sweep-fix", step: "sweep.fix.child_refused",
        pr_number: envelope.pr.prNumber, head_sha: FIX_HEAD, reason: `worker admission is held: ${reason}`,
      });
      rmSync(join(f.stateRoot, "STOP"), { force: true });
    }
    assert.equal(liveReads, 0, "both real holds refuse before reading live PR evidence");
    assert.equal(dispatchers, 0, "both real holds refuse before reconstructing the claim-taking dispatcher");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    process.argv.splice(0, process.argv.length, ...argv);
    f.cleanup();
  }
});
