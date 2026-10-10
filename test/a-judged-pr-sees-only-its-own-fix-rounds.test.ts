import assert from "node:assert/strict";
import { test } from "node:test";

import * as judge from "../src/lib/fix-progress-judge.js";

const url = (pr: number) => `https://github.com/craigoley/remudero/pull/${pr}`;
const round = (pr: number, id: string, head: string) => [
  { step: "fix.dispatch", task_id: "unfiled", repair_pr_url: url(pr), round_id: id, head_sha: head, ci_failures: [{ check: "ci" }] },
  { step: "fix.done", task_id: "unfiled", repair_pr_url: url(pr), round_id: id, head_sha: head, pushed_head_sha: `${head}-next` },
];

test("run-unfiled PRs sharing task id unfiled are judged on their own fix rounds only", () => {
  const ledger = [...round(10555, "a", "h1"), ...round(10552, "b", "h2"), ...round(10550, "c", "h3"),
    ...round(10555, "d", "h4"), ...round(10551, "e", "h5")];
  const input = judge.buildFixProgressInput({ taskId: "unfiled", prNumber: 10555, headSha: "h4",
    currentRed: ["ci"], ledger });
  assert.deepEqual(input.rounds.map(r => r.id), ["a", "d"]);
});

test("a fix row naming its PR only by repair_pr_url is never counted for another PR", () => {
  const input = judge.buildFixProgressInput({ taskId: "unfiled", prNumber: 10552, headSha: "h9",
    currentRed: ["ci"], ledger: round(10555, "x", "h8") });
  assert.equal(input.rounds.length, 0);
});
