// @source-text-subject: comment volume and executable-token preservation in src/lib/fleet-control.ts.
// @census-reads: src/lib/fleet-control.ts
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
    // Preserve syntax/ASI while ignoring source locations and parser formatting metadata.
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: parsed.comments!.reduce((n, c) => n + source.slice(c.start!, c.end!).split("\n").length, 0),
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T11065: comment compression preserves executable code", () => {
  // Pre-compression source: a25420801d59d6c2176a1c9dc00bb18153ac948f:src/lib/fleet-control.ts.
  // Babel counts 385 lines including inline comments; the repository ratchet counts 382.
  // These are before/after measurements for this edit, not a new maintenance ceiling.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/fleet-control.ts"), "utf8"));
  assert.equal(actual.tokenCount, 5327);
  assert.equal(actual.tokenDigest, "c8fb8b4cb207600d18b9d0d5d661ba233e6b009c7965880d32407bbdb68df95a");
  assert.equal(actual.astDigest, "44d5b136c0fa507bef56ef9162c15e08a21300f4f9db92174570eb760ee990f7");
  assert.ok(actual.commentLines > 0 && actual.commentLines < 385,
    "comment lines must decrease from the pre-compression source");
  assert.ok(actual.commentBytes > 0 && actual.commentBytes < 30080,
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
