/**
 * W1-T2692 — the Rule-15 refusal named no remedy, and the reason was not that nobody wrote one.
 *
 * ⚠ THE MESSAGE WAS NOT INCOMPLETE. IT WAS TRUNCATED. `failSummary`'s tampering branch rendered at
 * 145 characters, and the commit-status API caps a description at 140 (`description.slice(0, 140)`
 * in this file's own `postCommitStatus`). GitHub therefore showed
 * `… Standing rule 15 (a worker may n` — cut mid-word. Appending a remedy to that string would have
 * been sliced off exactly as the rule's own text was, which is the same defect stated twice.
 *
 * So the status line says the one thing that fits — the PR SHAPE to change — and the full remedy
 * rides `checkSatisfiedByGuard`'s advisory `reason`, which has no cap.
 *
 * THE REMEDY HAS TWO HALVES, MEASURED. Telling an author only to SPLIT the filing converts one
 * refusal into another: #3626, #3631, #3636 and #3669 each split correctly and were refused anyway,
 * because a filing PR's proofs name a test the implementation has not written yet, grade
 * `not_yet_built`, and leave the keyword floor to judge the body against each proof's own text.
 * #3669 scored 2 of 5 proof keywords against MIN_COVERAGE 0.6 and all seven criteria read UNMET on a
 * shard nothing was wrong with. The floor was right in every case; the author needed the second
 * sentence.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkSatisfiedByGuard, failSummary } from "../src/lib/review.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The commit-status cap this file's own poster applies — read from source, never re-declared. */
const STATUS_DESCRIPTION_CAP = 140;

/** A diff that ADDS a criterion — what a legitimate filing and a real tamper both look like. */
const ADDS_A_CRITERION = [
  "diff --git a/plan/tasks.d/W1-T1.yaml b/plan/tasks.d/W1-T1.yaml",
  "--- a/plan/tasks.d/W1-T1.yaml",
  "+++ b/plan/tasks.d/W1-T1.yaml",
  "@@ -1,2 +1,4 @@",
  '+    - claim: "a new criterion"',
  '+      proof: "unit test: test/new.test.ts"',
].join("\n");

// ── the truncation, which is the actual defect ────────────────────────────────────────────────

test("the tampering status line survives the 140-char commit-status cap whole", () => {
  const summary = failSummary([], false, false, true);
  assert.ok(
    summary.length <= STATUS_DESCRIPTION_CAP,
    `the status description is sliced at ${STATUS_DESCRIPTION_CAP}; this renders at ${summary.length}: ${summary}`,
  );
  assert.equal(summary.slice(0, STATUS_DESCRIPTION_CAP), summary, "so nothing is lost to the slice");
});

test("the cap this test asserts against is the one the poster really applies", () => {
  // The control for the test above: a hard-coded 140 here would keep passing if the poster's own
  // cap moved, so the number is read back out of the shipped source.
  const src = readFileSync(join(REPO_ROOT, "src", "lib", "review.ts"), "utf8");
  assert.match(
    src,
    new RegExp(`description=\\$\\{opts\\.description\\.slice\\(0, ${STATUS_DESCRIPTION_CAP}\\)\\}`),
    "postCommitStatus must still slice the description at the cap this suite pins",
  );
});

test("the status line names the remedy rather than trailing off mid-rule", () => {
  const summary = failSummary([], false, false, true);
  assert.match(summary, /plan-only PR/, "it must say what to DO");
  assert.doesNotMatch(summary, /a worker may n$/, "and must not end mid-word, which is how it read before");
});

// ── the full remedy, on the surface that has room for it ──────────────────────────────────────

test("the advisory reason carries BOTH halves of the remedy — split the filing, then substantiate each proof", () => {
  const result = checkSatisfiedByGuard(ADDS_A_CRITERION, { planOnly: false });
  assert.equal(result.pass, false, "control: this diff really is refused, so there is a reason to read");
  assert.match(result.reason ?? "", /plan-only PR/, "half one: the PR shape to change");
  assert.match(
    result.reason ?? "",
    /NAMING the proof that will carry it/,
    "half two: what the filing PR must then claim — the half that four PRs needed and did not get",
  );
  assert.match(result.reason ?? "", /keyword floor/, "and names the mechanism that judges them");
});

test("both refusal directions carry the remedy — a run branch and a non-plan-only PR alike", () => {
  for (const planOnly of [true, false]) {
    const result = checkSatisfiedByGuard(ADDS_A_CRITERION, { planOnly });
    assert.equal(result.pass, false);
    assert.match(result.reason ?? "", /REMEDY:/, `planOnly=${planOnly} must still name the remedy`);
  }
});

test("the guard still PASSES a plan-only human-authored filing — the carve-out is untouched", () => {
  // The precision falsifier: a remedy is worthless if the refusal it explains started firing on
  // work that was always legitimate.
  const result = checkSatisfiedByGuard(ADDS_A_CRITERION, { planOnly: true, humanAuthored: true });
  assert.equal(result.pass, true);
  assert.doesNotMatch(result.reason ?? "", /REMEDY:/, "a passing check names no remedy");
});

test("a diff that touches no criterion still passes and is unchanged by this task", () => {
  const noCriterion = [
    "diff --git a/src/lib/x.ts b/src/lib/x.ts",
    "--- a/src/lib/x.ts",
    "+++ b/src/lib/x.ts",
    "@@ -1 +1,2 @@",
    "+const x = 1;",
  ].join("\n");
  const result = checkSatisfiedByGuard(noCriterion, { planOnly: false });
  assert.equal(result.pass, true);
});

// ── the description, and the set of diffs that fail ───────────────────────────────────────────

test("the refusal DESCRIBES the shape rather than asserting the author edited its own criteria", () => {
  // Criterion 1. A filing bundled with a build is byte-indistinguishable from a tamper to this
  // predicate — `criterionFieldTampered`'s own doc says `planOnly` is the whole discriminator — so
  // the summary must state the observable fact (a criterion changed beside non-plan files) rather
  // than an intent it cannot know. #3615 was 35/35 green and had edited nothing.
  const summary = failSummary([], false, false, true);
  assert.match(summary, /added\/edited beside non-plan files/, "it states what was observed");
  assert.doesNotMatch(summary, /worker editing its own criteria/, "the status line asserts no intent");
});

test("a genuine edit to an existing criterion still reads accurately in the advisory reason", () => {
  // Criterion 3. The wording fix must not cost the real case its accurate description.
  const edited = [
    "diff --git a/plan/tasks.d/W1-T1.yaml b/plan/tasks.d/W1-T1.yaml",
    "--- a/plan/tasks.d/W1-T1.yaml",
    "+++ b/plan/tasks.d/W1-T1.yaml",
    "@@ -1,2 +1,2 @@",
    '-      proof: "unit test: test/old.test.ts"',
    '+      proof: "unit test: test/new.test.ts"',
  ].join("\n");
  const result = checkSatisfiedByGuard(edited, { planOnly: true });
  assert.equal(result.pass, false);
  assert.match(result.reason ?? "", /added\/edited/, "the reason still names the edit accurately");
  assert.match(result.reason ?? "", /Standing rule 15/, "and still cites the rule by its canonical name");
});

test("the SET of diffs that fail is unchanged — the wording fix narrows nothing", () => {
  // Criterion 4, the load-bearing one: a friendlier message is worthless if it also quietly stopped
  // refusing something. Every combination's verdict is asserted, not just the new one.
  const cases: [string, { planOnly?: boolean; humanAuthored?: boolean }, boolean][] = [
    ["adds a criterion, not plan-only", { planOnly: false }, false],
    ["adds a criterion, plan-only run branch", { planOnly: true }, false],
    ["adds a criterion, plan-only + human", { planOnly: true, humanAuthored: true }, true],
    ["adds a criterion, no meta at all", {}, false],
  ];
  for (const [label, meta, expectedPass] of cases) {
    assert.equal(checkSatisfiedByGuard(ADDS_A_CRITERION, meta).pass, expectedPass, label);
  }
});
