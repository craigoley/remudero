import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { runGarden, type GardenerDeps } from "../src/lib/gardener.js";
import { loadPlan } from "../src/lib/plan.js";
import { applyPlanActions, filingRef, grepProofHolds, planGardenSpec, planInventory, proofLandingCommit, retirementCandidates } from "../src/lib/plan-gardener.js";
import { gitRepo } from "./helpers/git-repo.js";

const shard = "plan/tasks.d/W1-T1-landed.yaml";

function fixture(heldAtFiling = false) {
  const repo = gitRepo({ kind: "queued-landed" });
  mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
  mkdirSync(join(repo.dir, "state"));
  writeFileSync(join(repo.dir, "plan/tasks.yaml"), "[]\n");
  writeFileSync(join(repo.dir, "work.txt"), heldAtFiling ? "first\nsecond\n" : "seed\n");
  writeFileSync(join(repo.dir, shard), [
    "- id: W1-T1",
    "  title: landed work",
    "  repo: remudero",
    "  type: implement",
    "  depends_on: []",
    "  status: queued",
    "  acceptance:",
    "    - claim: first part landed",
    "      proof: 'grep: first in work.txt'",
    "    - claim: second part landed",
    "      proof: 'grep: second in work.txt'",
    "",
  ].join("\n"));
  repo.git("add", "-A");
  repo.git("commit", "-qm", "file task");
  writeFileSync(join(repo.dir, "work.txt"), "first\n");
  repo.git("commit", "-qam", "land first part");
  writeFileSync(join(repo.dir, "work.txt"), "first\nsecond\n");
  repo.git("commit", "-qam", "land second part");
  const commit = repo.git("rev-parse", "HEAD");
  repo.git("commit", "-q", "--allow-empty", "-m", "unrelated later change");
  const proposals: Array<{ paths: string[]; title: string; body: string }> = [];
  const deps: GardenerDeps = {
    repoRoot: repo.dir,
    stateDir: join(repo.dir, "state"),
    seed: 1,
    log: () => {},
    openWorkspace: () => ({
      root: repo.dir,
      land: (proposal) => {
        proposals.push(proposal);
        return "https://github.com/acme/remudero/pull/1";
      },
      dispose: () => {},
    }),
  };
  return { repo, deps, proposals, commit };
}

test("W1-T4861: a queued task whose proofs now hold is proposed done with its commit", () => {
  const { repo, deps, proposals, commit } = fixture();
  const before = readFileSync(join(repo.dir, shard), "utf8");
  const spec = planGardenSpec(deps);
  const actions = spec.candidates(planInventory(repo.dir, deps.stateDir), () => 0.5);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.landingCommit, commit);
  assert.ok(spec.review?.[actions[0]!.class], "completion stays on a reviewed proposal path");
  assert.equal(readFileSync(join(repo.dir, shard), "utf8"), before, "discovery never rewrites the plan");
  runGarden(spec, deps);
  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0]!.paths, [shard]);
  assert.match(proposals[0]!.body, /status: done/);
  assert.ok(proposals[0]!.body.includes(commit));
  const proofs = proposals[0]!.body.split("\n").filter((line) => line.startsWith("  proof: "));
  assert.equal(proofs.length, 2, "the proposal proves both completion and its landing commit");
  for (const proof of proofs) assert.equal(grepProofHolds(repo.dir, proof.slice("  proof: ".length)), true);
  const task = loadPlan(join(repo.dir, "plan/tasks.yaml")).byId.get("W1-T1")!;
  assert.equal(task.status, "done");
  assert.equal(task.retirement, undefined);
  assert.ok(readFileSync(join(repo.dir, shard), "utf8").includes(commit));
  assert.deepEqual(retirementCandidates(planInventory(repo.dir, deps.stateDir), repo.dir), []);
});

test("W1-T4861: a task whose proofs held at filing is not proposed done", () => {
  const { repo, deps, proposals } = fixture(true);
  const before = readFileSync(join(repo.dir, shard), "utf8");
  assert.deepEqual(retirementCandidates(planInventory(repo.dir, deps.stateDir), repo.dir), []);
  runGarden(planGardenSpec(deps), deps);
  assert.deepEqual(proposals, []);
  assert.equal(readFileSync(join(repo.dir, shard), "utf8"), before);
});

test("completion waits for every proof in committed history", () => {
  const { repo, deps } = fixture();
  const inv = planInventory(repo.dir, deps.stateDir);
  inv.open[0]!.acceptance!.push({ claim: "third part", proof: "grep: third in work.txt" });
  assert.deepEqual(retirementCandidates(inv, repo.dir), [], "one missing proof prevents completion");
  writeFileSync(join(repo.dir, "work.txt"), "first\nsecond\nthird\n");
  assert.deepEqual(retirementCandidates(inv, repo.dir), [], "dirty work is not a landing commit");
});

test("completion does not discard a failing proof about the task's own shard", () => {
  const { repo, deps } = fixture();
  const inv = planInventory(repo.dir, deps.stateDir);
  inv.open[0]!.acceptance!.push({ claim: "own proof", proof: `grep: absent-marker in ${shard}` });
  assert.deepEqual(retirementCandidates(inv, repo.dir), []);
});

test("unreadable completion history never invents a landing commit", () => {
  const { repo } = fixture();
  const filed = filingRef(repo.dir, shard)!;
  assert.equal(proofLandingCommit(repo.dir, filed, ["grep: first in work.txt", "grep: second in work.txt"]), repo.git("rev-parse", "HEAD~1"));
  assert.equal(proofLandingCommit(repo.dir, "missing-ref", ["grep: first in work.txt"]), undefined);
  assert.equal(proofLandingCommit(repo.dir, filed, ["unit test: unsupported"]), undefined);
  assert.equal(proofLandingCommit(repo.dir, filed, []), undefined);
  assert.equal(proofLandingCommit(repo.dir, "HEAD", ["grep: first in work.txt"]), undefined);
});

test("a merge records the commit that brought all proofs onto main", () => {
  const { repo, deps } = fixture();
  repo.git("checkout", "-qb", "work-branch");
  writeFileSync(join(repo.dir, "work.txt"), "first\nsecond\nthird\n");
  repo.git("commit", "-qam", "complete work on a branch");
  const branchCommit = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "main");
  repo.git("merge", "-q", "--no-ff", "-m", "land work on main", "work-branch");
  const mergeCommit = repo.git("rev-parse", "HEAD");
  const inv = planInventory(repo.dir, deps.stateDir);
  inv.open[0]!.acceptance!.push({ claim: "third part", proof: "grep: third in work.txt" });
  const actions = retirementCandidates(inv, repo.dir);
  assert.equal(actions[0]!.landingCommit, mergeCommit);
  assert.notEqual(actions[0]!.landingCommit, branchCommit);
});

test("a regression records the commit that restored all proofs", () => {
  const { repo, deps } = fixture();
  writeFileSync(join(repo.dir, "work.txt"), "first\n");
  repo.git("commit", "-qam", "regress work");
  assert.deepEqual(retirementCandidates(planInventory(repo.dir, deps.stateDir), repo.dir), []);
  writeFileSync(join(repo.dir, "work.txt"), "first\nsecond\n");
  repo.git("commit", "-qam", "restore work");
  const restored = repo.git("rev-parse", "HEAD");
  repo.git("commit", "-q", "--allow-empty", "-m", "later change");
  const actions = retirementCandidates(planInventory(repo.dir, deps.stateDir), repo.dir);
  assert.equal(actions[0]!.landingCommit, restored);
});

test("completion preserves a task changed since inventory and is idempotent", () => {
  const { repo, deps } = fixture();
  const inv = planInventory(repo.dir, deps.stateDir);
  const actions = retirementCandidates(inv, repo.dir);
  const original = readFileSync(join(repo.dir, shard), "utf8");
  for (const status of ["blocked", "done", "running"]) {
    const text = original.replace("status: queued", `status: ${status}`);
    writeFileSync(join(repo.dir, shard), text);
    assert.deepEqual(applyPlanActions(repo.dir, inv.shards, actions), []);
    assert.equal(readFileSync(join(repo.dir, shard), "utf8"), text);
  }
  inv.open[0]!.status = "done";
  assert.deepEqual(retirementCandidates(inv, repo.dir), []);
  inv.open[0]!.status = "queued";
  inv.open[0]!.retirement = "closed";
  assert.deepEqual(retirementCandidates(inv, repo.dir), []);
});
