import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { withTempDir } from "#src/lib/tmp.js";
import { inboxThreadId } from "#src/lib/inbox-thread.js";
import { readCodeHealthInventory, readCodeHealthRelatedWork } from "#src/lib/code-health-view.js";
import * as store from "#src/lib/code-health-store.js";

function roster(dir: string) {
  const repository = "acme/atlas", instance = "atlas", root = join(dir, "atlas"); mkdirSync(join(root, "state"), { recursive: true }); mkdirSync(join(dir, "read-model"));
  writeFileSync(join(dir, "read-model", "repositories-sources.json"), JSON.stringify({ instances: [{ instanceId: instance, options: { controlRoot: root, ledgerPath: join(root, "state", "ledger.ndjson") } }], improvementEvidence: { version: "repository-evidence-inventory-v1", measurementState: "not_collected", repositories: [{ repository, instanceIds: [instance], expectedDailySources: ["pull_requests", "ledger_activity", "deployments"], expectedQualitySources: ["quality", "coverage"] }], unresolvedInstances: [] } }));
  return { repository, instance, root, inventory: readCodeHealthInventory(dir) };
}

test("code health related work links the native saved conversation without inventing its freshness", async () => {
  await withTempDir("code-health-chat-links", dir => {
    const { repository, instance, root, inventory } = roster(dir), proposalId = "codeql-quality:quality-rule";
    const id = `improvement:${createHash("sha256").update(JSON.stringify([repository, instance, proposalId])).digest("hex")}`, threadId = inboxThreadId(id);
    const row = { id, summary: "A saved planning conversation", evidenceAnchors: [], improvement: { version: "improvement-thread-v1", repository, instance, opportunityId: `${repository}/${proposalId}`, snapshotId: "a".repeat(64), requestId: "b".repeat(64), goalDigest: "c".repeat(64), conversationReady: true, threadId } };
    const path = join(root, "state", "inbox-proposals.json"); writeFileSync(path, JSON.stringify({ proposals: [row] }));
    const read = () => readCodeHealthRelatedWork(dir, inventory, repository, Date.parse("2026-11-02T12:00:00.000Z"));
    const result = read(); assert.deepEqual(result.work, [{ repository, proposalId, threadId }]); assert.equal(result.asOf, null, "a file read or mtime is not a saved conversation timestamp");
    writeFileSync(path, JSON.stringify({ proposals: [{ ...row, improvement: { ...row.improvement, repository: "acme/foreign" } }] })); assert.equal(read().work.length, 0);
    writeFileSync(path, JSON.stringify({ proposals: [{ ...row, improvement: { ...row.improvement, conversationReady: false } }] })); assert.equal(read().work.length, 0);
    writeFileSync(path, "{broken"); assert.notEqual(read().state, "reported");
  });
});

test("code health related work joins isolated improvement outcomes to the original finding", async () => {
  await withTempDir("code-health-effect-links", dir => {
    const { repository, instance, inventory } = roster(dir), proposalId = "codeql-quality:quality-rule", now = "2026-11-02T12:00:00.000Z";
    const locate = (store as unknown as { improvementOutcomeStateDir?: (state: string, repo: string, instance: string) => string }).improvementOutcomeStateDir;
    assert.equal(typeof locate, "function", "the producer and consumer need one scoped outcome namespace"); assert(locate);
    const target = locate(dir, repository, instance); mkdirSync(target, { recursive: true });
    const source = { repository, opportunityId: `${repository}/${proposalId}`, threadId: "thread:improvement:one", snapshotId: "a".repeat(64), taskIds: ["W1-T7", "W1-T8"] };
    writeFileSync(join(target, "opportunity-outcomes.json"), JSON.stringify([{ key: `${repository}/improvement:one`, proposalId: "improvement:one", sourceIds: [source.snapshotId], candidate: { repo: repository, key: "improvement:one", observedAt: now }, at: now, state: "merged", improvement: source, task: { repo: repository, key: "improvement:one", id: "W1-T7" }, pr: { repo: repository, taskId: "W1-T7", url: `https://github.com/${repository}/pull/7` } }]));
    const result = readCodeHealthRelatedWork(dir, inventory, repository, Date.parse(now));
    assert(result.work.some(row => row.proposalId === proposalId && row.threadId === source.threadId && row.taskId === "W1-T7" && row.prUrl?.endsWith("/pull/7")));
    assert(result.work.some(row => row.proposalId === proposalId && row.taskId === "W1-T8"));
    assert(!result.work.some(row => row.proposalId === "improvement:one"), "the finding group is the join key; the planning proposal is separate");
    assert.notEqual(locate(dir, repository, instance), locate(dir, repository, "another-instance"));
    assert.throws(() => locate(dir, repository, "../other"));
  });
});


test("code health refuses contradictory configured source expectations", async () => {
  await withTempDir("code-health-inventory-contract", dir => {
    const configured = roster(dir); assert.equal(configured.inventory.repositories.length, 1);
    const path = join(dir, "read-model", "repositories-sources.json"), valid = JSON.parse(readFileSync(path, "utf8"));
    for (const mutate of [
      (value: typeof valid) => { value.improvementEvidence.measurementState = "measured"; },
      (value: typeof valid) => { value.improvementEvidence.repositories[0].expectedDailySources = []; },
      (value: typeof valid) => { value.improvementEvidence.repositories.push({ ...value.improvementEvidence.repositories[0], repository: "acme/foreign" }); },
    ]) {
      const changed = structuredClone(valid); mutate(changed); writeFileSync(path, JSON.stringify(changed));
      assert.throws(() => readCodeHealthInventory(dir), /configured repository list/, "an invalid scope must not publish another portfolio");
    }
  });
});
