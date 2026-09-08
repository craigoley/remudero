/**
 * W1-T3190. W1-T3098 copies the diff's ADDED `test/**` files into the base worktree so a
 * `unit test:` proof can genuinely be re-run at the merge-base. Its pathspec comment says "only
 * files a `unit test:` proof could ever name are ever copied" — but a `grep:` proof names a
 * `test/` path too, and `grep: MUTANT in test/<the new suite>.test.ts` is this repo's own idiom
 * for a falsifier criterion (75 such proofs name a `test/` path).
 *
 * Such a proof then greps the copy put there for someone else, `classifyBaseProofOutcome` returns
 * `stale`, and the review reports "proof also matches the PR's merge-base … positive override
 * withdrawn, keyword floor applied" about a file the base never had. A forward reference — the
 * STRONGEST discrimination a proof can carry — was graded as the weakest.
 *
 * Neither the executor nor the classifier was at fault: both are correct given their inputs. The
 * base TREE is wrong, so the fix tells the classifier which paths are copies rather than content.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { preexistingProofHits, parseWhitelistedProof } from "../src/lib/review.js";

const ADDED = "test/a-brand-new-suite.test.ts";
const PREEXISTING = "test/an-already-shipped-suite.test.ts";

function grepProof(path: string) {
  const p = parseWhitelistedProof(`grep: MUTANT in ${path}`);
  assert.ok(p, "fixture proof must parse");
  return p;
}

/** Stands in for the base tree: every grep "passes", exactly as it does against a copied-in file. */
const alwaysPasses = () => "pass" as const;

test("a grep proof naming a file this diff ADDS is not a base hit — the copy is not base content", () => {
  // Control first: with no added-file set the old reading stands, so the test is only meaningful
  // because the second call differs by that argument alone.
  assert.equal(
    preexistingProofHits(grepProof(ADDED), alwaysPasses, "/base", undefined, true),
    true,
    "control: without the set, a passing base grep still reads as a pre-existing hit",
  );
  assert.equal(
    preexistingProofHits(grepProof(ADDED), alwaysPasses, "/base", undefined, true, new Set([ADDED])),
    false,
    "the path did not exist at the merge-base, so no text there could have matched",
  );
});

test("still-stale: a grep naming a test file that ALREADY existed at the base still degrades", () => {
  // The fix must narrow nothing. A proof whose target is genuinely present at the merge-base and
  // matches there is non-discriminating exactly as before, even while a sibling file was copied in.
  assert.equal(
    preexistingProofHits(grepProof(PREEXISTING), alwaysPasses, "/base", undefined, true, new Set([ADDED])),
    true,
    "only the COPIED paths are excused; every other grep keeps its staleness check",
  );
});

test("a base run that does not pass is still not a hit, added-file set or not", () => {
  const fails = () => "fail" as const;
  for (const added of [undefined, new Set([ADDED])]) {
    assert.equal(preexistingProofHits(grepProof(ADDED), fails, "/base", undefined, true, added), false);
    assert.equal(preexistingProofHits(grepProof(PREEXISTING), fails, "/base", undefined, true, added), false);
  }
});

test("an unreadable base blob still outranks the added-file short-circuit — it fails closed", () => {
  // `base_unreadable` means we never asked; that is not the same as knowing the path is a copy,
  // and it must keep its own grading rather than being silently converted into a discrimination.
  assert.equal(
    preexistingProofHits(grepProof(ADDED), alwaysPasses, "/base", new Set([ADDED]), true, new Set([ADDED])),
    false,
    "unreadable is not a hit either, so the caller still withdraws the positive override",
  );
});

test("a unit test: proof on a copied-in file keeps its real base run — W1-T3098 is not narrowed", () => {
  // The copy exists so this proof CAN be re-run at base. If it passes there it is genuinely
  // stale, and the short-circuit must not claim otherwise.
  const unit = parseWhitelistedProof(`unit test: ${ADDED}`);
  assert.ok(unit);
  assert.equal(
    preexistingProofHits(unit, alwaysPasses, "/base", undefined, true, new Set([ADDED])),
    true,
    "a unit test that passes at the merge-base is stale however new its file is",
  );
});

test("MUTANT: dropping the added-file argument reproduces the mis-grade the fix exists to stop", () => {
  const withFix = preexistingProofHits(grepProof(ADDED), alwaysPasses, "/base", undefined, true, new Set([ADDED]));
  const withoutFix = preexistingProofHits(grepProof(ADDED), alwaysPasses, "/base", undefined, true);
  assert.equal(withFix, false);
  assert.equal(withoutFix, true);
  assert.notEqual(withFix, withoutFix, "the argument is what moves the verdict; the rest is unchanged");
});
