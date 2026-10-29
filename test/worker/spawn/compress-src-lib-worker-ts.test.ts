// @source-text-subject: worker.ts comment compression must preserve its pre-compression code.
// @census-reads: src/lib/worker.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { countCommentLines } from "#scripts/comment-load-ratchet.mjs";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// Snapshot at 3b28ef9e3, before compression: 2,018 comment lines (the filing measured 2,008).
// Fingerprint token kinds, raw literal contents and preceding line breaks (ASI), including types.
// Intentional future code edits must review this pre-compression fingerprint.
const BEFORE_TOKENS_SHA256 = "72db6076a400b40434b831299e52b4ace83e910d641d124a7bffc9424758148a";
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

test("W1-T10879: comment compression preserves executable code", () => {
  const source = readFileSync(join(REPO_ROOT, "src/lib/worker.ts"), "utf8");
  const tokens = executableTokens(source);
  assert.equal(createHash("sha256").update(JSON.stringify(tokens)).digest("hex"), BEFORE_TOKENS_SHA256,
    "all pre-compression executable tokens, literals and line-break boundaries must remain unchanged");
  const { comments } = countCommentLines(source, "src/lib/worker.ts");
  assert.ok(comments < BEFORE_COMMENT_LINES,
    `expected a real reduction from ${BEFORE_COMMENT_LINES} comment lines, observed ${comments}`);
});
