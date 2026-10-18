// Feedback-landing PR #11901 (10 operator answers, plan/feedback/* only) was open 3h42m on 2026-10-15 and
// its head was replaced four times. Three of those were the direct-merge preflight's update-branch:
// - 04:03Z and 05:53Z: `plan_pr_behind` because "the merged tree was unreadable: git cat-file --batch
//   output ended before <tree>:plan/tasks.d/...". Every one of the 25 plan_pr_behind refreshes on
//   10-12..10-15 had that cause, all on the daemon's async runner, none on a review run's sync one: the
//   read was cut short, the plan was never found unsafe, and a refresh cannot make a read succeed.
// - 03:53Z: W1-T9536's `main_changed_own_files` with own_files_cause "baseline" (ci.yml, package.json,
//   package-lock.json), though the PR has no file outside plan/. Four plan-only PRs took it that day.
// An unread merged tree is now re-read on the next pass, and refreshed only when it stays unread on the
// same head; a PR with no non-plan file of its own is judged by its merged-plan load alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { attemptArm, attemptArmAsync, logArmAttribution, type ArmDeps } from "#src/lib/arm-auto-merge.js";
import { runStepsSync as runSync } from "#src/lib/git-push.js";
import * as safetyModule from "#src/lib/plan-pr-merge-safety.js";

const safety = safetyModule as unknown as Record<string, any>;
const runStepsSync = (steps: unknown): any => runSync(steps as never);

const PR = "https://github.com/craigoley/remudero/pull/11901";
const HEAD = "c47073ef517af872c3adade18b5e961a3091f63c";
const CLEAN = "Pull request is in clean status";
const BEHIND = { mergeable: "MERGEABLE", behindBy: 1, mergeableState: "clean" };
const CUT_SHORT = "git cat-file --batch output ended before 88a67cdee376e810822581367ae0f28db3b67b16:plan/tasks.d/W1-T7853.yaml";

function harness(readings: () => unknown, ledger: Array<Record<string, unknown>> = []) {
  const calls: string[] = [];
  const deps: Record<string, unknown> = {
    headSha: () => HEAD,
    ledgerLines: () => ledger,
    armAuto: () => {
      calls.push("armAuto");
      throw Object.assign(new Error("boom"), { stderr: CLEAN });
    },
    mergeDirect: () => void calls.push("mergeDirect"),
    disableAuto: () => {},
    isMerged: () => false,
    readMergeFacts: () => BEHIND,
    updateBranch: () => {
      calls.push("updateBranch");
      return { ok: true };
    },
    readPlanTouch: () => "touched",
    readPlanMergeSafety: () => readings(),
    say: () => {},
  };
  return { deps: deps as unknown as ArmDeps, calls };
}

/** The rows logArmAttribution writes for one arm result: what the next pass reads back as memory. */
function rowsOf(result: ReturnType<typeof attemptArm>): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  logArmAttribution((step, extra) => void rows.push({ step, ...extra }), result.outcome, PR, "PR-11901", "sweep", {}, undefined, result.directMergePreflight);
  return rows;
}

const unreadTree = () => ({ prPlanPaths: ["plan/feedback/fb-1.yaml"], mainPlanPaths: [], mergedTree: { state: "unreadable", error: CUT_SHORT } });

test("a behind plan PR whose merged tree git could not read is re-read next pass, not refreshed", async () => {
  const { deps, calls } = harness(unreadTree);
  const result = await attemptArmAsync(PR, deps as never, HEAD);
  assert.equal(result.outcome, "direct-merge-preflight-refused");
  assert.ok(!calls.includes("updateBranch") && !calls.includes("mergeDirect"), "a read that failed must not move the head");
  assert.equal(result.directMergePreflight?.remedy, "retry-later");
  assert.equal(result.directMergePreflight?.reason, "plan_merge_unread");
  assert.match(String(result.directMergePreflight?.planMergeUnsafe), /output ended before/);
  const row = rowsOf(result).find((r) => r.step === "automerge.direct_merge_preflight_refused");
  assert.equal(row?.reason, "plan_merge_unread");
  assert.equal(row?.prior_head_sha, HEAD);
});

test("a head whose merged tree stays unread on the next pass is refreshed, as before", () => {
  const first = harness(unreadTree);
  const memory = rowsOf(attemptArm(PR, first.deps, HEAD));
  const second = harness(unreadTree, memory);
  const result = attemptArm(PR, second.deps, HEAD);
  assert.equal(result.outcome, "direct-merge-updated");
  assert.deepEqual(second.calls, ["updateBranch"]);
  assert.equal(result.directMergePreflight?.reason, "plan_pr_behind");
  // a read that failed on an OLDER head says nothing about this one.
  const moved = harness(unreadTree, memory.map((r) => ({ ...r, prior_head_sha: "b72b9c08efac9ef716dee9db7373d8f839fb1045" })));
  assert.equal(attemptArm(PR, moved.deps, HEAD).outcome, "direct-merge-preflight-refused");
  // a merged plan that was READ and found unsafe still refreshes at once.
  const unsafe = harness(() => ({ mergedTree: { state: "quarantined", ids: ["W1-T1"] } }));
  assert.equal(attemptArm(PR, unsafe.deps, HEAD).outcome, "direct-merge-updated");
});

test("a plan-only landing PR whose merged plan loads merges as-is when main changed package.json and ci.yml", () => {
  // #11901 at 03:53Z: no own file outside plan/, main's baseline paths since the merge base.
  const mainFiles = { files: [".github/workflows/ci.yml", "package-lock.json", "package.json", "plan/feedback/fb-2.yaml"], truncated: false };
  const { deps, calls } = harness(() => ({ mergedTree: { state: "loads" }, ownFiles: { prFiles: [], mainFiles } }));
  const result = attemptArm(PR, deps, HEAD);
  assert.equal(result.outcome, "direct-merged");
  assert.deepEqual(calls, ["mergeDirect"]);
  assert.equal(result.directMergePreflight?.planMergeSafe, "merged_tree");
  // even a main list GitHub cut short cannot hide an overlap with no files.
  assert.equal(safety.mainChangedOwnFiles({ prFiles: [], mainFiles: { files: ["package.json"], truncated: true } }), undefined);
  // a PR that does carry a file of its own still refreshes on a baseline change (W1-T9536).
  assert.deepEqual(safety.mainChangedOwnFiles({ prFiles: ["src/lib/drain.ts"], mainFiles }), {
    cause: "baseline",
    files: [".github/workflows/ci.yml", "package-lock.json", "package.json"],
  });
  assert.equal(safety.mainChangedOwnFiles({ prFiles: [], error: "HTTP 502" })?.cause, "unread");
});

test("a cat-file --batch the runner cut short reads as unreadable and names its exit", () => {
  const tree = "a".repeat(40);
  const pr = { base: { ref: "main" }, head: { sha: HEAD } };
  const rest = (a: string[]) =>
    String(a[1]).endsWith("/pulls/11901") ? pr
      : String(a[1]).includes("compare/main") ? { base_commit: { sha: "m" }, merge_base_commit: { sha: "b" }, files: [{ filename: "plan/feedback/x.yaml" }] }
      : { files: [{ filename: "plan/tasks.d/W1-T1.yaml" }] };
  // a killed child: no exit status, and a blob header whose body never arrived.
  const git = (args: readonly string[]) =>
    args[0] === "merge-tree" ? { status: 0, stdout: `${tree}\n` }
      : args[0] === "ls-tree" ? { status: 0, stdout: "plan/tasks.d/W1-T1.yaml\n" }
      : args[0] === "cat-file" && args[1] === "--batch" ? { status: null, stdout: `${tree} blob 9000\n- id: W1-T1\n` }
      : { status: 0, stdout: "" };
  const read = runStepsSync(safety.readPlanMergeSafetySteps({ owner: "craigoley", repo: "remudero", prNumber: 11901 }, rest, git));
  assert.equal(read.mergedTree.state, "unreadable");
  assert.match(read.mergedTree.error, /cat-file --batch exited null/);
  assert.equal(safety.mergedTreeUnread(read), true);
  assert.equal(safety.mergedTreeUnread({ error: "HTTP 502", mergedTree: { state: "unreadable", error: "x" } }), false);
});
