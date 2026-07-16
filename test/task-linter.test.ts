import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertLintClean,
  budgetSanityWarning,
  changedTaskIds,
  headlessFitnessViolations,
  lintPlan,
  lintTask,
  moduleIdFromPath,
  proofShapeViolations,
  provenanceViolation,
  sizingViolation,
  subsystemsOf,
  TaskLintError,
} from "../src/lib/task-linter.js";
import { loadPlanFromYaml, type Task } from "../src/lib/plan.js";

/** A minimal, otherwise-clean Task fixture — every test overrides only what it needs. */
function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "does the thing", proof: "unit test test/foo.test.ts asserts the thing" }],
    ...over,
  };
}

// ── moduleIdFromPath ──────────────────────────────────────────────────────────

test("moduleIdFromPath: basename minus extension", () => {
  assert.equal(moduleIdFromPath("src/lib/daemon.ts"), "daemon");
  assert.equal(moduleIdFromPath("src/lib/launchd.ts"), "launchd");
});

test("moduleIdFromPath: a `.test.ts` file folds to the SAME module as its source", () => {
  assert.equal(moduleIdFromPath("test/review.test.ts"), "review");
  assert.equal(moduleIdFromPath("src/lib/review.ts"), "review");
});

test("moduleIdFromPath: no extension ⇒ undefined", () => {
  assert.equal(moduleIdFromPath("plan/tasks"), undefined);
});

// ── SIZING (Rule 19) — acceptance criteria 1 and 2 ────────────────────────────

test("ACCEPTANCE 1: a task spanning 3 distinct subsystems (files:) at risk:medium is FLAGGED (sizing)", () => {
  const t = task({
    id: "FIX-SIZING",
    risk: "medium",
    files: ["src/lib/daemon.ts", "src/lib/launchd.ts", "src/lib/review.ts"],
  });
  assert.equal(subsystemsOf(t).size, 3);
  const v = sizingViolation(t);
  assert.ok(v, "expected a sizing violation");
  assert.equal(v?.severity, "block");
  const res = lintTask(t);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((x) => x.check === "sizing"));
});

test("risk:high is EXEMPT from sizing — the same 3-subsystem spread does NOT flag", () => {
  const t = task({
    id: "FIX-SIZING-HIGH",
    risk: "high",
    files: ["src/lib/daemon.ts", "src/lib/launchd.ts", "src/lib/review.ts"],
  });
  assert.equal(sizingViolation(t), undefined);
});

// The ACTUAL W1-T4 shape (HeadroomTracker v0 — /usage parser), verbatim from
// plan/tasks.yaml: 3 criteria, ONE module (the /usage parser), no `files:`.
const W1_T4_SHAPE = task({
  id: "W1-T4-SHAPE",
  title: "HeadroomTracker v0 — /usage parser",
  risk: "medium",
  acceptance: [
    {
      claim: "parses session % + BOTH weekly windows + reset timestamps from `claude -p /usage`",
      proof: "parser test against the captured WS-0 fixture returns all five fields",
    },
    {
      claim: "the weekly label is read as DATA, not hardcoded (WS-0 saw a model name)",
      proof: "fixture with a different model label parses identically",
    },
    {
      claim: "total_cost_usd is used ONLY as a runaway tripwire, never for window math",
      proof: "grep: no window arithmetic references total_cost_usd",
    },
  ],
});

test("ACCEPTANCE 2: a multi-criteria SINGLE-concern task (W1-T4 shape) is NOT flagged — no false positive on raw criterion count", () => {
  assert.equal(sizingViolation(W1_T4_SHAPE), undefined);
  const res = lintTask(W1_T4_SHAPE);
  assert.equal(
    res.violations.some((v) => v.check === "sizing"),
    false,
  );
  assert.equal(res.ok, true);
});

// W1-T3E shape (Reviewer rubric): 4 criteria, ONE subsystem (the review.ts
// judge), but its criteria/proofs mention "plan/tasks.yaml", "review-gate.md",
// and "test/review.test.ts" — exactly the kind of incidental path/prose mention
// a naive "grep every src/lib basename" sizing check would false-positive on.
const W1_T3E_SHAPE = task({
  id: "W1-T3E-SHAPE",
  title: "Reviewer rubric — the four judgment items",
  risk: "medium",
  acceptance: [
    {
      claim: "the reviewer rubric checks four judgment items: ONE CONCERN per PR, ALL CALLERS AUDITED, TEST THEATER, REFACTOR-PHASE HONESTY",
      proof: "fixture tests over recorded (diff, report) tuples",
    },
    {
      claim: "the reviewer rubric flags a worker-authored satisfied_by: a diff that ADDS satisfied_by to plan/tasks.yaml FAILS unless plan-only and human-authored",
      proof: "fixture test: a diff adding satisfied_by in a NON-plan-only PR -> fails; the same in a plan-only PR -> passes",
    },
    {
      claim: "GOLDEN: the reviewer FAILS PR #12's docs/review-gate.md diff",
      proof: "golden test present in test/review.test.ts",
    },
    {
      claim: "a failing remudero-review status NAMES the unmet criterion",
      proof: "on a planted failure, the status description contains the unmet criterion's text",
    },
  ],
});

test("a naive keyword scan would false-positive on W1-T3E's incidental 'plan/tasks.yaml' and 'review-gate' mentions — the curated lexicon must NOT", () => {
  const res = lintTask(W1_T3E_SHAPE);
  assert.equal(
    res.violations.some((v) => v.check === "sizing"),
    false,
  );
});

// ── HEADLESS-FITNESS (Rule 18) — acceptance criterion 3 ───────────────────────

test("ACCEPTANCE 3: a criterion containing 'overnight' on an auto-verify task is FLAGGED (headless-fitness)", () => {
  const t = task({
    id: "FIX-HEADLESS-OVERNIGHT",
    verify: "auto",
    acceptance: [
      {
        claim: "the daemon drains a plan end-to-end, unattended, overnight",
        proof: "ledger + merged PRs + daily digest received",
      },
    ],
  });
  const v = headlessFitnessViolations(t);
  assert.equal(v.length, 1);
  assert.equal(v[0].severity, "block");
  assert.equal(lintTask(t).ok, false);
});

for (const [term, text] of [
  ["reboot", "survives a reboot"],
  ["launchctl", "loaded via launchctl"],
  ["loads-at-boot", "loads at boot"],
  ["killed", "the process is killed mid-task"],
  ["operator-confirms", "the operator confirms the result"],
  ["user-selects", "the user selects an option"],
  ["manual-eyeball", "a manual eyeball of the output"],
] as const) {
  test(`headless lexicon catches '${term}'`, () => {
    const t = task({ id: `FIX-${term}`, acceptance: [{ claim: text, proof: "some proof" }] });
    assert.equal(headlessFitnessViolations(t).length, 1);
  });
}

test("the SAME criterion on a verify:human task is NOT flagged — headless-fitness only governs auto-verify dispatch", () => {
  const t = task({
    id: "FIX-HUMAN-OK",
    verify: "human",
    acceptance: [{ claim: "overnight drain, killed and recovered manually", proof: "operator transcript" }],
  });
  assert.equal(headlessFitnessViolations(t).length, 0);
});

// ── PROOF-SHAPE — acceptance criterion 4 ──────────────────────────────────────

test('ACCEPTANCE 4: a criterion whose proof is "works" is FLAGGED (proof-shape)', () => {
  const t = task({ id: "FIX-VIBE-WORKS", acceptance: [{ claim: "it does the thing", proof: "works" }] });
  const v = proofShapeViolations(t);
  assert.equal(v.length, 1);
  assert.equal(lintTask(t).ok, false);
});

test('a criterion whose proof is "correct" is FLAGGED (proof-shape)', () => {
  const t = task({ id: "FIX-VIBE-CORRECT", acceptance: [{ claim: "it does the thing", proof: "correct" }] });
  assert.equal(proofShapeViolations(t).length, 1);
});

test("an empty proof is FLAGGED", () => {
  const t = task({ id: "FIX-VIBE-EMPTY", acceptance: [{ claim: "it does the thing", proof: "" }] });
  assert.equal(proofShapeViolations(t).length, 1);
});

test("an observable proof (a grep/test/transcript reference) is NOT flagged", () => {
  const t = task({
    id: "FIX-OBSERVABLE",
    acceptance: [{ claim: "it does the thing", proof: "grep: no callers of the old API remain" }],
  });
  assert.equal(proofShapeViolations(t).length, 0);
});

// ── PROVENANCE (Rules 16/17) ──────────────────────────────────────────────────

test("a task missing origin: is FLAGGED (provenance)", () => {
  const t = task({ id: "FIX-NO-ORIGIN", origin: undefined });
  const v = provenanceViolation(t);
  assert.ok(v);
  assert.equal(lintTask(t).ok, false);
});

test("a task with origin: present passes provenance", () => {
  const t = task({ id: "FIX-ORIGIN-OK", origin: "feedback#plan-health" });
  assert.equal(provenanceViolation(t), undefined);
});

// ── BUDGET-SANITY (soft) ──────────────────────────────────────────────────────

test("budget-sanity WARNS (never blocks) when mount max_turns is below the class mean", () => {
  const t = task({ id: "FIX-BUDGET" });
  const warn = budgetSanityWarning(20, { avgTurns: 45.2 });
  assert.ok(warn);
  assert.equal(warn?.severity, "warn");
  const res = lintTask(t, { mountMaxTurns: 20, calibration: { avgTurns: 45.2 } });
  assert.equal(res.ok, true, "a WARN must never flip ok to false");
  assert.ok(res.violations.some((v) => v.check === "budget-sanity"));
});

test("budget-sanity is silent when calibration data is not supplied — NEVER a hardcoded mean", () => {
  assert.equal(budgetSanityWarning(1, undefined), undefined);
});

test("budget-sanity is silent when the mount already meets or beats the class mean", () => {
  assert.equal(budgetSanityWarning(60, { avgTurns: 45.2 }), undefined);
});

// ── ACCEPTANCE 5: the pre-dispatch guard ──────────────────────────────────────

test("ACCEPTANCE 5: assertLintClean THROWS TaskLintError for a malformed task; a clean task PASSES", () => {
  const bad = task({
    id: "FIX-MALFORMED",
    risk: "medium",
    files: ["src/lib/daemon.ts", "src/lib/launchd.ts", "src/lib/review.ts"],
  });
  assert.throws(() => assertLintClean(bad), TaskLintError);
  try {
    assertLintClean(bad);
    assert.fail("expected a throw");
  } catch (e) {
    if (!(e instanceof TaskLintError)) throw e;
    assert.equal(e.taskId, "FIX-MALFORMED");
    assert.ok(e.violations.length > 0);
  }
  assert.doesNotThrow(() => assertLintClean(W1_T4_SHAPE));
});

// ── ACCEPTANCE 6: the canonical regression fixture ────────────────────────────
//
// W1-T12's ORIGINAL definition, verbatim from `git show 68aa498^:plan/tasks.yaml`
// (the commit immediately before its decompose, PR #57) — the task that died
// error_max_turns at 81 turns / $10.27, the 4th such event and the direct
// trigger for §5C. Bundled THREE concerns (scheduler loop / launchd unit /
// crash-recovery) and THREE headless-unfit criteria (overnight drain,
// launchctl-load-shaped boot assertion, live kill-and-recover).

const W1_T12_ORIGINAL = task({
  id: "W1-T12",
  title: "Daemonize — scheduler loop + launchd unit (LAST task in WS-1)",
  depends_on: ["W1-T2", "W1-T3", "W1-T4", "W1-T5", "W1-T6", "W1-T7", "W1-T8", "W1-T9a", "W1-T9b", "W1-T9c", "W1-T11"],
  risk: "medium",
  origin: "architect",
  acceptance: [
    {
      claim: "the daemon drains a 3-task plan on remudero-sandbox end-to-end, unattended, overnight",
      proof: "ledger + merged PRs + daily digest received",
    },
    {
      claim: "launchd unit uses absolute paths + explicit PATH; the daemon asserts its own env is ANTHROPIC-clean at boot",
      proof: "startup ledger line: env_clean=true, billing_mode=subscription",
    },
    {
      claim: "daemon killed mid-task recovers correct state from git + GitHub alone",
      proof: "chaos-drill transcript",
    },
  ],
});

test("ACCEPTANCE 6 (CANONICAL REGRESSION): W1-T12's original definition is flagged for BOTH sizing and headless-fitness", () => {
  const res = lintTask(W1_T12_ORIGINAL);
  assert.equal(res.ok, false);
  assert.ok(
    res.violations.some((v) => v.check === "sizing"),
    "must flag sizing (3 concerns: scheduler/launchd/crash-recovery)",
  );
  assert.ok(
    res.violations.some((v) => v.check === "headless-fitness"),
    "must flag headless-fitness (overnight/launchctl/killed)",
  );
  assert.throws(() => assertLintClean(W1_T12_ORIGINAL), TaskLintError);
});

// ── changedTaskIds — the CI diff-scope helper ─────────────────────────────────

test("changedTaskIds: a brand-new task id is changed", () => {
  const oldTasks = [task({ id: "A" })];
  const newTasks = [task({ id: "A" }), task({ id: "B" })];
  assert.deepEqual([...changedTaskIds(oldTasks, newTasks)], ["B"]);
});

test("changedTaskIds: an edited existing task is changed; an untouched one is not", () => {
  const oldTasks = [task({ id: "A", title: "old title" }), task({ id: "B" })];
  const newTasks = [task({ id: "A", title: "new title" }), task({ id: "B" })];
  assert.deepEqual([...changedTaskIds(oldTasks, newTasks)], ["A"]);
});

test("changedTaskIds: identical plans ⇒ nothing changed", () => {
  const t = [task({ id: "A" }), task({ id: "B" })];
  assert.deepEqual([...changedTaskIds(t, t)], []);
});

// ── lintPlan over a real loaded Plan ──────────────────────────────────────────

test("lintPlan runs the same checks across every task in a loaded plan", () => {
  const yaml = `
- id: CLEAN
  title: fine
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  origin: architect
  acceptance:
    - claim: "does the thing"
      proof: "grep: no old callers remain"
- id: BAD
  title: broken
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  origin: architect
  acceptance:
    - claim: "does the thing overnight"
      proof: "works"
`;
  const plan = loadPlanFromYaml(yaml, "fixture");
  const results = lintPlan(plan);
  assert.equal(results.get("CLEAN")?.ok, true);
  assert.equal(results.get("BAD")?.ok, false);
  const badChecks = results.get("BAD")?.violations.map((v) => v.check).sort();
  assert.deepEqual(badChecks, ["headless-fitness", "proof-shape"]);
});
