import assert from "node:assert/strict";
import { test } from "node:test";
import { armIfVerdictPermits } from "../src/run-task.js";

// ── THE DEFECT ───────────────────────────────────────────────────────────────────────
// `armAutoMerge` returns "no-task-id" on its FIRST branch when a PR has no
// `Remudero-Task:` trailer, and arms nothing. Every automated lane either writes a trailer
// (worker, triage, plan, retro) or mints a synthetic id so it arms anyway (`rmd approve`
// uses a `PR-<n>` form). The OPERATOR-LANE agent PR is the only class with neither, and
// five PRs in one day needed a hand merge for that reason alone: #958, #961, #964, #968,
// #970.
//
// The inversion that makes it stark: #970 had 22 checks green and
// "PASS — 5 criteria substantiated, no test theater" and never armed, while #969 auto-merged
// two seconds after posting "CAPPED — 0/4 proofs executed; not certified".
//
// This is the exact mirror of #973's `withdrawArmIfVerdictRefuses` — same call site, same
// `decideAutoMergeArm` predicate, complementary condition. The SAFETY LOCK is that the
// shared predicate returns arm:false for a proof-failure cap, so widening WHO may arm does
// not widen WHAT may arm.

type Verdict = Parameters<typeof armIfVerdictPermits>[0];

const PASS: Verdict = { state: "success", capped: false, planOnly: false };
const CAPPED_PROOF_FAILURE: Verdict = { state: "success", capped: true, planOnly: false };
const CAPPED_PLAN_ONLY: Verdict = { state: "success", capped: true, planOnly: true };

/** Records every arm the code issues so a test asserts the CALL, not that the code ran. */
function harness(over: Record<string, unknown> = {}) {
  const arms: Array<{ prUrl: string; taskId: string }> = [];
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return {
    arms,
    logged,
    ctx: {
      prUrl: "https://github.com/craigoley/remudero/pull/970",
      taskId: "PR-970",
      headSha: "a9e8163cafe",
      ledgerPath: "/dev/null",
      log: (step: string, extra?: Record<string, unknown>) => void logged.push({ step, extra }),
      ...over,
    },
    deps: {
      ledgerLines: () => [] as Array<Record<string, unknown>>,
      arm: (prUrl: string, taskId: string) => {
        arms.push({ prUrl, taskId });
        return "armed" as const;
      },
    },
  };
}

// ── 3: an UNTRAILERED PR with a PASSING verdict IS armed ────────────────────────────
test("an untrailered PR with a PASSING verdict IS armed — the #970 shape that needed a hand merge", () => {
  const h = harness();

  const outcome = armIfVerdictPermits(PASS, h.ctx, h.deps);

  assert.equal(outcome, "armed", "the arm was attempted and reported its outcome");
  assert.deepEqual(
    h.arms,
    [{ prUrl: "https://github.com/craigoley/remudero/pull/970", taskId: "PR-970" }],
    "the arm was ISSUED with the synthetic PR-<n> id the review lane already assigns — asserting the call",
  );
  const line = h.logged.find((l) => l.step === "automerge.armed");
  assert.ok(line, "and it is ledgered under automerge.armed so an operator can attribute it");
  assert.equal(line?.extra?.task_id, "PR-970", "the ledger line names the id it armed against");
  assert.equal(line?.extra?.outcome, "armed", "and the real outcome, not an assumption of success");
});

// ── 4: THE SAFETY LOCK — a proof-failure cap is still NOT armed ─────────────────────
test("SAFETY LOCK: an untrailered PR with a PROOF-FAILURE CAPPED verdict is NOT armed", () => {
  const h = harness();

  const outcome = armIfVerdictPermits(CAPPED_PROOF_FAILURE, h.ctx, h.deps);

  assert.equal(outcome, "skipped", "a capped verdict does not arm");
  assert.deepEqual(
    h.arms,
    [],
    "NO arm was issued — widening WHO may arm must not widen WHAT may arm; this is what makes the change safe",
  );
  assert.equal(h.logged.filter((l) => l.step === "automerge.armed").length, 0, "and nothing is ledgered as armed");
});

// ── 5: the W1-T205 carve-out — plan-only capped PRs DO arm ─────────────────────────
test("CARVE-OUT: an untrailered PLAN-ONLY capped PR IS armed, with no operator override needed", () => {
  const h = harness();

  // No override is supplied anywhere: `ledgerLines` returns [], so cappedOverrideFromLedger
  // finds nothing. The arm must come from the W1-T205 carve-out alone.
  const outcome = armIfVerdictPermits(CAPPED_PLAN_ONLY, h.ctx, h.deps);

  assert.equal(outcome, "armed", "a plan-only cap is structural, not a proof failure — it arms");
  assert.equal(h.arms.length, 1, "the arm was issued");
  const line = h.logged.find((l) => l.step === "automerge.armed");
  assert.match(String(line?.extra?.reason), /plan-only/, "and the ledger names the carve-out as the reason");
});

// ── 6: REGRESSION LOCK — a trailered worker PR is unchanged ────────────────────────
test("REGRESSION LOCK: a TRAILERED worker PR arms exactly as before — this widened arming, not replaced it", () => {
  const h = harness({ taskId: "W1-T195" });

  const outcome = armIfVerdictPermits(PASS, h.ctx, h.deps);

  assert.equal(outcome, "armed");
  assert.deepEqual(
    h.arms.map((a) => a.taskId),
    ["W1-T195"],
    "a real task id is passed through untouched — the same id armAutoMerge has always received",
  );
});

// ── 7: TRAP 1 — dependabot stays excluded ──────────────────────────────────────────
test("TRAP 1: a dependabot PR is NOT armed here — the dep-review lane owns arming for those", () => {
  const h = harness({ headRefName: "dependabot/npm_and_yarn/typescript-5.9.3" });

  const outcome = armIfVerdictPermits(PASS, h.ctx, h.deps);

  assert.equal(outcome, "skipped", "excluded before the decision is even consulted");
  assert.deepEqual(h.arms, [], "no arm issued — two lanes arming one PR on different rules is worse than the gap");
  const line = h.logged.find((l) => l.step === "automerge.arm_skipped");
  assert.match(String(line?.extra?.reason), /dep-review lane/, "and the skip is ledgered with its reason");
});

// ── 8: TRAP 3 — repeated review does not thrash ────────────────────────────────────
test("TRAP 3: a second review of the same PR re-arms idempotently — one ledger line per review, no error", () => {
  const h = harness();

  const first = armIfVerdictPermits(PASS, h.ctx, h.deps);
  const second = armIfVerdictPermits(PASS, h.ctx, h.deps);

  assert.equal(first, "armed");
  assert.equal(second, "armed", "an already-armed PR re-arms cleanly — `gh pr merge --auto` is idempotent");
  assert.equal(h.arms.length, 2, "each review issues its own arm");
  assert.equal(
    h.logged.filter((l) => l.step === "automerge.armed").length,
    2,
    "one ledger line PER REVIEW, not per poll — this site is runReview, not the 60s sweep loop, so a " +
      "re-review is the only thing that repeats it",
  );
});

// ── ORDERING: the arm runs AFTER the post, unlike the withdrawal ───────────────────
//
// W1-T2232 MOVED THIS FROM SOURCE TEXT TO BEHAVIOUR. impl-BL's correction (recorded until now
// in this test's own history) already taught the lesson: a source-text lock on where a call
// SITS can be true of the code and still let the underlying defect through, and a weaker anchor
// (four-space indentation) breaks on "site not found" the moment a call is reindented — neither
// failure mode says anything about the ORDER the fix actually depends on. `runReview`'s own args
// expose an injectable observer for both effects this test protected (`disarm`, `arm`, plus the
// real ledger file `ledgerPath` points at), so "withdraw precedes the post" and "the arm follows
// the review.posted ledger write" are now proven by driving `runReview` end-to-end and observing
// the injected `disarm`/`arm` calls and the real `gh` argv/ledger file — see
// test/wiring-ordering-behaviour.test.ts.
