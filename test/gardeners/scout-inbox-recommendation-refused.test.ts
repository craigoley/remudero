import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readRecommendationStore,
  recommendationStorePath,
  startRecommendationBackfill,
  type RecommendationBackfill,
} from "#src/lib/inbox-recommendation.js";
import { withTempDir } from "#src/lib/tmp.js";

test("W1-T10229: a previously refused fingerprint is retried after an intervening refusal", async () => {
  await withTempDir("scout-inbox-recommendation-refused", async (stateDir) => {
    const id = "machine-judge:W1-T5418";
    const originalSummary = "A parked fix is waiting for a ruling.";
    let summary = originalSummary;
    let writerCalls = 0;
    const events: Array<{ step: string; details?: Record<string, unknown> }> = [];
    const deps: RecommendationBackfill = {
      stateDir,
      readProposals: () => [{ id, summary }],
      readLanes: () => ({ [id]: "ready" }),
      evidence: {
        shards: async () => new Map(),
        shardText: async () => undefined,
        taskHistory: async () => [],
        resolve: async () => undefined,
      },
      summarize: async () => {
        writerCalls += 1;
        return {
          action: "approve",
          why: "The fix already landed.",
          evidence: ["#999999"],
          obsolete: true,
        };
      },
    };
    async function runPass(): Promise<void> {
      const pump = startRecommendationBackfill(deps, 60_000, (step, details) => events.push({ step, details }));
      pump.stop();
      await pump.settled();
    }
    const refusal = { step: "inbox.recommendation_refused", details: { count: 1 } };

    await runPass();
    assert.equal(writerCalls, 2);
    assert.deepEqual(events, [refusal]);

    await runPass();
    assert.equal(writerCalls, 2, "the unchanged fingerprint is skipped");
    assert.deepEqual(events, [refusal]);

    summary = `${originalSummary} Its review was reopened.`;
    await runPass();
    assert.equal(writerCalls, 4);
    assert.deepEqual(events, [refusal, refusal]);

    summary = originalSummary;
    await runPass();
    assert.equal(writerCalls, 6, "the intervening refusal displaced the original fingerprint");
    assert.deepEqual(events, [refusal, refusal, refusal]);
    assert.deepEqual(readRecommendationStore(recommendationStorePath(stateDir)), {});
  });
});
