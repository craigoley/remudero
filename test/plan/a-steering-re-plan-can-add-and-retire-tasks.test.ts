import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { planArchitectPrompt } from "#src/lib/plan-architect.js";
import { bootstrapConfirmed } from "#src/lib/product-build.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import {
  PRODUCT_STEER_REFERENCE_PREFIX, productPlanModeFor, ProductPlanOperationService, unansweredSteerNotes,
  type PlanHandoffOutcome, type PlanRepository, type PlanTargetPort,
} from "#src/lib/product-plan-operation.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const actor = "clerk:alice";
const HEAD = "a".repeat(40);
const ID = 1432832754;
const REQUESTED = "2026-11-24T16:30:00.000Z";
const identity = { provider: "github", id: ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public", verifiedAt: "2026-10-26T00:00:00.000Z" } as const;
const envelope = { budgetUsd: 30, maxConcurrentBuilds: 1, existingSetupOnly: true };
const steer = (value: string, at: string) => ({ key: `Direction ${at}`, value, provenance: { kind: "operator" as const, reference: `${PRODUCT_STEER_REFERENCE_PREFIX}${at}` } });
const setup = { key: "Original identity", value: "Original vehicles only.", provenance: { kind: "operator" as const } };

class Target implements PlanTargetPort {
  async inspect() { return { enrolled: true, head: HEAD, readmeOnly: false }; }
  runnerRegistered() { return true; }
}

/** A bound product on a target whose head already holds a plan shard, planned through the real service. */
async function planOnce(t: TestContext, decisions: Array<typeof setup>) {
  const root = ownedFixtureDir(t, "steer-re-plan").dir;
  const store = new ProductIntentStore({ root });
  const saved = store.write(actor, { version: "product-intent-v1", requestId: "seed-product-00001", expectedRevision: 0,
    brief: { idea: "original mobile car combat in real cities", name: "Wreckterra", decisions, resourceEnvelope: envelope } });
  assert.ok(saved.ok);
  const productId = saved.value.receipt.productId;
  assert.ok(store.transition(actor, { version: "product-intent-v1", requestId: "seed-bound-0000001", id: productId,
    expectedRevision: 1, expectedObjectiveRevision: 1, repository: identity }).ok);
  mkdirSync(join(root, "state"), { recursive: true });
  const calls: Array<{ mode: string; brief: string }> = [];
  const service = new ProductPlanOperationService({
    root, store, target: new Target(), bootstrapConfirmed, ledgerPath: join(root, "state", "ledger.ndjson"),
    provider: { async read() { return { state: "found" as const, repository: { id: ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" as const } }; } },
    text: async () => JSON.stringify([{ name: "WRECK-T1-first.yaml" }]),
    checkout: (repo: PlanRepository) => repo.name === "wreckterra" ? join(root, "repos", "wreckterra") : undefined,
    runnerConfig: async (_checkout: string, head: string) => ({ state: "present" as const, head, path: ".remudero/mounts.yaml", digest: "0".repeat(64) }),
    clock: fixedClock(Date.parse(REQUESTED)), isAlive: () => true,
    gateway: { async productPlan(call: { mode: "create" | "clarify"; brief: string }) { calls.push(call); return new Promise<{ outcome: PlanHandoffOutcome }>(() => {}); } },
  });
  const result = await service.execute(actor, { requestId: "plan-request-00001", productId, expectedRevision: 2, expectedObjectiveRevision: 1 });
  assert.ok(result.ok, JSON.stringify(result));
  return { observation: result.value.observation, calls };
}

test("W1-T14675: a brief with new operator direction plans in a mode that may add tasks", async (t) => {
  const { observation, calls } = await planOnce(t, [setup, steer("Add a start screen with a map to pick any real city.", "2026-11-24T16:05:00.000Z")]);
  assert.equal(observation.mode, "create", "a steering note on a target that has a plan plans in a mode that adds tasks");
  assert.equal(calls[0]!.mode, "create");
  assert.match(calls[0]!.brief, /^New operator direction to plan now/, "the newest direction leads the brief");
  assert.match(calls[0]!.brief, /- Add a start screen with a map to pick any real city\. \(2026-11-24T16:05:00\.000Z\)/);
  const prompt = planArchitectPrompt("create", calls[0]!.brief, "PLAN-create-1");
  assert.match(prompt, /rewrite an existing\s+task the new direction changes/, "create may rewrite a task the direction changes");
  assert.match(prompt, /Never delete a task, and never\s+write `retirement:`/, "it never deletes a task or writes an operator-only retirement");
  // The pure seam: a produced plan observed after the note answers it; a queued or failed one does not.
  const brief = { idea: "i", decisions: [steer("map picker", "2026-11-24T16:05:00.000Z")] };
  const plan = (outcome: "proposed" | "succeeded" | "queued" | "failed", observedAt: string) =>
    ({ id: "pplan-x", stage: "plan" as const, outcome, objectiveRevision: 1, observedAt, references: [] });
  assert.equal(productPlanModeFor({ brief, stageEvidence: [plan("queued", "2026-11-24T16:06:00.000Z"), plan("failed", "2026-11-24T16:07:00.000Z")] }, true), "create");
  assert.equal(productPlanModeFor({ brief, stageEvidence: [plan("succeeded", "2026-11-24T15:00:00.000Z")] }, true), "create", "a plan from before the note answers nothing");
  assert.equal(productPlanModeFor({ brief: { idea: "i", decisions: [{ ...setup, provenance: { kind: "research", reference: `${PRODUCT_STEER_REFERENCE_PREFIX}2026-11-24T16:05:00.000Z` } }] }, stageEvidence: [] }, true), "clarify", "only operator provenance steers");
  assert.equal(productPlanModeFor({ brief: { idea: "i", decisions: [steer("x", "not a time")] }, stageEvidence: [] }, true), "clarify", "an unreadable note time never steers");
});

test("W1-T14675: a brief with no new operator direction still plans in clarify mode", async (t) => {
  const { observation, calls } = await planOnce(t, [setup]);
  assert.equal(observation.mode, "clarify", "a target with a plan and no steering note is reconciled, not re-created");
  assert.doesNotMatch(calls[0]!.brief, /New operator direction/);
  const brief = { idea: "i", decisions: [steer("map picker", "2026-11-24T16:05:00.000Z")] };
  const answered = { brief, stageEvidence: [{ id: "pplan-y", stage: "plan" as const, outcome: "proposed" as const, objectiveRevision: 1, observedAt: "2026-11-24T16:10:00.000Z", references: [] }] };
  assert.deepEqual(unansweredSteerNotes(answered), [], "a plan produced after the note answers it");
  assert.equal(productPlanModeFor(answered, true), "clarify");
  assert.equal(productPlanModeFor(answered, false), "create", "a target with no plan is still created");
});
