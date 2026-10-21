import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { taskContractRevision } from "#src/lib/escalate.js";
import { CONTRACT_AMENDED_REFRESH_STEP, runSweep, type OpenPrView, type SweepDeps, type UpdateBranchOutcome } from "#src/lib/sweep.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

/**
 * PR 13039 sat red for 20+ hours behind two holds that awaited a plan amendment and never noticed one.
 * Its first fix round reported NEEDS_SCOPE; the sweep stood down "fix report requests a scope amendment"
 * from 04:38Z to 17:50Z although #13106 widened the task's files at 12:07Z. A later round handed off
 * NEEDS_DESIGN at 20:30Z; the operator answered by amending the task (#13214, 20:59Z), and the fix rung
 * stood down at rung.needs_design on every pass after it. Both holds key on the head, which an amendment
 * on main never moves. These tests pin the release: each hold remembers the contract it stands on, and a
 * different one on main takes main into the branch once, as the escalated progress latch already does.
 */

const TASK = "W1-T9265";
const HEAD = "0dad88f";
const NOW = Date.now();
const RED = "ci-shard (1/8)";
const pr = (over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: 13039, prUrl: "https://github.com/o/remudero/pull/13039", taskId: TASK,
  headSha: HEAD, checksState: "red", reviewState: "pending", unmetCriteria: [],
  priorStrikes: 1, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(),
  ciFailures: [{ name: RED, logTail: "not ok 1 - W1-T9265: inbox.draft_escalated no longer recurs" }], ...over,
});

function fixture(rows: Record<string, unknown>[]) {
  const state = { revision: "contract-A" as string | undefined, escalated: 0, dispatched: 0, refreshed: 0 };
  const deps: SweepDeps = {
    ledgerPath: "/unused/contract-hold-ledger", runId: "contract-hold-test", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    fixProgressJudge: async () => ({ verdict: "continue", reason: "the red names one failing test" }),
    readTaskContractRevision: (taskId) => (taskId === TASK ? state.revision : undefined),
    updateBranch: async (): Promise<UpdateBranchOutcome> => { state.refreshed++; return "updated"; },
    arm: () => {}, close: () => {},
    escalate: () => { state.escalated++; },
    dispatchFix: () => { state.dispatched++; },
  };
  return { deps, state };
}

const lastDisposed = (rows: Record<string, unknown>[]) => rows.findLast(row => row.step === "sweep.disposed")!;
const designRow = (revision?: string) => ({ step: "fix.needs_design", task_id: TASK, head_sha: HEAD,
  reason: "decide whether the scout or the draft ladder changes", ...(revision !== undefined ? { contract_revision: revision } : {}) });

describe("test/inbox/an-amended-contract-releases-a-design-or-scope-hold.test.ts", () => {
  test("a NEEDS_DESIGN hold takes main once when the task contract is amended under it", async () => {
    const rows: Record<string, unknown>[] = [designRow("contract-A")];
    const f = fixture(rows);

    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 0, "an unchanged contract changes nothing");
    assert.equal(f.state.dispatched, 1, "the rung is still offered the head, as before");
    assert.equal(lastDisposed(rows).needs_design_hold, true);
    assert.equal(lastDisposed(rows).progress_contract_revision, "contract-A");

    f.state.revision = "contract-B";
    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 1, "the answering amendment takes main into the branch");
    assert.equal(f.state.dispatched, 1, "no round runs against the old head's contract");
    const disposed = lastDisposed(rows);
    assert.equal(disposed.acted, true);
    assert.match(String(disposed.stand_down_reason), /task contract amended since this head was escalated — took main into the branch \(updated\)/);
    const refresh = rows.findLast(row => row.step === CONTRACT_AMENDED_REFRESH_STEP)!;
    assert.deepEqual([refresh.pr_number, refresh.head_sha, refresh.escalated_under, refresh.contract_revision, refresh.outcome],
      [13039, HEAD, "contract-A", "contract-B", "updated"]);

    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 1, "one amendment is refreshed once per head");
  });

  test("the design hold starts on the contract the round refused, so an amendment before the next pass still counts", async () => {
    const rows: Record<string, unknown>[] = [designRow("contract-A")];
    const f = fixture(rows);
    f.state.revision = "contract-B";

    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 1);
    assert.equal(f.state.dispatched, 0);
  });

  test("a NEEDS_DESIGN row that predates the record adopts the current contract, then releases on the next amendment", async () => {
    const rows: Record<string, unknown>[] = [designRow()];
    const f = fixture(rows);

    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 0, "an unknown starting contract is never read as an amendment");
    assert.equal(lastDisposed(rows).progress_contract_revision, "contract-A");

    f.state.revision = "contract-B";
    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 1);
  });

  test("a NEEDS_SCOPE hold releases when the task's scope is amended on main", async () => {
    const rows: Record<string, unknown>[] = [
      { step: "sweep.disposed", task_id: TASK, pr_number: 13039, head_sha: HEAD, disposition: "blocked-fixable", acted: true, red_checks: [RED] },
      { step: "fix.commit_refused", task_id: TASK, head_sha: HEAD, reason: "non-test paths need scope",
        scope_amendment_detail: "NEEDS_SCOPE src/lib/scout-gardener.ts" },
    ];
    const f = fixture(rows);

    await runSweep([pr()], f.deps);
    assert.equal(f.state.escalated, 1);
    assert.equal(lastDisposed(rows).stand_down_reason, "fix report requests a scope amendment: NEEDS_SCOPE src/lib/scout-gardener.ts");
    assert.equal(lastDisposed(rows).progress_contract_revision, "contract-A");

    f.state.revision = "contract-B";
    await runSweep([pr()], { ...f.deps, updateBranch: undefined });
    assert.equal(lastDisposed(rows).acted, false);
    assert.match(String(lastDisposed(rows).stand_down_reason), /deferred to full sweep \(update-branch not available on this pass\)/);

    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 1, "the full pass takes main into the branch");
    assert.equal(f.state.dispatched, 0);
    assert.equal(f.state.escalated, 1, "the scope question is not re-asked");
  });

  test("a fix round's NEEDS_DESIGN row records the contract it worked on", async (t) => {
    const repo = gitRepo({ scope: t, kind: "design-contract" });
    repo.git("config", "user.name", "fixture");
    repo.git("config", "user.email", "fixture@example.invalid");
    mkdirSync(join(repo.dir, "src"));
    writeFileSync(join(repo.dir, "src/fix.ts"), "old source\n");
    repo.git("add", "-A");
    repo.git("commit", "-qm", "seed");
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    const rows: Array<{ step: string } & Record<string, unknown>> = [];
    const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
    const review = {
      state: "failure", criteria: [{ claim: "repair failing check", proof: "unit test: repair", met: false,
        reason: "broken", proof_exec: "not_executable" }], testTheater: false, summary: "broken",
      floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: "head-a", reviewerOutcome: "failure",
    } as Parameters<typeof runFixRung>[0]["initialReview"];
    const worker: WorkerResult = {
      sessionId: "fix-session", costUsd: 1, numTurns: 2, text: "REPORT\nFIX_OUTCOME: NEEDS_DESIGN decide the scope", blocks: [],
      stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
      model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
      modelUsage: {}, compactionEvents: [], qualitySuspect: false, provider: "claude",
    };
    const task = { id: TASK, title: "design contract", files: ["src/fix.ts"] };
    const outcome = await runFixRung({
      taskId: TASK, runId: "design-contract-run", task, prUrl: "https://github.com/o/remudero/pull/13039",
      branch: `run-${TASK}-1`, worktreePath: repo.dir, initialSessionId: "initial", mount, settingsFile: join(repo.dir, "settings.json"),
      config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
      budgetUsd: 10, strikeCap: 2, initialReview: review,
      reviewBase: { owner: "o", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
      escalationJudge: async () => ({ decision: "deliver", reason: "test" }),
      deps: {
        spawn: async () => worker, waitForCiGreen: async () => "green",
        runReview: async () => ({ ...review, state: "success" }), fetchPrBody: async () => "REPORT", push: () => {},
        issues: { create: () => "https://github.com/o/remudero/issues/1", listOpen: () => [], comment: () => {} },
        ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
        log: (step, extra) => rows.push({ step, task_id: TASK, ...extra }), say: () => {}, account: (r) => r,
      },
    });
    assert.equal(outcome.outcome, "needs_design");
    assert.equal(rows.find((r) => r.step === "fix.needs_design")?.contract_revision, taskContractRevision(task));
  });
});
