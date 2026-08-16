import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  baseCausedCheckName,
  checksStateFromRollup,
  classifyRedCause,
  deriveDisposition,
  environmentFaultCheckName,
  isBlockedCi,
  runSweep,
  type CiFailure,
  type OpenPrView,
  type RollupCheckEntry,
} from "../src/lib/sweep.js";
import type { CriterionVerdict } from "../src/lib/review.js";

/**
 * PR #1441, 2026-08-07: dispositioned `blocked-fixable` with reason `required checks red —
 * ci-log fix, strike 1/2` while ALL 21 check runs were green — the sole red on the head was the
 * `remudero-review` COMMIT STATUS (a body-claim contradiction). The ci-log fix rung had no
 * failing job to read and burned a strike for nothing.
 *
 * ROOT CAUSE: `checksStateFromRollup` read `statusCheckRollup` — which mixes CHECK RUNS with
 * COMMIT STATUSES — and folded `remudero-review` (a commit status carrying the REVIEW verdict,
 * already tracked separately as `reviewState`) into `checksState` right alongside genuine CI
 * check runs. `isBlockedCi` is exactly `checksState === "red"`, so a review failure alone made it
 * true, claiming DISPOSITION_RULES' checks-red row (ordered first) before the review-shaped row
 * — `reviewState === "failure" && unmetCriteria.length > 0` — ever got a chance to match. That
 * row's own comment ("Reached only when checks are NOT red") named the case it could never reach.
 *
 * THE FIX (W1-T394): `checksStateFromRollup` now excludes the `remudero-review` context from the
 * gate unconditionally, so a red review can never manufacture `checksState: "red"`. These tests
 * drive the REAL rollup -> checksState -> disposition path (never a hand-set `checksState`) so a
 * regression in either function fails here.
 */

const NOW = Date.parse("2026-08-07T18:00:00Z");
const RECENT = "2026-08-07T17:55:00Z";
const REQUIRED = ["ci-gate", "commitlint", "remudero-review"];

function rollupCheck(over: Partial<RollupCheckEntry> = {}): RollupCheckEntry {
  return { name: "check", conclusion: "SUCCESS", ...over };
}

function criterion(over: Partial<CriterionVerdict> = {}): CriterionVerdict {
  return {
    claim: "PR body substantiates the acceptance criteria",
    proof: "unit test: it works",
    met: false,
    reason: "body-claim contradiction",
    proof_exec: "executed_fail",
    ...over,
  };
}

function basePr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1441,
    prUrl: "https://github.com/craigoley/remudero/pull/1441",
    taskId: "W1-TX",
    reviewState: "pending",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "cafef00d",
    autoMergeArmed: false,
    ...over,
  };
}

test("W1-T394 acceptance 1 (regression lock, the #1441 fixture) — all check runs green, remudero-review COMMIT STATUS red: checksState stays green, isBlockedCi is false, and the disposition reason never names ci-log", () => {
  // The #1441 shape: every real check run green, the sole red is the review commit status.
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
    rollupCheck({ name: "commitlint", conclusion: "SUCCESS" }),
    rollupCheck({ context: "remudero-review", state: "FAILURE" }),
  ];
  const checksState = checksStateFromRollup(rollup, REQUIRED);
  assert.equal(checksState, "green", "a red remudero-review commit status must never veto checksState");

  const pr = basePr({
    reviewState: "failure",
    checksState,
    unmetCriteria: [criterion({ claim: "48 files changed" })],
  });
  assert.equal(isBlockedCi(pr), false, "isBlockedCi must not go true off a review failure alone");

  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable");
  assert.match(r.reason, /1 unmet criteri/, "reaches the review-shaped row's own reason text");
  assert.doesNotMatch(r.reason, /ci-log fix/, "must never be routed to a rung with nothing to read");
  assert.doesNotMatch(r.reason, /required checks red/);
});

test("W1-T394 acceptance 2 — the review-shaped row IS reachable for a review failure (not just theoretically ordered second): unmet criteria alone reaches it, no checks-red row intercepts", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
    rollupCheck({ name: "commitlint", conclusion: "SUCCESS" }),
    rollupCheck({ context: "remudero-review", state: "FAILURE" }),
  ];
  const checksState = checksStateFromRollup(rollup, REQUIRED);
  const pr = basePr({
    reviewState: "failure",
    checksState,
    priorStrikes: 1,
    unmetCriteria: [criterion({ claim: "one" }), criterion({ claim: "two" })],
  });
  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable");
  assert.equal(r.reason, `2 unmet criteria — strike ${pr.priorStrikes + 1}/${DEFAULT_SWEEP_POLICY.strikeCap}`);
});

test("W1-T394 acceptance 3 (mirror fixture) — a genuinely red required CHECK RUN still routes to the ci-log rung, with remudero-review green/success beside it", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "FAILURE" }),
    rollupCheck({ name: "commitlint", conclusion: "SUCCESS" }),
    rollupCheck({ context: "remudero-review", state: "SUCCESS" }),
  ];
  const checksState = checksStateFromRollup(rollup, REQUIRED);
  assert.equal(checksState, "red", "a real check-run failure must still veto checksState");

  const pr = basePr({ reviewState: "success", checksState, priorStrikes: 0, unmetCriteria: [] });
  assert.equal(isBlockedCi(pr), true, "splitting the signal must not blind isBlockedCi to a real check failure");

  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable");
  assert.equal(r.reason, `required checks red — ci-log fix, strike ${pr.priorStrikes + 1}/${DEFAULT_SWEEP_POLICY.strikeCap}`);
});

test("W1-T394 acceptance 3 (both-red case) — a red required check run WITH a red remudero-review still routes to ci-log (checks-red keeps precedence), never re-litigated as reviewer-unmet", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "FAILURE" }),
    rollupCheck({ name: "commitlint", conclusion: "SUCCESS" }),
    rollupCheck({ context: "remudero-review", state: "FAILURE" }),
  ];
  const checksState = checksStateFromRollup(rollup, REQUIRED);
  assert.equal(checksState, "red");

  const pr = basePr({
    reviewState: "failure",
    checksState,
    priorStrikes: 0,
    unmetCriteria: [criterion({ claim: "some criterion" })],
  });
  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable");
  assert.match(r.reason, /required checks red — ci-log fix/, "checks-red wins — GitHub will not merge past it regardless of the review");
  assert.doesNotMatch(r.reason, /unmet criteri/);
});

test("W1-T394 — checksStateFromRollup excludes remudero-review even in the unreadable-protection (requiredContexts undefined) fallback", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" }),
    rollupCheck({ context: "remudero-review", state: "FAILURE" }),
  ];
  assert.equal(
    checksStateFromRollup(rollup, undefined),
    "green",
    "even the fail-closed fallback must not fold the review commit status into checksState",
  );
});

/**
 * W1-T527 — `isBlockedCi` is `pr.checksState === "red"` and asks nothing about WHY. Four causes
 * reached the identical dispatch; two of them (base-caused, environment) are unreachable by any
 * edit to the PR's own diff, so a strike spent on them is the budget that would have fixed a real
 * defect. These tests drive the REAL `runSweep` disposition path — never a hand-called classifier
 * alone for the routing claims — so a regression in either the fold or the wire-in fails here.
 */

const T527_NOW = Date.parse("2026-08-15T23:00:00Z");
const T527_RECENT = "2026-08-15T22:55:00Z";

function ciFailure(over: Partial<CiFailure> = {}): CiFailure {
  return { name: "ci-gate", logTail: "AssertionError: expected 1 to equal 2", ...over };
}

function redPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9001,
    prUrl: "https://github.com/craigoley/remudero/pull/9001",
    taskId: "W1-TZ",
    reviewState: "success",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: T527_RECENT,
    headSha: "deadbeef",
    autoMergeArmed: false,
    ciFailures: [ciFailure()],
    ...over,
  };
}

/** Drives the whole pass and records what the sweep actually DID, not what it derived. */
async function sweepOnce(prs: OpenPrView[]) {
  const appended: Array<Record<string, unknown>> = [];
  const dispatched: number[] = [];
  const summary = await runSweep(
    prs,
    {
      arm: () => {},
      close: () => {},
      dispatchFix: (pr) => {
        dispatched.push(pr.prNumber);
      },
      escalate: () => {},
      ledgerPath: "/dev/null/ledger.ndjson",
      runId: "t527-run",
      readLedger: () => [],
      appendLine: (_p, line) => {
        appended.push(line);
      },
      now: () => T527_NOW,
      log: () => {},
    },
    DEFAULT_SWEEP_POLICY,
  );
  const actedRows = appended.filter((l) => l.step === "sweep.disposed" && l.acted === true);
  return { summary, appended, dispatched, actedRows };
}

test("W1-T527: a check failing on every open pull request reads base-caused", () => {
  const a = redPr({ prNumber: 9001, ciFailures: [ciFailure({ name: "lint-plan" })] });
  const b = redPr({ prNumber: 9002, ciFailures: [ciFailure({ name: "lint-plan" })] });
  assert.equal(baseCausedCheckName(a, [a, b]), "lint-plan", "the shared name is the cross-PR fact");
  assert.equal(classifyRedCause(a, [a, b]), "base-caused");

  // FALSIFIER — one survivor is evidence AGAINST the base being the cause.
  const c = redPr({ prNumber: 9003, ciFailures: [ciFailure({ name: "commitlint" })] });
  assert.equal(classifyRedCause(a, [a, b, c]), "in-diff", "a PR not failing that check refutes it");

  // VACUITY GUARD — one PR cannot establish a cross-PR fact about itself.
  assert.equal(baseCausedCheckName(a, [a]), undefined, "a single PR must never exonerate itself");
  assert.equal(classifyRedCause(a, [a]), "in-diff");
});

test("W1-T527: a base-caused red pull request spends no strike", async () => {
  const a = redPr({ prNumber: 9001, ciFailures: [ciFailure({ name: "lint-plan" })] });
  const b = redPr({ prNumber: 9002, ciFailures: [ciFailure({ name: "lint-plan" })] });
  const stoodDown = await sweepOnce([a, b]);

  assert.deepEqual(stoodDown.dispatched, [], "no fix worker may be dispatched for a base-caused red");
  assert.equal(stoodDown.actedRows.length, 0, "no acted:true row — priorActionsFromLedger seeds strikes from those alone");
  const reasons = stoodDown.appended
    .filter((l) => l.step === "sweep.disposed")
    .map((l) => String(l.stand_down_reason ?? ""));
  assert.ok(
    reasons.every((r) => r.includes("base-caused")),
    `every disposed line must name the cause; got ${JSON.stringify(reasons)}`,
  );

  // THE FALSIFIER Q2 DEMANDS: an in-diff red DOES consume one, through the same path.
  const x = redPr({ prNumber: 9101, ciFailures: [ciFailure({ name: "ci" })] });
  const y = redPr({ prNumber: 9102, ciFailures: [ciFailure({ name: "commitlint" })] });
  const spent = await sweepOnce([x, y]);
  assert.deepEqual(spent.dispatched, [9101, 9102], "an in-diff red must still reach the fix rung");
  assert.equal(spent.actedRows.length, 2, "and must still write acted:true, which is what spends the strike");
});

test("W1-T527: an in-diff red pull request still dispatches the rung", async () => {
  const x = redPr({ prNumber: 9201, ciFailures: [ciFailure({ name: "ci" })] });
  const y = redPr({ prNumber: 9202, ciFailures: [ciFailure({ name: "depcruise" })] });
  assert.equal(classifyRedCause(x, [x, y]), "in-diff", "distinct failures are per-diff, not base-caused");

  const r = await sweepOnce([x, y]);
  assert.ok(r.dispatched.includes(9201), "the fix rung's own territory must be untouched by this task");
  const disposed = r.appended.filter((l) => l.step === "sweep.disposed" && l.pr_number === 9201);
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0].stand_down_reason, undefined, "an in-diff red must carry no stand-down reason");
  assert.equal(
    deriveDisposition(x, DEFAULT_SWEEP_POLICY, T527_NOW).disposition,
    "blocked-fixable",
    "the disposition itself is unchanged — this task classifies, it does not re-route",
  );
});

test("W1-T527: a gate conflict still escalates rather than standing down", async () => {
  // Standing rule 25 fails the remudero-review COMMIT STATUS, which checksStateFromRollup
  // excludes from checksState (W1-T394) — so a gate conflict is review-red, never checks-red.
  const gate = redPr({
    prNumber: 9301,
    checksState: "green",
    reviewState: "failure",
    ciFailures: undefined,
    unmetCriteria: [
      criterion({
        claim: "instrument and product paths are split",
        reason:
          "remudero-review: FAIL — entangled: instrument path(s) .github/workflows/ci.yml changed alongside src/ path(s) src/lib/sweep.ts in the same PR",
      }),
    ],
  });
  assert.equal(classifyRedCause(gate, [gate, redPr({ prNumber: 9302 })]), "gate-conflict");

  const r = await sweepOnce([gate, redPr({ prNumber: 9302, ciFailures: [ciFailure({ name: "ci" })] })]);
  const disposed = r.appended.filter((l) => l.step === "sweep.disposed" && l.pr_number === 9301);
  assert.equal(disposed.length, 1);
  assert.equal(
    disposed[0].stand_down_reason,
    undefined,
    "an unsatisfiable gate must NEVER be stood down — that would swallow the escalation",
  );
  assert.ok(r.dispatched.includes(9301), "it reaches the existing refuse/escalate path exactly as before");
});

test("W1-T527: an environment fault repeating one message stands down without a strike", async () => {
  const launchFailure = ciFailure({
    name: "ci",
    logTail: Array.from({ length: 12 }, () => "Error: browserType.launch: Executable doesn't exist").join("\n"),
  });
  const env = redPr({ prNumber: 9401, ciFailures: [launchFailure] });
  const other = redPr({ prNumber: 9402, ciFailures: [ciFailure({ name: "commitlint" })] });
  assert.equal(environmentFaultCheckName(env), "ci");
  assert.equal(classifyRedCause(env, [env, other]), "environment");

  const r = await sweepOnce([env, other]);
  assert.ok(!r.dispatched.includes(9401), "an environment fault is not a diff defect and must spend no worker");
  const disposed = r.appended.filter((l) => l.step === "sweep.disposed" && l.pr_number === 9401);
  assert.match(String(disposed[0].stand_down_reason), /environment/);

  // FALSIFIER — a genuinely varied log tail is NOT an environment fault.
  const varied = redPr({
    prNumber: 9403,
    ciFailures: [ciFailure({ name: "ci", logTail: "a failed\nb failed\nc failed\nd failed\ne failed" })],
  });
  assert.equal(environmentFaultCheckName(varied), undefined, "distinct failures must stay in-diff");
});
