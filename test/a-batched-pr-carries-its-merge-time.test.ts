import assert from "node:assert/strict";
import { test } from "node:test";
import { mapBoardPr, type RestPullRow } from "../src/lib/open-prs-rest.js";
import { shippedSince, type ShippedGithub, type RunSummary } from "../src/lib/retro.js";
import { buildBatchedGithub } from "../src/lib/status.js";

const TASK = "W1-T5791";
const RUN = `${TASK}-1`;
const URL = "https://github.com/o/r/pull/12";
const MARKER = "2026-10-05T02:00:00Z";
const COMMIT_TIME = "2026-10-05T03:00:00Z";
const MERGE_TIME = "2026-10-05T03:00:01Z";
const ROW: RestPullRow = {
  number: 12,
  html_url: URL,
  state: "closed",
  merged: true,
  merged_at: MERGE_TIME,
  updated_at: MERGE_TIME,
  head: { ref: `run-${RUN}`, sha: "sha12" },
  body: `Remudero-Task: ${TASK}`,
};
const RUNS: RunSummary[] = [{
  runId: RUN,
  taskId: TASK,
  type: "implement",
  startTs: "2026-10-05T01:00:00Z",
  verdict: "blocked_ci",
  costUsd: 1,
  numTurns: 1,
}];

function boardExec(row: RestPullRow, calls: string[][]) {
  return (args: string[]): string => {
    calls.push(args);
    assert.equal(args[0], "api");
    assert.match(args[1], /^repos\/o\/r\/pulls\?state=(open|closed)&/);
    return JSON.stringify(args[1].includes("state=closed&") ? [row] : []);
  };
}

function withCommitDate(github: ShippedGithub): ShippedGithub {
  return {
    ...github,
    unavailable: () => undefined,
    mergedCommits: () => [{ date: COMMIT_TIME, message: `feat: shipped (#12)\n\nRemudero-Task: ${TASK}` }],
  };
}

test("a batched trailer hit carries the REST merge timestamp without another PR read", () => {
  const calls: string[][] = [];
  const github = buildBatchedGithub("o", "r", { exec: boardExec(ROW, calls) });
  assert.equal(github.findMergedByTrailer(TASK)?.mergedAt, MERGE_TIME);
  assert.equal(github.findMergedByTrailerAll?.(TASK)?.[0]?.mergedAt, MERGE_TIME);
  assert.equal(github.prByRef(URL)?.mergedAt, MERGE_TIME);
  assert.equal(calls.length, 2, "one open page and one closed page, reused by every lookup");
});

test("test/a-batched-pr-carries-its-merge-time.test.ts", () => {
  // The retro gateway forwards `findMergedByTrailer` straight to `buildBatchedGithub` (retroShippedGithubGateway),
  // so this composes the same batched gateway rather than importing run-task (the reach ratchet's importer bound).
  for (const mergedAt of [MERGE_TIME, undefined, null, MARKER]) {
    const calls: string[][] = [];
    const row = { ...ROW, merged_at: mergedAt };
    const batched = buildBatchedGithub("o", "r", { exec: boardExec(row, calls) });
    const github = withCommitDate({
      findMergedByTrailer: (taskId) => batched.findMergedByTrailer(taskId),
      headRefName: (prUrl) => batched.headRefName(prUrl),
    });
    const result = shippedSince(RUNS, MARKER, github);
    if (mergedAt === MARKER) {
      assert.equal(result.shipped.length, 0, "GitHub's marker-time merge overrides the later commit date");
    } else {
      assert.equal(result.shipped.length, 1);
      assert.equal(result.shipped[0].source, "github");
      assert.equal(result.shipped[0].mergeTs, mergedAt ?? COMMIT_TIME);
    }
    assert.equal(calls.length, 2, "the sync retro uses the board walk without per-PR reads");
  }
});

test("the board mapper leaves null and absent merge timestamps omitted", () => {
  for (const mergedAt of [undefined, null]) {
    const row = mapBoardPr({ ...ROW, merged_at: mergedAt });
    assert.equal("mergedAt" in row, false);
  }
  assert.equal(mapBoardPr(ROW).mergedAt, MERGE_TIME);
});
