import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { judgeCriterion, parseReviewerVerdicts } from "#src/lib/review.js";
import { requiredSemanticRefusal } from "#src/lib/required-semantic-review.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const refusal = (text: string, count: number) => requiredSemanticRefusal({ required: true, planOnly: false,
  outcome: "success", criteriaCount: count, verdicts: parseReviewerVerdicts(text, count) });

test("a complete semantic PASS is observed but cannot certify a failing mechanical proof", () => {
  const semantic = parseReviewerVerdicts("REVIEW_VERDICT 1: PASS", 1);
  assert.deepEqual(semantic, [true], "an observed PASS and a missing verdict are different evidence");
  assert.equal(refusal("REVIEW_VERDICT 1: PASS", 1), undefined, "the real required-completion consumer accepts the observed line");
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}semantic-pass-presence-`));
  try {
    writeFileSync(join(root, "marker.txt"), "the expected marker is absent\n");
    const verdict = judgeCriterion({ claim: "the marker exists", proof: "grep: REQUIRED_MARKER in marker.txt" },
      new Set(["marker", "exists"]), semantic[0], { cwd: root, exec: () => "fail" });
    assert.equal(verdict.proof_exec, "executed_fail");
    assert.equal(verdict.met, false, "an affirmative semantic observation never rescues the mechanical floor");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing malformed partial and out-of-range reviewer output remains incomplete", () => {
  for (const text of ["", "the code looks good", "REVIEW_VERDICT 3: PASS", "REVIEW_VERDICT 1: MAYBE",
    "REVIEW_VERDICT 1: PASS", "REVIEW_VERDICT 1: PASS\nREVIEW_VERDICT 1: PASS"]) {
    assert.equal(refusal(text, 2), "required-semantic-incomplete-verdicts", text);
  }
  assert.deepEqual(parseReviewerVerdicts("unparseable", 2), [undefined, undefined]);
});

test("an observed semantic FAIL remains a downgrade even after a later PASS", () => {
  for (const text of ["REVIEW_VERDICT 1: FAIL\nREVIEW_VERDICT 1: PASS",
    "REVIEW_VERDICT 1: PASS\nREVIEW_VERDICT 1: FAIL"]) {
    assert.deepEqual(parseReviewerVerdicts(text, 1), [false], "PASS must not erase a witnessed FAIL");
    assert.equal(refusal(text, 1), undefined, "complete means evaluated, not approved");
  }
});
