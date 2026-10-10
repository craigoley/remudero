// A refused PR open used to strand its branch: both push paths land the run branch on origin BEFORE the
// checked opener runs its filed proofs, and a refusal then threw `run.error` naming no branch. Five runs on
// 2026-09-28 (W1-T3720, 3741, 3745, 3759, 3765) left pushed, PR-less branches holding finished work that
// nothing recorded. These tests drive the REAL runTask against a local origin and assert the refusal now
// names the branch and head it left behind, and escalates only the class a rebuild cannot clear.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { reclaimRunWorktree, runTask, runTaskBody, type RunTaskContext } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { loadPlan } from "../src/lib/plan.js";
import { bodyWithFailingProofAtOpen, openPullRequestChecked, PrOpenRefusedError, recordRefusedPrOpen } from "../src/lib/pr-open.js";
import type { GitHub } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { WorkerResult, spawnWorker } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TASK_ID = "W1-T990071";

function planFor(proof: string): string {
  return [
    `- id: ${TASK_ID}`,
    "  title: a refused pr open names its branch",
    "  repo: remudero",
    "  type: implement",
    "  verify: auto",
    "  risk: medium",
    "  files: [README.md]",
    "  origin: test",
    "  status: queued",
    "  acceptance:",
    "    - claim: the readme carries the mark",
    `      proof: "${proof}"`,
    "",
  ].join("\n");
}

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });

const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

function workerResult(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "test-session",
    costUsd: 0.02,
    numTurns: 1,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "test",
    effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

/** A bare origin seeded with the plan, and the clone runTask works from. */
function buildRun(proof: string): { root: string; planPath: string; config: Config; origin: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}refused-open-root-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, planFor(proof));
  const origin = gitRepo({ bare: true, kind: "refused-open-origin" });
  const seed = gitRepo({ cloneFrom: origin.dir, kind: "refused-open-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  mkdirSync(join(seed.dir, "plan"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), planFor(proof));
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  const repoDir = join(root, "repos", "remudero");
  execFileSync("git", ["clone", "-q", origin.dir, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "fixture@remudero.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero test fixture"]);
  return {
    root,
    planPath,
    origin: origin.dir,
    config: { claudeBin: "/bin/true", root, installRoot: process.cwd() },
    cleanup: () => {
      origin.cleanup();
      seed.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function readLedger(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Recon succeeds; the implement worker commits a change and reports no PR, so the harness pushes and opens. */
const committingSpawn: typeof spawnWorker = (() => {
  let calls = 0;
  return async (args: { cwd: string }) => {
    calls += 1;
    if (calls % 2 === 1) return workerResult({ text: "RECON REPORT\nOBSERVED: fixture\n" });
    writeFileSync(join(args.cwd, "README.md"), "seed\nthe worker's change\n");
    execFileSync("git", ["-C", args.cwd, "-c", "user.email=w@remudero.invalid", "-c", "user.name=w", "commit", "-qam", "fix: the worker's change"]);
    return workerResult({ text: "REPORT\ncommitted, no PR opened\n" });
  };
})() as unknown as typeof spawnWorker;

function originBranches(origin: string): Map<string, string> {
  const out = execFileSync("git", ["--git-dir", origin, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/"], { encoding: "utf8" });
  return new Map(out.split("\n").filter(Boolean).map((line) => line.split(" ") as [string, string]));
}

// 2026-10-09: a branch-gap refusal still stranded the finished work — W1-T7243's build pushed, refused at open on
// one failing proof, and sat with no PR for hours until an operator found it (#10551). The open now goes ahead
// with the failing proof named as the PR's fix target, so the sweep, fix lane and progress judge take it.
test("a build whose filed proof fails at open opens its PR with that proof named instead of stranding the branch", async () => {
  const fx = buildRun("grep: NEVER_WRITTEN_MARK in README.md");
  try {
    const created: string[][] = [];
    const result = await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true,
        planPath: fx.planPath,
        config: fx.config,
        github: OFFLINE_GITHUB,
        spawn: committingSpawn,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
        otherOpenPrReader: async () => [],
        prCreateExec: (_command, args) => {
          created.push(args);
          return "";
        },
      }),
    );
    const ledger = readLedger(fx.root);
    assert.equal(ledger.filter((row) => row.step === "pr.open_refused").length, 0, "a failing proof no longer refuses the open");
    const opened = ledger.filter((row) => row.step === "pr.opened_with_failing_proof");
    assert.equal(opened.length, 1, "the open names the failing proof");
    assert.equal(opened[0]?.proof, "grep: NEVER_WRITTEN_MARK in README.md");
    assert.equal(created.length, 1, "the PR create ran for the built branch");
    const body = created[0]?.find((arg) => arg.startsWith("body=")) ?? "";
    assert.match(body, /## Pre-open proof failure/);
    assert.match(body, /NEVER_WRITTEN_MARK/);
    assert.match(body, /Remudero-Task: W1-T990071/, "the checked body still carries the task trailer");
    assert.notEqual(result.verdict, "merged");
  } finally {
    fx.cleanup();
  }
});

test("a pr open refused on a stale proof escalates naming the branch", async () => {
  const fx = buildRun("grep: seed in README.md");
  try {
    const created: Array<{ title: string; body: string }> = [];
    const issues: IssueGateway = {
      create: (title, body) => {
        created.push({ title, body });
        return "https://github.com/acme/remudero/issues/7";
      },
      listOpen: () => [],
      ensureLabel: () => true,
    };
    const plan = loadPlan(fx.planPath);
    const ctx: RunTaskContext = {
      config: fx.config,
      fetchPrBodyFn: async () => {
        throw new Error("PR body fetch is unreachable in this fixture");
      },
      github: OFFLINE_GITHUB,
      isMerged: () => false,
      ledgerPath: join(fx.root, "state", "ledger.ndjson"),
      log: () => {},
      openTaskIds: new Set([TASK_ID]),
      opts: { containmentExec: holdingContainmentExec, isolationExec: cleanIsolationExec, prOpenRefusalIssues: issues },
      owner: "acme",
      plan,
      planPath: fx.planPath,
      recordDecisionFn: () => ({ landed: false, files: [] }),
      repoRoot: REPO_ROOT,
      runId: `${TASK_ID}-1`,
      runReviewFn: async () => {
        throw new Error("review is unreachable in this fixture");
      },
      say: () => {},
      spawn: committingSpawn,
      task: plan.byId.get(TASK_ID)!,
      taskId: TASK_ID,
      workerStateSensor: { observer: () => {}, startPolling: () => () => {}, setRunawayBound: () => {} },
    };
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    ctx.log = (step, extra) => rows.push({ step, extra });
    const result = await withLiveWritesAllowed(() => runTaskBody(ctx));
    assert.equal(result.verdict, "failed");
    const refused = rows.find((row) => row.step === "pr.open_refused")?.extra ?? {};
    assert.equal(refused.refusal_class, "stale-proof");
    assert.equal(created.length, 1, "one escalation issue");
    assert.ok(created[0]?.body.includes(String(refused.branch)), "the escalation names the kept branch");
    assert.ok(created[0]?.body.includes(String(refused.head_sha)), "and its head");
    const verdict = rows.find((row) => row.step === "verdict")?.extra ?? {};
    assert.equal(verdict.issue_url, "https://github.com/acme/remudero/issues/7");
  } finally {
    fx.cleanup();
  }
});

test("the opener classifies a proof that already passes at the merge base as a stale proof", () => {
  const repo = gitRepo({ kind: "refused-open-classify" });
  try {
    mkdirSync(join(repo.dir, "plan"), { recursive: true });
    writeFileSync(join(repo.dir, "plan", "tasks.yaml"), planFor("grep: seed in README.md"));
    writeFileSync(join(repo.dir, "README.md"), "seed\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "seed");
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    const refuse = (stdout: string) => () => ({ status: 5, stdout, stderr: "" });
    const classOf = (stdout: string): string => {
      try {
        openPullRequestChecked("", `run-${TASK_ID}-1`, repo.dir, "origin/main", refuse(stdout));
      } catch (err) {
        assert.ok(err instanceof PrOpenRefusedError);
        assert.match(err.message, /^openPullRequestChecked: /, "the message keeps the prefix runErrorCause reads");
        return err.refusalClass;
      }
      return assert.fail("the opener must refuse");
    };
    assert.equal(classOf("discrimination: executed_stale — this proof matches BOTH head and base"), "stale-proof");
    assert.equal(classOf("verdict:    fail\ncause:      absent"), "branch-gap");
  } finally {
    repo.cleanup();
  }
});

test("a branch-gap refusal records the branch without raising an escalation", () => {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const issues: IssueGateway = {
    create: () => assert.fail("a branch gap must not open an issue"),
  };
  const url = recordRefusedPrOpen(
    new PrOpenRefusedError("branch-gap", "W1-T1 proof did not pass against merge base (grep: x in y)"),
    { taskId: "W1-T1", branch: "run-W1-T1-1", headSha: "a".repeat(40) },
    (step, extra) => rows.push({ step, extra }),
    { issues, ledgerPath: join(tmpdir(), "unused-ledger.ndjson"), runId: "W1-T1-1" },
  );
  assert.equal(url, null);
  assert.deepEqual(rows.map((row) => row.step), ["pr.open_refused"]);
  assert.equal(rows[0]?.extra?.branch, "run-W1-T1-1");
  assert.equal(rows[0]?.extra?.head_sha, "a".repeat(40));
});

test("a worktree that cannot be removed is ledgered and never replaces the refused verdict", () => {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  reclaimRunWorktree("/repo", "/repo/wt", "pr_open.refused", (step, extra) => rows.push({ step, extra }), () => {
    throw new Error("fixture: worktree is busy");
  });
  assert.deepEqual(rows, [{ step: "worktree.remove.error", extra: { on: "pr_open.refused", error: "fixture: worktree is busy" } }]);
});

test("a branch-gap proof refusal carries the checked body and the failing proof; a stale-proof one carries neither", () => {
  const repo = gitRepo({ kind: "refused-open-carry" });
  try {
    mkdirSync(join(repo.dir, "plan"), { recursive: true });
    writeFileSync(join(repo.dir, "plan", "tasks.yaml"), planFor("grep: NEVER_WRITTEN_MARK in README.md"));
    writeFileSync(join(repo.dir, "README.md"), "seed\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "seed");
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    const refusalFor = (stdout: string): PrOpenRefusedError => {
      try {
        openPullRequestChecked("", `run-${TASK_ID}-1`, repo.dir, "origin/main", () => ({ status: 5, stdout, stderr: "" }));
      } catch (err) {
        assert.ok(err instanceof PrOpenRefusedError);
        return err;
      }
      return assert.fail("the opener must refuse");
    };
    const gap = refusalFor("verdict:    fail\ncause:      absent");
    assert.equal(gap.failingProof?.proof, "grep: NEVER_WRITTEN_MARK in README.md");
    assert.match(gap.failingProof?.checkedBody ?? "", /Remudero-Task: W1-T990071/);
    assert.equal(refusalFor("discrimination: executed_stale — matches BOTH head and base").failingProof, undefined);
  } finally {
    repo.cleanup();
  }
});

test("the failing-proof note sits before the task trailer so the trailer stays last", () => {
  const body = bodyWithFailingProofAtOpen({
    proof: "grep: X in y",
    detail: "verdict: fail",
    checkedBody: "Intro\n\n## Acceptance\n\n- c | grep: X in y\n\nRemudero-Task: W1-T1",
  });
  assert.ok(body.indexOf("## Pre-open proof failure") < body.indexOf("Remudero-Task: W1-T1"));
  assert.match(body, /Remudero-Task: W1-T1$/);
});
