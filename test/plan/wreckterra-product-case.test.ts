import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { stringify } from "yaml";
import { ProductCaseService, productCasePlanText } from "#src/lib/product-case.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import { productPlanOrigin } from "#src/lib/product-build.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const actor = "clerk:alice";
const head = "c".repeat(40);
const repository = { id: 1432832754, owner: "craigoley", name: "wreckterra", visibility: "public" };
const planEvidenceId = "wreckterra-plan-v1";
const brief = {
  name: "Wreckterra", portfolio: "OleyArcade", idea: "Original IP vehicle combat in Central Park",
  objective: "A mobile-first solo Central Park prototype",
  requestedRepository: { owner: "craigoley", name: "wreckterra" },
  decisions: [
    ["ip", "Original IP only"], ["mobile", "Mobile-first touch controls"],
    ["players", "Solo first, network-ready architecture"], ["map", "OpenStreetMap Central Park fidelity and attribution"],
    ["resources", "Use existing resources only"],
  ].map(([key, value]) => ({ key, value, provenance: { kind: "operator" as const, reference: "operator-request#wreckterra-console-product-2026-10-25" } })),
  resourceEnvelope: { budgetUsd: 30, maxConcurrentBuilds: 1, existingSetupOnly: true },
};

function fixture(t: TestContext) {
  const root = ownedFixtureDir(t, "wreckterra-case").dir;
  const shim = ghShim([
    { when: "commits/main", stdout: JSON.stringify({ sha: head }) },
    { when: `contents?ref=${head}`, stdout: JSON.stringify([{ name: "src" }]) },
    { when: "contents/plan/tasks.d?", stdout: JSON.stringify([{ name: "W9-T1-prototype.yaml" }]) },
    { when: "matching-refs/", stdout: "[]" },
    { when: "search/issues", stdout: '{"total_count":0}' },
    { when: "api repos/craigoley/wreckterra", stdout: JSON.stringify({ id: repository.id, name: repository.name,
      owner: { login: repository.owner }, private: false, default_branch: "main" }) },
  ]);
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath}`;
  t.after(() => { process.env.PATH = savedPath; rmSync(shim.dir, { recursive: true, force: true }); });
  mkdirSync(join(root, ".remudero"), { recursive: true });
  writeFileSync(join(root, ".remudero/managed-repos.json"), JSON.stringify({ repos: ["craigoley/wreckterra"] }));
  writeFileSync(join(root, ".remudero/daemon-instances.yaml"), "instances:\n  core:\n    github_repo: craigoley/remudero\n  wreckterra:\n    github_repo: craigoley/wreckterra\n");
  const stateBase = join(root, "instances");
  const daemonState = join(stateBase, "wreckterra/state");
  mkdirSync(daemonState, { recursive: true });
  const options = { root, repoRoot: root, instances: { stateBase } };
  const service = () => new ProductCaseService(options);
  const store = () => new ProductIntentStore({ root });
  const imported = () => service().execute(actor, { version: "product-case-v1", action: "import",
    command: { version: "product-intent-v1", requestId: "case-import-000001", expectedRevision: 0, brief } });
  const adopt = (productId: string) => ({ version: "product-case-v1", action: "adopt", command: {
    version: "product-repository-v1", requestId: "case-adopt-000001", action: "adopt", productId,
    expectedRevision: 1, expectedObjectiveRevision: 1, repositoryId: repository.id,
    owner: repository.owner, name: repository.name, visibility: repository.visibility } });
  const plan = (productId: string) => ({ version: "product-case-v1", action: "plan", command: {
    requestId: "case-plan-0000001", productId, expectedRevision: 2, expectedObjectiveRevision: 1,
    planEvidenceId, taskId: "W9-T1", pullRequest: 7 } });
  const build = (productId: string) => ({ version: "product-case-v1", action: "build", command: {
    version: "product-build-v1", requestId: "case-build-000001", productId, expectedRevision: 3,
    expectedObjectiveRevision: 1, planEvidenceId, taskId: "W9-T1" } });
  const configurePlan = (productId: string, changes: Record<string, unknown> = {}) => {
    const task = { id: "W9-T1", origin: productPlanOrigin(productId, planEvidenceId), status: "queued", budget_usd: 10,
      design: productCasePlanText(brief), ...changes };
    shim.addRoute({ when: "contents/plan/tasks.d/W9-T1-prototype.yaml", stdout: stringify([task]) });
    shim.addRoute({ when: "pulls/7", stdout: JSON.stringify({ number: 7, merged_at: "2026-10-26T00:00:00Z",
      merge_commit_sha: head, head: { sha: head }, base: { ref: "main", repo: { id: repository.id } } }) });
    shim.addRoute({ when: "pulls/7/files", stdout: JSON.stringify([{ filename: "plan/tasks.d/W9-T1-prototype.yaml" }]) });
    shim.addRoute({ when: "pulls/7/reviews", stdout: JSON.stringify([{ state: "APPROVED", commit_id: head, user: { login: "reviewer" } }]) });
  };
  return { root, daemonState, shim, service, store, imported, adopt, plan, build, configurePlan };
}

async function throughPlan(t: TestContext) {
  const f = fixture(t);
  const saved = await f.imported();
  assert.ok(saved.ok);
  const id = saved.value.productId;
  assert.ok((await f.service().execute(actor, f.adopt(id))).ok);
  f.configurePlan(id);
  const planned = await f.service().execute(actor, f.plan(id));
  assert.ok(planned.ok, JSON.stringify(planned));
  return { ...f, id };
}

test("W1-T10618: Wreckterra resumes the same product and repository across every stage", async (t) => {
  const f = await throughPlan(t);
  const result = await f.service().execute(actor, f.build(f.id));
  assert.ok(result.ok);
  assert.equal(result.value.build?.outcome, "queued");
  for (const retry of [await f.imported(), await f.service().execute(actor, f.adopt(f.id)),
    await f.service().execute(actor, f.plan(f.id)), await f.service().execute(actor, f.build(f.id))]) {
    assert.ok(retry.ok);
    assert.equal(retry.value.productId, f.id);
    assert.equal(retry.value.replayed, true);
  }
  const read = f.store().read(actor, f.id);
  assert.ok(read.ok);
  assert.equal(read.value.repository?.id, repository.id);
  assert.equal(read.value.repository?.owner, repository.owner);
  assert.equal(read.value.repository?.name, repository.name);
  assert.equal(read.value.objectiveRevision, 1);
  assert.equal(f.store().list(actor).value?.length, 1);
  assert.equal(f.store().list("clerk:bob").value?.length, 0);
  const wrongOwner = await f.service().execute("clerk:bob", f.build(f.id));
  assert.equal(wrongOwner.code, "not_found");
  const collision = f.adopt(f.id);
  collision.command.repositoryId = 7;
  assert.equal((await f.service().execute(actor, collision)).code, "idempotency_conflict");
  const changedPlan = f.plan(f.id);
  changedPlan.command.pullRequest = 8;
  assert.equal((await f.service().execute(actor, changedPlan)).code, "idempotency_conflict");
  assert.ok(existsSync(join(f.daemonState, "KICK_REQUESTED-wreckterra:W9-T1")));
  assert.ok(!f.shim.calls().some((call) => call.includes("-X POST")));
});

test("W1-T10618: Wreckterra carries approved mobile Central Park requirements into its build", async (t) => {
  const f = await throughPlan(t);
  const built = await f.service().execute(actor, f.build(f.id));
  assert.ok(built.ok);
  const product = f.store().read(actor, f.id);
  assert.ok(product.ok);
  assert.deepEqual(product.value.brief, brief);
  assert.equal(built.value.build?.planEvidenceId, planEvidenceId);
  assert.equal(built.value.build?.repository.id, repository.id);
  assert.equal(built.value.build?.objectiveRevision, product.value.objectiveRevision);
  assert.equal(product.value.stageEvidence.find((item) => item.id === planEvidenceId)?.stage, "plan");
  assert.ok(product.value.stageEvidence.some((item) => item.id === `case-onboarding:${planEvidenceId}`));
  assert.equal(built.value.evidence.review.length, 1);
  assert.equal(built.value.evidence.merge.length, 1);
  assert.deepEqual(built.value.evidence.deploy, []);
  assert.deepEqual(built.value.evidence.mobile, []);
  assert.deepEqual(built.value.evidence.local, []);
  assert.deepEqual(built.value.evidence.hosted, []);
  assert.match(readFileSync(join(f.daemonState, "KICK_REQUESTED-wreckterra:W9-T1"), "utf8"), /product:/);
});

test("W1-T10618: metadata alone cannot satisfy the Wreckterra end to end case", async (t) => {
  const f = fixture(t);
  const saved = await f.imported(); assert.ok(saved.ok);
  const id = saved.value.productId;
  assert.equal((await f.service().execute(actor, f.build(id))).code, "repository_missing");
  assert.ok((await f.service().execute(actor, f.adopt(id))).ok);
  f.configurePlan(id, { design: "metadata only" });
  assert.equal((await f.service().execute(actor, f.plan(id))).code, "plan_not_approved");
  f.configurePlan(id);
  f.shim.addRoute({ when: "pulls/7/reviews", stdout: "[]" });
  assert.equal((await f.service().execute(actor, f.plan(id))).code, "plan_not_approved");
  f.configurePlan(id);
  f.shim.addRoute({ when: "pulls/7", stdout: "not-json" });
  assert.equal((await f.service().execute(actor, f.plan(id))).code, "provider_unreadable");
  f.configurePlan(id);
  assert.ok((await f.service().execute(actor, f.plan(id))).ok);
  f.configurePlan(id, { design: "requirements were removed after approval" });
  assert.equal((await f.service().execute(actor, f.build(id))).code, "plan_not_approved");
  assert.ok(!existsSync(join(f.daemonState, "KICK_REQUESTED-wreckterra:W9-T1")));
});


test("case import validates identity and authority and reports a failed durable boundary", async (t) => {
  const f = fixture(t);
  assert.equal((await f.service().execute("", {})).code, "invalid_identity");
  assert.equal((await f.service().execute(actor, { version: "product-case-v1", action: "import",
    command: { version: "product-intent-v1", requestId: "bad-case-import01", expectedRevision: 0, brief, verified: true } })).code, "invalid_input");
  assert.equal(f.store().list(actor).value?.length, 0);
  const broken = new class extends ProductIntentStore {
    override read(): never { throw new Error("storage boundary failed"); }
  }({ root: f.root });
  const service = new ProductCaseService({ root: f.root, store: broken });
  assert.equal((await service.execute(actor, f.adopt("prd_" + "0".repeat(32)))).code, "unavailable");
});

test("case planning refuses independent repository, onboarding and review failures", async (t) => {
  const f = fixture(t);
  const saved = await f.imported(); assert.ok(saved.ok);
  const id = saved.value.productId;
  assert.ok((await f.service().execute(actor, f.adopt(id))).ok);
  f.configurePlan(id);
  const attempt = () => f.service().execute(actor, f.plan(id));
  const pull = { number: 7, merged_at: "2026-10-26T00:00:00Z", merge_commit_sha: head, head: { sha: head },
    base: { ref: "main", repo: { id: repository.id } } };
  for (const bad of [{ ...pull, merged_at: null }, { ...pull, base: { ref: "other", repo: { id: repository.id } } },
    { ...pull, base: { ref: "main", repo: { id: 7 } } }, { ...pull, number: 9 }]) {
    f.shim.addRoute({ when: "pulls/7", stdout: JSON.stringify(bad) });
    f.shim.addRoute({ when: "pulls/7/reviews", stdout: JSON.stringify([{ state: "APPROVED", commit_id: head, user: { login: "reviewer" } }]) });
    assert.equal((await attempt()).code, "plan_not_approved");
  }
  f.configurePlan(id);
  f.shim.addRoute({ when: "pulls/7/reviews", stdout: JSON.stringify([
    { state: "APPROVED", commit_id: head, user: { login: "reviewer" } }, { state: "CHANGES_REQUESTED", commit_id: head, user: { login: "reviewer" } }]) });
  assert.equal((await attempt()).code, "plan_not_approved");
  f.configurePlan(id);
  f.shim.addRoute({ when: "pulls/7/reviews", stdout: JSON.stringify([{ state: "APPROVED", commit_id: "e".repeat(40), user: { login: "reviewer" } }]) });
  assert.equal((await attempt()).code, "plan_not_approved");
  f.configurePlan(id);
  f.shim.addRoute({ when: "pulls/7/files", stdout: JSON.stringify([{ filename: "README.md" }]) });
  assert.equal((await attempt()).code, "plan_not_approved");
  f.configurePlan(id);
  f.shim.addRoute({ when: `contents?ref=${head}`, stdout: JSON.stringify([{ name: "README.md" }]) });
  assert.equal((await attempt()).code, "bootstrap_unverified");
  f.shim.addRoute({ when: `contents?ref=${head}`, stdout: JSON.stringify([{ name: "src" }]) });
  writeFileSync(join(f.root, ".remudero/managed-repos.json"), JSON.stringify({ repos: [] }));
  assert.equal((await attempt()).code, "target_not_enrolled");
  writeFileSync(join(f.root, ".remudero/managed-repos.json"), JSON.stringify({ repos: ["craigoley/wreckterra"] }));
  f.shim.addRoute({ when: "api repos/craigoley/wreckterra", stdout: JSON.stringify({ id: 7, name: "wreckterra", owner: { login: "craigoley" }, private: false, default_branch: "main" }) });
  assert.equal((await attempt()).code, "repository_conflict");
  f.shim.addRoute({ when: "api repos/craigoley/wreckterra", stderr: "gh: Not Found (HTTP 404)", exit: 1 });
  assert.equal((await attempt()).code, "repository_not_found");
  f.shim.addRoute({ when: "api repos/craigoley/wreckterra", stdout: "bad-json" });
  assert.equal((await attempt()).code, "provider_unreadable");
  assert.equal(f.store().read(actor, id).value?.revision, 2);
  assert.ok(!existsSync(join(f.daemonState, "KICK_REQUESTED-wreckterra:W9-T1")));
});


test("case lost responses recover durable plan and build receipts during a provider outage", async (t) => {
  const f = await throughPlan(t);
  const first = await f.service().execute(actor, f.build(f.id)); assert.ok(first.ok);
  f.shim.addRoute({ when: "api repos/", stdout: "provider unavailable", exit: 1 });
  const plan = await f.service().execute(actor, f.plan(f.id));
  assert.ok(plan.ok); assert.equal(plan.value.replayed, true);
  const build = await f.service().execute(actor, f.build(f.id));
  assert.ok(build.ok); assert.equal(build.value.replayed, true);
  assert.deepEqual(build.value.build, first.value.build);
  assert.equal(build.value.revision, first.value.revision);
  const changed = f.plan(f.id);
  changed.command.pullRequest = 8;
  assert.equal((await f.service().execute(actor, changed)).code, "idempotency_conflict");
});


test("trusted case receipts persist separately and browser metadata grants no evidence", async (t) => {
  const f = await throughPlan(t);
  const service = f.service();
  assert.equal((await service.execute(actor, { version: "product-case-v1", action: "evidence", verified: true })).code, "invalid_input");
  const receipt = { requestId: "case-local-proof01", productId: f.id, expectedRevision: 3, expectedObjectiveRevision: 1,
    repositoryId: repository.id, channel: "local" as const, observedAt: "2026-10-27T00:00:00.000Z",
    references: [{ label: "Fixture local receipt", url: "https://example.test/receipts/local" }] };
  assert.equal(service.recordEvidence(actor, { ...receipt, references: [] }).code, "invalid_input");
  assert.equal(service.recordEvidence("clerk:bob", receipt).code, "not_found");
  assert.equal(service.recordEvidence(actor, { ...receipt, repositoryId: 7 }).code, "repository_conflict");
  assert.ok(service.recordEvidence(actor, receipt).ok);
  const replay = service.recordEvidence(actor, receipt);
  assert.ok(replay.ok);
  assert.equal(replay.value.replayed, true);
  const rehydrated = await f.imported(); assert.ok(rehydrated.ok);
  assert.deepEqual(rehydrated.value.evidence.local.map((item) => item.reference), [receipt.references[0].url]);
  assert.deepEqual(rehydrated.value.evidence.hosted, []);
  assert.deepEqual(rehydrated.value.evidence.deploy, []);
  assert.deepEqual(rehydrated.value.evidence.mobile, []);
});
