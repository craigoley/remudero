// W1-T14947 — a review holds one in-flight lock under state/inflight/reviews from its claim to its result, so a
// container recycle's drain can see it; the lock is never a task run (invariant one-lock-per-review).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { REVIEW_INFLIGHT_DIR, whileWorkerRunLive, type ReviewCommandHost } from "#src/cli/commands/review.js";
import { liveInflightRuns } from "#src/lib/report-commands.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

function host(): ReviewCommandHost {
  // whileWorkerRunLive reads only these two members of the host.
  return { liveWorkerRunIds: new Set<string>(), reviewWorkerLockId: (runId: string) => `review-${runId}` } as unknown as ReviewCommandHost;
}

function inflight(t: TestContext): { dir: string; lockPath: string } {
  const dir = join(ownedFixtureDir(t, "review-inflight-lock").dir, "inflight");
  return { dir, lockPath: join(dir, REVIEW_INFLIGHT_DIR, "review-run-a.lock") };
}

test("W1-T14947 a review holds its in-flight lock from claim to result", async (t) => {
  const { dir, lockPath } = inflight(t);
  const seen: Array<[string, boolean]> = [];
  const result = await whileWorkerRunLive(host(), "run-a", async () => {
    seen.push(["review.pending_posted", existsSync(lockPath)]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push(["review.posted", existsSync(lockPath)]);
    return "verdict";
  }, dir);
  assert.equal(result, "verdict");
  assert.deepEqual(seen, [["review.pending_posted", true], ["review.posted", true]], "held at the claim and at the result");
  assert.equal(existsSync(lockPath), false, "released once the review returns");

  await assert.rejects(whileWorkerRunLive(host(), "run-a", async () => {
    assert.equal(existsSync(lockPath), true);
    throw new Error("the review threw");
  }, dir), /the review threw/);
  assert.equal(existsSync(lockPath), false, "a thrown error releases the lock too");
  assert.equal(existsSync(join(dir, "review-workers", "review-run-a.lock")), false, "the worker lock is released as before");
});

test("W1-T14947 the lock outlives the reviewer worker", async (t) => {
  const { dir, lockPath } = inflight(t);
  let afterWorker: boolean | undefined;
  await whileWorkerRunLive(host(), "run-a", async () => {
    // The reviewer worker runs and exits; the verdict is posted afterwards, still inside the review run.
    const workerExit = await new Promise<number>((resolve) => setTimeout(() => resolve(0), 5));
    assert.equal(workerExit, 0);
    afterWorker = existsSync(lockPath);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }, dir);
  assert.equal(afterWorker, true, "between the worker's exit and the posted verdict the review still holds its lock");
});

test("W1-T14947 a review lock is not a task run", async (t) => {
  const { dir } = inflight(t);
  mkdirSync(join(dir, REVIEW_INFLIGHT_DIR), { recursive: true });
  const alive = { pid: process.pid, run_id: "run-a", host: "fixture-host", startedAt: new Date(0).toISOString() };
  writeFileSync(join(dir, REVIEW_INFLIGHT_DIR, "review-run-a.lock"), JSON.stringify(alive));
  assert.deepEqual(liveInflightRuns(dir, () => true), [], "a live review lock is no task run");
  writeFileSync(join(dir, "W1-T1.lock"), JSON.stringify({ ...alive, run_id: "dispatch-run" }));
  assert.deepEqual(liveInflightRuns(dir, () => true).map((run) => run.taskId), ["W1-T1"],
    "positive control: a top-level task lock is still read");
});
