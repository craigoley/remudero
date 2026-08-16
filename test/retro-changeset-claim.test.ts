/**
 * W1-T911 — THE PURE RECONCILER (`reconcileRetroChangesetClaim`, lib/plan-pr-emitter.ts).
 *
 * The retro's PR body is written by the Architect worker BEFORE the harness commits
 * `docs/ORIENTATION.md` and `plan/plan-index.json` into the same PR — so a body that was TRUE
 * the instant it was written ("touches exactly one file") is FALSE by the time
 * `bodyContradictsDiff` reads it, and no wording the Architect could have chosen fixes that (it
 * cannot know what the harness appends after it returns). W1-T908 shipped a repair for one of
 * the two shapes `bodyContradictsDiff` actually keys on — the count-shaped claim (arm (a)). This
 * task adds the other — a `no <path>` denial for a path the diff DOES carry (arm (b)), the shape
 * that tripped PR #1943 by writing "No docs/ORIENTATION.md" while carrying it — and relocates
 * the fold into `lib/plan-pr-emitter.ts`, the module that already owns every other plan-PR body
 * primitive plus one of the two regenerations that cause this in the first place.
 *
 * These tests drive the PURE fold directly (no `gh`, no PR, no network) and, for the
 * falsifiers, the REAL `bodyContradictsDiff` — the gate that refused all four real instances —
 * over this function's output, rather than a local restatement of what "contradicts" means. The
 * IO seam that calls this fold (`repairRetroChangesetClaim`, run-task.ts) keeps its own coverage
 * in test/retro-acceptance-repair.test.ts; this file is scoped to the fold itself, per
 * CLAUDE.md's coverage rule that a load-bearing test must not share a file that can crash at
 * file level.
 *
 * TEST TITLES carry the literal `W1-T533:` prefix from the task's own acceptance criteria
 * (plan/tasks.d/W1-T911-the-retro-body-outlives-its-own-truth.yaml), BYTE-IDENTICAL to what
 * `proof:` names — Standing rule 15 forbids editing a `claim:`/`proof:` field outside a
 * plan-only diff, and `verify:auto` resolves a `unit test:` proof by a literal substring search
 * against test titles, so renaming the prefix here would silently break the very proof this
 * file exists to satisfy. (The renumbering W1-T533 -> W1-T911 is recorded in the task's own
 * `note:`; a later, genuinely plan-only task should renumber `claim:`/`proof:` and these titles
 * together.)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileRetroChangesetClaim } from "../src/lib/plan-pr-emitter.js";
import { bodyContradictsDiff } from "../src/lib/review.js";

const RETRO_PATHS = ["MASTER-PLAN.md", "docs/ORIENTATION.md", "plan/plan-index.json"];

/** What the Architect actually writes today (quoted, in shape, from #974's merged body) plus the
 *  arm-(b) denial that tripped #1943: a truthful "no src/, no test/" alongside a FALSE "no
 *  docs/ORIENTATION.md" — the diff DOES carry that path. */
const TEMPLATED_BODY = [
  "This is a retro sync touching exactly one file: MASTER-PLAN.md.",
  "No src/, no test/, no docs/ORIENTATION.md.",
  "",
  "Acceptance:",
  "- the shipped log is updated | grep: SHIPPED in MASTER-PLAN.md",
  "",
].join("\n");

test("W1-T533: the reconciled body names every path the run wrote and no others", () => {
  const reconciled = reconcileRetroChangesetClaim(TEMPLATED_BODY, RETRO_PATHS);
  assert.ok(reconciled !== undefined, "a contradicted body must be rewritten");

  // EVERY path the run actually wrote is named.
  for (const p of RETRO_PATHS) assert.ok(reconciled!.includes(p), `the reconciled body must name ${p}`);
  // AND NO OTHERS — the falsifier for "just list something plausible".
  for (const absent of ["src/run-task.ts", "plan/tasks.yaml", "DECISIONS.md"]) {
    assert.ok(!reconciled!.includes(absent), `${absent} was not changed and must not be named`);
  }
  // The false denial is gone, not merely joined by a true statement beside it.
  assert.ok(!/no\s+docs\/ORIENTATION\.md/i.test(reconciled!), "the false 'no docs/ORIENTATION.md' denial must be dropped");
  // The count claim is gone too — arm (a), still repaired.
  assert.ok(!/exactly\s+\w+\s+files?/i.test(reconciled!), "the count claim must be gone, not merely joined");
});

test("W1-T533: the pre-change body is contradicted by the real diff and the reconciled one is not", () => {
  // THE FALSIFIER, run first: the pre-change template really is refused by the real gate — both
  // the count-shaped claim (arm (a)) AND the false denial (arm (b)) fire on it.
  const before = bodyContradictsDiff(TEMPLATED_BODY, RETRO_PATHS);
  assert.ok(before.length > 0, "the pre-change template must contradict the real three-file diff");
  assert.ok(
    before.some((c) => /exactly/i.test(c.claim)),
    "the count-shaped claim must be one of the contradictions",
  );
  assert.ok(
    before.some((c) => /no\s+docs\/ORIENTATION\.md/i.test(c.claim)),
    "the false 'no docs/ORIENTATION.md' denial must be one of the contradictions",
  );

  const reconciled = reconcileRetroChangesetClaim(TEMPLATED_BODY, RETRO_PATHS);
  assert.ok(reconciled !== undefined);

  // And the repaired body satisfies the SAME detector — not a local restatement of it.
  const after = bodyContradictsDiff(reconciled!, RETRO_PATHS);
  assert.deepEqual(after, [], "the reconciled body must not contradict its own diff");
});

test("W1-T533: a run writing a different number of files is reconciled just as well", () => {
  // A HARDCODED THREE IS THE SAME DEFECT WEARING A NEW NUMBER. If a future retro stops
  // regenerating the index, or gains a fourth artefact, the reconciler must still be correct
  // with nobody editing a number.
  for (const paths of [
    ["MASTER-PLAN.md"],
    ["MASTER-PLAN.md", "docs/ORIENTATION.md"],
    [...RETRO_PATHS, "plan/tasks.d/W1-T1.yaml"],
  ]) {
    const reconciled = reconcileRetroChangesetClaim(TEMPLATED_BODY, paths);
    assert.ok(reconciled !== undefined, `arity ${paths.length} must still repair`);
    for (const p of paths) assert.ok(reconciled!.includes(p), `arity ${paths.length} must name ${p}`);
    assert.ok(!/exactly\s+\w+\s+files?/i.test(reconciled!), `arity ${paths.length} must carry no count`);
    // And the sentence must not have acquired a count of its own in words either.
    assert.ok(
      !/\b(one|two|three|four|1|2|3|4)\s+files?\b/i.test(reconciled!),
      `arity ${paths.length} names paths, not a tally`,
    );
    // The real gate agrees for every arity, not just three.
    assert.deepEqual(bodyContradictsDiff(reconciled!, paths), [], `arity ${paths.length} must satisfy the real gate`);
  }
});

test("W1-T533: a body that already agrees is left alone rather than rewritten", () => {
  // No count claim, no "no <path>" denial at all — nothing for either arm to touch.
  const healthyBody = "Acceptance:\n- a claim | grep: needle in src/x.ts\n";
  assert.equal(reconcileRetroChangesetClaim(healthyBody, RETRO_PATHS), undefined, "a body with nothing to repair is never rewritten");

  // A denial the diff does NOT refute is TRUE and must survive untouched — design (iv): only a
  // denial the diff actually contradicts may ever be dropped.
  const truthfulDenial = "This retro touches MASTER-PLAN.md, docs/ORIENTATION.md and plan/plan-index.json. No src/, no test/.\n";
  assert.equal(
    reconcileRetroChangesetClaim(truthfulDenial, RETRO_PATHS),
    undefined,
    "a truthful 'no src/, no test/' denial must survive untouched, not be rewritten",
  );
  assert.deepEqual(bodyContradictsDiff(truthfulDenial, RETRO_PATHS), [], "and it never contradicted the real gate to begin with");
});
