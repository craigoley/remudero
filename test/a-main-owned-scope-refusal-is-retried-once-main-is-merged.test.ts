// W1-T9807: #12043 (W1-T9363) round 1 was reviewer-unmet and ended NEEDS_SCOPE src/run-task.ts. It was refused
// main-owned because main had touched that hot file, and three later refreshes never retried the amendment.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runFixRung } from "#test/helpers/run-task-test.js";
import type { ProofAmendmentRecord, ProofAmendmentWritePorts } from "#src/lib/proof-amendment.js";
import type { Config } from "#src/lib/config.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const taskId = "W1-T9807X";
const shardPath = `plan/tasks.d/${taskId}-fixture.yaml`;
const shard = `- id: ${taskId}\n  files: [src/declared.ts]\n  acceptance:\n    - claim: unchanged\n      proof: 'unit test: unchanged'\n`;
const mount = { model: "sonnet", effort: "medium" as const, maxTurns: 20, contextBudget: 120000 };
const prNumber = 1;

function amendmentPorts() {
  const prs: string[] = [];
  const records = new Map<string, ProofAmendmentRecord>();
  const deps: ProofAmendmentWritePorts = {
    repoDir: "/fixture", findShard: () => ({ path: shardPath, text: shard }),
    worktreeAdd: () => {}, worktreeRemove: () => {}, writeFile: () => {}, gitAdd: () => {},
    gitCommit: () => "amendment-sha", gitPush: () => {}, probeExisting: () => undefined,
    createPr: (opts) => { prs.push(opts.head); return { prUrl: "https://github.com/acme/remudero/pull/99", prNumber: 99 }; },
    worktreePathFor: () => "/amendment", lookupIdentity: (key) => records.get(key),
    recordIdentity: (key, record) => { records.set(key, record); }, updateBranch: () => ({ ok: true }),
  };
  return { deps, prs };
}

// main changes src/shared.ts after the merge base; the branch changes only its declared file.
function branchBehindMain() {
  const repo = gitRepo({ kind: "w1-t9807-main-owned" });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src/declared.ts"), "export const declared = 1;\n");
  writeFileSync(join(repo.dir, "src/shared.ts"), "export const shared = 1;\n");
  repo.git("add", "src");
  repo.git("commit", "-qm", "seed");
  const seed = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, "src/shared.ts"), "export const shared = 2;\n");
  repo.git("add", "src");
  repo.git("commit", "-qm", "main changes shared");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const mainSha = repo.git("rev-parse", "HEAD");
  repo.git("reset", "-q", "--hard", seed);
  writeFileSync(join(repo.dir, "src/declared.ts"), "export const declared = 2;\n");
  repo.git("add", "src");
  repo.git("commit", "-qm", "the PR's own change");
  return { repo, mainSha };
}

function harness(repo: ReturnType<typeof gitRepo>, update: () => { ok: boolean; error?: string } = () => ({ ok: true })) {
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  const amendment = amendmentPorts();
  const updates: number[] = [];
  let spawns = 0;
  const round = async (ciLog: string | undefined) => {
    const headSha = repo.git("rev-parse", "HEAD");
    const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
      state: "failure", criteria: [{ claim: "selector edge", proof: "unit test: edge", met: false, reason: "red",
        proof_exec: "not_executable" }], summary: "red", testTheater: false, floorDegraded: false, capped: false,
      keywordOnly: false, planOnly: false, headSha, reviewerOutcome: "failure",
    };
    return runFixRung({
      taskId, runId: `${taskId}-run`, task: { id: taskId, title: "selector edge", files: ["src/declared.ts"] },
      prUrl: `https://github.com/acme/remudero/pull/${prNumber}`, branch: `run-${taskId}-1`,
      worktreePath: repo.dir, initialSessionId: "initial", mount, settingsFile: join(repo.dir, "settings.json"),
      config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
      budgetUsd: 10, strikeCap: 2, initialReview: review,
      ...(ciLog === undefined ? {} : { ciFailures: [{ name: "ci-shard (1/8)", logTail: ciLog }] }),
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
      deps: {
        spawn: async () => {
          spawns++;
          writeFileSync(join(repo.dir, "src/shared.ts"), "export const shared = 9;\n");
          return {
            sessionId: "fix-session", costUsd: 0, numTurns: 1, text: "FIX_OUTCOME: NEEDS_SCOPE src/shared.ts", blocks: [],
            stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
            model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
            modelUsage: {}, compactionEvents: [], qualitySuspect: false,
          } satisfies WorkerResult;
        },
        scopeAmendmentWritePorts: amendment.deps,
        updateBranch: (n) => { updates.push(n); return update(); },
        fetchPrDiffFiles: async () => ["src/declared.ts"],
        waitForCiGreen: async () => "green",
        runReview: async () => review,
        fetchPrBody: async () => `Remudero-Task: ${taskId}`,
        readHeadShaForProvenance: () => repo.git("rev-parse", "HEAD"),
        push: () => {},
        issues: { create: () => { throw new Error("unexpected escalation"); }, listOpen: () => [], comment: () => {} },
        ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
        log: (step, extra) => { rows.push({ step, task_id: taskId, ...extra }); }, say: () => {}, account: (result) => result,
      },
    });
  };
  return { rows, amendment, updates, round, spawns: () => spawns };
}

const scopeRows = (rows: Array<Record<string, unknown>>) => rows.filter((row) => row.step === "fix.scope_amendment");

test("W1-T9807: a reviewer-unmet scope need on a path main touched gets its amendment", async () => {
  const { repo } = branchBehindMain();
  const h = harness(repo);
  await h.round(undefined);
  assert.equal(h.spawns(), 1, "the round ran its worker");
  assert.deepEqual(scopeRows(h.rows).map((row) => [row.outcome, row.reason]), [["created", undefined]]);
  assert.deepEqual(h.amendment.prs, [`scope-amendment/${taskId}-${prNumber}`]);
  assert.deepEqual(h.updates, [], "no main-owned red, so no refresh");
});

test("W1-T9807: a log-named path main is repairing is still refused main-owned", async () => {
  const { repo, mainSha } = branchBehindMain();
  const h = harness(repo);
  await h.round("src/shared.ts(1,14): error TS2339: Property 'readPaced' does not exist");
  const [row] = scopeRows(h.rows);
  assert.equal(row?.reason, "main-owned");
  assert.equal(row?.main_sha, mainSha);
  assert.deepEqual(row?.changed_paths, ["src/shared.ts"]);
  assert.deepEqual(h.amendment.prs, [], "the amendment writer never ran");
  assert.deepEqual(h.updates, [prNumber], "the round requests the refresh itself");
  const refreshed = h.rows.find((r) => r.step === "fix.base_refreshed");
  assert.equal(refreshed?.reason, "scope-main-owned");
});

test("W1-T9807: a main-owned refusal is retried once its main is merged", async () => {
  const { repo, mainSha } = branchBehindMain();
  const h = harness(repo);
  const log = "src/shared.ts(1,14): error TS2339: Property 'readPaced' does not exist";
  await h.round(log);
  assert.equal(scopeRows(h.rows).at(-1)?.reason, "main-owned");
  repo.git("checkout", "-q", "--", ".");
  await h.round(log);
  assert.equal(h.spawns(), 2, "a head without main_sha is not retried: the round runs its worker as today");
  assert.deepEqual(h.amendment.prs, []);
  repo.git("checkout", "-q", "--", ".");
  repo.git("merge", "-q", "--no-edit", mainSha);
  await h.round(log);
  assert.equal(h.spawns(), 2, "the retry needs no new worker");
  assert.deepEqual(h.amendment.prs, [`scope-amendment/${taskId}-${prNumber}`]);
  const retried = scopeRows(h.rows).at(-1);
  assert.equal(retried?.outcome, "created");
  assert.deepEqual(retried?.paths, ["src/shared.ts"]);
  assert.equal(retried?.head_sha, repo.git("rev-parse", "HEAD"));
});

test("W1-T9807: a refresh GitHub refuses is ledgered as failed, never as refreshed", async () => {
  for (const update of [() => ({ ok: false, error: "head moved" }), () => { throw new Error("gh unavailable"); }]) {
    const { repo } = branchBehindMain();
    const h = harness(repo, update);
    await h.round("src/shared.ts(1,14): error TS2339: Property 'readPaced' does not exist");
    assert.deepEqual(h.updates, [prNumber]);
    assert.equal(h.rows.some((r) => r.step === "fix.base_refreshed"), false);
    assert.match(String(h.rows.find((r) => r.step === "fix.base_refresh_failed")?.error), /head moved|gh unavailable/);
  }
});
