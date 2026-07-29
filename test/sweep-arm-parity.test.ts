import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideSweepArm, runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import {
  decideAutoMergeArm,
  postedArmFactsFromLedger,
  reviewLedgerLegibilityFields,
} from "../src/lib/review.js";
import { readLedgerLines } from "../src/lib/status.js";

// ── THE DEFECT ──────────────────────────────────────────────────────────────
//
// run-task.ts's arming path refuses ANY capped verdict (W1-T229) unless it is
// the structurally-capped plan-only shape (W1-T205) or an operator ledgered an
// override (W1-T219). Its own comment named the hole it left behind: "sweep.ts's
// independent 'checks green + review success -> mergeable' reconciliation does
// not yet consult `capped`/an override — a PR this refuses stays OPEN and
// UNARMED, but a later sweep poll could still arm it via that separate path."
//
// LIVE INSTANCE, 2026-07-28: PR #800's verdict carried capped:true at
// proof_exec 0/5 (five exec_error proofs, zero executed). The sweep armed it at
// 17:48:57Z; GitHub merged it 35 seconds later at 17:49:32Z, unattended, with
// no acceptance proof ever executed.
//
// The fix is PARITY, not a blanket refusal: `decideSweepArm` delegates to the
// SAME `decideAutoMergeArm` predicate the run flow calls, so the plan-only
// carve-out travels with it and the plan lane never stalls.
// ────────────────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-07-28T18:00:00Z");
const RECENT = "2026-07-28T17:00:00Z";
const HEAD = "d00dfeed";
const OTHER_HEAD = "beefcafe";
const TASK = "W1-T800";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-arm-parity-")), "ledger.ndjson");
}

/** The exact shape row 8 (`mergeable`) matches: required checks green, review success. */
function greenPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 800,
    prUrl: "https://github.com/craigoley/remudero/pull/800",
    taskId: TASK,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: HEAD,
    autoMergeArmed: false,
    ...over,
  };
}

/** One `review.posted` ledger line, exactly as run-task.ts writes it. */
function postedLine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: "2026-07-28T17:48:00.000Z",
    run_id: "DAEMON-1",
    task_id: TASK,
    step: "review.posted",
    context: "remudero-review",
    state: "success",
    head_sha: HEAD,
    proof_exec: ["exec_error", "exec_error", "exec_error", "exec_error", "exec_error"],
    capped: true,
    keyword_only: false,
    plan_only: false,
    ...over,
  };
}

/** A recording fake for every injected sweep effect. */
function fakeDeps(lines: Array<Record<string, unknown>>, overrides: Partial<SweepDeps> = {}): SweepDeps & {
  armed: OpenPrView[];
} {
  const armed: OpenPrView[] = [];
  return {
    armed,
    arm: (p) => {
      armed.push(p);
    },
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: ledgerPath(),
    runId: "SWEEP-ARM-PARITY",
    now: () => NOW,
    readLedger: () => lines,
    ...overrides,
  };
}

// ── 1. the defect: a proof-failure CAPPED verdict is NOT armed ──────────────

test("the sweep refuses to arm a proof-failure CAPPED verdict — capped with plan_only false and zero executed proofs, the exact PR #800 shape", () => {
  const decision = decideSweepArm(greenPr(), [postedLine()]);
  assert.equal(decision.arm, false, "capped + not plan-only + no override must NOT arm — this is PR #800");
  assert.match(decision.reason, /CAPPED verdict \(zero proofs executed\)/);
});

test("runSweep never calls the arm effect for a proof-failure CAPPED PR, and the disposed ledger line names why it stood down", async () => {
  const deps = fakeDeps([postedLine()]);
  const summary = await runSweep([greenPr()], deps);
  assert.deepEqual(deps.armed, [], "deps.arm must never fire — GitHub must not be told to auto-merge this PR");
  assert.equal(summary.actionsTaken, 0);
  assert.equal(summary.byDisposition.mergeable, 1, "the DISPOSITION is untouched — only the ACTION stands down");
  assert.equal(summary.actions[0].acted, false);

  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed.length, 1, "the one-ledger-line-per-PR invariant still holds");
  assert.equal(disposed[0].acted, false);
  assert.match(String(disposed[0].stand_down_reason), /CAPPED verdict \(zero proofs executed\)/);
});

test("a stood-down capped PR is re-derived and armed on the very next pass once executed proof lands — the refusal is level-triggered, never a terminal strike", async () => {
  const lines: Array<Record<string, unknown>> = [postedLine()];
  const deps = fakeDeps(lines);
  await runSweep([greenPr()], deps);
  assert.equal(deps.armed.length, 0);
  // A re-review on the SAME head executes proof this time: capped goes false.
  lines.push(postedLine({ proof_exec: ["executed_pass"], capped: false }));
  await runSweep([greenPr()], deps);
  assert.deepEqual(
    deps.armed.map((p) => p.prNumber),
    [800],
    "nothing about the earlier refusal blocks the later arm — no strike was spent, no escalation raised",
  );
});

// ── 2. the W1-T205 regression lock: plan-only CAPPED still arms ─────────────

test("a plan-only CAPPED verdict STILL arms with no operator override — the W1-T205 ruling, and the reason the fix is parity and not a blanket refusal of everything capped", () => {
  const decision = decideSweepArm(greenPr(), [postedLine({ plan_only: true })]);
  assert.equal(decision.arm, true, "a plan PR has no executable proof by construction — refusing it stalls the whole plan lane");
  assert.match(decision.reason, /plan-only PR — structurally has no executable proof/);
  assert.doesNotMatch(decision.reason, /override/, "the carve-out must never be misattributed to an override");
});

test("runSweep arms a plan-only CAPPED PR end to end, so retro/triage/plan/approve filing PRs never stall behind the raised floor", async () => {
  const deps = fakeDeps([postedLine({ plan_only: true })]);
  const summary = await runSweep([greenPr()], deps);
  assert.deepEqual(deps.armed.map((p) => p.prNumber), [800]);
  assert.equal(summary.actionsTaken, 1);
  assert.equal(summary.actions[0].acted, true);
});

// ── 3. a clean uncapped green verdict is untouched ──────────────────────────

test("a clean uncapped green verdict arms exactly as it did before this change", () => {
  const decision = decideSweepArm(greenPr(), [postedLine({ capped: false, proof_exec: ["executed_pass", "executed_pass"] })]);
  assert.equal(decision.arm, true);
  assert.match(decision.reason, /verdict is a full PASS/);
});

test("runSweep still arms an uncapped green PR, and still dedups it against a prior arm", async () => {
  const lines = [postedLine({ capped: false, proof_exec: ["executed_pass"] })];
  const deps = fakeDeps(lines);
  await runSweep([greenPr()], deps);
  assert.deepEqual(deps.armed.map((p) => p.prNumber), [800]);
  // Already armed on GitHub ⇒ deduped before the arm decision is ever consulted.
  const again = await runSweep([greenPr({ autoMergeArmed: true })], deps);
  assert.equal(deps.armed.length, 1);
  assert.equal(again.actions[0].acted, false);
});

// ── 4. the operator override, head-bound, shared with the run flow ──────────

test("a head-bound operator override recovered from the ledger arms a capped verdict in the sweep too — an operator who unblocks a PR unblocks it for BOTH paths", () => {
  const grant = {
    task_id: TASK,
    step: "automerge.capped_override_granted",
    by: "craig",
    reason: "read the diff by hand",
    head_sha: HEAD,
  };
  const decision = decideSweepArm(greenPr(), [postedLine(), grant]);
  assert.equal(decision.arm, true);
  assert.match(decision.reason, /CAPPED override granted by craig/);
});

test("an override granted against a DIFFERENT head is never honoured by the sweep — the W1-T219 head binding is not re-implemented, it is inherited", () => {
  const staleGrant = {
    task_id: TASK,
    step: "automerge.capped_override_granted",
    by: "craig",
    reason: "granted against an older push",
    head_sha: OTHER_HEAD,
  };
  assert.equal(decideSweepArm(greenPr(), [postedLine(), staleGrant]).arm, false);
});

// ── 5. absent evidence arms, positively-matched evidence refuses ────────────

test("postedArmFactsFromLedger returns undefined — no evidence, so the sweep arms as before — when no verdict for this exact head and task is recoverable at all", () => {
  assert.equal(postedArmFactsFromLedger([postedLine()], TASK, OTHER_HEAD), undefined, "wrong head");
  assert.equal(postedArmFactsFromLedger([postedLine()], "W1-OTHER", HEAD), undefined, "wrong task");
  assert.equal(postedArmFactsFromLedger([postedLine()], undefined, HEAD), undefined, "no task id");
  assert.equal(postedArmFactsFromLedger([postedLine()], TASK, undefined), undefined, "no head sha");
  assert.equal(postedArmFactsFromLedger([postedLine({ step: "review.post_refused" })], TASK, HEAD), undefined, "not a review.posted line");
  assert.equal(postedArmFactsFromLedger([postedLine({ head_sha: 42 })], TASK, HEAD), undefined, "head_sha not a string");
  const noCapped = postedLine();
  delete noCapped.capped;
  assert.equal(postedArmFactsFromLedger([noCapped], TASK, HEAD), undefined, "capped absent is not capped:true");
});

// The two absences are NOT symmetric, and this is the fixture that says so: a
// recoverable capped verdict written before `plan_only` existed reads planOnly
// FALSE and therefore REFUSES, because an unattended merge with zero executed
// proof is irreversible while a stall costs one `rmd review <n>`.
test("a capped verdict from a ledger line written before plan_only existed still refuses to arm — absence of the carve-out field is not the carve-out", () => {
  const legacy = postedLine();
  delete legacy.plan_only;
  assert.deepEqual(postedArmFactsFromLedger([legacy], TASK, HEAD), { capped: true, planOnly: false });
  const decision = decideSweepArm(greenPr(), [legacy]);
  assert.equal(decision.arm, false, "this is PR #800's own ledger line shape, replayed");
  assert.match(decision.reason, /CAPPED verdict \(zero proofs executed\)/);
});

test("an UNCAPPED verdict from that same pre-plan_only era arms untouched — the transitional rule only ever binds on a positively capped line", () => {
  const legacy = postedLine({ capped: false, proof_exec: ["executed_pass"] });
  delete legacy.plan_only;
  assert.equal(decideSweepArm(greenPr(), [legacy]).arm, true);
});

test("postedArmFactsFromLedger takes the LAST matching line for the head — a re-review supersedes the verdict before it", () => {
  const lines = [postedLine(), postedLine({ capped: false, proof_exec: ["executed_pass"] })];
  assert.deepEqual(postedArmFactsFromLedger(lines, TASK, HEAD), { capped: false, planOnly: false });
});

test("a head with no recoverable ledgered verdict arms exactly as it did before — refusal requires positively observing capped true and plan_only false", async () => {
  const deps = fakeDeps([]);
  const decision = decideSweepArm(greenPr(), []);
  assert.equal(decision.arm, true);
  assert.match(decision.reason, /no ledgered verdict recoverable for this head/);
  await runSweep([greenPr()], deps);
  assert.deepEqual(deps.armed.map((p) => p.prNumber), [800], "a rotated ledger must never strand a green PR");
});

// ── 6. parity is delegation, not duplication ───────────────────────────────

test("decideSweepArm returns byte-identical decisions to the run flow's own decideAutoMergeArm across every capped/plan-only combination — one predicate, two call sites", () => {
  for (const capped of [true, false]) {
    for (const planOnly of [true, false]) {
      const mine = decideSweepArm(greenPr(), [postedLine({ capped, plan_only: planOnly })]);
      const runFlow = decideAutoMergeArm({ state: "success", capped, planOnly }, false, undefined);
      assert.deepEqual(mine, runFlow, `capped=${capped} planOnly=${planOnly} must decide identically in both paths`);
    }
  }
});

test("the review.posted ledger projection carries plan_only, so the sweep can tell a structural plan-only cap from a proof-failure cap at all", () => {
  assert.deepEqual(reviewLedgerLegibilityFields({ capped: true, keywordOnly: false, planOnly: true }), {
    capped: true,
    keyword_only: false,
    plan_only: true,
  });
});
