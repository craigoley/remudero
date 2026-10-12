import assert from "node:assert/strict";
import { test } from "node:test";
import * as review from "../src/lib/review.js";

const REAL = "- the real claim | unit test: the real test title";
const CLAIM = "This PR is plan-only.";
const DIFF = ["src/lib/review.ts"];

test("test/a-fence-inside-an-html-comment-does-not-hide-the-acceptance-block.test.ts", () => {
  for (const prefix of ["<!-- note\n```\n-->", "    ```", "\t```", "<!-- note\n~~~\n-->"]) {
    const body = `${prefix}\n## Acceptance\n${REAL}`;
    assert.deepEqual(review.parseAcceptanceBlock(body), [
      { claim: "the real claim", proof: "unit test: the real test title" },
    ]);
    assert.equal(review.acceptanceBlockDiagnostics(body).defective, false);
  }
  const quoted = `~~~\n${CLAIM}\n~~~`;
  assert.equal(review.stripQuotedRegions(quoted).scan.trim(), "");
  assert.equal(review.recognizeChangesetClaims(quoted, DIFF).recognisedCount, 0);
  assert.equal(review.recognizeChangesetClaims(CLAIM, DIFF).recognisedCount, 1);
});

test("comment ownership hides headers and preserves offsets before a real block", () => {
  const body = `Prefix 💡 <!--\n## Acceptance\n${REAL}\n--> suffix\n## Acceptance\n${REAL}`;
  assert.equal(review.acceptanceHeaderLine(body.split("\n")), 4);
  const { scan, fenceUnbalancedAtEof } = review.stripQuotedRegions(body);
  assert.equal(scan.length, body.length);
  assert.deepEqual([...scan.matchAll(/\n/g)].map((m) => m.index), [...body.matchAll(/\n/g)].map((m) => m.index));
  assert.match(scan, /Prefix 💡 /);
  assert.match(scan, /suffix/);
  assert.equal(fenceUnbalancedAtEof, false);
  assert.equal(review.acceptanceHeaderLine(["<!--", "## Acceptance"]), -1);
});

test("both walkers require matching fence character length and at most three spaces", () => {
  for (const open of ["   ````md", "   ~~~~md"]) {
    const marker = open.includes("`") ? "`" : "~";
    const other = marker === "`" ? "~" : "`";
    const body = [open, marker.repeat(3), other.repeat(4), `${marker.repeat(4)} text`,
      `    ${marker.repeat(4)}`, "## Acceptance", REAL, CLAIM,
      `  ${marker.repeat(5)}\t`, CLAIM, "## Acceptance", REAL].join("\n");
    assert.equal(review.acceptanceHeaderLine(body.split("\n")), 10);
    const result = review.recognizeChangesetClaims(body, DIFF);
    assert.equal(result.recognisedCount, 1);
    assert.equal(result.fenceUnbalancedAtEof, false);
  }
  assert.equal(review.FENCE_OPEN_RE.test("    ```"), false);
  assert.equal(review.FENCE_OPEN_RE.test("\t~~~"), false);
  assert.equal(review.stripQuotedRegions(`    ~~~\n${CLAIM}`).scan.includes(CLAIM), true);
  assert.equal(review.stripQuotedRegions("```js `inline`\nvisible").scan, "```js `inline`\nvisible");
});

test("only an unclosed fence hiding the header sets headerInsideFence", () => {
  for (const marker of ["```", "~~~"]) {
    const body = `${marker}\n<!--\n## Acceptance\n${REAL}`;
    assert.deepEqual(review.parseAcceptanceBlock(body), []);
    const diagnostic = review.acceptanceBlockDiagnostics(body);
    assert.equal(diagnostic.headerFound, false);
    assert.equal(diagnostic.headerInsideFence, true);
    assert.equal(diagnostic.defective, true);
    assert.equal(review.stripQuotedRegions(body).fenceUnbalancedAtEof, true);
    assert.equal(review.acceptanceBlockDiagnostics(`${body}\n${marker}`).headerInsideFence, false);
    assert.equal(review.acceptanceBlockDiagnostics(`${body}\n${marker}\n${marker}`).headerInsideFence, false);
    assert.equal(review.acceptanceBlockDiagnostics(`${body}\n${marker}\n## Acceptance\n${REAL}`).headerInsideFence, false);
  }
  assert.equal(review.acceptanceBlockDiagnostics("no header").headerInsideFence, false);
  assert.equal(review.acceptanceBlockDiagnostics("<!--\n## Acceptance").headerInsideFence, false);
});

test("W1-T5621 fenced examples still select the real block", () => {
  for (const marker of ["```", "~~~"]) {
    const body = [marker, "## Acceptance", "- example | unit test: example", marker,
      "## Acceptance", REAL].join("\n");
    assert.equal(review.acceptanceHeaderLine(body.split("\n")), 4);
    assert.deepEqual(review.acceptanceBlockRegion(body), { headerLine: 4, endLine: 6, bulletsWritten: 1 });
    assert.deepEqual(review.parseAcceptanceBlock(body).map((c) => c.claim), ["the real claim"]);
  }
});

test("the exported classifier handles comment closes and fence-owned comment syntax", () => {
  const state = { inHtmlComment: false } as review.MarkdownLineState;
  assert.equal(typeof review.classifyMarkdownLine, "function");
  assert.equal(review.classifyMarkdownLine("<!-- first --> text <!-- second", state).scan.trim(), "text");
  assert.equal(state.inHtmlComment, true);
  assert.equal(review.classifyMarkdownLine("--> ~~~", state).insideFence, true);
  assert.equal(state.inHtmlComment, false);
  assert.equal(review.classifyMarkdownLine("<!--", state).scan.trim(), "");
  assert.equal(state.inHtmlComment, false);
  review.classifyMarkdownLine("~~~", state);
  assert.equal(state.fence, undefined);
  assert.equal(review.classifyMarkdownLine("visible\r", state).scan, "visible\r");
  assert.equal(review.classifyMarkdownLine("~~~ <!--", state).insideFence, true);
  assert.equal(state.inHtmlComment, false);
  review.classifyMarkdownLine("~~~", state);
  assert.equal(review.classifyMarkdownLine("``<!-- hidden -->`", state).insideFence, false);
  assert.equal(review.classifyMarkdownLine("", state).scan, "");
});
