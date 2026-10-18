/**
 * THE SECOND HALF OF THE SCOPE-AMENDMENT LOOP. A fix round that needs a path outside its task's `files`
 * opens a plan-only amendment PR (W1-T5534, W1-T6465) and stands down. Earlier suites prove that half and
 * the `branch_update_requested` step once the amendment merges. They stop there. This suite drives the
 * rest over one real repository: the amendment merges, the next round on the same head asks GitHub to
 * update the branch, the branch takes main, and the round after that reads the task contract AT THE NEW
 * HEAD (sweep.ts `fixRungTaskAtHead` over `resolveFixRungTaskContractAtHead`, as the sweep does). It then
 * commits and pushes the widened path instead of asking for scope again.
 *
 * Ledger, 2026-10-05..11: 11 amendments, all merged. `branch_update_requested` never fired: each PR's head
 * moved first, through the fleet's base refresh or a hand fix. Three later fleet rounds committed the
 * widened path (#10190 src/lib/serve.ts, #10251 src/lib/config-schema.ts, #10523 src/lib/sweep.ts).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import type { Config } from "#src/lib/config.js";
import { fixRungTaskAtHead } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { resolveFixRungTaskContractAtHead, runFixRung } from "#test/helpers/run-task-test.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const taskId = "W1-T9";
const prUrl = "https://github.com/acme/repo/pull/42";
const branch = `run-${taskId}-1791469669000`;
const amendmentBranch = `scope-amendment/${taskId}-42`;
const shardPath = `plan/tasks.d/${taskId}-fixture.yaml`;
const shard = `- id: ${taskId}\n  title: repair the consumer\n  repo: remudero\n  type: implement\n  verify: auto\n  files: [src/existing.ts]\n` +
  `  acceptance:\n    - claim: the consumer is repaired\n      proof: 'unit test: the consumer is repaired'\n`;
const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;

function worker(text: string): WorkerResult {
  return { text, blocks: [], sessionId: "scope", costUsd: 1, numTurns: 1, subtype: "success", isError: false, apiError: false,
    permissionDenials: [], childEnvKeys: [], tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    stderr: "", model: "sonnet", effort: "medium", compactionEvents: [], qualitySuspect: false,
    modelUsage: {}, provider: "codex" } as WorkerResult;
}

test("a merged scope amendment reaches the PR head through a branch update, and the next round commits the widened path", async (t) => {
  const repo = gitRepo({ kind: "scope-second-half" });
  repo.git("config", "user.name", "scope fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}scope-second-half-root-`));
  t.after(() => { rmSync(root, { recursive: true, force: true }); repo.cleanup(); });
  mkdirSync(join(repo.dir, "src"));
  mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan/tasks.yaml"), "[]\n");
  writeFileSync(join(repo.dir, shardPath), shard);
  writeFileSync(join(repo.dir, "src/existing.ts"), "export const existing = 1;\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "seed the plan and the declared surface");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("checkout", "-q", "-b", branch);
  writeFileSync(join(repo.dir, "src/existing.ts"), "export const existing = 2;\n");
  repo.git("commit", "-qam", "feat: the implementation");
  const firstHead = repo.git("rev-parse", "HEAD");

  const rows: Array<Record<string, unknown>> = [];
  const updates: string[][] = [];
  const pushes: string[] = [];
  let merged = false;
  let report = `REPORT\nFIX_OUTCOME: NEEDS_SCOPE src/new.ts`;
  let spawns = 0;
  const reviewAt = (headSha: string, state: "failure" | "success") => ({ state, criteria: state === "success" ? [] : [{
    claim: "the consumer is repaired", proof: "unit test: the consumer is repaired", met: false, reason: "broken", proof_exec: "not_executable" }],
    testTheater: false, summary: state, floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha,
    reviewerOutcome: state }) as Parameters<typeof runFixRung>[0]["initialReview"];
  const contractAt = (headSha: string) => {
    const atHead = fixRungTaskAtHead({ task: { id: taskId, title: "repair the consumer", risk: "low", acceptance: [], files: [] }, synthetic: false }, taskId,
      resolveFixRungTaskContractAtHead(prUrl, taskId, repo.dir, () => headSha));
    assert.ok(!("standDown" in atHead), JSON.stringify(atHead));
    return atHead.task;
  };
  const opts = (headSha: string): Parameters<typeof runFixRung>[0] => ({
    taskId, runId: "scope-second-half", task: contractAt(headSha), prUrl, branch, worktreePath: repo.dir,
    initialSessionId: "initial", mount, settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: reviewAt(headSha, "failure"),
    reviewBase: { owner: "acme", repo: "repo", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "fixture" }),
    deps: {
      spawn: async () => {
        spawns++;
        writeFileSync(join(repo.dir, "src/new.ts"), "export const consumer = 1;\n");
        return worker(report);
      },
      scopeAmendmentPortsIo: {
        worktreeAddFn: (_repo, wp, name) => { repo.addWorktree(wp, name, "origin/main"); },
        worktreeRemoveFn: (_repo, wp) => { repo.git("worktree", "remove", "--force", wp); },
        gitPushFn: (_wp, name, sha) => { pushes.push(`${name}@${sha}`); },
        probeExistingPlanPrFn: () => undefined,
        createPlanPrRestFn: () => ({ prUrl: "https://github.com/acme/repo/pull/99", prNumber: 99 }) as ReturnType<NonNullable<NonNullable<ReturnType<typeof opts>["deps"]["scopeAmendmentPortsIo"]>["createPlanPrRestFn"]>>,
        isPrMergedNowFn: () => merged,
        assertLiveWriteAllowedFn: () => {},
        ghExecFn: ((argv: string[]) => { updates.push(argv); return Buffer.from(""); }) as unknown as NonNullable<NonNullable<ReturnType<typeof opts>["deps"]["scopeAmendmentPortsIo"]>["ghExecFn"]>,
      },
      fetchPrBody: async () => "A fleet build PR body.",
      fetchPrDiffFiles: async () => ["src/existing.ts"],
      readHeadShaForProvenance: () => repo.git("rev-parse", "HEAD"),
      push: () => { pushes.push(`${branch}@${repo.git("rev-parse", "HEAD")}`); },
      waitForCiGreen: async () => "green",
      runReview: async () => reviewAt(repo.git("rev-parse", "HEAD"), "success"),
      issues: { create: () => { assert.fail("the loop must not escalate"); }, listOpen: () => [], comment: () => {} },
      ledgerPath: join(root, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => { rows.push({ step, task_id: taskId, ...extra }); }, say: () => {}, account: (r) => r,
    },
  });

  // Round 1, the proven half: the contract at the head lacks src/new.ts, so the round opens the amendment.
  assert.deepEqual(contractAt(firstHead).files, ["src/existing.ts"]);
  const first = await runFixRung(opts(firstHead));
  assert.equal(first.outcome, "stood_down", first.reason);
  assert.equal(rows.findLast((r) => r.step === "fix.scope_amendment" && r.outcome !== undefined)?.outcome, "created");
  assert.deepEqual(parse(repo.git("show", `${amendmentBranch}:${shardPath}`))[0].files, ["src/existing.ts", "src/new.ts"]);
  assert.equal(repo.git("rev-parse", "HEAD"), firstHead, "nothing was committed to the PR");
  rmSync(join(repo.dir, "src/new.ts"));

  // The amendment merges. The next round at the SAME head asks GitHub to update the branch and spends no worker.
  repo.git("update-ref", "refs/remotes/origin/main", amendmentBranch);
  merged = true;
  const second = await runFixRung(opts(firstHead));
  assert.equal(second.reason, "awaiting scope amendment branch update");
  assert.equal(rows.findLast((r) => r.step === "fix.scope_amendment")?.outcome, "branch_update_requested");
  assert.equal(updates.length, 1, "one update-branch call");
  assert.ok(updates[0]!.some((arg) => arg.includes("update-branch")) && updates[0]!.some((arg) => arg.includes(firstHead)), updates[0]!.join(" "));
  assert.equal(spawns, 1);

  // GitHub's update merges main into the PR. The round after it reads the contract at THAT head and commits src/new.ts.
  repo.git("merge", "-q", "--no-edit", "refs/remotes/origin/main");
  const updatedHead = repo.git("rev-parse", "HEAD");
  assert.deepEqual(contractAt(updatedHead).files, ["src/existing.ts", "src/new.ts"], "the widened files reached the PR head");
  report = "REPORT\nFIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(consumer): repair the consumer through its new module";
  const third = await runFixRung(opts(updatedHead));
  assert.equal(third.outcome, "fixed", third.reason);
  assert.equal(spawns, 2);
  assert.equal(repo.git("show", "--format=", "--name-only", "HEAD"), "src/new.ts", "the round committed the widened path");
  assert.ok(pushes.includes(`${branch}@${repo.git("rev-parse", "HEAD")}`), pushes.join(","));
  const afterUpdate = rows.slice(rows.findLastIndex((r) => r.outcome === "branch_update_requested") + 1);
  assert.equal(afterUpdate.some((r) => r.step === "fix.commit_refused"), false, "nothing was refused for scope");
  assert.equal(afterUpdate.some((r) => r.step === "fix.scope_amendment" || r.step === "fix.scope_needed"), false, "no second amendment");
  assert.equal(existsSync(join(repo.dir, "src/new.ts")), true);
});
