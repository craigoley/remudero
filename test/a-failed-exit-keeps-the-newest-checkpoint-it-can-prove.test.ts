import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pendingWorkerBoundaryHandoffs, runBranchStateFrom } from "#src/lib/daemon.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { WorkerAbandonedError, type WorkerResult } from "#src/lib/worker.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { runTask } from "#test/helpers/run-task-test.js";

const TASK = "W1-T9815";
const SOURCE = `run-${TASK}-1792027244995`;
const lines = (rows: Record<string, unknown>[]) => rows.map(row => JSON.stringify(row));
const abandoned = () => new WorkerAbandonedError({ elapsedMs: 1200001, boundMs: 1200000 });
const bounded = () => Object.assign(new Error("Codex output exceeded retention budget"), {
  name: "CodexWorkerOutputLimitError", reasonClass: "bounded_output", stream: "stdout", limitBytes: 10, observedBytes: 11,
});

function worker(text: string, overrides: Partial<WorkerResult> = {}): WorkerResult {
  return { sessionId: "fixture", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "test", effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
    ...overrides };
}

function fixture(restore = true) {
  const origin = gitRepo({ bare: true });
  const seed = gitRepo();
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  seed.git("checkout", "--quiet", "-b", SOURCE);
  writeFileSync(join(seed.dir, "paid-work.txt"), "checkpoint work\n");
  seed.git("add", "paid-work.txt");
  seed.git("commit", "--quiet", "-m", "chore(checkpoint): paid work");
  const headSha = seed.git("rev-parse", "HEAD");
  seed.git("push", "--quiet", "origin", SOURCE);
  const clone = gitRepo({ cloneFrom: `file://${origin.dir}` });
  clone.git("config", "user.name", "checkpoint fixture");
  clone.git("config", "user.email", "checkpoint@fixture.invalid");
  const root = gitRepo();
  mkdirSync(join(root.dir, "repos"));
  renameSync(clone.dir, join(root.dir, "repos", "remudero"));
  mkdirSync(join(root.dir, "state"));
  const ledgerPath = join(root.dir, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, restore ? lines([{ task_id: TASK, step: "run.freshness_handoff", branch: SOURCE,
    head_sha: headSha }]).join("\n") + "\n" : "");
  const planPath = join(root.dir, "tasks.yaml");
  writeFileSync(planPath, `- id: ${TASK}\n  title: checkpoint fixture\n  repo: remudero\n  type: implement\n  verify: auto\n` +
    `  risk: high\n  origin: test\n  status: queued\n  files: [paid-work.txt]\n`);
  const readRows = () => readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean)
    .map(raw => JSON.parse(raw) as Record<string, unknown>);
  const pushOwn = (cwd: string) => {
    writeFileSync(join(cwd, "paid-work.txt"), "newer work\n");
    origin.git("-C", cwd, "add", "paid-work.txt");
    origin.git("-C", cwd, "commit", "--quiet", "-m", `fix(test): newer work\n\nRemudero-Task: ${TASK}`);
    const branch = origin.git("-C", cwd, "branch", "--show-current");
    const pushedHead = origin.git("-C", cwd, "rev-parse", "HEAD");
    origin.git("-C", cwd, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
    return { branch, headSha: pushedHead };
  };
  return { origin, root, headSha, planPath, readRows, pushOwn,
    cleanup: () => { root.cleanup(); clone.cleanup(); seed.cleanup(); origin.cleanup(); } };
}

function dispatch(f: ReturnType<typeof fixture>, implement: (cwd: string) => Promise<WorkerResult>,
  overrides: Partial<NonNullable<Parameters<typeof runTask>[1]>> = {}) {
  let calls = 0;
  return withLiveWritesAllowed(() => runTask(TASK, {
    config: { claudeBin: "/bin/true", root: f.root.dir, installRoot: REPO_ROOT },
    skipGitSync: true, planPath: f.planPath,
    github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    claimReserver: { mintAnchor: () => "checkpoint-anchor", attempt: () => "created", holder: () => undefined, drop: () => true },
    containmentExec: async token => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
    isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    externalWaitFreshness: () => undefined,
    spawn: async args => (++calls === 1 ? worker("RECON REPORT\nOBSERVED: checkpoint fixture\n") : implement(args.cwd)),
    ...overrides,
  }));
}

function assertKept(f: ReturnType<typeof fixture>, checkpoint: { branch: string; headSha: string }, stage: string) {
  const rows = f.readRows();
  const verdictAt = rows.findIndex(row => row.step === "verdict");
  assert.equal(rows[verdictAt]?.verdict, "failed");
  assert.equal(rows[verdictAt]?.stage, stage);
  const kept = rows.filter(row => row.step === "implement.checkpoint_kept");
  assert.equal(kept.length, 1);
  assert.equal(rows[verdictAt + 1], kept[0], "the receipt follows its verdict immediately");
  assert.equal(kept[0]?.run_id, rows[verdictAt]?.run_id);
  assert.equal(kept[0]?.failed_stage, stage);
  assert.equal(kept[0]?.source_branch, checkpoint.branch);
  assert.equal(kept[0]?.head_sha, checkpoint.headSha);
  assert.deepEqual(pendingWorkerBoundaryHandoffs(lines(rows)).get(TASK), checkpoint);
  return kept[0]!;
}

test("W1-T9815: an abandoned or over-budget worker keeps its restored checkpoint", async t => {
  for (const [stage, error] of [["worker.abandoned", abandoned()], ["worker.bounded_output", bounded()]] as const) {
    await t.test(stage, async () => {
      const f = fixture();
      try {
        const result = await dispatch(f, async cwd => {
          assert.equal(readFileSync(join(cwd, "paid-work.txt"), "utf8"), "checkpoint work\n");
          throw error;
        });
        assert.equal(result.verdict, "failed");
        const kept = assertKept(f, { branch: SOURCE, headSha: f.headSha }, stage);
        assert.equal(kept.failed_cause, error.reasonClass);
      } finally { f.cleanup(); }
    });
  }
});

test("W1-T9815: a thrown run keeps its own pushed head when it opened no PR", async () => {
  for (const restore of [true, false]) {
    const f = fixture(restore);
    let own: { branch: string; headSha: string } | undefined;
    const error = new Error("Command failed: gh pr create --head x\nHTTP 502");
    try {
      await assert.rejects(dispatch(f, async cwd => { own = f.pushOwn(cwd); throw error; }), err => err === error);
      assert.ok(own);
      assert.notEqual(own.headSha, f.headSha);
      assert.equal(assertKept(f, own, "run.error").failed_cause, "pr-create-failed");
      const refs = f.origin.git("show-ref", "--heads").split("\n").map(row => row.replace(" ", "\t")).join("\n");
      assert.equal(runBranchStateFrom(refs, undefined).ids?.has(TASK), true, "control: the pushed ref blocks without a receipt");
      assert.equal(runBranchStateFrom(refs, undefined, pendingWorkerBoundaryHandoffs(lines(f.readRows()))).ids?.has(TASK), false);
    } finally { f.cleanup(); }
  }
});

test("W1-T9815: worker failures share the newest-head rule and budget verdicts consume it", async () => {
  for (const stage of ["worker.abandoned", "worker.bounded_output", "implement", "blocked_budget"]) {
    const f = fixture();
    let own: { branch: string; headSha: string } | undefined;
    try {
      const result = await dispatch(f, async cwd => {
        own ??= f.pushOwn(cwd);
        if (stage === "worker.abandoned") throw abandoned();
        if (stage === "worker.bounded_output") throw bounded();
        return worker("", { isError: true, subtype: stage === "blocked_budget" ? "error_max_budget_usd" : "error_codex", provider: "codex" });
      });
      assert.ok(own);
      if (stage === "blocked_budget") {
        assert.equal(result.verdict, "blocked_budget");
        assert.equal(f.readRows().some(row => row.step === "implement.checkpoint_kept"), false);
        assert.equal(pendingWorkerBoundaryHandoffs(lines(f.readRows())).size, 0);
      } else {
        assert.equal(result.verdict, "failed");
        const kept = assertKept(f, own, stage);
        if (stage === "implement") assert.equal(kept.failed_subtype, "error_codex");
      }
    } finally { f.cleanup(); }
  }
});

test("W1-T9815: an unreadable origin tip keeps nothing and preserves the thrown error", async () => {
  const f = fixture();
  const error = new Error("Command failed: gh pr create --head x\nHTTP 502");
  try {
    await assert.rejects(dispatch(f, async () => {
      writeFileSync(join(f.root.dir, "repos", "remudero", ".git", "packed-refs"), "invalid packed refs\n");
      throw error;
    }), err => err === error);
    const rows = f.readRows();
    const unproven = rows.find(row => row.step === "implement.checkpoint_keep_unproven");
    assert.equal(unproven?.status, 128);
    assert.match(String(unproven?.error), /packed-refs/);
    assert.equal(rows.find(row => row.step === "verdict")?.cause, "pr-create-failed");
    assert.equal(rows.some(row => row.step === "implement.checkpoint_kept"), false);
    assert.equal(pendingWorkerBoundaryHandoffs(lines(rows)).size, 0);
  } finally { f.cleanup(); }
});

test("W1-T9815: a run that opened a PR keeps no checkpoint", async t => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const prUrl = "https://github.com/craigoley/remudero/pull/1";
  const shim = ghShim([
    { when: "pulls?", stdout: "[]" },
    { when: "pr view", stdout: JSON.stringify({ headRefName: `run-${TASK}-${now}`, body: `Remudero-Task: ${TASK}` }) },
    { when: "/pulls/1", stdout: JSON.stringify({ number: 1, state: "open", head: { sha: "a".repeat(40) } }) },
    { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "queued" }] }) },
    { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
    { when: "/actions/runs", stdout: JSON.stringify({ workflow_runs: [] }) },
  ]);
  const priorPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${priorPath}`;
  const f = fixture();
  let own: { branch: string; headSha: string } | undefined;
  const error = new Error("fixture failure after PR opened");
  try {
    await assert.rejects(dispatch(f, async cwd => {
      own = f.pushOwn(cwd);
      return worker(`REPORT\nPR_URL: ${prUrl}\n`);
    }, {
      preopenGate: async () => ({ kind: "pass", durationMs: 0 }),
      readHeadShaForProvenance: () => "a".repeat(40),
      externalWaitFreshness: () => {
        if (f.readRows().some(row => row.step === "pr.opened")) {
          assert.ok(own);
          assert.equal(f.origin.git("rev-parse", `refs/heads/${own.branch}`), own.headSha);
          // Even if local tracking disappears, the recorded PR owns this work; never re-pend the restored head.
          f.origin.git("-C", join(f.root.dir, "repos", "remudero"), "update-ref", "-d", `refs/remotes/origin/${own.branch}`);
          throw error;
        }
        return undefined;
      },
    }), err => err === error);
    const rows = f.readRows();
    assert.ok(rows.some(row => row.step === "pr.opened" && row.pr_url === prUrl), "control: the run recorded its PR");
    assert.equal(rows.find(row => row.step === "verdict")?.stage, "run.error");
    assert.equal(rows.some(row => row.step === "implement.checkpoint_kept"), false);
    assert.equal(pendingWorkerBoundaryHandoffs(lines(rows)).size, 0);
  } finally {
    process.env.PATH = priorPath;
    rmSync(shim.dir, { recursive: true, force: true });
    f.cleanup();
  }
});
