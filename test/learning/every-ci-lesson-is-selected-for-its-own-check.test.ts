// W1-T14140 — EVERY ACTIVE CI LESSON IS SELECTED FOR ITS OWN CHECK. A lesson drafted from a failing check is worth
// carrying only if a round that fails THAT check is handed it; the lesson's id being present in a file proves nothing
// about reach. MEASURED 2026-11-21 at origin/main 17e986698: of 25 active ci-learning entries, selectLearnings picked
// 2 for a context naming their own gate — the two whose error_signatures held the gate exactly.
//
// One test per ACTIVE ci-learning entry (an entry whose `src:` is a `ci-learning:<pr>:<gate>` finding id), generated
// from the real corpus at load time, so a lesson a machine shard adds later is proved by the very title its shard
// template names (`unit test: ci lesson <findingId> is selected for its own check`, ciLearningShardYaml). A
// superseded entry gets no test: selectLearnings drops every non-active entry before matching, so it is never injected.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS, learningsSourceFiles, loadLearningsCorpus, selectLearnings } from "#src/lib/learnings.js";
import { ciLearningGateOf } from "#src/lib/measurement-cadence.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const LEARNINGS_DIR = join(REPO_ROOT, "learnings");
const corpus = loadLearningsCorpus(LEARNINGS_DIR);
const lessons = corpus.flatMap((entry) => {
  const gate = entry.lifecycle === "active" ? ciLearningGateOf(entry.src) : undefined;
  return gate === undefined ? [] : [{ entry, gate }];
});

test("W1-T14140: the generated suite reads the ci-learning corpus it generates its tests from", () => {
  // POSITIVE CONTROL: a corpus read that found no lesson would generate no per-entry test and pass vacuously.
  const shards = learningsSourceFiles(LEARNINGS_DIR).map((f) => f.filename);
  assert.ok(shards.includes("ci.yaml"), `learnings/ci.yaml was not read: ${shards.join(", ")}`);
  assert.ok(lessons.length > 0, "no active ci-learning entry was read, so no per-entry test was generated");
});

for (const { entry, gate } of lessons) {
  test(`ci lesson ${entry.src} is selected for its own check`, () => {
    const { selected } = selectLearnings(corpus, undefined, DEFAULT_KNOWLEDGE_BUDGET_CHARS, { text: gate });
    assert.ok(
      selected.some((s) => s.id === entry.id),
      `${entry.id} is not selected for a round failing "${gate}"; its error_signatures are ` +
        `${JSON.stringify(entry.errorSignatures ?? [])} — add the check name exactly as it reads: error_signatures: [${JSON.stringify(gate)}]`,
    );
  });
}
