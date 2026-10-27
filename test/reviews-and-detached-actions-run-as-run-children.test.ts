import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";

import { REPO_ROOT } from "#test/helpers/repo-root.js";
import type { Config } from "#src/lib/config.js";
import { runDaemon, type DaemonFreshness } from "#src/lib/daemon.js";
import { defaultInstance } from "#src/lib/host-memory-ledger.js";
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
  adoptChildWork, childWorkCount, childWorkHoldsReviewKey, childWorkLeftRunning, installDetachedWorkHost, resetChildWork, reviewAdmissionBound,
  type BuildSweepEffectsDeps, type DetachedActionKind, type OpenPrView,
} from "#src/lib/sweep.js";
import type { SweepCommandHost } from "#src/cli/commands/sweep.js";

// Avoid the argv module's checkout discovery: these fixtures do not need a git executable.
const savedArgv = [...process.argv];
process.argv.push("--repo-root", REPO_ROOT);
const { buildSweepEffects } = await import("#src/cli/commands/sweep.js");
const { runDetachedWork } = await import("#src/run-task.js");
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
  assert.deepEqual(moved(on()), ["review"], "only the review moves: a fix dispatch is deferred out of this task");
  const fixPlacement = detachedWorkPlacement("fix-dispatch", on());
  assert.equal(fixPlacement.placement, "process");
  assert.match(fixPlacement.reason, /deferred out of W1-T9114/, "the table says why the fix dispatch stays in process");
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
      runDetachedWork: async (work, ctx) => { seen.push(work, ctx); return result("A"); } }), 0);
    assert.deepEqual(seen, [review, { runId: "work-ok-1", taskId: "A" }]);
    assert.equal(read(ok.dir).state, "done");
    assert.equal(read(ok.dir).phase, "done");

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

// Narrowed per the operator (W1-T78): the drain half is proved for REVIEW children only, through the production host factory.
// Fix-dispatch drain is out of scope for this PR (no production producer spawns a fix child); the test asserts it stays in process.
test("W1-T9114: a restart does not drain child reviews or fix dispatches — only reviews move, fix dispatch is deferred", async () => {
  const f = fixture();
  try {
    const reviewDir = f.add("work-review-A-3", review);
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
    assert.equal(summary.stopReason, "stale", "the restart returned while the review child still ran");
    const completed = moved.rows.find((r) => r.step === "daemon.freshness_drain.completed");
    assert.ok(completed, "the drain row is written for children alone");
    assert.deepEqual(completed.detached_children_left_running, { review: 1 });
    assert.equal(completed.in_flight_reviews, 0);
    assert.equal(completed.abandoned_in_flight_reviews, 0);
    assert.equal(completed.abandoned_detached_sweep_actions, 0);
    assert.equal((completed.detached_work_placement as Record<string, string>).review, "child");
    // A fix dispatch's inputs are in-process claims no spec can carry, so nothing spawns one as a child: it stays in process
    // (and the drain waits for it) under the moved mode. That drain is out of this task's scope; a follow-up moves it.
    assert.equal((completed.detached_work_placement as Record<string, string>)["fix-dispatch"], "process");
    assert.equal((completed.detached_work_placement as Record<string, string>).retro, "process");
    assert.equal(childWorkCount(), 1, "the review child was not settled, aborted or waited for by the exit");
    assert.equal(JSON.parse(readFileSync(join(reviewDir.dir, "status.json"), "utf8")).state, "running");

    // Control: the same boot with the mode off reads every kind as in process, and a child adopted earlier is still left running and named.
    const off = drive("off");
    assert.equal((await off.daemon).stopReason, "stale");
    const offRow = off.rows.find((r) => r.step === "daemon.freshness_drain.completed");
    assert.equal((offRow?.detached_work_placement as Record<string, string>).review, "process");
    assert.deepEqual(offRow?.detached_children_left_running, { review: 1 });

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

    assert.deepEqual([...HOSTED_DETACHED_WORK_KINDS], ["review"], "only the review has an entry: a fix dispatch's inputs are in-process claims");
    assert.deepEqual([...host("on").hosts], ["review"]);

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
    assert.equal(typeof runDetachedWork, "function");
    await assert.rejects(() => runDetachedWork(fix, { runId: "r", taskId: "A" }), /hosts no detached work of kind fix-dispatch/);
    await assert.rejects(() => runDetachedWork({ kind: "review" }, { runId: "r", taskId: "A" }), /without a PR number/);
    // Through the child's entry, with the real run path's export: a kind nothing hosts is a failed status, never a success.
    const unhosted = f.add("work-fix-1", fix);
    assert.equal(await runChildMain(["--run-dir", unhosted.dir], { env: {}, stderr: () => {}, heartbeatMs: 60_000, signals: { on() {}, off() {} },
      loadRunPath: async () => ({ runDetachedWork }) }), 1);
    const status = readStatus(unhosted.dir);
    assert.ok(status.ok);
    assert.equal(status.value.state, "failed");
  } finally { f.cleanup(); }
});
