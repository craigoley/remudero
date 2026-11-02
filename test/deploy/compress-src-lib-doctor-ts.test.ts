// @source-text-subject: doctor.ts comment compression and executable-token preservation.
// @census-reads: src/lib/doctor.ts
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

test("W1-T11086: comment compression preserves executable code", () => {
  // Frozen before compression at 1c4901384e1553a72e73f3f657f834346454820b; not a new ceiling.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/doctor.ts"), "utf8"));
  assert.equal(actual.tokenCount, 6942);
  assert.equal(actual.tokenDigest, "b377ac74b8cbacec22ed85da61d5a15b3f6cdae33108c072cd4f8132a24ba57c");
  assert.equal(actual.astDigest, "9b2800abb41eb2dd637cff1a7b01bdf07ea95b1502c79eb52943baba637eda8b");
  assert.ok(actual.commentLines < 335, `comment lines must decrease from 335, found ${actual.commentLines}`);
  assert.ok(actual.commentBytes < 26721, "comment bytes must decrease; rewrapping alone is insufficient");

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
