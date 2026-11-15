// @source-text-subject: comment compression and executable-token preservation in src/lib/review.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  // Parser tokens distinguish comments from comment-like strings, regexes and nested templates.
  const tokens = parsed.tokens!.filter((token) => typeof token.type !== "string")
    .map((token) => [token.type.label, source.slice(token.start, token.end)]);
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    tokens,
    tokenDigest: digest(JSON.stringify(tokens)),
    tokenCount: tokens.length,
    // Also protect newline-sensitive syntax such as return's automatic semicolon insertion.
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: parsed.comments!.reduce((n, c) => n + source.slice(c.start!, c.end!).split("\n").length, 0),
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T12217: comment compression preserves executable code", (t) => {
  const sourcePath = "src/lib/review.ts";
  const actual = snapshot(readFileSync(join(REPO_ROOT, sourcePath), "utf8"));
  let before = compressionPinBase(sourcePath, import.meta.url);
  if (before === undefined) {
    // Existing pin file: compare until this task's title reaches the merge base, then retire.
    const git = (args: string[]) => {
      const result = spawnSync("git", args, {
        cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(result.status, 0, `git ${args[0]} failed: ${result.error ?? result.stderr}`);
      return result.stdout;
    };
    const base = git(["merge-base", "origin/main", "HEAD"]).trim();
    if (git(["show", `${base}:test/review/compress-src-lib-review-ts.test.ts`]).includes(
      "W1-T12217: comment compression preserves executable code")) return;
    before = git(["show", `${base}:${sourcePath}`]);
  }
  const previous = snapshot(before);
  t.diagnostic(`comments: ${previous.commentLines} -> ${actual.commentLines} lines; ` +
    `${previous.commentBytes} -> ${actual.commentBytes} bytes`);
  assertSameTokens(actual.tokens, previous.tokens, "executable tokens must remain unchanged");
  assert.equal(actual.astDigest, previous.astDigest, "syntax including automatic semicolon insertion is preserved");
  assert.ok(actual.commentLines > 0 && previous.commentLines > 0, "both sources contain measurable comments");
  assert.ok(actual.commentLines < previous.commentLines,
    `comment lines decrease: ${actual.commentLines} >= ${previous.commentLines}`);
  assert.ok(actual.commentBytes < previous.commentBytes,
    `comment bytes decrease: ${actual.commentBytes} >= ${previous.commentBytes}`);
});

function assertCompression(source: string, before: string | undefined) {
  const actual = snapshot(source);
  if (before !== undefined) {
    // Only on the PR that adds this pin: later feature edits to the module stay free.
    const base = snapshot(before);
    assert.deepEqual([actual.tokenCount, actual.tokenDigest, actual.astDigest],
      [base.tokenCount, base.tokenDigest, base.astDigest], "executable tokens and syntax match the PR base");
    assert.ok(actual.commentLines < base.commentLines, "comment lines decrease from the PR base");
    assert.ok(actual.commentBytes < base.commentBytes,
      "comment bytes decrease from the PR base; rewrapping alone is insufficient");
  }
}

test("W1-T10852: comment compression preserves executable code", () => {
  const source = readFileSync(join(REPO_ROOT, "src/lib/review.ts"), "utf8");
  assertCompression(source, compressionPinBase("src/lib/review.ts", import.meta.url));
});

test("W1-T12164 criterion 1: later comment growth passes the pin", () => {
  const source = "const value = 1;";
  const grown = `${"// added\n".repeat(3222)}/*${"x".repeat(319723)}*/\n${source}`;
  const original = snapshot(source);
  const actual = snapshot(grown);
  assert.ok(actual.commentLines > original.commentLines);
  assert.ok(actual.commentBytes > original.commentBytes);
  assert.doesNotThrow(() => assertCompression(grown, undefined));
});

test("W1-T12164 criterion 2: the adding PR requires reductions and unchanged executable code", () => {
  const source = "const value = 1;";
  const before = `// long comment\n// another long comment\n${source}`;
  assert.doesNotThrow(() => assertCompression(`// short\n${source}`, before));
  assert.throws(() => assertCompression(before, before), /comment lines decrease/);
  assert.throws(() => assertCompression(`// a\n// b\n${source}`, before), /comment lines decrease/);
  assert.throws(() => assertCompression(`// a\n// b\n// c\n${source}`, before), /comment lines decrease/);
  const sameBytes = `/*${"x".repeat(snapshot(before).commentBytes - 4)}*/\n${source}`;
  assert.throws(() => assertCompression(sameBytes, before), /comment bytes/);
  assert.throws(() => assertCompression(sameBytes.replace("/*", "/*x"), before), /comment bytes/);
  assert.throws(() => assertCompression(source.replace("1", "2"), before), /executable tokens/);
  assert.throws(() => assertCompression(`${source}\nconst extra = 2;`, before), /executable tokens/);
  assert.throws(() => assertCompression("function f() { return\n1; }",
    "// comment\nfunction f() { return 1; }"), /executable tokens and syntax/);
});

test("W1-T12164 criterion 3: parser distinguishes comments from strings, regexes and templates", () => {
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
