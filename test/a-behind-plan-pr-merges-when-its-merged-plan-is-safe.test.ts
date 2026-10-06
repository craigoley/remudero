// W1-T5748 — on 2026-10-04 batch 9 (#9138) and batch 10 (#9155) were re-headed 2 and 3 times
// between 20:36Z and 21:29Z and never merged: W1-T5472 updated every behind plan PR
// (`plan_pr_behind`) and a refreshed plan PR needs ~15 min of checks and review while main moved
// every few minutes. The hazard W1-T5472 guards is a merged plan that does not load (#8871's
// joined `priority:` lines). So a behind plan PR now merges as-is when its merged tree loads (W1-T5780:
// path disjointness alone no longer counts); otherwise it is refreshed, and past a bound it is
// escalated to the operator instead of refreshed again.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { attemptArm, attemptArmAsync, logArmAttribution, realArmDeps, realArmDepsAsync, type ArmDeps } from "../src/lib/arm-auto-merge.js";
import { runStepsAsync as runAsync, runStepsSync as runSync } from "../src/lib/git-push.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

// Read off a dynamic import so this file still LOADS on a tree without the module, and fails per test.
const safety = (await import("../src/lib/plan-pr-merge-safety.js").catch(() => ({}))) as Record<string, any>;
const runStepsSync = (steps: unknown): any => runSync(steps as never);
const runStepsAsync = (steps: unknown): Promise<any> => runAsync(steps as never);

const PR = "https://github.com/craigoley/remudero/pull/9155";
const HEAD = "634285b5634285b5634285b5634285b5634285b5";
const CLEAN = "Pull request is in clean status";
const BEHIND_CLEAN = { mergeable: "MERGEABLE", behindBy: 4, mergeableState: "clean" };

function refreshRow(head: string, extra: Record<string, unknown> = {}) {
  return { step: "automerge.direct_merge_updated", pr_number: 9155, pr_url: PR, reason: "plan_pr_behind", prior_head_sha: head, ...extra };
}

function harness(opts: { readings?: () => unknown; ledger?: Array<Record<string, unknown>> } = {}) {
  const calls: string[] = [];
  const said: string[] = [];
  const deps: Record<string, unknown> = {
    headSha: () => HEAD,
    ledgerLines: () => opts.ledger ?? [],
    armAuto: () => {
      calls.push("armAuto");
      throw Object.assign(new Error("boom"), { stderr: CLEAN });
    },
    mergeDirect: () => void calls.push("mergeDirect"),
    disableAuto: () => {},
    isMerged: () => false,
    readMergeFacts: () => BEHIND_CLEAN,
    updateBranch: () => {
      calls.push("updateBranch");
      return { ok: true };
    },
    readPlanTouch: () => "touched",
    say: (msg: string) => void said.push(msg),
  };
  if (opts.readings) {
    const read = opts.readings;
    deps.readPlanMergeSafety = (prUrl: string) => {
      calls.push(`readPlanMergeSafety:${prUrl}`);
      return read();
    };
  }
  return { deps: deps as unknown as ArmDeps, calls, said };
}

test("a behind plan PR whose shards are disjoint from main's plan changes and whose merged tree loads merges directly, never updated", () => {
  const { deps, calls, said } = harness({
    readings: () => ({ prPlanPaths: ["plan/tasks.d/W1-T5730.yaml"], mainPlanPaths: ["plan/tasks.d/W1-T5700.yaml", "plan/tasks.yaml"], mergedTree: { state: "loads" } }),
  });
  const result = attemptArm(PR, deps, HEAD);
  assert.equal(result.outcome, "direct-merged");
  assert.ok(calls.includes("mergeDirect"));
  assert.ok(!calls.includes("updateBranch"), "the unconditional plan_pr_behind update would re-head it again");
  assert.ok(!calls.includes("armAuto"), "a plan PR is never armed (W1-T5615)");
  assert.equal(result.directMergePreflight?.remedy, "direct-merge");
  assert.equal(result.directMergePreflight?.planMergeSafe, "merged_tree");
  assert.match(said.join("\n"), /automerge\.plan_pr_merge_safe \(W1-T5748\): basis=merged_tree behind_by=4/);
});

test("a behind plan PR that overlaps main but whose merged tree loads and lints merges directly", () => {
  const { deps, calls } = harness({
    readings: () => ({ prPlanPaths: ["plan/tasks.d/W1-T1.yaml"], mainPlanPaths: ["plan/tasks.d/W1-T1.yaml"], mergedTree: { state: "loads" } }),
  });
  const result = attemptArm(PR, deps, HEAD);
  assert.equal(result.outcome, "direct-merged");
  assert.ok(!calls.includes("updateBranch"));
  assert.equal(result.directMergePreflight?.planMergeSafe, "merged_tree");
});

test("an overlapping plan PR whose merged tree carries a duplicate key is updated, as W1-T5472 did", () => {
  const { deps, calls, said } = harness({
    readings: () => ({
      prPlanPaths: ["plan/tasks.d/W1-T1.yaml"],
      mainPlanPaths: ["plan/tasks.d/W1-T1.yaml"],
      mergedTree: { state: "quarantined", ids: ["W1-T1"] },
    }),
    ledger: [refreshRow("aaaa"), refreshRow("bbbb", { pr_url: "https://github.com/craigoley/remudero/pull/9138" })],
  });
  const result = attemptArm(PR, deps, HEAD);
  assert.equal(result.outcome, "direct-merge-updated");
  assert.deepEqual(calls.filter((c) => c === "updateBranch" || c === "mergeDirect"), ["updateBranch"]);
  assert.equal(result.directMergePreflight?.reason, "plan_pr_behind");
  assert.match(String(result.directMergePreflight?.planMergeUnsafe), /quarantines W1-T1/);
  assert.match(said.join("\n"), /reason=plan_pr_behind plan_touch=touched/);
});

test("a plan PR past the refresh bound is escalated naming its heads, never updated again", () => {
  const bound = safety.PLAN_PR_REFRESH_BOUND as number;
  assert.ok(Number.isInteger(bound) && bound >= 1);
  const heads = Array.from({ length: bound }, (_, i) => `head${i}`);
  const { deps, calls, said } = harness({
    readings: () => ({ prPlanPaths: ["plan/tasks.d/W1-T1.yaml"], mainPlanPaths: ["plan/tasks.d/W1-T1.yaml"], mergedTree: { state: "conflict" } }),
    // Only this PR's plan_pr_behind refreshes count.
    ledger: [...heads.map((h) => refreshRow(h)), refreshRow("other", { reason: undefined }), { step: "automerge.plan_pr_held", pr_url: PR }],
  });
  const result = attemptArm(PR, deps, HEAD);
  assert.equal(result.outcome, "plan-pr-held");
  assert.ok(!calls.includes("updateBranch") && !calls.includes("mergeDirect"));
  assert.equal(result.directMergePreflight?.reason, "plan_pr_refresh_bound");
  assert.equal(result.directMergePreflight?.remedy, "retry-later");
  assert.deepEqual(result.directMergePreflight?.refreshedHeads, [...heads, HEAD]);
  assert.match(said.join("\n"), new RegExp(`automerge\\.plan_pr_refresh_escalated \\(W1-T5748\\): ${bound} refreshes .*head0.*${HEAD}`));

  // One refresh short of the bound still refreshes.
  const under = harness({ readings: () => ({ error: "HTTP 502" }), ledger: heads.slice(1).map((h) => refreshRow(h)) });
  assert.equal(attemptArm(PR, under.deps, HEAD).outcome, "direct-merge-updated");
});

test("no merge-safety reader, or a reader that throws, refreshes exactly as W1-T5472 did", async () => {
  const unwired = harness();
  const plain = attemptArm(PR, unwired.deps, HEAD);
  assert.equal(plain.outcome, "direct-merge-updated");
  assert.match(String(plain.directMergePreflight?.planMergeUnsafe), /no plan merge-safety reader/);

  const throwing = harness({
    readings: () => {
      throw new Error("compare read refused");
    },
  });
  const thrown = await attemptArmAsync(PR, throwing.deps as never, HEAD);
  assert.equal(thrown.outcome, "direct-merge-updated");
  assert.match(String(thrown.directMergePreflight?.planMergeUnsafe), /compare read refused/);

  // A strict base that reports `behind` is never merged as-is: GitHub would refuse it.
  const strict = harness({ readings: () => ({ prPlanPaths: ["plan/a.yaml"], mainPlanPaths: ["plan/b.yaml"] }) });
  (strict.deps as unknown as Record<string, unknown>).readMergeFacts = () => ({ ...BEHIND_CLEAN, mergeableState: "behind" });
  assert.equal(attemptArm(PR, strict.deps, HEAD).outcome, "direct-merge-updated");
  assert.ok(!strict.calls.some((c) => c.startsWith("readPlanMergeSafety")));
});

test("decidePlanPrMergeSafety refreshes on every unreadable or unsafe reading", () => {
  const decide = safety.decidePlanPrMergeSafety as (input: unknown) => { action: string; basis?: string; why?: string };
  const none = { count: 0, heads: [] };
  const why = (readings: unknown) => decide({ readings, refreshes: none }).why ?? "";
  assert.equal(decide({ readings: { prPlanPaths: ["plan/a"], mainPlanPaths: [], mergedTree: { state: "loads" } }, refreshes: none }).basis, "merged_tree");
  assert.match(why(undefined), /no plan merge-safety reader/);
  assert.match(why({ error: "HTTP 404" }), /HTTP 404/);
  assert.match(why({ prPlanPaths: ["plan/a"] }), /main's plan changes since the merge base were unreadable/);
  assert.match(why({ prPlanPaths: ["plan/a"], mainPlanPaths: ["plan/a"] }), /merged tree was not read/);
  assert.match(why({ mergedTree: { state: "conflict" } }), /conflicts/);
  assert.match(why({ mergedTree: { state: "refused", detail: "depends_on unknown task" } }), /depends_on unknown task/);
  assert.match(why({ mergedTree: { state: "unreadable", error: "no tree" } }), /no tree/);
  assert.equal(decide({ readings: { error: "x" }, refreshes: { count: 1, heads: ["h"] }, bound: 1 }).action, "escalate");
});

test("planPrRefreshesFromLedger counts this PR's plan_pr_behind refreshes and their heads", () => {
  const count = safety.planPrRefreshesFromLedger as (lines: unknown[], prUrl: string) => { count: number; heads: string[] };
  assert.deepEqual(count([refreshRow("a"), refreshRow("b"), refreshRow("c", { pr_url: "x" }), { step: "other", pr_url: PR }], PR), {
    count: 2,
    heads: ["a", "b"],
  });
  assert.deepEqual(count([refreshRow("a", { prior_head_sha: undefined })], PR), { count: 1, heads: [] });
});

test("logArmAttribution carries the merge-safety basis, the reason and the refreshed heads", () => {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const log = (step: string, extra?: Record<string, unknown>) => void rows.push({ step, extra });
  logArmAttribution(log, "direct-merged", PR, "W1-T5748", "review", {}, undefined, { remedy: "direct-merge", planMergeSafe: "merged_tree" } as never);
  logArmAttribution(log, "plan-pr-held", PR, "W1-T5748", "review", {}, undefined, {
    remedy: "retry-later",
    reason: "plan_pr_refresh_bound",
    planMergeUnsafe: "the merged tree conflicts",
    refreshedHeads: ["a", "b"],
  } as never);
  assert.equal(rows.find((r) => r.step === "automerge.clean_status_direct_merge")?.extra?.plan_pr_merge_safe, "merged_tree");
  const held = rows.find((r) => r.step === "automerge.plan_pr_held")?.extra;
  assert.equal(held?.reason, "plan_pr_refresh_bound");
  assert.deepEqual(held?.refreshed_heads, ["a", "b"]);
  assert.equal(held?.plan_merge_unsafe, "the merged tree conflicts");
});

// ── the real reader: GitHub's compare reads plus a real `git merge-tree` ───────────────────────

const SHARD = "plan/tasks.d/W1-T1.yaml";
const BASE_SHARD = "- id: W1-T1\n  title: one\n  repo: remudero\n  type: implement\n  status: queued\n  attempts: 0\n";

function commitShard(seed: GitRepo, branch: string, text: string): string {
  seed.git("checkout", "-q", branch);
  writeFileSync(join(seed.dir, SHARD), text);
  seed.git("commit", "-qam", branch);
  return seed.git("rev-parse", "HEAD");
}

/** origin (bare) holding `main` and three PR heads off one base; `work` cloned before any of them. */
function planFixture() {
  const origin = gitRepo({ bare: true, kind: "w1t5748-origin" });
  const seed = gitRepo({ seedCommit: false, kind: "w1t5748-seed" });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(seed.dir, SHARD), BASE_SHARD);
  seed.git("add", "-A");
  seed.git("commit", "-qm", "base");
  const base = seed.git("rev-parse", "HEAD");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "main");
  const work = gitRepo({ cloneFrom: origin.dir, kind: "w1t5748-work" });
  for (const b of ["dup", "loads", "conflict"]) seed.git("branch", b, base);
  const main = commitShard(seed, "main", BASE_SHARD.replace("  status:", "  priority: 1\n  status:"));
  const dup = commitShard(seed, "dup", `${BASE_SHARD}  priority: 2\n`);
  const loads = commitShard(seed, "loads", `${BASE_SHARD}  budget_usd: 3\n`);
  const conflict = commitShard(seed, "conflict", BASE_SHARD.replace("  status: queued", "  status: blocked"));
  seed.git("push", "-q", "origin", "main", `${dup}:refs/pull/1/head`, `${loads}:refs/pull/2/head`, `${conflict}:refs/pull/3/head`);
  const cleanup = () => [origin, seed, work].forEach((r) => r.cleanup());
  return { origin, seed, work: work.dir, base, main, heads: { 1: dup, 2: loads, 3: conflict } as Record<number, string>, cleanup };
}

function restFor(repos: ReturnType<typeof planFixture>, prNumber: number, mainFiles: unknown = [{ filename: SHARD }]) {
  const head = repos.heads[prNumber];
  return (args: string[]): unknown => {
    const path = args[1];
    if (path === `repos/o/r/pulls/${prNumber}`) return { base: { ref: "main" }, head: { sha: head } };
    if (path === `repos/o/r/compare/main...${head}`) {
      return { base_commit: { sha: repos.main }, merge_base_commit: { sha: repos.base }, files: [{ filename: SHARD }, { filename: "src/x.ts" }] };
    }
    if (path === `repos/o/r/compare/${repos.base}...${repos.main}`) return { files: mainFiles };
    throw new Error(`unrouted ${path}`);
  };
}

test("the real reader merges the PR head into main with git and loads the merged plan", async () => {
  const repos = planFixture();
  try {
    const read = (n: number, mainFiles?: unknown) =>
      runStepsSync(safety.readPlanMergeSafetySteps({ owner: "o", repo: "r", prNumber: n }, restFor(repos, n, mainFiles), safety.planSafetyGitSync(repos.work)));

    // #8871's shape: git joins two `priority:` lines into one shard, and the plan refuses it.
    const dup = read(1);
    assert.deepEqual(dup.prPlanPaths, [SHARD]);
    assert.equal(dup.mergedTree.state, "quarantined");
    assert.deepEqual(dup.mergedTree.ids, ["W1-T1"]);

    const loads = await runStepsAsync(
      safety.readPlanMergeSafetySteps({ owner: "o", repo: "r", prNumber: 2 }, restFor(repos, 2), safety.planSafetyGitAsync(repos.work)),
    );
    assert.deepEqual(loads.mergedTree, { state: "loads" });

    assert.equal(read(3).mergedTree.state, "conflict");

    // Disjoint paths still read the merged tree (W1-T5780): the paths are evidence, never a basis.
    const disjoint = read(1, [{ filename: "plan/tasks.d/W1-T2.yaml", previous_filename: "plan/tasks.d/W1-T0.yaml" }]);
    assert.deepEqual(disjoint.mainPlanPaths, ["plan/tasks.d/W1-T2.yaml", "plan/tasks.d/W1-T0.yaml"]);
    assert.equal(disjoint.mergedTree.state, "quarantined");

    // Unreadable file lists: an empty or a full (truncated) compare proves nothing.
    assert.equal(read(1, []).mainPlanPaths, undefined);
    assert.equal(read(1, Array.from({ length: 300 }, (_, i) => ({ filename: `src/f${i}.ts` }))).mainPlanPaths, undefined);
    // A main tip git cannot reach is unreadable, never safe.
    const ghost = runStepsSync(
      safety.readPlanMergeSafetySteps({ owner: "o", repo: "r", prNumber: 1 }, (args: string[]) =>
        String(args[1]).includes("compare/main")
          ? { base_commit: { sha: "f".repeat(40) }, merge_base_commit: { sha: repos.base }, files: [{ filename: SHARD }] }
          : String(args[1]).includes("compare/") ? { files: [{ filename: SHARD }] } : restFor(repos, 1)(args), safety.planSafetyGitSync(repos.work)),
    );
    assert.equal(ghost.mergedTree.state, "unreadable");
  } finally {
    repos.cleanup();
  }
});

test("the real reader names each unreadable REST input and a broken merged monolith", () => {
  const read = (rest: (args: string[]) => unknown, git: unknown = () => ({ status: 0, stdout: "" })) =>
    runStepsSync(safety.readPlanMergeSafetySteps({ owner: "o", repo: "r", prNumber: 7 }, rest, git));
  assert.match(read(() => {
    throw new Error("HTTP 502");
  }).error, /HTTP 502/);
  assert.match(read(() => ({})).error, /no base ref or head sha/);
  const pr = { base: { ref: "main" }, head: { sha: HEAD } };
  assert.match(read((a) => (String(a[1]).endsWith("/pulls/7") ? pr : { files: [] })).error, /no merge base or main tip/);
  assert.match(read((a) => {
    if (String(a[1]).endsWith("/pulls/7")) return pr;
    throw new Error("compare 404");
  }).error, /compare 404/);
  const twoReads = (second: () => unknown) => (a: string[]) =>
    String(a[1]).endsWith("/pulls/7") ? pr : String(a[1]).includes("compare/main") ? { base_commit: { sha: "m" }, merge_base_commit: { sha: "b" }, files: [{ filename: "plan/x" }] } : second();
  assert.match(read(twoReads(() => {
    throw new Error("second compare 500");
  })).error, /second compare 500/);

  // A merged tree whose monolith does not parse is refused, never "loads".
  const tree = "a".repeat(40);
  const fakeGit = (args: readonly string[]) => {
    if (args[0] === "merge-tree") return { status: 0, stdout: `${tree}\n` };
    if (args[0] === "ls-tree") return { status: 0, stdout: "" };
    if (args[0] === "cat-file" && args[1] === "--batch") return { status: 0, stdout: `${tree} blob 4\n{a:\n\n` };
    return { status: 0, stdout: "" };
  };
  const refused = read(twoReads(() => ({ files: [{ filename: "plan/x" }] })), fakeGit);
  assert.equal(refused.mergedTree.state, "refused");
  // merge-tree exiting neither 0 nor 1, or with no tree, is unreadable.
  const broken = read(twoReads(() => ({ files: [{ filename: "plan/x" }] })), (args: readonly string[]) =>
    args[0] === "merge-tree" ? { status: 128, stdout: "" } : { status: 0, stdout: "" });
  assert.equal(broken.mergedTree.state, "unreadable");
  const lsFails = read(twoReads(() => ({ files: [{ filename: "plan/x" }] })), (args: readonly string[]) =>
    args[0] === "merge-tree" ? { status: 0, stdout: `${tree}\n` } : args[0] === "ls-tree" ? { status: 128, stdout: "" } : { status: 0, stdout: "" });
  assert.equal(lsFails.mergedTree.state, "unreadable");
  const catFails = read(twoReads(() => ({ files: [{ filename: "plan/x" }] })), (args: readonly string[]) =>
    args[0] === "merge-tree" ? { status: 0, stdout: `${tree}\n` } : args[0] === "cat-file" && args[1] === "--batch" ? { status: 0, stdout: `${tree} missing\n` } : { status: 0, stdout: "" });
  assert.equal(catFails.mergedTree.state, "unreadable");
  const gitThrows = read(twoReads(() => ({ files: [{ filename: "plan/x" }] })), () => {
    throw new Error("spawn git ENOENT");
  });
  assert.match(gitThrows.mergedTree.error, /ENOENT/);
});

test("realArmDeps wires the reader through gh and the repo clone under config.root", async () => {
  const repos = planFixture();
  const root = repos.seed.dir;
  const oldPath = process.env.PATH;
  try {
    mkdirSync(join(root, "cfg", "repos"), { recursive: true });
    repos.seed.git("clone", "-q", repos.origin.dir, join(root, "cfg", "repos", "remudero"));
    const head = repos.heads[2];
    const shim = ghShim(
      [
        { when: `compare/${repos.base}...${repos.main}`, stdout: JSON.stringify({ files: [{ filename: SHARD }] }) },
        { when: `compare/main...${head}`, stdout: JSON.stringify({ base_commit: { sha: repos.main }, merge_base_commit: { sha: repos.base }, files: [{ filename: SHARD }] }) },
        { when: "pulls/2", stdout: JSON.stringify({ base: { ref: "main" }, head: { sha: head } }) },
      ],
      { kind: "w1t5748" },
    );
    process.env.PATH = `${shim.dir}:${oldPath}`;
    const config = (() => ({ root: join(root, "cfg") })) as never;
    const url = "https://github.com/craigoley/remudero/pull/2";
    const sync = realArmDeps(config) as unknown as { readPlanMergeSafety: (u: string) => any };
    assert.deepEqual(sync.readPlanMergeSafety(url).mergedTree, { state: "loads" }, "the PR head and main are fetched from origin");
    assert.match(sync.readPlanMergeSafety("not-a-pr-url").error, /cannot resolve/);
    const asyncDeps = realArmDepsAsync(config) as unknown as { readPlanMergeSafety: (u: string) => Promise<any> };
    assert.deepEqual((await asyncDeps.readPlanMergeSafety(url)).mergedTree, { state: "loads" });
    assert.match((await asyncDeps.readPlanMergeSafety("not-a-pr-url")).error, /cannot resolve/);
    const noConfig = realArmDeps((() => {
      throw new Error("no config");
    }) as never) as unknown as { readPlanMergeSafety: (u: string) => any };
    assert.match(noConfig.readPlanMergeSafety(url).error, /no config/);
  } finally {
    process.env.PATH = oldPath;
    repos.cleanup();
  }
});
