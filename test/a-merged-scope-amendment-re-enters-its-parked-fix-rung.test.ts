// test/a-merged-scope-amendment-re-enters-its-parked-fix-rung.test.ts
//
// LIVE 2026-10-09: #10300's ci-log fix round asked for a scope amendment, opened #10308 and ended
// `fix.done subtype scope_amendment_pending`. #10308 merged at 10:22Z, yet every later sweep stood
// #10300 down with "fix already dispatched for this head — awaiting its outcome", because
// `fixRungStalledWithoutNewHead` never counted a parked amendment as ended. The rung was never
// re-entered, so its pending-scope branch never asked GitHub to update the PR branch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixRungStalledWithoutNewHead } from "../src/lib/sweep.js";

const TASK = "W1-T5791";
const HEAD = "5898c3b12a9cc79fc39176fd51acec6c814d9c9a";
const AMENDMENT = 10308;

function parkedRound(): Array<Record<string, unknown>> {
  return [
    { task_id: TASK, step: "fix.dispatch", mode: "ci-log", head_sha: HEAD, strike: 1 },
    { task_id: TASK, step: "fix.scope_amendment", kind: "scope_amendment", pr_number: 10300,
      identity_key: `scope:${TASK}:10300:26463da4b275277bb4dd`, amendment_url: `https://github.com/o/r/pull/${AMENDMENT}`,
      amendment_number: AMENDMENT },
    { task_id: TASK, step: "fix.scope_amendment", outcome: "created", kind: "created", amendmentNumber: AMENDMENT,
      paths: ["src/lib/open-prs-rest.ts"], head_sha: HEAD, pr_number: 10300 },
    { task_id: TASK, step: "fix.done", head_sha: HEAD, subtype: "scope_amendment_pending", fix_outcome: "NEEDS_SCOPE" },
  ];
}

function terminal(prNumber: number, state: "merged" | "closed"): Record<string, unknown> {
  return { task_id: "SWEEP", step: "pr.terminal", pr_url: `https://github.com/o/r/pull/${prNumber}`, pr_number: prNumber, state };
}

test("a rung parked on its scope amendment re-enters once that amendment merges", () => {
  assert.equal(fixRungStalledWithoutNewHead([...parkedRound(), terminal(AMENDMENT, "merged")], TASK), true);
});

test("a rung parked on a still-open scope amendment stays parked", () => {
  assert.equal(fixRungStalledWithoutNewHead(parkedRound(), TASK), false);
  assert.equal(fixRungStalledWithoutNewHead([...parkedRound(), terminal(AMENDMENT + 1, "merged")], TASK), false);
});

test("a later fix dispatch supersedes the parked amendment", () => {
  const lines = [...parkedRound(), { task_id: TASK, step: "fix.dispatch", mode: "ci-log", head_sha: "f00d", strike: 1 },
    terminal(AMENDMENT, "merged")];
  assert.equal(fixRungStalledWithoutNewHead(lines, TASK), false);
});
