import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEFAULT_SWEEP_POLICY,
  checksStateFromRollup,
  deriveDisposition,
  isBlockedCi,
  isCappedReviewOrphanEscalation,
  redQualityGateNames,
  type OpenPrView,
  type RollupCheckEntry,
} from "../src/lib/sweep.js";

/**
 * W1-T2504 — `checksStateFromRollup` answers "what gates the merge" (branch protection's own
 * set, which on this repo names only `ci-gate` + `remudero-review` — the latter excluded
 * unconditionally). `isBlockedCi` was `checksState === "red"` alone, so the fix rung's own
 * trigger could only ever learn a required check was red SECOND-HAND, from `ci-gate` — the
 * aggregate that WAITS for every one of its 14 sibling checks before it reports anything —
 * finishing. MEASURED on #3318: the run lane's own CI wait named `coverage-ratchet` red at the
 * moment it concluded; the sweep's `checksState` stayed "pending" (ci-gate still running) for a
 * further 24 minutes, and nothing drove the already-failing PR in that whole window.
 *
 * THE FIX: `redQualityGateNames` reads ci-gate's OWN required list (never branch protection's
 * narrower one) directly off the rollup, independently of ci-gate's own still-running verdict.
 * `OpenPrView.redRequiredChecks` carries its output; `isBlockedCi` is widened to ALSO fire off a
 * non-empty `redRequiredChecks`, alongside its untouched `checksState === "red"` read.
 * `checksState`/`checksStateFromRollup` themselves are BYTE UNCHANGED — this is a SEPARATE
 * observable, the same route `CancelledRequiredCheck` (W1-T1223) already took, never a fifth
 * member of the `checksState` union.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SWEEP_SOURCE = readFileSync(join(__dirname, "..", "src", "lib", "sweep.ts"), "utf8");

const NOW = Date.parse("2026-08-30T14:00:00Z");
const RECENT = "2026-08-30T13:58:00Z";

// The real ci-gate.yml REQUIRED list (.github/workflows/ci-gate.yml, 14 entries) — what
// `redQualityGateNames` is meant to be threaded, never branch protection's own narrower set.
const CI_GATE_REQUIRED = [
  "ci",
  "lint-plan",
  "depcruise",
  "containment-probe",
  "coverage-ratchet",
  "mutation-ratchet",
  "jscpd-gate",
  "claims",
  "learnings-budget-ratchet",
  "commitlint",
  "api-client-drift",
  "no-hand-rolled-fetch",
  "scan-pr / osv-scan",
  "License Review",
];

// Branch protection's own (narrower) required-contexts set on this repo — what
// `checksStateFromRollup` is threaded, per its own doc: "ci-gate" + "remudero-review".
const BRANCH_PROTECTION_REQUIRED = ["ci-gate", "remudero-review"];

function rollupCheck(over: Partial<RollupCheckEntry> = {}): RollupCheckEntry {
  return { name: "check", conclusion: "SUCCESS", startedAt: "2026-08-30T13:50:00Z", ...over };
}

function basePr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 3318,
    prUrl: "https://github.com/craigoley/remudero/pull/3318",
    taskId: "W1-TX",
    reviewState: "success",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "cafef00d",
    autoMergeArmed: false,
    ...over,
  };
}

// The #3318 shape: ci-gate (the aggregate) still running; coverage-ratchet, one of the 14 checks
// it aggregates, already concluded FAILURE.
const PENDING_AGGREGATE_RED_GATE_ROLLUP: RollupCheckEntry[] = [
  rollupCheck({ name: "ci-gate", status: "in_progress", conclusion: undefined }),
  rollupCheck({ name: "coverage-ratchet", conclusion: "FAILURE" }),
  rollupCheck({ name: "ci", conclusion: "SUCCESS" }),
];

test("acceptance 1: a PR with a concluded red quality gate is visible as fixable while the aggregate is still pending", () => {
  const checksState = checksStateFromRollup(PENDING_AGGREGATE_RED_GATE_ROLLUP, BRANCH_PROTECTION_REQUIRED);
  assert.equal(checksState, "pending", "ci-gate itself has not concluded — the aggregate really is still pending");

  const redRequiredChecks = redQualityGateNames(PENDING_AGGREGATE_RED_GATE_ROLLUP, CI_GATE_REQUIRED);
  assert.deepEqual(redRequiredChecks, ["coverage-ratchet"]);

  const pr = basePr({ checksState, redRequiredChecks });
  assert.equal(isBlockedCi(pr), true, "a red required gate must be visible even while the aggregate is pending");

  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable", "the fix rung's own trigger must fire — not 'wait'");
});

test("acceptance 2: the failing check's own name reaches the fix rung's evidence rather than the aggregate's", () => {
  const redRequiredChecks = redQualityGateNames(PENDING_AGGREGATE_RED_GATE_ROLLUP, CI_GATE_REQUIRED);
  const pr = basePr({ checksState: "pending", redRequiredChecks });

  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.match(r.reason, /coverage-ratchet/, "the SPECIFIC failing check must be named, not the aggregate");
  assert.doesNotMatch(
    r.reason,
    /no failing-check detail captured/,
    "must not fall back to the generic no-detail message once a specific gate is known",
  );
  // The aggregate's own name must never stand in for the check that actually failed.
  assert.doesNotMatch(r.reason, /\bci-gate\b failed/);
});

test("acceptance 3: checksState returns exactly what it returns today for every input — unchanged by this task", () => {
  // green: every branch-protection-required context concludes OK.
  assert.equal(
    checksStateFromRollup(
      [rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" })],
      BRANCH_PROTECTION_REQUIRED,
    ),
    "green",
  );
  // red: a required context concludes a FAIL-set member.
  assert.equal(
    checksStateFromRollup(
      [rollupCheck({ name: "ci-gate", conclusion: "FAILURE" })],
      BRANCH_PROTECTION_REQUIRED,
    ),
    "red",
  );
  // pending: something reported, but the required context has not registered on this head yet.
  assert.equal(
    checksStateFromRollup([rollupCheck({ name: "some-other-check" })], BRANCH_PROTECTION_REQUIRED),
    "pending",
  );
  // none: nothing reported at all and no required contexts confirmed.
  assert.equal(checksStateFromRollup([], undefined), "none");
  // A NON-required, red sibling check (exactly this task's own #3318 shape) must NOT move
  // checksState — it stays "pending" precisely because checksStateFromRollup's own filter to
  // branch protection's contexts is untouched by this task.
  assert.equal(
    checksStateFromRollup(PENDING_AGGREGATE_RED_GATE_ROLLUP, BRANCH_PROTECTION_REQUIRED),
    "pending",
    "checksStateFromRollup must keep answering ONLY the merge-eligibility question, unchanged",
  );
});

test("acceptance 4: no fifth member is added to the checksState union", () => {
  assert.match(
    SWEEP_SOURCE,
    /checksState:\s*"green"\s*\|\s*"red"\s*\|\s*"pending"\s*\|\s*"none";/,
    "OpenPrView.checksState must remain the SAME four-member union",
  );
  assert.match(
    SWEEP_SOURCE,
    /export function checksStateFromRollup\(\s*\n\s*rollup: RollupCheckEntry\[\] \| undefined,\s*\n\s*requiredContexts: Iterable<string> \| undefined,\s*\n\): OpenPrView\["checksState"\] \{/,
    "checksStateFromRollup's own signature/return type must be untouched",
  );
  // The new observable is a genuinely SEPARATE field, never folded into the checksState union.
  assert.match(SWEEP_SOURCE, /redRequiredChecks\?:\s*string\[\];/);
});

test("acceptance 5: a PR with only pending checks and no concluded failure is still not fixable", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", status: "in_progress", conclusion: undefined }),
    rollupCheck({ name: "coverage-ratchet", status: "in_progress", conclusion: undefined }),
    rollupCheck({ name: "ci", status: "in_progress", conclusion: undefined }),
  ];
  const checksState = checksStateFromRollup(rollup, BRANCH_PROTECTION_REQUIRED);
  const redRequiredChecks = redQualityGateNames(rollup, CI_GATE_REQUIRED);
  assert.deepEqual(redRequiredChecks, [], "nothing has concluded red — the new observable must report nothing");

  const pr = basePr({ checksState, redRequiredChecks });
  assert.equal(isBlockedCi(pr), false, "no concluded failure anywhere — must not read as CI-blocked");

  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.notEqual(r.disposition, "blocked-fixable");
  assert.doesNotMatch(r.reason, /ci-log fix/);
});

test("acceptance 6: arming and merge-eligibility decisions read the unchanged field", () => {
  // isCappedReviewOrphanEscalation is an arming-adjacent predicate that reads `pr.checksState`
  // directly (never `isBlockedCi`) — it must be byte-identical whether or not redRequiredChecks
  // is populated, since checksState is what it actually reads.
  const policy = { ...DEFAULT_SWEEP_POLICY, reviewOrphanCap: 1 };
  const without = basePr({
    checksState: "green",
    reviewState: "none",
    reviewOrphanedByPush: true,
    priorReviewAttemptsForInput: 5,
    requiredContextsUnreadable: false,
  });
  // Same PR, but now carrying a (contrived) non-empty redRequiredChecks — the arm/merge-adjacent
  // predicate must not be swayed by it, because it never reads that field.
  const withRedGate = { ...without, redRequiredChecks: ["coverage-ratchet"] };

  assert.equal(isCappedReviewOrphanEscalation(without, policy), true);
  assert.equal(
    isCappedReviewOrphanEscalation(withRedGate, policy),
    true,
    "an arming/merge-eligibility predicate keyed on checksState must ignore the new observable entirely",
  );

  // And checksStateFromRollup's own output for the SAME rollup+requiredContexts is identical
  // regardless of what redQualityGateNames would separately report for that rollup.
  const rollup = [rollupCheck({ name: "ci-gate", conclusion: "SUCCESS" })];
  const checksStateAlone = checksStateFromRollup(rollup, BRANCH_PROTECTION_REQUIRED);
  redQualityGateNames(rollup, CI_GATE_REQUIRED); // computed, but must have no side effect
  assert.equal(checksStateFromRollup(rollup, BRANCH_PROTECTION_REQUIRED), checksStateAlone);
});

test("acceptance 7: a check outside the required list does not make a PR fixable on its own", () => {
  // #2434's own fixture: clock-sweep fails, but it is not — and never has been — a member of
  // ci-gate.yml's own REQUIRED list, so it must not be read as a quality-gate red either.
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "ci-gate", status: "in_progress", conclusion: undefined }),
    rollupCheck({ name: "coverage-ratchet", conclusion: "SUCCESS" }),
    rollupCheck({ name: "clock-sweep", conclusion: "FAILURE" }),
  ];
  const redRequiredChecks = redQualityGateNames(rollup, CI_GATE_REQUIRED);
  assert.deepEqual(redRequiredChecks, [], "a failing check outside ci-gate's own required list must be excluded");

  const pr = basePr({ checksState: checksStateFromRollup(rollup, BRANCH_PROTECTION_REQUIRED), redRequiredChecks });
  assert.equal(isBlockedCi(pr), false);

  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.notEqual(r.disposition, "blocked-fixable");
});

test("acceptance 8: restoring the aggregate-only read makes the pending-with-red-gate case invisible again", () => {
  const checksState = checksStateFromRollup(PENDING_AGGREGATE_RED_GATE_ROLLUP, BRANCH_PROTECTION_REQUIRED);
  const redRequiredChecks = redQualityGateNames(PENDING_AGGREGATE_RED_GATE_ROLLUP, CI_GATE_REQUIRED);
  assert.ok(redRequiredChecks.length > 0, "the new observable DOES see the red gate");

  // The pre-fix predicate: `isBlockedCi` was exactly `checksState === "red"`, nothing else.
  // Restoring THAT (aggregate-only) read reproduces the blind spot this task fixes.
  const aggregateOnlyIsBlockedCi = checksState === "red";
  assert.equal(
    aggregateOnlyIsBlockedCi,
    false,
    "reading only checksState leaves the #3318 case invisible — checksState is still 'pending'",
  );

  // The WIDENED predicate this task ships sees it.
  const pr = basePr({ checksState, redRequiredChecks });
  assert.equal(isBlockedCi(pr), true, "the widened predicate must see what the aggregate-only read cannot");
});

// ── Direct unit coverage of redQualityGateNames itself ──────────────────────────────────────

test("redQualityGateNames: empty/undefined required-check list fails closed to []", () => {
  assert.deepEqual(redQualityGateNames(PENDING_AGGREGATE_RED_GATE_ROLLUP, undefined), []);
  assert.deepEqual(redQualityGateNames(PENDING_AGGREGATE_RED_GATE_ROLLUP, []), []);
});

test("redQualityGateNames: dedupes by latest attempt — a superseded FAILURE followed by a SUCCESS on the same head reports nothing", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "coverage-ratchet", conclusion: "FAILURE", startedAt: "2026-08-30T13:48:42Z" }),
    rollupCheck({ name: "coverage-ratchet", conclusion: "SUCCESS", startedAt: "2026-08-30T13:50:02Z" }),
  ];
  assert.deepEqual(redQualityGateNames(rollup, CI_GATE_REQUIRED), []);
});

test("redQualityGateNames: excludes the remudero-review commit status even when it concludes a FAIL-set state", () => {
  const rollup: RollupCheckEntry[] = [rollupCheck({ context: "remudero-review", state: "FAILURE" })];
  assert.deepEqual(redQualityGateNames(rollup, ["remudero-review", ...CI_GATE_REQUIRED]), []);
});

test("redQualityGateNames: names every required gate that concluded red, not just the first", () => {
  const rollup: RollupCheckEntry[] = [
    rollupCheck({ name: "coverage-ratchet", conclusion: "FAILURE" }),
    rollupCheck({ name: "mutation-ratchet", conclusion: "TIMED_OUT" }),
    rollupCheck({ name: "ci", conclusion: "SUCCESS" }),
  ];
  assert.deepEqual(redQualityGateNames(rollup, CI_GATE_REQUIRED).sort(), ["coverage-ratchet", "mutation-ratchet"]);
});
