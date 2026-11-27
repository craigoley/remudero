// W1-T14916: since W1-T14873 a retiring daemon releases its drain lock before its SRE lane page settles. On 2026-11-26
// the retired process then ran 14 sweep passes and started 18 workers over 34 minutes, beside its successor.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { closeDaemonCleanup, createDaemonRetirement, inDaemonSpawnScope, retiringCiJudgeKick } from "#src/cli/commands/daemon.js";
import { CI_JUDGE_HEADS_FILE, judgeCiEscalation, productionCiJudgePorts, withCiJudgeAfterSweep } from "#src/lib/ci-escalation-judge.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LearnedReservation } from "#src/lib/host-memory-learning.js";
import { spawnRunChild } from "#src/lib/run-child.js";
import { captureInboxDraftSnapshot, commitInboxDraftOutcomes, draftsDueOnDaemon, runDraftRung, type DraftLaneIdentity, type Proposal } from "#src/lib/inbox.js";
import { resolveFleetControlHold, type LightPassScope, type RestartAdmission } from "#src/lib/daemon.js";
import { createClaudeExecutableCache, runInWorkerSpawnScope, spawnWorker, workerSpawnRetiredBy, WorkerNotStartedError, WorkerSpawnRetiredError, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
import { spawnCodexWorker, spawnOpenWeightWorker } from "#src/lib/worker-provider.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { installDetachedWorkHost, type DetachedWorkHost, type OpenPrView } from "#src/lib/sweep.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { answerThread, realThreadDecider, type InboxThreadItem } from "#src/lib/inbox-responder.js";
import { appendThreadMessage, inboxThreadId, inboxThreadIdentity, readAllThreads } from "#src/lib/inbox-thread.js";
import { runAlertLane, type AlertLaneAlert, type AlertPolicy } from "#src/lib/alert-lane.js";
import { productionFixProgressJudge, trackRepairLadder } from "#src/lib/sweep.js";
import { buildFixProgressInput, judgeFixProgress } from "#src/lib/fix-progress-judge.js";
import { claudeCapacityFromUsage, ProviderCapacityBlockedError, readRepairLadderState } from "#src/lib/worker-provider.js";
import { judgeVerifyHumanShard, realVerifyHumanJudge, type ShardUnderJudgement } from "#src/lib/verify-human-judge.js";
import { verifyHumanCadence } from "#src/lib/measurement-cadence.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { realDecisionSummarizer } from "#src/lib/feedback.js";
import { writePlainMessage } from "#src/lib/inbox-plain.js";
import { runInboxGardener, type InboxGardenerCandidate, type InboxGardenerPack, type InboxGardenerPorts } from "#src/lib/inbox-gardener.js";
import { inboxGardenerRunTaskPorts } from "#src/lib/inbox-gardener-runtime.js";
import { proofDebtPopulationPermit, readInboxGardenerStore, stampMechanicalAsk, type InboxGardenerScope } from "#src/lib/inbox-retirement.js";
import { fixedClock } from "#src/lib/clock.js";

// The shared run-task test helper, not a direct src/run-task.ts import (the affected-suite reach ratchet bounds direct importers).
import { buildSweepEffects, codeScanningJudgeDeps, dispatchAlertFixRun, dispatchMainRepairFixRun, mainRepairLaneFor, runFixRung, runReview, type AlertFixDispatchDeps } from "#test/helpers/run-task-test.js";
import { CODE_SCANNING_FIX_STEP, runSweep, type SweepDeps } from "#test/helpers/sweep-test.js";
import type { Plan, Task } from "#src/lib/plan.js";

type Row = { step: string } & Record<string, unknown>;

/** A retiring exit with its SRE lane page still in flight, and the hooks that start sweep passes and workers. */
function retiringExit() {
  const rows: Row[] = [];
  const started: string[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}) => { rows.push({ step, ...extra }); };
  const retirement = createDaemonRetirement(log);
  const sweep = retirement.refuse("sweep", async () => { started.push("sweep_pass"); return { swept: true }; });
  const sweepLight = retirement.refuse("sweep_light", () => { started.push("light_pass"); });
  const autoTriage = retirement.refuse("auto_triage", async (feedbackId: string) => { started.push(`worker:${feedbackId}`); });
  let settlePage: () => void = () => {};
  let pageDone = false;
  const page = new Promise<void>((resolve) => { settlePage = () => { pageDone = true; resolve(); }; });
  let lockReleased = false;
  const exit = () => closeDaemonCleanup(
    [{ resource: "drain_lock", close: () => { lockReleased = true; } }, { resource: "stop_marker", close: () => {} }],
    log, { now: () => 0 }, [{ resource: "sre_lane_page", settled: page }], retirement.retire,
  );
  return { rows, started, retirement, sweep, sweepLight, autoTriage, settlePage, exit,
    pageDone: () => pageDone, lockReleased: () => lockReleased };
}

/** A drafter start as the inbox draft rung makes it, with a provider seam that counts real starts. */
function drafterStart(t: TestContext, withheld: Array<Record<string, unknown>>, starts: string[]): SpawnWorkerArgs {
  const root = ownedFixtureDir(t, "retired-spawn").dir;
  return { cwd: root, permissionMode: "bypassPermissions", settingsFile: join(REPO_ROOT, "settings/worker.json"),
    config: { root, claudeBin: "/unused", dailyCapUsd: 25 }, model: "haiku", effort: "low", tools: ["Read"],
    workerClass: "review", prompt: "draft a proposal", taskId: "FB-DRAFT",
    admitWorkerMemory: async () => { starts.push("memory_admission"); return { kind: "admitted", tier: "fits", waitedMs: 0, attempts: 1 }; },
    logWorkerSpawnWithheld: (row) => withheld.push(row),
    providerRouting: { writeStatus: () => {}, spawnCodex: async () => { starts.push("drafter_worker"); throw new Error("started"); } } };
}

/** A detached run child whose memory reservation is held open until `admit()`, as sweep.ts launches reviews and fixes. */
function runChildStart(t: TestContext, duringPin: () => void = () => {}) {
  const root = ownedFixtureDir(t, "retired-run-child").dir;
  const state = join(root, "state");
  const sha = "b".repeat(40);
  const hash = "a".repeat(64);
  mkdirSync(join(state, "engines", hash), { recursive: true });
  writeFileSync(join(state, "engines", hash, "engine.json"), JSON.stringify({ sha, sourceHash: hash, builtAt: Date.now() }));
  const rows: Row[] = [];
  const spawned: string[] = [];
  const released: string[] = [];
  let admit: () => void = () => {};
  const reserved = new Promise<void>((resolve) => { admit = resolve; });
  const handle = { id: "reservation-1", workerClass: "review", estimateMib: 1, estimateSource: "default", bindRoot: () => {},
    releaseOccupancy: () => { released.push("reservation-1"); } } as unknown as LearnedReservation;
  const launch = () => spawnRunChild({
    taskId: "T-1", stateRoot: state, repoDir: root, root,
    options: { skipGitSync: false, handOffAtPrOpen: true, pairedTrialHost: "daemon" as const },
    plan: async () => ({ plan: { tasks: [{ id: "T-1", title: "t", repo: "remudero", depends_on: [], type: "implement",
      verify: "auto", status: "queued" }] } }) as never,
    log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); },
  }, { mainSha: async () => sha, engine: { isCurrent: () => true }, watch: false, pollMs: 60_000,
    reserve: async () => { await reserved; return handle; }, workerAdmissionHold: () => undefined,
    enginePin: { clock: clockFromMillisFn(() => { duringPin(); return Date.now(); }) },
    spawn: () => { spawned.push("run_child"); return Object.assign(new EventEmitter(), { pid: 424_242, unref() {} }) as never; } });
  const runDirs = (): string[] => existsSync(join(state, "runs")) ? readdirSync(join(state, "runs")) : [];
  return { rows, spawned, released, admit: () => admit(), launch, runDirs };
}

/** An in-process Codex fix start; `duringPreparation` runs after memory admission, before the provider launch. */
function codexFixStart(t: TestContext, withheld: Array<Record<string, unknown>>, starts: string[],
  duringAdmission: () => void, duringPreparation: () => void): SpawnWorkerArgs {
  const root = ownedFixtureDir(t, "retired-codex").dir;
  const result: WorkerResult = { provider: "codex", sessionId: "fixture-session", text: "done", blocks: [], stderr: "",
    isError: false, apiError: false, subtype: "success", costUsd: 0, numTurns: 1, permissionDenials: [], childEnvKeys: [],
    model: "fixture", effort: "low", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false };
  return { cwd: root, permissionMode: "bypassPermissions", settingsFile: join(REPO_ROOT, "settings/worker.json"),
    config: { root, claudeBin: "/unused", dailyCapUsd: 25, workerProviders: { enabled: ["claude", "codex", "cash"],
      cashFallbackWhenBlocked: true, cashEndpoint: "https://foundry.example.test/" } },
    model: "haiku", effort: "low", tools: ["Read", "Write", "Edit"], workerClass: "fix", memoryShadow: {},
    mountProvider: "codex", prompt: "fix the finding", taskId: "W1-T14916", runId: "W1-T14916-fixture",
    admitWorkerMemory: async () => { duringAdmission(); return { kind: "admitted", tier: "fits", waitedMs: 0, attempts: 1 }; },
    readWorkerAdmissionHold: () => { duringPreparation(); return undefined; },
    logWorkerSpawnWithheld: (row) => withheld.push(row),
    providerRouting: { writeStatus: () => {}, spawnCodex: async () => { starts.push("codex_worker"); return result; } },
    claudeExecutable: { cache: createClaudeExecutableCache(), deps: { env: { RMD_CLAUDE_BIN: "/fixture/claude" }, home: root,
      exists: () => true, which: () => "/fixture/claude", canExecute: () => true, locations: [] } },
    keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({
      claudeAiOauth: { accessToken: "fixture-only", expiresAt: Date.now() + 3_600_000 } }) },
  };
}

const turns = async (n: number) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker", async (t) => {
  const run = retiringExit();
  assert.deepEqual(await run.sweep(), { swept: true }, "before the release a sweep pass runs as before");
  await run.sweepLight();
  await run.autoTriage("FB-1");
  assert.deepEqual(run.started, ["sweep_pass", "light_pass", "worker:FB-1"]);

  const exit = run.exit();
  await turns(5);
  assert.ok(run.lockReleased() && !run.pageDone(), "the lock is released while the page is still in flight");
  assert.equal(run.retirement.retired(), true, "the release retires the process");
  assert.equal(await run.sweep(), undefined, "a sweep pass after the release starts nothing");
  assert.equal(await run.sweepLight(), undefined, "a light pass after the release starts nothing");
  assert.equal(await run.autoTriage("FB-2"), undefined, "a worker after the release is not spawned");
  assert.deepEqual(run.started, ["sweep_pass", "light_pass", "worker:FB-1"], "nothing new started after the release");
  assert.deepEqual(run.rows.filter((row) => row.step === "daemon.retired_start_refused").map((row) => row.hook),
    ["sweep", "sweep_light", "auto_triage"], "each refusal is ledgered with the hook it refused");
  run.settlePage();
  await exit;

  // A full sweep and a latched light pass that were already running when the lock was released.
  const late = retiringExit();
  const spawned: string[] = [];
  let finishSweep: () => void = () => {};
  const sweepGate = new Promise<void>((resolve) => { finishSweep = resolve; });
  const withheld: Array<Record<string, unknown>> = [];
  let drafted: Awaited<ReturnType<typeof spawnWorker>> | undefined;
  const admissionHold = () => late.retirement.admissionHold(() => resolveFleetControlHold({}));
  // daemonCommand runs runDaemon, and so every pass, in the retirement's spawn scope.
  const inFlightSweep = late.retirement.inSpawnScope(() => late.retirement.refuse("sweep", withCiJudgeAfterSweep(async () => {
    await sweepGate;
    if (admissionHold() === undefined) spawned.push("fix_worker");
    // The inbox draft rung calls spawnWorker with no admission hold of its own (cli/commands/sweep.ts).
    drafted = await spawnWorker(drafterStart(t, withheld, spawned));
  }, retiringCiJudgeKick(late.retirement, () => { spawned.push("ci_judge_worker"); })))());
  const latch: RestartAdmission = Object.assign(() => true, { heldBy: undefined });
  const scope = late.retirement.lightPassScope<LightPassScope>({ reviewOnly: true, admit: latch });
  assert.equal(scope.admit?.("review", "light"), true, "before the release the latched pass admits its review");
  const lateExit = late.exit();
  await turns(5);
  finishSweep();
  await inFlightSweep;
  assert.deepEqual(spawned, [], "a sweep that settles after the release spawns no fix, CI judge or drafter worker");
  assert.equal(drafted?.notStarted, "admission-abandoned", "the drafter start returns not-started");
  assert.deepEqual(withheld, [{ step: "worker.spawn_withheld", task_id: "FB-DRAFT",
    hold: "retired: drain lock released; the successor owns this work" }], "the spawn path ledgers why it withheld the start");
  assert.deepEqual(admissionHold(), { control: "STOP", detail: "retired: drain lock released; the successor owns this work" });
  assert.equal(scope.admit?.("review", "light"), false, "a light pass still running admits no new review worker");
  assert.equal(scope.admit?.heldBy, "retired: drain lock released; the successor owns this work", "its stand-down names why");
  assert.deepEqual(late.rows.filter((row) => row.step === "daemon.retired_start_refused").map((row) => row.hook),
    ["ci_judge_kick", "light_pass_admission"]);
  late.settlePage();
  await lateExit;

  // A review admitted before the release launches a detached run child, and its memory wait outlasts the release.
  const child = runChildStart(t);
  const waiting = retiringExit();
  const launched = waiting.retirement.inSpawnScope(() => child.launch());
  await turns(5);
  const waitingExit = waiting.exit();
  await turns(5);
  child.admit();
  const outcome = await launched;
  assert.equal(outcome.started, false, "a run child whose wait ends after the release does not start");
  assert.equal("abandoned" in outcome && outcome.abandoned, true, "the caller treats it as not started, never in process");
  assert.deepEqual(child.spawned, [], "no child process is spawned");
  assert.deepEqual(child.released, ["reservation-1"], "the admitted reservation is released");
  assert.equal(child.rows.find((row) => row.step === "run_child.spawn_withheld")?.hold,
    "retired: drain lock released; the successor owns this work", "the launch gate ledgers why it withheld the child");
  waiting.settlePage();
  await waitingExit;

  // The release can also land while the child waits for its engine pin, after that gate: the spawn reads the mark again.
  const pinning = retiringExit();
  const pinned = runChildStart(t, () => pinning.retirement.retire());
  pinned.admit();
  const pinOutcome = await pinning.retirement.inSpawnScope(() => pinned.launch());
  assert.equal(pinOutcome.started, false, "a release during the engine pin starts no child");
  assert.deepEqual(pinned.spawned, []);
  assert.deepEqual(pinned.released, ["reservation-1"]);
  assert.deepEqual(pinned.runDirs(), [], "the prepared run directory is removed");
  assert.equal(pinned.rows.find((row) => row.step === "run_child.spawn_withheld")?.hold,
    "retired: drain lock released; the successor owns this work");

  // In process, the release can land during memory admission or during provider preparation; each is read again.
  for (const when of ["admission", "preparation"] as const) {
    const run = retiringExit();
    const starts: string[] = [];
    const rows: Array<Record<string, unknown>> = [];
    const retire = () => run.retirement.retire();
    let prepared = 0;
    const outcome = await run.retirement.inSpawnScope(() => spawnWorker(codexFixStart(t, rows, starts,
      when === "admission" ? retire : () => {}, () => { prepared++; if (when === "preparation") retire(); })));
    assert.equal(prepared, when === "admission" ? 0 : 1, `a release during ${when} is refused before the next step`);
    assert.equal(outcome.notStarted, "admission-abandoned", `a release during ${when} starts no worker`);
    assert.deepEqual(starts, [], `no provider launch after a release during ${when}`);
    assert.deepEqual(rows.map((row) => row.hold), ["retired: drain lock released; the successor owns this work"]);
  }
  // A Claude start reads it once more just before its SDK query, after the egress broker and policy waits.
  const claude = retiringExit();
  const queried: string[] = [];
  const claudeRows: Array<Record<string, unknown>> = [];
  const { mountProvider: _codexMount, providerRouting: _codexRouting, ...claudeBase } =
    codexFixStart(t, claudeRows, queried, () => {}, () => {});
  const claudeOutcome = await claude.retirement.inSpawnScope(() => spawnWorker({ ...claudeBase,
    config: { root: claudeBase.config!.root, claudeBin: "/unused", dailyCapUsd: 25 },
    queryFn: (() => { queried.push("claude_query"); throw new Error("started"); }) as never,
    // The broker start is the last wait before the query; the release lands inside it.
    egress: { mode: "observe", checkVersion: () => "fixture", startProxy: async () => {
      claude.retirement.retire();
      return { httpProxyPort: 1, socksProxyPort: 2, close: async () => {} } as never;
    } } }));
  assert.deepEqual(queried, [], "no SDK query after a release during the Claude launch preparation");
  assert.equal(claudeOutcome.notStarted, "admission-abandoned");
  assert.deepEqual(claudeRows.map((row) => row.hold), ["retired: drain lock released; the successor owns this work"]);
  // The real adapters read it after their own last waits (the Codex worktree probe, the open-weight registry
  // invocation), before any trial receipt, cash reservation or process.
  const adapters = retiringExit();
  adapters.retirement.retire();
  const adapterArgs = { ...codexFixStart(t, [], [], () => {}, () => {}), workerHome: ownedFixtureDir(t, "retired-home").dir };
  await adapters.retirement.inSpawnScope(async () => {
    await assert.rejects(spawnCodexWorker(adapterArgs, adapterArgs.config!), WorkerSpawnRetiredError,
      "the real Codex adapter launches no process for a retired scope");
  });
  // The cash adapters (open-weight and Foundry Claude) read it in the transport, after its last wait and before the
  // first request reserves budget. Here the release lands inside the adapter, once the transport has started.
  const cashEnv = { RMD_OPENWEIGHT_API_KEY: "test-only-key", RMD_FOUNDRY_CLAUDE_API_KEY: "test-only-key",
    RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://foundry.example.test/anthropic" };
  for (const model of ["gpt-6-luna", "claude-haiku-5-5"]) {
    // The control run counts the clock reads up to the request; the last is the dispatch callback's own deadline check,
    // queued a microtask after the transport's first refusal check. "gap" lands the release on exactly that read.
    let readsAtSend = 0;
    for (const release of ["none", "first", "gap"] as const) {
      const cash = retiringExit();
      const root = ownedFixtureDir(t, "retired-cash").dir;
      let sent = 0, reads = 0;
      const launch = cash.retirement.inSpawnScope(() => spawnOpenWeightWorker({ cwd: root, workerHome: root, prompt: "classify",
        env: cashEnv, clock: clockFromMillisFn(() => {
          reads++;
          if (release === "first" || (release === "gap" && reads === readsAtSend)) cash.retirement.retire();
          return Date.now();
        }),
        fetchImpl: async () => { if (sent++ === 0 && release === "none") readsAtSend = reads; return new Response(JSON.stringify(model.startsWith("claude-")
          ? { id: "m-1", model, stop_reason: "end_turn", content: [{ type: "text", text: "done" }], usage: { input_tokens: 2, output_tokens: 1 } }
          : { id: "c-1", model, choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } }),
        { status: 200 }); } },
      { root, claudeBin: "/unused", dailyCapUsd: 25, workerProviders: { cashEndpoint: "https://openai.example.test/" } }, { model, effort: "low" }));
      if (release !== "none") await assert.rejects(launch, WorkerSpawnRetiredError, `${model} ${release}: a release inside the adapter sends no request`);
      else assert.equal((await launch).isError, false, `${model}: control, with no release the request is sent`);
      assert.equal(sent, release === "none" ? 1 : 0, `${model} ${release}: requests sent`);
      const allowance = join(root, "state", "openweight-allowance.json");
      if (release === "gap") {
        // The gap release lands after the first reservation: it settles as known-unbilled, never held against the cap.
        const rows = Object.values((JSON.parse(readFileSync(allowance, "utf8")) as { reservations: Record<string, Record<string, unknown>> }).reservations);
        assert.equal(rows.length, 1, `${model}: the one reserved attempt`);
        assert.deepEqual(rows.map((row) => [row.accountingState, row.settledUsd, row.heldUsd]), [["known-unbilled", 0, 0]], `${model}: unsent reservation settles`);
      }
      if (release === "none") assert.ok(readsAtSend > 1, `${model}: the control saw the clock reads before its request`);
    }
  }
  // spawnWorker turns an adapter's refusal into the not-started result and its withheld row.
  const viaAdapter = retiringExit();
  const adapterRows: Array<Record<string, unknown>> = [];
  const refused = await viaAdapter.retirement.inSpawnScope(() => spawnWorker({ ...codexFixStart(t, adapterRows, [], () => {}, () => {}),
    providerRouting: { writeStatus: () => {}, spawnCodex: async () => { throw new WorkerSpawnRetiredError("adapter saw the release"); } } }));
  assert.equal(refused.notStarted, "admission-abandoned");
  assert.deepEqual(adapterRows.map((row) => row.hold), ["retired: adapter saw the release"]);
  // Control: with no release the same start reaches its provider, so the refusals above are the mark's doing.
  const control = retiringExit();
  const controlStarts: string[] = [];
  await control.retirement.inSpawnScope(() => spawnWorker(codexFixStart(t, [], controlStarts, () => {}, () => {})));
  assert.deepEqual(controlStarts, ["codex_worker"]);

  // The retirement belongs to that daemon's scope: a start outside it (the next daemon in a pooled process, or a
  // direct spawn) still reaches memory admission.
  const outside: string[] = [];
  const outsideWithheld: Array<Record<string, unknown>> = [];
  const elsewhere = await spawnWorker({ ...drafterStart(t, outsideWithheld, outside),
    admitWorkerMemory: async () => { outside.push("memory_admission"); return { kind: "abandoned", reason: "admission-abandoned", waitedMs: 0, attempts: 1 }; } });
  assert.deepEqual(outside, ["memory_admission"], "a spawn outside the retired scope is not withheld");
  assert.deepEqual(outsideWithheld, []);
  assert.equal(elsewhere.notStarted, "admission-abandoned");
});

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker, in the whole run", async () => {
  // daemonCommand runs its whole body in inDaemonSpawnScope. The GitHub wake is wired before the retirement and the
  // loop exist; the main-health repair it schedules runs later and must see the release.
  let afterRelease: () => void = () => {};
  const released = new Promise<void>((resolve) => { afterRelease = resolve; });
  let seenByCallback: Promise<string | undefined> | undefined;
  await inDaemonSpawnScope(async () => {
    seenByCallback = released.then(() => workerSpawnRetiredBy());
    const run = retiringExit();
    run.settlePage();
    await run.exit();
  });
  const outside = released.then(() => workerSpawnRetiredBy());
  afterRelease();
  assert.equal(await seenByCallback, "drain lock released; the successor owns this work",
    "work a callback wired before the loop schedules sees the retired scope, so it starts no worker");
  assert.equal(await outside, undefined, "the caller of the daemon run is outside its scope");
  // The mark lands in the same synchronous step as the drain lock release: work queued at the release sees it.
  const rows: Row[] = [];
  const marked = createDaemonRetirement((step, extra = {}) => { rows.push({ step, ...extra }); });
  let seenAtRelease: boolean | undefined;
  await closeDaemonCleanup([{ resource: "drain_lock", close: () => { queueMicrotask(() => { seenAtRelease = marked.allows("sweep"); }); } }],
    () => {}, { now: () => 0 }, [], marked.retire);
  assert.equal(seenAtRelease, false, "a microtask queued by the release already sees the retirement");
  // A daemon run nested in a scope already open (the standby and registry re-entries) keeps that one scope.
  await inDaemonSpawnScope(async () => {
    const outer = workerSpawnRetiredBy;
    await inDaemonSpawnScope(async () => { createDaemonRetirement(() => {}).retire(); });
    assert.equal(outer(), "drain lock released; the successor owns this work");
  });
});

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker, and a withheld draft stays due", async (t) => {
  // An inbox draft rung already running at the release reaches the real spawnWorker, which returns not-started. The
  // proposal must stay due for the successor: no attempt key is written for work that never ran.
  const lane: DraftLaneIdentity = { leadDeployment: "gpt-oss-120b", effort: "high", escalationDeployment: "sonnet", escalationEffort: "medium" };
  const proposal: Proposal = { id: "P-14916", summary: "a withheld draft stays due",
    evidenceAnchors: [{ pattern: "draft input", path: "README.md", description: "fixture anchor" }] };
  const scope = { repository: "o/r" };
  const ranWithoutDraft = { sessionId: "fixture", costUsd: 0, numTurns: 1, text: "no fragment", blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], provider: "cash", model: "gpt-oss-120b",
    servedModel: "gpt-oss-120b", effort: "high", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
    compactionEvents: [], qualitySuspect: false } as WorkerResult;
  for (const retired of [true, false]) {
    const stateDir = ownedFixtureDir(t, "retired-draft-state").dir;
    writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [proposal] }));
    const withheld: Array<Record<string, unknown>> = [];
    const starts: string[] = [];
    const rows: Array<Record<string, unknown>> = [];
    const run = () => runDraftRung([proposal], "- id: W1-T1\n", { causalScope: scope, log: (step, extra) => rows.push({ step, ...extra }),
      spawn: async () => retired ? spawnWorker(drafterStart(t, withheld, starts)) : ranWithoutDraft }, "retired-draft");
    const outcomes = retired ? await runInWorkerSpawnScope({ retiredBy: "drain lock released; the successor owns this work" }, run) : await run();
    commitInboxDraftOutcomes({ stateDir, scope, snapshots: [captureInboxDraftSnapshot(proposal, scope)], outcomes, lane, log: () => {} });
    const attempts = existsSync(join(stateDir, "inbox-draft-attempts.json"))
      ? JSON.parse(readFileSync(join(stateDir, "inbox-draft-attempts.json"), "utf8")) as Record<string, string> : {};
    const due = draftsDueOnDaemon([proposal], {}, attempts, 3, undefined, lane).map((p) => p.id);
    if (retired) {
      assert.deepEqual(starts, [], "the retired scope starts no draft worker");
      assert.equal(withheld.length, 1);
      assert.deepEqual(due, ["P-14916"], "the withheld draft keys no attempt, so it stays due");
    } else {
      // Control: a draft that ran and wrote no fragment keys its attempt, so the proposal is no longer due.
      assert.deepEqual(due, [], "a draft that really ran keys its attempt");
    }
  }
});

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker, and a withheld CI judgment stays due", async (t) => {
  // A judge kick started just before the release reaches the real spawnWorker in the retired scope, which returns
  // not-started. The head must stay due for the successor, which shares the state dir.
  for (const retired of [true, false]) {
    const stateDir = ownedFixtureDir(t, "retired-ci-judge").dir;
    const rows: Row[] = [];
    let posts = 0;
    const production = productionCiJudgePorts({ owner: "fixture", repo: "fixture", repoRoot: REPO_ROOT, stateDir, log: () => {},
      spawn: async (args) => retired ? spawnWorker(args) : { ...(await runInWorkerSpawnScope({ retiredBy: "control" }, () => spawnWorker(args))),
        notStarted: undefined, text: JSON.stringify({ add: [], escalateFull: false, reason: "floor is sufficient" }) } });
    const pass = () => judgeCiEscalation({ stateDir, openPrs: async () => [{ number: 7, headSha: "head-7" }],
      changedFiles: async () => ["src/example.ts"], diff: async () => "diff", floor: () => ({ suites: [], fullRun: false }),
      suiteIds: () => [], judge: production.judge, post: async () => { posts++; },
      log: (step, extra = {}) => { rows.push({ step, ...extra }); } });
    const result = retired ? await runInWorkerSpawnScope({ retiredBy: "drain lock released; the successor owns this work" }, pass) : await pass();
    const heads = JSON.parse(readFileSync(join(stateDir, CI_JUDGE_HEADS_FILE), "utf8")) as Record<string, string>;
    if (retired) {
      assert.deepEqual(heads, {}, "the withheld judgment records no head, so the head stays due");
      assert.deepEqual(rows.map((row) => row.step), [], "no failure row: nothing ran");
      assert.deepEqual([result.judged, result.failed, posts], [[], [], 0]);
    } else {
      // Control: a judgment that ran records its head and posts.
      assert.deepEqual(heads, { 7: "head-7" });
      assert.deepEqual([result.judged, posts], [[7], 1]);
    }
  }
});

test("W1-T14916 criterion 2: in-flight SRE lane page work still completes", async () => {
  const run = retiringExit();
  let passDone = false;
  let finishPass: () => void = () => {};
  const inFlightPass = run.retirement.refuse("sweep", () => new Promise<void>((resolve) => {
    finishPass = () => { passDone = true; resolve(); };
  }))();
  let exited = false;
  const exit = run.exit().then(() => { exited = true; });
  await turns(5);
  assert.equal(run.retirement.retired(), true);
  assert.equal(exited, false, "the exit still waits for the in-flight page");
  finishPass();
  await inFlightPass;
  assert.equal(passDone, true, "a pass that started before the release still finishes");
  run.settlePage();
  await exit;
  assert.equal(run.pageDone(), true, "the in-flight page settled");
  assert.ok(run.rows.some((row) => row.step === "daemon.exit_after_release"), "the page's settle is still timed");
});

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker, " +
  "and a review admitted before the release neither falls back in-process nor claims the head", async (t: TestContext) => {
  const root = ownedFixtureDir(t, "retired-review").dir;
  const ledgerPath = join(root, "ledger.ndjson");
  const RETIRED = "drain lock released; the successor owns this work";
  // The reviewer's snapshot is materialized from this checkout, so the fixture PR's head is the checkout's own HEAD.
  const head = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const pr = { prNumber: 7, prUrl: "https://github.com/acme/remudero/pull/7", headSha: head, isPlanFiling: false,
    reviewState: "none", checksState: "green", unmetCriteria: [], priorStrikes: 0, lastActivityAt: "2026-11-26T20:00:00Z",
    autoMergeArmed: false, body: "" } as unknown as OpenPrView;

  // The sweep's post-review effect: the installed host withholds its child because the release lands in its wait.
  const sweepRun = async (retireAt: "before" | "spawn" | "never") => {
    const steps: string[] = [];
    let inProcess = 0;
    const scope: { retiredBy?: string } = retireAt === "before" ? { retiredBy: RETIRED } : {};
    installDetachedWorkHost({ hosts: new Set(["review"]), mode: () => "on",
      spawnReview: async () => { if (retireAt === "spawn") scope.retiredBy = RETIRED; return undefined; } } as unknown as DetachedWorkHost);
    try {
      const effects = buildSweepEffects({ owner: "acme", repo: "remudero", localRepoName: "not-remudero", config: { root } as never,
        ledgerPath, runId: "retired-review", plan: { tasks: [], byId: new Map() } as never,
        log: (step) => steps.push(step),
        reviewRunner: async () => { inProcess++; return 0; } });
      await runInWorkerSpawnScope(scope, () => withLiveWritesAllowed(() => effects.postReview!(pr)));
    } finally {
      installDetachedWorkHost(undefined);
    }
    return { steps: steps.filter((step) => step.startsWith("sweep.post_review")), inProcess };
  };
  assert.deepEqual(await sweepRun("before"), { steps: [], inProcess: 0 }, "a retired daemon writes no attempt and runs no review");
  assert.deepEqual(await sweepRun("spawn"), { steps: ["sweep.post_review.attempt", "sweep.post_review.done"], inProcess: 0 },
    "a child withheld by the release never becomes an in-process review");
  assert.deepEqual(await sweepRun("never"), { steps: ["sweep.post_review.attempt", "sweep.post_review.done"], inProcess: 1 },
    "control: a live daemon with no child runs the review in process");

  // The review command itself: a retired scope stands down before its pending claim and records no withheld attempt.
  const shim = ghShim([
    // CI's proof record answers slowly, as on a loaded host, so a read the stand-down left running would outlive it.
    { when: "proof-discrimination-gate", stdout: JSON.stringify({ workflow_runs: [] }), delaySeconds: 1 },
    { when: "/statuses?", stdout: "[[]]" },
    { when: "pulls/", stdout: JSON.stringify({ number: 7, html_url: pr.prUrl, updated_at: "t", body: "", state: "open",
      head: { ref: "run-W1-T90007-1", sha: pr.headSha } }) },
    { when: "/status", stdout: JSON.stringify({ state: "pending", statuses: [] }) },
  ], { kind: "t14916-review" });
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const reviewLedger = join(root, "review-ledger.ndjson");
  const priorPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${priorPath ?? ""}`;
  try {
    const result = await runInWorkerSpawnScope({ retiredBy: RETIRED }, () => withLiveWritesAllowed(() => runReview({
      owner: "acme", repo: "remudero", prUrl: pr.prUrl, task: { id: "W1-T90007", acceptance: [{ claim: "c", proof: "grep: x y" }] },
      report: "", settingsFile: join(root, "settings.json"), config: { claudeBin: "/bin/true", root } as never,
      log: (step: string, extra: Record<string, unknown> = {}) => appendLedger(reviewLedger, { run_id: "R", task_id: "W1-T90007", step, ...extra }),
      say: () => {}, account: (r: WorkerResult) => r, spawnReviewer: false, readReviewReuseFacts: () => undefined,
      disarm: () => "not-armed" as const, arm: async () => "armed" as const, ledgerPath: reviewLedger, runId: "R",
    } as never)));
    assert.equal(result.reviewerOutcome, "not_attempted_retired");
    const rows = readLedgerLines(reviewLedger);
    assert.deepEqual(rows.map((row) => row.step), ["review.stood_down"]);
    assert.match(String(rows[0]?.reason), /^retired: drain lock released/);
    assert.equal(shim.calls().some((call) => call.includes("context=remudero-review")), false, "no pending claim is posted");

    // Released after the claim, while the reviewer waits for admission: the withheld reviewer settles the claim and
    // records no withheld attempt (review.semantic_incomplete), so the withheld-review ladder does not move.
    const midLedger = join(root, "mid-ledger.ndjson");
    const scope: { retiredBy?: string } = {};
    const midRun = await runInWorkerSpawnScope(scope, () => withLiveWritesAllowed(() => runReview({
      owner: "acme", repo: "remudero", prUrl: pr.prUrl,
      task: { id: "W1-T90007", acceptance: [{ claim: "a claim", proof: "unit test: no-such-test-title-t14916" }] },
      report: "nothing", settingsFile: join(root, "settings.json"), config: { claudeBin: "/bin/true", root } as never,
      log: (step: string, extra: Record<string, unknown> = {}) => appendLedger(midLedger, { run_id: "MID", task_id: "W1-T90007", step, ...extra }),
      say: () => {}, account: (r: WorkerResult) => r, spawnReviewer: true,
      reviewerSpawnWorker: async () => {
        scope.retiredBy = RETIRED;
        return { notStarted: "admission-abandoned", subtype: "admission_abandoned", text: "", blocks: [] } as unknown as WorkerResult;
      },
      reviewerMount: { model: "sonnet", provider: "claude", effort: "medium", maxTurns: 10, contextBudget: 120000 },
      disarm: () => {}, headCheckoutDir: REPO_ROOT, ledgerPath: midLedger, runId: "MID",
    } as never)));
    assert.equal(midRun.reviewerOutcome, "not_attempted_retired", JSON.stringify(readLedgerLines(midLedger).map((r) => [r.step, r.error ?? r.reason])));
    const midSteps = readLedgerLines(midLedger).map((row) => String(row.step));
    assert.equal(midSteps.includes("review.semantic_incomplete"), false, midSteps.join(", "));
    assert.equal(midSteps.includes("review.posted"), false);
    assert.equal(midSteps.at(-1), "review.stood_down");
    // Every gh read the stand-down started has settled before it returned, so none outlives the review (or this shim).
    const events = shim.events();
    assert.equal(events.some((e) => e.phase === "start" && e.args.join(" ").includes("proof-discrimination-gate")), true,
      "control: the proof-record read did start");
    const open = events.filter((e) => e.phase === "start" && !events.some((x) => x.phase === "end" && x.id === e.id));
    assert.deepEqual(open.map((e) => e.args.join(" ")), [], "no gh read is still running when the review returns");
  } finally {
    process.env.PATH = priorPath;
  }
});

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker, " +
  "and a main-repair fix it withheld is neither a refusal nor a PR", async (t: TestContext) => {
  const root = ownedFixtureDir(t, "retired-main-repair").dir;
  const ledgerPath = join(root, "ledger.ndjson");
  const RETIRED = "drain lock released; the successor owns this work";
  const request = { branch: "main", headSha: "a".repeat(40), offendingSha: "b".repeat(40), offendingPr: 7, failingChecks: ["ci"],
    failingTestTitles: [], testFiles: [], diffStat: "", logExcerpt: "", reason: "required check ci failed" } as never;
  const deps: AlertFixDispatchDeps = {
    worktreeAdd: () => {}, worktreeRemove: () => {}, renderWorkerSettings: () => join(root, "settings.json"),
    loadMounts: () => ({}) as never, resolveMount: () => ({ model: "sonnet", provider: "claude", effort: "medium", maxTurns: 10 }) as never,
    spawn: async () => ({ notStarted: "admission-abandoned", subtype: "admission_abandoned", sessionId: "", costUsd: 0, numTurns: 0,
      text: "", blocks: [], stderr: "", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet",
      effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
      qualitySuspect: false }) as unknown as WorkerResult,
    ensureTaskTrailer: () => { throw new Error("no PR exists to trail"); }, checkAcceptance: () => ({ ok: true }) as never,
  };
  // The dispatcher: a worker that never started is not a fix run that opened no PR.
  await assert.rejects(dispatchMainRepairFixRun("acme", "fixture-repo", { root } as never, request, ledgerPath, "R", deps),
    (error: unknown) => error instanceof WorkerNotStartedError && error.notStarted === "admission-abandoned");
  const steps = readLedgerLines(ledgerPath).map((row) => String(row.step));
  assert.equal(steps.includes("main-repair.no_pr"), false, steps.join(", "));

  // The lane: in a retired daemon it never settles, so the rung writes no fix_refused row and the successor finds the
  // attempt unreported (W1-T13134); in a live daemon the not-started run still reaches the rung as an error.
  const notStarted = async (): Promise<string | undefined> => { throw new WorkerNotStartedError("admission-abandoned"); };
  const lane = mainRepairLaneFor("acme", "fixture-repo", { root } as never, ledgerPath, "R", notStarted);
  let settled: string = "pending";
  void runInWorkerSpawnScope({ retiredBy: RETIRED }, async () => lane.openFixPr!(request)).then(() => { settled = "fulfilled"; }, () => { settled = "rejected"; });
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, "pending", "a retired daemon reports nothing for a fix it never ran");
  await assert.rejects(runInWorkerSpawnScope({}, async () => lane.openFixPr!(request)), WorkerNotStartedError,
    "control: a live daemon's not-started fix reaches the rung");
});

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker, " +
  "and an operator reply its reader never read stays pending", async (t: TestContext) => {
  const root = ownedFixtureDir(t, "retired-inbox-reply").dir;
  const threadStorePath = join(root, "threads.ndjson");
  const ledgerPath = join(root, "ledger.ndjson");
  const item: InboxThreadItem = { proposalId: "ruling:t14916", state: "ready", summary: "Explain the proposal",
    plain: { headline: "A proposed improvement", whatHappened: "The evidence changed.", whatWeNeed: "Review the evidence.",
      ifNothingHappens: "Nothing is changed.", options: [], source: "template" } };
  appendThreadMessage(inboxThreadIdentity(item.proposalId), "reply", "What happens next?", { threadStorePath });
  const messages = () => {
    const read = readAllThreads({ threadStorePath });
    return read.status === "ok" ? read.threads.get(inboxThreadId(item.proposalId))?.length ?? 0 : -1;
  };
  const before = messages();
  // The real spawnWorker, refused by the retired scope before any provider starts.
  const withheld: Array<Record<string, unknown>> = [];
  const starts: string[] = [];
  const base = drafterStart(t, withheld, starts);
  const decide = realThreadDecider({ mount: { model: "haiku", effort: "low", maxTurns: 2, contextBudget: 1000 } as never,
    cwd: root, settingsFile: base.settingsFile, spawn: (args) => spawnWorker({ ...args, config: base.config,
      admitWorkerMemory: base.admitWorkerMemory, logWorkerSpawnWithheld: base.logWorkerSpawnWithheld, providerRouting: base.providerRouting }) });
  const deps = { threadStorePath, ledgerPath, readItems: () => [item], decide, reframe: () => {} };
  await assert.rejects(runInWorkerSpawnScope({ retiredBy: "drain lock released; the successor owns this work" },
    () => answerThread(inboxThreadId(item.proposalId), deps)), WorkerNotStartedError);
  assert.equal(starts.includes("drafter_worker"), false, "no reader started");
  assert.equal(withheld.length, 1, "the refusal is ledgered once");
  assert.equal(messages(), before, "no fallback answer is written to the thread");
  const rows = existsSync(ledgerPath) ? readLedgerLines(ledgerPath).map((row) => String(row.step)) : [];
  assert.equal(rows.includes("inbox.thread_answered"), false, rows.join(", "));
  // Control: the successor's reader answers the same reply, so it was left pending rather than consumed.
  const answered = await answerThread(inboxThreadId(item.proposalId), { ...deps,
    decide: async () => ({ action: "question", reply: "Which part should I explain?" }) });
  assert.equal(answered, "question");
  assert.equal(messages(), before + 1);
});

/** The WorkerResult spawnWorker returns when a retired scope withholds the start. */
function notStartedResult(): WorkerResult {
  return { notStarted: "admission-abandoned", subtype: "admission_abandoned", sessionId: "", costUsd: 0, numTurns: 0, text: "",
    blocks: [], stderr: "", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet",
    effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    qualitySuspect: false } as unknown as WorkerResult;
}

const isNotStarted = (error: unknown) => error instanceof WorkerNotStartedError && error.notStarted === "admission-abandoned";

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker, " +
  "and an alert fix it withheld stays undispatched", async (t: TestContext) => {
  const root = ownedFixtureDir(t, "retired-alert-fix").dir;
  const ledgerPath = join(root, "ledger.ndjson");
  const alert: AlertLaneAlert = { source: "code-scanning", id: "10", severity: "medium", state: "open", createdAt: "2026-11-26T00:00:00Z",
    summary: "unused variable", url: "https://github.com/acme/remudero/security/code-scanning/10", path: "src/lib/plain.ts" };
  const policy: AlertPolicy = { actSeverities: ["medium", "low"], criticalPaths: { review: [], gate: [], containment: [], ledger: [], status: [] } };
  const deps: AlertFixDispatchDeps = {
    worktreeAdd: () => {}, worktreeRemove: () => {}, renderWorkerSettings: () => join(root, "settings.json"),
    loadMounts: () => ({}) as never, resolveMount: () => ({ model: "sonnet", provider: "claude", effort: "medium", maxTurns: 10 }) as never,
    spawn: async () => notStartedResult(),
    ensureTaskTrailer: () => { throw new Error("no PR exists to trail"); }, checkAcceptance: () => ({ ok: true }) as never,
  };
  // The dispatcher: a fix that never started is not a fix run that failed.
  await assert.rejects(dispatchAlertFixRun("acme", "fixture-repo", { root } as never, alert, ledgerPath, "R", deps), isNotStarted);
  const steps = () => readLedgerLines(ledgerPath).map((row) => String(row.step));
  assert.equal(steps().includes("alert-fix.error"), false, steps().join(", "));
  // The lane writes no dispatched row, so the successor's lane still dispatches the alert.
  const withheld = await runAlertLane([alert], policy, { ledgerPath, runId: "R", escalate: () => "unused",
    dispatch: async () => { throw new WorkerNotStartedError("admission-abandoned"); } });
  assert.equal(withheld.dispatched.length, 0);
  assert.equal(steps().includes("alert-lane.dispatched"), false, steps().join(", "));
  const successor = await runAlertLane([alert], policy, { ledgerPath, runId: "R2", escalate: () => "unused", dispatch: async () => {} });
  assert.equal(successor.dispatched.length, 1, "control: the successor dispatches the same alert");
  await assert.rejects(runAlertLane([alert], policy, { ledgerPath: join(root, "other.ndjson"), runId: "R3", escalate: () => "unused",
    dispatch: async () => { throw new Error("worktree vanished"); } }), /worktree vanished/, "control: another failure still propagates");
});

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker, " +
  "and a fix spawn it withheld does not clear a stalled repair ladder", async (t: TestContext) => {
  const root = ownedFixtureDir(t, "retired-repair-ladder").dir;
  mkdirSync(join(root, "state"), { recursive: true });
  const config = { claudeBin: "/bin/true", root, workerProviders: { enabled: ["claude", "codex"] } } as never;
  const rows: Row[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}) => { rows.push({ step, ...extra }); };
  let next: () => Promise<WorkerResult> = async () => { throw new ProviderCapacityBlockedError([claudeCapacityFromUsage(undefined)]); };
  const spawn = trackRepairLadder(async () => next(), { config, log });
  const args = { cwd: root, permissionMode: "bypassPermissions", prompt: "fix", settingsFile: "/unused", config } as never;
  await assert.rejects(spawn(args));
  assert.equal(readRepairLadderState(root).state, "stalled");
  next = async () => notStartedResult();
  assert.equal((await spawn(args)).notStarted, "admission-abandoned");
  assert.equal(readRepairLadderState(root).state, "stalled", "a withheld spawn says nothing about provider capacity");
  assert.equal(rows.some((row) => row.step === "repair_ladder.recovered"), false);
  next = async () => ({ ...notStartedResult(), notStarted: undefined, subtype: "success" }) as WorkerResult;
  await spawn(args);
  assert.equal(readRepairLadderState(root).state, "running", "control: a worker that ran clears the stall");
});

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker, " +
  "and a verify-human shard it never judged stays due", async () => {
  const shard: ShardUnderJudgement = { id: "W1-T9001", title: "choose the policy", rationale: "An operator preference.",
    acceptance: ["the operator records it"], ageDays: 6, depsAllMerged: false, citedInSrc: false };
  const judge = realVerifyHumanJudge({ mounts: loadMounts(mountsPath(REPO_ROOT)), cwd: REPO_ROOT, settingsFile: "/unused",
    spawn: async () => notStartedResult() });
  await assert.rejects(judge(shard), isNotStarted);
  await assert.rejects(judgeVerifyHumanShard(shard, { judge }), isNotStarted);
  const control = await judgeVerifyHumanShard(shard, { judge: async () => { throw new Error("judge down"); } });
  assert.equal(control.judgeFailed, true, "control: any other failure still fails open");
  const rows: Array<Record<string, unknown>> = [];
  const staged: unknown[] = [];
  const result = await verifyHumanCadence({ shards: [shard], priorVerdicts: new Map(), judge, runId: "R",
    stageProposal: (proposal) => staged.push(proposal), appendRow: (row) => rows.push(row) });
  assert.deepEqual([rows.length, staged.length, result.judged], [0, 0, 0], "no verdict row and no Inbox ask");
});

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker, " +
  "and an Inbox message whose writer never started stays unwritten", async () => {
  const summarize = realDecisionSummarizer({ mount: { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 },
    cwd: "/unused", settingsFile: "/unused", spawn: async () => notStartedResult() });
  await assert.rejects(summarize({ context: "raw" }), isNotStarted);
  const proposal = { id: "ruling:t14916", summary: "Explain the proposal" };
  await assert.rejects(writePlainMessage(proposal, { summarize }), isNotStarted, "no template is stored in its place");
  const control = await writePlainMessage(proposal, { summarize: async () => { throw new Error("writer down"); } });
  assert.equal(control.source, "template", "control: a writer that failed still falls back to the template");
});

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker, " +
  "and an Inbox ask its gardener never judged is judged again", async (t: TestContext) => {
  const root = ownedFixtureDir(t, "retired-gardener").dir;
  const runtime = await inboxGardenerRunTaskPorts({ config: { root }, repoRoot: REPO_ROOT, owner: "acme", repo: "remudero",
    codeSha: "a".repeat(40), log: () => {} }, { spawn: async () => notStartedResult(),
    mount: () => ({ model: "haiku", effort: "low", maxTurns: 1, contextBudget: 1 }) });
  const now = Date.parse("2026-11-26T12:00:00.000Z"), clock = fixedClock(now);
  const scope: InboxGardenerScope = { repository: "acme/remudero", instance: "core", root };
  const task = { id: "W1-T9001", title: "A mechanical ask", repo: "remudero", verify: "auto", depends_on: [] };
  const proposal = stampMechanicalAsk({ id: "proof-debt:W1-T9001", summary: "repair a proof",
    evidenceAnchors: [{ description: "unresolved criterion 1", path: "plan/tasks.yaml", pattern: "grep: missing in src/missing.ts" }] },
  task.id, proofDebtPopulationPermit([task]));
  const candidates = [{ proposal, operatorIntent: "", unansweredReply: false, resolvedByOperator: false, task }] as unknown as InboxGardenerCandidate[];
  await assert.rejects(runtime.ports.judge!("prompt", candidates[0]!), isNotStarted);
  const pack: InboxGardenerPack = { scope, snapshotKey: "b".repeat(64), generatedAt: new Date(now - 60_000).toISOString(),
    checkedAt: new Date(now).toISOString(), codeSha: "a".repeat(40), candidates, ledgerEventIds: new Set(),
    coverage: { plan: "observed", registry: "observed", github: "observed", ledger: "observed", threads: "observed" } };
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const ports = (judge: InboxGardenerPorts["judge"]): InboxGardenerPorts => ({ capture: async () => pack,
    proof: async () => undefined as never, mirror: async () => assert.fail("nothing to mirror"), judge });
  const entry = () => { const read = readInboxGardenerStore(stateDir, scope);
    return read.state === "observed" ? read.store.entries["proof-debt:W1-T9001"] : assert.fail("store observed"); };
  const withheld = await runInboxGardener({ stateDir, scope, mode: "shadow", clock, ports: ports(runtime.ports.judge) });
  assert.equal(withheld.state, "pending", JSON.stringify(withheld));
  assert.equal(entry(), undefined, "no failed judgment is stored for a judge that never started");
  const successor = await runInboxGardener({ stateDir, scope, mode: "shadow", clock,
    ports: ports(async () => ({ decision: "needs_triage", reason: "an operator should look" })) });
  assert.equal(successor.state, "complete", JSON.stringify(successor));
  assert.equal(entry()?.judge, "complete", "control: the successor judges the same ask");
});

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker, " +
  "and a prerequisite fix it withheld is neither escalated nor exhausted", async (t: TestContext) => {
  const root = ownedFixtureDir(t, "retired-prerequisite").dir;
  const mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };
  const issues: string[] = [];
  const rows: Row[] = [];
  const review = { state: "failure", criteria: [], testTheater: false, summary: "entangled", floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, instrumentEntangled: true, headSha: "deadbeef", reviewerOutcome: "success",
    instrumentEntanglementPaths: { instrumentPaths: ["scripts/coverage-ratchet.mjs"], srcPaths: ["src/run-task.ts"] } };
  const outcome = await runFixRung({ taskId: "W1-T14916FIX", runId: "W1-T14916FIX-1", prUrl: "https://github.com/acme/remudero/pull/4242",
    task: { id: "W1-T14916FIX", title: "An entangled PR" }, branch: "run-W1-T14916FIX-1", worktreePath: join(root, "wt"),
    initialSessionId: "session-0", mount, settingsFile: join(root, "settings.json"), config: {}, budgetUsd: 10, strikeCap: 3,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: join(root, "wt"), reviewerMount: mount }, initialReview: review,
    deps: { spawn: async () => notStartedResult(), waitForCiGreen: async () => assert.fail("no PR to wait on"),
      runReview: async () => assert.fail("no re-review"), push: () => {}, ledgerPath: join(root, "ledger.ndjson"),
      issues: { create: (title: string) => { issues.push(title); return "https://github.com/acme/remudero/issues/1"; } },
      log: (step: string, extra: Record<string, unknown> = {}) => { rows.push({ step, ...extra }); }, say: () => {},
      account: (result: WorkerResult) => result, ledgerLines: () => [],
      readLiveHead: () => ({ ok: true as const, headSha: "deadbeef" }), fetchPrBody: async () => "" },
  } as never);
  assert.equal(outcome.outcome, "stood_down", JSON.stringify(outcome));
  assert.equal(outcome.strikes, 0);
  assert.deepEqual(issues, [], "no needs-human issue");
  assert.equal(rows.some((row) => row.step === "fix.exhausted"), false, rows.map((row) => row.step).join(", "));
});

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker, " +
  "and a fix progress judge it withheld rules nothing", async () => {
  let asks = 0;
  const judge = productionFixProgressJudge({ cwd: REPO_ROOT, settingsFile: "/unused",
    mount: { model: "test-model", effort: "low", maxTurns: 1, contextBudget: 10000 }, spawn: async () => { asks++; return notStartedResult(); } });
  const input = buildFixProgressInput({ taskId: "W1-T14916FIX", prNumber: 4242, headSha: "d".repeat(40), currentRed: ["ci"], ledger: [] });
  await assert.rejects(judge(input), isNotStarted);
  const decision = await judgeFixProgress(input, judge, { reask: true });
  assert.equal(decision.verdict, "unavailable", JSON.stringify(decision));
  assert.equal("judge_skipped" in decision, false, "no unparseable-twice continue is fabricated");
  assert.equal(asks, 2, "one ask per call: a withheld judge is not asked again");
});

const CS_N = 49160;
const CS_HEAD = `${CS_N}cccc`;
const CS_ALERT = { alertNumber: 77, ruleId: "js/incomplete-sanitization", severity: "high", path: "src/lib/plain.ts", line: 9,
  message: "This replaces only the first occurrence of ..." };
function codeScanningPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return { prNumber: CS_N, prUrl: `https://github.com/acme/remudero/pull/${CS_N}`, taskId: `W1-T${CS_N}`,
    headRefName: `run-W1-T${CS_N}-1`, reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: "2026-11-26T11:00:00Z", headSha: CS_HEAD, autoMergeArmed: false,
    codeqlHeadAlerts: { headSha: CS_HEAD, alerts: [CS_ALERT] }, ...over } as OpenPrView;
}

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker, " +
  "and the daemon's code-scanning judge it withheld throws instead of ruling the head unavailable", async (t: TestContext) => {
  const root = ownedFixtureDir(t, "retired-code-scanning-judge").dir;
  const task = { id: `W1-T${CS_N}`, title: "a codeql head", type: "implement", files: [CS_ALERT.path] } as unknown as Task;
  const plan: Plan = { tasks: [task], byId: new Map([[task.id, task]]) } as unknown as Plan;
  const config = { claudeBin: "/bin/true", root, installRoot: process.cwd() } as unknown as Parameters<typeof codeScanningJudgeDeps>[2];
  let spawns = 0;
  const deps = codeScanningJudgeDeps("acme", "remudero", config, plan, "SWEEP-14916", () => {},
    async () => { spawns++; return notStartedResult(); }, async () => []);
  await assert.rejects(deps.judgeCodeScanningAlerts!(codeScanningPr({ prUrl: "not a pr url" }), [CS_ALERT]), isNotStarted);
  assert.equal(spawns, 1, "a withheld judge is asked once, not retried as unparseable");
});

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker, " +
  "and a code-scanning head whose judge it withheld gets no ruling and is judged by the successor", async (t: TestContext) => {
  const root = ownedFixtureDir(t, "retired-code-scanning-gate").dir;
  const lines: Array<Record<string, unknown>> = [{ ts: "2026-11-26T11:30:00.000Z", run_id: "REVIEW-14916", task_id: `W1-T${CS_N}`,
    step: "review.posted", pr_url: codeScanningPr().prUrl, head_sha: CS_HEAD, state: "success", capped: false, plan_only: false }];
  const armed: string[] = [];
  const fixes: number[] = [];
  const sweepDeps = (judge: NonNullable<SweepDeps["judgeCodeScanningAlerts"]>): SweepDeps => ({
    arm: (p) => { armed.push(`${p.prNumber}@${p.headSha}`); },
    close: () => {},
    dispatchFix: (p) => { fixes.push(p.prNumber); },
    escalate: () => {},
    ledgerPath: join(root, "ledger.ndjson"),
    runId: "SWEEP-14916",
    now: () => Date.parse("2026-11-26T12:00:00.000Z"),
    readLedger: () => lines,
    appendLine: (_path, line) => { lines.push(line); },
    log: (step, extra = {}) => { lines.push({ run_id: "SWEEP-14916", step, ...extra }); },
    judgeCodeScanningAlerts: judge,
    postCodeScanningRuling: () => {},
  } as SweepDeps);
  await runSweep([codeScanningPr()], sweepDeps(() => Promise.reject(new WorkerNotStartedError("admission-abandoned"))));
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
  assert.equal(lines.filter((l) => l.step === CODE_SCANNING_FIX_STEP).length, 0, "no fix ruling is recorded for a withheld judge");
  assert.equal(fixes.length, 0, "no fix is dispatched");
  assert.deepEqual(armed, [], "the head is not armed");
  let judged = 0;
  await runSweep([codeScanningPr()], sweepDeps(async () => { judged++; return { ruling: "false_positive", reason: "a constant input" }; }));
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
  assert.equal(judged, 1, "control: the successor judges the same head");
  assert.deepEqual(armed, [`${CS_N}@${CS_HEAD}`], "control: the successor's ruling decides the head");
});
