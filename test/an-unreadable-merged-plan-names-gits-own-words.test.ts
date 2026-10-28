/**
 * W1-T9670 — AN UNREADABLE MERGED PLAN NAMES GIT'S OWN WORDS.
 *
 * 40 plan_merge_unsafe rows since 2026-10-14 read "the merged tree was unreadable: git cat-file --batch exited
 * null/128 (killed or failed mid-read)". planSafetyGitAsync dropped git's stderr and the kill signal, so a
 * refusal could not say whether the child was killed by its bound, git failed, or the read came back short.
 * The reading now names the verb, the signal or status, and git's stderr tail, and the ledger rows carry
 * `git_stderr`. decidePlanPrMergeSafety's refresh decision is unchanged.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { attemptArm, logArmAttribution, type ArmDeps } from "../src/lib/arm-auto-merge.js";
import { runStepsAsync, runStepsSync } from "../src/lib/git-push.js";
import * as safety from "../src/lib/plan-pr-merge-safety.js";
import type { PlanMergeSafetyReadings, PlanSafetyGit, PlanSafetyGitResult } from "../src/lib/plan-pr-merge-safety.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const PR = "https://github.com/craigoley/remudero/pull/11995";
const TARGET = { owner: "craigoley", repo: "remudero", prNumber: 11995 };
const HEAD = "c47073ef517af872c3adade18b5e961a3091f63c";
const TREE = "a".repeat(40);
const NO_REFRESHES = { count: 0, heads: [] };
// A namespace read, so a reader this suite pins but the base lacks fails its assertion, not the import.
const { decidePlanPrMergeSafety, planSafetyGitAsync, planSafetyGitSync, readPlanMergeSafetySteps } = safety;
const mergedTreeGitStderr = (r: PlanMergeSafetyReadings): string | undefined =>
  (safety as { mergedTreeGitStderr?: (r: PlanMergeSafetyReadings) => string | undefined }).mergedTreeGitStderr?.(r);

/** The pull row and both compares, for any main tip and head. */
function restFor(mainTip: string, head: string) {
  return (a: string[]) =>
    String(a[1]).endsWith("/pulls/11995") ? { base: { ref: "main" }, head: { sha: head } }
      : String(a[1]).includes("compare/main") ? { base_commit: { sha: mainTip }, merge_base_commit: { sha: mainTip }, files: [{ filename: "plan/feedback/x.yaml" }] }
      : { files: [{ filename: "plan/tasks.d/W1-T1.yaml" }] };
}

/** A fake clone: every step succeeds unless `over` names its verb. */
function fakeGit(over: Partial<Record<"fetch" | "merge-tree" | "ls-tree" | "batch", PlanSafetyGitResult>>, missing = false): PlanSafetyGit {
  return (args) => {
    if (args[0] === "cat-file" && args[1] === "-e") return { status: missing ? 1 : 0, stdout: "" };
    if (args[0] === "fetch") return over.fetch ?? { status: 0, stdout: "" };
    if (args[0] === "merge-tree") return over["merge-tree"] ?? { status: 0, stdout: `${TREE}\n` };
    if (args[0] === "ls-tree") return over["ls-tree"] ?? { status: 0, stdout: `100644 blob ${"1".repeat(40)}\tplan/tasks.d/W1-T1.yaml\n` };
    return over.batch ?? { status: 0, stdout: "" };
  };
}

function readWith(git: PlanSafetyGit): PlanMergeSafetyReadings {
  return runStepsSync(readPlanMergeSafetySteps(TARGET, restFor("m".repeat(40), HEAD), git));
}

function unreadable(r: PlanMergeSafetyReadings): { error: string; gitStderr?: string } {
  assert.equal(r.mergedTree?.state, "unreadable", JSON.stringify(r.mergedTree));
  return r.mergedTree as { error: string; gitStderr?: string };
}

function armHarness(reading: PlanMergeSafetyReadings, ledger: Array<Record<string, unknown>>) {
  const deps: Record<string, unknown> = {
    headSha: () => HEAD,
    ledgerLines: () => ledger,
    armAuto: () => { throw Object.assign(new Error("boom"), { stderr: "Pull request is in clean status" }); },
    mergeDirect: () => {},
    disableAuto: () => {},
    isMerged: () => false,
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 1, mergeableState: "clean" }),
    updateBranch: () => ({ ok: true }),
    readPlanTouch: () => "touched",
    readPlanMergeSafety: () => reading,
    say: () => {},
  };
  return deps as unknown as ArmDeps;
}

function rowsOf(result: ReturnType<typeof attemptArm>): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  logArmAttribution((step, extra) => void rows.push({ step, ...extra }), result.outcome, PR, "PR-11995", "sweep", {}, undefined, result.directMergePreflight);
  return rows;
}

test("W1-T9670: a signalled, a failed and a truncated batch read are told apart", () => {
  const signalled = unreadable(readWith(fakeGit({ batch: { status: null, signal: "SIGTERM", stdout: "", stderr: "" } })));
  const failed = unreadable(readWith(fakeGit({ batch: { status: 128, stdout: "", stderr: "fatal: bad object 0123abcd" } })));
  const truncated = unreadable(readWith(fakeGit({ batch: { status: 0, stdout: `${TREE} blob 7\nkey: v\n\n`, stderr: "" } })));

  assert.match(signalled.error, /^git cat-file --batch exited null, killed by SIGTERM \(its bound\)$/);
  assert.equal(signalled.gitStderr, undefined, "a kill with nothing on stderr carries no stderr");
  assert.equal(failed.error, "git cat-file --batch exited 128, git failed: fatal: bad object 0123abcd");
  assert.equal(failed.gitStderr, "fatal: bad object 0123abcd");
  assert.match(truncated.error, /^the batch read was truncated: git cat-file --batch output ended before /);
  assert.equal(new Set([signalled.error, failed.error, truncated.error]).size, 3, "three causes, three reasons");

  // An exit 0 that names a blob git could not read is unusable, not truncated; an unsignalled null keeps its words.
  const missing = unreadable(readWith(fakeGit({ batch: { status: 0, stdout: `${TREE}:plan/tasks.yaml missing\n`, stderr: "error: unable to unpack 0123abcd header" } })));
  assert.match(missing.error, /^the batch read was unusable: git cat-file --batch could not read .*: error: unable to unpack 0123abcd header$/);
  assert.match(unreadable(readWith(fakeGit({ batch: { status: null, stdout: "" } }))).error, /^git cat-file --batch exited null \(killed or failed mid-read\)$/);
  // Every git step names its own verb and git's words, not only the batch.
  assert.equal(unreadable(readWith(fakeGit({ "ls-tree": { status: 128, stdout: "", stderr: "fatal: not a tree object" } }))).error,
    "git ls-tree exited 128, git failed: fatal: not a tree object");
  assert.equal(unreadable(readWith(fakeGit({ "merge-tree": { status: 128, stdout: "", stderr: "fatal: refusing to merge unrelated histories" } }))).error,
    "git merge-tree exited 128, git failed: fatal: refusing to merge unrelated histories");
  assert.equal(unreadable(readWith(fakeGit({ fetch: { status: 128, stdout: "", stderr: "fatal: couldn't find remote ref" } }, true))).error,
    "git fetch main exited 128, git failed: fatal: couldn't find remote ref");
  assert.match(unreadable(readWith(fakeGit({}, true))).error, /is not in the clone after fetching main$/);

  // The decision is unchanged for all three: each refreshes, naming its own reason.
  for (const reading of [signalled, failed, truncated]) {
    const decision = decidePlanPrMergeSafety({ readings: { mergedTree: { state: "unreadable", ...reading } }, refreshes: NO_REFRESHES });
    assert.deepEqual(decision, { action: "refresh", why: `the merged tree was unreadable: ${reading.error}` });
  }

  // Every row that carries plan_merge_unsafe gains git_stderr: re-read, refreshed, then held at the bound.
  const reading = readWith(fakeGit({ batch: { status: 128, stdout: "", stderr: "fatal: bad object 0123abcd" } }));
  assert.equal(mergedTreeGitStderr(reading), "fatal: bad object 0123abcd");
  const refused = rowsOf(attemptArm(PR, armHarness(reading, []), HEAD));
  const refusedRow = refused.find((r) => r.step === "automerge.direct_merge_preflight_refused");
  assert.equal(refusedRow?.git_stderr, "fatal: bad object 0123abcd");
  assert.match(String(refusedRow?.plan_merge_unsafe), /exited 128, git failed: fatal: bad object/);
  const updated = rowsOf(attemptArm(PR, armHarness(reading, refused), HEAD)).find((r) => r.step === "automerge.direct_merge_updated");
  assert.equal(updated?.reason, "plan_pr_behind");
  assert.equal(updated?.git_stderr, "fatal: bad object 0123abcd");
  const bound = [1, 2, 3].map((i) => ({ step: "automerge.direct_merge_updated", reason: "plan_pr_behind", pr_url: PR, prior_head_sha: `${i}`.repeat(40) }));
  const held = rowsOf(attemptArm(PR, armHarness(reading, bound), HEAD));
  assert.deepEqual(held.map((r) => [r.step, r.git_stderr]), [
    ["automerge.arm_skipped", "fatal: bad object 0123abcd"],
    ["automerge.plan_pr_held", "fatal: bad object 0123abcd"],
  ]);
  // A reading git did not fail on carries no git_stderr field.
  const quarantined = rowsOf(attemptArm(PR, armHarness({ mergedTree: { state: "quarantined", ids: ["W1-T1"] } }, []), HEAD));
  assert.equal(quarantined.some((r) => "git_stderr" in r), false);
});

/** Main and a PR head that each add a shard, so merge-tree writes a new plan/tasks.d tree. */
function planFixture(t: TestContext): { repo: GitRepo; main: string; head: string } {
  const repo = gitRepo({ kind: "t9670" });
  t.after(() => repo.cleanup());
  const write = (rel: string, text: string) => {
    mkdirSync(join(repo.dir, rel, ".."), { recursive: true });
    writeFileSync(join(repo.dir, rel), text);
  };
  const commit = (rel: string, text: string, message: string) => {
    write(rel, text);
    repo.git("add", "plan");
    repo.git("commit", "-q", "-m", message);
  };
  write("plan/tasks.yaml", "tasks: []\n");
  commit("plan/tasks.d/W1-T1.yaml", "- id: W1-T1\n  title: one\n", "base");
  repo.git("checkout", "-q", "-b", "pr");
  commit("plan/tasks.d/W1-T2.yaml", "- id: W1-T2\n  title: two\n", "pr");
  const head = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "main");
  commit("plan/tasks.d/W1-T3.yaml", "- id: W1-T3\n  title: three\n", "main");
  return { repo, main: repo.git("rev-parse", "HEAD"), head };
}

function corruptLooseObject(repo: GitRepo, oid: string): void {
  const path = join(repo.dir, ".git", "objects", oid.slice(0, 2), oid.slice(2));
  // git writes loose objects read-only; replacing the file (its directory is writable) needs no mode change.
  rmSync(path);
  writeFileSync(path, "not a zlib stream");
}

test("W1-T9670: a real cat-file failure surfaces gits stderr in the unreadable reading", async (t) => {
  const { repo, main, head } = planFixture(t);
  // After ls-tree has listed it, the first blob the batch asks for (the monolith, by id) is corrupted under the batch.
  const real = planSafetyGitAsync(repo.dir);
  const corruptingBeforeBatch: PlanSafetyGit = (args, stdin) => {
    if (args[0] === "cat-file" && args[1] === "--batch") corruptLooseObject(repo, String(stdin).split("\n")[0]!);
    return real(args, stdin);
  };
  const reading = await runStepsAsync(readPlanMergeSafetySteps(TARGET, restFor(main, head), corruptingBeforeBatch));
  const tree = unreadable(reading);
  // asked by id, git reports a corrupt blob as `<id> missing` and exits 0; its stderr still says why.
  assert.match(tree.error, /^the batch read was unusable: .*\([0-9a-f]{40} missing\): .*unable to unpack [0-9a-f]{40} header/s);
  assert.match(String(tree.gitStderr), /unable to unpack [0-9a-f]{40} header/);
  assert.equal(mergedTreeGitStderr(reading), tree.gitStderr);

  // The sync runner says the same: the corrupted blob still fails the batch, in git's own words.
  const again = unreadable(runStepsSync(readPlanMergeSafetySteps(TARGET, restFor(main, head), planSafetyGitSync(repo.dir))));
  assert.match(again.error, /^the batch read was unusable: .*unable to unpack [0-9a-f]{40} header/s);
  const direct = planSafetyGitSync(repo.dir)(["cat-file", "-p", "0".repeat(40)]) as PlanSafetyGitResult;
  assert.equal(direct.status, 128);
  assert.equal(direct.signal, null);
  assert.match(String(direct.stderr), /fatal: /);
});
