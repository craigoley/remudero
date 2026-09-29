// test/a-ci-lesson-is-its-gate.test.ts — the CI-learning rung keyed idempotency on
// `ci-learning:<first PR in the window>:<gate>`. The first PR changes every window, so one gate's
// lesson was re-filed under a new number each time: 49 machine-filed lessons covered 9 gates, and
// 39 of them were withdrawn by hand as duplicates (plan/tasks.d, 2026-09-29).
import assert from "node:assert/strict";
import test from "node:test";

import { ciLearningGateOf, mintCiLearningShards } from "../src/lib/measurement-cadence.js";
import type { CiFailureCorpus, CiFailurePair } from "../src/lib/ci-failure-corpus.js";

const pair = (pr: number, gate: string): CiFailurePair => ({
  redSha: `red-${pr}`,
  greenSha: `green-${pr}`,
  pr,
  gate,
  state: "repaired",
  repairFiles: ["src/lib/x.ts"],
});

const corpus = (pairs: CiFailurePair[]): CiFailureCorpus => ({
  status: "populated",
  prsScanned: pairs.length,
  unreadableShas: [],
  fullyObservedGatePrs: [],
  pairs,
});

test("a gate that already has a filed lesson is not re-filed under a newer pull request", () => {
  // The real pair: W1-T3589 holds ci-learning:5289:ci-gate, and the next window re-filed the same
  // gate as W1-T3827 under ci-learning:6058:ci-gate.
  const window = corpus([pair(6058, "ci-gate"), pair(6060, "ci-gate"), pair(6061, "commitlint")]);
  const r = mintCiLearningShards(window, ["ci-learning:5289:ci-gate"]);
  assert.deepEqual(
    r.drafts.map((d) => d.gate),
    ["commitlint"],
    "the held gate is not drafted again and the new gate still is",
  );
  assert.deepEqual(r.excludedFindings, [], "a held gate is not a ceiling exclusion either");
});

test("a gate with no filed lesson is still drafted when other origins are held", () => {
  const r = mintCiLearningShards(corpus([pair(7204, "commitlint"), pair(7205, "commitlint")]), [
    "operator-session#ci-learning-repair-2026-09-10",
    "ci-learning:5318:coverage-ratchet",
  ]);
  assert.equal(r.drafts.length, 1);
  assert.equal(r.drafts[0].findingId, "ci-learning:7204:commitlint");
  assert.equal(r.status, "backlog");
});

test("the gate is read back from a lesson id and nothing else", () => {
  assert.equal(ciLearningGateOf("ci-learning:5318:coverage-shard (4/4)"), "coverage-shard (4/4)");
  assert.equal(ciLearningGateOf("ci-learning:5289:ci-gate"), "ci-gate");
  assert.equal(ciLearningGateOf("operator-session#ci-learning-repair-2026-09-10"), undefined);
  assert.equal(ciLearningGateOf("ci-learning:ci-gate"), undefined);
});
