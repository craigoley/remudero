import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { acquireInflightLock } from "#src/lib/inflight-lock.js";
import { ENGINE_RECORD, enginePath, pruneEngineTrees } from "#src/lib/engine-tree.js";
import { createAdmittedPlanSlot, spawnRunChild, startRunChildProbe } from "#src/lib/run-child.js";
import type { LearnedReservation, TreePeakSampler } from "#src/lib/host-memory-learning.js";

const temp = (): string => realpathSync(mkdtempSync(join(tmpdir(), "rmd-T11447-")));
const hash = (n: number): string => n.toString(16).padStart(64, "0");
const sha = (n: number): string => n.toString(16).padStart(40, "0");
function engine(state: string, n: number): string {
  const root = enginePath(state, hash(n));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, ENGINE_RECORD), JSON.stringify({ sourceHash: hash(n), sha: sha(n), builtAt: n }));
  return root;
}
function state(): string { return temp(); }

// W1-T11447 criterion 1

test("W1-T11447 criterion 1: empty run dirs do not defer pruning, while a held engine pin preserves its tree", async (t) => {
  const root = state();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = engine(root, 1);
  engine(root, 2);
  mkdirSync(join(root, "runs", "empty"), { recursive: true });
  assert.deepEqual(await pruneEngineTrees(root, { repoDir: root, git: async () => "" }), [hash(1)]);
  assert.equal(existsSync(old), false, "the unnamed engine is removed after empty dirs are ignored");

  const heldRoot = state();
  t.after(() => rmSync(heldRoot, { recursive: true, force: true }));
  const heldEngine = engine(heldRoot, 1);
  engine(heldRoot, 2);
  const lock = acquireInflightLock(join(heldRoot, "engines"), `${hash(1)}.pin`, { run_id: "test-owner", reclaim: false });
  t.after(() => lock.release());
  assert.deepEqual(await pruneEngineTrees(heldRoot, { repoDir: heldRoot, git: async () => "" }), []);
  assert.equal(existsSync(heldEngine), true, "a live pin makes prune defer this candidate");
});

// W1-T11447 criterion 2

test("W1-T11447 criterion 2: contentful metadata-free run dirs remain undecidable", async (t) => {
  const root = state();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = engine(root, 1);
  engine(root, 2);
  const dir = join(root, "runs", "contentful");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "worker-output"), "content without a spec or status");
  assert.deepEqual(await pruneEngineTrees(root, { repoDir: root, git: async () => "" }), []);
  assert.equal(existsSync(old), true);
});

test("W1-T11447 criterion 2: probe and run pin refusal leave no run directory", async (t) => {
  for (const path of ["probe", "run"] as const) {
    const repo = gitRepo({ kind: `engine-empty-pin-${path}` });
    t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
    const stateRoot = join(repo.dir, "state");
    const sha = repo.git("rev-parse", "HEAD");
    const publishedHash = hash(9);
    const publishedRoot = enginePath(stateRoot, publishedHash);
    mkdirSync(publishedRoot, { recursive: true });
    writeFileSync(join(publishedRoot, ENGINE_RECORD), JSON.stringify({ sourceHash: publishedHash, sha, builtAt: 9 }));
    const pin = acquireInflightLock(join(stateRoot, "engines"), `${publishedHash}.pin`, { run_id: "test-owner", reclaim: false });
    t.after(() => pin.release());
    const reservation = {
      id: "reservation", workerClass: "implement", estimateMib: 1, estimateSource: "default",
      bindRoot: () => {}, releaseOccupancy: () => {},
    } as unknown as LearnedReservation;
    const tasks = [{ id: "T-1", title: "test", repo: "remudero", depends_on: [], type: "implement", verify: "auto", status: "queued" }];
    if (path === "probe") {
      const slot = createAdmittedPlanSlot();
      slot.offer({ plan: { tasks } } as never);
      const outcome = await startRunChildProbe({
        taskId: "T-1", stateRoot, repoDir: repo.dir, root: repo.dir, plan: slot.promise, options: { owner: "test" }, log: () => {},
      }, {
        readMode: () => "shadow", mainSha: async () => sha, engine: { isCurrent: () => true },
        sampler: { sampleNow: () => {}, finish: () => 1 } as unknown as TreePeakSampler,
        reserve: () => reservation,
        launch: (engine, args) => ({ kind: "tsx", reason: "test", argv: [...args], cwd: repo.dir, engineRoot: engine.root }),
        enginePin: { waitMs: 0 },
      });
      assert.equal(outcome.started, false);
    } else {
      const launched = await spawnRunChild({
        taskId: "T-1", stateRoot, repoDir: repo.dir, root: repo.dir,
        options: { skipGitSync: false, handOffAtPrOpen: true, pairedTrialHost: "daemon" },
        plan: async () => ({ plan: { tasks } }) as never, log: () => {},
      }, {
        mainSha: async () => sha, engine: { isCurrent: () => true }, reserve: async () => reservation,
        launch: (engine, args) => ({ kind: "tsx", reason: "test", argv: [...args], cwd: repo.dir, engineRoot: engine.root }),
        enginePin: { waitMs: 0 },
      });
      assert.equal(launched.started, false);
    }
    assert.deepEqual(existsSync(join(stateRoot, "runs")) ? (await import("node:fs")).readdirSync(join(stateRoot, "runs")) : [], [], `${path} pin refusal leaves no run directory`);
  }
});
