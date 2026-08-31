import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CHANGED_FILES_HEADING,
  buildPlanPrBody,
  changedFilesBlockDrift,
  hasChangedFilesBlock,
  renderAcceptanceBlock,
  renderChangedFilesBlock,
} from "../src/lib/plan-pr-emitter.js";
import { bodyContradictsDiff, parseAcceptanceBlock } from "../src/lib/review.js";

/**
 * W1-T2535 — every "exactly N files" or scope sentence in a PR body is `git diff --name-only`
 * restated by hand, and it goes stale the moment anything is added to the diff.
 *
 * MEASURED 2026-08-31, the same claim failing for all three kinds of author in one day: fleet
 * workers (#3365, #3378), a careful hand-edit (a seven-PR batch), and #3388 — whose entire subject
 * is this detector, refused by it. Prose discipline is not the fix; CLAUDE.md already carried the
 * rule as forcefully as prose can and it did not hold.
 */

const FILES = ["src/lib/sweep.ts", "test/sweep-conflicted-disposition.test.ts", "scripts/source-size-baseline.json"];

test("W1-T2535 criterion 1: a rendered block lists exactly the diff's files, in a stable order", () => {
  const block = renderChangedFilesBlock(["b.ts", "a.ts", "c.ts"]);
  assert.match(block, /^## Changed files\n\n/);
  assert.deepEqual(
    block.split("\n").filter((l) => l.startsWith("- ")),
    ["- `a.ts`", "- `b.ts`", "- `c.ts`"],
    "sorted, so the same diff always renders the same bytes",
  );
  // Order-independence is the point: the caller's ordering cannot change the output.
  assert.equal(renderChangedFilesBlock(["c.ts", "a.ts", "b.ts"]), block);
  // AND IT EMITS NO COUNT. A count is a second assertion about the same list, and the list is
  // already countable — writing both is exactly how the two drift.
  assert.doesNotMatch(block, /\b3\b|three|exactly/i, "the paths ARE the claim; a count would be a second one");
});

test("W1-T2535 criterion 2: a body carrying the rendered block is not refused for the diff it was rendered from", () => {
  // THE LOAD-BEARING ONE. Structurally unfalsifiable rather than merely well-tested: the block IS
  // the diff, so there is no claim left to contradict.
  const body = buildPlanPrBody({
    intro: "Some prose about the change.",
    criteria: [{ claim: "it works", proof: "unit test: test/x.test.ts" }],
    changedFiles: FILES,
  });
  assert.deepEqual(
    bodyContradictsDiff(body, FILES),
    [],
    "a generated block must never contradict its own diff — it IS the diff",
  );

  // POSITIVE CONTROL, so this is not a vacuous pass. The HAND-WRITTEN form of the same claim,
  // against the same diff, is exactly what the detector refuses — and is what shipped on #3365,
  // #3378 and #3388.
  const handWritten = [
    "Some prose about the change.",
    "",
    "This changeset is exactly 2 files.",
    "",
    "Acceptance:",
    "- it works | unit test: test/x.test.ts",
    "",
  ].join("\n");
  assert.ok(
    bodyContradictsDiff(handWritten, FILES).length > 0,
    "the control must FIRE — if a hand-written stale count passes, this test proves nothing",
  );
});

test("W1-T2535 criterion 3: a block left behind by a later commit is DETECTABLE, both directions", () => {
  const body = buildPlanPrBody({
    intro: "prose",
    criteria: [{ claim: "c", proof: "unit test: test/x.test.ts" }],
    changedFiles: ["src/a.ts", "test/a.test.ts"],
  });
  // the exact shape that bit #3365/#3378: a later commit adds the size baseline
  const drift = changedFilesBlockDrift(body, ["src/a.ts", "test/a.test.ts", "scripts/source-size-baseline.json"]);
  assert.deepEqual(drift.missing, ["scripts/source-size-baseline.json"], "names WHICH file is unlisted — that is the remedy");
  assert.deepEqual(drift.extra, []);
  // and the other direction: a hand-edit claiming a file the diff does not carry
  const hand = changedFilesBlockDrift(body, ["src/a.ts"]);
  assert.deepEqual(hand.extra, ["test/a.test.ts"]);
  assert.deepEqual(hand.missing, []);
  // a block that still matches drifts in neither direction
  assert.deepEqual(changedFilesBlockDrift(body, ["test/a.test.ts", "src/a.ts"]), { missing: [], extra: [] });
});

test("W1-T2535 criterion 4: an empty diff renders a block that SAYS so, never an empty section", () => {
  // An empty section reads as an omission — a reader cannot tell "nothing changed" from "the
  // author forgot", and neither can a reviewer.
  const block = renderChangedFilesBlock([]);
  assert.match(block, /\(none —/);
  assert.doesNotMatch(block, /^- /m, "no bullets at all, so nothing can be mistaken for a path");
  assert.equal(hasChangedFilesBlock(block), true, "still a block, so its absence stays distinguishable");
});

test("W1-T2535 criterion 5: the acceptance renderer's output is UNCHANGED — this adds a section", () => {
  const criteria = [{ claim: "W1-T9999 filed as a well-formed plan task shard", proof: "unit test: test/fixture.test.ts" }];
  // byte-identical to the pre-existing contract when changedFiles is omitted
  assert.equal(
    buildPlanPrBody({ intro: "Filing W1-T9999.", criteria }),
    "Filing W1-T9999.\n\nAcceptance:\n- W1-T9999 filed as a well-formed plan task shard | unit test: test/fixture.test.ts\n",
  );
  assert.equal(
    renderAcceptanceBlock(criteria),
    "Acceptance:\n- W1-T9999 filed as a well-formed plan task shard | unit test: test/fixture.test.ts",
  );
  // and with the block present, the Acceptance block is still LAST before the trailer (the #394
  // lesson: its bullets must never be interrupted)
  const withBlock = buildPlanPrBody({ intro: "i", criteria, taskId: "W1-T1", changedFiles: ["a.ts"] });
  assert.ok(withBlock.indexOf(CHANGED_FILES_HEADING) < withBlock.indexOf("Acceptance:"));
  assert.ok(withBlock.indexOf("Acceptance:") < withBlock.indexOf("Remudero-Task:"));
  assert.deepEqual(parseAcceptanceBlock(withBlock), criteria, "and the block still round-trips through the reviewer's parser");
});

test("W1-T2535 criterion 6: hand-editing the block to disagree with its diff is caught, not silently accepted", () => {
  const body = buildPlanPrBody({
    intro: "prose",
    criteria: [{ claim: "c", proof: "unit test: test/x.test.ts" }],
    changedFiles: ["src/a.ts", "src/b.ts"],
  });
  const tampered = body.replace("- `src/b.ts`", "- `src/nonexistent.ts`");
  const drift = changedFilesBlockDrift(tampered, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(drift.missing, ["src/b.ts"]);
  assert.deepEqual(drift.extra, ["src/nonexistent.ts"]);
});

test("W1-T2535: a body with NO block is absent, not stale — the two must stay distinguishable", () => {
  // Fail-closed would be wrong: a body that never opted in has nothing to be stale about, and
  // reporting drift on it would flag every pre-existing PR in the repo.
  const plain = buildPlanPrBody({ intro: "i", criteria: [{ claim: "c", proof: "unit test: test/x.test.ts" }] });
  assert.equal(hasChangedFilesBlock(plain), false);
  assert.deepEqual(changedFilesBlockDrift(plain, ["src/a.ts"]), { missing: [], extra: [] });
});

test("W1-T2535: the block heading itself is not read as a scope CLAIM by the detector", () => {
  // Load-bearing for the design: a section headed "Changed files" must not itself trip the very
  // detector it exists to satisfy. Measured against the three forms that DO fire — a plan-only
  // label, and a count in a sentence carrying changeset context — none of which this heading is.
  const body = buildPlanPrBody({
    intro: "prose",
    criteria: [{ claim: "c", proof: "unit test: test/x.test.ts" }],
    changedFiles: ["src/a.ts"],
  });
  assert.deepEqual(bodyContradictsDiff(body, ["src/a.ts"]), []);
  // and it stays silent even when the diff is LARGER than the block lists — the drift detector is
  // what catches that (criterion 3), never this predicate, so the two never double-report.
  assert.deepEqual(bodyContradictsDiff(body, ["src/a.ts", "src/b.ts"]), []);
});

test("W1-T2535: prose mentioning a path is never mistaken for the block", () => {
  // The reader parses only the backticked bullets the renderer emits. A body discussing
  // `src/other.ts` in its intro must not read as listing it.
  const body = buildPlanPrBody({
    intro: "This is unrelated to `src/other.ts`, which it does not touch.\n\n- `src/decoy.ts` in a stray bullet",
    criteria: [{ claim: "c", proof: "unit test: test/x.test.ts" }],
    changedFiles: ["src/a.ts"],
  });
  assert.deepEqual(changedFilesBlockDrift(body, ["src/a.ts"]), { missing: [], extra: [] });
});
