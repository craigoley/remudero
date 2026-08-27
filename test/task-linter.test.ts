import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  advisoryRoutingViolations,
  assertLintClean,
  budgetSanityWarning,
  changedTaskIds,
  criteriaAdded,
  DATA_ARTIFACT_CLASSES,
  declaredScopeViolation,
  followUpCarriesCriteria,
  HEADLESS_FORBIDDEN_LEXICON,
  headlessFitnessViolations,
  lintPlan,
  lintTask,
  moduleIdFromPath,
  postMergeAmendmentViolations,
  PROOF_PAYLOAD_SHAPES,
  proofDialectViolations,
  proofResolvabilityViolations,
  proofShapeViolations,
  provenanceViolation,
  rule15FilingViolation,
  rulingVerifyViolation,
  sizingViolation,
  SPAWN_OWNERSHIP_CUE,
  subsystemsOf,
  TaskLintError,
} from "../src/lib/task-linter.js";
import { loadPlan, loadPlanFromYaml, type Plan, type Task } from "../src/lib/plan.js";
import { nextRunnable, type MergedSet } from "../src/lib/drain.js";

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

// ── W1-T92 ACCEPTANCE — data/config files are not subsystems (#153) ──────────

test("W1-T92 ACCEPTANCE 1: a code file paired with its OWN data artifact (retro.ts + plan/mast-mapping.yaml) at risk:medium is 1 subsystem, NOT flagged", () => {
  const t = task({
    id: "FIX-153-CODE-PLUS-YAML",
    risk: "medium",
    files: ["src/lib/retro.ts", "plan/mast-mapping.yaml"],
  });
  assert.equal(subsystemsOf(t).size, 1);
  assert.equal(sizingViolation(t), undefined);
});

test("W1-T92 ACCEPTANCE 2 (regression lock): two GENUINE code subsystems at risk:medium still flag exactly as today", () => {
  const t = task({
    id: "FIX-153-TWO-CODE-SUBSYSTEMS",
    risk: "medium",
    files: ["src/lib/sweep.ts", "src/run-task.ts"],
  });
  assert.equal(subsystemsOf(t).size, 2);
  const v = sizingViolation(t);
  assert.ok(v, "expected a sizing violation");
  assert.equal(v?.severity, "block");
});

test("W1-T92 ACCEPTANCE 3: the discount set is DATA — adding an extension row discounts a seeded file with ZERO changes to subsystemsOf", () => {
  const extendedClasses = [
    ...DATA_ARTIFACT_CLASSES,
    { tag: "fixture-data", pathPattern: /^fixtures\//, extPattern: /\.csv$/i },
  ];
  const seeded = task({
    id: "FIX-153-SEEDED-NEW-CLASS",
    risk: "medium",
    files: ["src/lib/retro.ts", "fixtures/seed.csv"],
  });
  assert.equal(subsystemsOf(seeded).size, 2, "the DEFAULT table must not know this class yet");
  assert.equal(sizingViolation(seeded)?.severity, "block", "still flags under the default table");
  assert.equal(
    subsystemsOf(seeded, extendedClasses).size,
    1,
    "the fixture/.csv row discounts the seeded file once added",
  );
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
  // W1_T4_SHAPE is the REAL, still-open W1-T4's verbatim prose proofs (a live dead-proof-floor
  // offender, per W1-T246's own census, and a live proof-resolvability offender too: its
  // criterion 3 `grep:` proof names no `in <path>` clause) — warn-demoting BOTH checks isolates
  // THIS test to what it is actually about (sizing), matching how the pre-dispatch call site
  // treats the legacy backlog.
  const res = lintTask(W1_T4_SHAPE, { proofDialect: "warn", proofResolvability: "warn" });
  assert.equal(
    res.violations.some((v) => v.check === "sizing"),
    false,
  );
  // W1_T4_SHAPE deliberately carries no files: (the real, still-open record's own shape), so
  // it now also legitimately trips the new declared-scope check (W1-T504) — that is correct,
  // not a false positive from sizing, which is what this test isolates.
  const blocking = res.violations.filter((v) => v.severity === "block").map((v) => v.check);
  assert.deepEqual(blocking, ["declared-scope"], "sizing must not block — only the pre-existing bare-scope gap does");
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

// ── new phrase-level lexicon rows (RECALL, the #146 sweep) — one direct hit each ──

test("headless lexicon catches phrase-level 'paste the X, then revert'", () => {
  const t = task({
    id: "FIX-paste-then-revert",
    acceptance: [{ claim: "the gate goes CI-red on a planted regression", proof: "paste the red check, then revert" }],
  });
  assert.equal(headlessFitnessViolations(t).length, 1);
});

test("headless lexicon catches phrase-level 'run against <live/sandbox repo>'", () => {
  const t = task({
    id: "FIX-against-live-repo",
    acceptance: [{ claim: "rmd project init is run against remudero-sandbox and the first PR goes green", proof: "some proof" }],
  });
  assert.equal(headlessFitnessViolations(t).length, 1);
});

test("headless lexicon catches phrase-level 'operator observes'", () => {
  const t = task({
    id: "FIX-operator-observes",
    acceptance: [{ claim: "the operator observes the live drain complete end to end", proof: "some proof" }],
  });
  assert.equal(headlessFitnessViolations(t).length, 1);
});

// ── negation / self-reference precision (W1-T81, the #146 false-positive pair) ──
//
// A naive whole-word-anywhere scan false-positives on a hit inside a NEGATION
// ('NO real overnight run') and on a SELF-DESCRIBING criterion that names the
// lexicon to describe the check itself, not to instruct a live action.

test("negation exempts a hit ONLY within the same clause — an unrelated negation in an earlier clause does not exempt a later live claim", () => {
  const t = task({
    id: "NEG-SCOPE-SYNTH",
    acceptance: [{ claim: "no manual step is required for setup", proof: "the daemon then runs overnight, unattended" }],
  });
  assert.equal(headlessFitnessViolations(t).length, 1);
});

test("a lexicon hit fully inside a quoted excerpt does not flag (discussing the term, not instructing it)", () => {
  const t = task({
    id: "QUOTE-SYNTH",
    acceptance: [
      {
        claim: "the docs explain why a criterion saying 'a launchctl load' is rejected",
        proof: "grep: docs/task-lifecycle.md contains the quoted example",
      },
    ],
  });
  assert.equal(headlessFitnessViolations(t).length, 0);
});

test("the SAME term OUTSIDE any quotes still flags — a possessive apostrophe is not mistaken for a quote", () => {
  const t = task({
    id: "QUOTE-SYNTH-OUTSIDE",
    acceptance: [{ claim: "the plist is loaded via launchctl on the operator's machine", proof: "some proof" }],
  });
  assert.equal(headlessFitnessViolations(t).length, 1);
});

test("a bare-'/' enumeration of >=2 lexicon terms is a quoted/listed excerpt, not an instruction — does not flag", () => {
  const t = task({
    id: "ENUM-SYNTH",
    acceptance: [{ claim: "the lexicon covers reboot/killed/overnight as forbidden terms", proof: "unit test asserts the lexicon table has these entries" }],
  });
  assert.equal(headlessFitnessViolations(t).length, 0);
});

test("two lexicon terms joined by a SPACED slash still flag — only a BARE '/' (no surrounding spaces) counts as an enumeration", () => {
  const t = task({
    id: "ENUM-SYNTH-SPACED",
    acceptance: [{ claim: "the live drill covers reboot / killed scenarios on the operator's laptop", proof: "some proof" }],
  });
  assert.equal(headlessFitnessViolations(t).length, 1);
});

// ── W1-T81 ACCEPTANCE 1: the three #146 false positives, loaded VERBATIM from the
// real plan, no longer flag ──────────────────────────────────────────────────

const REAL_PLAN = loadPlan(fileURLToPath(new URL("../plan/tasks.yaml", import.meta.url)));

function realTask(id: string): Task {
  const t = REAL_PLAN.tasks.find((x) => x.id === id);
  assert.ok(t, `expected ${id} in the real plan`);
  return t as Task;
}

test("W1-T81 ACCEPTANCE 1a: W1-T12a's negation criterion ('NO real ... overnight run') does not flag, verbatim from the plan", () => {
  const t = realTask("W1-T12a");
  // The 'NO real overnight run' negation may live in the criterion's proof OR its
  // claim (W1-T246 repointed W1-T12a's proofs to the executable `unit test:`
  // dialect, moving the negation into the claim). Either way the property under
  // test is unchanged: a legitimate negation of a live-context term must NOT trip
  // headless-fitness. Read it wherever it sits, still verbatim from the plan.
  assert.ok(
    t.acceptance!.some((c) => /\bNO real overnight run\b/.test(`${c.claim ?? ""} ${c.proof ?? ""}`)),
    "W1-T12a still carries the 'NO real overnight run' negation verbatim in the plan",
  );
  assert.equal(headlessFitnessViolations(t).length, 0);
});

test("W1-T81 ACCEPTANCE 1b: W1-T12b's negation criterion ('NOT a real ... launchctl load') does not flag, verbatim from the plan", () => {
  const t = realTask("W1-T12b");
  assert.match(t.acceptance![0].proof, /\bNOT a real launchctl load\b/);
  assert.equal(headlessFitnessViolations(t).length, 0);
});

test("W1-T81 ACCEPTANCE 1c: W1-T20c's self-description criterion (its claim IS the lexicon, 'overnight/launchctl/killed') does not flag, verbatim from the plan", () => {
  const t = realTask("W1-T20c");
  const selfDescribing = t.acceptance!.find((c) => c.claim.includes("overnight/launchctl/killed"));
  assert.ok(selfDescribing, "expected W1-T20c to still carry its self-describing criterion verbatim");
  assert.equal(headlessFitnessViolations({ ...t, acceptance: [selfDescribing!] }).length, 0);
  // the WHOLE task, every criterion together, stays clean too
  assert.equal(headlessFitnessViolations(t).length, 0);
});

// ── W1-T81 ACCEPTANCE 2: the W1-T25-class pre-sweep live proofs now flag — the
// #146 false negative. Verbatim from commit 123491a (PR #146, "headless-fitness
// backlog sweep"), the "-" side of plan/tasks.yaml's diff for W1-T25/26/27/28 —
// BEFORE that PR converted their live 'paste the X, then revert' / 'run against
// <repo>' proofs to fixtures. No single lexicon WORD appears in any of these
// (they're PHRASES), so the original word-only lexicon never matched them; that
// is exactly the no_pr-at-122-turns gap this task closes. ─────────────────────

const PRE_SWEEP_T25 = task({
  id: "PRE-SWEEP-T25",
  acceptance: [
    {
      claim: "the coverage ratchet BLOCKS a coverage-lowering PR (live)",
      proof:
        "a PR deleting a covered test drops coverage below the recorded baseline and goes CI-red on the ratchet job; paste the red check, then revert",
    },
    {
      claim: "a mutation-testing baseline is established with a recorded score",
      proof: "Stryker runs in CI and the mutation score is recorded as the baseline (paste the score + config)",
    },
    {
      claim: "the jscpd duplication threshold BLOCKS a planted duplicate",
      proof: "a branch duplicating a code block over the threshold goes CI-red on jscpd; paste the red, then revert",
    },
    {
      claim: "TypeScript strict is proven ACTIVE by a planted probe that MUST fail",
      proof:
        "a planted strict-only violation (e.g. an unchecked index / implicit any) makes typecheck FAIL; a bare 0-violations without the probe is NOT accepted as proof (neon-drift lesson)",
    },
  ],
});

const PRE_SWEEP_T26 = task({
  id: "PRE-SWEEP-T26",
  acceptance: [
    {
      claim: "a dependency-cruiser rule BLOCKS a planted layering violation",
      proof:
        "a branch adding an import of src/spike.ts (or src/run-task.ts) into src/lib goes CI-red on the depcruise job with the named rule; paste the red, then revert",
    },
    {
      claim: "the fitness ruleset is declared and runs in CI",
      proof: "a .dependency-cruiser config is present with the src/lib-imports-no-spike/CLI rule and the depcruise job appears in the CI run",
    },
  ],
});

const PRE_SWEEP_T27 = task({
  id: "PRE-SWEEP-T27",
  acceptance: [
    {
      claim: "rmd project init provisions the full stack on remudero-sandbox and its first gated PR is green",
      proof:
        "run against remudero-sandbox; paste gh api .../branches/main/protection contexts (single aggregator + remudero-review), the .github/workflows list, and the url of a green first gated PR",
    },
    {
      claim: "ratchet baselines are captured at onboarding (no repo starts at zero)",
      proof: "sandbox .remudero/principles.yaml (or a baselines file) shows non-empty coverage/mutation/dup floors captured from the repo — paste it",
    },
  ],
});

const PRE_SWEEP_T28 = task({
  id: "PRE-SWEEP-T28",
  acceptance: [
    {
      claim: "a planted containment-weakening diff is BLOCKED",
      proof:
        "a branch moving allowedDomains from sandbox.network to the sandbox root (the WS-0 silent-drop typo) makes the containment check FAIL and the PR non-mergeable; paste the failing check + blocked state, then revert",
    },
    {
      claim: "the containment check is REQUIRED (via the aggregator) for sandbox/hooks/env/deny-floor diffs",
      proof: "the containment job is a needs: of the ci-gate aggregator and a touching-diff PR shows it ran; paste the workflow wiring",
    },
  ],
});

for (const [id, fx] of [
  ["W1-T25", PRE_SWEEP_T25],
  ["W1-T26", PRE_SWEEP_T26],
  ["W1-T27", PRE_SWEEP_T27],
  ["W1-T28", PRE_SWEEP_T28],
] as const) {
  test(`W1-T81 ACCEPTANCE 2: ${id}'s pre-sweep live proof now flags — the #146 false negative`, () => {
    const v = headlessFitnessViolations(fx);
    assert.ok(v.length > 0, `expected ${id}'s pre-sweep criteria to flag`);
    assert.match(v[0].message, /'(paste-then-revert|against-live-repo)'/);
  });
}

test("W1-T81 ACCEPTANCE 2: the named example ('goes CI-red...paste the red check, then revert') flags naming the matched phrase", () => {
  const t = task({
    id: "PRE-SWEEP-NAMED-EXAMPLE",
    acceptance: [
      {
        claim: "the coverage ratchet BLOCKS a coverage-lowering PR (live)",
        proof:
          "a PR deleting a covered test drops coverage below the recorded baseline and goes CI-red on the ratchet job; paste the red check, then revert",
      },
    ],
  });
  const v = headlessFitnessViolations(t);
  assert.equal(v.length, 1);
  assert.match(v[0].message, /'paste-then-revert'/);
});

// ── W1-T81 ACCEPTANCE 3: post-sweep fixtures stay clean; the signal set is DATA ──

test("W1-T81 ACCEPTANCE 3: the post-sweep W1-T25/26/27/28-family tasks in the REAL plan stay clean", () => {
  for (const id of ["W1-T25", "W1-T26", "W1-T27", "W1-T28"]) {
    const t = realTask(id);
    assert.equal(headlessFitnessViolations(t).length, 0, `expected ${id} to stay clean post-sweep`);
  }
});

test("W1-T81 ACCEPTANCE 3: adding a new phrase row to the patterns table flags a seeded criterion — ZERO changes to headlessFitnessViolations itself", () => {
  const extendedLexicon = [...HEADLESS_FORBIDDEN_LEXICON, { tag: "confetti-cannon", pattern: /\bfire the confetti cannon\b/i }];
  const seeded = task({
    id: "SEEDED-NEW-PHRASE",
    acceptance: [{ claim: "the launch party proof", proof: "fire the confetti cannon live on stage" }],
  });
  assert.equal(headlessFitnessViolations(seeded).length, 0, "the DEFAULT lexicon must not know this phrase yet");
  const v = headlessFitnessViolations(seeded, extendedLexicon);
  assert.equal(v.length, 1);
  assert.match(v[0].message, /'confetti-cannon'/);
});

// ── W1-T118 — a lexicon hit needs an ACTOR (the #268 false positive) ─────────
//
// SAME WORD ('killed'), opposite fitness: W1-T117's child is spawned by the
// test itself and reaped in-process (headless-performable); W1-T12d's daemon
// is a real, operator-owned process on a live session (structurally NOT
// headless-performable). The discriminator is SPAWN-OWNERSHIP, carried as an
// optional `qualifier` on the lexicon row — never a rewording of the row.

test("W1-T118 ACCEPTANCE 1a: W1-T117's criteria, verbatim from the plan (the as-filed, post-reword observable form), do not flag", () => {
  const t = realTask("W1-T117");
  assert.equal(t.acceptance!.length, 3);
  assert.equal(headlessFitnessViolations(t).length, 0);
});

test("W1-T118 ACCEPTANCE 1b: the pre-#268-reword form of W1-T117's criteria — carrying the bare past-participle of the tag under test, same spawn-ownership context as the real proofs — also does not flag", () => {
  const t = realTask("W1-T117");
  // Derived from the REAL, as-filed criteria above by reverting the observable
  // ("process.kill(childPid, 0) throws ESRCH" / "the stray's pid is ESRCH")
  // back to the bare past-participle that #268 originally flagged, while
  // leaving the SAME spawn/seed/fixture ownership language the real proofs
  // already carry untouched — this is what the filer wrote BEFORE rewording
  // around the checker.
  const preReword: Task["acceptance"] = [
    {
      claim: t.acceptance![0]!.claim,
      proof:
        "in-process test: worker fixture spawns a detached long-sleep child; after teardown on BOTH the " +
        "success and the error path, the child's process group is killed and the survivor scan returns an " +
        "empty list — asserted in-process, no operator and no real signal to a system daemon",
    },
    {
      claim: t.acceptance![1]!.claim,
      proof:
        "in-process test: seed one stray child carrying run markers plus one unrelated child without them; " +
        "after the sweep, the stray child is killed and a ledger line carries its cmdline, while the " +
        "unrelated child is still alive",
    },
  ];
  assert.ok(/\bkilled\b/i.test(preReword[0]!.proof), "sanity: the pre-reword form carries the bare past-participle");
  assert.equal(headlessFitnessViolations({ ...t, acceptance: preReword }).length, 0);
});

test("W1-T118 ACCEPTANCE 2: W1-T12d's third acceptance criterion, verbatim from the plan and evaluated AS IF verify:auto, still flags — the live-kill regression lock", () => {
  const t12d = realTask("W1-T12d");
  const criterion3 = t12d.acceptance![2]!;
  assert.match(criterion3.claim, /\bkilled\b/i, "sanity: still carries the bare past-participle verbatim");
  const asAuto: Task = { ...t12d, verify: "auto", acceptance: [criterion3] };
  const v = headlessFitnessViolations(asAuto);
  assert.equal(v.length, 1, "an operator-owned subject with no ownership signal must still flag");
  assert.match(v[0].message, /'killed'/);
  // Deletion would pass ACCEPTANCE 1 above and must NOT pass this one — the row stays.
  const killedRow = HEADLESS_FORBIDDEN_LEXICON.find((e) => e.tag === "killed");
  assert.ok(killedRow, "the 'killed' row must remain in the exported lexicon — scope as data, never delete");
});

test("W1-T118 ACCEPTANCE 3a: adding a qualifier row to the exported table flips a seeded criterion's verdict — ZERO changes to headlessFitnessViolations itself", () => {
  const seeded = task({
    id: "SEEDED-OWNERSHIP-OVERNIGHT",
    acceptance: [
      {
        claim: "the scheduler fixture runs an overnight batch entirely in-process",
        proof: "a test-spawned overnight-scheduler fixture fires every queued job synchronously; no real clock, no operator",
      },
    ],
  });
  assert.equal(
    headlessFitnessViolations(seeded).length,
    1,
    "the DEFAULT lexicon's 'overnight' row carries no qualifier yet — it must still flag",
  );
  const qualifiedLexicon = HEADLESS_FORBIDDEN_LEXICON.map((e) =>
    e.tag === "overnight" ? { ...e, qualifier: SPAWN_OWNERSHIP_CUE } : e,
  );
  const v = headlessFitnessViolations(seeded, qualifiedLexicon);
  assert.equal(v.length, 0, "the qualifier, added as pure DATA, exempts the seeded criterion with zero code edits");
});

test("W1-T118 ACCEPTANCE 3b: a seeded criterion carrying a lexicon term with NO ownership signal in either direction still flags (fail-toward-flagging)", () => {
  const seeded = task({
    id: "SEEDED-AMBIGUOUS-KILLED",
    acceptance: [{ claim: "the daemon process is killed and restarted", proof: "observe the restart" }],
  });
  const v = headlessFitnessViolations(seeded);
  assert.equal(v.length, 1, "ambiguous ownership must default to flagging, not clearing");
  assert.match(v[0].message, /'killed'/);
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

// ── PROOF-DIALECT (moratorium finding 9 — the dead proof floor, W1-T246) ─────

test("W1-T246 ACCEPTANCE 1: unit test: W1-T79 criterion-2 prose proof yields a blocking proof-dialect violation naming the criterion", () => {
  // Loaded VERBATIM from the real, still-open plan/tasks.yaml (REAL_PLAN, defined above) —
  // the EXACT incident (W1-T79 / PR #662) that motivated this check, not a synthesized fixture.
  const w1t79 = REAL_PLAN.byId.get("W1-T79");
  assert.ok(w1t79, "expected W1-T79 in the real plan");
  const criterion2 = w1t79!.acceptance![1]!;
  assert.match(criterion2.proof, /^unit tests:/, "criterion 2's proof is the 'unit tests:' near-miss prose this check exists to catch");
  const violations = proofDialectViolations(w1t79!);
  const hit = violations.find((v) => v.check === "proof-dialect" && /criterion 2/.test(v.message));
  assert.ok(hit, "expected a proof-dialect violation naming criterion 2");
  assert.equal(hit!.severity, "block");
  assert.equal(lintTask(w1t79!).ok, false);
});

test("W1-T246 ACCEPTANCE 2: unit test: a well-formed unit test: proof yields no proof-dialect violation", () => {
  const clean = task({
    id: "FIX-DIALECT-CLEAN",
    files: ["test/foo.test.ts"],
    acceptance: [{ claim: "does the thing", proof: "unit test: test/foo.test.ts" }],
  });
  assert.deepEqual(proofDialectViolations(clean), []);
  assert.equal(lintTask(clean).ok, true);

  const cleanGrep = task({
    id: "FIX-DIALECT-CLEAN-GREP",
    acceptance: [{ claim: "does the thing", proof: "grep: no callers of the old API remain in src/lib/example.ts" }],
  });
  assert.deepEqual(proofDialectViolations(cleanGrep), []);
});

test("near-miss prefixes (unit tests:/unit test over/grep: with no path) are BLOCKED with a corrective hint", () => {
  const nearMissPlural = task({
    id: "FIX-DIALECT-NEARMISS-PLURAL",
    acceptance: [{ claim: "does the thing", proof: "unit tests: dirty -> no pull" }],
  });
  const v1 = proofDialectViolations(nearMissPlural);
  assert.equal(v1.length, 1);
  assert.match(v1[0]!.message, /near-miss/i);

  const nearMissOver = task({
    id: "FIX-DIALECT-NEARMISS-OVER",
    acceptance: [{ claim: "does the thing", proof: "unit test over injected git deps: behind+clean -> ff-pull invoked" }],
  });
  const v2 = proofDialectViolations(nearMissOver);
  assert.equal(v2.length, 1);
  assert.match(v2[0]!.message, /near-miss/i);

  const grepNoPath = task({
    id: "FIX-DIALECT-GREP-NOPATH",
    acceptance: [{ claim: "does the thing", proof: "grep: no callers of the old API remain" }],
  });
  const v3 = proofDialectViolations(grepNoPath);
  assert.equal(v3.length, 1);
  assert.match(v3[0]!.message, /dialect-prefixed but refused/i);

  const freeProse = task({
    id: "FIX-DIALECT-FREE-PROSE",
    acceptance: [{ claim: "does the thing", proof: "the operator eyeballs the output and confirms it looks right" }],
  });
  const v4 = proofDialectViolations(freeProse);
  assert.equal(v4.length, 1);
  assert.match(v4[0]!.message, /free prose/i);
  for (const v of [v1[0]!, v2[0]!, v3[0]!, v4[0]!]) assert.equal(v.severity, "block");
});

test("a unit test: proof whose body reads as a runtime narrative (the W1-T79-criteria-3/4 shape): proof-dialect itself still only WARNS, but the SAME narrative — carrying no path/::-anchor — is now a proof-resolvability BLOCK (W1-T101)", () => {
  const t = task({
    id: "FIX-DIALECT-NONTITLE",
    acceptance: [{ claim: "up-to-date adds nothing", proof: "unit test: same-sha fixture -> no pull, no re-exec, no output beyond the command's own" }],
  });
  // proofDialectViolations (W1-T246) is UNCHANGED — it still only warns on this shape.
  const dialectViolations = proofDialectViolations(t);
  assert.equal(dialectViolations.length, 1);
  assert.equal(dialectViolations[0]!.severity, "warn");
  // But proofResolvabilityViolations (W1-T101) recognizes this EXACT shape — a `unit
  // test:` body with two enumerated clauses ("no pull", "no re-exec") and no path/::
  // anchor — as unresolvable, and BLOCKS it: the gap this task exists to close.
  const resolvabilityViolations = proofResolvabilityViolations(t);
  assert.equal(resolvabilityViolations.length, 1);
  assert.equal(resolvabilityViolations[0]!.check, "proof-resolvability");
  assert.equal(resolvabilityViolations[0]!.severity, "block");
  assert.equal(lintTask(t).ok, false, "the aggregate now blocks — a warn-only heuristic is no longer the last word on this shape");
});

test("W1-T246 ACCEPTANCE 3: unit test: proofDialect warn mode returns ok true with the violation surfaced, never blocking", () => {
  const t = task({
    id: "FIX-DIALECT-WARN-MODE",
    files: ["src/lib/example.ts"],
    acceptance: [{ claim: "does the thing", proof: "a prose paragraph describing what happened, not a dialect proof" }],
  });
  const blockRes = lintTask(t); // default severity is "block"
  assert.equal(blockRes.ok, false);
  assert.ok(blockRes.violations.some((v) => v.check === "proof-dialect" && v.severity === "block"));

  const warnRes = lintTask(t, { proofDialect: "warn" });
  assert.equal(warnRes.ok, true, "warn mode must never block dispatch — the legacy backlog must not brick overnight");
  assert.ok(
    warnRes.violations.some((v) => v.check === "proof-dialect" && v.severity === "warn"),
    "the violation is still surfaced, just demoted",
  );
});

test("W1-T246 ACCEPTANCE 4: grep: parseWhitelistedProof in src/lib/task-linter.ts", () => {
  // The check reuses review.ts's OWN executed-proof predicate — never a reimplementation that
  // could drift from what remudero-review actually runs (see the module's design doc).
  const src = readFileSync(fileURLToPath(new URL("../src/lib/task-linter.ts", import.meta.url)), "utf8");
  assert.match(src, /parseWhitelistedProof/);
  assert.match(src, /import\s*\{[^}]*parseWhitelistedProof[^}]*\}\s*from\s*"\.\/review\.js"/);
});

test("a satisfied_by criterion is exempt — Architect-only, never expected to be executable prose", () => {
  const t = task({
    id: "FIX-DIALECT-SATISFIED-BY",
    acceptance: [{ claim: "already shipped elsewhere", proof: "free prose, never executed", satisfied_by: "#123" }],
  });
  assert.deepEqual(proofDialectViolations(t), []);
});

// ── PROOF-RESOLVABILITY (W1-T101 — a dialect prefix is a promise) ────────────

test("ACCEPTANCE 1: the W1-T100 regression corpus — all three verbatim proofs flag, remedy text names both options", () => {
  // Loaded VERBATIM from the real, still-open plan/tasks.yaml (REAL_PLAN, defined above) —
  // the EXACT ledger incident (proof_exec [not_executable x3]) that motivated this check.
  const w1t100 = REAL_PLAN.byId.get("W1-T100");
  assert.ok(w1t100, "expected W1-T100 in the real plan");
  const [c1, c2, c3] = w1t100!.acceptance!;
  assert.match(c1!.proof, /^unit test: the seeded state/, "criterion 1 is dialect-prefixed but names no anchor");
  assert.match(c2!.proof, /^unit test: same state with strikes at cap/, "criterion 2 is dialect-prefixed but names no anchor");
  assert.match(
    c3!.proof,
    /^existing W1-T93\/W1-T77/,
    "criterion 3 carries NO dialect prefix — its violation comes from proof-dialect's existing free-prose block, not this rule",
  );

  assert.equal(lintTask(w1t100!).ok, false);

  // Criteria 1 and 2 ARE dialect-prefixed but unresolvable — THIS rule flags them.
  const resolvability = proofResolvabilityViolations(w1t100!);
  assert.equal(resolvability.length, 2, "exactly the two dialect-prefixed, anchor-less proofs — never criterion 3");
  for (const v of resolvability) {
    assert.equal(v.severity, "block");
    assert.match(v.message, /resolvable/i);
    assert.match(v.message, /name a literal test|name a pattern/i, "remedy names an artifact option");
    assert.match(v.message, /drop the/i, "remedy names the drop-the-prefix option");
  }
  assert.match(resolvability[0]!.message, /criterion 1/);
  assert.match(resolvability[1]!.message, /criterion 2/);

  // Criterion 3 carries no prefix, so THIS rule leaves it untouched — but the task's
  // aggregate lint STILL flags it, via the pre-existing (unchanged) proof-dialect
  // free-prose block, so "violation each" holds across the full three-proof corpus.
  const c3Violations = lintTask(w1t100!).violations.filter((v) => v.message.includes("criterion 3"));
  assert.ok(
    c3Violations.some((v) => v.check === "proof-dialect"),
    "criterion 3 is still caught, by the existing free-prose block",
  );
  assert.ok(
    !c3Violations.some((v) => v.check === "proof-resolvability"),
    "criterion 3 makes no dialect promise — untouched by THIS rule",
  );
});

test("ACCEPTANCE 2: a resolvable unit test: proof (path + ::test-name), a resolvable grep: proof (pattern + in <path>), and an unprefixed prose proof all pass clean", () => {
  const resolvableTest = task({
    id: "FIX-RESOLVABLE-TEST",
    acceptance: [{ claim: "routes ci-red to blocked-fixable", proof: "unit test: test/sweep.test.ts::routes ci-red to blocked-fixable" }],
  });
  assert.deepEqual(proofResolvabilityViolations(resolvableTest), []);

  const resolvableGrep = task({
    id: "FIX-RESOLVABLE-GREP",
    acceptance: [{ claim: "the wx flag is present", proof: "grep: the wx flag in src/lib/config.ts" }],
  });
  assert.deepEqual(proofResolvabilityViolations(resolvableGrep), []);

  const prose = task({
    id: "FIX-RESOLVABLE-PROSE",
    acceptance: [{ claim: "does the thing", proof: "an unprefixed prose proof, with one clause, with two clauses, with three" }],
  });
  assert.deepEqual(proofResolvabilityViolations(prose), [], "no dialect prefix -> untouched by this rule, regardless of shape");
});

test("ACCEPTANCE 3: the resolvable shapes are DATA — a seeded new payload-shape row admits a new form with zero engine changes", () => {
  const narrativeWithMarker = task({
    id: "FIX-CUSTOM-SHAPE",
    acceptance: [
      { claim: "a custom marker anchors the scenario", proof: "unit test: given state one, given state two, resolves via @custom-marker-42" },
    ],
  });
  // Under the DEFAULT shapes table this is a multi-clause narrative with no path/::
  // anchor -> blocked.
  const before = proofResolvabilityViolations(narrativeWithMarker);
  assert.equal(before.length, 1);
  assert.equal(before[0]!.severity, "block");

  // Adding ONE new data row (zero changes to proofResolvabilityViolations itself)
  // admits the new form.
  const withCustomRow = [...PROOF_PAYLOAD_SHAPES, { tag: "custom-marker", dialect: "unit test" as const, pattern: /@custom-marker-\d+/ }];
  const after = proofResolvabilityViolations(narrativeWithMarker, {}, withCustomRow);
  assert.deepEqual(after, []);
});

test("a well-formed-looking grep: proof missing its in <path> clause is ALSO a proof-resolvability violation (redundant with, not a replacement for, proof-dialect's own refusal)", () => {
  const t = task({
    id: "FIX-GREP-NO-PATH-RESOLVABILITY",
    acceptance: [{ claim: "does the thing", proof: "grep: no callers of the old API remain" }],
  });
  const v = proofResolvabilityViolations(t);
  assert.equal(v.length, 1);
  assert.equal(v[0]!.severity, "block");
  assert.match(v[0]!.message, /in <path>/);
});

test("proofResolvability warn mode returns ok true with the violation surfaced, never blocking — the SAME rollout convention as proofDialect (W1-T246)", () => {
  const t = task({
    id: "FIX-RESOLVABILITY-WARN-MODE",
    files: ["src/lib/example.ts"],
    acceptance: [{ claim: "does the thing", proof: "unit test: given state one, given state two, given state three" }],
  });
  const blockRes = lintTask(t); // default severity is "block"
  assert.equal(blockRes.ok, false);
  assert.ok(blockRes.violations.some((v) => v.check === "proof-resolvability" && v.severity === "block"));

  const warnRes = lintTask(t, { proofResolvability: "warn" });
  assert.equal(warnRes.ok, true, "warn mode must never block dispatch — the legacy backlog must not brick overnight");
  assert.ok(
    warnRes.violations.some((v) => v.check === "proof-resolvability" && v.severity === "warn"),
    "the violation is still surfaced, just demoted",
  );
});

test("a single-arrow unit test: body (this repo's idiomatic single-clause test-title shape, e.g. real titles like 'critical severity -> escalate') is NOT flagged, even without a path/::-anchor", () => {
  const t = task({
    id: "FIX-SINGLE-ARROW-OK",
    acceptance: [{ claim: "critical severity escalates", proof: "unit test: critical severity -> escalate" }],
  });
  assert.deepEqual(proofResolvabilityViolations(t), []);
});

test("a satisfied_by criterion is exempt from proof-resolvability too — Architect-only, never expected to be executable prose", () => {
  const t = task({
    id: "FIX-RESOLVABILITY-SATISFIED-BY",
    acceptance: [{ claim: "already shipped elsewhere", proof: "unit test: given one, given two, given three", satisfied_by: "#123" }],
  });
  assert.deepEqual(proofResolvabilityViolations(t), []);
});

test("proofResolvabilityViolations reuses parseWhitelistedProof's sibling dialect shape, never a check that silently drifts from the linter's own module contract", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/task-linter.ts", import.meta.url)), "utf8");
  assert.match(src, /PROOF_PAYLOAD_SHAPES/);
  assert.match(src, /export function proofResolvabilityViolations/);
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

// ── RULING-VERIFY (W1-T326 — a ruling needs an operator, not a grep) ──────────

test("ACCEPTANCE 1: files: including DECISIONS.md at verify:auto is FLAGGED (ruling-verify), naming verify:human", () => {
  const t = task({ id: "FIX-RULING-AUTO", verify: "auto", files: ["DECISIONS.md"] });
  const v = rulingVerifyViolation(t);
  assert.ok(v, "expected a ruling-verify violation");
  assert.equal(v?.severity, "block");
  assert.match(v!.message, /verify:\s*human/);
  const res = lintTask(t);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((x) => x.check === "ruling-verify"));
});

test("ACCEPTANCE 1: the IDENTICAL task at verify:human PASSES ruling-verify", () => {
  const t = task({ id: "FIX-RULING-HUMAN", verify: "human", files: ["DECISIONS.md"] });
  assert.equal(rulingVerifyViolation(t), undefined);
  assert.equal(lintTask(t).ok, true);
});

test("a mixed diff — DECISIONS.md alongside other files — still triggers at verify:auto", () => {
  const t = task({ id: "FIX-RULING-MIXED", verify: "auto", files: ["src/lib/review.ts", "DECISIONS.md"] });
  const v = rulingVerifyViolation(t);
  assert.ok(v, "a mixed diff must still trigger — that is how the entry rides in unnoticed");
});

test("ACCEPTANCE 2: an ordinary implement task with NEITHER trigger (no DECISIONS.md in files:) is untouched", () => {
  const t = task({ id: "FIX-RULING-ORDINARY", verify: "auto", files: ["src/lib/review.ts"] });
  assert.equal(rulingVerifyViolation(t), undefined);
  const res = lintTask(t);
  assert.ok(!res.violations.some((x) => x.check === "ruling-verify"));
});

test("FALSIFIER: W1-T355's own shape (files include DECISIONS.md, verify:human) PASSES — the rule accepts the first task filed under it", () => {
  const t = task({
    id: "W1-T355",
    verify: "human",
    files: ["DECISIONS.md", "plan/tasks.d/W1-T355-rerecord-feedback-rulings-into-decisions.yaml"],
  });
  assert.equal(rulingVerifyViolation(t), undefined);
  assert.equal(lintTask(t).ok, true);
});

// ── DECLARED SCOPE (W1-T504 — an undeclared files: lints clean and then serializes the fleet) ──

test("a task with no files declared is refused by the linter as a blocking violation", () => {
  const t = task({ id: "FIX-SCOPE-ABSENT", files: undefined });
  const v = declaredScopeViolation(t);
  assert.ok(v, "expected a declared-scope violation");
  assert.equal(v?.severity, "block");
  const res = lintTask(t);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((x) => x.check === "declared-scope"));
});

test("a task declaring an empty files list is refused with the same blocking check", () => {
  const t = task({ id: "FIX-SCOPE-EMPTY", files: [] });
  const v = declaredScopeViolation(t);
  assert.ok(v, "expected a declared-scope violation");
  assert.equal(v?.severity, "block");
  assert.equal(v?.check, "declared-scope");
  const res = lintTask(t);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((x) => x.check === "declared-scope"));
});

test("a task declaring at least one path passes the declared-scope check", () => {
  const t = task({ id: "FIX-SCOPE-DECLARED", files: ["src/lib/task-linter.ts"] });
  assert.equal(declaredScopeViolation(t), undefined);
  const res = lintTask(t);
  assert.ok(!res.violations.some((x) => x.check === "declared-scope"));
});

// ── RULE-15 FILING (W1-T384 — a shape the review guard can only ever refuse) ──
//
// Each test isolates ONE clause of the trigger against the SAME otherwise-identical
// record, so a pass proves the clause discriminates rather than that the check is
// simply quiet. The `files:` list is the only variable except where verify/status is
// named as the variable under test.

test("ACCEPTANCE 1: plan/tasks.yaml alongside an out-of-scope path at verify:auto is FLAGGED, and the message names the remedy", () => {
  const t = task({
    id: "FIX-RULE15-MIXED-AUTO",
    verify: "auto",
    files: ["plan/tasks.yaml", "src/run-task.ts", "test/lint-plan-open-only.test.ts"],
  });
  const v = rule15FilingViolation(t);
  assert.ok(v, "expected a rule15-filing violation on W1-T324's exact shape");
  assert.equal(v?.severity, "block");
  assert.equal(v?.check, "rule15-filing");
  // The remedy, not merely the shape — both routes must be named.
  assert.match(v!.message, /two tasks/i);
  assert.match(v!.message, /verify:\s*human/);
  // The message must name the offending path(s), so the operator does not have to re-derive them.
  assert.match(v!.message, /src\/run-task\.ts/);
  const res = lintTask(t);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((x) => x.check === "rule15-filing"));
});

test("ACCEPTANCE 1 (contrast): the IDENTICAL record at verify:human PASSES — W1-T370's shape, the route the ruling adopts", () => {
  const mixedAuto = task({
    id: "FIX-RULE15-VERIFY-VAR",
    verify: "auto",
    files: ["plan/tasks.yaml", "src/run-task.ts"],
  });
  const mixedHuman = task({ ...mixedAuto, verify: "human" });
  // POSITIVE CONTRAST: the ONLY difference is `verify`, and it flips the verdict.
  assert.ok(rule15FilingViolation(mixedAuto), "the auto side must fire, or the human side proves nothing");
  assert.equal(rule15FilingViolation(mixedHuman), undefined);
  assert.equal(lintTask(mixedHuman).ok, true);
});

test("ACCEPTANCE 2: a record declaring ONLY plan-scope paths PASSES at either verify value — the by-hand repair route is never refused", () => {
  for (const verify of ["auto", "human"] as const) {
    const t = task({
      id: `FIX-RULE15-PLANONLY-${verify}`,
      verify,
      files: ["plan/tasks.yaml", "plan/tasks.d/W1-T999-some-shard.yaml", "MASTER-PLAN.md"],
    });
    assert.equal(rule15FilingViolation(t), undefined, `plan-only must pass at verify:${verify}`);
  }
  // POSITIVE CONTRAST with the variable isolated: adding ONE out-of-scope path to the
  // verify:auto case flips it, so the pass above is about scope and not about quietness.
  const flipped = task({
    id: "FIX-RULE15-PLANONLY-FLIP",
    verify: "auto",
    files: ["plan/tasks.yaml", "plan/tasks.d/W1-T999-some-shard.yaml", "MASTER-PLAN.md", "src/lib/review.ts"],
  });
  assert.ok(rule15FilingViolation(flipped), "one out-of-scope path must flip the same record");
});

test("ACCEPTANCE 3: a record with NO plan/tasks.yaml entry is untouched however many out-of-scope paths it declares", () => {
  // The measured 17-task config-plus-reader population: plan/policy.yaml beside its reader.
  const t = task({
    id: "FIX-RULE15-CONFIG-READER",
    verify: "auto",
    files: ["plan/policy.yaml", "src/lib/policy.ts", "test/policy.test.ts", "docs/cli-reference.md"],
  });
  assert.equal(rule15FilingViolation(t), undefined);
  assert.ok(!lintTask(t).violations.some((x) => x.check === "rule15-filing"));
  // POSITIVE CONTRAST: swapping plan/policy.yaml for the literal monolith path fires.
  const swapped = task({ ...t, id: "FIX-RULE15-CONFIG-SWAP", files: ["plan/tasks.yaml", "src/lib/policy.ts"] });
  assert.ok(rule15FilingViolation(swapped), "the literal monolith path is what the trigger keys on");
});

test("ACCEPTANCE 4: a RETIRED record is excluded, so a plan-only withdrawal preserving a mixed files: is not refused by the check it earned", () => {
  const mixed = ["plan/tasks.yaml", "test/plan-proof-debt.test.ts"];
  // W1-T369's real post-withdrawal shape: the record survives, files: included.
  for (const status of ["blocked", "merged", "done"] as const) {
    const t = task({ id: `FIX-RULE15-RETIRED-${status}`, verify: "auto", status, files: mixed });
    assert.equal(rule15FilingViolation(t), undefined, `a ${status} record must be excluded`);
  }
  // POSITIVE CONTRAST: the SAME record while still open fires — so the exclusion is
  // doing the work, not the files: list.
  const open = task({ id: "FIX-RULE15-RETIRED-OPEN", verify: "auto", status: "queued", files: mixed });
  assert.ok(rule15FilingViolation(open), "the identical record at status:queued must fire");
});

test("rule15-filing is wired into lintTask and blocks — one wiring point, no second call site", () => {
  const t = task({
    id: "FIX-RULE15-WIRED",
    verify: "auto",
    files: ["plan/tasks.yaml", "src/run-task.ts"],
  });
  // Drives the PRODUCTION default: lintTask with no opts, exactly as CI's lint-plan and
  // runTask's assertLintClean call it (preDispatchLint demotes only proofResolvability).
  const res = lintTask(t);
  assert.equal(res.ok, false, "a blocking violation must flip ok=false at the aggregator's default");
  const v = res.violations.find((x) => x.check === "rule15-filing");
  assert.ok(v, "lintTask must surface the check without any opt being passed");
  assert.equal(v?.severity, "block");
});

test("W1-T384's OWN files: do not trip the rule it proposes — a rule that refuses its own filing is the self-reference failure", () => {
  const t = task({
    id: "W1-T384",
    verify: "auto",
    files: ["src/lib/task-linter.ts", "test/task-linter.test.ts"],
  });
  assert.equal(rule15FilingViolation(t), undefined);
});

test("SELF-REFERENCE: W1-T353's own ruling-shaped TITLE (word 'ruling' appears repeatedly) never trips this check — trigger A is files-only, no title trigger is implemented", () => {
  const t = task({
    id: "W1-T353",
    verify: "auto",
    files: ["src/lib/task-linter.ts", "test/task-linter.test.ts"],
    title:
      "a task whose deliverable is a RULING chose verify:auto so 'no operator need be present to judge' a " +
      "record its own note called BINDING — the task linter REFUSES a ruling-shaped task (files containing " +
      "DECISIONS.md, or a ruling-shaped title) that is not verify:human",
  });
  assert.equal(rulingVerifyViolation(t), undefined);
  assert.equal(lintTask(t).ok, true);
});

// ── BUDGET-SANITY (soft) ──────────────────────────────────────────────────────

test("budget-sanity WARNS (never blocks) when mount max_turns is below the class mean", () => {
  const t = task({ id: "FIX-BUDGET", files: ["src/lib/example.ts"] });
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
  // W1_T4_SHAPE carries the REAL, still-open W1-T4's verbatim prose proofs — a live
  // proof-dialect AND proof-resolvability offender (its criterion 3 is a `grep:`-prefixed
  // proof with no `in <path>` clause: W1-T246, then W1-T101), so this ACCEPTANCE-5 check
  // (which predates both and is about sizing/headless-fitness/proof-shape/provenance)
  // isolates the SAME way the pre-dispatch call site does for the legacy backlog. It ALSO
  // carries no files: — one of the 80 historical bare-scope records the new declared-scope
  // check (W1-T504) now legitimately blocks on, so the isolation is to THAT check alone.
  try {
    assertLintClean(W1_T4_SHAPE, { proofDialect: "warn", proofResolvability: "warn" });
    assert.fail("expected declared-scope to throw — W1_T4_SHAPE carries no files:");
  } catch (e) {
    if (!(e instanceof TaskLintError)) throw e;
    assert.deepEqual(
      e.violations.map((v) => v.check),
      ["declared-scope"],
      "sizing/proof-dialect/proof-resolvability must stay isolated — only declared-scope throws here",
    );
  }
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

// ── W1-T198: the self-reference false positive + the over-gating blast radius ──
//
// W1-T20c's own criterion 3 NAMES the live-context lexicon ('overnight/launchctl/
// killed') to SPECIFY that headless-fitness detects those words — the detector
// then matched its own specification (observed 2026-07-21, escalated as issue
// #448 naming 27 transitively-blocked dependents). Two defects compound:
//   (1) the self-reference false positive itself — CLOSED by W1-T81's
//       enumeration/quote-span exemptions (commit 9fb30bd; see "W1-T81
//       ACCEPTANCE 1c", above, which already locks this exact fixture) — and
//   (2) the BLAST RADIUS: that one violation, on a task GitHub had already
//       merged (PR #134), must never gate a task that merely DEPENDS on it —
//       a settled dispatch decision has nothing left to gate.
// These four tests lock all four of W1-T198's acceptance claims under its own
// name, so a future regression on either half is caught here even if the
// upstream W1-T81/nextRunnable fixtures it currently piggybacks on ever move.

test("W1-T198 ACCEPTANCE 1: a criterion NAMING the trigger words to SPECIFY detection is not flagged; the SAME words used as a genuine live REQUIREMENT still are — FALSIFIER: W1-T20c criterion 3, verbatim from the plan", () => {
  // The FALSIFIER, verbatim from the real plan: 'a criterion containing
  // overnight/launchctl/killed on an auto-verify task is FLAGGED' — its claim IS
  // the lexicon, enumerating the three trigger words to say the rule detects them.
  const t = realTask("W1-T20c");
  const selfDescribing = t.acceptance!.find((c) => c.claim.includes("overnight/launchctl/killed"));
  assert.ok(selfDescribing, "expected W1-T20c to still carry its self-describing criterion verbatim");
  assert.equal(
    headlessFitnessViolations({ ...t, acceptance: [selfDescribing!] }).length,
    0,
    "naming the trigger words to SPECIFY the rule must not trip the rule it specifies",
  );
  // The SAME word, used to REQUIRE a live action rather than enumerate the
  // lexicon, must still flag — an exemption wide enough to pass the
  // self-reference case must not also blunt a genuine requirement.
  const genuinelyLive = task({
    id: "W1-T198-GENUINE-LIVE",
    acceptance: [
      {
        claim: "the daemon runs overnight on the operator's machine and is manually confirmed alive at dawn",
        proof: "operator confirms via ssh the following morning",
      },
    ],
  });
  assert.equal(headlessFitnessViolations(genuinelyLive).length, 1);
});

test("W1-T198 ACCEPTANCE 2: a genuinely live-context criterion is STILL flagged, standalone — FALSIFIER: an exemption broad enough to pass W1-T20c's self-reference would also pass W1-T12's live criteria, the fixtures Rule 18 was written from", () => {
  // W1-T12's original overnight-drain (criterion 1) and live-kill (criterion 3)
  // criteria are the FIXTURES Rule 18 was written from (ACCEPTANCE 6, above) —
  // checked STANDALONE (one criterion at a time) so the self-reference fix can't
  // be hiding behind an aggregate OR across the other criteria in the task.
  assert.equal(
    headlessFitnessViolations({ ...W1_T12_ORIGINAL, acceptance: [W1_T12_ORIGINAL.acceptance![0]] }).length,
    1,
    "criterion 1 ('...unattended, overnight') must still flag alone",
  );
  assert.equal(
    headlessFitnessViolations({ ...W1_T12_ORIGINAL, acceptance: [W1_T12_ORIGINAL.acceptance![2]] }).length,
    1,
    "criterion 3 ('daemon killed mid-task...') must still flag alone",
  );
  assert.throws(() => assertLintClean(W1_T12_ORIGINAL), TaskLintError);
});

test("W1-T198 ACCEPTANCE 3: a lint violation on an ALREADY-MERGED task refuses only THAT task's own dispatch; a task that merely DEPENDS on it dispatches normally — FALSIFIER: issue #448, one W1-T20c violation naming 27 transitively-blocked dependents on a task deriveStatus resolves as MERGED via PR #134", () => {
  const illformed = task({
    id: "W1-T198-ILLFORMED-MERGED",
    acceptance: [{ claim: "daemon killed mid-task recovers state", proof: "chaos-drill transcript" }],
  });
  const dependent = task({ id: "W1-T198-DEPENDENT", depends_on: ["W1-T198-ILLFORMED-MERGED"] });
  const plan: Plan = {
    tasks: [illformed, dependent],
    byId: new Map([
      [illformed.id, illformed],
      [dependent.id, dependent],
    ]),
  };

  // THAT task's own (re-)dispatch is still refused — the fail-closed guard is
  // unweakened by this fix.
  assert.equal(lintTask(illformed).ok, false);
  assert.throws(() => assertLintClean(illformed), TaskLintError);

  // But it is ALREADY MERGED (GitHub-derived, per the fixture's `isMerged`) —
  // `nextRunnable`'s dispatch-eligibility chain excludes an already-merged task
  // BEFORE any lint check ever runs (isDispatchEligible tests `isMerged` FIRST,
  // task-linter.ts is never even consulted for a merged candidate), and
  // `unmetDependencies` is purely merge-gated — a dependency's LINT status never
  // enters a dependent's eligibility at all. So the dependent, whose only
  // dependency is (already) merged, is offered next: the queue never freezes on
  // a violation the failing task's own dispatch decision has already settled.
  const isMerged: MergedSet = (id) => id === illformed.id;
  const next = nextRunnable(plan, isMerged);
  assert.equal(
    next?.id,
    dependent.id,
    "the dependent must dispatch — a merged dependency's OWN lint failure must not gate it",
  );

  // Contrast: while genuinely UNMERGED, the SAME task is still the one offered
  // first (dependency ordering is unweakened) — its own dispatch attempt is what
  // the pre-dispatch guard above refuses, never the dependent's.
  const isMergedNone: MergedSet = () => false;
  const next2 = nextRunnable(plan, isMergedNone);
  assert.equal(
    next2?.id,
    illformed.id,
    "while genuinely unmerged, the upstream task is still offered first — dependency ordering is unweakened",
  );
});

test("W1-T198 ACCEPTANCE 4: the fail-closed pre-dispatch guard still refuses a genuinely ill-formed task that IS due for dispatch — FALSIFIER: weakening the guard would reopen the W1-T12 max_turns hole it was built to close", () => {
  assert.equal(lintTask(W1_T12_ORIGINAL).ok, false);
  assert.throws(() => assertLintClean(W1_T12_ORIGINAL), TaskLintError);
  // The behavioral (verdict=blocked_illformed, zero spawn) integration of this
  // SAME guard is locked at the dispatch call site by
  // test/task-linter-wiring.test.ts's "CRITERION 5 (behavioral)" tests — this
  // test only re-asserts the pure guard this task's files: scope owns.
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
  files: [src/lib/example.ts]
  acceptance:
    - claim: "does the thing"
      proof: "grep: no old callers remain in src/lib/example.ts"
- id: BAD
  title: broken
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  origin: architect
  files: [src/lib/example.ts]
  acceptance:
    - claim: "does the thing overnight"
      proof: "works"
`;
  const plan = loadPlanFromYaml(yaml, "fixture");
  const results = lintPlan(plan);
  assert.equal(results.get("CLEAN")?.ok, true);
  assert.equal(results.get("BAD")?.ok, false);
  const badChecks = results.get("BAD")?.violations.map((v) => v.check).sort();
  // "works" is BOTH a vibe (proof-shape) AND unparseable as any executable dialect shape
  // (proof-dialect, moratorium finding 9) — the SAME defect, seen by two different checks.
  assert.deepEqual(badChecks, ["headless-fitness", "proof-dialect", "proof-shape"]);
});

// ── POST-MERGE-AMENDMENT (W1-T180) ────────────────────────────────────────────

const W1_T155_BASE_CRITERIA = [
  { claim: "status regresses to queued on a read failure is fixed", proof: "unit test: test/status.test.ts" },
];

test("W1-T180 ACCEPTANCE 1: a plan PR that ADDS a criterion to an already-merged task FAILS the linter, naming the task and the criterion (PR #374/W1-T155 falsifier)", () => {
  const amended = task({
    id: "W1-T155",
    acceptance: [
      ...W1_T155_BASE_CRITERIA,
      { claim: "monotonic under darkness: status never regresses across an unobservable gap", proof: "unit test: test/status.test.ts::monotonic under darkness" },
    ],
  });
  const res = lintTask(amended, {
    postMergeAmendment: {
      statusResolvable: true,
      merged: true,
      baseAcceptance: W1_T155_BASE_CRITERIA,
      followUpFiled: false,
    },
  });
  assert.equal(res.ok, false);
  const v = res.violations.find((x) => x.check === "post-merge-amendment");
  assert.ok(v, "expected a post-merge-amendment violation");
  assert.equal(v?.severity, "block");
  assert.match(v!.message, /W1-T155/);
  assert.match(v!.message, /monotonic under darkness/);
});

test("W1-T180 ACCEPTANCE 1 (helper): criteriaAdded reports the gained entry vs the base ref, and NOTHING when the set is unchanged", () => {
  const current = [
    ...W1_T155_BASE_CRITERIA,
    { claim: "liveness bound: a stale in-flight trace is never reported running forever", proof: "unit test: test/status.test.ts::liveness bound" },
  ];
  const added = criteriaAdded(W1_T155_BASE_CRITERIA, current);
  assert.equal(added.length, 1);
  assert.equal(added[0].claim, "liveness bound: a stale in-flight trace is never reported running forever");
  assert.deepEqual(criteriaAdded(W1_T155_BASE_CRITERIA, W1_T155_BASE_CRITERIA), []);
});

test("W1-T180 ACCEPTANCE 1: reword/reorder-only changes (SAME set, different order/whitespace) do NOT trip it", () => {
  const reworded = [{ claim: "  status   regresses to queued on a read failure is fixed ", proof: "unit test: test/status.test.ts" }];
  assert.deepEqual(criteriaAdded(W1_T155_BASE_CRITERIA, reworded), []);
  const amended = task({ id: "W1-T155", files: ["src/lib/status.ts"], acceptance: reworded });
  const res = lintTask(amended, {
    postMergeAmendment: { statusResolvable: true, merged: true, baseAcceptance: W1_T155_BASE_CRITERIA, followUpFiled: false },
  });
  assert.equal(res.ok, true);
});

test("W1-T180 ACCEPTANCE 2: the SAME PR filing a follow-up task carrying the amended criteria PASSES — the check gates the orphaning, not the amending", () => {
  const addedCriterion = { claim: "monotonic under darkness", proof: "unit test: test/status.test.ts::monotonic under darkness" };
  // W1-T2375: the escape now also requires the parent's disposition to be stated. The parent is
  // fully superseded here, so it moves out of dispatch; the assertions below are unchanged.
  const amended = task({ id: "W1-T155", status: "blocked", files: ["src/lib/status.ts"], acceptance: [...W1_T155_BASE_CRITERIA, addedCriterion] });
  const followUp = task({ id: "W1-T179", files: ["src/lib/status.ts"], acceptance: [addedCriterion] });
  const changedSet = [amended, followUp];
  for (const t of changedSet) {
    const added = criteriaAdded(W1_T155_BASE_CRITERIA, t.acceptance ?? []);
    const followUpFiled = followUpCarriesCriteria(
      added,
      changedSet.filter((c) => c.id !== t.id),
    );
    const res = lintTask(t, {
      postMergeAmendment: {
        statusResolvable: true,
        merged: t.id === "W1-T155",
        baseAcceptance: t.id === "W1-T155" ? W1_T155_BASE_CRITERIA : undefined,
        followUpFiled,
      },
    });
    assert.equal(res.ok, true, `${t.id} must pass — the follow-up carries the amended criteria`);
  }
});

test("W1-T180 ACCEPTANCE 2 (helper): followUpCarriesCriteria is FALSE with no escape hatch, TRUE once a candidate task carries the added criterion, and vacuously TRUE for an empty added set", () => {
  const addedCriterion = { claim: "monotonic under darkness", proof: "unit test: test/status.test.ts::monotonic under darkness" };
  assert.equal(followUpCarriesCriteria([addedCriterion], []), false);
  assert.equal(followUpCarriesCriteria([addedCriterion], [task({ id: "OTHER", acceptance: [{ claim: "unrelated", proof: "unit test: test/other.test.ts" }] })]), false);
  assert.equal(followUpCarriesCriteria([addedCriterion], [task({ id: "W1-T179", acceptance: [addedCriterion] })]), true);
  assert.equal(followUpCarriesCriteria([], []), true);
});

test("W1-T180 ACCEPTANCE 4: an UNREADABLE derived status fails OPEN — a status-read failure never reds an otherwise-valid plan PR", () => {
  const amended = task({
    id: "W1-T155",
    files: ["src/lib/status.ts"],
    acceptance: [...W1_T155_BASE_CRITERIA, { claim: "a brand new criterion", proof: "unit test: test/status.test.ts::brand new" }],
  });
  const res = lintTask(amended, {
    postMergeAmendment: {
      statusResolvable: false, // the seeded status-resolution failure
      merged: true,
      baseAcceptance: W1_T155_BASE_CRITERIA,
      followUpFiled: false,
    },
  });
  assert.equal(res.ok, true, "an unreadable status must never produce a violation");
  assert.ok(!res.violations.some((v) => v.check === "post-merge-amendment"));
});

test("W1-T180: absent LintOpts.postMergeAmendment entirely is a no-op (the pre-dispatch call site, which never dispatches an already-merged task)", () => {
  const amended = task({
    id: "W1-T155",
    files: ["src/lib/status.ts"],
    acceptance: [...W1_T155_BASE_CRITERIA, { claim: "a brand new criterion", proof: "unit test: test/status.test.ts::brand new" }],
  });
  assert.deepEqual(postMergeAmendmentViolations(amended), []);
  assert.equal(lintTask(amended).ok, true);
});

test("W1-T180: an amended task whose derived status is NOT merged (still open/queued) is untouched — ordinary authoring, not a post-merge amendment", () => {
  const amended = task({
    id: "W1-T155",
    files: ["src/lib/status.ts"],
    acceptance: [...W1_T155_BASE_CRITERIA, { claim: "a brand new criterion", proof: "unit test: test/status.test.ts::brand new" }],
  });
  const res = lintTask(amended, {
    postMergeAmendment: { statusResolvable: true, merged: false, baseAcceptance: W1_T155_BASE_CRITERIA, followUpFiled: false },
  });
  assert.equal(res.ok, true);
});

test("W1-T180 ACCEPTANCE 5: the check stays PURE — task-linter.ts imports neither status.ts nor any gh/exec surface", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/task-linter.ts", import.meta.url)), "utf8");
  assert.ok(!/from ["']\.\/status\.js["']/.test(src), "must not import lib/status.ts");
  assert.ok(!/node:child_process/.test(src), "must not import an exec surface");
  // and it is reachable purely through injection: merge state supplied via LintOpts,
  // never fetched by the check itself.
  const t = task({ id: "W1-T155", acceptance: [...W1_T155_BASE_CRITERIA, { claim: "x", proof: "unit test: test/x.test.ts" }] });
  const v = postMergeAmendmentViolations(t, {
    postMergeAmendment: { statusResolvable: true, merged: true, baseAcceptance: W1_T155_BASE_CRITERIA, followUpFiled: false },
  });
  assert.equal(v.length, 1);
});

// ── POST-MERGE-AMENDMENT KEYS ON CLAIM, NOT CLAIM+PROOF (W1-T1098) ───────────

test("W1-T1098 ACCEPTANCE 1: a criterion whose claim is unchanged and whose proof is reworded is not counted as added", () => {
  // Same claim as W1_T155_BASE_CRITERIA's single entry; proof text rewritten
  // into a different (still valid) dialect string. Claim-only keying must
  // treat this as unchanged, not as a newly added criterion.
  const reworkedProof = [
    { claim: "status regresses to queued on a read failure is fixed", proof: "unit test: test/status.test.ts::regression" },
  ];
  assert.deepEqual(criteriaAdded(W1_T155_BASE_CRITERIA, reworkedProof), []);

  const amended = task({ id: "W1-T155", files: ["src/lib/status.ts"], acceptance: reworkedProof });
  const res = lintTask(amended, {
    postMergeAmendment: { statusResolvable: true, merged: true, baseAcceptance: W1_T155_BASE_CRITERIA, followUpFiled: false },
  });
  assert.equal(res.ok, true, "a proof-only reword on an already-merged task must not trip rule 21");
  assert.ok(!res.violations.some((v) => v.check === "post-merge-amendment"));
});

test("W1-T1098 ACCEPTANCE 2 (control): a criterion with a genuinely new claim on a merged task is still refused", () => {
  const genuinelyNew = [
    ...W1_T155_BASE_CRITERIA,
    { claim: "a brand new promise this task never made before", proof: "unit test: test/status.test.ts::brand new" },
  ];
  const added = criteriaAdded(W1_T155_BASE_CRITERIA, genuinelyNew);
  assert.equal(added.length, 1);
  assert.equal(added[0].claim, "a brand new promise this task never made before");

  const amended = task({ id: "W1-T155", files: ["src/lib/status.ts"], acceptance: genuinelyNew });
  const res = lintTask(amended, {
    postMergeAmendment: { statusResolvable: true, merged: true, baseAcceptance: W1_T155_BASE_CRITERIA, followUpFiled: false },
  });
  assert.equal(res.ok, false, "a genuinely new claim on a merged task must still be refused");
  const v = res.violations.find((x) => x.check === "post-merge-amendment");
  assert.ok(v);
  assert.match(v!.message, /brand new promise/);
});

test("W1-T1098 ACCEPTANCE 4: the check stays silent when the derived status cannot be resolved at all, even with a genuinely new claim", () => {
  const amended = task({
    id: "W1-T155",
    files: ["src/lib/status.ts"],
    acceptance: [...W1_T155_BASE_CRITERIA, { claim: "a genuinely new claim", proof: "unit test: test/status.test.ts::new" }],
  });
  const res = lintTask(amended, {
    postMergeAmendment: {
      statusResolvable: false, // fail OPEN: the derived status is unreadable
      merged: true,
      baseAcceptance: W1_T155_BASE_CRITERIA,
      followUpFiled: false,
    },
  });
  assert.equal(res.ok, true, "an unresolvable status must never produce a violation, claim-only keying or not");
  assert.ok(!res.violations.some((v) => v.check === "post-merge-amendment"));
});

test("W1-T1098 ACCEPTANCE 5: the follow-up escape hatch keeps working for a real (claim-level) amendment under claim-only keying", () => {
  const addedCriterion = { claim: "a brand new promise carried by the follow-up", proof: "unit test: test/status.test.ts::carried" };
  // W1-T2375: parent disposition stated (fully superseded) — assertions below unchanged.
  const amended = task({ id: "W1-T155", status: "blocked", files: ["src/lib/status.ts"], acceptance: [...W1_T155_BASE_CRITERIA, addedCriterion] });
  // The follow-up task carries the SAME claim with a DIFFERENT proof wording —
  // claim-only keying means the escape hatch still recognizes it as carried.
  const followUp = task({
    id: "W1-T179",
    files: ["src/lib/status.ts"],
    acceptance: [{ claim: addedCriterion.claim, proof: "unit test: test/status.test.ts::carried (follow-up wording)" }],
  });
  const changedSet = [amended, followUp];
  for (const t of changedSet) {
    const added = criteriaAdded(W1_T155_BASE_CRITERIA, t.acceptance ?? []);
    const followUpFiled = followUpCarriesCriteria(
      added,
      changedSet.filter((c) => c.id !== t.id),
    );
    const res = lintTask(t, {
      postMergeAmendment: {
        statusResolvable: true,
        merged: t.id === "W1-T155",
        baseAcceptance: t.id === "W1-T155" ? W1_T155_BASE_CRITERIA : undefined,
        followUpFiled,
      },
    });
    assert.equal(res.ok, true, `${t.id} must pass — the follow-up carries the amended claim even with reworded proof text`);
  }
});

test("W1-T1098 ACCEPTANCE 3: the proof-weakening case the rule no longer sees is DEMONSTRATED, not asserted from a comment", () => {
  // WHY THIS IS BEHAVIOURAL AND NOT A DOC GREP. This test used to assert that the phrase
  // "swapped for a WEAKER one" appeared in the rule's source. `assertion-discrimination`
  // (W1-T1051) correctly refused it: the literal lives ONLY in a comment, so the assertion
  // could not tell "the rule really stopped seeing this case" from "someone wrote the words
  // down". The baseline escape is unavailable here — `scripts/*-baseline.json` is an
  // INSTRUMENT_SURFACE path and adding one beside a `src/` change fails Rule 25 — and it would
  // be the wrong answer anyway. The case is shown instead.
  //
  // THE CASE: a merged task whose criterion keeps its CLAIM but has its proof swapped for a
  // strictly weaker one. Under claim+proof keying this read as a new criterion and tripped the
  // rule; under claim-only keying it is invisible, which is the deliberate blind spot the
  // rule's doc records.
  const weakened = task({
    id: "W1-T155",
    files: ["src/lib/status.ts"],
    acceptance: W1_T155_BASE_CRITERIA.map((c, i) =>
      i === 0 ? { claim: c.claim, proof: "grep: status in src/lib/status.ts" } : c,
    ),
  });
  const added = criteriaAdded(W1_T155_BASE_CRITERIA, weakened.acceptance ?? []);
  assert.deepEqual(added, [], "claim-only keying sees NO added criterion when only the proof changed");
  const res = lintTask(weakened, {
    postMergeAmendment: { statusResolvable: true, merged: true, baseAcceptance: W1_T155_BASE_CRITERIA, followUpFiled: false },
  });
  assert.equal(res.ok, true, "so a weakened proof on a merged task draws nothing — the documented blind spot, demonstrated");
  assert.ok(!res.violations.some((v) => v.check === "post-merge-amendment"));

  // PAIRED POSITIVE CONTROL: the SAME fixture with a genuinely new CLAIM still trips the rule,
  // so the silence above is claim-only keying and not a check that can no longer fire at all.
  const reallyAmended = task({
    id: "W1-T155",
    files: ["src/lib/status.ts"],
    acceptance: [...W1_T155_BASE_CRITERIA, { claim: "a genuinely new promise", proof: "unit test: test/status.test.ts::new" }],
  });
  const control = lintTask(reallyAmended, {
    postMergeAmendment: { statusResolvable: true, merged: true, baseAcceptance: W1_T155_BASE_CRITERIA, followUpFiled: false },
  });
  assert.ok(
    control.violations.some((v) => v.check === "post-merge-amendment"),
    "a new claim on a merged task still trips post-merge-amendment",
  );
});

// ── ADVISORY-ROUTING (W1-T519 — a security-shaped filing is PUBLISHED before it's fixed) ────

test("ACCEPTANCE 1 (W1-T519): security-shaped task draws an advisory-routing warn", () => {
  const t = task({
    id: "FIX-SANDBOX-ESCAPE",
    title: "a worker sandbox escape lets a compromised task read host files outside its worktree",
  });
  const vs = advisoryRoutingViolations(t);
  assert.equal(vs.length, 1, "expected exactly one advisory-routing warn");
  const v = vs[0];
  assert.equal(v.check, "advisory-routing");
  assert.equal(v.severity, "warn");
  assert.match(v.message, /sandbox\/containment escape or bypass/);
  assert.match(v.message, /private security advisory/);
  assert.match(v.message, /SECURITY\.md/);
  // exactly ONE — design point (iv) — never one per hit, one per field
  const res = lintTask(t);
  assert.equal(res.violations.filter((x) => x.check === "advisory-routing").length, 1);
});

test("ACCEPTANCE 2 (W1-T519): a routine fleet-vocabulary task (scope, route, grant, tier used benignly) draws ZERO advisory-routing warns", () => {
  const t = task({
    id: "FIX-ROUTINE-VOCAB",
    title:
      "the coverage-ratchet task widens session grant reporting within the route's declared files scope, per risk tier",
    rationale: "this task's own declared scope is one module; the grant is a duplicate-title match, not a permission",
  });
  assert.deepEqual(advisoryRoutingViolations(t), []);
  const res = lintTask(t);
  assert.equal(res.violations.filter((x) => x.check === "advisory-routing").length, 0);
});

test("ACCEPTANCE 2 (W1-T519): advisory routing warn never blocks a filing", () => {
  const t = task({
    id: "FIX-ADVISORY-NO-BLOCK",
    title: "an authentication bypass gap lets an unauthenticated route reach host secrets",
    files: ["test/foo.test.ts"],
  });
  const vs = advisoryRoutingViolations(t);
  assert.equal(vs.length, 1, "expected an advisory-routing warn");
  assert.equal(vs[0].severity, "warn");
  const res = lintTask(t);
  assert.equal(res.ok, true, "a warn-only violation must never flip lintTask.ok to false");
  const blockingCount = res.violations.filter((x) => x.severity === "block").length;
  assert.equal(blockingCount, 0);
  // EXIT-IDENTICAL, both directions (design point iv): the same otherwise-clean fixture, with
  // and without the security-shaped title, carries the identical blocking-violation count — the
  // warn changes visibility only, never dispatch eligibility.
  const withoutTrigger = task({
    id: "FIX-ADVISORY-NO-BLOCK-CONTROL",
    title: "an ordinary task title",
    files: ["test/foo.test.ts"],
  });
  assert.deepEqual(advisoryRoutingViolations(withoutTrigger), []);
  assert.equal(
    lintTask(withoutTrigger).violations.filter((x) => x.severity === "block").length,
    blockingCount,
  );
});

test("advisoryRoutingViolations matches the measured live-corpus fixture shapes: token/credential leak, route-scope-enforcement audit — and stays silent on a bare 'mutation escape' (W1-T393's own vocabulary)", () => {
  const tokenLeak = task({
    id: "FIX-TOKEN-LEAK",
    title: "a read-token leak is a confidentiality incident; a write-token leak is unbounded spend",
  });
  const tokenLeakVs = advisoryRoutingViolations(tokenLeak);
  assert.equal(tokenLeakVs.length, 1);
  assert.equal(tokenLeakVs[0].check, "advisory-routing");
  assert.match(tokenLeakVs[0].message, /token or credential leakage/);

  const routeScope = task({
    id: "FIX-ROUTE-SCOPE-AUDIT",
    title: "prove every console route's scope is enforced server-side before the console is exposed",
  });
  const routeScopeVs = advisoryRoutingViolations(routeScope);
  assert.equal(routeScopeVs.length, 1);
  assert.equal(routeScopeVs[0].check, "advisory-routing");
  assert.match(routeScopeVs[0].message, /scope enforcement on a reachable route/);

  const mutationEscape = task({
    id: "FIX-MUTATION-ESCAPE",
    title: "report lifetime mutant totals, survivors and escapes alongside the run count",
    rationale: "whether the mutation gate has EVER caught a real escape is currently unknown, not 'no'",
  });
  assert.deepEqual(advisoryRoutingViolations(mutationEscape), []);
});

test("ACCEPTANCE 3 (W1-T519): advisoryRoutingViolations lands beside the other violation families as one idiom — grep: advisoryRoutingViolations in src/lib/task-linter.ts", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/task-linter.ts", import.meta.url)), "utf8");
  assert.match(src, /export function advisoryRoutingViolations\(/);
  assert.match(src, /\.\.\.advisoryRoutingViolations\(task\)/); // wired into lintTask's aggregator,
  // spread exactly like proofShapeViolations/headlessFitnessViolations/dispatchPriorityViolations
});

test("advisory-routing carries NO severity override anywhere in LintOpts — warn-only by construction, unlike proofDialect/proofResolvability", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/task-linter.ts", import.meta.url)), "utf8");
  const fnStart = src.indexOf("export function advisoryRoutingViolations(");
  assert.ok(fnStart >= 0);
  const fnSrc = src.slice(fnStart, src.indexOf("\n}", fnStart));
  assert.ok(!fnSrc.includes("opts"), "advisoryRoutingViolations must take no LintOpts parameter at all");
  assert.ok(!/advisoryRouting\?:\s*LintSeverity/.test(src), "LintOpts must carry no advisoryRouting severity knob");
});

// ── W1-T180's escape, tightened to its own doc (2026-08-26) ─────────────────────────────────
//
// `followUpCarriesCriteria` read `some`/`some` — at least ONE added criterion carried by at least
// one candidate task — while its doc has always said "every criterion in `added`". The doc is the
// one that serves W1-T180's purpose ("so the criteria have a home that will actually be
// dispatched"): one carried criterion gives the other four no home, and a PR could add five
// criteria to a MERGED task, carry one, and pass — orphaning four through Rule 21's own escape.
//
// RETROFIT, measured before the change over 823 plan commits: 93 criteria amendments, 4 with a new
// task in the same PR, 34 adding more than one, exactly 1 both — and that one (#396, W1-T136 +2
// beside a new W1-T176) is carried by NEITHER, so it fails both readings. Tightening refuses
// nothing that has ever happened.

test("W1-T180: a MULTI-criterion amendment carried by only ONE follow-up criterion is REFUSED", () => {
  const added = [
    { claim: "the first amended claim", proof: "unit test: a" },
    { claim: "the second amended claim", proof: "unit test: b" },
  ];
  const followUp = { id: "W1-T900", acceptance: [{ claim: "the first amended claim", proof: "unit test: z" }] } as unknown as Task;
  assert.equal(followUpCarriesCriteria(added, [followUp]), false, "one of two carried is not a home for both");
  // THE OLD READING, stated rather than described, so the change is visible and not merely asserted.
  const addedKeys = new Set(added.map((c) => c.claim.trim().replace(/\s+/g, " ")));
  const oldReading = [followUp].some((t) => (t.acceptance ?? []).some((c) => addedKeys.has(c.claim.trim().replace(/\s+/g, " "))));
  assert.equal(oldReading, true, "and the shipped code PERMITTED it until this change");
});

test("W1-T180: a multi-criterion amendment is PERMITTED when every added criterion has a home", () => {
  const added = [
    { claim: "the first amended claim", proof: "unit test: a" },
    { claim: "the second amended claim", proof: "unit test: b" },
  ];
  // Across SEVERAL follow-ups, since the caller passes every new task in the changed set.
  const f1 = { id: "W1-T900", acceptance: [{ claim: "the first amended claim", proof: "unit test: z" }] } as unknown as Task;
  const f2 = { id: "W1-T901", acceptance: [{ claim: "the second amended claim", proof: "unit test: y" }] } as unknown as Task;
  assert.equal(followUpCarriesCriteria(added, [f1, f2]), true, "a filer can satisfy this — one follow-up per criterion, or one carrying all");
  const both = { id: "W1-T902", acceptance: added.map((c) => ({ ...c, proof: "unit test: q" })) } as unknown as Task;
  assert.equal(followUpCarriesCriteria(added, [both]), true, "or a single follow-up carrying every one");
});

test("W1-T180 REGRESSION LOCK: the single-criterion case W1-T2327 just used still passes", () => {
  const added = [{ claim: "a job left non-terminal inside a run whose conclusion is terminal is reported as stalled rather than pending", proof: "unit test: x" }];
  const followUp = {
    id: "W1-T2340",
    // Proof wording deliberately different — the key is the normalised CLAIM only.
    acceptance: [{ claim: "a job left non-terminal inside a run whose conclusion is terminal is reported as stalled rather than pending", proof: "unit test: terminal-run" }],
  } as unknown as Task;
  assert.equal(followUpCarriesCriteria(added, [followUp]), true);
});

test("W1-T180: whitespace normalisation still decides the match, and an empty `added` is still vacuously true", () => {
  const added = [{ claim: "a   claim   with    runs of space", proof: "unit test: a" }];
  const followUp = { id: "W1-T903", acceptance: [{ claim: "a claim with runs of space", proof: "unit test: b" }] } as unknown as Task;
  assert.equal(followUpCarriesCriteria(added, [followUp]), true, "criterionKey collapses whitespace");
  assert.equal(followUpCarriesCriteria([], []), true, "nothing to carry");
  assert.equal(followUpCarriesCriteria(added, []), false, "no candidate tasks at all is never a home");
});
