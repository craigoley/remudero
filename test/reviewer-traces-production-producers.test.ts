import assert from "node:assert/strict";
import test from "node:test";

import { buildReviewPrompt } from "../src/lib/review.js";

test("semantic review traces new inputs to a production producer instead of accepting fixture-only wiring", () => {
  const prompt = buildReviewPrompt({
    task: {
      id: "W1-T9000",
      acceptance: [
        {
          claim: "subscription routing uses live window share",
          proof: "grep: routingObjectiveFor( in src/lib/mount-recommender.ts",
        },
      ],
    },
    prUrl: "https://github.com/craigoley/remudero/pull/9000",
    owner: "craigoley",
    repo: "remudero",
    headSha: "9000deadbeef",
  });

  assert.match(prompt, /trace (?:each|the) new input backwards through the production caller/i);
  assert.match(prompt, /test fixtures?[\s\S]*no production producer[\s\S]*FAILURE/i);
  assert.match(prompt, /always takes? a fallback[\s\S]*FAILURE/i);
  assert.match(prompt, /grep[\s\S]*call site[\s\S]*not proof[\s\S]*runtime value/i);
});
