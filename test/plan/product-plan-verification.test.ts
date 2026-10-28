import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { stringify } from "yaml";
import { clockFromMillisFn, fixedClock } from "#src/lib/clock.js";
import { DEFAULT_LIVENESS_BOUND_MS } from "#src/lib/non-worker-verdict.js";
import { ProductBuildService, productBuildKickOrigin, readTargetExecution, type BuildTask, type ProductBuildTarget, type TargetInspection, type TaskRead } from "#src/lib/product-build.js";
import { ProductCaseService } from "#src/lib/product-case.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import type { StoredProduct } from "#src/lib/product-intent.js";
import { productCasePlanText, productPlanOrigin, verifyProductPlanEvidence, type ProductPlanVerification } from "#src/lib/product-plan-operation.js";
import type { ProductRepositoryProvider } from "#src/lib/product-repository.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const actor = "clerk:alice";
const REVIEWED = "1".repeat(40);
const MERGE = "2".repeat(40);
const HEAD = "3".repeat(40);
const REPO_ID = 1432832754;
const TRUSTED = "remudero-reviewer[bot]";
const WRECK_ORIGIN = "operator-request#wreckterra-console-product-2026-10-25";
const brief = {
  name: "Wreckterra", idea: "Original IP vehicle combat in Central Park", objective: "A mobile-first solo Central Park prototype",
  requestedRepository: { owner: "craigoley", name: "wreckterra" },
  resourceEnvelope: { budgetUsd: 30, maxConcurrentBuilds: 1, existingSetupOnly: true },
};
const identity = { provider: "github", id: REPO_ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public", verifiedAt: "2026-10-26T00:00:00.000Z" } as const;
const shardPath = "plan/tasks.d/WRECK-T1-first.yaml";
const shardRoute = (ref: string) => `contents/${shardPath}?ref=${ref}`;

/** The merged Wreckterra plan PR's native shape: COMMENTED reviews, a trusted remudero-review success, no GitHub APPROVED review. */
function wreck(t: TestContext) {
  const root = ownedFixtureDir(t, "product-plan-verification").dir;
  const store = new ProductIntentStore({ root });
  const saved = store.write(actor, { version: "product-intent-v1", requestId: "seed-product-00001", expectedRevision: 0, brief });
  assert.ok(saved.ok);
  const productId = saved.value.receipt.productId;
  assert.ok(store.transition(actor, { version: "product-intent-v1", requestId: "seed-bound-0000001", id: productId,
    expectedRevision: 1, expectedObjectiveRevision: 1, repository: identity }).ok);
  const planEvidenceId = "wreck-plan-v1";
  const task = (over: Record<string, unknown> = {}) => ({ id: "WRECK-T1", origin: WRECK_ORIGIN, status: "queued", budget_usd: 10,
    design: `${productCasePlanText(brief)}\nTask origin: ${productPlanOrigin(productId, planEvidenceId)}`, ...over });
  const shim = ghShim([
    { when: "commits/main", stdout: JSON.stringify({ sha: HEAD }) },
    { when: `contents?ref=${HEAD}`, stdout: JSON.stringify([{ name: "src" }]) },
    { when: "contents/plan/tasks.d?", stdout: JSON.stringify([{ name: "WRECK-T1-first.yaml" }]) },
    { when: "matching-refs/", stdout: "[]" },
    { when: "search/issues", stdout: '{"total_count":0}' },
    { when: `commits/${REVIEWED}/status`, stdout: JSON.stringify({ statuses: [{ context: "remudero-review", state: "success", creator: { login: TRUSTED, type: "Bot" } }] }) },
    { when: "pulls/7/reviews", stdout: JSON.stringify([{ state: "COMMENTED", commit_id: REVIEWED, user: { login: TRUSTED } }]) },
    { when: "pulls/7/files", stdout: JSON.stringify([{ filename: shardPath }]) },
    { when: "pulls/7", stdout: JSON.stringify({ number: 7, merged_at: "2026-10-26T00:00:00Z", merge_commit_sha: MERGE, head: { sha: REVIEWED },
      base: { ref: "main", repo: { id: REPO_ID } } }) },
    { when: shardRoute(HEAD), stdout: stringify([task()]) },
    { when: shardRoute(REVIEWED), stdout: stringify([task()]) },
    { when: shardRoute(MERGE), stdout: stringify([task()]) },
    { when: shardRoute("main"), stdout: stringify([task()]) },
    { when: "api repos/craigoley/wreckterra", stdout: JSON.stringify({ id: REPO_ID, name: "wreckterra", owner: { login: "craigoley" }, private: false, default_branch: "main" }) },
  ]);
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath}`;
  t.after(() => { process.env.PATH = savedPath; rmSync(shim.dir, { recursive: true, force: true }); });
  const product = (): StoredProduct => { const read = store.read(actor, productId); assert.ok(read.ok); return read.value; };
  const verify = (over: Partial<ProductPlanVerification> = {}) => verifyProductPlanEvidence({ product: product(), planEvidenceId, taskId: "WRECK-T1",
    purpose: "record", pullRequest: 7, targetHead: HEAD, trustedReviewer: TRUSTED, ...over });
  // `pulls/7` is a substring of its own sub-routes, so any change re-adds all three, the most specific last.
  const page = { pull: {} as Record<string, unknown> | string, files: [{ filename: shardPath }] as unknown, reviews: [{ state: "COMMENTED", commit_id: REVIEWED, user: { login: TRUSTED } }] as unknown };
  const setPage = (changes: Partial<typeof page>) => {
    Object.assign(page, changes);
    shim.addRoute({ when: "pulls/7", stdout: typeof page.pull === "string" ? page.pull : JSON.stringify({ number: 7, merged_at: "2026-10-26T00:00:00Z", merge_commit_sha: MERGE,
      head: { sha: REVIEWED }, base: { ref: "main", repo: { id: REPO_ID } }, ...page.pull }) });
    shim.addRoute({ when: "pulls/7/files", stdout: JSON.stringify(page.files) });
    shim.addRoute({ when: "pulls/7/reviews", stdout: JSON.stringify(page.reviews) });
  };
  const everywhere = (changes: Record<string, unknown>) => { for (const ref of [HEAD, REVIEWED, MERGE, "main"]) shim.addRoute({ when: shardRoute(ref), stdout: stringify([task(changes)]) }); };
  return { root, store, productId, planEvidenceId, shim, task, product, verify, everywhere, setPage };
}
const refusal = (verdict: Awaited<ReturnType<typeof verifyProductPlanEvidence>>) => { assert.equal(verdict.ok, false, JSON.stringify(verdict)); return verdict.code; };

test("W1-T10823: shared plan verification accepts native review and preserves original task origin", async (t) => {
  const f = wreck(t);
  // The merged Wreckterra plan's native shape is accepted without a GitHub APPROVED review, and its original origin survives.
  const accepted = await f.verify();
  assert.ok(accepted.ok, JSON.stringify(accepted));
  assert.equal(accepted.value.receipt?.review, "native-status");
  assert.deepEqual(accepted.value.receipt && [accepted.value.receipt.head, accepted.value.receipt.merge, accepted.value.receipt.reviewedHead], [HEAD, MERGE, REVIEWED]);
  assert.deepEqual(accepted.value.association, { taskId: "WRECK-T1", origin: WRECK_ORIGIN, pullRequest: 7, head: REVIEWED, merge: MERGE },
    "the association names the task id, its ORIGINAL origin and the exact PR, head and merge");
  assert.ok(!f.shim.calls().some((call) => call.includes("-X POST")));
  // A plan whose own origin is the product's needs no association and records none.
  f.everywhere({ origin: productPlanOrigin(f.productId, f.planEvidenceId) });
  const own = await f.verify();
  assert.ok(own.ok);
  assert.equal(own.value.association, undefined);
  f.everywhere({});

  // Forging the origin instead of associating refuses: an origin the task does not carry, with no token in its design.
  f.everywhere({ design: productCasePlanText(brief) });
  assert.equal(refusal(await f.verify()), "plan_not_approved");
  f.everywhere({});
  // Without an explicit recorded association an admission refuses; the original origin is never silently accepted.
  assert.equal(refusal(await f.verify({ purpose: "admit" })), "plan_not_approved");
  assert.equal(refusal(await f.verify({ purpose: "admit", task: { origin: WRECK_ORIGIN, budgetUsd: 10 } })), "task_stale");

  // Foreign, stale, missing or ambiguous receipts all refuse.
  assert.equal(refusal(await f.verify({ trustedReviewer: "someone-else" })), "plan_not_approved", "a status posted by another login is not the trusted reviewer's");
  assert.equal(refusal(await f.verify({ trustedReviewer: "" })), "plan_not_approved", "with no trusted identity there is no native contract");
  const status = (state: string, login = TRUSTED) => f.shim.addRoute({ when: `commits/${REVIEWED}/status`,
    stdout: JSON.stringify({ statuses: [{ context: "remudero-review", state, creator: { login, type: "Bot" } }] }) });
  status("success", "attacker[bot]");
  assert.equal(refusal(await f.verify()), "plan_not_approved", "a forged poster is absent, never success");
  status("failure");
  assert.equal(refusal(await f.verify()), "plan_not_approved");
  status("pending");
  assert.equal(refusal(await f.verify()), "plan_not_approved");
  f.shim.addRoute({ when: `commits/${REVIEWED}/status`, stdout: JSON.stringify({ statuses: [] }) });
  assert.equal(refusal(await f.verify()), "plan_not_approved", "a missing status refuses");
  f.shim.addRoute({ when: `commits/${REVIEWED}/status`, stdout: "not-json" });
  assert.equal(refusal(await f.verify()), "provider_unreadable", "an unreadable status is never read as success");
  status("success");
  assert.ok((await f.verify()).ok);
  const pull = (changes: Record<string, unknown>) => f.setPage({ pull: changes });
  pull({ merged_at: null });
  assert.equal(refusal(await f.verify()), "plan_not_approved", "an unmerged plan");
  pull({ base: { ref: "other", repo: { id: REPO_ID } } });
  assert.equal(refusal(await f.verify()), "plan_not_approved", "a merge into another branch");
  pull({ base: { ref: "main", repo: { id: 7 } } });
  assert.equal(refusal(await f.verify()), "plan_not_approved", "another repository");
  f.shim.addRoute({ when: `commits/${"4".repeat(40)}/status`, stdout: JSON.stringify({ statuses: [] }) });
  pull({ head: { sha: "4".repeat(40) } });
  assert.equal(refusal(await f.verify()), "plan_not_approved", "a status at some other head is not the exact reviewed head's");
  pull({});
  f.setPage({ files: [{ filename: shardPath }, { filename: "src/lib/anything.ts" }] });
  assert.equal(refusal(await f.verify()), "plan_not_approved", "a native review covers a plan-only pull request");
  f.setPage({ files: [{ filename: "plan/tasks.d/OTHER-T1-x.yaml" }] });
  assert.equal(refusal(await f.verify()), "plan_not_approved", "the PR must carry this task's shard");
  f.setPage({ files: [{ filename: shardPath }], reviews: Array.from({ length: 100 }, () => ({ state: "COMMENTED", commit_id: REVIEWED, user: { login: TRUSTED } })) });
  assert.equal(refusal(await f.verify()), "plan_not_approved", "a full review page is ambiguous");
  f.setPage({ reviews: [{ state: "COMMENTED", commit_id: REVIEWED, user: { login: TRUSTED } }] });
  assert.ok((await f.verify()).ok);

  // Post-review drift: the task differs at the reviewed head, the merge or the current target head.
  for (const ref of [HEAD, REVIEWED, MERGE]) {
    f.shim.addRoute({ when: shardRoute(ref), stdout: stringify([f.task({ budget_usd: 11 })]) });
    assert.equal(refusal(await f.verify()), "plan_not_approved", `drift at ${ref.slice(0, 1)} refuses`);
    f.shim.addRoute({ when: shardRoute(ref), stdout: stringify([f.task()]) });
  }
  f.everywhere({ design: "requirements were removed after approval" });
  assert.equal(refusal(await f.verify()), "plan_not_approved");
  f.everywhere({});

  // A standing human hold refuses, even beside a trusted success; the hold is the reviewer's LATEST decisive review.
  f.setPage({ reviews: [
    { state: "COMMENTED", commit_id: REVIEWED, user: { login: TRUSTED } }, { state: "CHANGES_REQUESTED", commit_id: REVIEWED, user: { login: "craigoley" } }] });
  assert.equal(refusal(await f.verify()), "plan_not_approved");
  f.setPage({ reviews: [
    { state: "CHANGES_REQUESTED", commit_id: REVIEWED, user: { login: "craigoley" } }, { state: "APPROVED", commit_id: REVIEWED, user: { login: "craigoley" } }] });
  assert.ok((await f.verify()).ok, "a hold the same reviewer later withdrew is not standing");
  f.setPage({ reviews: [{ state: "COMMENTED", commit_id: REVIEWED, user: { login: TRUSTED } }] });

  // An over-envelope budget, and a missing one, refuse.
  f.everywhere({ budget_usd: 31 });
  assert.equal(refusal(await f.verify()), "budget_exceeded");
  f.everywhere({ budget_usd: undefined });
  assert.equal(refusal(await f.verify()), "budget_exceeded");
  f.everywhere({});
  f.setPage({ pull: "not-json" });
  assert.equal(refusal(await f.verify()), "provider_unreadable");
  f.setPage({ pull: {} });
  assert.ok((await f.verify()).ok);
});

test("W1-T10823: the case records a WRECK association that the build then re-verifies against GitHub", async (t) => {
  const f = wreck(t);
  mkdirSync(join(f.root, ".remudero"), { recursive: true });
  writeFileSync(join(f.root, ".remudero/managed-repos.json"), JSON.stringify({ repos: ["craigoley/wreckterra"] }));
  writeFileSync(join(f.root, ".remudero/daemon-instances.yaml"), "instances:\n  core:\n    github_repo: craigoley/remudero\n  wreckterra:\n    github_repo: craigoley/wreckterra\n");
  const stateBase = join(f.root, "instances");
  mkdirSync(join(stateBase, "wreckterra/state"), { recursive: true });
  const service = () => new ProductCaseService({ root: f.root, repoRoot: f.root, instances: { stateBase }, planTrustedReviewer: TRUSTED });
  const planning = { version: "product-case-v1", action: "plan", command: { requestId: "case-plan-0000001", productId: f.productId, expectedRevision: 2,
    expectedObjectiveRevision: 1, planEvidenceId: f.planEvidenceId, taskId: "WRECK-T1", pullRequest: 7 } };
  const build = { version: "product-case-v1", action: "build", command: { version: "product-build-v1", requestId: "case-build-000001", productId: f.productId,
    expectedRevision: 3, expectedObjectiveRevision: 1, planEvidenceId: f.planEvidenceId, taskId: "WRECK-T1" } };
  const planned = await service().execute(actor, planning);
  assert.ok(planned.ok, JSON.stringify(planned));
  const refs = f.product().stageEvidence.find((item) => item.id === f.planEvidenceId)?.references.map((ref) => ref.label) ?? [];
  assert.ok(refs.includes("Association WRECK-T1") && refs.includes(`Original origin ${WRECK_ORIGIN}`), "the association is an explicit, durable record");
  assert.ok(refs.includes(`Association head ${REVIEWED}`) && refs.includes(`Association merge ${MERGE}`));

  // The build re-reads GitHub through the same rule: post-review drift refuses before any marker is written.
  f.everywhere({ design: "requirements were removed after approval" });
  assert.equal((await service().execute(actor, build)).code, "plan_not_approved");
  assert.ok(!existsSync(join(stateBase, "wreckterra/state/KICK_REQUESTED-wreckterra:WRECK-T1")));
  f.everywhere({});
  f.shim.addRoute({ when: `commits/${REVIEWED}/status`, stdout: JSON.stringify({ statuses: [{ context: "remudero-review", state: "failure", creator: { login: TRUSTED, type: "Bot" } }] }) });
  assert.equal((await service().execute(actor, build)).code, "plan_not_approved", "the native review is re-read, not remembered");
  f.shim.addRoute({ when: `commits/${REVIEWED}/status`, stdout: JSON.stringify({ statuses: [{ context: "remudero-review", state: "success", creator: { login: TRUSTED, type: "Bot" } }] }) });
  f.everywhere({ budget_usd: 31 });
  assert.equal((await service().execute(actor, build)).code, "budget_exceeded");
  f.everywhere({});
  const started = await service().execute(actor, build);
  assert.ok(started.ok, JSON.stringify(started));
  assert.equal(started.value.build?.outcome, "queued");
  assert.ok(existsSync(join(stateBase, "wreckterra/state/KICK_REQUESTED-wreckterra:WRECK-T1")));
  assert.equal(f.product().stageEvidence.find((item) => item.id === f.planEvidenceId)?.references.find((ref) => ref.label.startsWith("Original origin"))?.label,
    `Original origin ${WRECK_ORIGIN}`, "the original origin is never rewritten");
  assert.ok(!f.shim.calls().some((call) => call.includes("-X POST")));

  // Forging an association: a record that carries none, or one for another origin, cannot admit this task.
  const admit = (stageEvidence: StoredProduct["stageEvidence"], origin: string) => f.verify({ product: { ...f.product(), stageEvidence }, purpose: "admit",
    pullRequest: undefined, task: { origin, budgetUsd: 10 } });
  assert.equal(refusal(await admit([], WRECK_ORIGIN)), "task_stale");
  assert.equal(refusal(await admit(f.product().stageEvidence, "forged-origin")), "task_stale", "an origin the association never named");
  assert.ok((await admit(f.product().stageEvidence, WRECK_ORIGIN)).ok, "the recorded association admits exactly the origin it named");
});

class FakeTarget implements ProductBuildTarget {
  inspection: TargetInspection = { enrolled: true, head: HEAD, readmeOnly: false };
  tasks = new Map<string, BuildTask>();
  async inspect() { return this.inspection; }
  runnerRegistered() { return true; }
  async task(_repo: unknown, taskId: string): Promise<TaskRead> { const task = this.tasks.get(taskId); return task ? { state: "found", task } : { state: "absent" }; }
  async observe() { return { state: "none" as const, branches: [] }; }
  async bootstrap() { return { state: "absent" as const }; }
}

test("W1-T10823: a product build refuses more active builds than its envelope allows", async (t) => {
  for (const [allowed, nativeState, second] of [
    [1, "unknown", "concurrency_exceeded"], [2, "unknown", undefined],
    [1, "dispatched", "concurrency_exceeded"], [2, "dispatched", undefined],
    [1, "running", "concurrency_exceeded"], [2, "running", undefined],
    [1, "silent", "concurrency_exceeded"], [2, "silent", undefined],
    [1, "ended", undefined], [2, "ended", undefined],
    [1, "refused", undefined], [2, "refused", undefined],
  ] as const) {
    const root = ownedFixtureDir(t, "product-plan-envelope").dir;
    const store = new ProductIntentStore({ root });
    const saved = store.write(actor, { version: "product-intent-v1", requestId: "seed-product-00001", expectedRevision: 0,
      brief: { ...brief, resourceEnvelope: { budgetUsd: 30, maxConcurrentBuilds: allowed, existingSetupOnly: true } } });
    assert.ok(saved.ok);
    const productId = saved.value.receipt.productId;
    const plan = { id: "plan-approved-1", stage: "plan", outcome: "succeeded", objectiveRevision: 1, observedAt: "2026-10-26T00:00:01.000Z", references: [] } as const;
    assert.ok(store.transition(actor, { version: "product-intent-v1", requestId: "seed-trusted-000001", id: productId, expectedRevision: 1,
      expectedObjectiveRevision: 1, repository: identity, stageEvidence: [plan] }).ok);
    const target = new FakeTarget();
    for (const id of ["W9-T1", "W9-T2"]) target.tasks.set(id, { id, origin: productPlanOrigin(productId, plan.id), status: "queued", budgetUsd: 10, claimed: false, merged: false });
    const registryPath = join(root, "daemon-instances.yaml");
    writeFileSync(registryPath, "instances:\n  core:\n    github_repo: craigoley/remudero\n  wreckterra:\n    github_repo: craigoley/wreckterra\n    mode: shadow\n");
    const stateBase = join(root, "instances");
    mkdirSync(join(stateBase, "wreckterra", "state"), { recursive: true });
    const provider: Pick<ProductRepositoryProvider, "read"> = { async read() {
      return { state: "found", repository: { id: REPO_ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" } };
    } };
    const requestedAt = "2026-10-26T01:00:00.000Z";
    let nowMs = Date.parse(requestedAt);
    const service = new ProductBuildService({ root, store, target, provider, clock: clockFromMillisFn(() => nowMs),
      instances: { registryPath, stateBase }, kick: () => {} });
    const start = (taskId: string, requestId: string, expectedRevision: number) => service.execute(actor, { version: "product-build-v1", requestId, productId,
      planEvidenceId: plan.id, taskId, expectedRevision, expectedObjectiveRevision: 1 });
    const first = await start("W9-T1", "build-request-0001", 2);
    assert.ok(first.ok, JSON.stringify(first));
    const state = join(stateBase, "wreckterra", "state");
    const origin = productBuildKickOrigin(productId, first.value.receipt.operationId);
    const runId = "W9-T1-12345";
    if (nativeState !== "unknown") {
      const rows: Record<string, unknown>[] = [{ ts: requestedAt, run_id: "DAEMON-1", task_id: "DAEMON",
        step: nativeState === "refused" ? "console.kick_refused" : "console.kick_dispatched",
        lane: "daemon", task: "W9-T1", origin, repo: "wreckterra" }];
      if (["running", "silent", "ended"].includes(nativeState)) rows.push({ ts: requestedAt, run_id: runId,
        task_id: "W9-T1", step: "run.start", lane: "run-task" });
      if (nativeState === "ended") rows.push({ ts: requestedAt, run_id: runId, task_id: "W9-T1", step: "verdict",
        lane: "run-task", verdict: "pass" });
      writeLedger(rows, { dir: state });
      if (nativeState === "silent") nowMs += DEFAULT_LIVENESS_BOUND_MS + 1;
    }
    assert.deepEqual(readTargetExecution(state, { taskId: "W9-T1", origin, repo: "wreckterra", requestedAt, nowMs }),
      ["running", "silent", "ended"].includes(nativeState) ? { state: nativeState, runId } : { state: nativeState },
      "the real ledger reader distinguishes a terminal receipt from elapsed silence");
    const next = await start("W9-T2", "build-request-0002", 3);
    assert.equal(next.ok ? undefined : next.code, second, `maxConcurrentBuilds ${allowed}, native state ${nativeState}`);
  }
});


test("W1-T10823: manual approval never substitutes for the native plan verdict", async (t) => {
  const f = wreck(t);
  f.setPage({ reviews: [{ state: "APPROVED", commit_id: REVIEWED, user: { login: "craigoley" } }] });
  f.shim.addRoute({ when: `commits/${REVIEWED}/status`, stdout: JSON.stringify({ statuses: [] }) });
  assert.equal(refusal(await f.verify()), "plan_not_approved");
  assert.ok(f.shim.calls().some((call) => call.includes(`commits/${REVIEWED}/status`)), "manual approval still reads the native verdict");
  f.shim.addRoute({ when: `commits/${REVIEWED}/status`, stdout: JSON.stringify({ statuses: [{ context: "remudero-review", state: "success", creator: { login: TRUSTED, type: "Bot" } }] }) });
  assert.ok((await f.verify()).ok);
  f.setPage({ files: [{ filename: shardPath }, { filename: "src/lib/anything.ts" }] });
  assert.equal(refusal(await f.verify()), "plan_not_approved", "approval does not broaden the plan-only protocol");
});
