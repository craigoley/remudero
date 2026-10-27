/**
 * W1-T9212 — A HELD PLAN PR MERGES WHEN ITS CHECKS TURN GREEN, NOT ON THE NEXT LIGHT PASS.
 *
 * MEASURED 2026-10-13: 52 plan PRs were held (`automerge.plan_pr_held`) and later direct-merged;
 * median 7 min, 10 over 15 min (#11322 97 min). A held plan PR waited for a LATER light pass, and a
 * light pass direct-merged only ONE plan PR, so a second held PR waited a pass behind the first.
 * Now every held plan PR the pass observes ready is re-evaluated in that same observation, one at a
 * time under the pass's single W1-T5901 claim, each with a fresh arm-time mergeability read, and each
 * writes `sweep.plan_pr_reevaluated` naming its trigger and the wait since the hold.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  armAutoMergeDetailedAsync,
  heldPlanPrFromLedger,
  type ArmDeps,
} from "../src/lib/arm-auto-merge.js";
import { selectLightPassPlanMerge, selectLightPassPlanMerges } from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { lightPassActionable } from "../src/run-task.js";
import {
  DEFAULT_SWEEP_POLICY,
  runSweepLightPass,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";

const NOW = Date.parse("2026-10-13T15:10:00Z");
const HELD_AT = NOW - 15 * 60_000;
const REEVALUATED = "sweep.plan_pr_reevaluated";

function planPr(prNumber: number): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    taskId: `W1-T${prNumber}`,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    headSha: `head${prNumber}`,
    autoMergeArmed: false,
    isPlanFiling: true,
  };
}

/** The row the review lane / sweep arm wrote when it held this PR, as `logArmAttribution` writes it. */
function heldRow(pr: OpenPrView, held: { mergeable_state: string; remedy: string }): Record<string, unknown> {
  return {
    ts: new Date(HELD_AT).toISOString(),
    run_id: "review-held",
    task_id: pr.taskId,
    step: "automerge.plan_pr_held",
    pr_number: pr.prNumber,
    pr_url: pr.prUrl,
    head_sha: pr.headSha,
    lane: "review",
    plan_touch: "touched",
    ...held,
  };
}

function ledgerWith(rows: Array<Record<string, unknown>>): string {
  const ledger = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t9212-`)), "ledger.ndjson");
  writeFileSync(ledger, "");
  for (const row of rows) appendFileSync(ledger, `${JSON.stringify(row)}\n`);
  return ledger;
}

/** `outcomes` answers each arm; `inFlight` records the widest overlap of arms the pass made. */
function sweepDeps(ledger: string, armed: number[], outcomes: Map<number, string>, overlap = { now: 0, max: 0 }): SweepDeps {
  return {
    log: () => {},
    arm: async (p) => {
      armed.push(p.prNumber);
      overlap.now++;
      overlap.max = Math.max(overlap.max, overlap.now);
      await new Promise<void>((resolve) => setImmediate(resolve));
      overlap.now--;
      return (outcomes.get(p.prNumber) ?? "direct-merged") as "direct-merged";
    },
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: () => {},
    ledgerPath: ledger,
    runId: "SWEEP-W1-T9212",
    now: () => NOW,
    actionable: (d) => lightPassActionable(d, false, false, true),
  };
}

const reevaluations = (ledger: string) => readLedgerLines(ledger).filter((l) => l.step === REEVALUATED);

test("W1-T9212: a held plan PR merges when its checks turn green", async () => {
  // Two plan PRs held at review while their required checks were pending (`blocked`); this pass
  // observes both green and reviewed. Before: one merged, the other waited for a later pass.
  const first = planPr(9401);
  const second = planPr(9402);
  const ledger = ledgerWith([
    heldRow(first, { mergeable_state: "blocked", remedy: "retry-later" }),
    heldRow(second, { mergeable_state: "blocked", remedy: "retry-later" }),
  ]);
  const armed: number[] = [];
  await runSweepLightPass([first, second], sweepDeps(ledger, armed, new Map()), DEFAULT_SWEEP_POLICY);

  assert.deepEqual([...armed].sort(), [9401, 9402], "both held plan PRs were re-evaluated in the one pass that saw them green");
  const rows = reevaluations(ledger);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.trigger, "checks-green");
    assert.equal(row.wait_ms, NOW - HELD_AT, "the wait since the hold is measured from the hold's own row");
    assert.equal(row.arm_outcome, "direct-merged");
  }
});

test("W1-T9212: a held plan PR on unknown mergeability merges when it settles", async () => {
  // Held when GitHub had not computed mergeability. The next pass re-reads it FRESH (the arm reads
  // the live facts; nothing is inherited): the one GitHub now answers merges, the one still unknown stays held.
  const settled = planPr(9411);
  const stillUnknown = planPr(9412);
  const ledger = ledgerWith([
    heldRow(settled, { mergeable_state: "unknown", remedy: "mergeability-unknown" }),
    heldRow(stillUnknown, { mergeable_state: "unknown", remedy: "mergeability-unknown" }),
  ]);
  const armed: number[] = [];
  const outcomes = new Map<number, string>([[9411, "direct-merged"], [9412, "plan-pr-held"]]);
  await runSweepLightPass([settled, stillUnknown], sweepDeps(ledger, armed, outcomes), DEFAULT_SWEEP_POLICY);

  assert.deepEqual([...armed].sort(), [9411, 9412], "each held PR was re-read by its own arm, not by an inherited reading");
  const byPr = new Map(reevaluations(ledger).map((row) => [row.pr_number, row]));
  assert.equal(byPr.get(9411)?.trigger, "mergeability-settled");
  assert.equal(byPr.get(9411)?.arm_outcome, "direct-merged");
  assert.equal(byPr.get(9412)?.trigger, "mergeability-settled");
  assert.equal(byPr.get(9412)?.arm_outcome, "plan-pr-held", "a still-unknown PR stays held; the stale hold never merges it");
  assert.equal(byPr.get(9411)?.wait_ms, NOW - HELD_AT);
});

test("W1-T9212: the re-evaluation never arms and takes the one-plan-merge claim", async () => {
  const heldA = planPr(9421);
  const heldB = planPr(9422);
  const fresh = planPr(9423); // ready but never held: keeps W1-T5901's one-per-pass bound
  const ledger = ledgerWith([
    heldRow(heldA, { mergeable_state: "blocked", remedy: "retry-later" }),
    heldRow(heldB, { mergeable_state: "blocked", remedy: "retry-later" }),
  ]);
  const armed: number[] = [];
  const overlap = { now: 0, max: 0 };
  const pass = runSweepLightPass([fresh, heldA, heldB], sweepDeps(ledger, armed, new Map(), overlap), DEFAULT_SWEEP_POLICY);
  // an overlapping pass while the first holds the claim: its plan PR defers, as W1-T5901 requires
  for (let i = 0; i < 200 && armed.length === 0; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(armed.length > 0, "precondition: the re-evaluating pass is mid-claim");
  const other = planPr(9424);
  await runSweepLightPass([other], sweepDeps(ledger, armed, new Map()), DEFAULT_SWEEP_POLICY);
  assert.ok(!armed.includes(9424), "an overlapping pass never takes a claim the re-evaluating pass holds");
  await pass;

  assert.equal(overlap.max, 1, "re-evaluations take the claim one at a time, never two plan merges at once");
  assert.ok(armed.includes(9421) && armed.includes(9422), "both held PRs were re-evaluated");
  assert.ok(!armed.includes(9423), "a plan PR that was never held still waits for a later pass");
  const row = readLedgerLines(ledger).findLast((l) => l.step === "sweep.disposed" && l.pr_number === 9423);
  assert.match(String(row?.stand_down_reason), /one plan PR direct-merges per light pass/);
  assert.ok(!reevaluations(ledger).some((r) => r.pr_number === 9423), "a never-held PR writes no re-evaluation row");

  // The arm itself is unchanged: a held plan PR whose fresh read is mergeable merges directly, never armed.
  const calls: string[] = [];
  const seams = {
    headSha: () => "head9421",
    ledgerLines: () => [{
      ts: new Date(NOW - 60_000).toISOString(), step: "review.posted", task_id: "W1-T9421", state: "success", capped: false,
      head_sha: "head9421", pr_url: heldA.prUrl,
    }],
    armAuto: () => void calls.push("armAuto"),
    mergeDirect: () => void calls.push("mergeDirect"),
    disableAuto: () => {},
    isMerged: () => false,
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 0, mergeableState: "clean" }),
    updateBranch: () => ({ ok: true }),
    readPlanTouch: () => "touched" as const,
    stackPrerequisite: () => ({ state: "unstacked" as const, parentNumbers: [] }),
    closingReferences: () => ({ state: "clean" as const, defused: [] }),
    mergeQueue: () => false,
    sleep: () => {},
    say: () => {},
  };
  const result = await armAutoMergeDetailedAsync(heldA.prUrl, "W1-T9421", seams as unknown as ArmDeps<true>);
  assert.equal(result.outcome, "direct-merged");
  assert.deepEqual(calls, ["mergeDirect"], "the plan PR is merged directly and never armed");
});

test("W1-T9212: selectLightPassPlanMerge returns the longest-held plan PR, the head of the pass's order", () => {
  const never = planPr(9411);
  const held = planPr(9412);
  const ledgerLines = [heldRow(held, { mergeable_state: "blocked", remedy: "retry-later" })];
  const chosen = selectLightPassPlanMerge([never, held], DEFAULT_SWEEP_POLICY, NOW, ledgerLines);
  assert.equal(chosen?.prNumber, 9412, "a held plan PR outranks one never held, though its number is higher");
  assert.deepEqual(
    selectLightPassPlanMerges([never, held], DEFAULT_SWEEP_POLICY, NOW, ledgerLines).map((p) => p.prNumber),
    [9412],
    "the never-held PR keeps the one-per-pass bound",
  );
  assert.equal(selectLightPassPlanMerge([], DEFAULT_SWEEP_POLICY, NOW, []), undefined, "no plan PR, no choice");
});

test("W1-T9212: heldPlanPrFromLedger names the trigger and the first hold at this head", () => {
  const pr = planPr(9431);
  const rows = [
    { ...heldRow(pr, { mergeable_state: "blocked", remedy: "retry-later" }), ts: new Date(HELD_AT).toISOString() },
    { ...heldRow(pr, { mergeable_state: "unknown", remedy: "mergeability-unknown" }), ts: new Date(HELD_AT + 60_000).toISOString() },
    { ...heldRow({ ...pr, headSha: "elsewhere" }, { mergeable_state: "blocked", remedy: "retry-later" }), ts: new Date(NOW).toISOString() },
  ];
  const held = heldPlanPrFromLedger(rows, pr);
  assert.equal(held?.heldAtMs, HELD_AT, "the wait runs from the FIRST hold at this head");
  assert.equal(held?.trigger, "mergeability-settled", "the latest hold's reason names the trigger");
  assert.equal(heldPlanPrFromLedger(rows, { ...pr, headSha: "unheld" }), undefined, "another head is not held");
  assert.equal(heldPlanPrFromLedger([heldRow(pr, { mergeable_state: "dirty", remedy: "retry-later" })], pr), undefined,
    "a conflicting hold is not a checks-green or settled-unknown hold");
});


test("a genuine current-head review hold reaches the existing serial plan merge selection", () => {
  const held = { ...planPr(14828), headSha: "275ac3e9515e21507a2c69c066c101e1230c776f" };
  const row = {
    ts: "2026-10-27T13:33:03.932Z", step: "automerge.arm_skipped", lane: "review",
    outcome: "plan-pr-held", head_sha: held.headSha, pr_number: held.prNumber, pr_url: held.prUrl,
    plan_touch: "touched", mergeable_state: "blocked", remedy: "retry-later",
  };
  const at = Date.parse(row.ts);
  assert.deepEqual(heldPlanPrFromLedger([row], held), { heldAtMs: at, trigger: "checks-green" });
  const never = planPr(14824);
  assert.deepEqual(selectLightPassPlanMerges([never, held], DEFAULT_SWEEP_POLICY, at + 60_000, [row])
    .map(pr => pr.prNumber), [14828], "the actual review hold wins the existing claim; never-held work retains its limit");
  for (const bad of [
    { ...row, outcome: "skipped" }, { ...row, plan_touch: "unknown" },
    { ...row, head_sha: "older-head" }, { ...row, head_sha: undefined },
    { ...row, pr_number: 14829 }, { ...row, pr_url: "https://github.com/craigoley/remudero/pull/14829" },
    { ...row, ts: "unreadable" }, { ...row, mergeable_state: "dirty" },
  ]) assert.equal(heldPlanPrFromLedger([bad], held), undefined, "incomplete, conflicting or foreign evidence grants no held priority");
});
