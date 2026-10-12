import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pendingWorkerBoundaryHandoffs, handoffReceiptsToCarry } from "../src/lib/daemon.js";
import { DECLARED_BRANCH_GUARDS, reapBranchesCommand, restoreBoundaryCheckpoint } from "./helpers/run-task-test.js";
import { gitRepo } from "./helpers/git-repo.js";

const taskId = "W1-T8503";
const branch = `run-${taskId}-1`;
const sha = "a".repeat(40);
const receipt = (headSha = sha) => ({ task_id: taskId, step: "verdict", verdict: "handed_off",
  reason: "freshness_yield", branch, head_sha: headSha });
const lines = (rows: Record<string, unknown>[]) => rows.map((row) => JSON.stringify(row));

function reap(rows: Record<string, unknown>[], unreadable = false, prState = "none") {
  const repo = gitRepo();
  const ledgerPath = join(repo.dir, "ledger.ndjson");
  writeFileSync(ledgerPath, lines(rows).join("\n") + "\n");
  const heads = [branch, "run-W1-T99-2", "finished"];
  const deleted: string[] = [];
  const exec = (cmd: string, args: string[]): string => {
    if (args[0] === "ls-remote") return ["main", ...heads].map((name) => `${sha}\trefs/heads/${name}`).join("\n");
    if (args[0] === "for-each-ref") {
      if (args.includes("--merged=origin/main")) return heads.map((name) => `origin/${name}`).join("\n");
      return heads.map((name) => `origin/${name}\t${sha}\t1`).join("\n");
    }
    if (args[0] === "grep" && args.includes("-o")) return DECLARED_BRANCH_GUARDS.map((name) => `src/example.ts:1:${name}`).join("\n");
    if (args[0] === "grep") throw Object.assign(new Error("no citations"), { status: 1 });
    if (args[0] === "push") { deleted.push(...args.slice(3)); return ""; }
    if (cmd === "gh") {
      if (args[1]?.includes("state=all")) return prState === "none" ? "" : `${branch}\tclosed\t${prState === "merged"}`;
      if (args[1]?.includes("state=open")) return "";
      return "[]";
    }
    return "";
  };
  try {
    reapBranchesCommand(["--prune"], { exec, root: repo.dir, quiet: true, ownerRepo: { owner: "fixture", repo: "fixture" },
      ledgerPath, creditLedgerPath: unreadable ? repo.dir : ledgerPath });
    const report = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((raw) => JSON.parse(raw))
      .find((row) => row.step === "branch_reap.dry_run");
    return { deleted, report };
  } finally { repo.cleanup(); }
}

test("W1-T8503: the branch reap keeps a run branch a live handoff receipt names", () => {
  for (const state of ["none", "merged", "closed"]) {
    const result = reap([receipt()], false, state);
    assert.deepEqual(result.report.kept_handoff_receipt_branches, [branch]);
    assert.equal(result.deleted.includes(branch), false);
    assert.ok(result.deleted.includes("run-W1-T99-2"), "unrelated run heads remain reapable");
    assert.equal(result.report.reasons[branch], state === "none" ? "tip_in_main" : state === "merged" ? "merged" : "closed_unmerged");
  }
});

test("W1-T8503: an unreadable ledger keeps every run-shaped head", () => {
  const result = reap([], true);
  assert.deepEqual(result.report.kept_handoff_receipt_branches, [branch, "run-W1-T99-2"]);
  assert.deepEqual(result.deleted, ["finished"]);
});

test("W1-T8503: a consumed receipt no longer protects its branch", () => {
  for (const end of [
    { task_id: taskId, step: "verdict", verdict: "no_pr", reason: "completed" },
    { task_id: taskId, step: "implement.checkpoint_dropped", source_branch: branch, head_sha: sha, reason: "object unavailable" },
  ]) {
    const result = reap([receipt(), end]);
    assert.deepEqual(result.report.kept_handoff_receipt_branches, []);
    assert.ok(result.deleted.includes(branch));
  }
  const failed = reap([receipt(), { task_id: taskId, step: "verdict", verdict: "no_pr", reason: "restart_checkpoint_restore_failed" }]);
  assert.deepEqual(failed.report.kept_handoff_receipt_branches, [branch]);
});

function fixture(inMain = false) {
  const origin = gitRepo({ bare: true });
  const repo = gitRepo();
  repo.git("config", "user.name", "receipt fixture");
  repo.git("config", "user.email", "receipt@fixture.invalid");
  repo.addRemote("origin", origin.dir);
  repo.git("push", "--quiet", "origin", "main");
  repo.git("checkout", "--quiet", "-b", branch);
  if (!inMain) {
    writeFileSync(join(repo.dir, "paid-work.txt"), "checkpoint work\n");
    repo.git("add", "paid-work.txt");
    repo.git("commit", "--quiet", "-m", "wip: checkpoint work");
  }
  const headSha = repo.git("rev-parse", "HEAD");
  repo.git("push", "--quiet", "origin", branch);
  repo.git("checkout", "--quiet", "main");
  repo.git("commit", "--quiet", "--allow-empty", "-m", "fix(other): main advanced");
  repo.git("push", "--quiet", "origin", "main");
  origin.git("update-ref", "-d", `refs/heads/${branch}`);
  const fresh = gitRepo({ cloneFrom: `file://${origin.dir}` });
  fresh.git("config", "user.name", "receipt fixture");
  fresh.git("config", "user.email", "receipt@fixture.invalid");
  const rows: Record<string, unknown>[] = [];
  const log = (step: string, data: Record<string, unknown>) => { rows.push({ task_id: taskId, step, ...data }); };
  return { origin, repo: fresh, headSha, rows, log, cleanup: () => { fresh.cleanup(); repo.cleanup(); origin.cleanup(); } };
}

test("W1-T8503: a gone checkpoint branch whose head is in main resumes on main", async () => {
  const f = fixture(true);
  try {
    const main = f.repo.git("rev-parse", "HEAD");
    const restored = await restoreBoundaryCheckpoint({ branch, headSha: f.headSha }, taskId, async (args) => f.repo.git(...args), f.log);
    assert.equal(restored.base, "main");
    assert.equal(restored.headSha, main);
    assert.equal(restored.sourceBranchAbsent, true);
    assert.equal(f.repo.git("rev-parse", "HEAD"), main);
    assert.deepEqual(f.rows, []);
    assert.equal(f.repo.git("ls-remote", "origin", `refs/heads/${branch}`), "");
  } finally { f.cleanup(); }
});

test("W1-T8503: a gone checkpoint branch with a fetchable head is recreated", async () => {
  const f = fixture();
  try {
    const calls: string[][] = [];
    const restored = await restoreBoundaryCheckpoint({ branch, headSha: f.headSha }, taskId, async (args) => {
      calls.push(args); return f.repo.git(...args);
    }, f.log);
    assert.equal(restored.base, "main");
    assert.equal(restored.sourceBranchAbsent, true);
    assert.match(f.repo.git("ls-remote", "origin", `refs/heads/${branch}`), new RegExp(`^${f.headSha}`));
    assert.equal(readFileSync(join(f.repo.dir, "paid-work.txt"), "utf8"), "checkpoint work\n");
    f.repo.git("merge-base", "--is-ancestor", f.headSha, "HEAD");
    assert.ok(calls.some((args) => args.includes(`--force-with-lease=refs/heads/${branch}:`)));
    assert.deepEqual(f.rows, [{ task_id: taskId, step: "implement.checkpoint_branch_recreated", source_branch: branch, head_sha: f.headSha }]);
  } finally { f.cleanup(); }
});

test("W1-T8503: an unfetchable checkpoint is dropped once and the run starts fresh", async () => {
  const f = fixture();
  try {
    f.origin.git("reflog", "expire", "--expire=now", "--all");
    f.origin.git("gc", "--prune=now");
    assert.throws(() => f.origin.git("cat-file", "-e", f.headSha), "the origin really lost the checkpoint object");
    const main = f.repo.git("rev-parse", "HEAD");
    const restored = await restoreBoundaryCheckpoint({ branch, headSha: f.headSha }, taskId, async (args) => f.repo.git(...args), f.log);
    assert.equal(restored.base, "main");
    assert.equal(restored.dropped, true);
    assert.equal(f.repo.git("rev-parse", "HEAD"), main);
    assert.equal(f.rows.length, 1);
    assert.equal(f.rows[0]?.step, "implement.checkpoint_dropped");
    assert.equal(f.rows[0]?.source_branch, branch);
    assert.equal(f.rows[0]?.head_sha, f.headSha);
    assert.ok(f.rows[0]?.reason);
    const pendingLines = lines([receipt(f.headSha), ...f.rows]);
    assert.equal(pendingWorkerBoundaryHandoffs(pendingLines).size, 0);
    assert.deepEqual(handoffReceiptsToCarry(pendingLines), []);
    for (const mismatch of [{ source_branch: "run-W1-T99-2" }, { head_sha: sha }, { task_id: "W1-T99" }]) {
      assert.equal(pendingWorkerBoundaryHandoffs(lines([receipt(f.headSha), { ...f.rows[0], ...mismatch }])).size, 1);
    }
  } finally { f.cleanup(); }
});

test("W1-T8503: a failed ls-remote or a moved head still refuses", async () => {
  const f = fixture();
  try {
    await assert.rejects(restoreBoundaryCheckpoint({ branch, headSha: f.headSha }, taskId, async () => { throw new Error("remote unavailable"); }, f.log), /remote unavailable/);
    f.origin.git("update-ref", `refs/heads/${branch}`, f.origin.git("rev-parse", "main"));
    await assert.rejects(restoreBoundaryCheckpoint({ branch, headSha: f.headSha }, taskId, async (args) => f.repo.git(...args), f.log), /remote head moved/);
    assert.deepEqual(f.rows, []);
    assert.equal(pendingWorkerBoundaryHandoffs(lines([receipt(f.headSha), { task_id: taskId, step: "verdict", verdict: "no_pr", reason: "restart_checkpoint_restore_failed" }])).size, 1);
  } finally { f.cleanup(); }
});
