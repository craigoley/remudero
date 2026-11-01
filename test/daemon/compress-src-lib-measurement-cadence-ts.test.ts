// @source-text-subject: measurement-cadence.ts executable tokens, syntax and comment volume.
// @census-reads: src/lib/measurement-cadence.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
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
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: source.split("\n").filter((line) => /^(?:\/\/|\/\*|\*)/.test(line.trim())).length,
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T11007: comment compression preserves executable code", () => {
  // Frozen before compression at 6f907f51a9e0158b48f68838ebd5590621c386f7.
  // Refreshed for W1-T10041's intentional tree-free machine-filing admission check.
  // Comparative evidence for this edit, not a new hard comment ceiling.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/measurement-cadence.ts"), "utf8"));
  assert.equal(actual.tokenCount, 23604);
  assert.equal(actual.tokenDigest, "c5f6e995838eb080f5c4d462dbd876566e7f7e223a4975bc9422bb15d37d726f");
  assert.equal(actual.astDigest, "d5a69bce1de424708922358485743cfa7ada085c5280b2d3ae864d467ef2f534");
  assert.ok(actual.commentLines < 756, `comment lines must decrease from 756; got ${actual.commentLines}`);
  assert.ok(actual.commentBytes < 62677, `comment bytes must decrease from 62677; got ${actual.commentBytes}`);

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
