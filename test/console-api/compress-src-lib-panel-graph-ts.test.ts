// @source-text-subject: panel-graph.ts comment compression and executable-token preservation.
// @census-reads: src/lib/panel-graph.ts
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
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: source.split("\n").filter((line) => /^(?:\/\/|\/\*|\*)/.test(line.trim())).length,
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T11035: comment compression preserves executable code", () => {
  // Pre-compression evidence at 148253e6a2bd08c32ea2168689f9bcf881bf275f, not a new volume ceiling.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/panel-graph.ts"), "utf8"));
  assert.equal(actual.tokenCount, 35892);
  assert.equal(actual.tokenDigest, "291ff653408f837bd34cf3e29e91abe77f430649d389fd228dca795981c73a26");
  assert.equal(actual.astDigest, "7fdc7f0464d3f297a328172bc27e2525014f15b5db1e1381516bc9029b0a68ae");
  assert.ok(actual.commentLines < 633, `comment lines must decrease from 633, found ${actual.commentLines}`);
  assert.ok(actual.commentBytes < 52646, "comment bytes must decrease; rewrapping alone is insufficient");

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
