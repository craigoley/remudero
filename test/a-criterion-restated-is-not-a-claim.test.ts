// test/a-criterion-restated-is-not-a-claim.test.ts — W1-T3142.
//
// MEASURED on origin/main, driving the shipped `bodyContradictsDiff` over a diff of
// `[.github/workflows/ci.yml, test/x.test.ts]`:
//
//   1 contradiction   "a plan-only diff still classifies as PLAN_ONLY when commits land on the base"
//                       ^ W1-T3060 acceptance criterion 2, VERBATIM from the merged shard
//   1 contradiction   "This PR is plan-only."                    <- CONTROL: a false claim
//   0                 the same criterion, backtick-quoted
//   0                 "Fixes the diff base. Touches the workflow and one test."
//
// THE CRITERION AND THE LIE WERE INDISTINGUISHABLE. #4577 had to OMIT its Acceptance block to be
// reviewed — on a task whose criteria the gate then resolved from the shard anyway. The same words
// sit harmlessly in #4484's merged body, because THAT diff was plan-scoped and the violator set came
// back empty; the wording never changed, only the diff did.
//
// THE PRINCIPLE IS ALREADY IN review.ts AND THIS IS ITS THIRD APPLICATION, not a new mechanism:
// W1-T308 blanked blockquotes and fenced blocks ("a quotation is not an assertion"), W1-T2534
// extended it to inline spans, W1-T2549 made it the one predicate every arm shares. The acceptance
// block is a restatement of the shard's text, so it is blanked by the same function — for CLAIM
// SCANNING ONLY. `parseAcceptanceBlock` still reads it, or a body would land "no acceptance criteria
// to judge (fail closed)" on a PR whose checks are all green.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptanceBlockDiagnostics,
  acceptanceBlockRegion,
  bodyContradictsDiff,
  parseAcceptanceBlock,
} from "../src/lib/review.js";

/** A diff that is emphatically NOT plan-scoped, so a genuine `plan-only` claim over it contradicts. */
const SOURCE_DIFF = [".github/workflows/ci.yml", "test/x.test.ts"];

/** W1-T3060's acceptance criterion 2, verbatim from the merged shard. */
const MERGED_CRITERION =
  "a plan-only diff still classifies as PLAN_ONLY when unrelated commits have landed on the base, so the fast lane skips diff-coverage as designed";

const withBlock = (criterion: string, prose = "Fixes the diff base.") =>
  `${prose}\n\n## Acceptance\n\n- claim: ${criterion}\n  proof: unit test: test/x.test.ts\n`;

test("W1-T3142 criterion 1: a criterion restated inside the Acceptance block is not read as the body's own scope claim", () => {
  const body = withBlock(MERGED_CRITERION);

  // The positive control FIRST, so a clean result below means the detector was awake: the identical
  // sentence in prose, over the identical diff, still contradicts.
  assert.equal(
    bodyContradictsDiff(`Fixes the diff base. ${MERGED_CRITERION}\n`, SOURCE_DIFF).length,
    1,
    "control: in prose this sentence MUST still be refused, or this test proves nothing",
  );

  assert.deepEqual(
    bodyContradictsDiff(body, SOURCE_DIFF),
    [],
    "a PR must be able to state what it must achieve in the words its own shard already uses",
  );
});

test("W1-T3142 criterion 2: the same sentence in ordinary body prose is still refused — the exemption is the REGION, never the wording", () => {
  // Prose BEFORE the block.
  assert.equal(bodyContradictsDiff(withBlock(MERGED_CRITERION, "This PR is plan-only."), SOURCE_DIFF).length, 1);
  // Prose AFTER the block has ended — the end boundary doing its job.
  assert.equal(
    bodyContradictsDiff(`${withBlock(MERGED_CRITERION)}\nThis PR is plan-only.\n`, SOURCE_DIFF).length,
    1,
    "the block ends where its parser says it ends; everything after it is the author speaking again",
  );
});

test("W1-T3142 criterion 3: one shared walk — the region and the diagnostics agree on every body, rather than drifting", () => {
  const bodies: Array<[string, string]> = [
    ["no header", "Just prose, no block at all.\n"],
    ["header, no bullets", "## Acceptance\n\nnothing yet\n"],
    ["header then bullets", withBlock(MERGED_CRITERION)],
    ["blank lines tolerated before the first bullet", "## Acceptance\n\n\n- claim: a\n  proof: unit test: test/x.test.ts\n"],
    ["block then a later section", `${withBlock(MERGED_CRITERION)}\n## Validation\n\n- something else\n`],
    ["numbered bullets", "## Acceptance\n\n1. claim: a\n   proof: unit test: test/x.test.ts\n"],
  ];
  for (const [label, body] of bodies) {
    const region = acceptanceBlockRegion(body);
    const diag = acceptanceBlockDiagnostics(body);
    assert.equal(region !== undefined, diag.headerFound, `${label}: header agreement`);
    assert.equal(region?.bulletsWritten ?? 0, diag.bulletsWritten, `${label}: bullet agreement`);
    if (region) {
      assert.ok(region.endLine > region.headerLine, `${label}: the region must be non-empty and forward`);
      assert.ok(region.endLine <= body.split("\n").length, `${label}: and must not run past the body`);
    }
  }
});

test("W1-T3142 criterion 4: a body carrying no acceptance header scans exactly as it does today", () => {
  const body = "This PR is plan-only.\n\nNo acceptance section anywhere in this body.\n";
  assert.equal(acceptanceBlockRegion(body), undefined, "no header, no region — nothing is blanked");
  assert.equal(
    bodyContradictsDiff(body, SOURCE_DIFF).length,
    1,
    "and the false claim is refused exactly as before this change",
  );
});

test("W1-T3142 criterion 5: criteria PARSING is unaffected — the block is blanked for claim scanning only", () => {
  const body = withBlock(MERGED_CRITERION);
  const parsed = parseAcceptanceBlock(body);

  assert.equal(parsed.length, 1, "the criterion must still parse, or the review lands 'nothing to judge (fail closed)'");
  assert.equal(parsed[0].claim, MERGED_CRITERION, "verbatim — the blanking must not reach the parser");
  assert.equal(parsed[0].proof, "unit test: test/x.test.ts");

  const diag = acceptanceBlockDiagnostics(body);
  assert.equal(diag.headerFound, true);
  assert.equal(diag.criteriaParsed, 1);
  assert.equal(diag.emptyProofs, 0);
  assert.equal(diag.defective, false);
});

test("W1-T3142: a fenced block opened INSIDE the acceptance region still toggles, so the fence arms are not shadowed", () => {
  // The blanking is checked AFTER the fence arms deliberately. If it ran first, a fence opened
  // inside the block would never toggle and the REMAINDER of the body would stop being blanked —
  // silently turning off W1-T308's protection for everything below.
  const body = ["## Acceptance", "", "- claim: a", "  proof: unit test: test/x.test.ts", "```", "This PR is plan-only.", "```", ""].join("\n");
  assert.deepEqual(bodyContradictsDiff(body, SOURCE_DIFF), [], "the fenced claim is quoted content either way");
});

test("W1-T3142: the guarantee is intact — a genuine false claim over a source diff is still refused in every unquoted position", () => {
  for (const body of [
    "This PR is plan-only.",
    "Plan-only: yes",
    "These changes are plan-only.",
    "## Acceptance\n\n- claim: a\n  proof: unit test: test/x.test.ts\n\nThis PR is plan-only.",
  ]) {
    assert.ok(bodyContradictsDiff(body, SOURCE_DIFF).length > 0, `must still refuse: ${JSON.stringify(body)}`);
  }
});

test("W1-T3142: a plan-scoped diff is unaffected either way, which is why this never showed up until an implementing PR quoted a criterion", () => {
  // #4484 carried this exact criterion and merged clean, because its violator set was empty. The
  // words only became fatal on the PR that implemented the task.
  const planDiff = ["plan/tasks.d/W1-T3060-x.yaml", "MASTER-PLAN.md"];
  assert.deepEqual(bodyContradictsDiff(withBlock(MERGED_CRITERION), planDiff), []);
  assert.deepEqual(bodyContradictsDiff(`Fixes it. ${MERGED_CRITERION}`, planDiff), []);
});
