// @source-text-subject: ledger-union.ts comment compression must preserve its pre-compression code.
// @census-reads: src/lib/ledger-union.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { transformSync } from "esbuild";
import { assertSameTokens, compressionPinBase } from "#test/helpers/compression-pin.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const COMMENT_LOAD_SCRIPT = "#scripts/comment-load-ratchet.mjs";
const { countCommentLines } = await import(COMMENT_LOAD_SCRIPT) as {
  countCommentLines: (text: string, path: string) => { comments: number; code: number };
};

const PATH = "src/lib/ledger-union.ts";
// Comment floor at 4c549c5db:src/lib/ledger-union.ts, before compression.
const BEFORE_COMMENT_LINES = 325;

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

function emitted(source: string): string {
  return transformSync(source, { loader: "ts", format: "esm", legalComments: "none" }).code;
}

test("W1-T11307: comment compression preserves executable code", () => {
  const source = readFileSync(join(REPO_ROOT, PATH), "utf8");
  const { comments } = countCommentLines(source, PATH);
  assert.ok(comments < BEFORE_COMMENT_LINES,
    `expected a real reduction from ${BEFORE_COMMENT_LINES} comment lines, observed ${comments}`);
  const before = compressionPinBase(PATH, import.meta.url);
  if (before === undefined) return;
  assertSameTokens(executableTokens(source), executableTokens(before),
    "all PR-base executable tokens, literals and line-break boundaries must remain unchanged");
  assert.equal(emitted(source), emitted(before), "emitted JavaScript must be unchanged");
  assert.ok(comments < countCommentLines(before, PATH).comments, "comment lines decrease from the PR base");
});
