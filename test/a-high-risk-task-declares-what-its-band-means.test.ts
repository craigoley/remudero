import assert from "node:assert/strict";
import { test } from "node:test";
import { lintTask, sizingViolation, type RiskTransitionContext } from "../src/lib/task-linter.js";
import { parseTasksFromYaml, PlanError, type Task } from "../src/lib/plan.js";

/**
 * W1-T2503: `sizingViolation` used to exempt EVERY `risk: high` task from Rule 19's span
 * check with one line (`if (task.risk === "high") return undefined`) — so raising a band
 * was a one-word escape, and the band itself conflated two meanings (Rule 19's SPAN vs.
 * genuine BLAST RADIUS) with nothing recording which. This suite locks the fix: a task the
 * diff newly files or promotes to high must now DECLARE `band_meaning` (`"span"` or
 * `"blast-radius"`); the standing backlog authored before this field existed is reported,
 * never refused.
 */

/** A minimal, otherwise-clean Task fixture at risk:high — every test overrides only what it
 *  needs. Mirrors the `task()` helper in test/task-linter.test.ts (kept local: this file's
 *  own declared scope is task-linter.ts + this test, not that sibling suite). */
function highTask(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "high",
    status: "queued",
    attempts: 0,
    origin: "architect",
    files: ["src/lib/example-subsystem.ts"],
    acceptance: [
      { claim: "does the thing", proof: "unit test: test/example-subsystem.test.ts asserts the thing" },
    ],
    ...over,
  };
}

function mediumTask(over: Partial<Task> & { id: string }): Task {
  return { ...highTask(over), risk: "medium" };
}

/** riskTransition context for "the diff MOVED this task to high" (was medium/low). */
function movedToHigh(fromRisk: "medium" | "low" = "medium"): RiskTransitionContext {
  return { baseTask: { ...highTask({ id: "BASE" }), risk: fromRisk } };
}

/** riskTransition context for "the diff FILED this task new, directly at high". */
const filedNewAtHigh: RiskTransitionContext = { baseTask: undefined };

/** riskTransition context for "this task was ALREADY high before the diff" (standing). */
const alreadyHigh: RiskTransitionContext = { baseTask: highTask({ id: "BASE" }) };

// ── ACCEPTANCE 1+2: a diff-introduced high-risk task without a declared band is refused,
//    and the refusal names BOTH legal meanings ────────────────────────────────────────────

test("ACCEPTANCE 1: a task the diff MOVES to high risk with no band_meaning is BLOCKED", () => {
  const t = highTask({ id: "W1-MOVED" });
  const v = sizingViolation(t, { riskTransition: movedToHigh("medium") });
  assert.ok(v, "expected a sizing violation");
  assert.equal(v?.severity, "block");
  const res = lintTask(t, { riskTransition: movedToHigh("medium") });
  assert.equal(res.ok, false);
});

test("ACCEPTANCE 1b: a task the diff FILES NEW directly at high with no band_meaning is BLOCKED", () => {
  const t = highTask({ id: "W1-NEW-HIGH" });
  const v = sizingViolation(t, { riskTransition: filedNewAtHigh });
  assert.ok(v, "expected a sizing violation");
  assert.equal(v?.severity, "block");
});

test("ACCEPTANCE 2: the refusal names BOTH legal band_meaning values, not a bare rejection", () => {
  const t = highTask({ id: "W1-MOVED-MSG" });
  const v = sizingViolation(t, { riskTransition: movedToHigh() });
  assert.ok(v?.message.includes("band_meaning: span"), "must name span");
  assert.ok(v?.message.includes("band_meaning: blast-radius"), "must name blast-radius");
});

// ── ACCEPTANCE 3: a task ALREADY high before the diff is reported, never refused ──────────

test("ACCEPTANCE 3: a task already high BEFORE the diff, with no band_meaning, is a WARN — never a block", () => {
  const t = highTask({ id: "W1-STANDING" });
  const v = sizingViolation(t, { riskTransition: alreadyHigh });
  assert.ok(v, "still reported");
  assert.equal(v?.severity, "warn");
  const res = lintTask(t, { riskTransition: alreadyHigh });
  assert.equal(res.ok, true, "a warn never flips lintTask.ok false");
});

test("ACCEPTANCE 3b: with NO diff context at all (every call site before this task: pre-dispatch, " +
  "whole-plan lintPlan, retro, inbox, panel-skill-run), an undeclared band on a standing high-risk " +
  "task stays fully SILENT — byte-for-byte the old exemption", () => {
  const t = highTask({ id: "W1-NO-CONTEXT", files: ["src/lib/daemon.ts", "src/lib/launchd.ts", "src/lib/review.ts"] });
  assert.equal(sizingViolation(t), undefined);
  assert.equal(lintTask(t).violations.some((v) => v.check === "sizing"), false);
});

// ── ACCEPTANCE 4: band_meaning: blast-radius is exempt from the span check, exactly as today ─

test("ACCEPTANCE 4: band_meaning: blast-radius is fully EXEMPT — a wide span never flags, transition or not", () => {
  const wideSpanFiles = ["src/lib/daemon.ts", "src/lib/launchd.ts", "src/lib/review.ts"];
  const movedNoDeclare = highTask({ id: "W1-BR-MOVED", band_meaning: "blast-radius", files: wideSpanFiles });
  assert.equal(sizingViolation(movedNoDeclare, { riskTransition: movedToHigh() }), undefined);
  const standing = highTask({ id: "W1-BR-STANDING", band_meaning: "blast-radius", files: wideSpanFiles });
  assert.equal(sizingViolation(standing, { riskTransition: alreadyHigh }), undefined);
  const noContext = highTask({ id: "W1-BR-NO-CONTEXT", band_meaning: "blast-radius", files: wideSpanFiles });
  assert.equal(sizingViolation(noContext), undefined);
});

// ── ACCEPTANCE 5+6: band_meaning: span computes and REPORTS the subsystem count — never a
//    refusal, even for a wide span ─────────────────────────────────────────────────────────

test("ACCEPTANCE 5: band_meaning: span REPORTS the subsystem count instead of skipping it", () => {
  const t = highTask({
    id: "W1-SPAN-REPORTED",
    band_meaning: "span",
    files: ["src/lib/daemon.ts", "src/lib/launchd.ts"],
  });
  const v = sizingViolation(t, { riskTransition: movedToHigh() });
  assert.ok(v, "expected a report");
  assert.match(v!.message, /spans 2 distinct subsystems/);
});

test("ACCEPTANCE 6: band_meaning: span NEVER turns a wide span into a refusal — WARN only, " +
  "on a diff-transition task and a standing one alike", () => {
  const wideSpanFiles = ["src/lib/daemon.ts", "src/lib/launchd.ts", "src/lib/review.ts"];
  const movedTask = highTask({ id: "W1-SPAN-MOVED", band_meaning: "span", files: wideSpanFiles });
  const vMoved = sizingViolation(movedTask, { riskTransition: movedToHigh() });
  assert.equal(vMoved?.severity, "warn");
  assert.equal(lintTask(movedTask, { riskTransition: movedToHigh() }).ok, true);

  const standingTask = highTask({ id: "W1-SPAN-STANDING", band_meaning: "span", files: wideSpanFiles });
  const vStanding = sizingViolation(standingTask, { riskTransition: alreadyHigh });
  assert.equal(vStanding?.severity, "warn");

  // A single subsystem under band_meaning: span is silent, exactly like risk:medium's own rule.
  const narrowTask = highTask({ id: "W1-SPAN-NARROW", band_meaning: "span", files: ["src/lib/daemon.ts"] });
  assert.equal(sizingViolation(narrowTask, { riskTransition: movedToHigh() }), undefined);
});

// ── ACCEPTANCE 7: medium and low tasks keep the existing sizing behaviour byte for byte ─────

test("ACCEPTANCE 7: risk:medium spanning 3 subsystems still BLOCKS exactly as before this task", () => {
  const t = mediumTask({
    id: "W1-MEDIUM-SPAN",
    files: ["src/lib/daemon.ts", "src/lib/launchd.ts", "src/lib/review.ts"],
  });
  const v = sizingViolation(t);
  assert.ok(v);
  assert.equal(v?.severity, "block");
  assert.match(v!.message, /spans 3 distinct subsystems.*at risk:medium — Rule 19/);
  // opts (including a riskTransition, which only ever matters at risk:high) change nothing.
  assert.deepEqual(sizingViolation(t, { riskTransition: movedToHigh() }), v);
});

test("ACCEPTANCE 7b: risk:low spanning 2 subsystems still BLOCKS exactly as before this task", () => {
  const t = { ...mediumTask({ id: "W1-LOW-SPAN", files: ["src/lib/daemon.ts", "src/lib/launchd.ts"] }), risk: "low" as const };
  const v = sizingViolation(t);
  assert.ok(v);
  assert.equal(v?.severity, "block");
});

test("ACCEPTANCE 7c: a single-subsystem risk:medium task is silent exactly as before this task", () => {
  const t = mediumTask({ id: "W1-MEDIUM-ONE", files: ["src/lib/daemon.ts"] });
  assert.equal(sizingViolation(t), undefined);
});

// ── ACCEPTANCE 8: dropping the transition scoping makes the standing 824 fail the gate ─────

test("ACCEPTANCE 8: the TRANSITION SCOPING is what protects the standing baseline — drop the " +
  "comparison against baseTask.risk (i.e. treat every undeclared high-risk task as a fresh " +
  "transition, exactly what a scoping-less check would do) and the SAME standing task flips " +
  "from a warn to a block", () => {
  const standing = highTask({ id: "W1-DROP-SCOPING" });
  // Correctly scoped: the caller tells sizingViolation this task was ALREADY high before the
  // diff — reported, never refused.
  const scoped = sizingViolation(standing, { riskTransition: alreadyHigh });
  assert.equal(scoped?.severity, "warn");
  // Dropping the scoping is exactly "treat baseTask as absent/unknown" — the same shape
  // `filedNewAtHigh` uses for a genuinely new task. Feeding the IDENTICAL standing task
  // through that shape is what a check that forgot to compare against baseTask.risk would
  // do, and it fails the gate outright.
  const unscoped = sizingViolation(standing, { riskTransition: filedNewAtHigh });
  assert.equal(unscoped?.severity, "block", "dropping the transition scoping must fail the standing task");
});

// ── ACCEPTANCE 9: the YAML loader validates `band_meaning` exactly like every other
//    enum field on a task (risk, status, retirement) — a bogus value is a PlanError,
//    a legal one round-trips onto the parsed Task ────────────────────────────────────

test("ACCEPTANCE 9: parseTasksFromYaml rejects an unrecognised band_meaning", () => {
  const yaml = `
- id: W1-BAD-BAND
  title: bogus band
  repo: remudero
  type: implement
  risk: high
  band_meaning: not-a-real-value
`;
  assert.throws(
    () => parseTasksFromYaml(yaml, "test-blob"),
    (err: unknown) => err instanceof PlanError && /invalid band_meaning/.test((err as Error).message),
  );
});

test("ACCEPTANCE 9b: parseTasksFromYaml accepts a legal band_meaning and carries it onto the Task", () => {
  const yaml = `
- id: W1-GOOD-BAND
  title: legit band
  repo: remudero
  type: implement
  risk: high
  band_meaning: blast-radius
`;
  const [t] = parseTasksFromYaml(yaml, "test-blob");
  assert.equal(t.band_meaning, "blast-radius");
});

test("ACCEPTANCE 9c: parseTasksFromYaml leaves band_meaning undefined when the task omits it", () => {
  const yaml = `
- id: W1-NO-BAND
  title: no band declared
  repo: remudero
  type: implement
  risk: high
`;
  const [t] = parseTasksFromYaml(yaml, "test-blob");
  assert.equal(t.band_meaning, undefined);
});
