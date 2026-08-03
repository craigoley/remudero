import assert from "node:assert/strict";
import { test } from "node:test";

import { armAutoMerge, armAndLogOutcome, armAutoMergeAtOpen } from "../src/run-task.js";
import type { ArmDeps } from "../src/run-task.js";

/**
 * test/capped-verdict-never-arms.test.ts — the CAPPED-arms-anyway gap.
 *
 * THE DEFECT. `decideArmFromLedgerVerdict` tested three things: a `review.posted` verdict
 * exists, its head sha matches, and `state === "success"`. A CAPPED verdict (zero proofs
 * executed) POSTS `success` — CAPPED IS NOT FAIL — so unproven work armed auto-merge on
 * every lane routed through that function: sweep, dep-review, retro, triage, plan, approve.
 * `decideAutoMergeArm` had refused exactly this since W1-T229, one call away, unconsulted.
 *
 * WHAT DRIVES WHAT. Every test below calls the REAL `armAutoMerge` / `armAndLogOutcome` /
 * `armAutoMergeAtOpen`, so `priorReviewVerdictFromLedger`, `decideArmFromLedgerVerdict` and
 * `decideAutoMergeArm` all run for real and are never injected. Only the side-effecting
 * leaves are recorders — `armAuto`/`mergeDirect` (which would shell out to `gh pr merge`),
 * `headSha` (a `gh pr view`) and `ledgerLines` (a disk read). The DECISION under test is
 * production code; the recorder exists so the assertion can be "was the arm attempted",
 * which is the only observable that matters.
 *
 * NOT PROVEN HERE, deliberately: `realArmDeps().armAuto` itself — the literal
 * `gh pr merge --auto --squash --delete-branch`. This change does not touch it.
 */

const HEAD = "abc1234def5678";
const PR = "https://github.com/craigoley/remudero/pull/999";
const TASK = "W1-T999";

/** A `review.posted` line as `reviewLedgerLegibilityFields` actually writes one. */
function reviewPosted(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { step: "review.posted", task_id: TASK, head_sha: HEAD, state: "success", capped: false, plan_only: false, ...over };
}

function recordingDeps(lines: Array<Record<string, unknown>>): ArmDeps & { armed: string[]; merged: string[] } {
  const armed: string[] = [];
  const merged: string[] = [];
  return {
    armed,
    merged,
    headSha: () => HEAD,
    ledgerLines: () => lines,
    armAuto: (prUrl) => void armed.push(prUrl),
    mergeDirect: (prUrl) => void merged.push(prUrl),
    disableAuto: () => {},
    say: () => {},
  };
}

// ── F1 — a CAPPED verdict must not arm ──────────────────────────────────────────────────

test("F1: a CAPPED verdict does NOT arm, even though it posted state: success", () => {
  const deps = recordingDeps([reviewPosted({ capped: true })]);
  const outcome = armAutoMerge(PR, TASK, deps);

  assert.equal(deps.armed.length, 0, "FALSIFIER: a capped verdict must never reach `gh pr merge --auto`");
  assert.equal(deps.merged.length, 0, "nor the clean-status direct-merge fallback, which completes the merge outright");
  assert.equal(outcome, "ledger-refused");
});

// ── F2 — THE REGRESSION LOCK. A fix that broke everything would still pass F1. ────────────

test("F2: a genuine PASS still arms exactly once — the regression lock", () => {
  const deps = recordingDeps([reviewPosted({ capped: false })]);
  const outcome = armAutoMerge(PR, TASK, deps);

  assert.deepEqual(deps.armed, [PR], "an uncapped success must still arm, with the PR url, exactly once");
  assert.equal(outcome, "armed");
});

// ── F3 — every lane, not just the one I tested ───────────────────────────────────────────

test("F3: the gate is shared by every lane — armAndLogOutcome's DEFAULT arm reaches it", () => {
  // `arm` is left DEFAULTED here (it defaults to `armAutoMerge`), which is the whole point:
  // dep-review, retro, triage, plan and approve all call `armAndLogOutcome` this way, and
  // sweep's `buildSweepEffects` passes `armAutoMerge` directly. Injecting `arm` would prove
  // only that this test can call a fake.
  const steps: string[] = [];
  const log = (step: string) => void steps.push(step);

  const capped = recordingDeps([reviewPosted({ capped: true })]);
  const cappedOutcome = armAndLogOutcome(PR, TASK, log, (u, t) => armAutoMerge(u, t, capped));
  assert.equal(capped.armed.length, 0, "a capped verdict is refused through the lane wrapper too");
  assert.equal(cappedOutcome, "ledger-refused");
  assert.ok(steps.includes("automerge.arm_skipped"), "the refusal is recorded as a skip, not as an arm");

  const clean = recordingDeps([reviewPosted({ capped: false })]);
  const cleanOutcome = armAndLogOutcome(PR, TASK, log, (u, t) => armAutoMerge(u, t, clean));
  assert.deepEqual(clean.armed, [PR], "and an uncapped success still arms through the same wrapper");
  assert.equal(cleanOutcome, "armed");
  assert.ok(steps.includes("automerge.armed"));
});

// ── F4 — the at-open arm is ungated BY DESIGN and must stay that way ─────────────────────

test("F4: armAutoMergeAtOpen still arms with a CAPPED verdict on the ledger — ungated by design", () => {
  // At PR-open time no verdict can exist, so this path never consults one. `runTask`'s own
  // capped-refusal branch withdraws it via `disarmAutoMerge`. If this test ever fails, the
  // change has leaked into a path it was never meant to touch.
  const deps = recordingDeps([reviewPosted({ capped: true })]);
  const outcome = armAutoMergeAtOpen(PR, deps);

  assert.deepEqual(deps.armed, [PR], "the at-open arm is deliberately independent of any verdict");
  assert.equal(outcome, "armed");
});

// ── F5 — the operator's absent-field ruling, pinned ──────────────────────────────────────

test("F5: a ledger line predating the capped field still ARMS — absent means NOT capped", () => {
  // Binding operator ruling: failing closed on lines older than W1-T185 would refuse to arm
  // across the entire pre-field history. An unreadable field fails OPEN.
  const line = reviewPosted();
  delete line.capped;
  delete line.plan_only;
  const deps = recordingDeps([line]);

  const outcome = armAutoMerge(PR, TASK, deps);
  assert.deepEqual(deps.armed, [PR], "a pre-field line must still arm");
  assert.equal(outcome, "armed");
});

test("F5b: a MALFORMED capped field is treated as absent, not as truthy", () => {
  // `capped: "yes"` is not a boolean. Coercing a non-boolean to `true` would fail closed on
  // corrupt data — the same halt the ruling exists to prevent.
  const deps = recordingDeps([reviewPosted({ capped: "yes" })]);
  armAutoMerge(PR, TASK, deps);
  assert.deepEqual(deps.armed, [PR], "a non-boolean capped field falls back to the fail-open default");
});
