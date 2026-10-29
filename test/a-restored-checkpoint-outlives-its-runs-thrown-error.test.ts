/**
 * W1-T9786 — A RESTORED CHECKPOINT OUTLIVES ITS RUN'S THROWN HARNESS ERROR. On 2026-10-15 W1-T9047's run
 * W1-T9047-1792035987149 restored run-W1-T9047-1792027244995 at 03:48Z, and at 04:10Z its `git push` threw
 * "could not read Username". The thrown run's `failed` verdict (stage run.error, cause git-push-failed) consumed the
 * receipt, and no `implement.checkpoint_kept` row followed: W1-T8676 writes one only after a worker error. Every pass
 * then refused the P1 as run-branch-already-pushed until the 24 h orphan grace, and the next build had nothing left to
 * restore.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pendingWorkerBoundaryHandoffs } from "../src/lib/daemon.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { runTask } from "./helpers/run-task-test.js";
import { gitRepo } from "./helpers/git-repo.js";

const TASK = "W1-T9786";
const SOURCE = `run-${TASK}-1792027244995`;
const HEAD = "a1251e869".padEnd(40, "0");
const PUSH_REFUSED = "Command failed: git -C /home/node/Remudero/worktrees/run-W1-T9047-1792035987149 push origin HEAD\n" +
  "fatal: could not read Username for 'https://github.com/craigoley/remudero.git': No such device or address";
const lines = (rows: Record<string, unknown>[]) => rows.map((row) => JSON.stringify(row));

function worker(text: string): WorkerResult {
  return { sessionId: "fixture", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "test", effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false };
}

/** A checkpoint branch on a bare origin, a clone as the managed checkout, and a ledger holding its receipt. */
function checkpointFixture() {
  const origin = gitRepo({ bare: true });
  const seed = gitRepo();
  seed.git("config", "user.name", "checkpoint fixture");
  seed.git("config", "user.email", "checkpoint@fixture.invalid");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  seed.git("checkout", "--quiet", "-b", SOURCE);
  writeFileSync(join(seed.dir, "paid-work.txt"), "checkpoint work\n");
  seed.git("add", "paid-work.txt");
  seed.git("commit", "--quiet", "-m", "wip: checkpoint work");
  const headSha = seed.git("rev-parse", "HEAD");
  seed.git("push", "--quiet", "origin", SOURCE);
  seed.git("checkout", "--quiet", "main");
  const clone = gitRepo({ cloneFrom: `file://${origin.dir}` });
  clone.git("config", "user.name", "checkpoint fixture");
  clone.git("config", "user.email", "checkpoint@fixture.invalid");
  const root = gitRepo();
  mkdirSync(join(root.dir, "repos"));
  renameSync(clone.dir, join(root.dir, "repos", "remudero"));
  mkdirSync(join(root.dir, "state"));
  const ledgerPath = join(root.dir, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, lines([{ task_id: TASK, step: "run.freshness_handoff", waiting_on: "worker_round", branch: SOURCE,
    head_sha: headSha }]).join("\n") + "\n");
  const planPath = join(root.dir, "tasks.yaml");
  writeFileSync(planPath, `- id: ${TASK}\n  title: checkpoint fixture\n  repo: remudero\n  type: implement\n  verify: auto\n` +
    `  risk: high\n  origin: test\n  status: queued\n  files: [paid-work.txt]\n`);
  const readRows = () => readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((raw) => JSON.parse(raw) as Record<string, unknown>);
  const cleanup = () => { root.cleanup(); clone.cleanup(); seed.cleanup(); origin.cleanup(); };
  return { origin, root, headSha, readRows, cleanup };
}

/** One real runTask dispatch whose implement worker the caller scripts; recon always reports. */
function dispatch(f: ReturnType<typeof checkpointFixture>, implement: (cwd: string) => Promise<WorkerResult>) {
  let calls = 0;
  return withLiveWritesAllowed(() => runTask(TASK, {
    config: { claudeBin: "/bin/true", root: f.root.dir, installRoot: process.cwd() },
    skipGitSync: true, planPath: join(f.root.dir, "tasks.yaml"),
    github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    claimReserver: { mintAnchor: () => "checkpoint-anchor", attempt: () => "created", holder: () => undefined, drop: () => true },
    containmentExec: async (token) => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
    isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    externalWaitFreshness: () => undefined,
    spawn: async (args) => (++calls === 1 ? worker("RECON REPORT\nOBSERVED: restored checkpoint\n") : implement((args as { cwd: string }).cwd)),
  }));
}

test("W1-T9786: a restored checkpoint stays pending after its run throws a harness error", async () => {
  // The fold, over W1-T9047's own rows: the thrown verdict consumes the receipt; the kept row re-pends that head.
  const thrown = { task_id: TASK, run_id: "r2", step: "verdict", verdict: "failed", stage: "run.error", cause: "git-push-failed", reason: PUSH_REFUSED };
  const history = [
    { task_id: TASK, run_id: "r1", step: "run.freshness_handoff", waiting_on: "worker_round", branch: SOURCE, head_sha: HEAD },
    { task_id: TASK, run_id: "r2", step: "implement.checkpoint_restored", source_branch: SOURCE, source_head_sha: HEAD, base: "main" },
    thrown,
  ];
  assert.equal(pendingWorkerBoundaryHandoffs(lines(history)).size, 0, "without a kept row the thrown verdict consumed it");

  // The writer: a real dispatch restores the checkpoint, then a harness push throws, and run-task keeps the checkpoint.
  const f = checkpointFixture();
  try {
    await assert.rejects(dispatch(f, async (cwd) => {
      assert.equal(readFileSync(join(cwd, "paid-work.txt"), "utf8"), "checkpoint work\n", "the worker sees the restored work");
      throw new Error(PUSH_REFUSED);
    }), /could not read Username/);
    const rows = f.readRows();
    assert.equal(rows.find((row) => row.step === "implement.checkpoint_restored")?.source_branch, SOURCE);
    const verdictAt = rows.findIndex((row) => row.step === "verdict");
    assert.equal(rows[verdictAt]?.stage, "run.error");
    assert.equal(rows[verdictAt]?.cause, "git-push-failed");
    const keptAt = rows.findIndex((row) => row.step === "implement.checkpoint_kept");
    assert.ok(verdictAt >= 0 && keptAt === verdictAt + 1, "ONE kept row, right after the thrown verdict");
    assert.equal(rows.filter((row) => row.step === "implement.checkpoint_kept").length, 1);
    const keptRow = rows[keptAt]!;
    assert.equal(keptRow.run_id, rows[verdictAt]!.run_id);
    assert.equal(keptRow.source_branch, SOURCE);
    assert.equal(keptRow.head_sha, f.headSha);
    assert.equal(keptRow.failed_stage, "run.error");
    assert.equal(keptRow.failed_cause, "git-push-failed");
    assert.deepEqual(pendingWorkerBoundaryHandoffs(lines(rows)).get(TASK), { branch: SOURCE, headSha: f.headSha });
  } finally { f.cleanup(); }
});

test("W1-T9786: a thrown run that pushed its own branch keeps its own head", async () => {
  // Its own branch is the newer checkpoint (W1-T7837), so the restored one is not re-pended.
  const f = checkpointFixture();
  let own: string | undefined;
  try {
    await assert.rejects(dispatch(f, async (cwd) => {
      own = f.origin.git("-C", cwd, "rev-parse", "--abbrev-ref", "HEAD");
      f.origin.git("-C", cwd, "push", "--quiet", "origin", `HEAD:refs/heads/${own}`);
      throw new Error("Command failed: gh pr create --head x\nHTTP 502");
    }), /HTTP 502/);
    const rows = f.readRows();
    assert.ok(rows.some((row) => row.step === "implement.checkpoint_restored"));
    assert.equal(rows.find((row) => row.step === "verdict")?.stage, "run.error");
    assert.equal(rows.find((row) => row.step === "implement.checkpoint_kept")?.source_branch, own);
    assert.deepEqual(pendingWorkerBoundaryHandoffs(lines(rows)).get(TASK), { branch: own, headSha: f.headSha });
  } finally { f.cleanup(); }
});

test("W1-T9786: an unproven own-branch read keeps nothing and keeps the run's own error", async () => {
  // A refused worktree pointer must not replace the push error the daemon's credential check reads (W1-T9680).
  const f = checkpointFixture();
  try {
    await assert.rejects(dispatch(f, async (cwd) => {
      rmSync(join(cwd, ".git"), { force: true });
      throw new Error(PUSH_REFUSED);
    }), /could not read Username/);
    const rows = f.readRows();
    assert.ok(rows.some((row) => row.step === "implement.checkpoint_keep_unproven"));
    assert.equal(rows.find((row) => row.step === "verdict")?.cause, "git-push-failed");
    assert.equal(rows.some((row) => row.step === "implement.checkpoint_kept"), false);
  } finally { f.cleanup(); }
});
