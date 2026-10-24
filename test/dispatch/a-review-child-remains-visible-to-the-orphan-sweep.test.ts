import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reviewCommand, runInflightLockSweepRung, whileWorkerRunLive } from "#test/helpers/run-task-test.js";
import { acquireInflightLock } from "#src/lib/inflight-lock.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const runId = "review-PR1-1792784104686";
function otherProcessSees(dir: string): boolean {
  const code = `import { orphanSweepRunActive } from "#test/helpers/run-task-test.js"; process.stdout.write(JSON.stringify(orphanSweepRunActive("DAEMON-fixture", process.argv[1])(process.argv[2])));`;
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, dir, runId], { cwd: REPO_ROOT, encoding: "utf8" }));
}
function fixture(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-review-child-live-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a separate orphan-sweep process sees a review worker only while its owner is running it", async t => {
  const dir = fixture(t);
  assert.equal(otherProcessSees(dir), false, "positive control: a separate process has no local worker registry entry");
  const value = await whileWorkerRunLive(runId, async () => {
    assert.equal(otherProcessSees(dir), true, "a live review must be visible outside its own process");
    return "complete";
  }, dir);
  assert.equal(value, "complete");
  assert.equal(otherProcessSees(dir), false, "a returned review leaves no orphan protection");
  assert.deepEqual(readdirSync(join(dir, "review-workers")), []);
});

test("a throwing review releases its cross-process liveness record", async t => {
  const dir = fixture(t);
  await assert.rejects(whileWorkerRunLive(runId, async () => {
    assert.equal(otherProcessSees(dir), true);
    throw new Error("review failure control");
  }, dir), /review failure control/);
  assert.equal(otherProcessSees(dir), false);
  assert.deepEqual(readdirSync(join(dir, "review-workers")), []);
});

test("a review liveness collision preserves the existing holder and never starts work", async t => {
  const dir = fixture(t);
  await whileWorkerRunLive(runId, async () => {
    const [name] = readdirSync(join(dir, "review-workers"));
    assert.ok(name, "the outer review owns a durable record");
    const before = readFileSync(join(dir, "review-workers", name));
    let spawned = false;
    await assert.rejects(whileWorkerRunLive(runId, async () => { spawned = true; }, dir));
    assert.equal(spawned, false);
    assert.deepEqual(readFileSync(join(dir, "review-workers", name)), before);
  }, dir);
  assert.deepEqual(readdirSync(join(dir, "review-workers")), []);
});

test("a dead or foreign-host review holder does not become an active run", async t => {
  const dir = fixture(t);
  const name = `review-worker-${createHash("sha256").update(runId).digest("hex")}`;
  for (const info of [{}, { host: "foreign-host-fixture", pid: process.pid }, { pid: 99999999 }]) {
    const holder = acquireInflightLock(join(dir, "review-workers"), name, { run_id: runId, info });
    try { assert.equal(otherProcessSees(dir), Object.keys(info).length === 0); } finally { holder.release(); }
  }
});


test("the real review command protects its child worker from a separate orphan sweep", async t => {
  const root = fixture(t);
  const dir = join(root, "state", "inflight");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  let observed = false;
  const deps = {
    fetchView: () => ({ headRefOid: head, headRefName: "fixture", body: "Acceptance:\n- it works | grep: review in src/lib/review.ts\n", url: "https://github.com/craigoley/remudero/pull/1", number: 1 }),
    fetchHead: () => {},
    loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/bin/true" }),
    postReviewPending: async () => ({ posted: true }),
    materialize: () => ({ worktreePath: undefined, failure: { errorClass: "test", message: "fixture" } }),
    runReview: async (args: { runId: string }) => {
      const code = `import { orphanSweepRunActive } from "#test/helpers/run-task-test.js"; process.stdout.write(JSON.stringify(orphanSweepRunActive("DAEMON-fixture", process.argv[1])(process.argv[2])));`;
      observed = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, dir, args.runId], { cwd: REPO_ROOT, encoding: "utf8" }));
      return { state: "success", headSha: head, reviewerOutcome: "not_attempted", criteria: [] };
    },
    executionMode: "semantic",
  };
  await reviewCommand("fixture", ["--repo", "craigoley/remudero"], deps as never);
  assert.equal(observed, true, "the real command must publish liveness in its configured installation state");
  assert.deepEqual(readdirSync(join(dir, "review-workers")), []);
});


test("the regular in-flight sweep retires dead review records and preserves live holders", t => {
  const root = fixture(t);
  const dir = join(root, "state", "inflight", "review-workers");
  const stale = acquireInflightLock(dir, "dead-review", { run_id: "review-dead", info: { pid: 99999999 } });
  const live = acquireInflightLock(dir, "live-review", { run_id: runId });
  try {
    const result = runInflightLockSweepRung({ root } as never, () => {});
    assert.deepEqual(result.reaped, ["dead-review"]);
    assert.deepEqual(result.live, ["live-review"]);
    assert.deepEqual(readdirSync(dir), ["live-review.lock"]);
  } finally { stale.release(); live.release(); }
});
