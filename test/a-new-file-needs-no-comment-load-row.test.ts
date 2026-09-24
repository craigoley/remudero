// W1-T4431 -- AN ABSENT ROW ALREADY MEANS THE DEFAULT BUCKET.
//
// scripts/comment-load-ratchet.mjs's own `evaluateCommentLoadRatchet` never refused a new file --
// it measures, records the file's bucket, and moves on (see that function's own doc). The refusal
// this task targets lived one layer up, in test/comment-load-ratchet.test.ts's own CENSUS test:
// "the shipped baseline covers every measured file, and no other" -- which requires a row for
// EVERY measured file, with no exemption for a file sitting exactly at the default bucket
// (CEILING_BUCKET_COMMENTS, 250). MEASURED 2026-09-24 on #6922 and #6925: a brand-new file needed a
// row whose value WAS the default -- information an absent row already carries, so the row was pure
// merge-conflict surface (scripts/comment-load-baseline.json is touched by 17 of the last 150
// merged PRs).
//
// This suite pins the REPLACEMENT rule -- "a row is required only above the default, and a row AT
// the default is refused as redundant" -- against the two new pure predicates
// scripts/comment-load-ratchet.mjs exports for it: `baselineRowRequired` and
// `isRedundantBaselineRow`, composed here as `evaluateBaselineCensus`.
//
// scripts/**` sits outside tsconfig's `include`, so this loads the module dynamically, exactly as
// test/comment-load-ratchet.test.ts already does -- the real module, no shadow copy.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "comment-load-ratchet.mjs");

const { baselineRowRequired, isRedundantBaselineRow, evaluateBaselineCensus, CEILING_BUCKET_COMMENTS } =
  (await import(pathToFileURL(SCRIPT).href)) as {
    baselineRowRequired: (comments: number) => boolean;
    isRedundantBaselineRow: (recorded: number) => boolean;
    evaluateBaselineCensus: (
      current: Record<string, number>,
      baseline: Record<string, number>,
    ) => { missing: string[]; redundant: string[]; ok: boolean };
    CEILING_BUCKET_COMMENTS: number;
  };

test("W1-T4431: a new file under the default bucket needs no baseline row", () => {
  // The falsifier this task names: a new file with a SINGLE comment line, absent from the
  // baseline entirely -- exactly the shape #6922 and #6925 were refused over.
  const current = { "src/brand-new.ts": 1 };
  const baseline = {};

  // THE OLD RULE, restated as the falsifier itself: "require a row for every measured file" fails
  // this fixture immediately -- there is no row for "src/brand-new.ts".
  const everyMeasuredFileHasARow = Object.keys(current).every((path) => baseline[path] !== undefined);
  assert.equal(everyMeasuredFileHasARow, false, "the old rule refuses this fixture -- that is the bug");

  // THE REPLACEMENT RULE does not: a rowless file under the default bucket is not "missing".
  assert.equal(baselineRowRequired(1), false, "one comment line sits nowhere near the default bucket");
  const verdict = evaluateBaselineCensus(current, baseline);
  assert.deepEqual(verdict.missing, [], "no row is required -- absent already means the default bucket");
  assert.deepEqual(verdict.redundant, []);
  assert.equal(verdict.ok, true);

  // The boundary itself: exactly at the default bucket still needs no row: `ceilingForComments`
  // rounds a file of exactly CEILING_BUCKET_COMMENTS comments up to itself, not past it.
  assert.equal(baselineRowRequired(CEILING_BUCKET_COMMENTS), false);
  // One comment line over the default bucket crosses into the next bucket, and DOES need a row --
  // this is design (i)'s other half: a rowless file is held to the default, not to anything above.
  assert.equal(baselineRowRequired(CEILING_BUCKET_COMMENTS + 1), true);
  const overDefault = evaluateBaselineCensus({ "src/big.ts": CEILING_BUCKET_COMMENTS + 1 }, {});
  assert.deepEqual(overDefault.missing, ["src/big.ts"]);
  assert.equal(overDefault.ok, false);
});

test("W1-T4431: a row equal to the default is refused as redundant", () => {
  assert.equal(isRedundantBaselineRow(CEILING_BUCKET_COMMENTS), true);
  // A row above the default carries information an absent row would not, so it is not redundant.
  assert.equal(isRedundantBaselineRow(CEILING_BUCKET_COMMENTS * 2), false);

  const baseline = { "src/at-default.ts": CEILING_BUCKET_COMMENTS, "src/above.ts": CEILING_BUCKET_COMMENTS * 2 };
  const current = { "src/at-default.ts": 12, "src/above.ts": 400 };
  const verdict = evaluateBaselineCensus(current, baseline);
  assert.deepEqual(verdict.redundant, ["src/at-default.ts"], "only the row AT the default is flagged");
  assert.deepEqual(verdict.missing, []);
  assert.equal(verdict.ok, false, "a redundant row is still a census failure -- it wants removing");

  // `_comment` is prose the baseline carries for whoever opens it, not a path -- never flagged even
  // when its own value would coincidentally equal the default bucket.
  const withProse = evaluateBaselineCensus({}, { _comment: CEILING_BUCKET_COMMENTS });
  assert.deepEqual(withProse.redundant, []);
});
