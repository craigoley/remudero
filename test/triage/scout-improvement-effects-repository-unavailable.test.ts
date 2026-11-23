import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { improvementOutcomeStateDir, reconcileManagedImprovementEffects, type OpportunityOutcome } from "#src/lib/opportunity-outcomes.js";
import { withTempDir } from "#src/lib/tmp.js";

function setupScope(root: string) {
  const repository = "acme/core", instance = "core";
  const stateDir = join(root, "state"), controlRoot = join(root, "native");
  const planPath = join(controlRoot, "tasks.yaml"), registry = join(controlRoot, "state", "inbox-proposals.json");
  mkdirSync(join(controlRoot, "state"), { recursive: true });
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(planPath, "[]\n");
  writeFileSync(join(stateDir, "read-model", "repositories-sources.json"), JSON.stringify({
    instances: [{ instanceId: instance, options: { controlRoot, planPath } }],
    improvementEvidence: {
      version: "repository-evidence-inventory-v1", measurementState: "not_collected",
      repositories: [{
        repository, instanceIds: [instance], expectedDailySources: ["pull_requests", "ledger_activity", "deployments"],
        expectedQualitySources: ["quality", "coverage"],
      }],
      unresolvedInstances: [],
    },
  }));
  const events: Array<{ step: string; error: unknown }> = [];
  return {
    repository, instance, registry, events,
    projection: join(improvementOutcomeStateDir(stateDir, repository, instance), "opportunity-outcomes.json"),
    run: () => reconcileManagedImprovementEffects({
      stateDir, repoRoot: root, repository,
      log: (step, fields) => events.push({ step, error: fields?.error }),
      fetch: () => assert.fail("a conversation without filed tasks needs no GitHub evidence"),
    }),
  };
}

test("W1-T12429: improvement_effects.repository_unavailable no longer recurs", async () => {
  await withTempDir("scout-improvement-effects", async root => {
    const scope = setupScope(root), proposalId = "improvement:saved", threadId = "thread:improvement:saved";
    const proposals = Array.from({ length: 2342 }, (_, index) => ({
      id: `P${index}`, summary: "ordinary Inbox proposal ".repeat(43), evidenceAnchors: [],
    }));
    const registry = JSON.stringify({ proposals: [...proposals, {
      id: proposalId, summary: "Check the targeted findings", evidenceAnchors: [],
      improvement: {
        version: "improvement-thread-v1", repository: scope.repository, instance: scope.instance,
        opportunityId: `${scope.repository}/codeql-quality:example-check`,
        snapshotId: "a".repeat(64), requestId: "b".repeat(64), goalDigest: "c".repeat(64), threadId, conversationReady: true,
      },
    }] }, null, 2);
    assert(Buffer.byteLength(registry) >= 2_448_321, "fixture reaches the production size recorded in W1-T13202");
    writeFileSync(scope.registry, registry);

    assert.deepEqual(await scope.run(), { state: "reported", expectedScopes: 1, publishedScopes: 1 }, JSON.stringify(scope.events));
    const outcomes: OpportunityOutcome[] = JSON.parse(readFileSync(scope.projection, "utf8"));
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.proposalId, proposalId);
    assert.equal(outcomes[0]?.improvement?.threadId, threadId);
    assert.equal(outcomes[0]?.effect?.stage, "conversation_saved");
    assert.equal(scope.events.some(event => event.step === "improvement_effects.repository_unavailable"), false);
  });
});

test("managed follow-up still reports a registry above the Inbox read bound as unavailable", async () => {
  await withTempDir("scout-improvement-effects-oversized", async root => {
    const scope = setupScope(root);
    writeFileSync(scope.registry, '{"proposals":[]}');
    truncateSync(scope.registry, 8 * 1024 * 1024 + 1);

    assert.deepEqual(await scope.run(), { state: "partial", expectedScopes: 1, publishedScopes: 0 });
    assert.equal(scope.events[0]?.step, "improvement_effects.repository_unavailable");
    assert.match(String(scope.events[0]?.error), /oversized/);
    assert.equal(existsSync(scope.projection), false);
  });
});
