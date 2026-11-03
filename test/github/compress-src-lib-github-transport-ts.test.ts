// @source-text-subject: github-transport.ts comment compression and executable-token preservation.
// @census-reads: src/lib/github-transport.ts
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
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: source.split("\n").filter(line => /^(?:\/\/|\/\*|\*)/.test(line.trim())).length,
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T11059: comment compression preserves executable code", () => {
  // Snapshot: a25420801d59d6c2176a1c9dc00bb18153ac948f; measurements, not a new ceiling.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/github-transport.ts"), "utf8"));
  assert.equal(actual.tokenCount, 12338);
  assert.equal(actual.tokenDigest, "de7dd199c036ad5be80d3e731a6350f4eb51f9354f58bb40d4c78d4f6bd107ae");
  assert.equal(actual.astDigest, "4321d09de1ed1004845d8a679f5f695f1112c6ca5fe5c409cc2d997b7bb521ff");
  assert.ok(actual.commentLines > 0 && actual.commentLines < 439,
    `comment lines must decrease from 439, found ${actual.commentLines}`);
  assert.ok(actual.commentBytes > 0 && actual.commentBytes < 35881,
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
