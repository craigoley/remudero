import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideSweepArm, runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import { decideAutoMergeArm } from "../src/lib/review.js";
import { readLedgerLines } from "../src/lib/status.js";

// ── THE DEFECT (W1-T1028) ────────────────────────────────────────────────────
//
// The operator has ruled that a green, reviewed, hand-filed PR should not need
// their merge. `sweep.armSessionPrs` (W1-T516) already resolves the run flow's
// OWN arm attempt to the `PR-<n>` synthetic id a hand-filed PR's review is
// ledgered under — but `decideSweepArm`'s OWN evidence recovery, upstream of
// that handoff, never made the same substitution: it looked up
// `postedArmFactsFromLedger(lines, pr.taskId, pr.headSha)` with `pr.taskId`
// RAW, and a hand-filed PR's `pr.taskId` is undefined by construction (no
// `Remudero-Task:` trailer). `postedArmFactsFromLedger` bails on its own
// `!taskId` guard the instant that happens, so this gate took the fail-open
// branch for EVERY hand-filed PR, whether or not real evidence existed — it
// said "arm" without ever looking, and any refusal for a bad hand-filed PR
// (capped, irreversible) depended entirely on the run flow's own, independent
// re-check downstream to catch what this gate waved through unexamined. That
// is the disagreement traced end to end in this task's own rationale (3): "the
// sweep decides to arm and the handoff refuses for evidence it never needed."
//
// The fix recovers evidence under the SAME `pr.taskId ?? PR-<n>` synthetic id
// the review lane already ledgers `review.posted` under for a task-less PR —
// so a hand-filed PR that WAS reviewed is judged on the real, head-bound
// verdict (arms on a genuine pass, refuses on a genuine capped/irreversible
// one) instead of a blind pass-through, and one that was never reviewed still
// takes the pre-existing fail-open branch, unchanged.
// ────────────────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-08-19T18:00:00Z");
const RECENT = "2026-08-19T17:00:00Z";
const HEAD = "cafef00d";
const OTHER_HEAD = "d15ea5e5";
const PR_NUMBER = 977;
const SYNTHETIC_ID = `PR-${PR_NUMBER}`;

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-handfiled-arm-")), "ledger.ndjson");
}

/** A green, reviewed, HAND-FILED PR: no `Remudero-Task:` trailer, no run branch, no taskId. */
function handFiledPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR_NUMBER,
    prUrl: `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`,
    // taskId intentionally absent — this is the population the operator's ruling targets.
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

/** One `review.posted` ledger line, keyed exactly as the review lane ledgers a task-less PR's
 *  verdict (`taskId ?? PR-<n>`, run-task.ts's `reviewCommand`). */
function postedLine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: "2026-08-19T17:48:00.000Z",
    run_id: "review-PR977-1",
    task_id: SYNTHETIC_ID,
    step: "review.posted",
    context: "remudero-review",
    state: "success",
    head_sha: HEAD,
    proof_exec: ["executed_pass", "executed_pass"],
    capped: false,
    keyword_only: false,
    plan_only: false,
    ...over,
  };
}

/** A recording fake for every injected sweep effect — mirrors sweep-arm-parity.test.ts's own. */
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
    runId: "SWEEP-HANDFILED-ARM",
    now: () => NOW,
    readLedger: () => lines,
    ...overrides,
  };
}

// ── 1. a green reviewed PR with no run branch reaches the arm ───────────────

test("W1-T1028: a green reviewed pr with no run branch reaches the arm", async () => {
  const deps = fakeDeps([postedLine()]);
  const summary = await runSweep([handFiledPr()], deps);
  assert.deepEqual(
    deps.armed.map((p) => p.prNumber),
    [PR_NUMBER],
    "a hand-filed PR with a real, matching, green review verdict must reach deps.arm — the absent " +
      "taskId must never by itself stand it down before the arm decision is even attempted",
  );
  assert.equal(summary.actionsTaken, 1);
  assert.equal(summary.actions[0].acted, true);
});

// ── 2. the sweep's arm carries the head-bound decision it already made ──────

test("W1-T1028: the sweep arm carries its own head bound decision", () => {
  const decision = decideSweepArm(handFiledPr(), [postedLine()]);
  // Byte-identical to the run flow's own core predicate over the SAME recovered facts — proving
  // this is the real, head-bound verdict (not the generic "no evidence" fallback a taskId-blind
  // lookup would have produced for every hand-filed PR before this fix).
  const runFlow = decideAutoMergeArm({ state: "success", capped: false, planOnly: false }, false, undefined, undefined);
  assert.deepEqual(decision, runFlow);
  assert.match(decision.reason, /verdict is a full PASS/);
  assert.doesNotMatch(
    decision.reason,
    /no evidence to refuse on/,
    "evidence WAS recoverable under the PR-<n> synthetic id — this must not fall back to the blind pass",
  );

  // Head-bound, not merely task-bound: a verdict posted for a DIFFERENT head of this same
  // synthetic id must never be carried forward as if it covered the current one.
  const stalePush = decideSweepArm(handFiledPr(), [postedLine({ head_sha: OTHER_HEAD })]);
  assert.equal(stalePush.arm, true, "no verdict for THIS head is recoverable — falls back to fail-open, not a stale carry");
  assert.match(stalePush.reason, /no ledgered verdict recoverable for this head/);
});

// ── 3. a capped verdict with no ledgered override still refuses ─────────────

test("W1-T1028: a capped verdict still refuses on the widened path", async () => {
  const decision = decideSweepArm(handFiledPr(), [postedLine({ capped: true, proof_exec: ["exec_error", "exec_error"] })]);
  assert.equal(decision.arm, false, "capped + no override must not arm just because the PR is hand-filed");
  assert.match(decision.reason, /CAPPED verdict \(zero proofs executed\)/);

  const deps = fakeDeps([postedLine({ capped: true, proof_exec: ["exec_error", "exec_error"] })]);
  const summary = await runSweep([handFiledPr()], deps);
  assert.deepEqual(deps.armed, [], "deps.arm must never fire for a capped hand-filed verdict with no override");
  assert.equal(summary.actions[0].acted, false);
  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.match(String(disposed[0].stand_down_reason), /CAPPED verdict \(zero proofs executed\)/);
});

// ── 4. an irreversible diff still refuses, even on an otherwise-clean pass ──

test("W1-T1028: an irreversible diff still refuses on the widened path", () => {
  // Otherwise a clean, uncapped PASS — the only refusing fact is the trailing `irreversible`
  // parameter, the SAME appended-last idiom `decideAutoMergeArm` itself already uses so no
  // positional caller shifts (a hand-filed PR with no worktree-derived classification simply
  // omits it, unchanged from before this task).
  const decision = decideSweepArm(handFiledPr(), [postedLine()], true);
  assert.equal(decision.arm, false, "an irreversible diff must refuse regardless of an otherwise-passing verdict");
  assert.match(decision.reason, /diff classified IRREVERSIBLE/);

  // Checked FIRST — before capped/override are even consulted (mirrors decideAutoMergeArm's
  // own ordering, W1-T919: no override buys back an irreversible refusal).
  const stillRefuses = decideSweepArm(handFiledPr(), [postedLine({ capped: true })], true);
  assert.equal(stillRefuses.arm, false);
  assert.match(stillRefuses.reason, /diff classified IRREVERSIBLE/);

  // Omitted (the default, and the only shape any current caller passes) — behaviour is
  // byte-for-byte unchanged from before this parameter existed.
  const omitted = decideSweepArm(handFiledPr(), [postedLine()]);
  assert.equal(omitted.arm, true);
});
