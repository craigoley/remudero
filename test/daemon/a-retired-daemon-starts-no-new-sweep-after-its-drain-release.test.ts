// W1-T14916: since W1-T14873 a retiring daemon releases its drain lock before its SRE lane page settles. On 2026-11-26
// the retired process then ran 14 sweep passes and started 18 workers over 34 minutes, beside its successor.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { closeDaemonCleanup, createDaemonRetirement, inDaemonSpawnScope, retiringCiJudgeKick } from "#src/cli/commands/daemon.js";
import { withCiJudgeAfterSweep } from "#src/lib/ci-escalation-judge.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LearnedReservation } from "#src/lib/host-memory-learning.js";
import { spawnRunChild } from "#src/lib/run-child.js";
import { resolveFleetControlHold, type LightPassScope, type RestartAdmission } from "#src/lib/daemon.js";
import { createClaudeExecutableCache, spawnWorker, workerSpawnRetiredBy, WorkerSpawnRetiredError, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
import { spawnCodexWorker, spawnOpenWeightWorker } from "#src/lib/worker-provider.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

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
