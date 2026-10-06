// W1-T5780 — W1-T5748 merged a behind plan PR on DISJOINT plan paths without loading the merged plan.
// Disjoint paths do not make a disjoint plan: two PRs that add one new task id in different shards, or
// a PR whose depends_on names a task main has since removed, share no path with main's changes and
// still break `loadPlan` on main. These fixtures are real git trees, so each shape is built the way
// it happens: paths disjoint, merged plan not loadable.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { attemptArm, type ArmDeps } from "../src/lib/arm-auto-merge.js";
import { decidePlanPrMergeSafety, planSafetyGitSync, readPlanMergeSafetySteps } from "../src/lib/plan-pr-merge-safety.js";
import { runStepsSync } from "../src/lib/git-push.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const PR_URL = "https://github.com/craigoley/remudero/pull/";
const NONE = { count: 0, heads: [] };

function shard(id: string, extra = ""): string {
  return `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  status: queued\n  attempts: 0\n${extra}`;
}

function put(seed: GitRepo, name: string, text: string | null): void {
  const path = join(seed.dir, "plan", "tasks.d", name);
  if (text === null) rmSync(path);
  else writeFileSync(path, text);
}

function commitOn(seed: GitRepo, branch: string, edit: () => void): string {
  seed.git("checkout", "-q", branch);
  edit();
  seed.git("add", "-A");
  seed.git("commit", "-qm", branch);
  return seed.git("rev-parse", "HEAD");
}

/** main gained a shard declaring W1-T50 and deleted W1-T9; each PR head touches only files main did not. */
function fixture() {
  const origin = gitRepo({ bare: true, kind: "w1t5780-origin" });
  const seed = gitRepo({ seedCommit: false, kind: "w1t5780-seed" });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "[]\n");
  put(seed, "W1-T1.yaml", shard("W1-T1"));
  put(seed, "W1-T9.yaml", shard("W1-T9"));
  seed.git("add", "-A");
  seed.git("commit", "-qm", "base");
  const base = seed.git("rev-parse", "HEAD");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "main");
  const work = gitRepo({ cloneFrom: origin.dir, kind: "w1t5780-work" });
  for (const b of ["dup", "dep", "ok"]) seed.git("branch", b, base);
  const main = commitOn(seed, "main", () => {
    put(seed, "W1-T50-main.yaml", shard("W1-T50"));
    put(seed, "W1-T9.yaml", null);
  });
  const heads: Record<number, string> = {
    1: commitOn(seed, "dup", () => put(seed, "W1-T50-pr.yaml", shard("W1-T50"))),
    2: commitOn(seed, "dep", () => put(seed, "W1-T60.yaml", shard("W1-T60", "  depends_on: [W1-T9]\n"))),
    3: commitOn(seed, "ok", () => put(seed, "W1-T70.yaml", shard("W1-T70"))),
  };
  const files: Record<number, string> = { 1: "W1-T50-pr.yaml", 2: "W1-T60.yaml", 3: "W1-T70.yaml" };
  seed.git("push", "-q", "origin", "main", ...Object.entries(heads).map(([n, h]) => `${h}:refs/pull/${n}/head`));
  const rest = (n: number) => (args: string[]): unknown => {
    const path = String(args[1]);
    if (path === `repos/o/r/pulls/${n}`) return { base: { ref: "main" }, head: { sha: heads[n] } };
    if (path === `repos/o/r/compare/main...${heads[n]}`) {
      return { base_commit: { sha: main }, merge_base_commit: { sha: base }, files: [{ filename: `plan/tasks.d/${files[n]}` }, { filename: "src/x.ts" }] };
    }
    if (path === `repos/o/r/compare/${base}...${main}`) return { files: [{ filename: "plan/tasks.d/W1-T50-main.yaml" }, { filename: "plan/tasks.d/W1-T9.yaml" }] };
    throw new Error(`unrouted ${path}`);
  };
  const read = (n: number) => runStepsSync(readPlanMergeSafetySteps({ owner: "o", repo: "r", prNumber: n }, rest(n), planSafetyGitSync(work.dir)) as never) as any;
  return { read, cleanup: () => [origin, seed, work].forEach((r) => r.cleanup()) };
}

function armWith(n: number, readings: unknown) {
  const calls: string[] = [];
  const deps = {
    headSha: () => "a".repeat(40),
    ledgerLines: () => [],
    armAuto: () => {
      throw Object.assign(new Error("boom"), { stderr: "Pull request is in clean status" });
    },
    mergeDirect: () => void calls.push("mergeDirect"),
    disableAuto: () => {},
    isMerged: () => false,
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 3, mergeableState: "clean" }),
    updateBranch: () => {
      calls.push("updateBranch");
      return { ok: true };
    },
    readPlanTouch: () => "touched",
    readPlanMergeSafety: () => readings,
    say: () => {},
  } as unknown as ArmDeps;
  return { result: attemptArm(`${PR_URL}${n}`, deps, "a".repeat(40)), calls };
}

test("a behind plan PR with disjoint paths whose merged tree declares a duplicate task id, or a depends_on on a task main removed, is refreshed not merged, while a disjoint PR whose merged tree loads still merges directly", () => {
  const repos = fixture();
  try {
    const dup = repos.read(1);
    const dep = repos.read(2);
    const ok = repos.read(3);
    // Every shape is path-disjoint from main's changes: that is what W1-T5748 merged on.
    for (const r of [dup, dep, ok]) {
      assert.equal(r.prPlanPaths.some((p: string) => r.mainPlanPaths.includes(p)), false);
      assert.ok(r.mergedTree, "the merged tree is read for a disjoint PR too");
    }
    assert.equal(dup.mergedTree.state, "quarantined");
    assert.deepEqual(dup.mergedTree.ids, ["W1-T50"]);
    assert.equal(dep.mergedTree.state, "refused");
    assert.match(dep.mergedTree.detail, /W1-T9/);
    assert.deepEqual(ok.mergedTree, { state: "loads" });

    for (const [n, readings] of [[1, dup], [2, dep]] as const) {
      const { result, calls } = armWith(n, readings);
      assert.equal(result.outcome, "direct-merge-updated", `PR ${n} is refreshed`);
      assert.deepEqual(calls, ["updateBranch"], `PR ${n} is not merged on its stale head`);
      assert.equal(result.directMergePreflight?.reason, "plan_pr_behind");
    }
    const merged = armWith(3, ok);
    assert.equal(merged.result.outcome, "direct-merged");
    assert.deepEqual(merged.calls, ["mergeDirect"]);
    assert.equal(merged.result.directMergePreflight?.planMergeSafe, "merged_tree");
  } finally {
    repos.cleanup();
  }
});

test("decidePlanPrMergeSafety never merges on disjoint paths alone, and records disjointness beside a loading tree", () => {
  const paths = { prPlanPaths: ["plan/tasks.d/a.yaml"], mainPlanPaths: ["plan/tasks.d/b.yaml"] };
  const unread = decidePlanPrMergeSafety({ readings: paths, refreshes: NONE });
  assert.equal(unread.action, "refresh");
  assert.match((unread as { why: string }).why, /merged tree was not read/);
  const dup = decidePlanPrMergeSafety({ readings: { ...paths, mergedTree: { state: "quarantined", ids: ["W1-T50"] } }, refreshes: NONE });
  assert.equal(dup.action, "refresh");
  assert.match((dup as { why: string }).why, /quarantines W1-T50/);
  // Past the bound the unproven plan escalates instead of merging.
  assert.equal(decidePlanPrMergeSafety({ readings: paths, refreshes: { count: 3, heads: ["h"] } }).action, "escalate");

  const disjointLoads = decidePlanPrMergeSafety({ readings: { ...paths, mergedTree: { state: "loads" } }, refreshes: NONE });
  assert.deepEqual(disjointLoads, { action: "merge", basis: "merged_tree", disjoint: true });
  const overlapLoads = decidePlanPrMergeSafety({
    readings: { prPlanPaths: ["plan/tasks.d/a.yaml"], mainPlanPaths: ["plan/tasks.d/a.yaml"], mergedTree: { state: "loads" } },
    refreshes: NONE,
  });
  assert.deepEqual(overlapLoads, { action: "merge", basis: "merged_tree", disjoint: false });
});
