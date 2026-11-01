// @source-text-subject: main-health-rung.ts comment compression and executable-token preservation.
// @census-reads: src/lib/main-health-rung.ts
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
  const tokens = parsed.tokens!.filter(token => typeof token.type !== "string")
    .map(token => [token.type.label, source.slice(token.start, token.end)]);
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    tokenCount: tokens.length,
    tokenDigest: digest(JSON.stringify(tokens)),
    // Ignore positions while retaining syntax, including automatic semicolon insertion.
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: parsed.comments!.reduce((n, c) => n + source.slice(c.start!, c.end!).split("\n").length, 0),
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T11066: comment compression preserves executable code", () => {
  // Pre-compression source: 69ba8151bb8f69458ace15c1dfd7e71e78396722.
  // These measurements document this edit, rather than establish a new comment ceiling.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/main-health-rung.ts"), "utf8"));
  assert.equal(actual.tokenCount, 26316);
  assert.equal(actual.tokenDigest, "f34cc863fa31a4504fd7e21b8416a4c44139fcdf7bea8d3baa31a2686eaa3f51");
  assert.equal(actual.astDigest, "e15381a5e1a45cd31ce59dee2cb26ec9510585c72accc2d3b039d4285a0f407e");
  assert.ok(actual.commentLines > 0 && actual.commentLines < 361,
    `comment lines must decrease from 361, found ${actual.commentLines}`);
  assert.ok(actual.commentBytes > 0 && actual.commentBytes < 31698,
    "comment bytes must decrease; rewrapping alone is insufficient");

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
