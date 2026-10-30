// @source-text-subject: ci-parity.ts comment compression must preserve its pre-compression code.
// @census-reads: src/lib/ci-parity.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// scripts/ is outside tsconfig's include; load the real counter with its explicit runtime contract.
const COMMENT_LOAD_SCRIPT = "#scripts/comment-load-ratchet.mjs";
const { countCommentLines } = await import(COMMENT_LOAD_SCRIPT) as {
  countCommentLines: (text: string, path: string) => { comments: number; code: number };
};

// Snapshot at f134daa07bf5ca8467f7c699968ef6e2051b6e5a, before compression: 912 comment lines.
// Fingerprint token kinds, raw literal contents and preceding line breaks (ASI), including types.
// Intentional future code edits must review this pre-compression fingerprint.
const BEFORE_TOKENS_SHA256 = "80c7fec79de760aecfb0485bafb2de36c54a274ebaa8afd2151c4bcc3dd3f248";
const BEFORE_COMMENT_LINES = 912;

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

test("W1-T10969: comment compression preserves executable code", () => {
  const control = 'const re = /https?:\\/\\//; const s = `// ${name} /* text */`;';
  assert.deepEqual(executableTokens(control), executableTokens(`/* explanation */ ${control}`));
  for (const [before, after] of [["name", "other"], ["text", "changed"], ["https?", "http"]]) {
    assert.notDeepEqual(executableTokens(control), executableTokens(control.replace(before, after)));
  }
  assert.notDeepEqual(executableTokens("return value"), executableTokens("return\nvalue"));
  const source = readFileSync(join(REPO_ROOT, "src/lib/ci-parity.ts"), "utf8");
  const tokens = executableTokens(source);
  assert.equal(createHash("sha256").update(JSON.stringify(tokens)).digest("hex"), BEFORE_TOKENS_SHA256,
    "all pre-compression executable tokens, literals and line-break boundaries must remain unchanged");
  const { comments } = countCommentLines(source, "src/lib/ci-parity.ts");
  assert.ok(comments < BEFORE_COMMENT_LINES,
    `expected a real reduction from ${BEFORE_COMMENT_LINES} comment lines, observed ${comments}`);
});
