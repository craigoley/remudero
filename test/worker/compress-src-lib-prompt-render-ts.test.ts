// @source-text-subject: comment compression and executable-token preservation in prompt-render.ts.
// @census-reads: src/lib/prompt-render.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "@babel/parser";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function snapshot(source: string) {
  const parsed = parse(source, {
    sourceType: "module", plugins: ["typescript"], tokens: true, attachComment: false,
  });
  const tokens = parsed.tokens!.filter((token) => typeof token.type !== "string")
    .map((token) => [token.type.label, source.slice(token.start, token.end)]);
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    tokenCount: tokens.length,
    tokenDigest: digest(JSON.stringify(tokens)),
    // Retain newline-sensitive syntax while ignoring source positions.
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: parsed.comments!.reduce((n, c) => n + source.slice(c.start!, c.end!).split("\n").length, 0),
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T11047: comment compression preserves executable code", () => {
  // Captured from ccdae0c920e7b6fbfeb01e72bbd69e802f5ddcae before compression.
  // Comparison evidence for this edit, not a new comment-volume ceiling.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/prompt-render.ts"), "utf8"));
  assert.equal(actual.tokenCount, 5302);
  assert.equal(actual.tokenDigest, "26042422471f5279fe0aed6add069a9cf8fe30f7bf2a315a16c9bde37b37c368");
  assert.equal(actual.astDigest, "f2838f55f57427e1f7eb2dbed0ab4448947e8b9005c7af0ba783aa3fa568319b");
  assert.ok(actual.commentLines < 531, "comment lines must decrease from the pre-compression source");
  assert.ok(actual.commentBytes < 38447, "comment bytes must decrease; rewrapping alone is insufficient");

  const fixture = 'const re = /https?:\\/\\//; const s = "// kept"; const t = `/* ${`// ${1}`} */`;';
  const original = snapshot(fixture);
  const commented = snapshot(`/** extra */\n${fixture}\n// extra`);
  assert.equal(commented.tokenDigest, original.tokenDigest);
  assert.equal(commented.astDigest, original.astDigest);
  for (const changed of [fixture.replace("https?", "http"), fixture.replace("// kept", "// changed"),
    fixture.replace("${1}", "${2}")]) {
    assert.notEqual(snapshot(changed).tokenDigest, original.tokenDigest);
  }
  assert.notEqual(snapshot("function f() { return 1; }").astDigest,
    snapshot("function f() { return\n1; }").astDigest);
});
