import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  BOOTSTRAP_CHECKS, bootstrapConfirmed, bootstrapEvidenceId, ghProductBuildTarget, productBuildKickOrigin, productPlanOrigin, ProductBuildService,
  fileTargetJobStore, readTargetExecution, registryDaemonRoot, starterEvidenceId,
  type BootstrapRead, type BuildObservation, type BuildTask, type ExecutionQuery, type ProductBuildOptions, type ProductBuildTarget, type TargetInspection, type TaskRead,
} from "#src/lib/product-build.js";
import { createNativeTargetJobRunner, daemonKickPort, daemonTargetJobPort } from "#src/cli/commands/daemon.js";
import { runDrain, type DrainOpts, type TargetJobRecord } from "#src/lib/drain.js";
import { clockFromMillisFn, fixedClock } from "#src/lib/clock.js";
import { runDaemon, type DaemonDeps, type DaemonOpts } from "#src/lib/daemon.js";
import { requestKick } from "#src/lib/fleet-control.js";
import { appendLedger, type LedgerLine } from "#src/lib/ledger.js";
import { DEFAULT_LIVENESS_BOUND_MS } from "#src/lib/non-worker-verdict.js";
import { loadPlan } from "#src/lib/plan.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import type { ProductRepositoryProvider, ProviderRead } from "#src/lib/product-repository.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { writeLedger, type LedgerFixture } from "#test/helpers/ledger-fixture.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const actor = "clerk:alice";
const kickMarker = (root: string, repo: string, taskId: string) => join(root, "state", `KICK_REQUESTED-${repo}:${taskId}`);
const HEAD = "a".repeat(40);
const ID = 1432832754;
const identity = { provider: "github", id: ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public", verifiedAt: "2026-10-26T00:00:00.000Z" } as const;
const planEvidence = { id: "plan-approved-1", stage: "plan", outcome: "succeeded", objectiveRevision: 1, observedAt: "2026-10-26T00:00:01.000Z", references: [] } as const;
/** The repo-tracked registry shape: core drives remudero; Wreckterra has its own (shadow) daemon instance. */
const REGISTRY = "instances:\n  core:\n    github_repo: craigoley/remudero\n  wreckterra:\n    github_repo: craigoley/wreckterra\n    mode: shadow\n";

class FakeTarget implements ProductBuildTarget {
  inspection: TargetInspection = { enrolled: true, head: HEAD, readmeOnly: false };
  runner = true;
  taskRead: TaskRead | undefined;
  observation: BuildObservation = { state: "none", branches: [] };
  calls: string[] = [];
  productId = "";
  constructor() { this.taskRead = undefined; }
  withTask(over: Partial<BuildTask> = {}) {
    this.taskRead = { state: "found", task: { id: "W9-T1", origin: productPlanOrigin(this.productId, planEvidence.id), status: "queued", budgetUsd: 10, claimed: false, merged: false, ...over } };
    return this;
  }
  async inspect() { this.calls.push("inspect"); return this.inspection; }
  runnerRegistered() { this.calls.push("runner"); return this.runner; }
  async task() { this.calls.push("task"); return this.taskRead ?? { state: "absent" as const }; }
  async observe() { this.calls.push("observe"); return this.observation; }
  bootstrapRead: BootstrapRead = { state: "absent" };
  bootstrapHeads: string[] = [];
  async bootstrap(_repo: unknown, head: string) { this.calls.push("bootstrap"); this.bootstrapHeads.push(head); return this.bootstrapRead; }
}

function fixture(t: TestContext, over: { target?: FakeTarget; envelope?: boolean } = {}) {
  const root = ownedFixtureDir(t, "product-build").dir;
  const store = new ProductIntentStore({ root });
  const brief = { idea: "private product", ...(over.envelope === false ? {} : { resourceEnvelope: { budgetUsd: 30, maxConcurrentBuilds: 1, existingSetupOnly: true } }) };
  const saved = store.write(actor, { version: "product-intent-v1", requestId: "seed-product-00001", expectedRevision: 0, brief });
  assert.ok(saved.ok);
  const productId = saved.value.receipt.productId;
  const moved = store.transition(actor, { version: "product-intent-v1", requestId: "seed-trusted-000001", id: productId,
    expectedRevision: 1, expectedObjectiveRevision: 1, repository: identity, stageEvidence: [planEvidence] });
  assert.ok(moved.ok);
  const target = over.target ?? new FakeTarget();
  target.productId = productId;
  if (target instanceof FakeTarget && !target.taskRead) target.withTask();
  const provider: Pick<ProductRepositoryProvider, "read"> & { reads: number; next: ProviderRead } = {
    reads: 0,
    next: { state: "found", repository: { id: ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" } },
    async read() { this.reads += 1; return this.next; },
  };
  const kicks: string[][] = [];
  // The real registry resolver over a real registry file: the target's own daemon root sits under the state base.
  const registryPath = join(root, "daemon-instances.yaml");
  writeFileSync(registryPath, REGISTRY);
  const stateBase = join(root, "instances");
  const daemonRoot = join(stateBase, "wreckterra");
  mkdirSync(join(daemonRoot, "state"), { recursive: true });
  const options: ProductBuildOptions = { root, store, target, provider, clock: fixedClock(Date.parse("2026-10-26T01:00:00.000Z")),
    instances: { registryPath, stateBase },
    kick: (kickRoot, taskId, origin, repo) => { kicks.push([taskId, origin, repo]); assert.equal(kickRoot, daemonRoot, "the marker goes to the target's own daemon root"); } };
  const service = new ProductBuildService(options);
  const command = (extra: Record<string, unknown> = {}) => ({ version: "product-build-v1", requestId: "build-request-0001", productId,
    planEvidenceId: planEvidence.id, taskId: "W9-T1", expectedRevision: 2, expectedObjectiveRevision: 1, ...extra });
  return { root, daemonRoot, registryPath, stateBase, store, productId, target, provider, kicks, service, command, options };
}
const refused = async (promise: ReturnType<ProductBuildService["execute"]>) => { const result = await promise; assert.equal(result.ok, false); return result.code; };
const REQUESTED_MS = Date.parse("2026-10-26T01:00:00.000Z");
const RUN_ID = "W9-T1-1793034698650";

/** The TARGET daemon's own ledger, seeded by test/helpers/ledger-fixture.ts on its first row (no file before it):
 *  daemon rows shaped as daemonCommand's `log`, run rows as runTask's, each `ts` stamped as appendLedger stamps it. */
function targetDaemonRows(daemonRoot: string) {
  const dir = join(daemonRoot, "state");
  let fixture: LedgerFixture | undefined;
  const append = (atMs: number, line: LedgerLine) => {
    fixture ??= writeLedger([], { dir });
    fixture.append([{ ts: fixedClock(atMs).iso(), ...line }]);
  };
  return {
    path: join(dir, "ledger.ndjson"),
    daemon: (atMs: number, step: string, extra: Record<string, unknown> = {}) => append(atMs, { run_id: "DAEMON-1", task_id: "DAEMON", step, lane: "daemon", ...extra }),
    run: (atMs: number, runId: string, step: string, extra: Record<string, unknown> = {}) => append(atMs, { run_id: runId, task_id: "W9-T1", step, lane: "run-task", repo: "wreckterra", ...extra }),
  };
}
const buildRows = async (f: ReturnType<typeof fixture>, operationId: string) => {
  const read = f.store.read(actor, f.productId);
  assert.ok(read.ok);
  return read.value.stageEvidence.filter((item) => item.id.startsWith(operationId));
};

test("W1-T10615: product build refuses missing runner claims and stale task ownership", async (t) => {
  const { service, command, kicks, target, store, productId } = fixture(t);
  assert.equal(await refused(service.execute("", command())), "invalid_identity");
  assert.equal(await refused(service.execute(actor, { ...command(), extra: 1 })), "invalid_input");
  target.runner = false;
  assert.equal(await refused(service.execute(actor, command())), "runner_missing");
  target.runner = true;
  target.inspection = { enrolled: false, head: HEAD, readmeOnly: false };
  assert.equal(await refused(service.execute(actor, command())), "target_not_enrolled");
  target.inspection = { enrolled: undefined, head: HEAD, readmeOnly: false };
  assert.equal(await refused(service.execute(actor, command())), "target_unreadable");
  target.inspection = { enrolled: true, head: undefined, readmeOnly: undefined };
  assert.equal(await refused(service.execute(actor, command())), "target_unreadable");
  target.inspection = { enrolled: true, head: HEAD, readmeOnly: false };
  target.withTask({ origin: productPlanOrigin(productId, "a-different-plan") });
  assert.equal(await refused(service.execute(actor, command())), "task_stale");
  target.withTask({ origin: undefined });
  assert.equal(await refused(service.execute(actor, command())), "task_stale");
  target.withTask({ status: "merged" });
  assert.equal(await refused(service.execute(actor, command())), "task_stale");
  target.withTask({ claimed: true });
  assert.equal(await refused(service.execute(actor, command())), "task_claimed");
  target.withTask({ merged: true });
  assert.equal(await refused(service.execute(actor, command())), "task_merged");
  target.withTask({ budgetUsd: 31 });
  assert.equal(await refused(service.execute(actor, command())), "budget_exceeded");
  target.withTask({ budgetUsd: undefined });
  assert.equal(await refused(service.execute(actor, command())), "budget_exceeded");
  target.taskRead = { state: "unreadable" };
  assert.equal(await refused(service.execute(actor, command())), "task_unreadable");
  target.taskRead = { state: "absent" };
  assert.equal(await refused(service.execute(actor, command())), "task_not_found");
  assert.equal(await refused(service.execute(actor, command({ planEvidenceId: "unknown-plan" }))), "plan_not_approved");
  assert.equal(await refused(service.execute(actor, command({ expectedRevision: 1 }))), "stale_revision");
  assert.equal(await refused(service.execute("clerk:bob", command())), "not_found");
  assert.deepEqual(kicks, [], "no refusal ever wrote a kick marker");
  const product = store.read(actor, productId);
  assert.ok(product.ok);
  assert.equal(product.value.stageEvidence.length, 1, "no refusal recorded stage evidence");
});

test("W1-T10615: a product build starts through the admitted target repository path", async (t) => {
  const f = fixture(t);
  const started = await f.service.execute(actor, f.command());
  assert.ok(started.ok);
  assert.equal(started.value.replayed, false);
  assert.equal(started.value.receipt.outcome, "queued");
  const origin = productBuildKickOrigin(f.productId, started.value.receipt.operationId);
  assert.deepEqual(f.kicks, [["W9-T1", origin, "wreckterra"]], "exactly one repo-scoped kick, naming this request, through the injected guarded seam");
  assert.equal(started.value.receipt.queuedAt, "2026-10-26T01:00:00.000Z", "the request's own time is recorded with its queue entry");
  const read = f.store.read(actor, f.productId);
  assert.ok(read.ok);
  const queued = read.value.stageEvidence.find((item) => item.id === started.value.receipt.operationId);
  assert.equal(queued?.stage, "build");
  assert.equal(queued?.outcome, "queued");
  // An identical retry replays the receipt: no second kick, no second record.
  const again = await f.service.execute(actor, f.command());
  assert.ok(again.ok);
  assert.equal(again.value.replayed, true);
  assert.equal(f.kicks.length, 1);
  assert.deepEqual(again.value.receipt, started.value.receipt);
  // The same request id with another task is a conflict, never a second start.
  assert.equal(await refused(f.service.execute(actor, f.command({ taskId: "W9-T2" }))), "idempotency_conflict");
  assert.equal(f.kicks.length, 1);
  // Independent evidence: admitted, then running with a real link, each its own record.
  f.target.observation = { state: "admitted", branches: [`run-${RUN_ID}`] };
  const admitted = await f.service.execute(actor, f.command());
  assert.ok(admitted.ok);
  assert.equal(admitted.value.receipt.outcome, "admitted", "a held claim and a published branch are admission, never running");
  // Running is the target daemon's own evidence: it dispatched THIS request's kick and the run it started has not ended.
  const ledger = targetDaemonRows(f.daemonRoot);
  ledger.daemon(REQUESTED_MS, "console.kick_dispatched", { task: "W9-T1", origin, repo: "wreckterra" });
  ledger.run(REQUESTED_MS, RUN_ID, "run.start", { repo: "wreckterra", type: "implement" });
  const running = await f.service.execute(actor, f.command());
  assert.ok(running.ok);
  assert.equal(running.value.receipt.outcome, "running");
  assert.deepEqual(running.value.receipt.evidence.map((item) => item.outcome), ["queued", "admitted", "running"]);
  const linked = (await buildRows(f, running.value.receipt.operationId)).find((item) => item.outcome === "running");
  assert.equal(linked?.references[0]?.url, `https://github.com/craigoley/wreckterra/tree/run-${RUN_ID}`, "the run's own published branch is its link");
  assert.equal(f.kicks.length, 1);
});

test("W1-T10615: a product build writes the real repo-scoped kick marker by default", async (t) => {
  const f = fixture(t);
  const service = new ProductBuildService({ ...f.options, kick: undefined });
  const started = await service.execute(actor, f.command());
  assert.ok(started.ok);
  assert.ok(existsSync(kickMarker(f.daemonRoot, "wreckterra", "W9-T1")), "the marker sits under the target daemon's own config root");
  assert.ok(!existsSync(kickMarker(f.root, "wreckterra", "W9-T1")), "the core root, which no Wreckterra daemon reads, gets no marker");
  assert.ok(!existsSync(join(f.daemonRoot, "state", "KICK_REQUESTED-W9-T1")), "the unscoped marker of the self daemon is untouched");
  mkdirSync(join(f.root, "state"), { recursive: true });
  writeFileSync(join(f.root, "state", "PAUSE"), "{}");
  const halted = fixture(t);
  writeFileSync(join(halted.root, "state", "STOP"), "{}");
  assert.equal(await refused(halted.service.execute(actor, halted.command())), "fleet_halted");
  assert.equal(await refused(new ProductBuildService({ ...halted.options, root: undefined }).execute(actor, halted.command())), "unavailable");
  // The target's own daemon being halted refuses too, before any marker.
  const paused = fixture(t);
  mkdirSync(join(paused.daemonRoot, "state"), { recursive: true });
  writeFileSync(join(paused.daemonRoot, "state", "PAUSE"), "{}");
  assert.equal(await refused(paused.service.execute(actor, paused.command())), "fleet_halted");
  assert.deepEqual(paused.kicks, []);
});

/** The TARGET repository's own plan, as its daemon loads it: the product task, an ordinary one, and a human-only one. */
const targetPlan = (productId: string) => `
- id: W9-T0
  title: an ordinary queued task
  repo: wreckterra
  type: implement
  depends_on: []
  status: queued
- id: W9-T1
  title: the product's first source task
  repo: wreckterra
  type: implement
  depends_on: []
  status: queued
  origin: product-plan#${productId}/plan-approved-1
  budget_usd: 10
- id: W9-T2
  title: a task only a human verifies
  repo: wreckterra
  type: implement
  verify: human
  depends_on: []
  status: queued
`;

test("W1-T10615: a product build kick reaches only the target daemon's own admission, consumed once", async (t) => {
  const f = fixture(t);
  const service = new ProductBuildService({ ...f.options, kick: undefined });
  const started = await service.execute(actor, f.command());
  assert.ok(started.ok);
  const origin = productBuildKickOrigin(f.productId, started.value.receipt.operationId);
  const planDir = ownedFixtureDir(t, "product-build-target-plan").dir;
  writeFileSync(join(planDir, "tasks.yaml"), targetPlan(f.productId));
  const plan = loadPlan(join(planDir, "tasks.yaml"));
  // One real daemon pass over the CLI's own kick binding: the daemon's admission is the only judge.
  const drive = async (port: ReturnType<typeof daemonKickPort>) => {
    const spawned: string[] = [];
    const lines: { step: string; extra: Record<string, unknown> }[] = [];
    await runDaemon(plan, {
      refreshMerged: () => () => false,
      runOne: async (id) => { spawned.push(id); return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }; },
      ...port, sleep: async () => {}, log: (step, extra = {}) => { lines.push({ step, extra }); },
    }, { headroomEnabled: false, max: 1 });
    return { spawned, kicks: lines.filter((line) => line.step.startsWith("console.kick_")) };
  };
  const marker = kickMarker(f.daemonRoot, "wreckterra", "W9-T1");
  assert.deepEqual(daemonKickPort(f.root, { repo: "remudero", isSelf: true }).pendingKicks(), [], "the core daemon's own root holds no such marker");
  // Another repository's daemon, even over the same root, neither dispatches nor refuses (and so never clears) it.
  for (const other of [{ repo: "remudero-site", isSelf: false }, { repo: "remudero", isSelf: true }]) {
    const run = await drive(daemonKickPort(f.daemonRoot, other));
    assert.deepEqual(run.kicks, [], `${other.repo} left another repository's kick alone`);
    assert.deepEqual(run.spawned, ["W9-T0"], `${other.repo} ran its natural pick, not the kicked task`);
    assert.ok(existsSync(marker), `${other.repo} left the marker in place`);
  }
  // The target daemon picks the task from its OWN plan, and its admission (assertRunnable) admits it.
  const own = daemonKickPort(f.daemonRoot, { repo: "wreckterra", isSelf: false });
  assert.deepEqual(own.pendingKicks().map((kick) => [kick.taskId, kick.repo, kick.origin]), [["W9-T1", "wreckterra", origin]]);
  const dispatched = await drive(own);
  assert.deepEqual(dispatched.spawned, ["W9-T1"], "the kicked task ran ahead of the plan's natural pick, W9-T0");
  assert.deepEqual(dispatched.kicks, [{ step: "console.kick_dispatched", extra: { task: "W9-T1", origin, repo: "wreckterra" } }]);
  assert.ok(!existsSync(marker), "the exact marker was consumed");
  assert.deepEqual((await drive(own)).kicks, [], "consumed once: the next pass finds no kick");
  // The daemon's own dispatch row, written as daemonCommand's `log` writes it, is what the execution reader correlates.
  const ledger = targetDaemonRows(f.daemonRoot);
  const state = join(f.daemonRoot, "state");
  for (const line of dispatched.kicks) ledger.daemon(REQUESTED_MS, line.step, line.extra);
  const query = { taskId: "W9-T1", origin, repo: "wreckterra", requestedAt: started.value.receipt.queuedAt, nowMs: REQUESTED_MS };
  assert.deepEqual(readTargetExecution(state, query), { state: "dispatched" });
  // A refused kick clears exactly its own marker; the unscoped and another repository's marker for the same id remain.
  const second = await service.execute(actor, f.command({ requestId: "build-request-0002", taskId: "W9-T2", expectedRevision: 3 }));
  assert.ok(second.ok);
  requestKick(f.daemonRoot, "W9-T2", "console-run");
  requestKick(f.daemonRoot, "W9-T2", "escalation-triage", "remudero-site");
  const refusal = await drive(own);
  assert.deepEqual(refusal.kicks.map((line) => [line.step, line.extra.task, line.extra.repo]), [["console.kick_refused", "W9-T2", "wreckterra"]]);
  assert.match(String(refusal.kicks[0]!.extra.reason), /verify:human/, "the daemon's own admission named the refusal");
  for (const line of refusal.kicks) ledger.daemon(REQUESTED_MS, line.step, line.extra);
  assert.deepEqual(readTargetExecution(state, { ...query, taskId: "W9-T2", origin: productBuildKickOrigin(f.productId, second.value.receipt.operationId) }), { state: "refused" });
  assert.ok(!refusal.spawned.includes("W9-T2"), "a refused kick never dispatches");
  assert.ok(!existsSync(kickMarker(f.daemonRoot, "wreckterra", "W9-T2")), "the refused marker was cleared");
  assert.ok(existsSync(join(f.daemonRoot, "state", "KICK_REQUESTED-W9-T2")), "the unscoped marker is not this daemon's to clear");
  assert.ok(existsSync(kickMarker(f.daemonRoot, "remudero-site", "W9-T2")), "nor is another repository's");
  // A marker whose body names another repository than its file name is never offered, so no clear can miss it.
  writeFileSync(kickMarker(f.daemonRoot, "wreckterra", "W9-T0"), JSON.stringify({ taskId: "W9-T0", origin: "hand", requestedAt: "2026-10-26T00:00:00.000Z" }));
  assert.deepEqual(own.pendingKicks(), []);
  assert.deepEqual(daemonKickPort(f.daemonRoot, { repo: "remudero", isSelf: true }).pendingKicks().map((kick) => kick.origin), ["console-run"]);
});

test("W1-T10615: a product build refuses a target no live daemon instance drives", async (t) => {
  const f = fixture(t);
  // W1-T10799: a retired instance drives nothing, so the marker goes to the CORE daemon's root, which owns one bounded job.
  const native = fixture(t);
  writeFileSync(native.registryPath, "instances:\n  core:\n    github_repo: craigoley/remudero\n  old:\n    github_repo: craigoley/wreckterra\n    retired: true\n");
  const roots: string[] = [];
  const routed = await new ProductBuildService({ ...native.options, kick: (kickRoot) => { roots.push(kickRoot); } }).execute(actor, native.command());
  assert.ok(routed.ok);
  assert.deepEqual(roots, [native.root], "a retired instance drives nothing: the core root is the marker's home");
  writeFileSync(f.registryPath, "instances:\n  core:\n  wreckterra:\n");
  assert.equal(await refused(f.service.execute(actor, f.command())), "target_unreadable", "a malformed registry is unknown, never no daemon");
  assert.equal(await refused(new ProductBuildService({ ...f.options, instances: undefined }).execute(actor, f.command())), "target_unreadable",
    "no registry path and no checkout is unknown");
  assert.equal(await refused(new ProductBuildService({ ...f.options, daemonRoot: () => ({ state: "found", root: "relative/state", instance: "wreckterra" }) })
    .execute(actor, f.command())), "unavailable", "a daemon root that is not absolute is never written to");
  assert.deepEqual(f.kicks, [], "no refusal wrote a marker");
  // The resolver itself: core's daemon root is this process's fleet root; any other is its state root under the base.
  const repo = { id: ID, owner: "CraigOley", name: "Wreckterra", defaultBranch: "main" };
  writeFileSync(f.registryPath, REGISTRY);
  assert.deepEqual(registryDaemonRoot(f.root, { registryPath: f.registryPath, stateBase: f.stateBase })(repo),
    { state: "found", root: f.daemonRoot, instance: "wreckterra" }, "repository identity is matched without case");
  assert.deepEqual(registryDaemonRoot(f.root, { registryPath: f.registryPath })({ ...repo, owner: "craigoley", name: "remudero" }),
    { state: "found", root: f.root, instance: "core" });
  assert.deepEqual(registryDaemonRoot(undefined, { registryPath: f.registryPath })({ ...repo, name: "remudero" }), { state: "unreadable" });
  assert.deepEqual(registryDaemonRoot(f.root, { registryPath: f.registryPath })({ ...repo, name: "elsewhere" }), { state: "absent" });
  // An instance whose state directory is not mounted here (the gateway's default base, in a test) is unknown, never written to.
  assert.deepEqual(registryDaemonRoot(f.root, { registryPath: f.registryPath })(repo), { state: "unreadable" },
    "the default state base is the instance gateway's own, and it is not reachable from this fixture");
  const unmounted = fixture(t);
  assert.equal(await refused(new ProductBuildService({ ...unmounted.options, instances: { registryPath: unmounted.registryPath, stateBase: join(unmounted.root, "absent") } })
    .execute(actor, unmounted.command())), "target_unreadable");
  assert.ok(!existsSync(join(unmounted.root, "absent")), "an unreachable daemon root is never created");
  // With only a checkout, the registry is the repo-tracked one under it.
  const checkout = ownedFixtureDir(t, "product-build-registry").dir;
  mkdirSync(join(checkout, ".remudero"), { recursive: true });
  writeFileSync(join(checkout, ".remudero", "daemon-instances.yaml"), REGISTRY);
  assert.deepEqual(registryDaemonRoot(f.root, { repoRoot: checkout, stateBase: f.stateBase })(repo), { state: "found", root: f.daemonRoot, instance: "wreckterra" });
});

test("W1-T10615: queued and refused product work never reads as running", async (t) => {
  const f = fixture(t);
  // A fresh claim and a fresh run branch with no execution evidence from the target daemon are recorded as admitted.
  f.target.observation = { state: "admitted", branches: [`run-${RUN_ID}`] };
  const unlinked = await f.service.execute(actor, f.command());
  assert.ok(unlinked.ok);
  assert.equal(unlinked.value.receipt.outcome, "admitted", "GitHub refs without the target daemon's evidence are never reported as running");
  const read = f.store.read(actor, f.productId);
  assert.ok(read.ok);
  assert.ok(read.value.stageEvidence.every((item) => item.outcome !== "running"));
  // An unobserved or unknown state adds nothing beyond the queue the operation itself wrote.
  const quiet = fixture(t);
  quiet.target.observation = { state: "unknown" };
  const unknown = await quiet.service.execute(actor, quiet.command());
  assert.ok(unknown.ok);
  assert.equal(unknown.value.receipt.outcome, "queued");
  const quietRead = quiet.store.read(actor, quiet.productId);
  assert.ok(quietRead.ok);
  assert.ok(quietRead.value.stageEvidence.every((item) => item.outcome !== "running" && item.outcome !== "admitted"));
  // A refused start leaves no build evidence at all.
  const other = fixture(t);
  other.target.withTask({ claimed: true });
  assert.equal(await refused(other.service.execute(actor, other.command())), "task_claimed");
  const none = other.store.read(actor, other.productId);
  assert.ok(none.ok);
  assert.ok(!none.value.stageEvidence.some((item) => item.stage === "build"));
  // A repository that moved, vanished or cannot be read refuses before any kick.
  other.provider.next = { state: "found", repository: { id: 7, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" } };
  assert.equal(await refused(other.service.execute(actor, other.command({ requestId: "build-request-0002" }))), "repository_conflict");
  other.provider.next = { state: "found", repository: { id: ID, owner: "craigoley", name: "wreckterra", defaultBranch: "trunk", visibility: "public" } };
  assert.equal(await refused(other.service.execute(actor, other.command({ requestId: "build-request-0003" }))), "repository_conflict");
  other.provider.next = { state: "absent" };
  assert.equal(await refused(other.service.execute(actor, other.command({ requestId: "build-request-0004" }))), "repository_not_found");
  other.provider.next = { state: "unreadable" };
  assert.equal(await refused(other.service.execute(actor, other.command({ requestId: "build-request-0005" }))), "provider_unreadable");
  assert.deepEqual(other.kicks, []);
  // A kick that cannot be written is explicit, not a recorded queue entry.
  const broken = fixture(t);
  const failing = new ProductBuildService({ ...broken.options, kick: () => { throw new Error("disk full"); } });
  assert.equal(await refused(failing.execute(actor, broken.command())), "kick_failed");
  const after = broken.store.read(actor, broken.productId);
  assert.ok(after.ok);
  assert.ok(!after.value.stageEvidence.some((item) => item.stage === "build"));
  // A product with no repository or no budget envelope cannot start.
  const bare = fixture(t, { envelope: false });
  assert.equal(await refused(bare.service.execute(actor, bare.command())), "budget_exceeded");
  const store = new ProductIntentStore({ root: bare.root });
  const fresh = store.write(actor, { version: "product-intent-v1", requestId: "seed-product-00002", expectedRevision: 0, brief: { idea: "no repo yet" } });
  assert.ok(fresh.ok);
  assert.equal(await refused(bare.service.execute(actor, bare.command({ productId: fresh.value.receipt.productId, expectedRevision: 1 }))), "repository_missing");
});

/** One started build whose later observations run at `observe(atMs)`, against the target daemon's real ledger. */
async function observedBuild(t: TestContext, observation: BuildObservation = { state: "admitted", branches: [`run-${RUN_ID}`] }) {
  const f = fixture(t);
  let now = REQUESTED_MS;
  const service = new ProductBuildService({ ...f.options, clock: clockFromMillisFn(() => now) });
  const started = await service.execute(actor, f.command());
  assert.ok(started.ok);
  assert.equal(started.value.receipt.outcome, "queued", "no claim and no target ledger yet");
  f.target.observation = observation;
  const origin = productBuildKickOrigin(f.productId, started.value.receipt.operationId);
  const observe = async (atMs: number) => {
    now = atMs;
    const result = await service.execute(actor, f.command());
    assert.ok(result.ok);
    return result.value.receipt.outcome;
  };
  return { f, origin, ledger: targetDaemonRows(f.daemonRoot), observe };
}

test("W1-T10615: only the target daemon's evidence of this request's own run reads as running", async (t) => {
  // Fresh admission without execution: a fresh claim and branch, a live daemon, and an EARLIER request's run of the same
  // task that started before this request and is still writing after it.
  const fresh = await observedBuild(t);
  fresh.ledger.daemon(REQUESTED_MS - 60_000, "daemon.start", { repo: "wreckterra" });
  fresh.ledger.run(REQUESTED_MS - 30_000, "W9-T1-1793034000000", "run.start", { type: "implement" });
  fresh.ledger.run(REQUESTED_MS + 60_000, "W9-T1-1793034000000", "worker.activity", { event_kind: "tool" });
  assert.equal(await fresh.observe(REQUESTED_MS + 120_000), "admitted", "an earlier request's run is never this build running");
  // The daemon's admission consumed THIS request's kick, but no run has started from it yet.
  fresh.ledger.daemon(REQUESTED_MS + 130_000, "console.kick_dispatched", { task: "W9-T1", origin: fresh.origin, repo: "wreckterra" });
  assert.equal(await fresh.observe(REQUESTED_MS + 140_000), "admitted", "a consumed kick is admission until its run starts");
  fresh.ledger.run(REQUESTED_MS + 150_000, RUN_ID, "run.start", { type: "implement" });
  assert.equal(await fresh.observe(REQUESTED_MS + 160_000), "running", "the run this request's dispatch started, with no terminal row");

  // Leftover refs after a terminal run: the claim and branch remain, and the run wrote its own verdict.
  const ended = await observedBuild(t);
  ended.ledger.daemon(REQUESTED_MS + 1_000, "console.kick_dispatched", { task: "W9-T1", origin: ended.origin, repo: "wreckterra" });
  ended.ledger.run(REQUESTED_MS + 2_000, RUN_ID, "run.start", { type: "implement" });
  ended.ledger.run(REQUESTED_MS + 3_000, RUN_ID, "verdict", { verdict: "failed", stage: "run.error" });
  assert.equal(await ended.observe(REQUESTED_MS + 4_000), "admitted", "fresh refs left after a terminal run never read as running");

  // A refused kick: another dispatch's claim is not this request's admission, and nothing runs.
  const refusal = await observedBuild(t);
  refusal.ledger.daemon(REQUESTED_MS + 1_000, "console.kick_refused", { task: "W9-T1", origin: refusal.origin, reason: "task is verify:human", repo: "wreckterra" });
  assert.equal(await refusal.observe(REQUESTED_MS + 2_000), "queued", "a refused request is neither admitted nor running");

  // A run that wrote no terminal row and nothing inside the liveness bound died silently.
  const silent = await observedBuild(t);
  silent.ledger.daemon(REQUESTED_MS + 1_000, "console.kick_dispatched", { task: "W9-T1", origin: silent.origin, repo: "wreckterra" });
  silent.ledger.run(REQUESTED_MS + 2_000, RUN_ID, "run.start", { type: "implement" });
  assert.equal(await silent.observe(REQUESTED_MS + 2_000 + DEFAULT_LIVENESS_BOUND_MS + 1), "admitted");

  // An unreadable target ledger is unknown: even an archive that shows this request's live run is not read past it.
  const blind = await observedBuild(t, { state: "none", branches: [] });
  writeFileSync(join(blind.f.daemonRoot, "state", "ledger.2026-10-26T01-00-05-000Z.ndjson"), [
    { ts: "2026-10-26T01:00:01.000Z", run_id: "DAEMON-1", task_id: "DAEMON", step: "console.kick_dispatched", task: "W9-T1", origin: blind.origin, repo: "wreckterra" },
    { ts: "2026-10-26T01:00:02.000Z", run_id: RUN_ID, task_id: "W9-T1", step: "run.start", repo: "wreckterra" },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  mkdirSync(join(blind.f.daemonRoot, "state", "ledger.ndjson"));
  assert.equal(await blind.observe(REQUESTED_MS + 3_000), "queued", "an unreadable live file is never a complete corpus");

  // A daemon whose state this process cannot reach answers unknown, never running; reachable again, its run reads.
  const remote = await observedBuild(t);
  remote.ledger.daemon(REQUESTED_MS + 1_000, "console.kick_dispatched", { task: "W9-T1", origin: remote.origin, repo: "wreckterra" });
  remote.ledger.run(REQUESTED_MS + 2_000, RUN_ID, "run.start", { type: "implement" });
  writeFileSync(remote.f.registryPath, "instances:\n  core:\n    github_repo: craigoley/remudero\n  wreckterra:\n    github_repo: craigoley/wreckterra\n    retired: true\n");
  assert.equal(await remote.observe(REQUESTED_MS + 3_000), "queued", "the native fallback requires its own correlated receipt");
  writeFileSync(remote.f.registryPath, REGISTRY);
  assert.equal(await remote.observe(REQUESTED_MS + 4_000), "running");
});

test("W1-T10615: the target execution reader correlates this request, never freshness", (t) => {
  const dir = ownedFixtureDir(t, "product-build-execution").dir;
  const state = join(dir, "state");
  const query: ExecutionQuery = { taskId: "W9-T1", origin: "product:prd_x/pbuild_1", repo: "wreckterra", requestedAt: "2026-10-26T01:00:00.000Z", nowMs: REQUESTED_MS + 60_000 };
  assert.deepEqual(readTargetExecution(state, query), { state: "unknown" }, "a state directory that cannot be listed");
  mkdirSync(state);
  assert.deepEqual(readTargetExecution(state, query), { state: "unknown" }, "no ledger at all is a daemon this process cannot see");
  const ledger = targetDaemonRows(dir);
  const kick = { task: "W9-T1", origin: query.origin, repo: "wreckterra" };
  ledger.daemon(REQUESTED_MS - 1, "console.kick_dispatched", kick);
  ledger.daemon(REQUESTED_MS + 1, "console.kick_dispatched", { ...kick, task: "W9-T10" });
  ledger.daemon(REQUESTED_MS + 1, "console.kick_dispatched", { ...kick, origin: "product:prd_x/pbuild_0" });
  ledger.daemon(REQUESTED_MS + 1, "console.kick_dispatched", { ...kick, repo: "remudero-site" });
  ledger.daemon(REQUESTED_MS + 1, "console.kick_dispatched", { task: "W9-T1", origin: query.origin });
  writeFileSync(ledger.path, `${JSON.stringify({ ts: "garbled", step: "console.kick_refused", ...kick })}\n`, { flag: "a" });
  assert.deepEqual(readTargetExecution(state, query), { state: "none" }, "an earlier, sibling, other-request, other-repo or unscoped kick is not this one");
  ledger.daemon(REQUESTED_MS + 2, "console.kick_dispatched", { ...kick, repo: "Wreckterra" });
  assert.deepEqual(readTargetExecution(state, query), { state: "dispatched" });
  appendLedger(ledger.path, { run_id: "W9-T10-1", task_id: "W9-T10", step: "run.start" }, { clock: fixedClock(REQUESTED_MS + 3) });
  ledger.run(REQUESTED_MS + 3, "elsewhere-1", "run.start");
  ledger.run(REQUESTED_MS + 1, "W9-T1-1", "run.start");
  assert.deepEqual(readTargetExecution(state, query), { state: "dispatched" }, "a sibling's run, a foreign run id, or a run before the dispatch");
  ledger.run(REQUESTED_MS + 4, RUN_ID, "run.start");
  ledger.run(REQUESTED_MS + 9, "W9-T1-2", "run.start");
  assert.deepEqual(readTargetExecution(state, query), { state: "running", runId: RUN_ID }, "the first run at or after the dispatch is its run");
  assert.deepEqual(readTargetExecution(state, { ...query, nowMs: REQUESTED_MS + 4 + DEFAULT_LIVENESS_BOUND_MS }), { state: "running", runId: RUN_ID });
  assert.deepEqual(readTargetExecution(state, { ...query, nowMs: REQUESTED_MS + 5 + DEFAULT_LIVENESS_BOUND_MS }), { state: "silent", runId: RUN_ID });
  ledger.run(REQUESTED_MS + 10, RUN_ID, "worker.activity");
  assert.deepEqual(readTargetExecution(state, { ...query, nowMs: REQUESTED_MS + 5 + DEFAULT_LIVENESS_BOUND_MS }), { state: "running", runId: RUN_ID });
  ledger.run(REQUESTED_MS + 11, RUN_ID, "run.error", { error: "boom" });
  assert.deepEqual(readTargetExecution(state, query), { state: "ended", runId: RUN_ID }, "a thrown run's own terminal row");
  assert.deepEqual(readTargetExecution(state, { ...query, origin: "product:prd_x/pbuild_0" }), { state: "running", runId: "W9-T1-1" },
    "the other request's dispatch has its own run, which was never this request's");
  ledger.daemon(REQUESTED_MS + 1, "console.kick_refused", { ...kick, origin: "product:prd_x/pbuild_r", reason: "unknown task id" });
  assert.deepEqual(readTargetExecution(state, { ...query, origin: "product:prd_x/pbuild_r" }), { state: "refused" });
  // A rotation this process cannot read is unknown, never a corpus with nothing in it.
  writeFileSync(join(state, "ledger.2026-10-26T01-00-05-000Z.ndjson.gz"), "not gzip");
  assert.deepEqual(readTargetExecution(state, query), { state: "unknown" });
});

test("W1-T10615: a README-only product verifies bootstrap before filing source tasks", async (t) => {
  const target = new FakeTarget();
  target.inspection = { enrolled: true, head: HEAD, readmeOnly: true };
  const f = fixture(t, { target });
  assert.equal(await refused(f.service.execute(actor, f.command())), "bootstrap_unverified");
  assert.deepEqual(f.kicks, []);
  const product = f.store.read(actor, f.productId);
  assert.ok(product.ok);
  assert.equal(bootstrapConfirmed(product.value, target.inspection), false);
  assert.equal(bootstrapConfirmed(product.value, { head: undefined, readmeOnly: true }), false);
  assert.equal(bootstrapConfirmed(product.value, { head: HEAD, readmeOnly: undefined }), false);
  assert.equal(bootstrapConfirmed(product.value, { head: HEAD, readmeOnly: false }), true, "a repository with source needs no bootstrap");
  assert.deepEqual(target.bootstrapHeads, [HEAD], "the production reconciler asked GitHub about the exact head");
  const bootstrapRows = () => { const read = f.store.read(actor, f.productId); assert.ok(read.ok); return read.value.stageEvidence.filter((item) => item.id.startsWith("bootstrap")); };
  assert.deepEqual(bootstrapRows(), [], "an absent starter records nothing");
  // Receipts for an OLDER head never satisfy the current head (seeded as a trusted mechanism would have left them).
  const stale = f.store.transition(actor, { version: "product-intent-v1", requestId: "bootstrap-stale-0001", id: f.productId, expectedRevision: 2, expectedObjectiveRevision: 1,
    stageEvidence: BOOTSTRAP_CHECKS.map((check) => ({ id: bootstrapEvidenceId("b".repeat(40), check), stage: "repository" as const, outcome: "succeeded" as const,
      objectiveRevision: 1, observedAt: "2026-10-26T00:30:00.000Z", references: [{ label: "starter PR", url: "https://github.com/craigoley/wreckterra/pull/1" }] })) });
  assert.ok(stale.ok);
  const allChecks = { test: true, typecheck: true, build: true, security: true };
  target.bootstrapRead = { state: "absent" };
  assert.equal(await refused(f.service.execute(actor, f.command({ expectedRevision: 3 }))), "bootstrap_unverified");
  target.bootstrapRead = { state: "unreadable" };
  assert.equal(await refused(f.service.execute(actor, f.command({ expectedRevision: 3 }))), "bootstrap_unverified");
  target.bootstrapRead = { state: "found", starter: { number: 7, reviewed: false }, checks: allChecks };
  assert.equal(await refused(f.service.execute(actor, f.command({ expectedRevision: 3 }))), "bootstrap_unverified");
  assert.equal(bootstrapRows().filter((item) => item.id.includes(HEAD)).length, 0, "an unreviewed starter records no receipt: nothing is invented");
  // Reviewed, but only three checks really passed: those are persisted, the fourth stays unverified and the gate closed.
  target.bootstrapRead = { state: "found", starter: { number: 7, reviewed: true }, checks: { ...allChecks, security: false } };
  assert.equal(await refused(f.service.execute(actor, f.command({ expectedRevision: 3 }))), "bootstrap_unverified");
  assert.deepEqual(bootstrapRows().filter((item) => item.id.includes(HEAD)).map((item) => item.id),
    [starterEvidenceId(HEAD), ...(["test", "typecheck", "build"] as const).map((check) => bootstrapEvidenceId(HEAD, check))]);
  assert.deepEqual(f.kicks, []);
  // The reconciler recorded real receipts, so the next request (at the revision it produced) is admitted without any fixture write.
  target.bootstrapRead = { state: "found", starter: { number: 7, reviewed: true }, checks: allChecks };
  const started = await f.service.execute(actor, f.command({ expectedRevision: 4 }));
  assert.ok(started.ok);
  assert.equal(started.value.receipt.outcome, "queued");
  assert.equal(f.kicks.length, 1);
  const recorded = f.store.read(actor, f.productId);
  assert.ok(recorded.ok);
  assert.equal(bootstrapConfirmed(recorded.value, target.inspection), true);
  assert.ok(bootstrapRows().filter((item) => item.id.includes(HEAD)).every((item) => item.references[0]?.url === "https://github.com/craigoley/wreckterra/pull/7"));
});

test("W1-T10615: the default target reads the starter PR, its review and check receipts at the exact head", async () => {
  const repo = { id: ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main" };
  const calls: string[] = [];
  let pulls: unknown = [{ number: 7, merged_at: "2026-10-26T00:10:00Z", merge_commit_sha: HEAD, base: { ref: "main" } }];
  let reviews: unknown = [{ state: "APPROVED", user: { login: "rev" } }, { state: "COMMENTED", user: { login: "rev" } }];
  let runs: unknown = { check_runs: [
    { name: "test", status: "completed", conclusion: "success" }, { name: "CI / typecheck", status: "completed", conclusion: "success" },
    { name: "build", status: "completed", conclusion: "success" }, { name: "security", status: "completed", conclusion: "failure" }] };
  const text = async (args: string[]) => {
    const path = args.at(-1) ?? "";
    calls.push(path);
    if (path.includes("/pulls/7/reviews")) return JSON.stringify(reviews);
    if (path.includes(`/commits/${HEAD}/pulls`)) return JSON.stringify(pulls);
    if (path.includes(`/commits/${HEAD}/check-runs`)) return JSON.stringify(runs);
    throw new Error(`unrouted ${path}`);
  };
  const target = ghProductBuildTarget({ text });
  assert.deepEqual(await target.bootstrap(repo, HEAD), { state: "found", starter: { number: 7, reviewed: true }, checks: { test: true, typecheck: true, build: true, security: false } });
  runs = { check_runs: [{ name: "test", status: "in_progress", conclusion: null }] };
  assert.deepEqual((await target.bootstrap(repo, HEAD) as { checks: unknown }).checks, { test: false, typecheck: false, build: false, security: false });
  reviews = [{ state: "APPROVED", user: { login: "rev" } }, { state: "CHANGES_REQUESTED", user: { login: "other" } }];
  assert.equal((await target.bootstrap(repo, HEAD) as { starter: { reviewed: boolean } }).starter.reviewed, false, "an outstanding change request is not review");
  reviews = [{ state: "APPROVED", user: { login: "rev" } }, { state: "DISMISSED", user: { login: "rev" } }];
  assert.equal((await target.bootstrap(repo, HEAD) as { starter: { reviewed: boolean } }).starter.reviewed, false, "a dismissed approval is not review");
  pulls = [{ number: 7, merged_at: "2026-10-26T00:10:00Z", merge_commit_sha: "c".repeat(40), base: { ref: "main" } }, { number: 8, merged_at: null, merge_commit_sha: HEAD, base: { ref: "main" } }];
  assert.deepEqual(await target.bootstrap(repo, HEAD), { state: "absent" }, "only the merged PR whose merge commit is this head counts");
  pulls = { not: "an array" };
  assert.deepEqual(await target.bootstrap(repo, HEAD), { state: "unreadable" });
  assert.ok(calls.every((path) => !path.includes("undefined")));
});

test("W1-T10615: the default target reads the real managed set, runner registry and gh transport", async (t) => {
  const repoRoot = ownedFixtureDir(t, "product-build-managed").dir;
  mkdirSync(join(repoRoot, ".remudero"), { recursive: true });
  writeFileSync(join(repoRoot, ".remudero", "managed-repos.json"), JSON.stringify({ repos: ["craigoley/wreckterra"] }));
  const repo = { id: ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main" };
  const shard = "- id: W9-T1\n  origin: product-plan#prd_x/plan-approved-1\n  status: queued\n  budget_usd: 10\n";
  const ANCHOR = "1".repeat(40);
  const TIP = "2".repeat(40);
  const claimRef = JSON.stringify([{ ref: "refs/rmd-dispatch/W9-T1", object: { sha: ANCHOR } }]);
  const routes: { when: string; stdout: string }[] = [
    { when: "commits/main", stdout: JSON.stringify({ sha: HEAD }) },
    { when: `contents?ref=${HEAD}`, stdout: JSON.stringify([{ name: "README.md" }, { name: "LICENSE" }]) },
    { when: "contents/plan/tasks.d/W9-T1-first.yaml", stdout: shard },
    { when: "contents/plan/tasks.d?ref=main", stdout: JSON.stringify([{ name: "W9-T1-first.yaml" }]) },
    { when: "matching-refs/rmd-dispatch/W9-T1", stdout: JSON.stringify([]) },
    { when: "matching-refs/heads/run-W9-T1-", stdout: JSON.stringify([{ ref: "refs/heads/run-W9-T1-17", object: { sha: TIP } }]) },
    { when: "search/issues", stdout: JSON.stringify({ total_count: 0 }) },
  ];
  const answer = async (args: string[]) => {
    const joined = args.join(" ");
    const route = routes.find((entry) => joined.includes(entry.when));
    if (!route) throw new Error(`unrouted ${joined}`);
    return route.stdout;
  };
  const override = (when: string, stdout: string) => { routes.unshift({ when, stdout }); };
  const target = ghProductBuildTarget({ repoRoot, text: answer });
  // One call over the real default transport proves the production seam is not only ever faked.
  const shim = ghShim([{ when: "commits/main", stdout: JSON.stringify({ sha: HEAD }) }, { when: "contents?ref=", stdout: JSON.stringify([{ name: "src" }]) }]);
  const original = process.env.PATH;
  process.env.PATH = `${shim.dir}:${original}`;
  t.after(() => { process.env.PATH = original; });
  assert.deepEqual(await ghProductBuildTarget({ repoRoot }).inspect(repo), { enrolled: true, head: HEAD, readmeOnly: false });
  assert.ok(shim.calls().some((call) => call.includes("commits/main")));
  assert.deepEqual(await target.inspect(repo), { enrolled: true, head: HEAD, readmeOnly: true });
  assert.equal(target.runnerRegistered(repo), true, "the closed registry names the owned Wreckterra runner");
  assert.equal(target.runnerRegistered({ ...repo, name: "not-registered" }), false, "an unknown repository has no runner claim");
  assert.deepEqual(await target.task(repo, "W9-T1"), { state: "found", task: { id: "W9-T1", origin: "product-plan#prd_x/plan-approved-1", status: "queued", budgetUsd: 10, claimed: false, merged: false } });
  assert.deepEqual(await target.task(repo, "W9-T2"), { state: "absent" });
  assert.deepEqual(await target.observe(repo, "W9-T1"), { state: "none", branches: ["run-W9-T1-17"] });
  // `matching-refs` is a prefix match: a sibling task's claim is neither this task's claim nor its admission.
  override("matching-refs/rmd-dispatch/W9-T1", JSON.stringify([{ ref: "refs/rmd-dispatch/W9-T10", object: { sha: ANCHOR } }]));
  assert.deepEqual(await target.observe(repo, "W9-T1"), { state: "none", branches: ["run-W9-T1-17"] });
  const sibling = await target.task(repo, "W9-T1");
  assert.ok(sibling.state === "found" && !sibling.task.claimed, "W9-T10's claim never reads as W9-T1's");
  // A claim taken a minute ago with its run branch freshly published is ADMISSION: GitHub refs cannot express running,
  // because a claim can precede the worker and an ended or refused run leaves both behind. The branch is only a link.
  override("matching-refs/rmd-dispatch/W9-T1", claimRef);
  assert.deepEqual(await target.observe(repo, "W9-T1"), { state: "admitted", branches: ["run-W9-T1-17"] });
  const claimed = await target.task(repo, "W9-T1");
  assert.ok(claimed.state === "found" && claimed.task.claimed, "a held dispatch claim is read as claimed");
  override("search/issues", JSON.stringify({ total_count: 1 }));
  const merged = await target.task(repo, "W9-T1");
  assert.ok(merged.state === "found" && merged.task.merged, "merged credit is read from the trailer search");
  // Only an exact `run-<taskId>-<epochMs>` branch is a link; a claim with no object still proves only admission.
  override("matching-refs/heads/run-W9-T1-", JSON.stringify([{ ref: "refs/heads/run-W9-T1-17-retry", object: { sha: TIP } }, { ref: "refs/heads/run-W9-T1-18" }]));
  assert.deepEqual(await target.observe(repo, "W9-T1"), { state: "admitted", branches: ["run-W9-T1-18"] });
  override("matching-refs/heads/run-W9-T1-", JSON.stringify([]));
  override("matching-refs/rmd-dispatch/W9-T1", JSON.stringify([{ ref: "refs/rmd-dispatch/W9-T1" }]));
  assert.deepEqual(await target.observe(repo, "W9-T1"), { state: "admitted", branches: [] });
  // A shard that holds no such task is absent, never a guess.
  override("contents/plan/tasks.d/W9-T1-first.yaml", "- id: W9-T7\n  status: queued\n");
  assert.deepEqual(await target.task(repo, "W9-T1"), { state: "absent" });
  // No managed set path, a malformed managed set and an unreadable transport are unknown, never "free".
  assert.equal((await ghProductBuildTarget({ text: answer }).inspect(repo)).enrolled, undefined);
  writeFileSync(join(repoRoot, ".remudero", "managed-repos.json"), "{broken");
  assert.equal((await ghProductBuildTarget({ repoRoot, text: answer }).inspect(repo)).enrolled, undefined);
  const down = ghProductBuildTarget({ repoRoot, text: async () => { throw new Error("offline"); } });
  assert.deepEqual(await down.inspect(repo), { enrolled: undefined, head: undefined, readmeOnly: undefined });
  assert.deepEqual(await down.task(repo, "W9-T1"), { state: "unreadable" });
  assert.deepEqual(await down.observe(repo, "W9-T1"), { state: "unknown" });
  assert.equal(productPlanOrigin("prd_x", "p"), "product-plan#prd_x/p");
});

/** Core drives remudero. Wreckterra is enrolled below and, here, has NO live instance of its own. */
const CORE_ONLY = "instances:\n  core:\n    github_repo: craigoley/remudero\n";
const WITH_OWN = `${CORE_ONLY}  wreckterra:\n    github_repo: craigoley/wreckterra\n    mode: shadow\n`;
const nativeMarker = (root: string, repo: string, taskId: string) => join(root, "state", `KICK_REQUESTED-${repo}:${taskId}`);

/** The target repository's own plan: the product task, and an ordinary one the job must never touch. */
const nativeTargetPlan = (productId: string) => `
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
const nativeSelfPlan = `
- id: C1-T1
  title: a core task nothing here may dispatch
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

/** Real files throughout: the product store, the registry, the managed set, the kick markers, the job record and the ledger. */
function nativeFixture(t: TestContext, registry = CORE_ONLY) {
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
    async task() { return { state: "found" as const, task }; }, async observe() { return state.observation; },
    async bootstrap() { return { state: "absent" as const }; },
  };
  const provider: Pick<ProductRepositoryProvider, "read"> = {
    async read() { return { state: "found", repository: { id: ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" } }; },
  };
  const options: ProductBuildOptions = { root: core, store, target, provider, clock: fixedClock(REQUESTED_MS), instances: { registryPath, stateBase } };
  const command = () => ({ version: "product-build-v1", requestId: "build-request-0001", productId, planEvidenceId: planEvidence.id,
    taskId: "W9-T1", expectedRevision: 2, expectedObjectiveRevision: 1 });
  const planFile = join(root, "target-plan.yaml");
  writeFileSync(planFile, nativeTargetPlan(productId));
  const selfFile = join(root, "self-plan.yaml");
  writeFileSync(selfFile, nativeSelfPlan);
  const ledgerPath = join(core, "state", "ledger.ndjson");
  const lines: { step: string; extra: Record<string, unknown> }[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}) => {
    lines.push({ step, extra });
    appendLedger(ledgerPath, { run_id: "DAEMON-1", task_id: "DAEMON", step, lane: "daemon", ...extra });
  };
  const calls = { runTask: [] as string[], drains: [] as DrainOpts[], claims: [] as string[], durable: [] as string[][] };
  const state = { claimHeld: false as boolean | undefined, syncError: undefined as string | undefined, daemonDeps: {} as Partial<DaemonDeps>, daemonOpts: {} as DaemonOpts,
    drainThrows: undefined as "before" | "after" | "during" | undefined, silentRun: false, elapsedMs: 0,
    observation: { state: "none", branches: [] } as BuildObservation };
  const makeRunner = () => createNativeTargetJobRunner({
    root: core, repoRoot: checkout, log, nowMs: () => Date.now() + state.elapsedMs, instances: { registryPath },
    planPathFor: (_owner, repo) => (repo === "wreckterra" ? planFile : undefined),
    syncPlan: async (path) => (state.syncError === undefined ? { plan: loadPlan(path) } : { error: state.syncError }),
    project: () => new Map(),
    runTask: async (taskId, target) => {
      assert.equal(target.owner, "craigoley");
      assert.equal(target.repo, "wreckterra");
      assert.equal(target.plan.tasks.find((task) => task.id === taskId)?.repo, "wreckterra");
      calls.runTask.push(taskId);
      if (state.drainThrows === "during") throw new Error("native response lost");
      const jobs = join(core, "state", "target-jobs");
      calls.durable.push(existsSync(jobs) ? readdirSync(jobs).map((name) => String((JSON.parse(readFileSync(join(jobs, name), "utf8")) as TargetJobRecord).status)) : []);
      const runId = `${taskId}-${Date.now()}`;
      appendLedger(ledgerPath, { run_id: runId, task_id: taskId, step: "run.start", lane: "run-task", repo: "wreckterra" });
      if (!state.silentRun) appendLedger(ledgerPath, { run_id: runId, task_id: taskId, step: "verdict", lane: "run-task", verdict: "merged" });
      return { taskId, runId, merged: true, costUsd: 5, verdict: "merged" };
    },
    claimHeld: async (taskId) => { calls.claims.push(taskId); return state.claimHeld; },
    runDrain: async (plan, deps, opts) => {
      calls.drains.push(opts ?? {});
      if (state.drainThrows === "before") throw new Error("drain unavailable");
      if (state.drainThrows === "after") { await deps.runOne("W9-T1"); throw new Error("drain crashed"); }
      return runDrain(plan, deps, opts);
    },
  });
  let runner = makeRunner();
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
      ...state.daemonDeps,
    }, { headroomEnabled: false, max: 5, ...state.daemonOpts });
    return { lines: lines.slice(from), spawned };
  };
  const record = (origin: string) => fileTargetJobStore(core).read(origin);
  return { root, core, checkout, registryPath, stateBase, store, productId, inspection, options, service, command, ledgerPath, calls, state, drive, record, log, targetPlanFile: planFile,
    restart: () => { runner = makeRunner(); } };
}
const nativeStarted = async (f: ReturnType<typeof nativeFixture>) => {
  const result = await f.service.execute(actor, f.command());
  assert.ok(result.ok, "the build request is accepted");
  return { ...result.value, origin: productBuildKickOrigin(f.productId, result.value.receipt.operationId) };
};

test("W1-T10799: one managed target without a daemon reaches one bounded native job", async (t) => {
  const f = nativeFixture(t);
  const request = await nativeStarted(f);
  assert.equal(request.receipt.outcome, "queued", "the request's own act records queued, never more");
  assert.ok(existsSync(nativeMarker(f.core, "wreckterra", "W9-T1")), "the marker sits under the CORE daemon's root, where no target daemon exists");
  assert.deepEqual(daemonKickPort(f.core, { repo: "remudero", isSelf: true }).pendingKicks(), [], "the core daemon's own kick port never offers a foreign repository's marker");
  assert.deepEqual(daemonTargetJobPort(f.core, { repo: "remudero" }).pendingTargetJobs().map((job) => [job.taskId, job.repo, job.origin]), [["W9-T1", "wreckterra", request.origin]]);

  const run = await f.drive();
  assert.deepEqual(f.calls.runTask, ["W9-T1"], "exactly the one kicked task ran, and not the ordinary W9-T3 beside it");
  assert.deepEqual(run.spawned, [], "the core plan's own task never dispatched");
  assert.deepEqual(f.calls.durable, [["admitted"]], "the durable record was written before the spend, not after it");
  assert.equal(f.calls.drains.length, 1, "one maintained drain");
  assert.deepEqual([f.calls.drains[0]!.curated, f.calls.drains[0]!.max, f.calls.drains[0]!.laneCount], [["W9-T1"], 1, 1], "one task, depth one, one lane");
  assert.ok(!existsSync(nativeMarker(f.core, "wreckterra", "W9-T1")), "the marker was cleared at the terminal verdict");
  const job = f.record(request.origin);
  assert.ok(job.state === "found" && job.record.status === "ended" && job.record.attempts === 1);
  assert.equal(job.record.owner, "craigoley");
  assert.match(job.record.planRevision ?? "", /^[a-f0-9]{64}$/, "the durable dispatch retains the selected target plan revision");
  assert.deepEqual(run.lines.filter((line) => line.step === "console.kick_dispatched").map((line) => [line.extra.task, line.extra.origin, line.extra.repo]),
    [["W9-T1", request.origin, "wreckterra"]], "the dispatch receipt names this request's origin, task and repository");
  assert.ok(!run.lines.some((line) => line.step === "dispatch.pick_scored" && line.extra.task === "W9-T3"));
  const again = await f.drive();
  assert.deepEqual(f.calls.runTask, ["W9-T1"], "a further pass finds nothing left to run");
  assert.deepEqual(again.lines.filter((line) => line.step.startsWith("target_job.")), []);

  const foreign = nativeFixture(t);
  await nativeStarted(foreign);
  writeFileSync(foreign.targetPlanFile, nativeTargetPlan(foreign.productId).replaceAll("repo: wreckterra", "repo: gammaterra"));
  const refused = await foreign.drive();
  assert.deepEqual(foreign.calls.runTask, [], "a known id naming another repository cannot enter the target drain");
  assert.equal(foreign.calls.drains.length, 0);
  assert.ok(refused.lines.some((line) => line.step === "console.kick_refused" && String(line.extra.reason).includes("repository")));
});

test("W1-T10799: bounded target jobs share the core WIP budget and reserve its last slot", async (t) => {
  const f = nativeFixture(t);
  const request = await nativeStarted(f);
  const otherOrigin = "product:prd_other/op_2";
  requestKick(f.core, "W9-T3", otherOrigin, "wreckterra");
  f.state.daemonOpts = { laneCount: 3, wipLimit: 2 };
  f.state.daemonDeps.openPrCount = () => 2;
  const full = await f.drive();
  assert.deepEqual(f.calls.runTask, [], "a free local lane cannot bypass full shared WIP");
  assert.ok(full.lines.some((line) => line.step === "target_job.capacity_deferred" && line.extra.origin === request.origin));
  assert.equal(f.record(request.origin).state, "absent");

  // An adaptive admission is authoritative even if the static pair reports spare WIP.
  f.state.daemonDeps.openPrCount = () => 0;
  f.state.daemonDeps.readQueueAdmission = () => ({ wipLimit: 2, observedOpenCount: 2 });
  await f.drive();
  assert.deepEqual(f.calls.runTask, [], "the shared admission reading bounds the target job too");

  f.state.daemonDeps.readQueueAdmission = () => ({ wipLimit: 2, observedOpenCount: 1 + f.calls.runTask.length });
  const oneSlot = await f.drive();
  assert.deepEqual(f.calls.runTask, ["W9-T1"], "only one of the simultaneous requests occupies the last slot");
  assert.ok(oneSlot.lines.some((line) => line.step === "target_job.capacity_deferred" && line.extra.origin === otherOrigin));
  assert.ok(existsSync(nativeMarker(f.core, "wreckterra", "W9-T3")), "the waiting request keeps its marker");
  assert.equal(f.record(otherOrigin).state, "absent", "a waiting request never receives an admission record");
});

test("W1-T10799: unknown native receipts and an absent claim never respend an admitted job", async (t) => {
  const f = nativeFixture(t);
  const request = await nativeStarted(f);
  const landed: TargetJobRecord = { origin: request.origin, taskId: "W9-T1", repo: "wreckterra", status: "admitted", attempts: 1, updatedAt: new Date().toISOString() };
  fileTargetJobStore(f.core).write(landed);
  f.state.claimHeld = false;
  const archive = join(f.core, "state", `ledger.${new Date().toISOString().replaceAll(":", "-")}.ndjson.gz`);
  writeFileSync(archive, "unreadable gzip receipt corpus");
  const unknown = await f.drive();
  assert.deepEqual(f.calls.runTask, [], "an absent claim cannot turn unknown receipts into permission to spend again");
  assert.ok(unknown.lines.some((line) => line.step === "target_job.unknown"));
  assert.deepEqual(f.record(request.origin), { state: "found", record: landed });
  assert.ok(existsSync(nativeMarker(f.core, "wreckterra", "W9-T1")));

  rmSync(archive);
  await f.drive();
  assert.deepEqual(f.calls.runTask, [], "a free claim with no receipts cannot disprove an earlier spend");
  assert.deepEqual(f.record(request.origin), { state: "found", record: landed });
});

test("W1-T10799: a foreign repository's native run cannot satisfy this origin's receipt", async (t) => {
  const f = nativeFixture(t);
  const request = await nativeStarted(f);
  f.log("console.kick_dispatched", { task: "W9-T1", origin: request.origin, repo: "wreckterra" });
  const read = () => readTargetExecution(join(f.core, "state"), { taskId: "W9-T1", origin: request.origin, repo: "wreckterra", requestedAt: request.receipt.queuedAt, nowMs: Date.now() });
  const foreignRun = `W9-T1-${Date.now()}`;
  appendLedger(f.ledgerPath, { run_id: foreignRun, task_id: "W9-T1", step: "run.start", repo: "gammaterra" });
  assert.deepEqual(read(), { state: "dispatched" }, "the same task id in another repository is not this run");
  appendLedger(f.ledgerPath, { run_id: foreignRun, task_id: "W9-T1", step: "verdict", verdict: "merged" });
  assert.deepEqual(read(), { state: "dispatched" }, "the other repository's verdict cannot end this job");
  appendLedger(f.ledgerPath, { run_id: "W9-T1-unscoped", task_id: "W9-T1", step: "run.start" });
  assert.deepEqual(read(), { state: "dispatched" }, "a start without repository identity is insufficient");
  const ownRun = `W9-T1-${Date.now() + 1}`;
  appendLedger(f.ledgerPath, { run_id: ownRun, task_id: "W9-T1", step: "run.start", repo: "Wreckterra" });
  assert.deepEqual(read(), { state: "running", runId: ownRun });
  appendLedger(f.ledgerPath, { run_id: ownRun, task_id: "W9-T1", step: "verdict", verdict: "merged" });
  assert.deepEqual(read(), { state: "ended", runId: ownRun });
});

test("W1-T10799: replay after restart or lost response resumes the same native job", async (t) => {
  const f = nativeFixture(t);
  const request = await nativeStarted(f);
  // A lost response: the same request again is the same operation, and writes no second marker.
  const lost = await f.service.execute(actor, f.command());
  assert.ok(lost.ok && lost.value.replayed && lost.value.receipt.operationId === request.receipt.operationId);
  assert.equal(nativeKickMarkers(f.core).length, 1, "one marker for one request");

  // A restart after the dispatch landed: the durable record and the held claim resume it. No second dispatch.
  const store = fileTargetJobStore(f.core);
  const landed: TargetJobRecord = { origin: request.origin, taskId: "W9-T1", repo: "wreckterra", status: "admitted", attempts: 1, updatedAt: new Date().toISOString() };
  store.write(landed);
  f.state.claimHeld = true;
  const resumed = await f.drive();
  assert.deepEqual(f.calls.runTask, [], "a landed dispatch is never dispatched twice");
  assert.ok(resumed.lines.some((line) => line.step === "target_job.resumed"));
  assert.ok(existsSync(nativeMarker(f.core, "wreckterra", "W9-T1")), "the job is not closed, so its marker stays");
  const marked = f.record(request.origin);
  assert.ok(marked.state === "found" && marked.record.reason === "resumed" && marked.record.updatedAt === landed.updatedAt, "the dispatch time that correlates the receipts is kept");
  await f.drive();
  assert.equal(resumed.lines.filter((line) => line.step === "target_job.resumed").length, 1, "resumption is reported once");

  // An unknown claim (an unreadable remote) is never read as free either.
  f.state.claimHeld = undefined;
  await f.drive();
  assert.deepEqual(f.calls.runTask, []);

  // A free claim cannot disprove a spend: keep the original job unresolved.
  f.state.claimHeld = false;
  await f.drive();
  assert.deepEqual(f.calls.runTask, []);

  // Drive an actual charged run, lose its response, then restart after its native start goes silent.
  const spent = nativeFixture(t);
  const started = await nativeStarted(spent);
  spent.state.silentRun = true;
  spent.state.drainThrows = "after";
  await spent.drive();
  assert.deepEqual(spent.calls.runTask, ["W9-T1"], "the positive control really spent once");
  const admitted = spent.record(started.origin);
  assert.ok(admitted.state === "found" && admitted.record.status === "admitted" && admitted.record.attempts === 1);
  spent.restart();
  rmSync(nativeMarker(spent.core, "wreckterra", "W9-T1"));
  assert.equal(daemonTargetJobPort(spent.core, { repo: "remudero" }).pendingTargetJobs().length, 1, "durable recovery does not depend on a marker");
  spent.state.elapsedMs = DEFAULT_LIVENESS_BOUND_MS + 60_000;
  spent.state.drainThrows = undefined;
  await spent.drive();
  assert.deepEqual(spent.calls.runTask, ["W9-T1"], "a silent spent run with a free claim never spends twice");
  assert.deepEqual(spent.record(started.origin), admitted, "unresolved recovery preserves attempts and revision");

  // The original native terminal receipt resolves the synthetic recovery fixture without redispatch.
  f.log("console.kick_dispatched", { task: "W9-T1", repo: "wreckterra", origin: request.origin });
  const runId = `W9-T1-${Date.now()}`;
  appendLedger(f.ledgerPath, { run_id: runId, task_id: "W9-T1", repo: "wreckterra", step: "run.start" });
  appendLedger(f.ledgerPath, { run_id: runId, task_id: "W9-T1", step: "verdict", verdict: "merged" });
  await f.drive();
  const done = f.record(request.origin);
  assert.ok(done.state === "found" && done.record.status === "ended" && done.record.attempts === 1);

  // The same origin delivered again after the job closed reports it and never spends twice.
  const redelivered = await f.service.execute(actor, f.command());
  assert.ok(redelivered.ok && redelivered.value.replayed);
  writeFileSync(nativeMarker(f.core, "wreckterra", "W9-T1"), JSON.stringify({ taskId: "W9-T1", origin: request.origin, repo: "wreckterra", requestedAt: new Date().toISOString() }));
  const closed = await f.drive();
  assert.deepEqual(f.calls.runTask, [], "a closed job's origin never dispatches again");
  assert.ok(closed.lines.some((line) => line.step === "target_job.replayed"));
  assert.ok(!existsSync(nativeMarker(f.core, "wreckterra", "W9-T1")));

  // A record this process cannot read is held, never read as "no job": that would respend.
  const other = nativeFixture(t);
  const second = await nativeStarted(other);
  const recordFile = join(other.core, "state", "target-jobs");
  mkdirSync(recordFile, { recursive: true });
  fileTargetJobStore(other.core).write({ origin: second.origin, taskId: "W9-T1", repo: "wreckterra", status: "queued", attempts: 0, updatedAt: new Date().toISOString() });
  for (const name of readdirSync(recordFile)) writeFileSync(join(recordFile, name), "{torn");
  assert.equal(other.record(second.origin).state, "unreadable");
  const torn = await other.drive();
  assert.deepEqual(other.calls.runTask, []);
  assert.ok(torn.lines.some((line) => line.step === "target_job.unknown"));
  assert.ok(existsSync(nativeMarker(other.core, "wreckterra", "W9-T1")));
});

test("W1-T10799: native receipts distinguish queued admitted running and refused jobs", async (t) => {
  const f = nativeFixture(t);
  const request = await nativeStarted(f);
  const stateDir = join(f.core, "state");
  const read = (at = REQUESTED_MS) => readTargetExecution(stateDir, { taskId: "W9-T1", origin: request.origin, repo: "wreckterra", requestedAt: request.receipt.queuedAt, nowMs: at });
  const outcome = async () => { const result = await f.service.execute(actor, f.command()); assert.ok(result.ok); return result.value.receipt.outcome; };
  // The marker, a managed profile and free capacity are not receipts.
  f.state.observation = { state: "admitted", branches: [`run-${RUN_ID}`] };
  assert.deepEqual(read(), { state: "unknown" }, "no ledger at all is a daemon this process cannot see, never 'nothing ran'");
  assert.equal(await outcome(), "queued");
  // A governor that holds the drain is an explicit deferral: no dispatch row, no job record, the marker stays.
  const held = await f.drive({ checkQuietHours: () => ({ deferred: true, detail: "QUIET_HOURS file present" }) });
  assert.deepEqual(f.calls.runTask, []);
  assert.ok(held.lines.some((line) => line.step === "target_job.capacity_deferred" && String(line.extra.reason).includes("quiet_hours_deferred")));
  assert.equal(f.record(request.origin).state, "absent");
  assert.ok(existsSync(nativeMarker(f.core, "wreckterra", "W9-T1")));
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
  appendLedger(join(stateDir, "ledger.ndjson"), { run_id: runId, task_id: "W9-T1", step: "run.start", lane: "run-task", repo: "wreckterra" });
  assert.deepEqual(read(Date.now()), { state: "running", runId });
  assert.equal(await outcome(), "running");

  // A different origin's dispatch row is not this request's, and a refusal row outranks a held claim.
  const refusedF = nativeFixture(t);
  const second = await nativeStarted(refusedF);
  refusedF.state.observation = { state: "admitted", branches: [`run-${RUN_ID}`] };
  refusedF.log("console.kick_dispatched", { task: "W9-T1", origin: "product:other/op", repo: "wreckterra" });
  assert.equal(await nativeOutcome(refusedF), "queued", "another origin's receipt is never this request's");
  refusedF.log("console.kick_refused", { task: "W9-T1", origin: second.origin, repo: "wreckterra", reason: "unknown task id" });
  assert.deepEqual(readTargetExecution(join(refusedF.core, "state"), { taskId: "W9-T1", origin: second.origin, repo: "wreckterra", requestedAt: second.receipt.queuedAt, nowMs: Date.now() }), { state: "refused" });
  assert.equal(await nativeOutcome(refusedF), "queued");

  // The job's own refusal: an unknown task id is refused, recorded, ledgered and its marker cleared.
  const unknown = nativeFixture(t);
  const third = await nativeStarted(unknown);
  writeFileSync(unknown.targetPlanFile, nativeTargetPlan(unknown.productId).replace("W9-T1", "W9-T9"));
  const refusal = await unknown.drive();
  assert.deepEqual(unknown.calls.runTask, []);
  assert.deepEqual(refusal.lines.filter((line) => line.step === "console.kick_refused").map((line) => [line.extra.origin, line.extra.reason]), [[third.origin, "unknown task id"]]);
  const refusedJob = unknown.record(third.origin);
  assert.ok(refusedJob.state === "found" && refusedJob.record.status === "refused");
  assert.ok(!existsSync(nativeMarker(unknown.core, "wreckterra", "W9-T1")));
});

test("W1-T10799: a drain that throws holds the job open and keeps its marker", async (t) => {
  const before = nativeFixture(t);
  const request = await nativeStarted(before);
  before.state.drainThrows = "before";
  const failed = await before.drive();
  const errored = failed.lines.find((line) => line.step === "target_job.error");
  assert.equal(errored?.extra.reason, "drain failed: drain unavailable", "a drain that never started names its own failure");
  assert.deepEqual(before.calls.runTask, [], "nothing was dispatched");
  assert.equal(before.record(request.origin).state, "absent", "no dispatch, so no durable job record: the job is still only queued");
  assert.ok(existsSync(nativeMarker(before.core, "wreckterra", "W9-T1")), "a failed read of the world is never a terminal verdict");
  assert.equal(await nativeOutcome(before), "queued");

  const after = nativeFixture(t);
  const started = await nativeStarted(after);
  after.state.drainThrows = "after";
  const crashed = await after.drive();
  assert.equal(crashed.lines.find((line) => line.step === "target_job.error")?.extra.reason, "drain failed after dispatch: drain crashed",
    "a drain that threw after the dispatch landed says so");
  const landed = after.record(started.origin);
  assert.ok(landed.state === "found" && landed.record.status !== "refused" && landed.record.attempts >= 1, "the dispatch that did land is on the durable record");
  assert.ok(after.calls.runTask.length >= 1, "the one kicked task did dispatch before the drain threw");

  const during = nativeFixture(t);
  const interrupted = await nativeStarted(during);
  during.state.drainThrows = "during";
  const unresolved = await during.drive();
  assert.deepEqual(during.calls.runTask, ["W9-T1"], "a run error returned by the maintained drain never redispatches");
  const record = during.record(interrupted.origin);
  assert.ok(record.state === "found" && record.record.status === "admitted" && record.record.attempts === 1);
  assert.ok(unresolved.lines.some((line) => line.step === "target_job.unknown"));
  assert.ok(!unresolved.lines.some((line) => line.step === "target_job.ended"), "an unresolved response is not a terminal native receipt");
});

// The core daemon's own composition root (daemonCommand) is driven by the W1-T10799 wiring proof in
// the-daemon-owns-the-worker-git-credential-socket.test.ts, a suite that already drives daemonCommand.
const nativeOutcome = async (f: ReturnType<typeof nativeFixture>) => { const result = await f.service.execute(actor, f.command()); assert.ok(result.ok); return result.value.receipt.outcome; };
const nativeKickMarkers = (core: string) => readdirSync(join(core, "state")).filter((name) => name.startsWith("KICK_REQUESTED-"));

// The request side of routing: where a product build request's kick marker goes, and what it refuses. Every file here is
// real: the product store, the registry, the managed set, the kick markers and the halt flags.
test("W1-T10799: unreadable or halted routing refuses and live instances retain their own path", async (t) => {
  // An unreadable registry is unknown, never "no daemon".
  const broken = nativeFixture(t, "instances:\n  core:\n  wreckterra:\n");
  assert.equal(await refused(broken.service.execute(actor, broken.command())), "target_unreadable");
  assert.deepEqual(nativeKickMarkers(broken.core), [], "no marker anywhere");
  assert.deepEqual(readdirSync(join(broken.stateBase, "wreckterra", "state")), [], "none under the target's root either");
  // A halted core root refuses before any marker, whether paused or stopped.
  for (const flag of ["PAUSE", "STOP"]) {
    const halted = nativeFixture(t);
    writeFileSync(join(halted.core, "state", flag), "{}");
    assert.equal(await refused(halted.service.execute(actor, halted.command())), "fleet_halted", flag);
    assert.deepEqual(nativeKickMarkers(halted.core), [], flag);
  }
  // A core root whose state directory this process cannot reach is unreadable.
  const noState = nativeFixture(t);
  const bare = join(noState.root, "bare-core");
  mkdirSync(bare);
  assert.equal(await refused(new ProductBuildService({ ...noState.options, root: bare }).execute(actor, noState.command())), "target_unreadable",
    "a core root with no state directory is unreadable");
  // An unenrolled target is refused by the request itself: no marker, and no job is born.
  const unenrolled = nativeFixture(t);
  unenrolled.inspection.enrolled = false;
  assert.equal(await refused(unenrolled.service.execute(actor, unenrolled.command())), "target_not_enrolled");
  assert.deepEqual(nativeKickMarkers(unenrolled.core), []);
  // A target whose enrollment this process cannot read is unknown, never enrolled.
  const unknownEnrollment = nativeFixture(t);
  unknownEnrollment.inspection.enrolled = undefined;
  assert.equal(await refused(unknownEnrollment.service.execute(actor, unknownEnrollment.command())), "target_unreadable");
  assert.deepEqual(nativeKickMarkers(unknownEnrollment.core), []);

  // With no live instance of its own, the marker goes to the CORE root, once, and the same request replays without a second one.
  const native = nativeFixture(t);
  const first = await native.service.execute(actor, native.command());
  assert.ok(first.ok, "an enrolled target with no live instance is accepted, not refused as having no daemon");
  assert.ok(existsSync(nativeMarker(native.core, "wreckterra", "W9-T1")), "the marker sits under the core daemon's root");
  const replay = await native.service.execute(actor, native.command());
  assert.ok(replay.ok && replay.value.replayed && replay.value.receipt.operationId === first.value.receipt.operationId);
  assert.equal(nativeKickMarkers(native.core).length, 1, "one marker for one request");

  // A live instance keeps its own kick path: the marker goes to ITS root and none to the core root.
  const own = nativeFixture(t, WITH_OWN);
  const started = await own.service.execute(actor, own.command());
  assert.ok(started.ok);
  const ownMarker = nativeMarker(join(own.stateBase, "wreckterra"), "wreckterra", "W9-T1");
  assert.ok(existsSync(ownMarker), "the marker sits under the instance's own root");
  assert.deepEqual(nativeKickMarkers(own.core), [], "none under the core root");
  const carried = JSON.parse(readFileSync(ownMarker, "utf8")) as { origin?: string };
  assert.equal(carried.origin, productBuildKickOrigin(own.productId, started.value.receipt.operationId), "the marker carries the origin this request minted");
});

// The daemon side: what the core daemon does with a marker it is offered.
test("W1-T10799: the core daemon refuses a stray marker and holds one it cannot read", async (t) => {
  // An unenrolled target is refused by the daemon when a marker arrives anyway.
  const stray = nativeFixture(t);
  writeFileSync(join(stray.checkout, ".remudero", "managed-repos.json"), JSON.stringify({ repos: ["craigoley/something-else"] }));
  const strayKick = { taskId: "W9-T1", origin: "product:p/op", repo: "wreckterra", requestedAt: new Date().toISOString() };
  writeFileSync(nativeMarker(stray.core, "wreckterra", "W9-T1"), JSON.stringify(strayKick));
  const strayRun = await stray.drive();
  assert.deepEqual(stray.calls.runTask, []);
  assert.deepEqual(strayRun.lines.filter((line) => line.step === "console.kick_refused").map((line) => line.extra.reason), ["target is not an enrolled managed repository"]);
  assert.ok(!existsSync(nativeMarker(stray.core, "wreckterra", "W9-T1")));
  // A malformed managed set or registry at the daemon is held, never refused and never dispatched.
  const unreadable = nativeFixture(t);
  writeFileSync(nativeMarker(unreadable.core, "wreckterra", "W9-T1"), JSON.stringify(strayKick));
  writeFileSync(join(unreadable.checkout, ".remudero", "managed-repos.json"), "{not json");
  const heldRun = await unreadable.drive();
  assert.deepEqual(unreadable.calls.runTask, []);
  assert.ok(heldRun.lines.some((line) => line.step === "target_job.unknown"));
  assert.ok(existsSync(nativeMarker(unreadable.core, "wreckterra", "W9-T1")), "an unreadable source leaves the marker for a later tick");

  // A live instance keeps its own kick path: the marker goes to ITS root, and the core daemon refuses a stray one.
  const own = nativeFixture(t, WITH_OWN);
  const request = await nativeStarted(own);
  assert.ok(existsSync(nativeMarker(join(own.stateBase, "wreckterra"), "wreckterra", "W9-T1")), "the marker sits under the instance's own root");
  assert.deepEqual(nativeKickMarkers(own.core), [], "none under the core root");
  assert.deepEqual(daemonKickPort(join(own.stateBase, "wreckterra"), { repo: "wreckterra", isSelf: false }).pendingKicks().map((kick) => kick.origin), [request.origin]);
  writeFileSync(nativeMarker(own.core, "wreckterra", "W9-T1"), JSON.stringify({ ...strayKick, origin: request.origin }));
  const refusedStray = await own.drive();
  assert.deepEqual(own.calls.runTask, [], "the core daemon never runs a target another instance drives");
  assert.match(String(refusedStray.lines.find((line) => line.step === "console.kick_refused")?.extra.reason), /wreckterra drives this repository/);
  assert.ok(existsSync(nativeMarker(join(own.stateBase, "wreckterra"), "wreckterra", "W9-T1")), "the instance's own marker is untouched");
});
