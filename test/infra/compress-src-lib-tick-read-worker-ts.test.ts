// @source-text-subject: executable tokens, syntax and comment volume in tick-read-worker.ts.
// @census-reads: src/lib/tick-read-worker.ts
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
    // Preserve newline-sensitive syntax, including automatic semicolon insertion.
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: source.split("\n").filter((line) => /^(?:\/\/|\/\*|\*)/.test(line.trim())).length,
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T10963: comment compression preserves executable code", () => {
  // Frozen before compression at f134daa07bf5ca8467f7c699968ef6e2051b6e5a.
  // Comparative evidence for this edit, not a new comment-volume ceiling.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/tick-read-worker.ts"), "utf8"));
  assert.equal(actual.tokenCount, 23556);
  assert.equal(actual.tokenDigest, "af72e11268e9c2dd410d822aaa78f0da2f1c856547a9409e6168233f7842b48c");
  assert.equal(actual.astDigest, "a46f2ba5a6ed4256ed0bdc998679606f0d812160c0fc8d5978b8048afb85444c");
  assert.ok(actual.commentLines < 1053, `comment lines must decrease from 1053; got ${actual.commentLines}`);
  assert.ok(actual.commentBytes < 82761, `comment bytes must decrease from 82761; got ${actual.commentBytes}`);

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
