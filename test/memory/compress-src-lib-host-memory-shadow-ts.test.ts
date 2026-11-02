// @source-text-subject: host-memory-shadow.ts comment compression preserves executable tokens and syntax.
// @census-reads: src/lib/host-memory-shadow.ts
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
    // Keep newline-sensitive syntax while discarding source positions.
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: source.split("\n").filter((line) => /^\s*(?:\/\/|\/\*|\*)/.test(line)).length,
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T11068: comment compression preserves executable code", () => {
  // Pre-compression source at fe15c4b9e322fbe319b74ceee357516b4227e050.
  // These measurements witness this edit; intentional future code changes require review.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/host-memory-shadow.ts"), "utf8"));
  assert.equal(actual.tokenCount, 23397);
  assert.equal(actual.tokenDigest, "4c39fb452b450b372d493b7900f0643769316e3a1dbc9cca0eb066acdbd9bc28");
  assert.equal(actual.astDigest, "1c533d273842babec0ca08b1a0f6d52dd6bb19131a22d2eab5b62f3cc5243f25");
  assert.ok(actual.commentLines < 358, "comment lines must decrease from the pre-compression source");
  assert.ok(actual.commentBytes < 35666, "comment bytes must decrease; rewrapping alone is insufficient");
});

test("host memory compression fingerprint preserves literals and newline-sensitive syntax", () => {
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
