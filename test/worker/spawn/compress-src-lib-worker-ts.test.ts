import { compressionPinBase } from "#test/helpers/compression-pin.js";
// @source-text-subject: worker.ts comment compression against its PR base.
// @census-reads: src/lib/worker.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";

// scripts/ is outside tsconfig's include; load the real counter with its explicit runtime contract.
const COMMENT_LOAD_SCRIPT = "#scripts/comment-load-ratchet.mjs";
const { countCommentLines } = await import(COMMENT_LOAD_SCRIPT) as {
  countCommentLines: (text: string, path: string) => { comments: number; code: number };
};

// Pre-compression comment baseline at 3b28ef9e3. Historical fingerprints live in the sibling suite.
const BEFORE_COMMENT_LINES = 2018;

function executableTokens(source: string): Array<[SyntaxKind, string, boolean]> {
  const scanner = createScanner(true, undefined, source);
  const tokens: Array<[SyntaxKind, string, boolean]> = [];
  const braceDepths: number[] = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    // As in runtimeSpecifiers: rescan regexes and template substitutions so their contents stay literal.
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

test("W1-T10879: current worker retains the maintained comment reduction", () => {
  const source = readFileSync(join(REPO_ROOT, "src/lib/worker.ts"), "utf8");
  const { comments } = countCommentLines(source, "src/lib/worker.ts");
  assert.ok(comments < BEFORE_COMMENT_LINES, `expected a real reduction from ${BEFORE_COMMENT_LINES} comment lines, observed ${comments}`);
});

// Historical fingerprint assertions are retained in the sibling historical suite.
test("W1-T10879: comment compression preserves executable code: current PR-base comparison", () => {
  const source = readFileSync(join(REPO_ROOT, "src/lib/worker.ts"), "utf8");
  const { comments } = countCommentLines(source, "src/lib/worker.ts");
  assert.ok(comments < BEFORE_COMMENT_LINES,
    `expected a real reduction from ${BEFORE_COMMENT_LINES} comment lines, observed ${comments}`);
  const before = compressionPinBase("src/lib/worker.ts", import.meta.url);
  if (before === undefined) return;
  // Only on the PR that adds this pin: later feature edits to the module stay free.
  assert.deepEqual(executableTokens(source), executableTokens(before),
    "all PR-base executable tokens, literals and line-break boundaries must remain unchanged");
  assert.ok(comments < countCommentLines(before, "src/lib/worker.ts").comments,
    "comment lines decrease from the PR base");
});

test("worker compression fingerprint ignores comments and catches executable edits", () => {
  const control = 'const re = /https?:\\/\\//; const s = `// ${name} /* text */`;';
  assert.deepEqual(executableTokens(control), executableTokens(`/* explanation */ ${control}`));
  for (const [before, after] of [["name", "other"], ["text", "changed"], ["https?", "http"]]) {
    assert.notDeepEqual(executableTokens(control), executableTokens(control.replace(before, after)));
  }
  assert.notDeepEqual(executableTokens("return value"), executableTokens("return\nvalue"));
});
