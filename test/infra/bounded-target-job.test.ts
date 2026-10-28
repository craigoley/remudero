import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createNativeTargetJobRunner, daemonKickPort, daemonTargetJobPort } from "#src/cli/commands/daemon.js";
import { fixedClock } from "#src/lib/clock.js";
import { runDaemon, type TargetJobRecord } from "#src/lib/daemon.js";
import { runDrain, type DrainOpts } from "#src/lib/drain.js";
import { appendLedger } from "#src/lib/ledger.js";
import { loadPlan } from "#src/lib/plan.js";
import {
  fileTargetJobStore, productBuildKickOrigin, productPlanOrigin, ProductBuildService, readTargetExecution,
  type BuildTask, type ProductBuildOptions, type ProductBuildTarget, type TargetInspection,
} from "#src/lib/product-build.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import type { ProductRepositoryProvider } from "#src/lib/product-repository.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const actor = "clerk:alice";
const HEAD = "a".repeat(40);
const ID = 1432832754;
const NOW = Date.parse("2026-10-26T01:00:00.000Z");
const identity = { provider: "github", id: ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public", verifiedAt: "2026-10-26T00:00:00.000Z" } as const;
const planEvidence = { id: "plan-approved-1", stage: "plan", outcome: "succeeded", objectiveRevision: 1, observedAt: "2026-10-26T00:00:01.000Z", references: [] } as const;
/** Core drives remudero. Wreckterra is enrolled below and, here, has NO live instance of its own. */
const CORE_ONLY = "instances:\n  core:\n    github_repo: craigoley/remudero\n";
const WITH_OWN = `${CORE_ONLY}  wreckterra:\n    github_repo: craigoley/wreckterra\n    mode: shadow\n`;
const marker = (root: string, repo: string, taskId: string) => join(root, "state", `KICK_REQUESTED-${repo}:${taskId}`);

/** The target repository's own plan: the product task, and an ordinary one the job must never touch. */
const targetPlan = (productId: string) => `
- id: W9-T1
  title: the product's first source task
  repo: wreckterra
  type: implement
  depends_on: []
  status: queued
  origin: product-plan#${productId}/plan-approved-1
  budget_usd: 10
- id: W9-T3
  title: an ordinary queued task of the same plan
  repo: wreckterra
  type: implement
  depends_on: []
  status: queued
`;
const selfPlan = `
- id: C1-T1
  title: a core task nothing here may dispatch
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

/** Real files throughout: the product store, the registry, the managed set, the kick markers, the job record and the ledger. */
function fixture(t: TestContext, registry = CORE_ONLY) {
  const root = ownedFixtureDir(t, "bounded-target-job").dir;
  const core = join(root, "core");
  const checkout = join(root, "checkout");
  mkdirSync(join(core, "state"), { recursive: true });
  mkdirSync(join(checkout, ".remudero"), { recursive: true });
  writeFileSync(join(checkout, ".remudero", "managed-repos.json"), JSON.stringify({ repos: ["craigoley/wreckterra"] }));
  const registryPath = join(checkout, "daemon-instances.yaml");
  writeFileSync(registryPath, registry);
  const stateBase = join(root, "instances");
  mkdirSync(join(stateBase, "wreckterra", "state"), { recursive: true });
  const store = new ProductIntentStore({ root: core });
  const brief = { idea: "private product", resourceEnvelope: { budgetUsd: 30, maxConcurrentBuilds: 1, existingSetupOnly: true } };
  const saved = store.write(actor, { version: "product-intent-v1", requestId: "seed-product-00001", expectedRevision: 0, brief });
  assert.ok(saved.ok);
  const productId = saved.value.receipt.productId;
  assert.ok(store.transition(actor, { version: "product-intent-v1", requestId: "seed-trusted-000001", id: productId,
    expectedRevision: 1, expectedObjectiveRevision: 1, repository: identity, stageEvidence: [planEvidence] }).ok);
  const inspection: TargetInspection = { enrolled: true, head: HEAD, readmeOnly: false };
  const task: BuildTask = { id: "W9-T1", origin: productPlanOrigin(productId, planEvidence.id), status: "queued", budgetUsd: 10, claimed: false, merged: false };
  const target: ProductBuildTarget = {
    async inspect() { return inspection; }, runnerRegistered() { return true; },
    async task() { return { state: "found" as const, task }; }, async observe() { return { state: "none" as const, branches: [] }; },
    async bootstrap() { return { state: "absent" as const }; },
  };
  const provider: Pick<ProductRepositoryProvider, "read"> = {
    async read() { return { state: "found", repository: { id: ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" } }; },
  };
  const options: ProductBuildOptions = { root: core, store, target, provider, clock: fixedClock(NOW), instances: { registryPath, stateBase } };
  const command = () => ({ version: "product-build-v1", requestId: "build-request-0001", productId, planEvidenceId: planEvidence.id,
    taskId: "W9-T1", expectedRevision: 2, expectedObjectiveRevision: 1 });
  const planFile = join(root, "target-plan.yaml");
  writeFileSync(planFile, targetPlan(productId));
  const selfFile = join(root, "self-plan.yaml");
  writeFileSync(selfFile, selfPlan);
  const ledgerPath = join(core, "state", "ledger.ndjson");
  const lines: { step: string; extra: Record<string, unknown> }[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}) => {
    lines.push({ step, extra });
    appendLedger(ledgerPath, { run_id: "DAEMON-1", task_id: "DAEMON", step, lane: "daemon", ...extra });
  };
  const calls = { runTask: [] as string[], drains: [] as DrainOpts[], claims: [] as string[] };
  const state = { claimHeld: false as boolean | undefined, syncError: undefined as string | undefined, daemonDeps: {} as Record<string, unknown> };
  const runner = createNativeTargetJobRunner({
    root: core, repoRoot: checkout, log, nowMs: () => Date.now(), instances: { registryPath },
    planPathFor: (_owner, repo) => (repo === "wreckterra" ? planFile : undefined),
    syncPlan: async (path) => (state.syncError === undefined ? { plan: loadPlan(path) } : { error: state.syncError }),
    project: () => new Map(),
    runTask: async (taskId) => {
      calls.runTask.push(taskId);
      const runId = `${taskId}-${Date.now()}`;
      appendLedger(ledgerPath, { run_id: runId, task_id: taskId, step: "run.start", lane: "run-task" });
      appendLedger(ledgerPath, { run_id: runId, task_id: taskId, step: "verdict", lane: "run-task", verdict: "merged" });
      return { taskId, runId, merged: true, costUsd: 0, verdict: "merged" };
    },
    claimHeld: (taskId) => { calls.claims.push(taskId); return state.claimHeld; },
    runDrain: (plan, deps, opts) => { calls.drains.push(opts ?? {}); return runDrain(plan, deps, opts); },
  });
  const service = new ProductBuildService(options);
  /** One real daemon pass over the CORE daemon's own bindings: its kick port, the target-job port and the runner. */
  const drive = async (over: { checkQuietHours?: () => { deferred: true; detail: string } } = {}) => {
    const from = lines.length;
    const spawned: string[] = [];
    const daemonKicks = daemonKickPort(core, { repo: "remudero", isSelf: true });
    let ticks = 0;
    await runDaemon(loadPlan(selfFile), {
      refreshMerged: () => () => false,
      runOne: async (id) => { spawned.push(id); return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }; },
      ...daemonKicks, ...daemonTargetJobPort(core, { repo: "remudero" }),
      runTargetJob: (kick, daemonDeps) => runner(kick, { ...daemonDeps, ...over }),
      checkStop: () => (++ticks > 3 ? "enough ticks" : undefined),
      sleep: async () => {}, log,
    }, { headroomEnabled: false, max: 5 });
    return { lines: lines.slice(from), spawned };
  };
  const record = (origin: string) => fileTargetJobStore(core).read(origin);
  return { root, core, checkout, registryPath, stateBase, store, productId, options, service, command, ledgerPath, calls, state, drive, record, log, targetPlanFile: planFile };
}
const refused = async (promise: ReturnType<ProductBuildService["execute"]>) => { const result = await promise; assert.equal(result.ok, false); return result.code; };
const started = async (f: ReturnType<typeof fixture>) => {
  const result = await f.service.execute(actor, f.command());
  assert.ok(result.ok, "the build request is accepted");
  return { ...result.value, origin: productBuildKickOrigin(f.productId, result.value.receipt.operationId) };
};

test("W1-T10799: one managed target without a daemon reaches one bounded native job", async (t) => {
  const f = fixture(t);
  const request = await started(f);
  assert.equal(request.receipt.outcome, "queued", "the request's own act records queued, never more");
  assert.ok(existsSync(marker(f.core, "wreckterra", "W9-T1")), "the marker sits under the CORE daemon's root, where no target daemon exists");
  assert.deepEqual(daemonKickPort(f.core, { repo: "remudero", isSelf: true }).pendingKicks(), [], "the core daemon's own kick port never offers a foreign repository's marker");
  assert.deepEqual(daemonTargetJobPort(f.core, { repo: "remudero" }).pendingTargetJobs().map((job) => [job.taskId, job.repo, job.origin]), [["W9-T1", "wreckterra", request.origin]]);

  const run = await f.drive();
  assert.deepEqual(f.calls.runTask, ["W9-T1"], "exactly the one kicked task ran, and not the ordinary W9-T3 beside it");
  assert.deepEqual(run.spawned, [], "the core plan's own task never dispatched");
  assert.equal(f.calls.drains.length, 1, "one maintained drain");
  assert.deepEqual([f.calls.drains[0]!.curated, f.calls.drains[0]!.max, f.calls.drains[0]!.laneCount], [["W9-T1"], 1, 1], "one task, depth one, one lane");
  assert.ok(!existsSync(marker(f.core, "wreckterra", "W9-T1")), "the marker was cleared at the terminal verdict");
  const job = f.record(request.origin);
  assert.ok(job.state === "found" && job.record.status === "ended" && job.record.attempts === 1);
  assert.deepEqual(run.lines.filter((line) => line.step === "console.kick_dispatched").map((line) => [line.extra.task, line.extra.origin, line.extra.repo]),
    [["W9-T1", request.origin, "wreckterra"]], "the dispatch receipt names this request's origin, task and repository");
  assert.ok(!run.lines.some((line) => line.step === "dispatch.pick_scored" && line.extra.task === "W9-T3"));
  const again = await f.drive();
  assert.deepEqual(f.calls.runTask, ["W9-T1"], "a further pass finds nothing left to run");
  assert.deepEqual(again.lines.filter((line) => line.step.startsWith("target_job.")), []);
});

test("W1-T10799: replay after restart or lost response resumes the same native job", async (t) => {
  const f = fixture(t);
  const request = await started(f);
  // A lost response: the same request again is the same operation, and writes no second marker.
  const lost = await f.service.execute(actor, f.command());
  assert.ok(lost.ok && lost.value.replayed && lost.value.receipt.operationId === request.receipt.operationId);
  assert.equal(readdirKicks(f.core).length, 1, "one marker for one request");

  // A restart after the dispatch landed: the durable record and the held claim resume it. No second dispatch.
  const store = fileTargetJobStore(f.core);
  const landed: TargetJobRecord = { origin: request.origin, taskId: "W9-T1", repo: "wreckterra", status: "admitted", attempts: 1, updatedAt: new Date().toISOString() };
  store.write(landed);
  f.state.claimHeld = true;
  const resumed = await f.drive();
  assert.deepEqual(f.calls.runTask, [], "a landed dispatch is never dispatched twice");
  assert.ok(resumed.lines.some((line) => line.step === "target_job.resumed"));
  assert.ok(existsSync(marker(f.core, "wreckterra", "W9-T1")), "the job is not closed, so its marker stays");
  const marked = f.record(request.origin);
  assert.ok(marked.state === "found" && marked.record.reason === "resumed" && marked.record.updatedAt === landed.updatedAt, "the dispatch time that correlates the receipts is kept");
  await f.drive();
  assert.equal(resumed.lines.filter((line) => line.step === "target_job.resumed").length, 1, "resumption is reported once");

  // An unknown claim (an unreadable remote) is never read as free either.
  f.state.claimHeld = undefined;
  await f.drive();
  assert.deepEqual(f.calls.runTask, []);

  // A restart that lost the run: the claim is released and no terminal row exists, so the SAME job enters the drain once.
  f.state.claimHeld = false;
  await f.drive();
  assert.deepEqual(f.calls.runTask, ["W9-T1"], "the same job, dispatched exactly once");
  const done = f.record(request.origin);
  assert.ok(done.state === "found" && done.record.status === "ended" && done.record.attempts === 2);

  // The same origin delivered again after the job closed reports it and never spends twice.
  const redelivered = await f.service.execute(actor, f.command());
  assert.ok(redelivered.ok && redelivered.value.replayed);
  writeFileSync(marker(f.core, "wreckterra", "W9-T1"), JSON.stringify({ taskId: "W9-T1", origin: request.origin, repo: "wreckterra", requestedAt: new Date().toISOString() }));
  const closed = await f.drive();
  assert.deepEqual(f.calls.runTask, ["W9-T1"], "a closed job's origin never dispatches again");
  assert.ok(closed.lines.some((line) => line.step === "target_job.replayed"));
  assert.ok(!existsSync(marker(f.core, "wreckterra", "W9-T1")));

  // A record this process cannot read is held, never read as "no job": that would respend.
  const other = fixture(t);
  const second = await started(other);
  const recordFile = join(other.core, "state", "target-jobs");
  mkdirSync(recordFile, { recursive: true });
  fileTargetJobStore(other.core).write({ origin: second.origin, taskId: "W9-T1", repo: "wreckterra", status: "queued", attempts: 0, updatedAt: new Date().toISOString() });
  for (const name of readdirSync(recordFile)) writeFileSync(join(recordFile, name), "{torn");
  assert.equal(other.record(second.origin).state, "unreadable");
  const torn = await other.drive();
  assert.deepEqual(other.calls.runTask, []);
  assert.ok(torn.lines.some((line) => line.step === "target_job.unknown"));
  assert.ok(existsSync(marker(other.core, "wreckterra", "W9-T1")));
});

test("W1-T10799: native receipts distinguish queued admitted running and refused jobs", async (t) => {
  const f = fixture(t);
  const request = await started(f);
  const stateDir = join(f.core, "state");
  const read = (at = NOW) => readTargetExecution(stateDir, { taskId: "W9-T1", origin: request.origin, repo: "wreckterra", requestedAt: request.receipt.queuedAt, nowMs: at });
  const outcome = async () => { const result = await f.service.execute(actor, f.command()); assert.ok(result.ok); return result.value.receipt.outcome; };
  // The marker, a managed profile and free capacity are not receipts.
  assert.deepEqual(read(), { state: "unknown" }, "no ledger at all is a daemon this process cannot see, never 'nothing ran'");
  assert.equal(await outcome(), "queued");
  // A governor that holds the drain is an explicit deferral: no dispatch row, no job record, the marker stays.
  const held = await f.drive({ checkQuietHours: () => ({ deferred: true, detail: "QUIET_HOURS file present" }) });
  assert.deepEqual(f.calls.runTask, []);
  assert.ok(held.lines.some((line) => line.step === "target_job.capacity_deferred" && String(line.extra.reason).includes("quiet_hours_deferred")));
  assert.equal(f.record(request.origin).state, "absent");
  assert.ok(existsSync(marker(f.core, "wreckterra", "W9-T1")));
  assert.equal(await outcome(), "queued", "capacity that could not start the job leaves it queued");
  f.state.syncError = "origin unreachable";
  const unsynced = await f.drive();
  assert.ok(unsynced.lines.some((line) => line.step === "target_job.plan_unreadable"));
  assert.equal(await outcome(), "queued", "an unreadable target plan is not an admission");
  f.state.syncError = undefined;

  // Receipts, one at a time, in the core ledger the job writes.
  f.log("console.kick_dispatched", { task: "W9-T1", origin: request.origin, repo: "wreckterra" });
  assert.deepEqual(read(Date.now()), { state: "dispatched" });
  assert.equal(await outcome(), "admitted");
  const runId = `W9-T1-${Date.now()}`;
  appendLedger(join(stateDir, "ledger.ndjson"), { run_id: runId, task_id: "W9-T1", step: "run.start", lane: "run-task" });
  assert.deepEqual(read(Date.now()), { state: "running", runId });
  assert.equal(await outcome(), "running");

  // A different origin's dispatch row is not this request's, and a refusal row outranks a held claim.
  const refusedF = fixture(t);
  const second = await started(refusedF);
  refusedF.log("console.kick_dispatched", { task: "W9-T1", origin: "product:other/op", repo: "wreckterra" });
  assert.equal(await outcome2(refusedF), "queued", "another origin's receipt is never this request's");
  refusedF.log("console.kick_refused", { task: "W9-T1", origin: second.origin, repo: "wreckterra", reason: "unknown task id" });
  assert.deepEqual(readTargetExecution(join(refusedF.core, "state"), { taskId: "W9-T1", origin: second.origin, repo: "wreckterra", requestedAt: second.receipt.queuedAt, nowMs: Date.now() }), { state: "refused" });
  assert.equal(await outcome2(refusedF), "queued");

  // The job's own refusal: an unknown task id is refused, recorded, ledgered and its marker cleared.
  const unknown = fixture(t);
  const third = await started(unknown);
  writeFileSync(unknown.targetPlanFile, targetPlan(unknown.productId).replace("W9-T1", "W9-T9"));
  const refusal = await unknown.drive();
  assert.deepEqual(unknown.calls.runTask, []);
  assert.deepEqual(refusal.lines.filter((line) => line.step === "console.kick_refused").map((line) => [line.extra.origin, line.extra.reason]), [[third.origin, "unknown task id"]]);
  const refusedJob = unknown.record(third.origin);
  assert.ok(refusedJob.state === "found" && refusedJob.record.status === "refused");
  assert.ok(!existsSync(marker(unknown.core, "wreckterra", "W9-T1")));
});
const outcome2 = async (f: ReturnType<typeof fixture>) => { const result = await f.service.execute(actor, f.command()); assert.ok(result.ok); return result.value.receipt.outcome; };
const readdirKicks = (core: string) => readdirSync(join(core, "state")).filter((name) => name.startsWith("KICK_REQUESTED-"));

test("W1-T10799: unreadable or halted routing refuses and live instances retain their own path", async (t) => {
  // An unreadable registry is unknown, never "no daemon".
  const broken = fixture(t, "instances:\n  core:\n  wreckterra:\n");
  assert.equal(await refused(broken.service.execute(actor, broken.command())), "target_unreadable");
  assert.deepEqual(readdirKicks(broken.core), [], "no marker anywhere");
  // A halted core root refuses before any marker, whether paused or stopped.
  const paused = fixture(t);
  writeFileSync(join(paused.core, "state", "PAUSE"), "{}");
  assert.equal(await refused(paused.service.execute(actor, paused.command())), "fleet_halted");
  assert.deepEqual(readdirKicks(paused.core), []);
  // A core root whose state directory this process cannot reach is unreadable.
  const noState = fixture(t);
  const bare = join(noState.root, "bare-core");
  mkdirSync(bare);
  assert.equal(await refused(new ProductBuildService({ ...noState.options, root: bare }).execute(actor, noState.command())), "target_unreadable", "a core root with no state directory is unreadable");
  // An unenrolled target is refused by the request, and by the daemon when a marker arrives anyway.
  const stray = fixture(t);
  writeFileSync(join(stray.checkout, ".remudero", "managed-repos.json"), JSON.stringify({ repos: ["craigoley/something-else"] }));
  const strayKick = { taskId: "W9-T1", origin: "product:p/op", repo: "wreckterra", requestedAt: new Date().toISOString() };
  writeFileSync(marker(stray.core, "wreckterra", "W9-T1"), JSON.stringify(strayKick));
  const strayRun = await stray.drive();
  assert.deepEqual(stray.calls.runTask, []);
  assert.deepEqual(strayRun.lines.filter((line) => line.step === "console.kick_refused").map((line) => line.extra.reason), ["target is not an enrolled managed repository"]);
  assert.ok(!existsSync(marker(stray.core, "wreckterra", "W9-T1")));
  // A malformed managed set or registry at the daemon is held, never refused and never dispatched.
  const unreadable = fixture(t);
  writeFileSync(marker(unreadable.core, "wreckterra", "W9-T1"), JSON.stringify(strayKick));
  writeFileSync(join(unreadable.checkout, ".remudero", "managed-repos.json"), "{not json");
  const heldRun = await unreadable.drive();
  assert.deepEqual(unreadable.calls.runTask, []);
  assert.ok(heldRun.lines.some((line) => line.step === "target_job.unknown"));
  assert.ok(existsSync(marker(unreadable.core, "wreckterra", "W9-T1")), "an unreadable source leaves the marker for a later tick");

  // A live instance keeps its own kick path: the marker goes to ITS root, and the core daemon refuses a stray one.
  const own = fixture(t, WITH_OWN);
  const request = await started(own);
  assert.ok(existsSync(marker(join(own.stateBase, "wreckterra"), "wreckterra", "W9-T1")), "the marker sits under the instance's own root");
  assert.deepEqual(readdirKicks(own.core), [], "none under the core root");
  assert.deepEqual(daemonKickPort(join(own.stateBase, "wreckterra"), { repo: "wreckterra", isSelf: false }).pendingKicks().map((kick) => kick.origin), [request.origin]);
  writeFileSync(marker(own.core, "wreckterra", "W9-T1"), JSON.stringify({ ...strayKick, origin: request.origin }));
  const refusedStray = await own.drive();
  assert.deepEqual(own.calls.runTask, [], "the core daemon never runs a target another instance drives");
  assert.match(String(refusedStray.lines.find((line) => line.step === "console.kick_refused")?.extra.reason), /wreckterra drives this repository/);
  assert.ok(existsSync(marker(join(own.stateBase, "wreckterra"), "wreckterra", "W9-T1")), "the instance's own marker is untouched");
});
