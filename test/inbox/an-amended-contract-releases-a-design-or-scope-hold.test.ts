import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { taskContractRevision, taskSemanticRevision } from "#src/lib/escalate.js";
import { CONTRACT_AMENDED_REFRESH_STEP, runSweep, type OpenPrView, type SweepDeps, type UpdateBranchOutcome } from "#src/lib/sweep.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";
import { renderFixPrompt } from "#src/lib/prompt-render.js";
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
const HEAD = "0dad88f".padEnd(40, "0");
const NOW = Date.now();
const RED = "ci-shard (1/8)";
const pr = (over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: 13039, prUrl: "https://github.com/o/remudero/pull/13039", taskId: TASK,
  headSha: HEAD, checksState: "red", reviewState: "pending", unmetCriteria: [],
  priorStrikes: 1, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(),
  ciFailures: [{ name: RED, logTail: "not ok 1 - W1-T9265: inbox.draft_escalated no longer recurs" }], ...over,
});

function fixture(rows: Record<string, unknown>[]) {
  const state = { revision: "contract-A" as string | undefined, escalated: 0, dispatched: 0, refreshed: 0, admissions: 0 };
  const deps: SweepDeps = {
    ledgerPath: "/unused/contract-hold-ledger", runId: "contract-hold-test", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    fixProgressJudge: async () => ({ verdict: "continue", reason: "the red names one failing test" }),
    readTaskContractRevision: (taskId) => (taskId === TASK ? state.revision : undefined),
    updateBranch: async (): Promise<UpdateBranchOutcome> => { state.refreshed++; return "updated"; },
    arm: () => {}, close: () => {},
    escalate: () => { state.escalated++; },
    dispatchFix: () => { state.dispatched++; },
    claimFixAdmission: () => { state.admissions++; return { admitted: true }; },
  };
  return { deps, state };
}

const lastDisposed = (rows: Record<string, unknown>[]) => rows.findLast(row => row.step === "sweep.disposed")!;
const designRow = (revision?: string) => ({ step: "fix.needs_design", task_id: TASK, head_sha: HEAD,
  reason: "decide whether the scout or the draft ladder changes", ...(revision !== undefined ? { contract_revision: revision } : {}) });

function designRows(revision?: string): Record<string, unknown>[] {
  const common = { task_id: TASK, head_sha: HEAD, run_id: "DESIGN-ROUND", host: "fixture-host", actor_pid: 777 };
  const round = { ...common, round_id: "DESIGN-ROUND:1", repair_pr_url: pr().prUrl };
  return [
    { ...round, step: "fix.dispatch", ts: new Date(NOW - 3000).toISOString(), mode: "ci-log" },
    { ...common, ...designRow(revision), ts: new Date(NOW - 2000).toISOString() },
    { ...round, step: "fix.done", ts: new Date(NOW - 1000).toISOString(), fix_outcome: "NEEDS_DESIGN", subtype: "success" },
  ];
}

describe("test/inbox/an-amended-contract-releases-a-design-or-scope-hold.test.ts", () => {
  test("a NEEDS_DESIGN hold takes main once when the task contract is amended under it", async () => {
    const rows: Record<string, unknown>[] = designRows("contract-A");
    const f = fixture(rows);

    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 0, "an unchanged contract changes nothing");
    assert.equal(f.state.dispatched, 0, "the completed design handoff escalates before another fix admission");
    assert.equal(f.state.admissions, 0);
    assert.equal(lastDisposed(rows).needs_design_hold, true);
    assert.equal(lastDisposed(rows).progress_contract_revision, "contract-A");

    f.state.revision = "contract-B";
    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 1, "the answering amendment takes main into the branch");
    assert.equal(f.state.dispatched, 0, "no round runs against the old head's contract");
    assert.equal(f.state.admissions, 0);
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
    const rows: Record<string, unknown>[] = designRows("contract-A");
    const f = fixture(rows);
    f.state.revision = "contract-B";

    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 1);
    assert.equal(f.state.dispatched, 0);
  });

  test("a NEEDS_DESIGN row that predates the record adopts the current contract, then releases on the next amendment", async () => {
    const rows: Record<string, unknown>[] = designRows();
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
      { step: "fix.scope_amendment", task_id: TASK, pr_number: 13039, head_sha: HEAD,
        outcome: "created", amendmentNumber: 13106, paths: ["src/lib/scout-gardener.ts"] },
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
    const task = { id: TASK, title: "design contract", files: ["src/fix.ts"], design: "preserve the bounded rule", amendment: "approved precise repair" };
    const outcome = await runFixRung({
      taskId: TASK, runId: "design-contract-run", task, prUrl: "https://github.com/o/remudero/pull/13039",
      branch: `run-${TASK}-1`, worktreePath: repo.dir, initialSessionId: "initial", mount, settingsFile: join(repo.dir, "settings.json"),
      config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
      budgetUsd: 10, strikeCap: 2, initialReview: review,
      reviewBase: { owner: "o", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
      escalationJudge: async () => ({ decision: "deliver", reason: "test" }),
      deps: {
        spawn: async (prompt) => {
          assert.ok(String(prompt.prompt).includes(task.design)); assert.ok(String(prompt.prompt).includes(task.amendment));
          return worker;
        }, waitForCiGreen: async () => "green",
        runReview: async () => ({ ...review, state: "success" }), fetchPrBody: async () => "REPORT", push: () => {},
        issues: { create: () => "https://github.com/o/remudero/issues/1", listOpen: () => [], comment: () => {} },
        ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
        log: (step, extra) => rows.push({ step, task_id: TASK, ...extra }), say: () => {}, account: (r) => r,
      },
    });
    assert.equal(outcome.outcome, "needs_design");
    assert.equal(rows.find((r) => r.step === "fix.needs_design")?.contract_revision, taskContractRevision(task));
    assert.equal(rows.find((r) => r.step === "fix.needs_design")?.task_semantic_revision, taskSemanticRevision(task));
  });
});

test("design-hold fixture preserves approved amendments without spending fix admission", async () => {
  const rows = designRows("contract-A"), f = fixture(rows);
  await runSweep([pr()], f.deps);
  assert.equal(f.state.escalated, 1); assert.equal(f.state.dispatched, 0); assert.equal(f.state.admissions, 0);
  f.state.revision = "contract-B";
  await runSweep([pr()], f.deps);
  assert.equal(f.state.refreshed, 1); assert.equal(f.state.dispatched, 0); assert.equal(f.state.admissions, 0);
  await runSweep([pr()], f.deps);
  assert.equal(f.state.refreshed, 1);
});

const semanticA = taskSemanticRevision({ design: "keep behavior", amendment: "original decision" })!;
const semanticB = taskSemanticRevision({ design: "keep behavior", amendment: "approved answer" })!;
function semanticFixture(receipt: unknown = semanticA) {
  const rows = designRows("contract-A");
  if (receipt !== undefined) rows.find(row => row.step === "fix.needs_design")!.task_semantic_revision = receipt;
  const f = fixture(rows);
  f.deps.readTaskSemanticRevision = () => semanticB;
  return { ...f, rows };
}

test("validated task narratives survive the real loader and change only the separate versioned digest", () => {
  const yaml = `- id: W1-T9265
  title: repair
  repo: remudero
  type: implement
  status: queued
  design: preserve exact behavior
  amendment: approved precise answer
  files: [src/fix.ts]
`;
  const task = parseTasksFromYaml(yaml, "semantic-fixture")[0];
  assert.equal(task.amendment, "approved precise answer");
  assert.equal(task.design, "preserve exact behavior");
  assert.match(taskSemanticRevision(task)!, /^narrative-v1:[a-f0-9]{64}$/);
  for (const field of ["design", "amendment"] as const) {
    const changed = { ...task, [field]: "new approved contract" };
    assert.equal(taskContractRevision(changed), taskContractRevision(task), "legacy hash remains byte-identical");
    assert.notEqual(taskSemanticRevision(changed), taskSemanticRevision(task));
    const invalid = parseTasksFromYaml(yaml.replace(`${field}: ${task[field]}`, `${field}: [malformed]`), "invalid-narrative")[0];
    assert.equal(invalid.narrativeUnavailable, true);
    assert.equal(taskSemanticRevision(invalid), undefined);
  }
  assert.equal(taskSemanticRevision({ ...task, status: "done", attempts: 9, note: "decorative", files: [...task.files!].reverse() } as typeof task), taskSemanticRevision(task));
  const prompt = renderFixPrompt({ task, branch: "run-W1-T9265-1", round: 1, evidence: {} });
  assert.ok(prompt.includes(task.design!)); assert.ok(prompt.includes(task.amendment!));
  assert.ok(!renderFixPrompt({ task: { ...task, narrativeUnavailable: true }, branch: "run-W1-T9265-1", round: 1, evidence: {} }).includes(task.amendment!));
});

test("a producer-captured semantic amendment refreshes main once without admitting a fix at the old head", async () => {
  const f = semanticFixture();
  await runSweep([pr()], f.deps);
  assert.equal(f.state.refreshed, 1); assert.equal(f.state.dispatched, 0); assert.equal(f.state.admissions, 0);
  assert.equal(lastDisposed(f.rows).progress_task_semantic_revision, semanticB);
  const row = f.rows.find(row => row.step === CONTRACT_AMENDED_REFRESH_STEP)!;
  assert.equal(row.escalated_under_semantic, semanticA); assert.equal(row.task_semantic_revision, semanticB);
  await runSweep([pr()], f.deps);
  assert.equal(f.state.refreshed, 1); assert.equal(f.state.dispatched, 0);
});

test("legacy, malformed, unrelated-head and unchanged semantic receipts do not rearm design holds", async () => {
  for (const kind of ["legacy", "malformed", "same", "other-head", "unknown", "unknown-contract", "throws", "bad-record"]) {
    const f = semanticFixture();
    const held = f.rows.find(row => row.step === "fix.needs_design")!;
    if (kind === "legacy") delete held.task_semantic_revision;
    if (kind === "malformed") held.task_semantic_revision = "not-a-digest";
    if (kind === "same") f.deps.readTaskSemanticRevision = () => semanticA;
    if (kind === "other-head") held.head_sha = "another-head";
    if (kind === "unknown") f.deps.readTaskSemanticRevision = () => undefined;
    if (kind === "unknown-contract") f.state.revision = undefined;
    if (kind === "throws") f.deps.readTaskSemanticRevision = () => { throw new Error("unreadable canonical task"); };
    if (kind === "bad-record") f.rows.push({ step: "sweep.disposed", pr_number: 13039, head_sha: HEAD, needs_design_hold: true,
      task_id: TASK, needs_design_round_id: "DESIGN-ROUND:1", progress_contract_revision: "contract-A", progress_task_semantic_revision: "malformed" });
    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 0, kind);
    if (kind !== "other-head") { assert.equal(f.state.dispatched, 0, kind); assert.equal(f.state.admissions, 0, kind); }
    if (kind === "bad-record") {
      await runSweep([pr()], f.deps);
      assert.equal(f.state.refreshed, 0, "an ordinary observation cannot erase the unreadable explicit semantic receipt");
      assert.equal(f.state.dispatched, 0); assert.equal(f.state.admissions, 0);
    }
    if (kind === "legacy") {
      f.deps.readTaskSemanticRevision = () => semanticA;
      await runSweep([pr()], f.deps);
      assert.equal(f.state.refreshed, 0, "observation cannot manufacture a legacy semantic receipt");
      assert.equal(lastDisposed(f.rows).progress_task_semantic_revision, undefined);
    }
  }
});

test("semantic refresh refuses mid-observation drift and never admits after update failure", async () => {
  for (const kind of ["drift", "unavailable", "unknown", "throws", "failed-update", "throwing-update"]) {
    const f = semanticFixture(); let reads = 0;
    if (kind === "drift") f.deps.readTaskSemanticRevision = () => ++reads === 1 ? semanticB : semanticA;
    if (kind === "unavailable") f.deps.updateBranch = undefined;
    if (kind === "unknown") f.deps.readTaskSemanticRevision = () => ++reads === 1 ? semanticB : undefined;
    if (kind === "throws") f.deps.readTaskSemanticRevision = () => { if (++reads === 1) return semanticB; throw new Error("unreadable at action"); };
    if (kind === "failed-update") f.deps.updateBranch = async () => "conflict" as const;
    if (kind === "throwing-update") f.deps.updateBranch = async () => { throw new Error("merge refused"); };
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 0, kind); assert.equal(f.state.admissions, 0, kind);
    assert.equal(lastDisposed(f.rows).acted, false, kind);
    if (["drift", "unknown"].includes(kind)) assert.match(String(lastDisposed(f.rows).stand_down_reason), /changed during design-handoff observation/);
    if (kind === "throws") assert.match(String(lastDisposed(f.rows).stand_down_reason), /semantic revision unavailable.*unreadable at action/);
  }
});


test("a failed semantic amendment refresh remains explicitly held without checkpointing adoption or repeating its write", async () => {
  for (const outcome of ["error", "conflict", "up-to-date", "unknown", "throw"] as const) {
    const f = semanticFixture(); let attempts = 0;
    f.deps.updateBranch = async () => { attempts++; if (outcome === "throw") throw new Error("upstream unavailable"); return outcome as UpdateBranchOutcome; };
    await runSweep([pr()], f.deps);
    assert.equal(attempts, 1, outcome); assert.equal(lastDisposed(f.rows).progress_task_semantic_revision, semanticA);
    await runSweep([pr()], f.deps);
    assert.equal(attempts, 1, outcome); assert.equal(lastDisposed(f.rows).progress_task_semantic_revision, semanticA);
    assert.match(String(lastDisposed(f.rows).stand_down_reason), /amendment refresh failed; awaiting new evidence\/operator answer/);
    assert.equal(f.state.dispatched, 0); assert.equal(f.state.admissions, 0);
    const semanticC = taskSemanticRevision({ design: "keep behavior", amendment: "genuinely different approved answer" })!;
    f.deps.readTaskSemanticRevision = () => semanticC;
    f.deps.updateBranch = async () => { attempts++; return "updated" as const; };
    await runSweep([pr()], f.deps);
    assert.equal(attempts, 2, "new actual narrative earns its normal attempt");
    assert.equal(lastDisposed(f.rows).progress_task_semantic_revision, semanticC);
    await runSweep([pr()], f.deps); assert.equal(attempts, 2);
  }
});

test("semantic receipts bind the validated protective handoff round and never another hold at the same head", async () => {
  const f = semanticFixture();
  const common = { task_id: TASK, head_sha: HEAD, run_id: "SECOND-ROUND", host: "second-host", actor_pid: 888 };
  const round = { ...common, round_id: "SECOND-ROUND:1", repair_pr_url: pr().prUrl };
  f.rows.push({ ...round, step: "fix.dispatch", ts: new Date(NOW - 900).toISOString() },
    { ...common, step: "fix.needs_design", ts: new Date(NOW - 800).toISOString(), reason: "another protected handoff", contract_revision: "contract-A", task_semantic_revision: semanticB },
    { ...round, step: "fix.done", ts: new Date(NOW - 700).toISOString(), fix_outcome: "NEEDS_DESIGN" },
    { task_id: TASK, step: "sweep.disposed", pr_number: 13039, head_sha: HEAD, needs_design_hold: true,
      needs_design_round_id: "SECOND-ROUND:1", progress_contract_revision: "contract-A", progress_task_semantic_revision: semanticB });
  await runSweep([pr()], f.deps);
  assert.equal(f.state.refreshed, 1, "the original protective producer A is not replaced by second-round B");
  assert.equal(lastDisposed(f.rows).needs_design_round_id, "DESIGN-ROUND:1");
  const receipt = f.rows.find(row => row.step === CONTRACT_AMENDED_REFRESH_STEP)!;
  assert.equal(receipt.escalated_under_semantic, semanticA);
  assert.equal(f.state.dispatched, 0); assert.equal(f.state.admissions, 0);
});


test("a confirmed moved head checkpoints the semantic amendment without another write at the prior head", async () => {
  const f = semanticFixture(); let attempts = 0;
  f.deps.updateBranch = async () => { attempts++; return "head-moved" as const; };
  await runSweep([pr()], f.deps);
  assert.equal(lastDisposed(f.rows).progress_task_semantic_revision, semanticB);
  await runSweep([pr()], f.deps);
  assert.equal(attempts, 1); assert.equal(f.state.dispatched, 0); assert.equal(f.state.admissions, 0);
});

test("failed refresh evidence is exact task, PR, head, old semantic, new semantic and legacy contract bound", async () => {
  const failure = { step: CONTRACT_AMENDED_REFRESH_STEP, task_id: TASK, pr_number: 13039, head_sha: HEAD,
    escalated_under_semantic: semanticA, task_semantic_revision: semanticB, contract_revision: "contract-A", outcome: "error" };
  for (const over of [{ task_id: "W1-T9999" }, { pr_number: 999 }, { head_sha: "another-head" },
    { escalated_under_semantic: semanticB }, { task_semantic_revision: semanticA }, { contract_revision: "another-contract" }]) {
    const f = semanticFixture(); f.rows.push({ ...failure, ...over });
    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 1, JSON.stringify(over));
    assert.equal(f.state.dispatched, 0); assert.equal(f.state.admissions, 0);
  }
  const f = semanticFixture(); let attempts = 0;
  f.deps.updateBranch = async () => { attempts++; return "error" as const; };
  await runSweep([pr()], f.deps);
  f.state.revision = "contract-B";
  f.deps.updateBranch = async () => { attempts++; return "updated" as const; };
  await runSweep([pr()], f.deps);
  assert.equal(attempts, 2, "a genuinely different legacy contract earns its normal attempt");
  assert.equal(f.state.dispatched, 0); assert.equal(f.state.admissions, 0);
});
