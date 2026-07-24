import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertLintClean,
  budgetSanityWarning,
  changedTaskIds,
  HEADLESS_FORBIDDEN_LEXICON,
  headlessFitnessViolations,
  lintPlan,
  lintTask,
  moduleIdFromPath,
  proofDialectViolations,
  proofShapeViolations,
  provenanceViolation,
  sizingViolation,
  subsystemsOf,
  TaskLintError,
} from "../src/lib/task-linter.js";
import { loadPlan, loadPlanFromYaml, type Task } from "../src/lib/plan.js";

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
  // W1_T4_SHAPE is the REAL, still-open W1-T4's verbatim prose proofs (a live dead-proof-floor
  // offender, per W1-T246's own census) — proofDialect:"warn" isolates THIS test to what it is
  // actually about (sizing), matching how the pre-dispatch call site treats the legacy backlog.
  const res = lintTask(W1_T4_SHAPE, { proofDialect: "warn" });
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
  assert.match(t.acceptance![0].proof, /\bNO real overnight run\b/);
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

test("a unit test: proof whose body reads as a runtime narrative (the W1-T79-criteria-3/4 shape) WARNS but does not block", () => {
  const t = task({
    id: "FIX-DIALECT-NONTITLE",
    acceptance: [{ claim: "up-to-date adds nothing", proof: "unit test: same-sha fixture -> no pull, no re-exec, no output beyond the command's own" }],
  });
  const violations = proofDialectViolations(t);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.severity, "warn");
  assert.equal(lintTask(t).ok, true, "a warn must never block, regardless of opts.proofDialect");
});

test("W1-T246 ACCEPTANCE 3: unit test: proofDialect warn mode returns ok true with the violation surfaced, never blocking", () => {
  const t = task({
    id: "FIX-DIALECT-WARN-MODE",
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
  // W1_T4_SHAPE carries the REAL, still-open W1-T4's verbatim prose proofs — a live
  // proof-dialect offender (W1-T246), so this ACCEPTANCE-5 check (which predates W1-T246 and
  // is about sizing/headless-fitness/proof-shape/provenance, not proof-dialect) isolates the
  // SAME way the pre-dispatch call site does for the legacy backlog: proofDialect:"warn".
  assert.doesNotThrow(() => assertLintClean(W1_T4_SHAPE, { proofDialect: "warn" }));
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
      proof: "grep: no old callers remain in src/lib/example.ts"
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
  // "works" is BOTH a vibe (proof-shape) AND unparseable as any executable dialect shape
  // (proof-dialect, moratorium finding 9) — the SAME defect, seen by two different checks.
  assert.deepEqual(badChecks, ["headless-fitness", "proof-dialect", "proof-shape"]);
});
