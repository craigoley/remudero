import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { type OpenPrView } from "#src/lib/sweep.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { DEFAULT_SWEEP_POLICY, runSweepLightPass, type SweepDeps } from "#test/helpers/sweep-test.js";

const BASE = Date.parse("2026-10-20T12:00:00.000Z");

function planPr(prNumber: number): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    taskId: `W1-T${prNumber}`,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(BASE - 60_000).toISOString(),
    headSha: `head${prNumber}`,
    autoMergeArmed: false,
    isPlanFiling: true,
  };
}

function rowsAt(ledger: string): Array<Record<string, unknown>> {
  return readFileSync(ledger, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function pairedPassRows(intervalsMs: number[], scope = "idle"): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  let startedAt = BASE;
  const starts = [startedAt];
  for (const interval of intervalsMs) {
    startedAt += interval;
    starts.push(startedAt);
  }
  starts.forEach((at, index) => {
    const passId = `prior-${index}`;
    rows.push({ ts: new Date(at).toISOString(), task_id: "SWEEP", run_id: passId, step: "sweep.pass",
      pass_id: passId, light_pass_scope: scope });
    rows.push({ ts: new Date(at + 1).toISOString(), task_id: "SWEEP", run_id: passId, step: "sweep.summary",
      pass_id: passId, light_pass_scope: scope, elapsed_ms: 1 });
  });
  return rows;
}

function heldPlanRow(pr: OpenPrView, heldAtMs: number): Record<string, unknown> {
  return {
    ts: new Date(heldAtMs).toISOString(), run_id: "review-held", task_id: pr.taskId,
    step: "automerge.plan_pr_held", pr_number: pr.prNumber, pr_url: pr.prUrl, head_sha: pr.headSha,
    mergeable_state: "blocked", remedy: "retry-later",
  };
}

function sweepDeps(ledger: string, armed: number[], arm?: SweepDeps["arm"]): SweepDeps {
  return {
    log: (step, extra = {}) => appendFileSync(ledger, `${JSON.stringify({
      run_id: "SWEEP-W1-T11445", task_id: "SWEEP", step, ts: new Date(BASE).toISOString(), ...extra,
    })}\n`),
    arm: arm ?? (async (pr): Promise<"direct-merged"> => { armed.push(pr.prNumber); return "direct-merged"; }),
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: () => {},
    ledgerPath: ledger,
    runId: "SWEEP-W1-T11445",
    now: () => BASE,
    lightPassScope: "idle",
    actionable: (disposition) => disposition === "mergeable" || disposition === "post-review",
  };
}

const mergeRows = (ledger: string) => rowsAt(ledger).filter((row) => row.step === "sweep.disposed" && row.plan_merge_elapsed_ms !== undefined);

test("W1-T11445 criterion 1: light passes emit paired measurements and reject incomplete intervals", async () => {
  const ledger = writeLedger().path;
  await runSweepLightPass([], sweepDeps(ledger, []), DEFAULT_SWEEP_POLICY);
  const rows = rowsAt(ledger);
  const starts = rows.filter((row) => row.step === "sweep.pass" && row.pass_id !== undefined);
  const summaries = rows.filter((row) => row.step === "sweep.summary" && row.pass_id !== undefined);
  assert.equal(starts.length, 1);
  assert.equal(summaries.length, 1);
  assert.equal(starts[0]?.light_pass_scope, "idle");
  assert.equal(summaries[0]?.light_pass_scope, "idle");
  assert.equal(summaries[0]?.pass_id, starts[0]?.pass_id);
  assert.ok(typeof starts[0]?.pass_id === "string" && starts[0].pass_id.length > 0);
  const elapsed = summaries[0]?.elapsed_ms;
  assert.ok(typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= 0);
});

test("W1-T11445 criterion 2: plan merge attempts record elapsed time and outcome", async () => {
  const ledger = writeLedger().path;
  const armed: number[] = [];
  const pr = planPr(1144501);
  await runSweepLightPass([pr], sweepDeps(ledger, armed), DEFAULT_SWEEP_POLICY);
  assert.deepEqual(armed, [pr.prNumber]);
  const row = mergeRows(ledger).find((entry) => entry.pr_number === pr.prNumber);
  assert.equal(row?.pass_id && typeof row.pass_id, "string");
  assert.equal(row?.plan_merge_outcome, "direct-merged");
  const elapsed = row?.plan_merge_elapsed_ms;
  assert.ok(typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= 0);
});

test("W1-T11445 criterion 3: plan merge work stops at the measured interval budget", async () => {
  const ledger = writeLedger(pairedPassRows([250, 250, 250])).path;
  const armed: number[] = [];
  const slowArm: SweepDeps["arm"] = async (pr): Promise<"direct-merged"> => {
    armed.push(pr.prNumber);
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    return "direct-merged";
  };
  await runSweepLightPass([planPr(1144511), planPr(1144512), planPr(1144513)],
    sweepDeps(ledger, armed, slowArm), DEFAULT_SWEEP_POLICY);
  assert.deepEqual(armed, [1144511, 1144512], "a second merge fits before the 250ms budget; a third does not");
  const deferred = rowsAt(ledger).find((row) => row.step === "sweep.disposed" && row.pr_number === 1144513);
  assert.match(String(deferred?.stand_down_reason), /budget.*250/);
  assert.match(String(deferred?.stand_down_reason), /spent/);
});

test("W1-T11445 criterion 4: invalid or sparse measurements keep the one-plan bound", async () => {
  const sparse = pairedPassRows([25]);
  const malformed = [
    ...pairedPassRows([25, 25, 25]).filter((row) => row.step !== "sweep.summary" || row.pass_id !== "prior-2"),
    { ts: new Date(BASE + 999).toISOString(), run_id: "dup", task_id: "SWEEP", step: "sweep.pass",
      pass_id: "prior-0", light_pass_scope: "idle" },
  ];
  const clockRegressed = pairedPassRows([250, 250, 250, 250]);
  for (const row of clockRegressed) {
    if (row.step === "sweep.pass" && row.pass_id === "prior-2") row.ts = new Date(BASE + 200).toISOString();
    if (row.step === "sweep.pass" && row.pass_id === "prior-3") row.ts = new Date(BASE + 500).toISOString();
    if (row.step === "sweep.pass" && row.pass_id === "prior-4") row.ts = new Date(BASE + 750).toISOString();
  }
  const summaryBeforeStart = pairedPassRows([250, 250, 250]);
  const summaryIndex = summaryBeforeStart.findIndex((row) => row.step === "sweep.summary" && row.pass_id === "prior-1");
  const startIndex = summaryBeforeStart.findIndex((row) => row.step === "sweep.pass" && row.pass_id === "prior-1");
  const [outOfOrderSummary] = summaryBeforeStart.splice(summaryIndex, 1);
  summaryBeforeStart.splice(startIndex, 0, outOfOrderSummary!);

  for (const rows of [sparse, malformed, clockRegressed, summaryBeforeStart]) {
    const ledger = writeLedger(rows).path;
    const armed: number[] = [];
    const first = planPr(1144521);
    const second = planPr(1144522);
    await runSweepLightPass([first, second], sweepDeps(ledger, armed), DEFAULT_SWEEP_POLICY);
    assert.deepEqual(armed, [first.prNumber]);
    const deferred = rowsAt(ledger).find((row) => row.step === "sweep.disposed" && row.pr_number === second.prNumber);
    assert.match(String(deferred?.stand_down_reason), /one never-held plan PR direct-merges per light pass/);
  }

  const olderHeld = planPr(1144523);
  const newerHeld = planPr(1144524);
  const heldLedger = writeLedger([
    heldPlanRow(olderHeld, BASE - 60_000),
    heldPlanRow(newerHeld, BASE - 120_000),
  ]).path;
  const heldArmed: number[] = [];
  await runSweepLightPass([olderHeld, newerHeld], sweepDeps(heldLedger, heldArmed), DEFAULT_SWEEP_POLICY);
  assert.deepEqual(heldArmed, [newerHeld.prNumber, olderHeld.prNumber],
    "sparse cadence retains the oldest-held-first re-evaluation for every ready held plan PR");

  const noDurationLedger = writeLedger(pairedPassRows([250, 250, 250])).path;
  const noDurationArmed: number[] = [];
  const noDurationDeps = sweepDeps(noDurationLedger, noDurationArmed);
  noDurationDeps.readArmFacts = (pr) => ({
    prNumber: pr.prNumber,
    headSha: pr.headSha,
    state: "open",
    autoMergeArmed: true,
    mergeable: true,
    mergeableState: "clean",
    baseSha: "base",
    reviewPublished: true,
    checksGreen: true,
  });
  await runSweepLightPass([planPr(1144531), planPr(1144532)], noDurationDeps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(noDurationArmed, [], "a fresh already-armed observation records no new merge duration");
  // W1-T12266: a turn with no merge attempt spends no budget, so the next PR is judged on its own facts.
  const noDurationDeferred = rowsAt(noDurationLedger).find((row) =>
    row.step === "sweep.disposed" && row.pr_number === 1144532);
  assert.doesNotMatch(String(noDurationDeferred?.stand_down_reason), /duration unavailable or invalid/);
  assert.match(String(noDurationDeferred?.stand_down_reason), /already armed \(fresh GitHub observation\)/);
});
