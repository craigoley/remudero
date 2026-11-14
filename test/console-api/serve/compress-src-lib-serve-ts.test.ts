import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { assertSameTokens, compressionPinBase } from "#test/helpers/compression-pin.js";
import { spawnSync } from "node:child_process";
// @source-text-subject: serve.ts comment compression against its PR base.
// @census-reads: src/lib/serve.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { parse } from "@babel/parser";

function snapshot(source: string) {
  const parsed = parse(source, {
    sourceType: "module", plugins: ["typescript"], tokens: true, attachComment: false,
  });
  // Keep literal contents, regexes and nested templates; discard only parser-recognized comments.
  const tokens = parsed.tokens!.filter((token) => typeof token.type !== "string")
    .map((token) => [token.type.label, source.slice(token.start, token.end)]);
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    tokens,
    tokenCount: tokens.length,
    tokenDigest: digest(JSON.stringify(tokens)),
    // The AST also detects newline-sensitive automatic semicolon insertion.
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: parsed.comments!.reduce((n, c) => n + source.slice(c.start!, c.end!).split("\n").length, 0),
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T12291: comment compression preserves executable code", (t) => {
  const sourcePath = "src/lib/serve.ts";
  let before = compressionPinBase(sourcePath, import.meta.url);
  if (before === undefined) {
    // This file predates this task: retire the comparison once the new title reaches main.
    const git = (args: string[]) => {
      const result = spawnSync("git", args, {
        cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(result.status, 0, `git ${args[0]} failed: ${result.error ?? result.stderr}`);
      return result.stdout;
    };
    const base = git(["merge-base", "origin/main", "HEAD"]).trim();
    if (git(["show", `${base}:test/console-api/serve/compress-src-lib-serve-ts.test.ts`]).includes(
      "W1-T12291: comment compression preserves executable code")) return;
    before = git(["show", `${base}:${sourcePath}`]);
  }
  const previous = snapshot(before);
  const actual = snapshot(readFileSync(join(REPO_ROOT, sourcePath), "utf8"));
  t.diagnostic(`comments: ${previous.commentLines} -> ${actual.commentLines} lines; ` +
    `${previous.commentBytes} -> ${actual.commentBytes} bytes`);
  assertSameTokens(actual.tokens, previous.tokens, "all executable tokens survive compression");
  assert.equal(actual.astDigest, previous.astDigest, "syntax and automatic semicolon insertion survive");
  assert.ok(previous.commentLines > 0 && actual.commentLines > 0, "both comment corpora are nonempty");
  assert.ok(actual.commentLines < previous.commentLines, "comment lines decrease from the PR base");
  assert.ok(actual.commentBytes < previous.commentBytes, "comment bytes decrease from the PR base");
});

// Historical fingerprint assertions are retained in the historical suite.
test("W1-T10905: comment compression preserves executable code: current PR-base comparison", () => {
  // Pre-compression source: 8f587c4fe86d2ca60776f7a1a25cc261f41463a2.
  // These measurements prove this edit's reduction; they introduce no policy ceiling.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/serve.ts"), "utf8"));
  const before = compressionPinBase("src/lib/serve.ts", import.meta.url);
  if (before !== undefined) {
    // Only on the PR that adds this pin: later feature edits to the module stay free.
    const base = snapshot(before);
    assert.deepEqual([actual.tokenCount, actual.tokenDigest, actual.astDigest],
      [base.tokenCount, base.tokenDigest, base.astDigest], "executable tokens and syntax match the PR base");
    assert.ok(actual.commentLines < base.commentLines, "comment lines decrease from the PR base");
  }
  assert.ok(actual.commentLines < 1381,
    "comment lines must decrease from the measured pre-compression source");
  assert.ok(actual.commentBytes < 106468,
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
