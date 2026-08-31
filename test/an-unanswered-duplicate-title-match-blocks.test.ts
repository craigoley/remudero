// W1-T2486: the ratification comment at src/lib/inbox.ts's "THE DUPLICATE CHECK AT THE
// RATIFICATION SEAM" gave THREE reasons `duplicateTitleViolations` cannot stop a redundant
// filing. The third — "`lint-plan` is not a required check" — is FALSE: ci-gate.yml's REQUIRED
// list has named `lint-plan` since ci-gate started aggregating it. The two other reasons (warn
// severity never reaches `lintPlanCommand`'s `blocking` array; the corpus is scoped to the
// `--base` pass, `{}` for the whole-plan one) are real and stay. Meanwhile the plan carries
// W1-T403/W1-T1062 — byte-identical titles AND files:, both queued, neither citing the other —
// which is exactly the escape that comment describes and the advisory-only check cannot close.
//
// This file exercises the two-part remedy: (1) the corrected comment, and (2) the NEW narrow
// blocking arm, `unansweredDuplicateTitleViolations` (task-linter.ts) — BLOCK, not a promotion
// of the whole check, firing only on an UNANSWERED near-certain match (score >=
// NEAR_IDENTITY_DUPLICATE_CUTOFF, well above the warn-only check's DEFAULT_DUPLICATE_CUTOFF) with
// neither shard citing the other via plan_refs or rationale. Either shard's citation clears it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  citesTaskId,
  duplicateTitleViolations,
  lintTask,
  NEAR_IDENTITY_DUPLICATE_CUTOFF,
  unansweredDuplicateTitleViolations,
  type DuplicateAnswerCorpusEntry,
  type LintOpts,
} from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";
import { duplicateCorpusOpts } from "../src/run-task.js";

/** A minimal, otherwise-clean Task fixture — mirrors test/knowledge-dedup.test.ts's own helper. */
function task(over: Partial<Task> & { id: string; title: string }): Task {
  return {
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "does the thing", proof: "unit test: test/foo.test.ts" }],
    files: ["src/lib/example.ts"],
    ...over,
  };
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────

/** The W1-T403/W1-T1062 falsifier shape: one long, distinctive title, reused byte-for-byte for
 *  both shards — scores a perfect 1.00, well above NEAR_IDENTITY_DUPLICATE_CUTOFF. */
const FALSIFIER_TITLE =
  "rmd can only ever target repos under its OWN GitHub owner — `resolveOwnerRepo()` parses the " +
  "owner from this checkout's origin and 28 call sites across 27 commands each re-derive it " +
  "independently, so the single hard limit on running N containers against N codebases is 27 " +
  "per-verb decisions rather than one edit";

/** A LEGITIMATE sibling pair (same arc, distinct work) that STILL scores above the near-identity
 *  cutoff (0.913, measured below) — proving the exemption, not the score gap, is what spares a
 *  real sibling. Below NEAR_IDENTITY_DUPLICATE_CUTOFF is covered by a separate, lower-scoring
 *  pair (SIBLING_LOW_A/B) so criterion 5 and criterion 8 each test a genuinely different band. */
const SIBLING_HIGH_A =
  "the citation-loop worker records which learnings a task actually cited during its run so the " +
  "retro sweep can grade recall against the corpus without re-deriving it from scratch every " +
  "single cycle";
const SIBLING_HIGH_B =
  "the citation-loop worker records which learnings a task actually cited during its run so the " +
  "retro sweep can grade recall against the corpus without re-deriving it from scratch every " +
  "single pass";

/** A MERELY similar pair (the W1-T369/T370 shape) — scores 0.8, above the warn-only check's
 *  DEFAULT_DUPLICATE_CUTOFF but BELOW NEAR_IDENTITY_DUPLICATE_CUTOFF. Must stay advisory-only. */
const SIBLING_LOW_A = "the citation-loop worker records which learnings a task actually cited during its run";
const SIBLING_LOW_B = "the citation-loop worker records which learnings a task actually cited during its retro";

test("SANITY: the fixtures score where this suite depends on them scoring", () => {
  const falsifier = unansweredDuplicateTitleViolations(task({ id: "x", title: FALSIFIER_TITLE }), {
    openTaskRecords: [{ id: "y", text: FALSIFIER_TITLE }],
  });
  assert.ok(falsifier.length, "falsifier pair must clear the near-identity cutoff to exercise this suite");

  const high = unansweredDuplicateTitleViolations(task({ id: "x", title: SIBLING_HIGH_A }), {
    openTaskRecords: [{ id: "y", text: SIBLING_HIGH_B }],
  });
  assert.ok(high.length, "the high sibling pair must ALSO clear the near-identity cutoff (criterion 8's premise)");

  const low = unansweredDuplicateTitleViolations(task({ id: "x", title: SIBLING_LOW_A }), {
    openTaskRecords: [{ id: "y", text: SIBLING_LOW_B }],
  });
  assert.equal(low.length, 0, "the low sibling pair must sit BELOW the near-identity cutoff (criterion 5's premise)");
  assert.ok(
    duplicateTitleViolations(task({ id: "x", title: SIBLING_LOW_A }), { openTaskTitles: [{ id: "y", text: SIBLING_LOW_B }] })
      .length,
    "and must still clear the WARN-only check's own (lower) cutoff, so it is advisory rather than silent",
  );
});

// ── criterion 1: the ratification comment no longer asserts lint-plan is unrequired ────────────

// WHY THE SURVIVING REASONS ARE ASSERTED AGAINST MECHANISM AND NOT AGAINST THE COMMENT. The first
// draft of this test greped src/lib/inbox.ts for the prose of each reason ("severity is `warn`",
// "if (blocking.length)", "scoped to the `--base` pass and returns `{}` for the") — and every one
// of those literals exists in that file ONLY inside the comment this task rewrote, so
// `assertion-discrimination` refused them by name: "satisfiable by a COMMENT ALONE ... the
// assertion cannot tell 'the mechanism is real' from 'someone wrote the word down'". It was right.
// Each claim below now names the thing the comment is ABOUT: ci-gate.yml's own required list, the
// two severities the two checks really return, the file where `if (blocking.length)` is executable
// code rather than quoted prose, and `duplicateCorpusOpts`'s real empty-object return.
test("CRITERION 1: inbox.ts's ratification comment no longer asserts lint-plan is not required, and each surviving reason holds against the mechanism it describes", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/inbox.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(
    src,
    /and `lint-plan` is not a required check\. So `rmd approve`/,
    "the old, false third reason must be gone verbatim",
  );

  // THE CORRECTION, CHECKED AGAINST THE DATA IT CORRECTS. ci-gate.yml's REQUIRED array is YAML
  // data, not a comment, so this cannot be satisfied by anyone merely writing the sentence down.
  const ciGate = readFileSync(fileURLToPath(new URL("../.github/workflows/ci-gate.yml", import.meta.url)), "utf8");
  assert.match(
    ciGate,
    /^\s*"lint-plan",\s*$/m,
    "lint-plan must really be an entry in ci-gate.yml's REQUIRED list — the fact the old comment denied",
  );

  // SURVIVING REASON 1 — the warn/block split is real, not asserted. The advisory check returns
  // `warn` and this task's new arm returns `block`; that difference IS why the old check could
  // never stop a redundant filing.
  const advisory = duplicateTitleViolations(task({ id: "x", title: SIBLING_LOW_A }), {
    openTaskTitles: [{ id: "y", text: SIBLING_LOW_B }],
  });
  assert.equal(advisory[0]?.severity, "warn", "the pre-existing duplicate-title check really is advisory");
  const blocking = unansweredDuplicateTitleViolations(task({ id: "W1-T403", title: FALSIFIER_TITLE }), {
    openTaskRecords: [{ id: "W1-T1062", text: FALSIFIER_TITLE }],
  });
  assert.equal(blocking[0]?.severity, "block", "and the new arm really blocks — the whole point of the remedy");

  // SURVIVING REASON 2 — `if (blocking.length)` is EXECUTABLE code in run-task.ts. The same literal
  // in inbox.ts is quoted prose, which is what made the original assertion undiscriminating.
  const runTask = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
  assert.match(
    runTask,
    /if \(blocking\.length\)/,
    "lintPlanCommand's exit code must still be gated on the BLOCKING array, which a warn never joins",
  );

  // SURVIVING REASON 3 — the whole-plan pass really receives an empty opts object, so the duplicate
  // corpus is scoped to `--base`. This is `duplicateCorpusOpts`'s own return, not a sentence about it.
  const corpus = [{ id: "W1-T1062", text: FALSIFIER_TITLE }];
  assert.deepEqual(duplicateCorpusOpts(false, "W1-T403", corpus, undefined), {}, "unscoped ⇒ nothing");
  assert.ok(
    duplicateCorpusOpts(true, "W1-T403", corpus, undefined).openTaskTitles?.length,
    "scoped ⇒ the corpus really is handed over, so the empty object above is a decision and not an accident",
  );
});

// ── criterion 2: an unanswered near-certain match is refused ───────────────────────────────────

test("CRITERION 2: a near-identical pair where neither shard cites the other is refused", () => {
  const t403 = task({ id: "W1-T403", title: FALSIFIER_TITLE });
  const corpus: DuplicateAnswerCorpusEntry[] = [{ id: "W1-T1062", text: FALSIFIER_TITLE }];
  const v = unansweredDuplicateTitleViolations(t403, { openTaskRecords: corpus });
  assert.equal(v.length, 1);
  assert.equal(v[0].check, "duplicate-title");
  assert.equal(v[0].severity, "block");
  assert.match(v[0].message, /W1-T1062/);
  assert.match(v[0].message, /1\.00/);
});

// ── criterion 3: citing the sibling in plan_refs, from EITHER side, clears it ──────────────────

test("CRITERION 3: the pair passes once either shard names the other in plan_refs", () => {
  const t403 = task({ id: "W1-T403", title: FALSIFIER_TITLE });

  const thisCites = unansweredDuplicateTitleViolations(t403, {
    openTaskRecords: [{ id: "W1-T1062", text: FALSIFIER_TITLE }],
    taskPlanRefs: ["W1-T1062"],
  });
  assert.deepEqual(thisCites, [], "THIS shard citing the match in ITS OWN plan_refs clears it");

  const otherCites = unansweredDuplicateTitleViolations(t403, {
    openTaskRecords: [{ id: "W1-T1062", text: FALSIFIER_TITLE, planRefs: ["W1-T403"] }],
  });
  assert.deepEqual(otherCites, [], "the MATCHED shard citing this task back in ITS plan_refs clears it too");
});

// ── criterion 4: a stated difference in the rationale, from EITHER side, clears it ─────────────

test("CRITERION 4: the pair passes once either rationale says why it differs", () => {
  const t403 = task({
    id: "W1-T403",
    title: FALSIFIER_TITLE,
    rationale: "This differs from W1-T1062 because it is scoped to the dispatch path only.",
  });

  const thisRationale = unansweredDuplicateTitleViolations(t403, {
    openTaskRecords: [{ id: "W1-T1062", text: FALSIFIER_TITLE }],
  });
  assert.deepEqual(thisRationale, [], "THIS shard's own rationale naming the match clears it");

  const noRationale = task({ id: "W1-T403", title: FALSIFIER_TITLE });
  const otherRationale = unansweredDuplicateTitleViolations(noRationale, {
    openTaskRecords: [
      { id: "W1-T1062", text: FALSIFIER_TITLE, rationale: "This re-files W1-T403, which was credited without being built." },
    ],
  });
  assert.deepEqual(otherRationale, [], "the MATCHED shard's rationale naming this task back clears it too");
});

test("citesTaskId is delimiter-bounded — W1-T25 never matches a mention of W1-T250", () => {
  assert.equal(citesTaskId(undefined, "see W1-T250 for background", "W1-T25"), false);
  assert.equal(citesTaskId(undefined, "see W1-T25 for background", "W1-T25"), true);
  assert.equal(citesTaskId(["W1-T250"], undefined, "W1-T25"), false, "plan_refs membership is exact-string too");
});

// ── criterion 5: a merely-similar sibling below the near-identity score stays advisory ─────────

test("CRITERION 5: a merely-similar sibling below the near-identity score stays advisory, not blocked", () => {
  const candidate = task({ id: "W1-T900", title: SIBLING_LOW_A });
  const opts: LintOpts = { openTaskRecords: [{ id: "W1-T901", text: SIBLING_LOW_B }] };
  assert.deepEqual(unansweredDuplicateTitleViolations(candidate, opts), [], "below near-identity cutoff, the new arm is silent");

  const warnOpts: LintOpts = { openTaskTitles: [{ id: "W1-T901", text: SIBLING_LOW_B }] };
  const warned = duplicateTitleViolations(candidate, warnOpts);
  assert.equal(warned.length, 1, "the ORIGINAL warn-only check still fires — advisory, not silence");
  assert.equal(warned[0].severity, "warn");
});

// ── criterion 6: the refusal reaches lint-plan's exit code, not just a printed warning ──────────

test("CRITERION 6: the refusal is BLOCK severity, so it lands in lintPlanCommand's blocking filter", () => {
  const t403 = task({ id: "W1-T403", title: FALSIFIER_TITLE });
  const opts: LintOpts = { openTaskRecords: [{ id: "W1-T1062", text: FALSIFIER_TITLE }] };

  const result = lintTask(t403, opts);
  assert.equal(result.ok, false, "lintTask's own ok := every(v => v.severity !== 'block') must flip false");
  const blocking = result.violations.filter((v) => v.severity === "block");
  assert.ok(
    blocking.some((v) => v.check === "duplicate-title"),
    "run-task.ts's lintPlanCommand computes `blocking = violations.filter(v => v.severity === 'block')` " +
      "and only fails when blocking.length — this is exactly that predicate",
  );
});

// ── criterion 7: narrowing files: or deleting a proof does not clear the refusal ───────────────

test("CRITERION 7: answering by narrowing files or deleting a proof does not clear the refusal", () => {
  const opts: LintOpts = { openTaskRecords: [{ id: "W1-T1062", text: FALSIFIER_TITLE }] };
  const narrowedFiles = task({ id: "W1-T403", title: FALSIFIER_TITLE, files: [] });
  const deletedProof = task({ id: "W1-T403", title: FALSIFIER_TITLE, acceptance: [] });

  for (const t of [narrowedFiles, deletedProof]) {
    const v = unansweredDuplicateTitleViolations(t, opts);
    assert.equal(v.length, 1, "removing files:/acceptance is not a citation and must not clear the block");
    assert.equal(v[0].severity, "block");
  }
});

// ── criterion 8: removing the citation exemption makes a legitimate sibling pair fail ──────────

test("CRITERION 8: without the citation exemption, a legitimate near-identical sibling pair also fails", () => {
  // SIBLING_HIGH_A/B is a LEGITIMATE, distinct sibling pair (same arc, different word at the
  // tail) that nonetheless clears NEAR_IDENTITY_DUPLICATE_CUTOFF (see the SANITY test above).
  // Absent any citation on either side — i.e. with the citation exemption this task adds
  // (criteria 3 & 4) not exercised — the block still fires: the exemption, not the score gap
  // alone, is the only thing that can save a real sibling from this arm, so it is load-bearing
  // rather than decorative.
  const sibling = task({ id: "W1-T900", title: SIBLING_HIGH_A });
  const opts: LintOpts = { openTaskRecords: [{ id: "W1-T901", text: SIBLING_HIGH_B }] };
  const v = unansweredDuplicateTitleViolations(sibling, opts);
  assert.equal(v.length, 1, "an uncited legitimate sibling above the near-identity cutoff still blocks");
  assert.equal(v[0].severity, "block");

  // Restoring EITHER side's citation (the mechanism criteria 3/4 exercise) is what actually
  // saves it — proving the exemption, not a coincidence, is what would ordinarily clear this.
  const cited = unansweredDuplicateTitleViolations(sibling, { ...opts, taskPlanRefs: ["W1-T901"] });
  assert.deepEqual(cited, [], "the SAME pair clears once the citation exemption is actually exercised");
});

// ── absent-corpus contract, mirroring duplicateTitleViolations' own ────────────────────────────

test("unansweredDuplicateTitleViolations is silent absent opts.openTaskRecords — no corpus, no opinion", () => {
  const t403 = task({ id: "W1-T403", title: FALSIFIER_TITLE });
  assert.deepEqual(unansweredDuplicateTitleViolations(t403, {}), []);
  assert.deepEqual(unansweredDuplicateTitleViolations(t403, { openTaskRecords: [] }), []);
});

test("NEAR_IDENTITY_DUPLICATE_CUTOFF sits well above the warn-only check's DEFAULT_DUPLICATE_CUTOFF", () => {
  assert.ok(NEAR_IDENTITY_DUPLICATE_CUTOFF >= 0.9);
});
