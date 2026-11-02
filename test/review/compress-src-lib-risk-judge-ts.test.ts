// @source-text-subject: comment compression and executable-token preservation in src/lib/risk-judge.ts.
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
    // Ignore positions, but preserve syntax including automatic semicolon insertion.
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: parsed.comments!.reduce((n, c) => n + source.slice(c.start!, c.end!).split("\n").length, 0),
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T11058: comment compression preserves executable code", () => {
  // Pre-compression snapshot: a25420801d59d6c2176a1c9dc00bb18153ac948f.
  // These measurements document this edit; they do not establish a new comment ceiling.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/risk-judge.ts"), "utf8"));
  assert.equal(actual.tokenCount, 8661);
  assert.equal(actual.tokenDigest, "d38b7cb74e533ff3b75bf855332b77871ba243b7f5b73d1becb9a490aac2defb");
  assert.equal(actual.astDigest, "6fd3ce423c9d8db3c071ed61511142978381e0145cba90e72aa24b0f91ab684c");
  assert.ok(actual.commentLines > 0 && actual.commentLines < 449,
    "comment lines must decrease from the pre-compression source");
  assert.ok(actual.commentBytes > 0 && actual.commentBytes < 36535,
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
