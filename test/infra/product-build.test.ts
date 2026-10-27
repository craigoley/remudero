import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  BOOTSTRAP_CHECKS, bootstrapConfirmed, bootstrapEvidenceId, ghProductBuildTarget, productPlanOrigin, ProductBuildService, registryDaemonRoot,
  type BuildObservation, type BuildTask, type ProductBuildOptions, type ProductBuildTarget, type TargetInspection, type TaskRead,
} from "#src/lib/product-build.js";
import { daemonKickPort } from "#src/cli/commands/daemon.js";
import { fixedClock } from "#src/lib/clock.js";
import { runDaemon } from "#src/lib/daemon.js";
import { CLAIM_SILENCE_FLOOR_MS } from "#src/lib/dispatch-claim.js";
import { requestKick } from "#src/lib/fleet-control.js";
import { loadPlan } from "#src/lib/plan.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import type { ProductRepositoryProvider, ProviderRead } from "#src/lib/product-repository.js";
import { ghShim } from "#test/helpers/gh-shim.js";
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
  observation: BuildObservation = { state: "none" };
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
  const options: ProductBuildOptions = { root, store, target, provider, clock: fixedClock(Date.parse("2026-10-26T01:00:00.000Z")),
    instances: { registryPath, stateBase },
    kick: (kickRoot, taskId, origin, repo) => { kicks.push([taskId, origin, repo]); assert.equal(kickRoot, daemonRoot, "the marker goes to the target's own daemon root"); } };
  const service = new ProductBuildService(options);
  const command = (extra: Record<string, unknown> = {}) => ({ version: "product-build-v1", requestId: "build-request-0001", productId,
    planEvidenceId: planEvidence.id, taskId: "W9-T1", expectedRevision: 2, expectedObjectiveRevision: 1, ...extra });
  return { root, daemonRoot, registryPath, stateBase, store, productId, target, provider, kicks, service, command, options };
}
const refused = async (promise: ReturnType<ProductBuildService["execute"]>) => { const result = await promise; assert.equal(result.ok, false); return result.code; };

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
  assert.deepEqual(f.kicks, [["W9-T1", `product:${f.productId}`, "wreckterra"]], "exactly one repo-scoped kick through the injected guarded seam");
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
  f.target.observation = { state: "admitted" };
  const admitted = await f.service.execute(actor, f.command());
  assert.ok(admitted.ok);
  assert.equal(admitted.value.receipt.outcome, "admitted");
  f.target.observation = { state: "running", url: "https://github.com/craigoley/wreckterra/tree/run-W9-T1-1" };
  const running = await f.service.execute(actor, f.command());
  assert.ok(running.ok);
  assert.equal(running.value.receipt.outcome, "running");
  assert.deepEqual(running.value.receipt.evidence.map((item) => item.outcome), ["queued", "admitted", "running"]);
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
  assert.ok((await service.execute(actor, f.command())).ok);
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
  assert.deepEqual(own.pendingKicks().map((kick) => [kick.taskId, kick.repo, kick.origin]), [["W9-T1", "wreckterra", `product:${f.productId}`]]);
  const dispatched = await drive(own);
  assert.deepEqual(dispatched.spawned, ["W9-T1"], "the kicked task ran ahead of the plan's natural pick, W9-T0");
  assert.deepEqual(dispatched.kicks, [{ step: "console.kick_dispatched", extra: { task: "W9-T1", origin: `product:${f.productId}`, repo: "wreckterra" } }]);
  assert.ok(!existsSync(marker), "the exact marker was consumed");
  assert.deepEqual((await drive(own)).kicks, [], "consumed once: the next pass finds no kick");
  // A refused kick clears exactly its own marker; the unscoped and another repository's marker for the same id remain.
  assert.ok((await service.execute(actor, f.command({ requestId: "build-request-0002", taskId: "W9-T2", expectedRevision: 3 }))).ok);
  requestKick(f.daemonRoot, "W9-T2", "console-run");
  requestKick(f.daemonRoot, "W9-T2", "escalation-triage", "remudero-site");
  const refusal = await drive(own);
  assert.deepEqual(refusal.kicks.map((line) => [line.step, line.extra.task, line.extra.repo]), [["console.kick_refused", "W9-T2", "wreckterra"]]);
  assert.match(String(refusal.kicks[0]!.extra.reason), /verify:human/, "the daemon's own admission named the refusal");
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
  assert.equal((registryDaemonRoot(f.root, { registryPath: f.registryPath })(repo) as { root: string }).root, "/home/node/rmd-instances/wreckterra",
    "the default state base is the instance gateway's own");
  // With only a checkout, the registry is the repo-tracked one under it.
  const checkout = ownedFixtureDir(t, "product-build-registry").dir;
  mkdirSync(join(checkout, ".remudero"), { recursive: true });
  writeFileSync(join(checkout, ".remudero", "daemon-instances.yaml"), REGISTRY);
  assert.deepEqual(registryDaemonRoot(f.root, { repoRoot: checkout, stateBase: f.stateBase })(repo), { state: "found", root: f.daemonRoot, instance: "wreckterra" });
});

test("W1-T10615: queued and refused product work never reads as running", async (t) => {
  const f = fixture(t);
  // `running` without a real link is recorded no further than admitted; running needs evidence.
  f.target.observation = { state: "running" };
  const unlinked = await f.service.execute(actor, f.command());
  assert.ok(unlinked.ok);
  assert.equal(unlinked.value.receipt.outcome, "admitted", "running without real evidence is never reported as running");
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
  // Receipts for an OLDER head never satisfy the current head; three of four never suffice.
  const record = (head: string, checks: readonly (typeof BOOTSTRAP_CHECKS)[number][], revision: number, requestId: string) => {
    const saved = f.store.transition(actor, { version: "product-intent-v1", requestId, id: f.productId, expectedRevision: revision, expectedObjectiveRevision: 1,
      stageEvidence: checks.map((check) => ({ id: bootstrapEvidenceId(head, check), stage: "repository" as const, outcome: "succeeded" as const,
        objectiveRevision: 1, observedAt: "2026-10-26T00:30:00.000Z", references: [{ label: "starter PR", url: "https://github.com/craigoley/wreckterra/pull/1" }] })) });
    assert.ok(saved.ok);
  };
  record("b".repeat(40), BOOTSTRAP_CHECKS, 2, "bootstrap-stale-0001");
  assert.equal(await refused(f.service.execute(actor, f.command({ expectedRevision: 3 }))), "bootstrap_unverified");
  record(HEAD, ["test", "typecheck", "build"], 3, "bootstrap-partial-001");
  assert.equal(await refused(f.service.execute(actor, f.command({ expectedRevision: 4 }))), "bootstrap_unverified");
  record(HEAD, ["security"], 4, "bootstrap-security-01");
  const started = await f.service.execute(actor, f.command({ expectedRevision: 5 }));
  assert.ok(started.ok);
  assert.equal(started.value.receipt.outcome, "queued");
  assert.equal(f.kicks.length, 1);
});

test("W1-T10615: the default target reads the real managed set, runner registry and gh transport", async (t) => {
  const repoRoot = ownedFixtureDir(t, "product-build-managed").dir;
  mkdirSync(join(repoRoot, ".remudero"), { recursive: true });
  writeFileSync(join(repoRoot, ".remudero", "managed-repos.json"), JSON.stringify({ repos: ["craigoley/wreckterra"] }));
  const repo = { id: ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main" };
  const shard = "- id: W9-T1\n  origin: product-plan#prd_x/plan-approved-1\n  status: queued\n  budget_usd: 10\n";
  const NOW = Date.parse("2026-10-26T12:00:00.000Z");
  const ANCHOR = "1".repeat(40);
  const TIP = "2".repeat(40);
  const iso = (ms: number) => new Date(ms).toISOString();
  const anchorAt = (mintedMs: number, renewedMs?: number) =>
    `rmd-dispatch claim 4242@fleet-host ${iso(mintedMs)}${renewedMs === undefined ? "" : `\nrenewed 4242@fleet-host ${iso(renewedMs)}`}`;
  const commit = (message: string, dateMs: number) => JSON.stringify({ sha: "c".repeat(40), message, committer: { date: iso(dateMs) } });
  const claimRef = JSON.stringify([{ ref: "refs/rmd-dispatch/W9-T1", object: { sha: ANCHOR } }]);
  const routes: { when: string; stdout: string }[] = [
    { when: `git/commits/${ANCHOR}`, stdout: commit(anchorAt(NOW - 60_000), NOW - 60_000) },
    { when: `git/commits/${TIP}`, stdout: commit("wip", NOW - 30_000) },
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
  const target = ghProductBuildTarget({ repoRoot, text: answer, clock: fixedClock(NOW) });
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
  assert.deepEqual(await target.observe(repo, "W9-T1"), { state: "none" });
  // `matching-refs` is a prefix match: a sibling task's claim is neither this task's claim nor its admission.
  override("matching-refs/rmd-dispatch/W9-T1", JSON.stringify([{ ref: "refs/rmd-dispatch/W9-T10", object: { sha: ANCHOR } }]));
  assert.deepEqual(await target.observe(repo, "W9-T1"), { state: "none" });
  const sibling = await target.task(repo, "W9-T1");
  assert.ok(sibling.state === "found" && !sibling.task.claimed, "W9-T10's claim never reads as W9-T1's");
  // A claim minted a minute ago with its run branch published is running.
  override("matching-refs/rmd-dispatch/W9-T1", claimRef);
  assert.deepEqual(await target.observe(repo, "W9-T1"), { state: "running", url: "https://github.com/craigoley/wreckterra/tree/run-W9-T1-17" });
  const claimed = await target.task(repo, "W9-T1");
  assert.ok(claimed.state === "found" && claimed.task.claimed, "a held dispatch claim is read as claimed");
  override("search/issues", JSON.stringify({ total_count: 1 }));
  const merged = await target.task(repo, "W9-T1");
  assert.ok(merged.state === "found" && merged.task.merged, "merged credit is read from the trailer search");
  // The run ended and its refs remain: an old mint and renewal and an old branch commit are admission, not execution.
  override(`git/commits/${ANCHOR}`, commit(anchorAt(NOW - 3 * 3_600_000, NOW - 2 * 3_600_000), NOW - 2 * 3_600_000));
  override(`git/commits/${TIP}`, commit("last worker commit", NOW - 2 * 3_600_000));
  assert.deepEqual(await target.observe(repo, "W9-T1"), { state: "admitted" }, "leftover refs after the run ended never read as running");
  // Silence of exactly the two-renewal floor is already past what a live holder allows.
  override(`git/commits/${TIP}`, commit("last worker commit", NOW - CLAIM_SILENCE_FLOOR_MS));
  assert.deepEqual(await target.observe(repo, "W9-T1"), { state: "admitted" });
  // A fresh run-branch commit, or a fresh renewal on an old claim, is a live holder's sign of life.
  override(`git/commits/${TIP}`, commit("fresh worker commit", NOW - CLAIM_SILENCE_FLOOR_MS + 1));
  assert.equal((await target.observe(repo, "W9-T1")).state, "running");
  override(`git/commits/${TIP}`, commit("last worker commit", NOW - 2 * 3_600_000));
  override(`git/commits/${ANCHOR}`, commit(anchorAt(NOW - 3 * 3_600_000, NOW - 60_000), NOW - 60_000));
  assert.equal((await target.observe(repo, "W9-T1")).state, "running");
  // Alive but no exact published run branch to link: admitted, never running.
  override("matching-refs/heads/run-W9-T1-", JSON.stringify([{ ref: "refs/heads/run-W9-T1-17-retry", object: { sha: TIP } }, { ref: "refs/heads/run-W9-T1-18" }]));
  assert.deepEqual(await target.observe(repo, "W9-T1"), { state: "admitted" });
  override("matching-refs/heads/run-W9-T1-", JSON.stringify([]));
  assert.deepEqual(await target.observe(repo, "W9-T1"), { state: "admitted" });
  // A claim whose anchor carries no decodable identity, or no object, still proves only admission.
  override(`git/commits/${ANCHOR}`, commit("not a claim anchor", NOW));
  assert.deepEqual(await target.observe(repo, "W9-T1"), { state: "admitted" });
  override("matching-refs/rmd-dispatch/W9-T1", JSON.stringify([{ ref: "refs/rmd-dispatch/W9-T1" }]));
  assert.deepEqual(await target.observe(repo, "W9-T1"), { state: "admitted" });
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
