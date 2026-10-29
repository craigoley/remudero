// @source-text-subject: comment compression and executable-token preservation in src/lib/review.ts.
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
  // Parser tokens distinguish comments from comment-like strings, regexes and nested templates.
  const tokens = parsed.tokens!.filter((token) => typeof token.type !== "string")
    .map((token) => [token.type.label, source.slice(token.start, token.end)]);
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    tokenDigest: digest(JSON.stringify(tokens)),
    tokenCount: tokens.length,
    // Also protect newline-sensitive syntax such as return's automatic semicolon insertion.
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: parsed.comments!.reduce((n, c) => n + source.slice(c.start!, c.end!).split("\n").length, 0),
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T10852: comment compression preserves executable code", () => {
  // Captured before compression from cfa32ee06fa43b109da3f8e49f5de664990a38c5.
  // These are comparison evidence for this edit, not a new comment-volume ceiling.
  const source = readFileSync(join(REPO_ROOT, "src/lib/review.ts"), "utf8");
  const actual = snapshot(source);
  assert.equal(actual.tokenCount, 68720);
  assert.equal(actual.tokenDigest, "3a7d74fbc3086d11cb60bb570810c00bbe4d6d0d1785a132bacfb38c1b5faee8");
  assert.equal(actual.astDigest, "c68ffb3cc3c84a6766d54be38bbba89d392e610543704eb41473e9b3b526579a");
  assert.ok(actual.commentLines < 3222,
    "comment lines must decrease from the measured pre-compression source");
  assert.ok(actual.commentBytes < 319723,
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
