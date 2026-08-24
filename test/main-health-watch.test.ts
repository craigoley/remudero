import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  mainHealthEscalationClass,
  mainHealthEscalationDecision,
  mainHealthFromRollup,
  mainHealthShouldStandDownDispatch,
  PUSH_VACUOUS_SUCCESS_CHECK_NAMES,
  type MainHealthObservation,
  type RollupCheckEntry,
} from "../src/lib/sweep.js";

/**
 * W1-T2204 — nothing in the fleet reads main's own check state. Measured control: `checksState`
 * (a PR-rollup reader) appears 80 times in lib/sweep.ts; `mainChecks`/`trunkHealth`/`defaultBranch`
 * all read 0. This suite proves the reader this task adds satisfies the shard's five acceptance
 * criteria, one `describe`-style block per criterion, plus the falsifiers the shard states so they
 * can be run: a vacuous rollup must never read green, and neither an unrelated dispatch stand-down
 * nor an auto-revert may ever follow from a red trunk alone.
 */

const SHA = "68c8703bdeadbeef";
const REQUIRED = ["ci", "ci-gate", "coverage-ratchet"];

function check(over: Partial<RollupCheckEntry> = {}): RollupCheckEntry {
  return { name: "ci", conclusion: "SUCCESS", startedAt: "2026-08-24T00:00:00Z", ...over };
}

// ── acceptance 1 — the sweep reads main's own check state as a named observation ────────────────

test("acceptance 1: mainHealthFromRollup returns a named MainHealthObservation carrying the sha, a state, and a reason — not a bare boolean", () => {
  const rollup: RollupCheckEntry[] = [check({ name: "ci" })];
  const obs: MainHealthObservation = mainHealthFromRollup(SHA, rollup, ["ci"]);
  assert.equal(obs.sha, SHA);
  assert.equal(obs.state, "green");
  assert.equal(typeof obs.reason, "string");
  assert.ok(obs.reason.length > 0, "the observation must state WHY, not just what");
});

// ── acceptance 2 — skipped / vacuous-success checks are not evidence of health ───────────────────

test("acceptance 2: a required check that concluded SKIPPED is excluded from evidence, not counted toward green", () => {
  const rollup: RollupCheckEntry[] = [check({ name: "ci-gate", conclusion: "SKIPPED" })];
  const obs = mainHealthFromRollup(SHA, rollup, ["ci-gate"]);
  assert.notEqual(obs.state, "green");
  assert.deepEqual(obs.nonEvidenceChecks, ["ci-gate"]);
});

test("acceptance 2: the #2204 fixture — 13 required checks SKIPPED and coverage-ratchet a known vacuous SUCCESS, with only `ci` genuinely concluding, reads green off `ci` alone and names the rest as non-evidence, never silently folded into the green verdict", () => {
  const skippedNames = [
    "lint-plan",
    "claims",
    "commitlint",
    "depcruise",
    "jscpd-gate",
    "leak-grep",
    "mutation-ratchet",
    "containment-probe",
    "api-client-drift",
    "no-hand-rolled-fetch",
    "task-id-existence",
    "assertion-discrimination",
    "learnings-budget-ratchet",
  ];
  const rollup: RollupCheckEntry[] = [
    check({ name: "ci", conclusion: "SUCCESS" }),
    check({ name: "coverage-ratchet", conclusion: "SUCCESS" }),
    ...skippedNames.map((name) => check({ name, conclusion: "SKIPPED" })),
  ];
  const required = ["ci", "coverage-ratchet", ...skippedNames];
  const obs = mainHealthFromRollup(SHA, rollup, required);
  assert.equal(obs.state, "green", "ci genuinely ran and passed — real evidence exists");
  assert.ok(obs.nonEvidenceChecks.includes("coverage-ratchet"), "the vacuous-success job is named as non-evidence");
  for (const name of skippedNames) {
    assert.ok(obs.nonEvidenceChecks.includes(name), `${name} (skipped) must be named as non-evidence`);
  }
  assert.ok(!obs.failingChecks.length, "nothing here is a failure");
});

test("acceptance 2 falsifier: coverage-ratchet alone (SUCCESS, vacuous) with no other required check reads undetermined, never green — the exact vacuous-pass this task refuses", () => {
  const rollup: RollupCheckEntry[] = [check({ name: "coverage-ratchet", conclusion: "SUCCESS" })];
  const obs = mainHealthFromRollup(SHA, rollup, ["coverage-ratchet"]);
  assert.notEqual(obs.state, "green");
  assert.equal(obs.state, "undetermined");
  assert.ok(PUSH_VACUOUS_SUCCESS_CHECK_NAMES.has("coverage-ratchet"), "coverage-ratchet is the cited, named vacuous-success check");
});

// ── acceptance 3 — a trunk read with checks still pending is undetermined, never green ──────────

test("acceptance 3: a required check still IN_PROGRESS (no terminal conclusion) reads undetermined, not green — 0 failing must never alone mean healthy", () => {
  const rollup: RollupCheckEntry[] = [
    check({ name: "ci", conclusion: "SUCCESS" }),
    check({ name: "ci-gate", status: "IN_PROGRESS", conclusion: undefined }),
  ];
  const obs = mainHealthFromRollup(SHA, rollup, ["ci", "ci-gate"]);
  assert.equal(obs.state, "undetermined");
  assert.deepEqual(obs.pendingChecks, ["ci-gate"]);
});

test("acceptance 3: required checks configured but NONE have registered yet on this head reads undetermined, not green", () => {
  const obs = mainHealthFromRollup(SHA, [], ["ci"]);
  assert.equal(obs.state, "undetermined");
});

test("acceptance 3 falsifier: pending never gets silently outvoted by an unrelated passing check into green", () => {
  const rollup: RollupCheckEntry[] = [
    check({ name: "ci", conclusion: "SUCCESS" }),
    check({ name: "ci-gate", status: "QUEUED", conclusion: undefined }),
  ];
  const obs = mainHealthFromRollup(SHA, rollup, ["ci", "ci-gate"]);
  assert.notEqual(obs.state, "green");
});

// ── acceptance 4 — a red trunk escalates inside the existing three classes, never a revert ──────

test("acceptance 4: a required check concluded FAILURE reads red and escalates inside BLOCKED|MANUAL|HARD_STOP", () => {
  const rollup: RollupCheckEntry[] = [check({ name: "ci", conclusion: "FAILURE" })];
  const obs = mainHealthFromRollup(SHA, rollup, ["ci"]);
  assert.equal(obs.state, "red");
  assert.deepEqual(obs.failingChecks, ["ci"]);

  const decision = mainHealthEscalationDecision(obs);
  assert.equal(decision.escalate, true);
  assert.ok(
    (["BLOCKED", "MANUAL", "HARD_STOP"] as const).includes(decision.class as "BLOCKED" | "MANUAL" | "HARD_STOP"),
    "must land inside the existing three classes — never a fourth",
  );
  assert.equal(mainHealthEscalationClass(), decision.class, "the class is stable, not ad hoc per call");
});

test("acceptance 4: an undetermined (non-red) trunk observation never escalates — only red does", () => {
  const rollup: RollupCheckEntry[] = [check({ name: "ci-gate", conclusion: "SKIPPED" })];
  const obs = mainHealthFromRollup(SHA, rollup, ["ci-gate"]);
  assert.notEqual(obs.state, "red");
  assert.equal(mainHealthEscalationDecision(obs).escalate, false);
});

test("acceptance 4 falsifier: nothing about a red-trunk escalation decision performs or requests a revert — only reports", () => {
  const rollup: RollupCheckEntry[] = [check({ name: "ci", conclusion: "FAILURE" })];
  const obs = mainHealthFromRollup(SHA, rollup, ["ci"]);
  const decision = mainHealthEscalationDecision(obs);
  // The decision is a plain report object — no field naming a revert action, and no field of
  // any kind that isn't `escalate`/`class`/`reason` (an action field would be how a revert-taking
  // implementation would smuggle one in).
  assert.deepEqual(new Set(Object.keys(decision)), new Set(["escalate", "class", "reason"]));
  assert.equal(Object.keys(decision).includes("revert"), false);
  assert.ok(/never auto-reverted/i.test(decision.reason), "the reason states the no-revert guarantee explicitly");
});

// ── acceptance 5 — a red trunk does not by itself stop dispatch without an operator ruling ──────

test("acceptance 5: a red trunk with NO operator ruling recorded never stands down dispatch — the default (no second argument) is false", () => {
  const rollup: RollupCheckEntry[] = [check({ name: "ci", conclusion: "FAILURE" })];
  const obs = mainHealthFromRollup(SHA, rollup, ["ci"]);
  assert.equal(obs.state, "red");
  assert.equal(mainHealthShouldStandDownDispatch(obs), false);
  assert.equal(mainHealthShouldStandDownDispatch(obs, undefined), false);
  assert.equal(mainHealthShouldStandDownDispatch(obs, false), false);
});

test("acceptance 5: only an explicit, recorded operator ruling (true) can stand down dispatch, and only on a red trunk", () => {
  const redRollup: RollupCheckEntry[] = [check({ name: "ci", conclusion: "FAILURE" })];
  const red = mainHealthFromRollup(SHA, redRollup, ["ci"]);
  assert.equal(mainHealthShouldStandDownDispatch(red, true), true);

  const greenRollup: RollupCheckEntry[] = [check({ name: "ci", conclusion: "SUCCESS" })];
  const green = mainHealthFromRollup(SHA, greenRollup, ["ci"]);
  assert.equal(
    mainHealthShouldStandDownDispatch(green, true),
    false,
    "an operator ruling on a HEALTHY trunk must never stand down dispatch — the ruling answers the red-trunk question only",
  );
});

test("acceptance 5 falsifier: an unrelated task's dispatch never stops on a red trunk absent an operator ruling", () => {
  const rollup: RollupCheckEntry[] = [check({ name: "ci", conclusion: "FAILURE" })];
  const obs = mainHealthFromRollup(SHA, rollup, ["ci"]);
  // Simulates a dispatch loop consulting this signal with whatever it has on hand for an
  // operator ruling today — nothing recorded.
  const operatorRuling = undefined;
  assert.equal(mainHealthShouldStandDownDispatch(obs, operatorRuling), false);
});
