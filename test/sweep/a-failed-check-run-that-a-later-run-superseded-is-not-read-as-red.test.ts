import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "#src/lib/config.js";
import type { Plan } from "#src/lib/plan.js";
import { rollupForAsync, rollupFromRest } from "#src/lib/open-prs-rest.js";
import * as sweep from "#src/lib/sweep.js";
import type { OpenPrView, SweepDeps } from "#src/lib/sweep.js";

// #17793, head 14b8062, 2026-11-11. The `ci-gate` job of workflow CI (ci.yml) failed at 01:50:03Z, because
// acceptance-author-gate had failed at 01:25. A body edit ran acceptance-author-gate again (success at
// 01:52:53Z) and workflow CI gate (ci-gate.yml) posted a second `ci-gate` that passed at 01:53:04Z. The sweep
// read the PR as red on ci-gate and escalated it; it moved only after a person re-ran CI's ci-gate job.

const NOW = Date.parse("2026-11-11T02:06:53Z");
const HEAD = "14b8062e07789ef28bfa08f08c6f26601a1a8f01";
const CI_RUN = 42938819109;
const CI_GATE_RUN = 42942011505;
const ACCEPT_RUN_1 = 42938818774;
const ACCEPT_RUN_2 = 42942010284;
const FAILED_GATE_JOB = 130260991771;

interface RawCheck {
  id: number; name: string; status: string; conclusion: string | null;
  started_at: string; completed_at?: string; details_url: string;
}

function job(id: number, name: string, run: number, conclusion: string | null, started: string, completed?: string): RawCheck {
  return { id, name, status: conclusion === null ? "in_progress" : "completed", conclusion,
    started_at: `2026-11-11T${started}Z`, ...(completed ? { completed_at: `2026-11-11T${completed}Z` } : {}),
    details_url: `https://github.com/craigoley/remudero/actions/runs/${run}/job/${id}` };
}

// The check runs and workflow runs GitHub recorded for the head, as the tick's REST read returns them.
function measured(): RawCheck[] {
  return [
    job(130255414818, "acceptance-author-gate", ACCEPT_RUN_1, "failure", "01:25:15", "01:25:58"),
    job(FAILED_GATE_JOB, "ci-gate", CI_RUN, "failure", "01:39:30", "01:50:03"),
    job(130265807114, "acceptance-author-gate", ACCEPT_RUN_2, "success", "01:52:11", "01:52:53"),
    job(130265811120, "ci-gate", CI_GATE_RUN, "success", "01:52:12", "01:53:04"),
  ];
}
const WORKFLOW_RUNS = [
  { id: CI_RUN, workflow_id: 312964904 }, { id: CI_GATE_RUN, workflow_id: 313901555 },
  { id: ACCEPT_RUN_1, workflow_id: 338825600 }, { id: ACCEPT_RUN_2, workflow_id: 338825600 },
];

function planPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 17793, prUrl: "https://github.com/craigoley/remudero/pull/17793", reviewState: "success",
    checksState: "red", unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date(NOW - 60_000).toISOString(),
    headSha: HEAD, headRefName: "codex/amend-w1-t11841", autoMergeArmed: false, isPlanFiling: true,
    planFilingSource: "github-files", ciFailures: [{ name: "ci-gate", logTail: "", conclusion: "FAILURE" }],
    body: "Amends W1-T11841.", ...over,
  };
}

function greenPeer(): OpenPrView {
  return planPr({ prNumber: 6900, prUrl: "https://github.com/craigoley/remudero/pull/6900", taskId: "W1-T4000",
    checksState: "green", headSha: "e".repeat(40), headRefName: "run-W1-T4000-1", isPlanFiling: false, ciFailures: undefined });
}

// One sweep pass through the production effects: the real REST rollup read and the real job re-run route,
// on a fixture GitHub. Only the transport and the escalation sink are fakes.
async function pass(checks: RawCheck[], ledger: Record<string, unknown>[], over: Partial<SweepDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t12273-"));
  const reruns: string[][] = [];
  const escalated: string[] = [];
  try {
    const effects = sweep.buildSweepEffects({ owner: "craigoley", repo: "remudero", config: { root } as Config,
      ledgerPath: join(root, "ledger.ndjson"), runId: "W1-T12273-test", plan: { tasks: [], byId: new Map() } as unknown as Plan,
      log: () => {}, restRollupForImpl: rollupForAsync, readJsonImpl: async (args) => {
        if (args[1].includes("/check-runs?")) return { check_runs: checks };
        if (args[1].endsWith("/status")) return { statuses: [] };
        if (args[1].includes("/actions/runs?head_sha=")) return { workflow_runs: WORKFLOW_RUNS };
        throw new Error(`unexpected fixture read: ${args[1]}`);
      }, ghRunImpl: (_file, args) => { reruns.push([...args]); },
    });
    const deps = {
      arm: () => {}, close: () => {}, dispatchFix: () => {}, postReview: async () => {},
      escalate: (pr: OpenPrView, reason: string) => { if (pr.prNumber === 17793) escalated.push(reason); },
      readCiGateRollup: effects.readCiGateRollup, reaggregateCiGate: effects.reaggregateCiGate,
      behindMainByPr: new Map([[17793, 0], [6900, 0]]),
      ledgerPath: join(root, "sweep-ledger.ndjson"), runId: "W1-T12273-test",
      readLedger: () => ledger,
      appendLine: (_path: string, line: Record<string, unknown>) => { ledger.push(line); },
      now: () => NOW, ...over,
    } as unknown as SweepDeps;
    await sweep.runSweep([planPr(), greenPeer()], deps, sweep.DEFAULT_SWEEP_POLICY);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const disposed = ledger.filter((l) => l.step === "sweep.disposed" && l.pr_number === 17793).at(-1);
  const redrives = ledger.filter((l) => l.step === sweep.CI_GATE_REAGGREGATE_STEP && l.pr_number === 17793);
  return { reruns, escalated, disposed, redrives };
}

const mainGreen = () => ({ step: "main.health.observed", sha: "c".repeat(40), state: "green", failing_checks: [] });
const RERUN_FAILED_GATE = ["api", "-X", "POST", `repos/craigoley/remudero/actions/jobs/${FAILED_GATE_JOB}/rerun`];

test("W1-T12273 criterion 1: the #17793 plan-only red re-runs CI's ci-gate job once, not an escalation", async () => {
  const run = await pass(measured(), [mainGreen()]);
  assert.deepEqual(run.reruns, [RERUN_FAILED_GATE], "the failed producer's own ci-gate job is re-run");
  assert.equal(run.redrives.length, 1);
  assert.equal(run.redrives[0]?.sibling_name, "acceptance-author-gate");
  assert.equal(run.redrives[0]?.sibling_started_at, "2026-11-11T01:52:11Z");
  assert.equal(run.disposed?.disposition, "wait");
  assert.match(String(run.disposed?.reason), /stale ci-gate verdict — re-driving its job/);
  assert.deepEqual(run.escalated, []);
});

test("W1-T12273 criterion 2: a later pass on the same head and transition re-runs nothing and files no escalation", async () => {
  const ledger: Record<string, unknown>[] = [mainGreen()];
  await pass(measured(), ledger);
  const again = await pass(measured(), ledger);
  assert.deepEqual(again.reruns, [], "the ledgered bound holds the re-run to one");
  assert.equal(again.disposed?.disposition, "wait");
  assert.match(String(again.disposed?.reason), /already re-driven for this transition/);
  assert.deepEqual(again.escalated, []);
});

test("W1-T12273 criterion 3: the two-workflow ci-gate rollup still reads red (#14160)", () => {
  const rows = rollupFromRest(measured(), [], WORKFLOW_RUNS);
  for (const order of [rows, [...rows].reverse()]) {
    assert.equal(sweep.checksStateFromRollup(order, ["ci-gate"]), "red", "a pass from CI gate never clears CI's failure");
    assert.deepEqual(sweep.stillRedRequiredNames(["ci-gate"], order), ["ci-gate"]);
    assert.equal(sweep.supersededRedsNowPassing(order).includes("ci-gate"), false);
  }
});

test("W1-T12273 criterion 4: when the re-run of CI's ci-gate fails again, the plan-only escalation stays", async () => {
  const ledger: Record<string, unknown>[] = [mainGreen()];
  await pass(measured(), ledger);
  const failedAgain = [...measured(), job(130278407602, "ci-gate", CI_RUN, "failure", "02:25:02", "02:25:22")];
  const run = await pass(failedAgain, ledger);
  assert.deepEqual(run.reruns, [], "a gate attempt newer than the sibling's success is not stale");
  assert.equal(run.disposed?.disposition, "refused-escalate");
  assert.match(String(run.disposed?.reason), /plan-only PR is red on ci-gate/);
  assert.equal(run.escalated.length, 1);
});

test("W1-T12273 criterion 5: a light pass or a dry run re-runs nothing and does not escalate the stale gate", async () => {
  for (const over of [{ actionable: (d: string) => d !== "blocked-fixable" }, { dryRun: true }] as Partial<SweepDeps>[]) {
    const run = await pass(measured(), [mainGreen()], over);
    assert.deepEqual(run.reruns, []);
    assert.equal(run.redrives.length, 0);
    assert.deepEqual(run.escalated, []);
    // A dry run writes no ledger row; the light pass names why it waits.
    if (over.dryRun !== true) assert.match(String(run.disposed?.reason), /its re-run waits for a full sweep pass/);
  }
});

test("W1-T12273 criterion 6: a later ci-gate attempt still in progress leaves the check pending and re-runs nothing", async () => {
  const rerunning = [...measured(), job(130278407602, "ci-gate", CI_RUN, null, "02:25:02")];
  const rows = rollupFromRest(rerunning, [], WORKFLOW_RUNS);
  assert.equal(sweep.checksStateFromRollup(rows, ["ci-gate"]), "pending");
  assert.equal(sweep.staleCiGateTransition(rows), undefined);
  const run = await pass(rerunning, [mainGreen()]);
  assert.deepEqual(run.reruns, []);
});
