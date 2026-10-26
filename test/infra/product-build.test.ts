import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  BOOTSTRAP_CHECKS, bootstrapConfirmed, bootstrapEvidenceId, ghProductBuildTarget, productPlanOrigin, ProductBuildService,
  type BuildObservation, type BuildTask, type ProductBuildOptions, type ProductBuildTarget, type TargetInspection, type TaskRead,
} from "#src/lib/product-build.js";
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
  const options: ProductBuildOptions = { root, store, target, provider, now: () => "2026-10-26T01:00:00.000Z",
    kick: (_root, taskId, origin, repo) => { kicks.push([taskId, origin, repo]); } };
  const service = new ProductBuildService(options);
  const command = (extra: Record<string, unknown> = {}) => ({ version: "product-build-v1", requestId: "build-request-0001", productId,
    planEvidenceId: planEvidence.id, taskId: "W9-T1", expectedRevision: 2, expectedObjectiveRevision: 1, ...extra });
  return { root, store, productId, target, provider, kicks, service, command, options };
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
  assert.ok(existsSync(kickMarker(f.root, "wreckterra", "W9-T1")));
  assert.ok(!existsSync(join(f.root, "state", "KICK_REQUESTED-W9-T1")), "the unscoped marker of this repository's own task is untouched");
  mkdirSync(join(f.root, "state"), { recursive: true });
  writeFileSync(join(f.root, "state", "PAUSE"), "{}");
  const halted = fixture(t);
  writeFileSync(join(halted.root, "state", "STOP"), "{}");
  assert.equal(await refused(halted.service.execute(actor, halted.command())), "fleet_halted");
  assert.equal(await refused(new ProductBuildService({ ...halted.options, root: undefined }).execute(actor, halted.command())), "unavailable");
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
  const routes: { when: string; stdout: string }[] = [
    { when: "commits/main", stdout: JSON.stringify({ sha: HEAD }) },
    { when: `contents?ref=${HEAD}`, stdout: JSON.stringify([{ name: "README.md" }, { name: "LICENSE" }]) },
    { when: "contents/plan/tasks.d/W9-T1-first.yaml", stdout: shard },
    { when: "contents/plan/tasks.d?ref=main", stdout: JSON.stringify([{ name: "W9-T1-first.yaml" }]) },
    { when: "matching-refs/rmd-dispatch/W9-T1", stdout: JSON.stringify([]) },
    { when: "matching-refs/heads/run-W9-T1-", stdout: JSON.stringify([{ ref: "refs/heads/run-W9-T1-17" }]) },
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
  assert.deepEqual(await target.observe(repo, "W9-T1"), { state: "none" });
  override("matching-refs/rmd-dispatch/W9-T1", JSON.stringify([{ ref: "refs/rmd-dispatch/W9-T1" }]));
  assert.deepEqual(await target.observe(repo, "W9-T1"), { state: "running", url: "https://github.com/craigoley/wreckterra/tree/run-W9-T1-17" });
  override("matching-refs/heads/run-W9-T1-", JSON.stringify([]));
  assert.deepEqual(await target.observe(repo, "W9-T1"), { state: "admitted" });
  const claimed = await target.task(repo, "W9-T1");
  assert.ok(claimed.state === "found" && claimed.task.claimed, "a held dispatch claim is read as claimed");
  override("search/issues", JSON.stringify({ total_count: 1 }));
  const merged = await target.task(repo, "W9-T1");
  assert.ok(merged.state === "found" && merged.task.merged, "merged credit is read from the trailer search");
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
