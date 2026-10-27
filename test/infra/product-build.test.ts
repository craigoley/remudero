import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  BOOTSTRAP_CHECKS, bootstrapConfirmed, bootstrapEvidenceId, ghProductBuildTarget, productBuildKickOrigin, productPlanOrigin, ProductBuildService,
  readTargetExecution, registryDaemonRoot, starterEvidenceId,
  type BootstrapRead, type BuildObservation, type BuildTask, type ExecutionQuery, type ProductBuildOptions, type ProductBuildTarget, type TargetInspection, type TaskRead,
} from "#src/lib/product-build.js";
import { daemonKickPort } from "#src/cli/commands/daemon.js";
import { clockFromMillisFn, fixedClock } from "#src/lib/clock.js";
import { runDaemon } from "#src/lib/daemon.js";
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
    run: (atMs: number, runId: string, step: string, extra: Record<string, unknown> = {}) => append(atMs, { run_id: runId, task_id: "W9-T1", step, lane: "run-task", ...extra }),
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
  writeFileSync(f.registryPath, "instances:\n  core:\n    github_repo: craigoley/remudero\n  old:\n    github_repo: craigoley/wreckterra\n    retired: true\n");
  assert.equal(await refused(f.service.execute(actor, f.command())), "target_daemon_missing", "a retired instance drives nothing");
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
    { ts: "2026-10-26T01:00:02.000Z", run_id: RUN_ID, task_id: "W9-T1", step: "run.start" },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  mkdirSync(join(blind.f.daemonRoot, "state", "ledger.ndjson"));
  assert.equal(await blind.observe(REQUESTED_MS + 3_000), "queued", "an unreadable live file is never a complete corpus");

  // A daemon whose state this process cannot reach answers unknown, never running; reachable again, its run reads.
  const remote = await observedBuild(t);
  remote.ledger.daemon(REQUESTED_MS + 1_000, "console.kick_dispatched", { task: "W9-T1", origin: remote.origin, repo: "wreckterra" });
  remote.ledger.run(REQUESTED_MS + 2_000, RUN_ID, "run.start", { type: "implement" });
  writeFileSync(remote.f.registryPath, "instances:\n  core:\n    github_repo: craigoley/remudero\n  wreckterra:\n    github_repo: craigoley/wreckterra\n    retired: true\n");
  assert.equal(await remote.observe(REQUESTED_MS + 3_000), "admitted", "an unreachable target daemon is not evidence");
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
