// @source-text-subject: executable tokens, syntax and comment volume in escalate.ts.
// @census-reads: src/lib/escalate.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "@babel/parser";
import { compressionPinBase } from "#test/helpers/compression-pin.js";
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
    // Syntax catches newline-sensitive changes that identical tokens alone cannot detect.
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: source.split("\n").filter((line) => /^(?:\/\/|\/\*|\*)/.test(line.trim())).length,
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T11034: comment compression preserves executable code", () => {
  // Frozen from 2b52efd75 before compression; comparative evidence, not a new ceiling.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/escalate.ts"), "utf8"));
  const before = compressionPinBase("src/lib/escalate.ts", import.meta.url);
  if (before !== undefined) {
    // Only on the PR that adds this pin: later feature edits to the module stay free.
    const base = snapshot(before);
    assert.deepEqual([actual.tokenCount, actual.tokenDigest, actual.astDigest],
      [base.tokenCount, base.tokenDigest, base.astDigest], "executable tokens and syntax match the PR base");
    assert.ok(actual.commentLines < base.commentLines, "comment lines decrease from the PR base");
  }
  assert.ok(actual.commentLines < 641, `comment lines must decrease from 641; got ${actual.commentLines}`);
  assert.ok(actual.commentBytes < 55786, `comment bytes must decrease from 55786; got ${actual.commentBytes}`);

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
