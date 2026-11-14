// @source-text-subject: containment.ts comment compression preserves pre-compression executable code.
// @census-reads: src/lib/containment.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { assertSameTokens, compressionPinBase } from "#test/helpers/compression-pin.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const COMMENT_LOAD_SCRIPT = "#scripts/comment-load-ratchet.mjs";
const { countCommentLines } = await import(COMMENT_LOAD_SCRIPT) as {
  countCommentLines: (text: string, path: string) => { comments: number; code: number };
};

// Comment floor at 148253e6a2bd08c32ea2168689f9bcf881bf275f, before compression.
// The PR-base fingerprint covers ASI boundaries and types.
const BEFORE_COMMENT_LINES = 612;

function executableTokens(source: string): Array<[SyntaxKind, string, boolean]> {
  const scanner = createScanner(true, undefined, source);
  const tokens: Array<[SyntaxKind, string, boolean]> = [];
  const braceDepths: number[] = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if ((kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) &&
        /^(?:=|\(|\[|\{|,|:|\?|return|case|=>|!|&&|\|\||\?\?)$/.test(tokens.at(-1)?.[1] ?? "=")) {
      kind = scanner.reScanSlashToken();
    }
    if (kind === SyntaxKind.TemplateHead) braceDepths.push(0);
    else if (kind === SyntaxKind.OpenBraceToken && braceDepths.length > 0) braceDepths[braceDepths.length - 1]++;
    else if (kind === SyntaxKind.CloseBraceToken && braceDepths.length > 0) {
      if (braceDepths.at(-1) === 0) {
        kind = scanner.reScanTemplateToken(false);
        if (kind === SyntaxKind.TemplateTail) braceDepths.pop();
      } else braceDepths[braceDepths.length - 1]--;
    }
    tokens.push([kind, scanner.getTokenText(), scanner.hasPrecedingLineBreak()]);
  }
  return tokens;
}

test("W1-T11042: comment compression preserves executable code", () => {
  const control = 'const re = /https?:\\/\\//; const s = `// ${name} /* text */`;';
  assert.deepEqual(executableTokens(control), executableTokens(`/* explanation */ ${control}`));
  for (const [before, after] of [["name", "other"], ["text", "changed"], ["https?", "http"]]) {
    assert.notDeepEqual(executableTokens(control), executableTokens(control.replace(before, after)));
  }
  assert.notDeepEqual(executableTokens("return value"), executableTokens("return\nvalue"));
  const source = readFileSync(join(REPO_ROOT, "src/lib/containment.ts"), "utf8");
  const { comments } = countCommentLines(source, "src/lib/containment.ts");
  assert.ok(comments < BEFORE_COMMENT_LINES,
    `expected a real reduction from ${BEFORE_COMMENT_LINES} comment lines, observed ${comments}`);
  const before = compressionPinBase("src/lib/containment.ts", import.meta.url);
  if (before === undefined) return;
  // Only on the PR that adds this pin: later feature edits to the module stay free.
  assertSameTokens(executableTokens(source), executableTokens(before),
    "all PR-base executable tokens, literals and line-break boundaries must remain unchanged");
  assert.ok(comments < countCommentLines(before, "src/lib/containment.ts").comments,
    "comment lines decrease from the PR base");
});

test("W1-T12411: comment compression preserves executable code", () => {
  const path = "src/lib/containment.ts";
  const source = readFileSync(join(REPO_ROOT, path), "utf8");
  let before = compressionPinBase(path, import.meta.url);
  if (before === undefined) {
    // This task extends an existing pin file; the helper activates only for added files.
    // Compare only while this proof is being introduced, leaving later feature edits free.
    const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
    const base = git("merge-base", "origin/main", "HEAD").trim();
    const diff = git("diff", base, "--", "test/worker/sandbox/compress-src-lib-containment-ts.test.ts");
    if (!diff.includes('+test("W1-T12411: comment compression preserves executable code"')) return;
    before = git("show", `${base}:${path}`);
  }
  assertSameTokens(executableTokens(source), executableTokens(before),
    "executable tokens, literals and line-break boundaries must remain unchanged");
  const oldComments = countCommentLines(before, path).comments;
  const comments = countCommentLines(source, path).comments;
  assert.ok(comments < oldComments,
    `expected a real reduction from ${oldComments} comment lines, observed ${comments}`);
});
