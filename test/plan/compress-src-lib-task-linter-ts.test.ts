// @source-text-subject: comment compression and executable-token preservation in task-linter.ts.
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
    // Ignore positions, but retain the AST's newline-sensitive syntax.
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: parsed.comments!.reduce((n, c) => n + source.slice(c.start!, c.end!).split("\n").length, 0),
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T10912: comment compression preserves executable code", () => {
  // Captured before compression at 8f587c4fe86d2ca60776f7a1a25cc261f41463a2.
  // Comparison evidence for this edit; not a new maintenance ceiling.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/task-linter.ts"), "utf8"));
  assert.equal(actual.tokenCount, 21054);
  assert.equal(actual.tokenDigest, "d2abeb66dbf638f84a7a5dad279fa644abd534a4888af0693d9b668ed47626c8");
  assert.equal(actual.astDigest, "d372dcb544bae4ec197669092b6ffc5026136bf83113c2e45a16f498a0aa9d14");
  assert.ok(actual.commentLines < 1379, "comment lines must decrease from the pre-compression source");
  assert.ok(actual.commentBytes < 121705, "comment bytes must decrease; rewrapping alone is insufficient");

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
