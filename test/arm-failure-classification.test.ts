import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armAutoMerge, armFailureAction, sweepArmAttemptOutcome, type ArmDeps } from "../src/run-task.js";
import { runSweep, DEFAULT_SWEEP_POLICY, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";

// W1-T1117 — `armFailureAction`'s `transient` arm was an allowlist of TRANSPORT/SERVER faults
// only, so a merge race whose own GitHub message says "try the merge again" fell through to the
// `permanent` default — and because a failed arm attempt still seeded nothing to distinguish that
// default from a real failure, the sweep's head-keyed dedup had no way to ever stop retrying (or,
// symmetrically, no way to know a race SHOULD keep retrying) once the classification existed.
//
// This file locks the pure classifier's four-way split (direct-merge / transient / retryable /
// unknown) AND the "mergeable" arm's dedup behavior (lib/sweep.ts) that now actually consults it:
// a retryable (or transient) failure leaves the head free for the next pass, while an unknown one
// does not — exactly the shape design note (ii)/(iv) in this task's plan record describe.

// ── acceptance 1/2/5 — the pure classifier ───────────────────────────────────────────────

test("armFailureAction: a base-branch race classifies retryable, never permanent/unknown — GitHub's own message names the remedy", () => {
  const raceStderr = "GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)";
  assert.equal(armFailureAction(raceStderr), "retryable");
  assert.notEqual(armFailureAction(raceStderr), "unknown");
});

test("armFailureAction: a transport/server failure keeps its existing transient classification", () => {
  assert.equal(armFailureAction("connect ETIMEDOUT api.github.com"), "transient");
  assert.equal(armFailureAction("secondary rate limit exceeded"), "transient");
  assert.equal(armFailureAction("GraphQL: Something went wrong (mergePullRequest)"), "transient");
});

test("armFailureAction: an unrecognised failure reads unknown, not permanent — the classifier cannot decode gh's collapsed prose", () => {
  const undecodable = "GraphQL: Pull Request is not mergeable (mergePullRequest)";
  assert.equal(armFailureAction(undecodable), "unknown");
  assert.notEqual(armFailureAction(undecodable), "transient");
  assert.notEqual(armFailureAction(undecodable), "retryable");
});

test("armFailureAction: the clean-status completion still routes to a direct merge", () => {
  assert.equal(
    armFailureAction("X Pull request #591 is in clean status; auto-merge cannot be enabled"),
    "direct-merge",
  );
});

test("armAutoMerge: a clean-status refusal still completes as a direct merge end to end, unaffected by the retryable/unknown split", () => {
  const merged: string[] = [];
  const said: string[] = [];
  const deps: ArmDeps = {
    headSha: () => "aaaa111",
    ledgerLines: () => [
      { step: "review.posted", task_id: "W1-A", state: "success", head_sha: "aaaa111", proof_exec: ["executed_pass"] },
    ],
    armAuto: () => {
      const e = new Error("gh failed") as Error & { stderr: string };
      e.stderr = "X Pull request #591 is in clean status; auto-merge cannot be enabled";
      throw e;
    },
    mergeDirect: (u) => {
      merged.push(u);
    },
    disableAuto: () => {},
    say: (m) => {
      said.push(m);
    },
  };
  assert.equal(armAutoMerge("url/591", "W1-A", deps), "direct-merged");
  assert.deepEqual(merged, ["url/591"]);
});

// ── acceptance 3/4 — the sweep's "mergeable" arm dedup actually consults the classification ──

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-arm-failure-classification-")), "ledger.ndjson");
}

const NOW = Date.parse("2026-07-17T12:00:00Z");

function mergeablePr(): OpenPrView {
  return {
    prNumber: 10,
    prUrl: "url/10",
    taskId: "W1-A",
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-07-16T12:00:00Z",
    headSha: "aaaa111",
    autoMergeArmed: false,
  };
}

/** Two consecutive sweep passes against the SAME ledger, `deps.arm` always returning the same
 *  classified `arm-error-ignored` outcome — exactly the shape production wiring (run-task.ts's
 *  `buildSweepEffects`) now attaches via `armFailureAction`. */
async function runTwoPasses(failureClass: "transient" | "retryable" | "unknown") {
  const shared = ledgerPath();
  let armCalls = 0;
  const deps: SweepDeps = {
    arm: () => {
      armCalls += 1;
      return { outcome: "arm-error-ignored", failureClass };
    },
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: shared,
    runId: "SWEEP-1",
    now: () => NOW,
  };
  const first = await runSweep([mergeablePr()], deps, DEFAULT_SWEEP_POLICY);
  const second = await runSweep([mergeablePr()], deps, DEFAULT_SWEEP_POLICY);
  const disposed = readLedgerLines(shared).filter((l) => l.step === "sweep.disposed");
  return { first, second, disposed, armCalls };
}

test("W1-T1117: a retryable arm failure leaves the head free for the next pass to re-attempt", async () => {
  const { first, second, disposed, armCalls } = await runTwoPasses("retryable");
  assert.equal(first.actions[0].acted, false, "the first pass never seeds the dedup for a retryable failure");
  assert.equal(second.actions[0].acted, false, "the second pass still does not dedup a retryable failure");
  assert.equal(armCalls, 2, "the head was never marked done, so the SECOND pass re-attempts the arm — never deduped");
  assert.equal(disposed.length, 2);
  assert.ok(
    disposed.every((l) => l.arm_outcome === "arm-error-ignored"),
    "both passes actually attempted the arm (the outcome rides the row) rather than standing down before reaching it",
  );
});

test("W1-T1117: a transient arm failure keeps the existing (already-correct) re-attempt behavior", async () => {
  const { first, second, armCalls } = await runTwoPasses("transient");
  assert.equal(first.actions[0].acted, false);
  assert.equal(second.actions[0].acted, false);
  assert.equal(armCalls, 2, "a transient failure is retried next pass exactly as it always has been");
});

test("W1-T1117: an unrecognised (unknown) arm failure seeds the dedup and does NOT retry the next pass", async () => {
  const { first, second, disposed, armCalls } = await runTwoPasses("unknown");
  assert.equal(first.actions[0].acted, true, "an unknown failure is treated as terminal — it seeds prior.armed exactly like a genuine arm");
  assert.equal(second.actions[0].acted, false, "the second pass is a NO-ACTION dedup hold, not a fresh attempt");
  assert.equal(armCalls, 1, "the second pass never calls deps.arm again — the head is deduped, not re-attempted");
  assert.match(
    String(disposed[1].stand_down_reason),
    /already armed by a prior sweep pass/,
    "the second pass names the SAME prior-pass dedup every other terminal mergeable outcome already uses",
  );
});

test("W1-T1117: a bare ArmOutcomeName string (no failureClass) keeps its pre-existing behavior — every fake predating this task still compiles and still retries", async () => {
  const shared = ledgerPath();
  const deps: SweepDeps = {
    arm: () => "arm-error-ignored",
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: shared,
    runId: "SWEEP-1",
    now: () => NOW,
  };
  const first = await runSweep([mergeablePr()], deps, DEFAULT_SWEEP_POLICY);
  const second = await runSweep([mergeablePr()], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(first.actions[0].acted, false);
  assert.equal(second.actions[0].acted, false, "an old fake with no failureClass never seeds the dedup — unchanged from before this task");
});

// ── The fold between the classifier and the sweep row, as a unit ─────────────────────────────
//
// `buildSweepEffects`' `arm` effect used to make this decision inline, where the only way to
// reach an arm was to drive a whole sweep pass — so its narrowing guard was reachable by no
// test and `diff-coverage` blocked on that exact line. `sweepArmAttemptOutcome` is that
// decision extracted; these three tests are its three arms, one each.

test("sweepArmAttemptOutcome: an outcome that is not arm-error-ignored passes through unchanged", () => {
  assert.equal(sweepArmAttemptOutcome("armed", undefined), "armed");
  assert.equal(sweepArmAttemptOutcome("armed", "Base branch was modified."), "armed");
  assert.equal(sweepArmAttemptOutcome("direct-merged", "anything at all"), "direct-merged");
  // A bare arm-error-ignored with NO captured text is the pre-W1-T1117 shape every existing fake
  // still returns, and it must stay a bare string rather than gaining a fabricated class.
  assert.equal(sweepArmAttemptOutcome("arm-error-ignored", undefined), "arm-error-ignored");
});

test("sweepArmAttemptOutcome: a classified failure carries its class alongside the outcome", () => {
  assert.deepEqual(sweepArmAttemptOutcome("arm-error-ignored", "Base branch was modified. Review and try the merge again."), {
    outcome: "arm-error-ignored",
    failureClass: "retryable",
  });
  assert.deepEqual(sweepArmAttemptOutcome("arm-error-ignored", "ETIMEDOUT talking to github.com"), {
    outcome: "arm-error-ignored",
    failureClass: "transient",
  });
  assert.deepEqual(sweepArmAttemptOutcome("arm-error-ignored", "something gh could not explain"), {
    outcome: "arm-error-ignored",
    failureClass: "unknown",
  });
  // PAIRED POSITIVE CONTROL: each class above is the one `armFailureAction` itself returns for
  // that text, so the fold reads the classifier back rather than re-deriving a second opinion.
  for (const text of [
    "Base branch was modified. Review and try the merge again.",
    "ETIMEDOUT talking to github.com",
    "something gh could not explain",
  ]) {
    const folded = sweepArmAttemptOutcome("arm-error-ignored", text);
    assert.equal(typeof folded === "object" ? folded.failureClass : undefined, armFailureAction(text));
  }
});

test("sweepArmAttemptOutcome: a direct-merge classification returns the bare outcome and never a failure class", () => {
  // `attemptArm` cannot produce this pairing — a clean-status failure takes the direct-merge
  // fallback instead of returning arm-error-ignored — so this guard exists to keep the return
  // type exact rather than widening `ArmAttemptOutcome.failureClass` to a class the outcome can
  // never carry. It is tested directly because a guard nothing exercises is a guard nobody can
  // trust, and because leaving it unexercised is what blocked this PR.
  const cleanStatus = "Pull request is in clean status";
  assert.equal(armFailureAction(cleanStatus), "direct-merge", "positive control: this text IS the direct-merge class");
  const folded = sweepArmAttemptOutcome("arm-error-ignored", cleanStatus);
  assert.equal(folded, "arm-error-ignored", "the bare outcome, never an object carrying direct-merge");
  assert.equal(typeof folded, "string");
});
