// test/a-near-miss-run-branch-earns-no-credit.test.ts - W1-T3279.
//
// A head ref like run-W1-T3166-build looks task-shaped to humans, but neither dispatch nor merge
// credit reads it because the suffix is not numeric. The branch-shape gate must treat that near
// miss as a task claim only when the id is declared by the plan; ordinary branch names stay quiet.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "worker-branch-shape.mjs");

const mod = (await import(pathToFileURL(SCRIPT_PATH).href)) as {
  evaluateWorkerBranchShape: (input: {
    headRef: string | undefined;
    commitMessages: string | undefined;
    addedFiles: readonly string[];
    readFile: (path: string) => string | undefined;
    changedFiles?: readonly string[];
    declaredTaskIds?: readonly string[];
  }) => { ok: boolean; defect?: string; message: string };
  claimedTaskIds: (input: {
    commitMessages: string | undefined;
    addedFiles: readonly string[];
    readFile: (path: string) => string | undefined;
    headRef?: string | undefined;
    declaredTaskIds?: readonly string[];
  }) => string[];
};

const { claimedTaskIds, evaluateWorkerBranchShape } = mod;

const TASK_ID = "W1-T3279";
const DECLARED_TASK_IDS = [TASK_ID];
const SHARD_PATH = `plan/tasks.d/${TASK_ID}-near-miss.yaml`;
const noFile = () => undefined;

function shardYaml(id: string) {
  return `- id: ${id}\n  title: "near miss branch shape"\n  repo: remudero\n  status: queued\n`;
}

test("a head ref that names a declared task id with a non-numeric suffix is refused and names the would-be credited id", () => {
  const result = evaluateWorkerBranchShape({
    headRef: `run-${TASK_ID}-build`,
    commitMessages: "fix(gate): implement the near-miss guard\n",
    addedFiles: [],
    readFile: noFile,
    declaredTaskIds: DECLARED_TASK_IDS,
  });

  assert.equal(result.ok, false);
  assert.equal(result.defect, "unshaped-worker-branch");
  assert.match(result.message, new RegExp(TASK_ID), "the refusal names the task id the ref nearly credited");
  assert.match(result.message, /merge is credited/, "the refusal names the merge-credit consequence");
  assert.match(result.message, /make an in-flight task visible/, "the refusal names the dispatch visibility consequence");
});

test("the conforming run-<taskId>-<epochMs> shape still passes when the claim comes from the head ref", () => {
  const result = evaluateWorkerBranchShape({
    headRef: `run-${TASK_ID}-1787887966537`,
    commitMessages: "fix(gate): implement the near-miss guard\n",
    addedFiles: [],
    readFile: noFile,
    declaredTaskIds: DECLARED_TASK_IDS,
  });

  assert.equal(result.ok, true);
  assert.match(result.message, /run-<taskId>-<epochMs>/);
  assert.deepEqual(
    claimedTaskIds({
      headRef: `run-${TASK_ID}-1787887966537`,
      commitMessages: undefined,
      addedFiles: [],
      readFile: noFile,
      declaredTaskIds: DECLARED_TASK_IDS,
    }),
    [TASK_ID],
  );
});

test("a branch whose name resolves to no declared task id passes under any shape", () => {
  for (const headRef of ["run-something-else", "run-W1-T404-build", "fix/run-W1-T3279-build"]) {
    const result = evaluateWorkerBranchShape({
      headRef,
      commitMessages: "chore: unrelated work\n",
      addedFiles: [],
      readFile: noFile,
      declaredTaskIds: DECLARED_TASK_IDS,
    });

    assert.equal(result.ok, true, `${headRef}: no declared task id is claimed`);
  }
});

test("the plan-only filing exemption survives for a shard-only claim", () => {
  const result = evaluateWorkerBranchShape({
    headRef: "chore/file-a-plan-shard",
    commitMessages: "chore(plan): file a shard\n",
    addedFiles: [SHARD_PATH],
    readFile: (path) => (path === SHARD_PATH ? shardYaml(TASK_ID) : undefined),
    changedFiles: [SHARD_PATH],
    declaredTaskIds: DECLARED_TASK_IDS,
  });

  assert.equal(result.ok, true);
  assert.match(result.message, /plan-only diff/);
  assert.match(result.message, /exempt from the run-<taskId>-<epochMs> shape check/);
});
