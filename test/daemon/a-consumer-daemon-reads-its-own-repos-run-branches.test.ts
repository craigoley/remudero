/**
 * W1-T10897 — a consumer daemon's duplicate-build guard lists its TARGET repo's run branches.
 *
 * The listing ran `git ls-remote --heads origin run-*` in the engine checkout, whose origin is the
 * engine repo, so a site daemon never saw its own pushed `run-PORTAL-*` branches and rebuilt one task
 * on five fresh branches. These cases really shell out: two bare remotes, an engine checkout and a
 * target checkout under a fixture config root, each commit made with the fixture's own git identity.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { daemonTargetCheckoutRoot } from "#src/cli/commands/daemon.js";
import { runBranchDispatchOpts, runBranchStateFrom } from "#src/lib/daemon.js";
import { nextRunnable, runBranchTaskIds } from "#src/lib/drain.js";
import { loadPlan } from "#src/lib/plan.js";
import { repoRoot } from "#src/lib/repo-location.js";
import { readPushedRunBranchesOutput, readPushedRunBranchesOutputAsync } from "#src/run-task.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const TARGET_BRANCH = "run-PORTAL-T999-1793000000000";
const ENGINE_BRANCH = "run-W1-T1-1793000000000";

/** Clone `remote` into `dest`, commit once with the fixture identity, and push `branch` to origin. */
function checkoutPushing(remote: GitRepo, dest: string, branch: string): void {
  remote.git("clone", "--quiet", remote.dir, dest);
  remote.git("-C", dest, "commit", "--quiet", "--allow-empty", "-m", "seed");
  remote.git("-C", dest, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
}

function fixture(t: TestContext) {
  const engineRemote = gitRepo({ bare: true, scope: t, kind: "engine-remote" });
  const targetRemote = gitRepo({ bare: true, scope: t, kind: "target-remote" });
  const configRoot = ownedFixtureDir(t, "consumer-config-root").dir;
  const engineCheckout = join(configRoot, "engine");
  checkoutPushing(engineRemote, engineCheckout, ENGINE_BRANCH);
  mkdirSync(join(configRoot, "repos"), { recursive: true });
  checkoutPushing(targetRemote, join(configRoot, "repos", "remudero-site"), TARGET_BRANCH);
  return { configRoot, engineCheckout };
}

test("W1-T10897: a consumer daemon lists its target repo run branches, not the engine", async (t) => {
  const { configRoot, engineCheckout } = fixture(t);
  const checkout = daemonTargetCheckoutRoot({ repo: "remudero-site", isSelf: false }, configRoot, engineCheckout);
  assert.equal(checkout, join(configRoot, "repos", "remudero-site"));
  const listing = await readPushedRunBranchesOutputAsync(checkout);
  assert.deepEqual([...runBranchTaskIds(listing)], ["PORTAL-T999"], "the target's run branch, and only it");
  assert.deepEqual([...runBranchTaskIds(readPushedRunBranchesOutput(checkout))], ["PORTAL-T999"], "drain's sync read lists the same repo");
});

test("W1-T10897: a self-targeting daemon listing is unchanged", async (t) => {
  const { configRoot, engineCheckout } = fixture(t);
  const checkout = daemonTargetCheckoutRoot({ repo: "remudero", isSelf: true }, configRoot, engineCheckout);
  assert.equal(checkout, engineCheckout, "a self-targeting daemon lists from its own checkout");
  assert.deepEqual([...runBranchTaskIds(await readPushedRunBranchesOutputAsync(checkout))], ["W1-T1"]);
  assert.equal(daemonTargetCheckoutRoot({ repo: "remudero", isSelf: true }, configRoot), repoRoot, "the default self checkout is the engine's");
  // With no checkout named, both readers still list from the engine checkout, as before.
  const cwds: string[] = [];
  await readPushedRunBranchesOutputAsync(async (_cmd, _args, opts) => { cwds.push(opts.cwd); return { stdout: "" }; });
  readPushedRunBranchesOutput((_cmd, _args, opts) => { cwds.push(opts.cwd); return ""; });
  assert.deepEqual(cwds, [repoRoot, repoRoot]);
});

test("W1-T10897: a target repo pushed run branch blocks redispatch", async (t) => {
  const { configRoot, engineCheckout } = fixture(t);
  const planFile = join(configRoot, "tasks.yaml");
  writeFileSync(planFile, "- id: PORTAL-T999\n  title: t\n  repo: remudero-site\n  type: implement\n  depends_on: []\n  status: queued\n");
  const plan = loadPlan(planFile);
  const selectWith = (listing: string) => nextRunnable(plan, () => false, runBranchDispatchOpts(runBranchStateFrom(listing, undefined), [], () => {}))?.id;
  const consumer = daemonTargetCheckoutRoot({ repo: "remudero-site", isSelf: false }, configRoot, engineCheckout);
  assert.equal(selectWith(await readPushedRunBranchesOutputAsync(consumer)), undefined, "the target's pushed branch holds the task");
  assert.equal(selectWith(await readPushedRunBranchesOutputAsync(engineCheckout)), "PORTAL-T999", "the engine's listing never could");
  // A failed listing still refuses nothing, and its rejection names the checkout it read.
  const missing = join(configRoot, "repos", "absent");
  await assert.rejects(readPushedRunBranchesOutputAsync(missing), (e: Error) => e.message.startsWith(`run-branch listing in ${missing}: `));
  assert.equal(readPushedRunBranchesOutput(missing), "");
});
