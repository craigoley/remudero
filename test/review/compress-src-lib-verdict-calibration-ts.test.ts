// @source-text-subject: comment compression and executable-token preservation in src/lib/verdict-calibration.ts.
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

test("W1-T11091: comment compression preserves executable code", () => {
  // Pre-compression snapshot: 74e8a4a046b1f58feaf37eff86d34ecbfa8722de.
  // These measurements document this edit; they do not establish a new comment ceiling.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/verdict-calibration.ts"), "utf8"));
  assert.equal(actual.tokenCount, 4198);
  assert.equal(actual.tokenDigest, "ede75f4774858b0a6d0a7682ec5d5b51bc888948a24e4af0e2b2786294d96bae");
  assert.equal(actual.astDigest, "1f92420e1201e0eccbe286a727731be99fbfb79555bfbd64e79130bf2cdc78a8");
  assert.ok(actual.commentLines > 0 && actual.commentLines < 331,
    "comment lines must decrease from the pre-compression source");
  assert.ok(actual.commentBytes > 0 && actual.commentBytes < 27744,
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
