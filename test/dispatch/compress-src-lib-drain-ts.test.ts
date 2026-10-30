// @source-text-subject: comment compression and executable-token preservation in src/lib/drain.ts.
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
    // Preserve newline-sensitive syntax while ignoring source positions and comments.
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: parsed.comments!.reduce((n, c) => n + source.slice(c.start!, c.end!).split("\n").length, 0),
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T10971: comment compression preserves executable code", () => {
  // Pre-compression source: 1343a5d5ded2dc84b3139b17b886ee5a38328725.
  // Comparison evidence for this edit, not a policy ceiling.
  // W1-T9819 intentionally changes orphan release; refresh code snapshots, retaining comment ceilings.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/drain.ts"), "utf8"));
  assert.equal(actual.tokenCount, 15940);
  assert.equal(actual.tokenDigest, "b391d189981002edd0f3264a972910264023c9d694c3802232be167a5c3319cd");
  assert.equal(actual.astDigest, "5466e9b5fbfeeef6dbd203001ab901f368f3852a2d9ba1b4c13e047e7f132858");
  assert.ok(actual.commentLines < 919, "comment lines must decrease from the pre-compression source");
  assert.ok(actual.commentBytes < 82854, "comment bytes must decrease; rewrapping alone is insufficient");

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
