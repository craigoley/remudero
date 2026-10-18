import assert from "node:assert/strict";
import { test } from "node:test";
import { renderAcceptanceBlock } from "#src/lib/plan-pr-emitter.js";
import { parseAcceptanceBlock } from "#src/lib/review.js";

test("an acceptance producer refuses loss or truncation of any authored claim or proof", () => {
  const good = { claim: "one intact", proof: "unit test: one intact" };
  for (const bad of [
    { claim: "wrapped\nclaim", proof: "unit test: wrapped" },
    { claim: "middle", proof: "unit test: first\n\n- injected | unit test: injected" },
    { claim: " leading whitespace", proof: "unit test: whitespace" },
    { claim: "claim: a changed meaning", proof: "unit test: changed" },
    { claim: "", proof: "unit test: missing claim" },
    { claim: "no proof", proof: "" },
  ]) {
    assert.throws(() => renderAcceptanceBlock([good, bad, good]), /lossless round trip refused at criterion 2/);
  }
});

test("an acceptance producer preserves valid pipes quotes unicode and exact criterion order", () => {
  const criteria = [
    { claim: 'a "quoted" claim | with a pipe', proof: 'grep: alpha|beta in src/a.ts' },
    { claim: "résumé — preserved", proof: "unit test: résumé preserved" },
    { claim: "last intact", proof: "unit test: last intact" },
  ];
  const block = renderAcceptanceBlock(criteria);
  assert.deepEqual(parseAcceptanceBlock(block), criteria);
  assert.equal(block.includes("\n\n"), false);
});
