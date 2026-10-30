// @source-text-subject: comment compression and executable-token preservation in src/lib/worker-provider.ts.
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
    tokenDigest: digest(JSON.stringify(tokens)),
    tokenCount: tokens.length,
    // The AST also detects newline-sensitive changes such as return's automatic semicolon insertion.
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: parsed.comments!.reduce((n, c) => n + source.slice(c.start!, c.end!).split("\n").length, 0),
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T10918: comment compression preserves executable code", () => {
  // Pre-compression source: 811d6e2d19018530bd12c885d307d08f02fb09bc.
  // Historical comparison evidence for this edit, not a new comment ceiling.
  // W1-T10855 intentionally adds price, shape and effort rows plus the effort lookup.
  // Refresh executable fingerprints for that behavior; retain the compression bounds below.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/worker-provider.ts"), "utf8"));
  assert.equal(actual.tokenCount, 44036);
  assert.equal(actual.tokenDigest, "ca6c6a142830a81efbc569c3692b9b18ad5fe760b01c29ae2b10dd769f8b31fe");
  assert.equal(actual.astDigest, "9f97e3043c20e31c8fe50a437016871c3d24c254ac1c7386174fb531acbf4742");
  assert.ok(actual.commentLines < 1357, "comment lines must decrease from the pre-compression source");
  assert.ok(actual.commentBytes < 104858, "comment bytes must decrease; rewrapping alone is insufficient");

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
