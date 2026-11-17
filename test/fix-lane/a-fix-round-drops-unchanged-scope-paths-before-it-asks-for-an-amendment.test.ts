// W1-T10900: one untouched path in a NEEDS_SCOPE ask made requestScopeAmendment refuse the WHOLE ask as
// path-not-changed (#17010, #15918, #13924). The rung now drops the paths the worker's diff does not touch first.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import type { WorkerResult } from "#src/lib/worker.js";
import type { ProofAmendmentRecord, ProofAmendmentWritePorts } from "#src/lib/proof-amendment.js";
import { runFixRung } from "#test/helpers/run-task-test.js";
import { gitRepo } from "#test/helpers/git-repo.js";

type Row = { step: string } & Record<string, unknown>;
const taskId = "W1-T12543X";
const prNumber = 7;
const shardPath = `plan/tasks.d/${taskId}-fixture.yaml`;
const goodShard = `- id: ${taskId}\n  files: [src/declared.ts]\n  acceptance:\n    - claim: unchanged\n      proof: 'unit test: unchanged'\n`;
const mount = { model: "sonnet", effort: "medium" as const, maxTurns: 20, contextBudget: 120000 };

// main changes src/shared.ts after the merge base; the branch changes only its declared file.
function branchBehindMain() {
  const repo = gitRepo({ kind: "w1-t12543-scope" });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  put("src/declared.ts", "export const declared = 1;\n");
  put("src/shared.ts", "export const shared = 1;\n");
  put(".github/workflows/ci.yml", "name: ci\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "seed");
  const seed = repo.git("rev-parse", "HEAD");
  put("src/shared.ts", "export const shared = 2;\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "main changes shared");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const mainSha = repo.git("rev-parse", "HEAD");
  repo.git("reset", "-q", "--hard", seed);
  put("src/declared.ts", "export const declared = 2;\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "the PR's own change");
  return { repo, put, mainSha };
}

interface Plan {
  /** paths the worker names in NEEDS_SCOPE */ requested?: string[];
  /** paths the worker edits */ edited?: string[];
  /** shard text per findShard call; the last one repeats */ shards?: string[];
  /** fetchPrBody throws on these 1-based calls */ bodyThrowsOn?: number[];
  existingAmendment?: boolean;
  branch?: string;
  body?: string;
  taskId?: string;
}

function harness(plan: Plan = {}) {
  const { repo, put, mainSha } = branchBehindMain();
  const requested = plan.requested ?? ["src/shared.ts"];
  const edited = plan.edited ?? requested;
  const shards = plan.shards ?? [goodShard];
  const rows: Row[] = [];
  const records = new Map<string, ProofAmendmentRecord>();
  const prs: string[] = [];
  const issues: Array<{ title: string; body: string }> = [];
  const updates: number[] = [];
  let shardReads = 0;
  let bodyReads = 0;
  let spawns = 0;
  const ports: ProofAmendmentWritePorts = {
    repoDir: repo.dir,
    findShard: () => ({ path: shardPath, text: shards[Math.min(shardReads++, shards.length - 1)] }),
    worktreeAdd: () => {}, worktreeRemove: () => {}, writeFile: () => {}, gitAdd: () => {},
    gitCommit: () => "amendment-sha", gitPush: () => {}, probeExisting: () => plan.existingAmendment
      ? { prUrl: "https://github.com/acme/remudero/pull/99", prNumber: 99 } : undefined,
    createPr: (opts) => { prs.push(opts.head); return { prUrl: "https://github.com/acme/remudero/pull/99", prNumber: 99 }; },
    worktreePathFor: () => "/amendment", lookupIdentity: (key) => records.get(key),
    recordIdentity: (key, record) => { records.set(key, record); }, updateBranch: () => ({ ok: true }),
  };
  const round = async (ciLog?: string) => {
    const headSha = repo.git("rev-parse", "HEAD");
    const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
      state: "failure", criteria: [{ claim: "selector edge", proof: "unit test: edge", met: false, reason: "red",
        proof_exec: "not_executable" }], summary: "red", testTheater: false, floorDegraded: false, capped: false,
      keywordOnly: false, planOnly: false, headSha, reviewerOutcome: "failure",
    };
    return runFixRung({
      taskId: plan.taskId ?? taskId, runId: `${taskId}-run`, task: { id: plan.taskId ?? taskId, title: "selector edge", files: ["src/declared.ts"] },
      prUrl: `https://github.com/acme/remudero/pull/${prNumber}`, branch: plan.branch ?? `run-${taskId}-1`,
      worktreePath: repo.dir, initialSessionId: "initial", mount, settingsFile: join(repo.dir, "settings.json"),
      config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
      budgetUsd: 10, strikeCap: 2, initialReview: review,
      ...(ciLog === undefined ? {} : { ciFailures: [{ name: "ci-shard (1/8)", logTail: ciLog }] }),
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
      escalationJudge: async () => ({ decision: "deliver", reason: "fixture delivers" }),
      deps: {
        spawn: async () => {
          spawns++;
          for (const path of edited) put(path, `export const edit = ${spawns};\n`);
          return {
            sessionId: "fix-session", costUsd: 0, numTurns: 1, text: `FIX_OUTCOME: NEEDS_SCOPE ${requested.join(",")}`, blocks: [],
            stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
            model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
            modelUsage: {}, compactionEvents: [], qualitySuspect: false,
          } satisfies WorkerResult;
        },
        scopeAmendmentWritePorts: ports,
        updateBranch: (n) => { updates.push(n); return { ok: true }; },
        fetchPrDiffFiles: async () => ["src/declared.ts"],
        waitForCiGreen: async () => "green",
        runReview: async () => review,
        fetchPrBody: async () => {
          bodyReads++;
          if (plan.bodyThrowsOn?.includes(bodyReads)) throw new Error(`gh pr view failed on read ${bodyReads}`);
          return plan.body ?? `Remudero-Task: ${taskId}`;
        },
        readHeadShaForProvenance: () => repo.git("rev-parse", "HEAD"),
        push: () => {},
        issues: { create: (title, body) => { issues.push({ title, body }); return "https://github.com/acme/remudero/issues/1"; },
          listOpen: () => [], comment: () => {} },
        ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
        log: (step, extra) => { rows.push({ step, task_id: plan.taskId ?? taskId, pr_number: prNumber, ...extra }); }, say: () => {}, account: (result) => result,
      },
    });
  };
  const scopeRows = () => rows.filter((row) => row.step === "fix.scope_amendment");
  const refusals = () => rows.filter((row) => row.step === "fix.commit_refused");
  return { repo, mainSha, rows, prs, issues, updates, round, scopeRows, refusals,
    counts: () => ({ spawns, shardReads, bodyReads }) };
}

test("W1-T10585: fix_refusal:non-test-paths-need-scope-path-not-changed is prevented, not retried", async () => {
  // src/shared.ts is edited; src/untouched.ts is asked for but never edited.
  const mixed = harness({ requested: ["src/shared.ts", "src/untouched.ts"], edited: ["src/shared.ts"] });
  const result = await mixed.round();
  assert.deepEqual(mixed.refusals(), [], "no path-not-changed commit refusal is raised");
  assert.deepEqual(mixed.scopeRows().map((row) => [row.outcome, row.reason, row.retry]), [["created", undefined, undefined]],
    "one ask, created, not retried");
  assert.deepEqual(mixed.scopeRows()[0]?.paths, ["src/shared.ts"], "only the touched path is asked for");
  assert.deepEqual(mixed.scopeRows()[0]?.dropped_paths, ["src/untouched.ts"], "the dropped path is named in the ledger row");
  assert.deepEqual(mixed.prs, [`scope-amendment/${taskId}-${prNumber}`]);
  assert.equal(result.reason, "awaiting scope amendment merge");
  assert.equal(mixed.counts().spawns, 1);
  assert.equal(mixed.issues.length, 0);

  // Control: a fully-touched ask is unchanged (no dropped_paths), and a fully-untouched ask still names its refusal once.
  const clean = harness({ requested: ["src/shared.ts"] });
  await clean.round();
  assert.equal(clean.scopeRows()[0]?.dropped_paths, undefined);
  const none = harness({ requested: ["src/shared.ts"], edited: ["src/declared.ts"] });
  await none.round();
  assert.deepEqual(none.scopeRows().map((row) => [row.reason, row.retry]), [["path-not-changed", undefined]]);
});
