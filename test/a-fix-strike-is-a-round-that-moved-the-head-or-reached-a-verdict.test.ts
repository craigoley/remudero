import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as sweep from "./helpers/sweep-test.js";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { priorStrikesFor, runFixRung } from "./helpers/run-task-test.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";

const TASK = "W1-T5542";
const HEAD = "73dd194";
const REASON = "the worker changed nothing";
type Row = Record<string, unknown>;

function round(id: string | undefined, reason?: string, head = HEAD): Row[] {
  const identity = { task_id: TASK, strike: 1, head_sha: head, ...(id ? { round_id: id } : {}) };
  return [
    { ...identity, step: "fix.dispatch", verdict_regime: "executed" },
    ...(reason === undefined ? [] : [{ ...identity, step: "fix.commit_refused", reason }]),
    { ...identity, step: "fix.done", subtype: reason === undefined ? "success" : "commit_refused" },
  ];
}

function view(rows: Row[]): sweep.OpenPrView {
  const tally = sweep.fixRoundTally(rows, TASK, HEAD, "executed");
  return {
    prNumber: 8868, prUrl: "https://github.com/acme/remudero/pull/8868", taskId: TASK,
    headSha: HEAD, reviewState: "none", checksState: "red", unmetCriteria: [],
    priorStrikes: priorStrikesFor(rows, TASK, "executed", HEAD),
    repeatedFixRefusal: tally.repeatedRefusal, fixRefusalsAtHead: tally.refusals.length,
    lastActivityAt: new Date().toISOString(), autoMergeArmed: false,
    ciFailures: [{ name: "ci", logTail: "error TS2322: incompatible assignment" }],
  };
}

async function underClaim(rows: Row[], seedDispatch = false) {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-outcome-strikes-")), "ledger.ndjson");
  if (seedDispatch) appendLedger(ledgerPath, { run_id: "old-sweep", task_id: TASK, step: "sweep.disposed", head_sha: HEAD, pr_number: 8868, disposition: "blocked-fixable", acted: true, red_checks: ["ci"] });
  for (const row of rows) appendLedger(ledgerPath, { run_id: "fixture", task_id: TASK, step: String(row.step), ...row });
  let dispatched = 0;
  const stale = { ...view([]), priorStrikes: 0 };
  const result = await sweep.runSweep([stale], {
    ledgerPath, runId: "fixture-sweep", now: () => Date.now(),
    arm: () => {}, close: () => {}, escalate: () => {},
    dispatchFix: () => { dispatched++; },
  }, sweep.DEFAULT_SWEEP_POLICY);
  const disposed = readLedgerLines(ledgerPath).filter((row) => row.step === "sweep.disposed").at(-1);
  return { dispatched, result, disposed };
}

test("W1-T5542: refused rounds are never strikes and both readers agree", async () => {
  for (const identified of [false, true]) {
    const rows = [...round(identified ? "r1" : undefined, REASON), ...round(identified ? "r2" : undefined, REASON)];
    assert.equal(priorStrikesFor(rows, TASK, "executed", HEAD), 0);
    const disposition = sweep.deriveDisposition(view(rows));
    assert.equal(disposition.disposition, "blocked-fixable", "the sweep asks the progress judge to rule on repeated refusals");
    const claimed = await underClaim(rows);
    assert.equal(claimed.dispatched, 0, "the stale view cannot authorize a third refused round");
    assert.match(String(claimed.result.actions[0]?.reason), /fix progress judgment due after repeated refusal/);
    assert.equal(sweep.fixRoundTally(rows, TASK, HEAD).strikes, 0);
  }
  const single = await underClaim(round("r1", REASON), true);
  assert.equal(single.dispatched, 1, "one refusal earns one retry");
});

test("W1-T5542: incomplete legacy history preserves the cap while identified rounds need outcomes", async () => {
  const legacy = [1, 2].map((strike) => ({ task_id: TASK, step: "fix.dispatch", strike, head_sha: HEAD, verdict_regime: "executed" }));
  assert.equal(priorStrikesFor(legacy, TASK, "executed", HEAD), 2);
  assert.equal((await underClaim(legacy)).dispatched, 0, "missing historical receipts cannot re-open an exhausted cap");
  assert.equal(sweep.fixRoundTally(legacy, TASK, "other-head").strikes, 0);
  assert.equal(sweep.fixRoundTally(legacy.map((row) => ({ ...row, verdict_regime: "keyword_only" })), TASK, HEAD, "executed").strikes, 0);
  assert.equal(sweep.fixRoundTally(legacy.map((row) => ({ ...row, kind: "proof_amendment" })), TASK, HEAD).strikes, 0);
  const identified = legacy.map((row) => ({ ...row, round_id: `r${row.strike}` }));
  assert.equal(priorStrikesFor(identified, TASK, "executed", HEAD), 0, "new dispatches alone do not prove completed work");
  assert.equal((await underClaim(identified)).dispatched, 1);
  const bodyRepair = { ...legacy[0], mode: "body-repair" };
  assert.equal(sweep.fixRoundTally([bodyRepair], TASK, HEAD, "executed").strikes, 1, "a completed body write retains its own bounded repair budget");
  const orphan = { task_id: TASK, step: "fix.commit_refused", head_sha: HEAD, reason: REASON };
  const held = await underClaim([orphan], true);
  assert.equal(held.dispatched, 0, "an unpaired refusal cannot establish the one-retry allowance");
  assert.match(String(held.disposed?.stand_down_reason), /the worker changed nothing/);
});

test("W1-T5542: a round that moved the head or reached a verdict is one strike", async () => {
  for (const id of [undefined, "r1"]) {
    const pushed = round(id);
    pushed[1].pushed_head_sha = "new-head";
    assert.equal(sweep.fixRoundTally(pushed, TASK, HEAD).strikes, 1);
    const reviewed = [...round(id), { task_id: TASK, step: "fix.review", strike: 1, ...(id ? { round_id: id } : {}) }];
    assert.equal(sweep.fixRoundTally(reviewed, TASK, HEAD).strikes, 1);
    assert.equal(priorStrikesFor(reviewed, TASK, "executed", HEAD), 1);
    assert.equal(sweep.fixRoundTally(round(id), TASK, HEAD).strikes, 0, "a done row alone has no judgment");
    assert.equal(sweep.fixRoundTally([reviewed[0], reviewed[2]], TASK, HEAD).strikes, id === undefined ? 1 : 0, "legacy dispatch evidence fails closed; identified rounds require a worker receipt");
  }
  const first = round("r1");
  first[1].pushed_head_sha = "new-head";
  const second = [...round("r2"), { task_id: TASK, step: "fix.review", strike: 1, round_id: "r2" }];
  const two = [...first, ...second];
  assert.equal(sweep.fixRoundTally(two, TASK, HEAD).strikes, 2, "strike numbers may repeat across invocations");
  assert.equal((await underClaim(two)).dispatched, 0);
  const interleaved = [first[0], second[0], second[1], second[2], first[1], first[1]];
  assert.equal(sweep.fixRoundTally(interleaved, TASK, HEAD).strikes, 2, "round identity survives interleaving and duplicate receipts");
  const legacy = [...round(undefined, REASON), ...round(undefined), { task_id: TASK, step: "fix.review", strike: 1 }];
  assert.equal(sweep.fixRoundTally(legacy, TASK, HEAD).strikes, 1);
  assert.equal(sweep.fixRoundTally(legacy, TASK, HEAD).refusals.length, 1);
  const legacyPushed = round(undefined);
  legacyPushed[1].pushed_head_sha = "new-head";
  const legacyReviewed = [...round(undefined), { task_id: TASK, step: "fix.review", strike: 1 }];
  assert.equal(sweep.fixRoundTally([...legacyPushed, ...legacyReviewed], TASK, HEAD).strikes, 2);
  assert.equal(sweep.fixRoundTally(first, TASK, "other-head").strikes, 0);
  assert.equal(sweep.fixRoundTally([...round("r1"), { task_id: "other-task", step: "fix.review", round_id: "r1", strike: 1 }], TASK, HEAD).strikes, 0);
});

test("W1-T5542: a repeated identical refusal stops the rung without a strike", async () => {
  const identical = [...round("r1", REASON), ...round("r2", REASON)];
  const disposition = sweep.deriveDisposition(view(identical));
  assert.equal(disposition.disposition, "blocked-fixable");
  assert.match(disposition.reason, /fix progress judgment due after repeated refusal: the worker changed nothing/);
  assert.match(disposition.reason, /ci/);
  assert.doesNotMatch(disposition.reason, /\d+\/\d+/);
  const different = [...round("r1", REASON), ...round("r2", "outside its declared files")];
  assert.equal(sweep.deriveDisposition(view(different)).disposition, "blocked-fixable");
  assert.match(sweep.deriveDisposition(view(different)).reason, /refused \(2 at this head\)/);
  assert.equal((await underClaim(different, true)).dispatched, 1);
  assert.equal(sweep.deriveDisposition({ ...view(identical), reviewState: "failure", checksState: "green" }).disposition, "blocked-ambiguous");
  assert.equal(sweep.fixRoundTally([...identical, ...round("other", REASON, "other-head")], TASK, "other-head").repeatedRefusal, undefined);
});

test("W1-T5542: the 8868 ledger shape never renders an overshoot", async () => {
  const rows = [1, 2, 3].flatMap(() => round(undefined, REASON));
  const tally = sweep.fixRoundTally(rows, TASK, HEAD);
  assert.equal(tally.strikes, 0);
  assert.equal(tally.refusals.length, 3);
  const disposition = sweep.deriveDisposition(view(rows));
  assert.doesNotMatch(disposition.reason, /3\/2/);
  assert.match(disposition.reason, /fix progress judgment due after repeated refusal/);
  assert.equal((await underClaim(rows)).dispatched, 0);
});

test("W1-T5542: amnesty and identity exclusions apply to both readers", async () => {
  const rows = ["r1", "r2"].flatMap((id) => [...round(id), { task_id: TASK, step: "fix.review", strike: 1, round_id: id }]);
  for (const row of rows) if (row.step === "fix.dispatch") row.verdict_regime = "keyword_only";
  rows.push({ task_id: TASK, step: "review.posted", proof_exec: ["executed_fail"] });
  assert.equal(priorStrikesFor(rows, TASK, "executed", HEAD), 0);
  assert.equal((await underClaim(rows)).dispatched, 1);
  assert.equal(sweep.fixRoundTally(rows, TASK, HEAD, "keyword_only").strikes, 2);
  const excluded = rows.map((row) => row.step === "fix.dispatch" ? { ...row, kind: "proof_amendment" } : row);
  excluded.push({ task_id: TASK, step: "fix.retrigger", strike: 1, head_sha: HEAD });
  assert.equal(sweep.fixRoundTally(excluded, TASK, HEAD).strikes, 0);
  assert.equal(sweep.fixRoundTally(rows, undefined, HEAD).strikes, 0);
});

test("W1-T5542: the rung stamps round identities and renders refused rounds without a strike", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-strike-rung-"));
  const rows: Row[] = [];
  const messages: string[] = [];
  const initialReview = {
    state: "failure" as const, headSha: HEAD, reviewerOutcome: "failure",
    criteria: [{ claim: "the fix lands", proof: "unit test: the fix lands", met: false, reason: "blocked", proof_exec: "executed_fail" as const }],
    testTheater: false, summary: "blocked", floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
  };
  const mount = { model: "sonnet", effort: "medium" as const, maxTurns: 20, contextBudget: 120000 };
  const opts = {
    taskId: TASK, runId: "fixture-run", task: { id: TASK, title: "outcome strikes", files: ["src/run-task.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/8868", branch: "run-W1-T5542-1", worktreePath: root,
    initialSessionId: "session", mount, settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 1, strikeCap: 2, initialReview,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
    deps: {
      spawn: async () => ({ sessionId: "fix-session", text: "REPORT", blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], costUsd: 0, numTurns: 1, model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false } as WorkerResult),
      waitForCiGreen: async () => "green" as const, fetchPrBody: async () => "REPORT",
      runReview: async () => ({ ...initialReview, state: "success" as const, criteria: [{ ...initialReview.criteria[0], met: true }] }),
      push: () => {}, issues: { create: () => "https://github.com/acme/remudero/issues/1" },
      ledgerPath: join(root, "ledger.ndjson"),
      log: (step: string, extra?: Row) => rows.push({ task_id: TASK, step, ...extra }),
      say: (message: string) => messages.push(message), account: (result: WorkerResult) => result,
      harnessCommitForShellLessWorker: (input: Parameters<NonNullable<Parameters<typeof runFixRung>[0]["deps"]["harnessCommitForShellLessWorker"]>>[0]) => { input.onRefusal?.(REASON); return 0; },
      worktreeHasUncommittedChanges: () => false,
    },
  };
  const refused = await runFixRung(opts);
  assert.equal(refused.strikes, 0);
  const receipts = rows.filter((row) => ["fix.dispatch", "fix.commit_refused", "fix.done"].includes(String(row.step)));
  assert.equal(receipts.length, 3);
  assert.match(String(receipts[0].round_id), /^fixture-run:1:\d+$/);
  assert.ok(receipts.every((row) => row.round_id === receipts[0].round_id));
  assert.ok(messages.some((message) => /refused \(1 at this head\)/.test(message)));
  assert.ok(messages.every((message) => !/strike \d+\/\d+/.test(message)));
  const refusedRows = rows.slice();
  rows.length = 0;
  opts.deps.harnessCommitForShellLessWorker = () => 1;
  let retryPrompt = "";
  const fixed = await runFixRung({ ...opts, deps: {
    ...opts.deps, ledgerLines: () => refusedRows,
    spawn: async (args) => { retryPrompt = args.prompt; return opts.deps.spawn(); },
  } });
  assert.equal(fixed.outcome, "fixed");
  assert.match(retryPrompt, /LAST ROUND'S COMMIT WAS REFUSED.*the worker changed nothing/);
  const completed = rows.filter((row) => ["fix.dispatch", "fix.done", "fix.review"].includes(String(row.step)));
  assert.equal(completed.length, 3);
  assert.ok(completed.every((row) => row.round_id === completed[0].round_id));
  assert.equal(sweep.fixRoundTally(rows, TASK, HEAD).strikes, 1);
  rows.length = 0;
  opts.deps.push = () => { throw new Error("push failed"); };
  await assert.rejects(runFixRung(opts), /push failed/);
  assert.equal(rows.find((row) => row.step === "fix.done")?.pushed_head_sha, undefined);
  assert.equal(rows.filter((row) => row.step === "fix.done").length, 1, "push errors retain the worker receipt");
  assert.equal(sweep.fixRoundTally(rows, TASK, HEAD).strikes, 0);
});
