// @source-text-subject: comment compression and executable-token preservation in src/lib/drain.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "@babel/parser";
import { assertSameTokens, compressionPinBase } from "#test/helpers/compression-pin.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function snapshot(source: string) {
  const parsed = parse(source, {
    sourceType: "module", plugins: ["typescript"], tokens: true, attachComment: false,
  });
  const tokens = parsed.tokens!.filter((token) => typeof token.type !== "string")
    .map((token) => [token.type.label, source.slice(token.start, token.end)]);
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    tokens,
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
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/drain.ts"), "utf8"));
  const before = compressionPinBase("src/lib/drain.ts", import.meta.url);
  if (before !== undefined) {
    // Only on the PR that adds this pin: later feature edits to the module stay free.
    const base = snapshot(before);
    assert.deepEqual([actual.tokenCount, actual.tokenDigest, actual.astDigest],
      [base.tokenCount, base.tokenDigest, base.astDigest], "executable tokens and syntax match the PR base");
    assert.ok(actual.commentLines < base.commentLines, "comment lines decrease from the PR base");
  }
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

test("W1-T12355: comment compression preserves executable code", (t) => {
  const sourcePath = "src/lib/drain.ts";
  let before = compressionPinBase(sourcePath, import.meta.url);
  if (before === undefined) {
    // This pin extends an existing test file: activate only while its title is new to the base.
    const readGit = (args: string[]) => execFileSync("git", args, {
      cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    });
    const base = readGit(["merge-base", "origin/main", "HEAD"]).trim();
    const priorTest = readGit(["show", `${base}:test/dispatch/compress-src-lib-drain-ts.test.ts`]);
    if (priorTest.includes("W1-T12355: comment compression preserves executable code")) return;
    before = readGit(["show", `${base}:${sourcePath}`]);
  }
  const actual = snapshot(readFileSync(join(REPO_ROOT, sourcePath), "utf8"));
  const original = snapshot(before);
  assertSameTokens(actual.tokens, original.tokens, "executable tokens match the pre-compression source");
  assert.equal(actual.astDigest, original.astDigest, "newline-sensitive syntax is preserved");
  assert.ok(actual.commentLines < original.commentLines, "comment lines decrease from the PR base");
  assert.ok(actual.commentBytes < original.commentBytes, "comment bytes decrease from the PR base");
  t.diagnostic(`comments: ${original.commentLines} → ${actual.commentLines} lines; ` +
    `${original.commentBytes} → ${actual.commentBytes} bytes`);
});
