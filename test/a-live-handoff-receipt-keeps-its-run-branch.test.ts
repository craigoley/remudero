import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pendingWorkerBoundaryHandoffs, handoffReceiptsToCarry } from "../src/lib/daemon.js";
import { rotateLedger } from "../src/lib/ledger.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { DECLARED_BRANCH_GUARDS, reapBranchesCommand, restoreBoundaryCheckpoint, runTask } from "./helpers/run-task-test.js";
import { gitRepo } from "./helpers/git-repo.js";

const taskId = "W1-T8503";
const branch = `run-${taskId}-1`;
const sha = "a".repeat(40);
const receipt = (headSha = sha) => ({ task_id: taskId, step: "verdict", verdict: "handed_off",
  reason: "freshness_yield", branch, head_sha: headSha });
const lines = (rows: Record<string, unknown>[]) => rows.map((row) => JSON.stringify(row));

function reap(rows: Record<string, unknown>[], unreadable: boolean | "denied" | "missing" | "unconfigured" = false, prState = "none", prune = true) {
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
    reapBranchesCommand(prune ? ["--prune"] : [], { exec, root: repo.dir, quiet: true, ownerRepo: { owner: "fixture", repo: "fixture" },
      ledgerPath: unreadable === "unconfigured" ? undefined : ledgerPath,
      creditLedgerPath: unreadable === true ? repo.dir : unreadable === "missing" ? join(repo.dir, "missing.ndjson") : undefined,
      readFile: unreadable === "denied" ? (path) => {
        if (path === ledgerPath) throw Object.assign(new Error("access denied"), { code: "EACCES" });
        return readFileSync(path, "utf8");
      } : undefined });
    const report = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((raw) => JSON.parse(raw))
      .find((row) => row.step === "branch_reap.dry_run");
    return { deleted, report };
  } finally { repo.cleanup(); }
}

test("W1-T8503: the branch reap keeps a run branch a live handoff receipt names", () => {
  for (const state of ["none", "merged", "closed"]) for (const step of ["verdict", "run.freshness_handoff"]) for (const prune of [false, true]) {
    const result = reap([{ ...receipt(), step }], false, state, prune);
    assert.deepEqual(result.report.kept_handoff_receipt_branches, [branch]);
    assert.equal(result.report.deletable, 2, "dry run and prune report the same protected manifest");
    assert.equal(result.deleted.includes(branch), false);
    assert.deepEqual(result.deleted, prune ? ["run-W1-T99-2", "finished"] : [], "only prune deletes the unrelated heads");
    assert.equal(result.report.reasons[branch], state === "none" ? "tip_in_main" : state === "merged" ? "merged" : "closed_unmerged");
  }
});

test("W1-T8503: an unreadable ledger keeps every run-shaped head", () => {
  for (const failure of [true, "denied"] as const) {
    const result = reap([], failure);
    assert.deepEqual(result.report.kept_handoff_receipt_branches, [branch, "run-W1-T99-2"]);
    assert.deepEqual(result.deleted, ["finished"]);
  }
});

test("W1-T8503: a missing or unconfigured ledger keeps no receipt branches", () => {
  for (const missing of ["missing", "unconfigured"] as const) {
    const result = reap([receipt()], missing);
    assert.ok(result.deleted.includes(branch));
    if (missing === "missing") assert.deepEqual(result.report.kept_handoff_receipt_branches, []);
  }
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

test("W1-T8503: a dropped receipt stays consumed after ledger rotation", () => {
  const repo = gitRepo();
  try {
    const ledgerPath = join(repo.dir, "ledger.ndjson");
    const rows = [
      { ...receipt(), step: "run.freshness_handoff" },
      { task_id: taskId, step: "implement.checkpoint_dropped", source_branch: branch, head_sha: sha, reason: "object unavailable" },
      { task_id: "W1-T99", step: "run.freshness_handoff", branch: "run-W1-T99-2", head_sha: sha },
      { task_id: taskId, step: "worker.output", text: "noise".repeat(2_000) },
    ];
    writeFileSync(ledgerPath, lines(rows).join("\n") + "\n");
    assert.deepEqual([...pendingWorkerBoundaryHandoffs(lines(rows)).keys()], ["W1-T99"]);
    assert.equal(rotateLedger(ledgerPath, { ceilingBytes: 2_000 }).rotated, true);
    const rotated = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
    assert.deepEqual([...pendingWorkerBoundaryHandoffs(rotated).keys()], ["W1-T99"], "rotation must not resurrect the dropped checkpoint");
    assert.deepEqual(handoffReceiptsToCarry(rotated), []);
    assert.ok(rotated.some((raw) => JSON.parse(raw).step === "implement.checkpoint_dropped"));
    assert.equal(rotated.some((raw) => JSON.parse(raw).step === "worker.output"), false, "the rotation really discarded noise");
  } finally { repo.cleanup(); }
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
    assert.deepEqual(calls.filter((args) => args[0] === "push"), [["push",
      `--force-with-lease=refs/heads/${branch}:`, "origin", `${f.headSha}:refs/heads/${branch}`]]);
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
    const fetchFailure = Object.assign(new Error("fetch failed"), { stderr: "connection timed out" });
    await assert.rejects(restoreBoundaryCheckpoint({ branch, headSha: f.headSha }, taskId, async (args) => {
      if (args[0] === "fetch") throw fetchFailure;
      return f.repo.git(...args);
    }, f.log), (error) => error === fetchFailure);
    f.origin.git("update-ref", `refs/heads/${branch}`, f.origin.git("rev-parse", "main"));
    await assert.rejects(restoreBoundaryCheckpoint({ branch, headSha: f.headSha }, taskId, async (args) => f.repo.git(...args), f.log), /remote head moved/);
    assert.deepEqual(f.rows, []);
    assert.equal(pendingWorkerBoundaryHandoffs(lines([receipt(f.headSha), { task_id: taskId, step: "verdict", verdict: "no_pr", reason: "restart_checkpoint_restore_failed" }])).size, 1);
  } finally { f.cleanup(); }
});

test("W1-T8503: a concurrent branch recreation is never overwritten", async () => {
  const f = fixture();
  try {
    const main = f.origin.git("rev-parse", "main");
    await assert.rejects(restoreBoundaryCheckpoint({ branch, headSha: f.headSha }, taskId, async (args) => {
      if (args[0] === "push") f.origin.git("update-ref", `refs/heads/${branch}`, main);
      return f.repo.git(...args);
    }, f.log), /stale info/);
    assert.equal(f.origin.git("rev-parse", branch), main);
    assert.equal(f.repo.git("rev-parse", "HEAD"), main);
    assert.deepEqual(f.rows, []);
    assert.equal(pendingWorkerBoundaryHandoffs(lines([receipt(f.headSha)])).size, 1);
  } finally { f.cleanup(); }
});

test("W1-T8503: a transient fetch failure keeps the receipt recoverable on retry", async () => {
  const f = fixture();
  try {
    const main = f.repo.git("rev-parse", "HEAD");
    const failure = Object.assign(new Error("fetch failed"), { stderr: "connection timed out" });
    await assert.rejects(restoreBoundaryCheckpoint({ branch, headSha: f.headSha }, taskId, async (args) => {
      if (args[0] === "fetch") throw failure;
      return f.repo.git(...args);
    }, f.log), (error) => error === failure);
    assert.equal(f.repo.git("rev-parse", "HEAD"), main);
    assert.equal(f.repo.git("ls-remote", "origin", `refs/heads/${branch}`), "");
    assert.equal(f.rows.length, 0);
    const pending = pendingWorkerBoundaryHandoffs(lines([receipt(f.headSha), {
      task_id: taskId, step: "verdict", verdict: "no_pr", reason: "restart_checkpoint_restore_failed",
    }])).get(taskId);
    assert.deepEqual(pending, { branch, headSha: f.headSha });
    const restored = await restoreBoundaryCheckpoint(pending!, taskId, async (args) => f.repo.git(...args), f.log);
    assert.equal(restored.base, "main");
    assert.equal(restored.sourceBranchAbsent, true);
    assert.equal(f.origin.git("rev-parse", branch), f.headSha);
    assert.equal(readFileSync(join(f.repo.dir, "paid-work.txt"), "utf8"), "checkpoint work\n");
    assert.deepEqual(f.rows.map((row) => row.step), ["implement.checkpoint_branch_recreated"]);
  } finally { f.cleanup(); }
});

test("W1-T8503: a delayed checkpoint drop does not consume a newer receipt", () => {
  const newer = { ...receipt("b".repeat(40)), branch: `run-${taskId}-2`, step: "run.freshness_handoff" };
  const rows = lines([receipt(), newer, {
    task_id: taskId, step: "implement.checkpoint_dropped", source_branch: branch, head_sha: sha,
  }]);
  assert.deepEqual(pendingWorkerBoundaryHandoffs(rows).get(taskId), { branch: newer.branch, headSha: newer.head_sha });
  assert.deepEqual(handoffReceiptsToCarry(rows), []);
  rows.push(...lines([{
    task_id: taskId, step: "implement.checkpoint_dropped", source_branch: newer.branch, head_sha: newer.head_sha,
  }]));
  assert.equal(pendingWorkerBoundaryHandoffs(rows).size, 0);
});

test("W1-T8503: a checkpoint head that moves during fetch is refused", async () => {
  const f = fixture();
  try {
    const main = f.repo.git("rev-parse", "HEAD");
    f.origin.git("update-ref", `refs/heads/${branch}`, f.headSha);
    await assert.rejects(restoreBoundaryCheckpoint({ branch, headSha: f.headSha }, taskId, async (args) => {
      if (args[0] === "fetch") f.origin.git("update-ref", `refs/heads/${branch}`, main);
      return f.repo.git(...args);
    }, f.log), /remote head moved during fetch/);
    assert.equal(f.repo.git("rev-parse", "HEAD"), main);
    assert.equal(f.origin.git("rev-parse", branch), main);
    assert.deepEqual(f.rows, [], "a moved head must neither drop the receipt nor claim recovery");
    assert.equal(pendingWorkerBoundaryHandoffs(lines([receipt(f.headSha)])).size, 1);
  } finally { f.cleanup(); }
});

test("W1-T8503: a mismatched fetched object is dropped without recreating a branch", async () => {
  const f = fixture();
  try {
    const main = f.repo.git("rev-parse", "HEAD");
    const restored = await restoreBoundaryCheckpoint({ branch, headSha: f.headSha }, taskId, async (args) => {
      if (args[0] === "rev-parse" && args[1] === "FETCH_HEAD") return main;
      return f.repo.git(...args);
    }, f.log);
    assert.equal(restored.base, "main");
    assert.equal(restored.dropped, true);
    assert.equal(f.repo.git("rev-parse", "HEAD"), main);
    assert.equal(f.repo.git("ls-remote", "origin", `refs/heads/${branch}`), "");
    assert.equal(f.rows.length, 1);
    assert.equal(f.rows[0]?.reason, "fetched object does not match the checkpoint head");
    assert.equal(pendingWorkerBoundaryHandoffs(lines([receipt(f.headSha), ...f.rows])).size, 0);
  } finally { f.cleanup(); }
});

test("W1-T8503: absent checkpoint recovery reaches recon in the same dispatch", async () => {
  for (const recoveryMode of ["in_main", "fetchable", "unfetchable"]) {
    const inMain = recoveryMode === "in_main";
    const f = fixture(inMain);
    const root = gitRepo();
    try {
      if (recoveryMode === "unfetchable") { f.origin.git("reflog", "expire", "--expire=now", "--all"); f.origin.git("gc", "--prune=now"); }
      mkdirSync(join(root.dir, "repos"));
      renameSync(f.repo.dir, join(root.dir, "repos", "remudero"));
      mkdirSync(join(root.dir, "state"));
      const ledgerPath = join(root.dir, "state", "ledger.ndjson");
      writeFileSync(ledgerPath, lines([{ ...receipt(f.headSha), step: "run.freshness_handoff" }]).join("\n") + "\n");
      const planPath = join(root.dir, "tasks.yaml");
      writeFileSync(planPath, `- id: ${taskId}\n  title: receipt fixture\n  repo: remudero\n  type: implement\n  verify: auto\n  risk: high\n  origin: test\n  status: queued\n  files: [paid-work.txt]\n`);
      let calls = 0;
      let observed: Record<string, unknown>[] = [];
      const stopped = new Error("fixture reached recon");
      await assert.rejects(withLiveWritesAllowed(() => runTask(taskId, {
        config: { claudeBin: "/bin/true", root: root.dir, installRoot: process.cwd() },
        skipGitSync: true, planPath,
        github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
        claimReserver: { mintAnchor: () => "receipt-anchor", attempt: () => "created", holder: () => undefined, drop: () => true },
        containmentExec: async (token) => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
        isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
        externalWaitFreshness: () => undefined,
        spawn: async (args) => {
          calls++;
          observed = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((raw) => JSON.parse(raw));
          const workerHead = f.origin.git("-C", args.cwd, "rev-parse", "HEAD");
          if (recoveryMode === "fetchable") {
            assert.equal(readFileSync(join(args.cwd, "paid-work.txt"), "utf8"), "checkpoint work\n");
            f.origin.git("-C", args.cwd, "merge-base", "--is-ancestor", f.headSha, workerHead);
            f.origin.git("-C", args.cwd, "merge-base", "--is-ancestor", "origin/main", workerHead);
            assert.equal(f.origin.git("rev-parse", branch), f.headSha);
            const recreated = observed.filter((row) => row.step === "implement.checkpoint_branch_recreated");
            assert.deepEqual(recreated.map((row) => [row.task_id, row.source_branch, row.head_sha]), [[taskId, branch, f.headSha]]);
          } else assert.equal(workerHead, f.origin.git("rev-parse", "main"));
          throw stopped;
        },
      })), (error) => error === stopped);
      assert.equal(calls, 1, "this dispatch starts a worker after recovering the absent branch");
      assert.equal(observed.some((row) => row.step === "verdict"), false, "recovery does not burn a no_pr dispatch");
      const recovery = observed.filter((row) => row.step === (recoveryMode === "unfetchable" ? "implement.checkpoint_dropped" : "implement.checkpoint_restored"));
      assert.equal(recovery.length, 1);
      assert.equal(recovery[0].task_id, taskId);
      assert.equal(recovery[0].source_branch, branch);
      if (recoveryMode !== "unfetchable") {
        assert.equal(recovery[0].source_branch_absent, true);
        assert.equal(recovery[0].source_head_sha, f.headSha);
        assert.equal(recovery[0].base, "main");
        assert.ok(recovery[0].restored_head_sha);
      }
      else {
        assert.equal(recovery[0].head_sha, f.headSha);
        assert.equal(pendingWorkerBoundaryHandoffs(lines(observed)).size, 0);
        assert.deepEqual(handoffReceiptsToCarry(lines(observed)), []);
      }
    } finally { root.cleanup(); f.cleanup(); }
  }
});
