import { assertSameTokens, compressionPinBase } from "#test/helpers/compression-pin.js";
// @source-text-subject: worker-provider.ts comment compression against its PR base.
// @census-reads: src/lib/worker-provider.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { parse } from "@babel/parser";

function snapshot(source: string) {
  const parsed = parse(source, {
    sourceType: "module", plugins: ["typescript"], tokens: true, attachComment: false,
  });
  const tokens = parsed.tokens!.filter((token) => typeof token.type !== "string")
    .map((token) => [token.type.label, source.slice(token.start, token.end)]);
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    tokens,
    tokenDigest: digest(JSON.stringify(tokens)),
    tokenCount: tokens.length,
    // The AST also detects newline-sensitive changes such as return's automatic semicolon insertion.
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: parsed.comments!.reduce((n, c) => n + source.slice(c.start!, c.end!).split("\n").length, 0),
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T10918: current provider retains the maintained comment reduction", () => {
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/worker-provider.ts"), "utf8"));
  assert.ok(actual.commentLines < 1357, "comment lines must decrease from the pre-compression source");
  assert.ok(actual.commentBytes < 104858, "comment bytes must decrease; rewrapping alone is insufficient");
});

// Historical fingerprint assertions are retained in the historical suite.
test("W1-T10918: comment compression preserves executable code: current PR-base comparison", () => {
  // Pre-compression source: 811d6e2d19018530bd12c885d307d08f02fb09bc.
  // Historical comparison evidence for this edit, not a new comment ceiling.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/worker-provider.ts"), "utf8"));
  const before = compressionPinBase("src/lib/worker-provider.ts", import.meta.url);
  if (before !== undefined) {
    // Only on the PR that adds this pin: later feature edits to the module stay free.
    const base = snapshot(before);
    assert.deepEqual([actual.tokenCount, actual.tokenDigest, actual.astDigest],
      [base.tokenCount, base.tokenDigest, base.astDigest], "executable tokens and syntax match the PR base");
    assert.ok(actual.commentLines < base.commentLines, "comment lines decrease from the PR base");
  }
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


test("W1-T12298: comment compression preserves executable code", () => {
  const sourcePath = "src/lib/worker-provider.ts";
  const title = "W1-T12298: comment compression preserves executable code";
  let before = compressionPinBase(sourcePath, import.meta.url);
  if (before === undefined) {
    // This file already contains a pin: activate this comparison while the new title is absent
    // at the PR base, then release subsequent feature edits, as the shared helper does for additions.
    const git = (...args: string[]) => execFileSync("git", args, {
      cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    });
    const base = git("merge-base", "origin/main", "HEAD").trim();
    const baseTest = git("show", `${base}:test/worker/spawn/compress-src-lib-worker-provider-ts.test.ts`);
    if (baseTest.includes(title)) return;
    before = git("show", `${base}:${sourcePath}`);
  }
  const actual = snapshot(readFileSync(join(REPO_ROOT, sourcePath), "utf8"));
  const original = snapshot(before);
  assertSameTokens(actual.tokens, original.tokens, "executable tokens and literals match the PR base");
  assert.equal(actual.astDigest, original.astDigest, "syntax and automatic semicolon insertion match");
  assert.ok(actual.commentLines < original.commentLines, "comment lines decrease from the PR base");
  assert.ok(actual.commentBytes < original.commentBytes, "comment bytes decrease from the PR base");
});
