import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhAsyncExecutor } from "../src/lib/github-transport.js";
import { ShippedReadPending, type ShippedGithub } from "../src/lib/retro.js";
import { retroShippedGithubGateway, retroShippedGithubGatewayAsync } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const OWNER_REPO = { owner: "o", repo: "r" };
const TASK_ID = "W1-T5792";
const PROOF = "test/the-awaited-retro-gateway-falls-back-to-commit-trailers.test.ts";

async function findMerged(github: ShippedGithub, taskId: string) {
  for (let reads = 0; reads < 10; reads += 1) {
    try {
      return github.findMergedByTrailer(taskId);
    } catch (error) {
      if (!(error instanceof ShippedReadPending)) throw error;
      await error.load();
    }
  }
  assert.fail("the awaited gateway did not finish loading its board and commit reads");
}

test(`${PROOF}: a body miss returns the newest anchored commit's squash pr`, async () => {
  const repo = gitRepo({ kind: "retro-trailer-fallback" });
  repo.addRemote("origin", "https://github.com/o/r.git");
  repo.git("commit", "--allow-empty", "-m", "fix: older (#11)", "-m", `Remudero-Task: ${TASK_ID}`);
  repo.git("commit", "--allow-empty", "-m", "fix: newest (#12)", "-m", `details\n\nRemudero-Task:\t${TASK_ID}\t`);
  repo.git("commit", "--allow-empty", "-m", "fix: inline decoy (#13)", "-m", `mentions Remudero-Task: ${TASK_ID}`);
  repo.git("commit", "--allow-empty", "-m", "fix: longer id (#14)", "-m", `Remudero-Task: ${TASK_ID}0`);
  repo.git("commit", "--allow-empty", "-m", "fix: no squash number", "-m", `Remudero-Task: ${TASK_ID}`);
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const calls: string[][] = [];
  const execAsync = (async (_file, args) => {
    calls.push([...args]);
    assert.equal(args[0], "api");
    assert.match(args[1], /^repos\/o\/r\/pulls\?/);
    return { stdout: "[]", stderr: "" };
  }) as GhAsyncExecutor;
  try {
    const github = await retroShippedGithubGatewayAsync({ ownerRepo: OWNER_REPO, execAsync, commitCwd: repo.dir });
    const actual = await findMerged(github, TASK_ID);
    assert.deepEqual(actual, { number: 12, url: "https://github.com/o/r/pull/12", state: "merged" });
    const sync = retroShippedGithubGateway({ ownerRepo: OWNER_REPO, exec: () => "[]", commitCwd: repo.dir });
    assert.deepEqual(actual, sync.findMergedByTrailer(TASK_ID));
    assert.equal(calls.length, 2, "both board halves were read before the commit fallback");
    assert.ok(calls.some((args) => args[1].includes("state=open&")));
    assert.ok(calls.some((args) => args[1].includes("state=closed&")));
    assert.equal(await findMerged(github, "W1-T5793"), null, "neither surface carries this task");
    assert.equal(sync.findMergedByTrailer("W1-T5793"), null);
    assert.equal(calls.length, 2, "a second lookup reuses the board reads");
  } finally {
    repo.cleanup();
  }
});

test(`${PROOF}: with neither a body hit nor an anchored commit trailer the gateway returns null`, async () => {
  const repo = gitRepo({ kind: "retro-trailer-miss" });
  repo.addRemote("origin", "https://github.com/o/r.git");
  repo.git("commit", "--allow-empty", "-m", "fix: inline only (#21)", "-m", `mentions Remudero-Task: ${TASK_ID}`);
  repo.git("commit", "--allow-empty", "-m", "fix: suffix only (#22)", "-m", `Remudero-Task: ${TASK_ID}0`);
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const execAsync = (async () => ({ stdout: "[]", stderr: "" })) as GhAsyncExecutor;
  try {
    const github = await retroShippedGithubGatewayAsync({ ownerRepo: OWNER_REPO, execAsync, commitCwd: repo.dir });
    const actual = await findMerged(github, TASK_ID);
    assert.equal(actual, null);
    const sync = retroShippedGithubGateway({ ownerRepo: OWNER_REPO, exec: () => "[]", commitCwd: repo.dir });
    assert.equal(sync.findMergedByTrailer(TASK_ID), null);
  } finally {
    repo.cleanup();
  }
});
