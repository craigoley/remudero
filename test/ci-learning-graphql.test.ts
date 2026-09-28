import assert from "node:assert/strict";
import test from "node:test";

import { collectCiFailureCorpus } from "../src/lib/ci-failure-corpus.js";
import { readCiPrGraphql } from "../src/lib/ci-learning-graphql.js";

function page(sha: string, contexts: unknown, hasNextPage = false, endCursor: string | null = null): unknown {
  return { data: { repository: { pullRequest: { commits: {
    nodes: [{ commit: { oid: sha, statusCheckRollup: { contexts: { nodes: contexts, pageInfo: { hasNextPage: false } } } } }],
    pageInfo: { hasNextPage, endCursor },
  } } } } };
}

test("CI learning batches commit gates without losing red-to-green pairs or status contexts", async () => {
  const requests: string[][] = [];
  const red = page("red", [
    { __typename: "CheckRun", name: "ci-gate", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-27T00:00:00Z" },
    { __typename: "StatusContext", context: "remudero-review", state: "FAILURE", createdAt: "2026-09-27T00:00:01Z" },
  ], true, "cursor-1");
  const green = page("green", [
    { __typename: "CheckRun", name: "ci-gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-28T00:00:00Z" },
    { __typename: "StatusContext", context: "remudero-review", state: "SUCCESS", createdAt: "2026-09-28T00:00:01Z" },
  ]);
  const commits = await readCiPrGraphql("acme", "repo", 7, async (args) => {
    requests.push(args);
    return requests.length === 1 ? red : green;
  });
  assert.equal(requests.length, 2, "one request per commit page, including both gate types");
  assert.ok(requests[1]?.includes("after=cursor-1"), "the second page advances the cursor");
  assert.deepEqual(commits.map((commit) => commit.sha), ["red", "green"], "PR order is retained for pairing");
  assert.deepEqual(
    collectCiFailureCorpus({ prs: [{ number: 7, commits }] }).pairs.map((pair) => [pair.gate, pair.state, pair.greenSha]),
    [["ci-gate", "repaired", "green"], ["remudero-review", "repaired", "green"]],
  );
});

test("CI learning treats truncated or malformed GraphQL evidence as unreadable", async () => {
  const truncated = page("head", [{ __typename: "CheckRun", name: "ci-gate", status: "COMPLETED", conclusion: "SUCCESS" }]) as {
    data: { repository: { pullRequest: { commits: { nodes: Array<{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: boolean } } } } }> } } } };
  };
  truncated.data.repository.pullRequest.commits.nodes[0]!.commit.statusCheckRollup.contexts.pageInfo.hasNextPage = true;
  const commits = await readCiPrGraphql("acme", "repo", 8, async () => truncated);
  assert.equal(commits[0]?.rollup, undefined, "an unseen context page cannot certify a green gate");
  assert.equal(collectCiFailureCorpus({ prs: [{ number: 8, commits }] }).status, "unreadable");
  await assert.rejects(readCiPrGraphql("acme", "repo", 8, async () => ({ errors: [{ message: "denied" }] })), /GraphQL errors/);
  await assert.rejects(readCiPrGraphql("acme", "repo", 8, async () => page("head", [], true, null)), /cursor unreadable/);
});
