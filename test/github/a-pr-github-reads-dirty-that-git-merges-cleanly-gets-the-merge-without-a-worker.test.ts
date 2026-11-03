import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import * as sweep from "#src/lib/sweep.js";
import { probeMerge, type MergeProbeGit } from "#src/lib/merge-probe.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";

const LINES = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"];

/**
 * A run branch that edits a.ts, and a main that either renames a.ts to b.ts with an edit of its own ("rename", which git's
 * ort merge follows and a rename-blind merge does not) or edits the same line ("both", a real conflict).
 */
async function fixture(t: TestContext, kind: "rename" | "both" = "rename") {
  const origin = gitRepo({ bare: true });
  const repo = gitRepo();
  t.after(() => { repo.cleanup(); origin.cleanup(); });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  repo.addRemote("origin", origin.dir);
  const write = (path: string, lines: readonly string[]) => writeFileSync(join(repo.dir, path), `${lines.join("\n")}\n`);
  write("a.ts", LINES);
  write("other.txt", ["base"]);
  repo.git("add", ".");
  repo.git("commit", "-qm", "chore(test): seed");
  const branch = "run-W1-T11167-1793666131000";
  repo.git("checkout", "-qb", branch);
  write("a.ts", LINES.map(line => line === "l2" ? "l2-head" : line));
  repo.git("commit", "-qam", "chore(test): edit head");
  const headSha = repo.git("rev-parse", "HEAD");
  repo.git("push", "-q", "origin", branch);
  repo.git("checkout", "-q", "main");
  if (kind === "rename") {
    repo.git("mv", "a.ts", "b.ts");
    write("b.ts", LINES.map(line => line === "l9" ? "l9-main" : line));
  } else write("a.ts", LINES.map(line => line === "l2" ? "l2-main" : line));
  repo.git("add", ".");
  repo.git("commit", "-qm", "chore(test): edit main");
  repo.git("push", "-q", "origin", "main");
  const mainSha = repo.git("rev-parse", "HEAD");
  const git: MergeProbeGit = (args) => {
    try { return { status: 0, stdout: repo.git(...args) }; }
    catch (error) { return { status: (error as { status: number }).status, stdout: String((error as { stdout: string }).stdout) }; }
  };
  const probe = await probeMerge({ headSha, mainSha, git });
  const ledger: Record<string, unknown>[] = [{ step: "sweep.merge_probe", pr_number: 11167,
    head_sha: headSha, main_sha: mainSha, verdict: probe.verdict,
    conflict_paths: probe.verdict === "conflict" ? probe.paths : [] }];
  let workers = 0;
  let admissions = 0;
  let attempts = 0;
  const view = (head: string): sweep.OpenPrView => ({
    prNumber: 11167, prUrl: "https://github.com/example/fixture/pull/11167", taskId: "W1-T11167",
    headRefName: branch, headSha: head, mergeState: "dirty", mergeableState: "dirty", checksState: "none", reviewState: "none",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(), autoMergeArmed: false,
    mergeConflict: { files: [{ path: "a.ts", oursDeleted: 1, theirsDeleted: 1 }], oursLog: "head", theirsLog: "main" },
  });
  const deps: sweep.SweepDeps = {
    ledgerPath: join(repo.dir, "ledger.ndjson"), runId: "clean-merge-test",
    readLedger: () => ledger, appendLine: (_path, row) => { ledger.push(row); },
    arm: () => assert.fail("a conflicted PR cannot arm"), close: () => assert.fail("cannot close"),
    escalate: () => assert.fail("cannot escalate"), readMainTip: () => mainSha,
    dispatchFix: () => { workers++; }, claimFixAdmission: () => { admissions++; return { admitted: true }; },
    readActiveWorkerCount: () => 0, readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
    regenerateConflict: (pr, main, mode) => {
      attempts++;
      return sweep.regenerateConflictViaGit(repo.dir, join(repo.dir, "resolution"), pr, main, { ...(mode ? { mode } : {}) });
    },
  };
  const run = (pr: sweep.OpenPrView = view(headSha)) => withLiveWritesAllowed(async () => {
    const result = await sweep.runSweep([pr], deps);
    await sweep.drainDetachedSweepActions();
    return result;
  });
  const receipts = () => ledger.filter(row => row.step === "sweep.conflict_regenerated");
  const remoteHead = () => origin.git("rev-parse", `refs/heads/${branch}`);
  return { repo, origin, branch, headSha, mainSha, probe, git, ledger, deps, view, run, receipts, remoteHead,
    counts: () => ({ workers, admissions, attempts }) };
}

test("W1-T11167 criterion 1: a PR GitHub reads dirty that git merges cleanly across a rename main made gets git's merge pushed, with no worker", async (t) => {
  const f = await fixture(t);
  assert.equal(f.probe.verdict, "clean", "git's ort merge follows the rename");
  // `merge-tree -X` needs git >= 2.40, so the rename-blind control is a real merge in a scratch worktree.
  const scratch = `${f.repo.dir}-blind`;
  f.repo.git("worktree", "add", "-q", "--detach", scratch, f.headSha);
  t.after(() => { rmSync(scratch, { recursive: true, force: true }); });
  const blind = spawnSync("git", ["-C", scratch, "merge", "-s", "ort", "-X", "no-renames", "--no-commit", "--no-ff", f.mainSha],
    { encoding: "utf8" });
  assert.equal(blind.status, 1, `positive control: a rename-blind merge conflicts, as GitHub's did on #15602: ${blind.stderr}`);
  assert.ok(spawnSync("git", ["-C", scratch, "ls-files", "-u"], { encoding: "utf8" }).stdout.includes("a.ts"),
    "the rename-blind conflict is on a.ts");
  spawnSync("git", ["-C", scratch, "merge", "--abort"]);
  f.repo.git("worktree", "remove", "--force", scratch);
  f.deps.claimFixAdmission = () => assert.fail("the clean-merge route takes no fix capacity");
  await f.run();
  const head = f.remoteHead();
  assert.notEqual(head, f.headSha);
  assert.deepEqual(f.origin.git("rev-list", "--parents", "-1", head).split(" "), [head, f.headSha, f.mainSha],
    "a two-parent merge whose first parent is the PR's head");
  assert.match(f.origin.git("show", "-s", "--format=%B", head), /^Remudero-Task: W1-T11167$/m);
  assert.equal(f.origin.git("ls-tree", "-r", "--name-only", head, "--", "a.ts"), "", "the rename is followed");
  assert.deepEqual(f.origin.git("show", `${head}:b.ts`).split("\n"),
    LINES.map(line => line === "l2" ? "l2-head" : line === "l9" ? "l9-main" : line), "both sides' edits land on the renamed file");
  assert.equal(f.origin.git("rev-parse", `${head}^{tree}`),
    f.probe.verdict === "clean" ? f.probe.tree : "", "the pushed tree is exactly git's merge-tree result");
  assert.deepEqual(f.counts(), { workers: 0, admissions: 0, attempts: 1 });
  const [receipt] = f.receipts();
  assert.equal(receipt!.outcome, "pushed", String(receipt!.reason));
  assert.equal(receipt!.mode, "clean-merge");
  assert.equal(receipt!.new_head_sha, head);
  assert.equal(existsSync(join(f.repo.dir, "resolution")), false, "the detached worktree is removed");
});

test("W1-T11167 criterion 2: a moved head or main, a wrong or missing probe, and an unmerged local merge push nothing", async (t) => {
  for (const moved of ["head", "main"] as const) {
    const f = await fixture(t);
    f.deps.regenerateConflict = (pr, main, mode) => {
      f.repo.git("checkout", "-q", moved === "head" ? f.branch : "main");
      writeFileSync(join(f.repo.dir, "other.txt"), `${moved} moved\n`);
      f.repo.git("commit", "-qam", `chore(test): ${moved} moves`);
      f.repo.git("push", "-q", "origin", moved === "head" ? f.branch : "main");
      f.repo.git("checkout", "-q", "main");
      return sweep.regenerateConflictViaGit(f.repo.dir, join(f.repo.dir, "resolution"), pr, main, { ...(mode ? { mode } : {}) });
    };
    await f.run();
    assert.equal(f.receipts()[0]!.outcome, "lease-mismatch", moved);
    const remote = f.remoteHead();
    if (moved === "main") assert.equal(remote, f.headSha, "main moved: the branch is untouched");
    else assert.equal(f.origin.git("rev-parse", `${remote}^`), f.headSha, "head moved: only the mover's own commit is there");
    assert.equal(f.origin.git("rev-list", "--parents", "-1", remote).split(" ").length, 2, `${moved}: no merge was pushed`);
    assert.equal(f.counts().workers, 0, `${moved}: a lease mismatch waits for a fresh snapshot`);
  }
  for (const change of ["other-main", "missing", "unreadable"] as const) {
    const f = await fixture(t);
    if (change === "other-main") f.ledger[0]!.main_sha = "0".repeat(40);
    if (change === "missing") f.ledger.length = 0;
    if (change === "unreadable") f.ledger[0]!.verdict = "unreadable";
    await f.run();
    assert.equal(f.remoteHead(), f.headSha, change);
    assert.deepEqual(f.counts(), { workers: 1, admissions: 1, attempts: 0 }, `${change}: today's conflicted worker row`);
    assert.equal(f.receipts().length, 0, change);
  }
  const f = await fixture(t, "both");
  assert.equal(f.probe.verdict, "conflict", "positive control: both sides edited one line");
  f.ledger[0]!.verdict = "clean";
  f.ledger[0]!.conflict_paths = [];
  await f.run();
  assert.equal(f.remoteHead(), f.headSha, "a merge that leaves an unmerged path is never pushed");
  assert.equal(f.receipts()[0]!.outcome, "fell-through");
  assert.match(String(f.receipts()[0]!.reason), /^the local merge left unmerged paths: a\.ts$/, "the clean-merge fence names it");
  assert.deepEqual(f.counts(), { workers: 1, admissions: 1, attempts: 1 }, "the PR reaches the worker row unchanged");
  assert.equal(existsSync(join(f.repo.dir, "resolution")), false);
});

test("W1-T11167 criterion 3: one clean-merge attempt per head and main, recording what it overrode and the renames it followed", async (t) => {
  const f = await fixture(t);
  await f.run();
  const [receipt] = f.receipts();
  assert.equal(receipt!.mode, "clean-merge");
  assert.equal(receipt!.github_mergeable_state, "dirty");
  assert.deepEqual(receipt!.renames, [{ from: "a.ts", to: "b.ts" }], "the rename pair on a path the head changed");
  assert.equal(receipt!.head_sha, f.headSha);
  assert.equal(receipt!.main_sha, f.mainSha);
  const pushed = f.remoteHead();
  assert.equal(receipt!.new_head_sha, pushed);
  await f.run();
  assert.deepEqual(f.counts(), { workers: 0, admissions: 0, attempts: 1 }, "a stale snapshot at the same head and main never attempts again");
  f.ledger.push({ step: "sweep.merge_probe", pr_number: 11167, head_sha: pushed, main_sha: f.mainSha, verdict: "clean", conflict_paths: [] });
  await f.run(f.view(pushed));
  assert.equal(f.remoteHead(), pushed, "the merged head is never re-merged");
  assert.deepEqual(f.counts(), { workers: 1, admissions: 1, attempts: 1 }, "GitHub still dirty at the same main: the worker row runs");
  assert.equal(f.receipts().length, 1);
});
