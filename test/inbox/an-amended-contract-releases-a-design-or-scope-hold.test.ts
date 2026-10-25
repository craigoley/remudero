import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { taskContractRevision, taskSemanticRevision } from "#src/lib/escalate.js";
import { CONTRACT_AMENDED_REFRESH_STEP, runSweep, runSweepLightPass, type OpenPrView, type SweepDeps, type UpdateBranchOutcome } from "#src/lib/sweep.js";
import * as sweepModule from "#src/lib/sweep.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";
import { renderFixPrompt } from "#src/lib/prompt-render.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
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

const lightPassHeadContractRefresh = (...args: Parameters<typeof sweepModule.lightPassHeadContractRefresh>) => {
  assert.equal(typeof sweepModule.lightPassHeadContractRefresh, "function");
  return sweepModule.lightPassHeadContractRefresh(...args);
};

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
    readLedger: () => rows, readHeadContractRefreshHistory: async () => ({ complete: true, lines: rows }), appendLine: (_path, row) => { rows.push(row); },
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
const headContractHold = (over: Record<string, unknown> = {}) => ({ step: "fix.contract_hold", kind: "open-escalation",
  task_id: TASK, pr_url: pr().prUrl, head_sha: HEAD, contract_revision: "contract-A", ...over });
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
  test("a head-held escalation adopts an approved amendment before another fix round", async () => {
    const rows: Record<string, unknown>[] = [headContractHold()];
    const f = fixture(rows);
    f.state.revision = "contract-B";
    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 1);
    assert.equal(f.state.dispatched, 0);
    assert.equal(f.state.admissions, 0);
    const receipt = rows.findLast(row => row.step === CONTRACT_AMENDED_REFRESH_STEP)!;
    assert.deepEqual([receipt.escalated_under, receipt.contract_revision, receipt.head_sha], ["contract-A", "contract-B", HEAD]);
    await runSweep([pr()], f.deps);
    assert.equal(f.state.refreshed, 1, "an unchanged snapshot cannot repeat a successful refresh");
    const rotated = [headContractHold(), receipt];
    const fresh = fixture(rotated);
    fresh.state.revision = "contract-B";
    await runSweep([pr()], fresh.deps);
    assert.equal(fresh.state.refreshed, 0, "the attempt receipt, rather than process memory, prevents repeats");
  });

  test("a head-contract refresh preserves unknown outcomes and selects only one head per pass", async () => {
    for (const outcome of ["conflict", "error: unavailable", undefined]) {
      const rows: Record<string, unknown>[] = [headContractHold(), { step: CONTRACT_AMENDED_REFRESH_STEP,
        task_id: TASK, pr_number: pr().prNumber, head_sha: HEAD, contract_revision: "contract-B", outcome }];
      const f = fixture(rows);
      f.state.revision = "contract-B";
      await runSweep([pr()], f.deps);
      assert.equal(f.state.refreshed, 0, String(outcome));
      assert.equal(f.state.dispatched, 0, String(outcome));
    }
    const second = pr({ prNumber: 13040, prUrl: "https://github.com/o/remudero/pull/13040" });
    const rows = [headContractHold(), headContractHold({ pr_url: second.prUrl })];
    const f = fixture(rows);
    f.state.revision = "contract-B";
    await runSweep([pr(), second], f.deps);
    assert.equal(f.state.refreshed, 1);
    assert.equal(f.state.dispatched, 0);
  });

  test("a head-contract receipt grants no refresh for unchanged foreign unread or held inputs", async () => {
    for (const over of [{ task_id: "W1-T9999" }, { head_sha: "f".repeat(40) }, { pr_url: "https://github.com/o/remudero/pull/9" }]) {
      const f = fixture([headContractHold(over)]);
      f.state.revision = "contract-B";
      await runSweep([pr()], f.deps);
      assert.equal(f.state.refreshed, 0);
    }
    for (const revision of ["contract-A", undefined]) {
      const f = fixture([headContractHold()]);
      f.state.revision = revision;
      await runSweep([pr()], f.deps);
      assert.equal(f.state.refreshed, 0);
    }
    for (const extra of [{ dryRun: true }, { actionable: () => false }]) {
      const f = fixture([headContractHold()]);
      f.state.revision = "contract-B";
      await runSweep([pr()], { ...f.deps, ...extra });
      assert.equal(f.state.refreshed, 0);
      assert.equal(f.state.dispatched, 0);
    }
  });

  test("the light pass offers one contract refresh without opening generic branch updates", async () => {
    const second = pr({ prNumber: 13040, prUrl: "https://github.com/o/remudero/pull/13040" });
    const rows = [headContractHold(), headContractHold({ pr_url: second.prUrl })];
    const f = fixture(rows);
    f.state.revision = "contract-B";
    const capability = await lightPassHeadContractRefresh([second, pr()], f.deps);
    assert.equal(capability.headContractRefreshFor?.(second), undefined);
    assert.equal(capability.headContractRefreshFor?.(pr()), f.deps.updateBranch);
    assert.equal(capability.headContractRefreshFor?.(pr({ headSha: "f".repeat(40) })), undefined);
    await runSweepLightPass([second, pr()], { ...f.deps, updateBranch: undefined, ...capability });
    assert.equal(f.state.refreshed, 1);
    assert.equal(f.state.dispatched, 0);
    assert.equal(f.state.admissions, 0);
    assert.equal(rows.filter(row => row.step === "sweep.head_contract_refresh.attempted").length, 1);
    const next = await lightPassHeadContractRefresh([second, pr()], f.deps);
    assert.equal(next.headContractRefreshFor?.(pr()), undefined);
    assert.equal(next.headContractRefreshFor?.(second), f.deps.updateBranch);
  });

  test("a contract refresh refuses incomplete history and records intent before its effect", async t => {
    const rows: Record<string, unknown>[] = [headContractHold()];
    const f = fixture(rows);
    f.state.revision = "contract-B";
    const unread = { ...f.deps, readHeadContractRefreshHistory: async () => ({ complete: false, lines: [] }) };
    assert.deepEqual(await lightPassHeadContractRefresh([pr()], unread), {});
    await runSweep([pr()], unread);
    assert.equal(f.state.refreshed, 0);
    assert.equal(f.state.dispatched, 0);
    await runSweep([pr()], { ...f.deps, appendLine: (_path, row) => {
      if (row.step === "sweep.head_contract_refresh.attempted") throw new Error("intent write refused");
      rows.push(row);
    } });
    assert.equal(f.state.refreshed, 0, "a missing durable intent authorizes no external effect");
    assert.equal(f.state.dispatched, 0);
    const unknownRows = [headContractHold(), { step: "sweep.head_contract_refresh.attempted", task_id: TASK,
      pr_number: pr().prNumber, head_sha: HEAD, contract_revision: "contract-B" }];
    const fresh = fixture(unknownRows);
    fresh.state.revision = "contract-B";
    await runSweep([pr()], fresh.deps);
    assert.equal(fresh.state.refreshed, 0, "a prior intent without an outcome stays UNKNOWN across a restart");

    const repo = gitRepo({ scope: t, kind: "contract-incomplete-live" });
    const dir = join(repo.dir, "state");
    mkdirSync(dir);
    const ledger = join(dir, "ledger.ndjson");
    writeFileSync(ledger, JSON.stringify(headContractHold()) + "\n" +
      '{"task_id":"' + TASK + '","contract_revision":"contract-B",}\n' +
      JSON.stringify({ step: "unrelated.completed" }) + "\n");
    const real = fixture([headContractHold()]);
    real.state.revision = "contract-B";
    await runSweep([pr()], { ...real.deps, ledgerPath: ledger, readHeadContractRefreshHistory: undefined });
    assert.equal(real.state.refreshed, 0, "a torn intent followed by a valid row cannot authorize the effect");
    assert.equal(real.state.dispatched, 0);
  });

  test("a selected contract refresh rechecks authority and history at the action boundary", async () => {
    const rows = [headContractHold()];
    const f = fixture(rows);
    f.state.revision = "contract-B";
    const capability = await lightPassHeadContractRefresh([pr()], f.deps);
    f.state.revision = "contract-C";
    await runSweep([pr()], { ...f.deps, updateBranch: undefined, ...capability });
    assert.equal(f.state.refreshed, 0, "a capability selected under B cannot act on changed contract C");
    f.state.revision = "contract-B";
    const selected = await lightPassHeadContractRefresh([pr()], f.deps);
    const unseenAttempt = { step: "sweep.head_contract_refresh.attempted", task_id: TASK,
      pr_number: pr().prNumber, head_sha: HEAD, contract_revision: "contract-B" };
    await runSweep([pr()], { ...f.deps, updateBranch: undefined, ...selected,
      readHeadContractRefreshHistory: async () => ({ complete: true, lines: [unseenAttempt] }) });
    assert.equal(f.state.refreshed, 0, "an intent arriving after selection still blocks the write");
    assert.equal(f.state.dispatched, 0);
  });

  test("the real contract-refresh history finds an archived attempt and refuses unread history", async t => {
    const repo = gitRepo({ scope: t, kind: "contract-refresh-history" });
    const dir = join(repo.dir, "state");
    mkdirSync(dir);
    const ledger = join(dir, "ledger.ndjson");
    const attempt = { step: "sweep.head_contract_refresh.attempted", task_id: TASK, pr_number: pr().prNumber,
      head_sha: HEAD, contract_revision: "contract-B", ts: new Date(NOW).toISOString() };
    writeFileSync(join(dir, "ledger.2026-10-23.ndjson"), JSON.stringify(attempt) + "\n");
    writeFileSync(ledger, JSON.stringify(headContractHold()) + "\n");
    const f = fixture([headContractHold()]);
    f.state.revision = "contract-B";
    await runSweep([pr()], { ...f.deps, ledgerPath: ledger, readHeadContractRefreshHistory: undefined });
    assert.equal(f.state.refreshed, 0, "the production archive reader, rather than a retained live row, finds the intent");
    assert.equal(f.state.dispatched, 0);
    const missing = join(dir, "missing", "ledger.ndjson");
    await runSweep([pr()], { ...f.deps, ledgerPath: missing, readHeadContractRefreshHistory: undefined });
    assert.equal(f.state.refreshed, 0, "an absent corpus is UNKNOWN rather than proof of no prior attempt");
    assert.equal(f.state.dispatched, 0);
  });

  test("the real contract-refresh reader distinguishes empty evidence from an unattributed torn row", async t => {
    const repo = gitRepo({ scope: t, kind: "contract-torn-history" });
    const dir = join(repo.dir, "state");
    mkdirSync(dir);
    const ledger = join(dir, "ledger.ndjson");
    const hold = JSON.stringify(headContractHold()) + "\n";
    writeFileSync(ledger, hold);
    const healthy = fixture([headContractHold()]);
    healthy.state.revision = "contract-B";
    await runSweep([pr()], { ...healthy.deps, ledgerPath: ledger, readHeadContractRefreshHistory: undefined });
    assert.equal(healthy.state.refreshed, 1, "the real readable corpus is a positive control for the history boundary");
    for (const broken of ['{"unknown-truncated-record":\n', '{"unknown":"malformed",}\n']) {
      writeFileSync(ledger, hold + broken + JSON.stringify({ step: "unrelated.completed" }) + "\n");
      const damaged = fixture([headContractHold()]);
      damaged.state.revision = "contract-B";
      await runSweep([pr()], { ...damaged.deps, ledgerPath: ledger, readHeadContractRefreshHistory: undefined });
      assert.equal(damaged.state.refreshed, 0, "an unattributed damaged row cannot prove an empty attempt history");
      assert.equal(damaged.state.dispatched, 0);
    }
  });

  test("the light pass refuses non-object live rows through the real contract history reader", async t => {
    const { dir } = ownedFixtureDir(t, "contract-non-object-history");
    const ledger = join(dir, "ledger.ndjson");
    const hold = JSON.stringify(headContractHold()) + "\n";
    const f = fixture([headContractHold()]);
    f.state.revision = "contract-B";
    const deps = { ...f.deps, ledgerPath: ledger, readHeadContractRefreshHistory: undefined };
    writeFileSync(ledger, hold);
    const healthy = await lightPassHeadContractRefresh([pr()], deps);
    assert.equal(healthy.headContractRefreshFor?.(pr()), f.deps.updateBranch);
    for (const row of [null, false, 17, "unattributed", []]) {
      writeFileSync(ledger, hold + JSON.stringify(row) + "\n" +
        JSON.stringify({ step: "unrelated.completed" }) + "\n");
      assert.deepEqual(await lightPassHeadContractRefresh([pr()], deps), {}, JSON.stringify(row));
    }
    assert.equal(f.state.refreshed, 0);
    assert.equal(f.state.dispatched, 0);
    assert.equal(f.state.admissions, 0);
  });

  test("the light pass logs failed ledger reads and grants no contract refresh capability", async () => {
    for (const failure of ["live", "history"]) {
      const f = fixture([headContractHold()]);
      f.state.revision = "contract-B";
      const error = new Error(`${failure} ledger unavailable`);
      const logged: unknown[] = [];
      let historyReads = 0;
      const capability = await lightPassHeadContractRefresh([pr()], {
        ...f.deps,
        readLedger: () => {
          if (failure === "live") throw error;
          return [headContractHold()];
        },
        readHeadContractRefreshHistory: async () => {
          historyReads++;
          throw error;
        },
        log: (step, data) => { logged.push({ step, data }); },
      });
      assert.deepEqual(capability, {});
      assert.deepEqual(logged, [{ step: "sweep.head_contract_refresh.unreadable", data: { reason: String(error) } }]);
      assert.equal(historyReads, failure === "history" ? 1 : 0);
      assert.equal(f.state.refreshed, 0);
      assert.equal(f.state.dispatched, 0);
      assert.equal(f.state.admissions, 0);
    }
  });

  test("the contract refresh reader preserves torn evidence and reuses exact rotation digests", async t => {
    const repo = gitRepo({ scope: t, kind: "contract-history-digests" });
    const dir = join(repo.dir, "state");
    mkdirSync(dir);
    writeFileSync(join(dir, "ledger.ndjson"), "");
    writeFileSync(join(dir, "ledger.2026-10-23.ndjson"), '{"unknown-truncated-record":\n');
    let reads = 0;
    const opts = { parseAll: true, slice: { holder: "contract-refresh-fixture", version: "1",
      steps: ["sweep.head_contract_refresh.attempted"], project: (row: Record<string, unknown>) => ({ step: row.step }) },
      readFile: async (path: string) => { reads++; return readFile(path); } };
    const reader = sweepModule.createEscalationTriageHistoryReader(opts);
    assert.equal((await reader(dir)).torn, 1);
    assert.equal(reads, 1);
    assert.equal((await reader(dir)).torn, 1);
    assert.equal(reads, 1, "a repeated pass does not decompress the same archive again");
    const restarted = sweepModule.createEscalationTriageHistoryReader(opts);
    assert.equal((await restarted(dir)).torn, 1);
    assert.equal(reads, 1, "a fresh reader consumes the exact durable digest");
    assert.equal(restarted.lastLoad().digestHits, 1);
  });

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
