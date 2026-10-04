// test/an-acceptance-header-inside-a-code-fence-is-an-example-not-the-block.test.ts
//
// W1-T5621. THE DEFECT, reproduced on origin/main before the fix: a PR body that SHOWS the
// acceptance format inside a ``` fence, ahead of its real `## Acceptance` block, parsed back ONLY
// the fenced example — `parseAcceptanceBlock` and `acceptanceBlockRegion` entered the block at the
// first line matching `ACCEPTANCE_HEADER_RE` and kept no fence state. Review then executed the
// example's proof and never read the real block, and `replaceAcceptanceBlock` (plan-pr-emitter.ts)
// demoted the fenced example with its own copy of the regex, leaving the real header live above the
// appended repair block.
//
// THE FIX is ONE fence-aware walker, `acceptanceHeaderLine`, that all three start from — so the
// reviewer, the author-time gate (which imports `parseAcceptanceBlock`) and the repair cannot
// disagree about where the block begins.
//
// FALSIFIER: drop the fence check from `acceptanceHeaderLine` and the fixture body parses back the
// fenced example's criterion instead of the real one.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptanceBlockDiagnostics,
  acceptanceBlockRegion,
  acceptanceHeaderLine,
  parseAcceptanceBlock,
} from "../src/lib/review.js";
import { replaceAcceptanceBlock, SUPERSEDED_HEADER_SUFFIX } from "../src/lib/plan-pr-emitter.js";

const EXAMPLE = "- the example claim | grep: example in docs/example.md";
const REAL = "- the real claim | unit test: the real test title";

function bodyWithFence(open: string, close: string): string {
  return [
    "Shows the format an author should write:", // 0
    "", // 1
    open, // 2
    "## Acceptance", // 3
    EXAMPLE, // 4
    close, // 5
    "", // 6
    "## Acceptance", // 7
    REAL, // 8
  ].join("\n");
}

test("a backtick-fenced example header is skipped and the real block parses", () => {
  const body = bodyWithFence("```md", "```");
  assert.deepEqual(parseAcceptanceBlock(body), [{ claim: "the real claim", proof: "unit test: the real test title" }]);
  assert.equal(acceptanceHeaderLine(body.split("\n")), 7);
  assert.deepEqual(acceptanceBlockRegion(body), { headerLine: 7, endLine: 9, bulletsWritten: 1 });
  const d = acceptanceBlockDiagnostics(body);
  assert.equal(d.headerFound, true);
  assert.equal(d.criteriaParsed, 1);
  assert.equal(d.defective, false);
});

test("a tilde-fenced example header is skipped and the real block parses", () => {
  const body = bodyWithFence("~~~", "~~~");
  assert.deepEqual(parseAcceptanceBlock(body), [{ claim: "the real claim", proof: "unit test: the real test title" }]);
  assert.equal(acceptanceBlockRegion(body)?.headerLine, 7);
});

test("a fence closes only on its own character at the opener's length or longer, with nothing after it", () => {
  // A four-backtick fence is NOT closed by ```, nor by ~~~~, nor by a ```` carrying trailing text —
  // so the header after each of those lines is still the example.
  const body = [
    "````",
    "```",
    "~~~~",
    "```` not a closer",
    "## Acceptance",
    EXAMPLE,
    "`````  ",
    "## Acceptance",
    REAL,
  ].join("\n");
  assert.equal(acceptanceHeaderLine(body.split("\n")), 7);
  assert.deepEqual(parseAcceptanceBlock(body).map((c) => c.claim), ["the real claim"]);
});

test("a body whose ONLY acceptance header is fenced resolves nothing and fails closed", () => {
  const body = ["```", "## Acceptance", EXAMPLE, "```", "", "No block of my own."].join("\n");
  assert.deepEqual(parseAcceptanceBlock(body), []);
  assert.equal(acceptanceBlockRegion(body), undefined);
  assert.equal(acceptanceHeaderLine(body.split("\n")), -1);
  assert.equal(acceptanceBlockDiagnostics(body).defective, true);
  // An UNCLOSED fence runs to the end of the body, as CommonMark renders it.
  assert.deepEqual(parseAcceptanceBlock(["```", "", "## Acceptance", REAL].join("\n")), []);
});

test("an unfenced body is unchanged — the first header still begins the block", () => {
  const body = ["## Acceptance", REAL, "", "## Acceptance", EXAMPLE].join("\n");
  assert.equal(acceptanceHeaderLine(body.split("\n")), 0);
  assert.deepEqual(parseAcceptanceBlock(body).map((c) => c.claim), ["the real claim"]);
  assert.deepEqual(acceptanceBlockRegion(body), { headerLine: 0, endLine: 2, bulletsWritten: 1 });
});

test("replaceAcceptanceBlock demotes the REAL header, never the fenced example", () => {
  const body = bodyWithFence("```", "```");
  const repaired = replaceAcceptanceBlock(body, [{ claim: "the repaired claim", proof: "unit test: repaired" }]);
  const lines = repaired.split("\n");
  assert.equal(lines[3], "## Acceptance", "the fenced example is left exactly as written");
  assert.equal(lines[7], `## Acceptance${SUPERSEDED_HEADER_SUFFIX}`, "the real header is demoted");
  assert.deepEqual(parseAcceptanceBlock(repaired), [{ claim: "the repaired claim", proof: "unit test: repaired" }]);
});

test("replaceAcceptanceBlock leaves a body whose only header is fenced undemoted", () => {
  const body = ["```", "## Acceptance", EXAMPLE, "```"].join("\n");
  const repaired = replaceAcceptanceBlock(body, [{ claim: "the repaired claim", proof: "unit test: repaired" }]);
  assert.equal(repaired.includes(SUPERSEDED_HEADER_SUFFIX), false);
  assert.deepEqual(parseAcceptanceBlock(repaired).map((c) => c.claim), ["the repaired claim"]);
});
