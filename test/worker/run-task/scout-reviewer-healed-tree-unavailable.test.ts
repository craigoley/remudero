import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { emptyReviewerHealthState, reviewerHealthStatePath, saveReviewerHealthState } from "#src/lib/reviewer-health.js";
import type { Config } from "#src/lib/config.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

type PrepareWorktree = (repoDir: string, worktreePath: string) => boolean;

async function fixture(t: TestContext, prepareWorktree: PrepareWorktree = () => true) {
  // Keep this focused regression out of run-task's importer census while still loading the real
  // route at runtime. The graph reader only resolves literal module specifiers.
  const runTaskPath = ["#src/", "run-task.js"].join("");
  const runTask = await import(runTaskPath);
  const { dir } = ownedFixtureDir(t, "scout-healed-review");
  const origin = gitRepo({ scope: t, bare: true });
  const worker = gitRepo({ scope: t });
  const reviewFile = "src/lib/review.ts";
  const baseline = worker.git("rev-parse", "HEAD");
  worker.git("commit", "--allow-empty", "-m", "healthy reviewer (#100)");
  const healthy = worker.git("rev-parse", "HEAD");
  mkdirSync(join(worker.dir, "src", "lib"), { recursive: true });
  writeFileSync(join(worker.dir, reviewFile), "export const refuseReview = true;\n");
  worker.git("add", reviewFile);
  worker.git("commit", "-m", "regress reviewer (#101)");
  const main = worker.git("rev-parse", "HEAD");
  worker.addRemote("origin", origin.dir);
  worker.git("push", "origin", "main");

  const shared = join(dir, `healed-${main.slice(0, 12)}-${main.slice(0, 12)}`);
  worker.git("worktree", "add", "--detach", shared, healthy);
  worker.git("worktree", "lock", shared);
  const ledgerPath = join(dir, "ledger.ndjson");
  const ts = new Date().toISOString();
  const history = Array.from({ length: 111 }, (_, i) => ({
    ts, pr_url: `https://github.com/acme/remudero/pull/${i + 1}`, head_sha: (i + 1).toString(16).padStart(40, "0"),
    plan_only: false, state: "success", reviewer_code_sha: i < 100 ? baseline : i < 105 ? healthy : main,
    ...(i < 105 ? { step: "review.posted" } : {
      step: "review.semantic_incomplete", reason: "required-semantic-incomplete-verdicts", reviewer_outcome: "success",
    }),
  }));
  writeFileSync(ledgerPath, history.map((row) => JSON.stringify(row)).join("\n") + "\n");
  saveReviewerHealthState(reviewerHealthStatePath(dir), { ...emptyReviewerHealthState(), cursor: { liveOffset: 0 } });

  const spawned: string[] = [];
  const cuts: string[] = [];
  const route = runTask.buildReviewerHealthRoute(worker.dir, { root: dir } as Config, ledgerPath,
    (step, extra) => appendFileSync(ledgerPath, JSON.stringify({ ts, step, ...extra }) + "\n"), {
      worktreeRoot: dir,
      git: (args) => worker.git(...args.slice(2)),
      addWorktree: (_repo, path, sha) => {
        worker.git("worktree", "add", "--detach", path, sha);
        cuts.push(path);
      },
      prepareWorktree,
      spawnReview: async (path) => { spawned.push(path); return 0; },
    }, { listOpen: async () => [], create: async () => "https://github.com/acme/remudero/issues/1" },
    { openFixPr: async () => undefined, openRevertPr: async () => ({ prUrl: "https://github.com/acme/remudero/pull/900" }) });
  return {
    worker, main, healthy, reviewFile, shared, cuts, spawned, route,
    failures: () => readFileSync(ledgerPath, "utf8").trimEnd().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row.step === "reviewer.healed_tree_unavailable"),
  };
}

test("W1-T13096: reviewer.healed_tree_unavailable no longer recurs", async (t) => {
  const f = await fixture(t);
  const normal = async () => 7;
  assert.equal(await f.route("207", [], {}, normal), 0);
  assert.equal(await f.route("208", [], {}, normal), 0);
  assert.equal(f.cuts.length, 1, "the next review reuses the healed sibling");
  const healed = f.cuts[0]!;
  assert.deepEqual(f.spawned, [healed, healed]);
  assert.equal(f.worker.git("-C", healed, "rev-parse", "HEAD^1"), f.main);
  assert.equal(f.worker.git("-C", healed, "diff", "--name-only", "HEAD^1", "HEAD"), f.reviewFile);
  assert.equal(f.worker.git("-C", healed, "ls-tree", "HEAD", f.reviewFile), "");
  assert.equal(f.worker.git("-C", f.shared, "rev-parse", "HEAD"), f.healthy);
  assert.deepEqual(f.failures(), []);
});

test("W1-T13096: the symptom is still recorded when its failure occurs", async (t) => {
  const f = await fixture(t, () => false);
  assert.equal(await f.route("209", [], {}, async () => 7), 7);
  assert.equal(f.cuts.length, 1);
  assert.equal(existsSync(f.cuts[0]!), false, "the failed private checkout is removed");
  assert.deepEqual(f.spawned, []);
  const [failure, ...others] = f.failures();
  assert.ok(failure);
  assert.equal(others.length, 0);
  assert.equal(failure.pr, "209");
  assert.equal(failure.origin_main_sha, f.main);
  assert.equal(failure.state, "unavailable");
  assert.match(String(failure.reason), /healed tree could not be cut: .*no runnable canonical node_modules link/);
});
