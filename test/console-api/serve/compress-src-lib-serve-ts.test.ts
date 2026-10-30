// @source-text-subject: comment compression and executable-token preservation in src/lib/serve.ts.
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
  // Keep literal contents, regexes and nested templates; discard only parser-recognized comments.
  const tokens = parsed.tokens!.filter((token) => typeof token.type !== "string")
    .map((token) => [token.type.label, source.slice(token.start, token.end)]);
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    tokenCount: tokens.length,
    tokenDigest: digest(JSON.stringify(tokens)),
    // The AST also detects newline-sensitive automatic semicolon insertion.
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: parsed.comments!.reduce((n, c) => n + source.slice(c.start!, c.end!).split("\n").length, 0),
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T10905: comment compression preserves executable code", () => {
  // Pre-compression source: 8f587c4fe86d2ca60776f7a1a25cc261f41463a2.
  // These measurements prove this edit's reduction; they introduce no policy ceiling.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/serve.ts"), "utf8"));
  assert.equal(actual.tokenCount, 25040);
  assert.equal(actual.tokenDigest, "5360a943406a970130927db86b2580b3e4c452bd06aec0f7ca9af9eef6cd010a");
  assert.equal(actual.astDigest, "1ceb7ff455253f374082ac2234261613219f61e9e93af69d124ca8eae1b01fa3");
  assert.ok(actual.commentLines < 1381,
    "comment lines must decrease from the measured pre-compression source");
  assert.ok(actual.commentBytes < 106468,
    "comment bytes must decrease too; rewrapping alone is insufficient");

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
