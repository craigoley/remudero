import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startRecommendationBackfill, type RecommendationEvidence } from "#src/lib/inbox-recommendation.js";

test("W1-T10229: inbox.recommendation_refused no longer recurs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-scout-recommendation-refused-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });

  const proposal = { id: "machine-judge:W1-T5418", summary: "A parked decision needs review." };
  const evidence: RecommendationEvidence = {
    shards: async () => new Map(),
    shardText: async () => undefined,
    taskHistory: async () => [],
    resolve: async () => undefined,
  };
  let asks = 0;
  const events: string[] = [];
  const worker = startRecommendationBackfill({
    stateDir,
    evidence,
    readProposals: () => [proposal],
    readLanes: () => ({ [proposal.id]: "ready" }),
    summarize: async () => {
      asks += 1;
      return null; // The two checked answers are invalid; that exact source is refused once.
    },
  }, 5, (step) => events.push(step));

  try {
    // Let several timer ticks run. A stable refusal must be recorded once, then suppressed by
    // its proposal fingerprint instead of emitting a ledger row on every tick.
    await new Promise((resolve) => setTimeout(resolve, 40));
    await worker.settled();
  } finally {
    worker.stop();
  }

  assert.equal(asks, 2, "one initial answer and one repair attempt for the unchanged proposal");
  assert.deepEqual(events, ["inbox.recommendation_refused"]);
});
