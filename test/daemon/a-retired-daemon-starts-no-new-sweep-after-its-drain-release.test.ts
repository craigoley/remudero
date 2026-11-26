// W1-T14916: since W1-T14873 a retiring daemon releases its drain lock before its SRE lane page settles. On 2026-11-26
// the retired process then ran 14 sweep passes and started 18 workers over 34 minutes, beside its successor.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { closeDaemonCleanup, createDaemonRetirement, inDaemonSpawnScope, retiringCiJudgeKick } from "#src/cli/commands/daemon.js";
import { CI_JUDGE_HEADS_FILE, judgeCiEscalation, productionCiJudgePorts, withCiJudgeAfterSweep } from "#src/lib/ci-escalation-judge.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LearnedReservation } from "#src/lib/host-memory-learning.js";
import { createDetachedWorkHost, spawnRunChild, type RunChildLaunch } from "#src/lib/run-child.js";
import { captureInboxDraftSnapshot, commitInboxDraftOutcomes, draftsDueOnDaemon, runDraftRung, type DraftLaneIdentity, type Proposal } from "#src/lib/inbox.js";
import { resolveFleetControlHold, type LightPassScope, type RestartAdmission } from "#src/lib/daemon.js";
import type { Config } from "#src/lib/config.js";
import { buildSweepEffects, installDetachedWorkHost, reviewWithheldLadder, runSweep, withheldEvaluatorsForInput, type OpenPrView } from "#src/lib/sweep.js";
import { createClaudeExecutableCache, runInWorkerSpawnScope, spawnWorker, workerSpawnRetiredBy, WorkerNotStartedError, WorkerSpawnRetiredError, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
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

/** The production postReview effect, with the in-process review runner replaced by a counting gate. */
function reviewEffects(t: TestContext) {
  const root = ownedFixtureDir(t, "retired-review").dir;
  mkdirSync(join(root, "state"), { recursive: true });
  const rows: Row[] = [];
  const reviewed: unknown[] = [];
  const gate: { refuses?: string } = {};
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const effects = buildSweepEffects({ owner: "acme", repo: "fixture", config: { root, claudeBin: "/unused" } as Config,
    ledgerPath, runId: "SWEEP-RETIRED", plan: { tasks: [], byId: new Map() },
    log: (step, extra) => { rows.push({ step, ...extra }); },
    // The in-process review; `refuses` is its own freshness read seeing the release (decideReviewPath).
    reviewRunner: async (prNumber) => {
      if (gate.refuses !== undefined) throw new WorkerSpawnRetiredError(gate.refuses);
      reviewed.push(prNumber);
      return 0;
    } });
  const pr: OpenPrView = { prNumber: 14916, prUrl: "https://github.com/acme/fixture/pull/14916", headSha: "a".repeat(40),
    headRefName: "run-W1-T14916-1", taskId: "W1-T14916", reviewState: "none", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    autoMergeArmed: false, lastActivityAt: new Date().toISOString(), reviewInputDigest: "v1:input" };
  return { root, rows, reviewed, gate, pr, ledgerPath, effects };
}

/** A detached work host whose review launch answers `launch`, after `during` runs (the wait a release can land in). */
function reviewHost(root: string, launch: RunChildLaunch, during: () => void, asked: unknown[]) {
  return createDetachedWorkHost({ stateRoot: join(root, "state"), repoDir: root, root, repo: "fixture", log: () => {},
    readMode: () => "on", readLedger: () => [{ step: "daemon.freshness_drain.completed", duration_ms: 9_000, in_flight_reviews: 1,
      waited_on: [{ what: "review", kind: "review", settled_after_ms: 4_000 }] }],
    spawn: async (input) => { asked.push(input); during(); return launch; } });
}

const ABANDONED: RunChildLaunch = { started: false, abandoned: true, reason: "admission-abandoned", runId: "work-review-withheld", waitedMs: 0 };
const UNSTARTED: RunChildLaunch = { started: false, reason: "no engine tree has been built yet" };
const RELEASED = "drain lock released; the successor owns this work";

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker, and runs no withheld review in process", async (t) => {
  const withheldChild = "admission-abandoned (run child work-review-withheld)";
  const cases = [
    { name: "released before the review", release: "before", launch: ABANDONED, hold: `retired: ${RELEASED}`, asked: 0 },
    { name: "released while the child waits for admission", release: "launch", launch: ABANDONED, hold: withheldChild, asked: 1 },
    { name: "a fleet hold abandons the child", release: "never", launch: ABANDONED, hold: withheldChild, asked: 1 },
    { name: "released while a child fails to start", release: "launch", launch: UNSTARTED, hold: `retired: ${RELEASED}`, asked: 1 },
    { name: "released during the in-process freshness read", release: "gate", launch: UNSTARTED, hold: `retired: ${RELEASED}`, asked: 1 },
    { name: "control: no release, a child that cannot start", release: "never", launch: UNSTARTED, hold: undefined, asked: 1 },
  ];
  try {
    for (const c of cases) {
      const run = reviewEffects(t);
      const retirement = createDaemonRetirement(() => {});
      const asked: unknown[] = [];
      if (c.release === "before") retirement.retire();
      if (c.release === "gate") run.gate.refuses = RELEASED;
      installDetachedWorkHost(reviewHost(run.root, c.launch, () => { if (c.release === "launch") retirement.retire(); }, asked));
      const review = retirement.inSpawnScope(async () => run.effects.postReview!(run.pr, { kind: "full-review" }, "review-PR14916-attempt"));
      const steps = () => run.rows.map((row) => row.step).filter((step) => step.startsWith("sweep.post_review."));
      if (c.hold === undefined) {
        await review;
        assert.equal(run.reviewed.length, 1, `${c.name}: the review runs in process`);
        assert.deepEqual(steps(), ["sweep.post_review.attempt", "sweep.post_review.done"], c.name);
      } else {
        await assert.rejects(review, (error: unknown) => error instanceof WorkerNotStartedError &&
          error.message === `review start withheld: ${c.hold}; re-derived next pass`, c.name);
        assert.deepEqual(run.reviewed, [], `${c.name}: no in-process review`);
        assert.deepEqual(steps(), c.release === "before" ? ["sweep.post_review.stood_down"]
          : ["sweep.post_review.attempt", "sweep.post_review.stood_down"], `${c.name}: neither done nor failed`);
      }
      assert.equal(asked.length, c.asked, `${c.name}: child launches asked`);
    }
  } finally { installDetachedWorkHost(undefined); }
});

test("W1-T14916 criterion 1: after the drain lock is released the retired daemon starts no sweep pass and spawns no worker, and a withheld review keys no outcome", async (t) => {
  const run = reviewEffects(t);
  const { ledgerPath } = run;
  const retirement = createDaemonRetirement(() => {});
  retirement.retire();
  await retirement.inSpawnScope(() => runSweep([run.pr], { arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    postReview: run.effects.postReview, runId: "SWEEP-RETIRED", ledgerPath, log: () => {} }));
  const ledger = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
  assert.deepEqual(ledger.filter((row) => row.step === "review.post_refused" || row.step === "sweep.action_failed"), [],
    "no failure or refusal row keys the input, so the successor reviews it");
  const disposed = ledger.find((row) => row.step === "sweep.disposed");
  assert.equal(disposed?.acted, false);
  assert.equal(disposed?.stand_down_reason, `review start withheld: retired: ${RELEASED}; re-derived next pass`);
  assert.deepEqual(run.reviewed, []);

  // A release that lands after a review's claim leaves a withheld row for a reviewer that never started: no attempt.
  const withheld = (runId: string, outcome: string) => ({ run_id: runId, step: "review.semantic_incomplete", pr_url: run.pr.prUrl,
    head_sha: run.pr.headSha, review_input_digest: run.pr.reviewInputDigest, provider: "codex", reason: "incomplete", reviewer_outcome: outcome });
  const rows = [withheld("review-1", "error_max_turns"), withheld("review-2", "admission_abandoned")];
  assert.deepEqual(withheldEvaluatorsForInput(run.pr, rows).attempts.map((attempt) => attempt.runId), ["review-1"]);
  assert.equal(reviewWithheldLadder(run.pr, rows), undefined, "one real attempt does not climb to another evaluator");
  assert.equal(reviewWithheldLadder(run.pr, [rows[0]!, withheld("review-3", "error_max_turns")])?.rung, 2, "control: two real attempts do");
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
