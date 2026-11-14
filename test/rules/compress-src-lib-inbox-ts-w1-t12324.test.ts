// @source-text-subject: inbox.ts comment reduction and executable token preservation (W1-T12324).
// @census-reads: src/lib/inbox.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { assertSameTokens, compressionPinBase } from "#test/helpers/compression-pin.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function commentLines(source: string): number {
  return source.split("\n").filter((line) => /^(?:\/\/|\/\*|\*)/.test(line.trim())).length;
}

function executableTokens(source: string): Array<[SyntaxKind, string, boolean]> {
  const scanner = createScanner(true, undefined, source);
  const tokens: Array<[SyntaxKind, string, boolean]> = [];
  const braces: number[] = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if ((kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) &&
        /^(?:=|\(|\[|\{|,|:|\?|return|case|=>|!|&&|\|\||\?\?)$/.test(tokens.at(-1)?.[1] ?? "=")) {
      kind = scanner.reScanSlashToken();
    }
    if (kind === SyntaxKind.TemplateHead) braces.push(0);
    else if (kind === SyntaxKind.OpenBraceToken && braces.length) braces[braces.length - 1]++;
    else if (kind === SyntaxKind.CloseBraceToken && braces.length) {
      if (braces.at(-1) === 0) {
        kind = scanner.reScanTemplateToken(false);
        if (kind === SyntaxKind.TemplateTail) braces.pop();
      } else braces[braces.length - 1]--;
    }
    assert.ok(scanner.getTokenEnd() > scanner.getTokenStart(), "scanner must advance");
    tokens.push([kind, scanner.getTokenText(), scanner.hasPrecedingLineBreak()]);
  }
  assert.ok(tokens.length > 0, "the token corpus must be nonempty");
  return tokens;
}

test("W1-T12324: comment compression preserves executable code", () => {
  const control = 'const re = /https?:\\/\\//; const s = `// ${name} /* text */`;';
  assertSameTokens(executableTokens(control), executableTokens(`/* explanation */ ${control}`),
    "comments do not change executable tokens");
  for (const [before, after] of [["name", "other"], ["text", "changed"], ["https?", "http"]]) {
    assert.throws(() => assertSameTokens(executableTokens(control),
      executableTokens(control.replace(before, after)), "executable changes must be detected"),
    assert.AssertionError);
  }
  assert.throws(() => assertSameTokens(executableTokens("return\nvalue"),
    executableTokens("return value"), "line-break changes must be detected"), assert.AssertionError);
  const before = compressionPinBase("src/lib/inbox.ts", import.meta.url);
  if (before === undefined) return;
  const source = readFileSync(join(REPO_ROOT, "src/lib/inbox.ts"), "utf8");
  assertSameTokens(executableTokens(source), executableTokens(before),
    "all PR-base executable token kinds, spellings and line-break boundaries must survive");
  assert.ok(commentLines(source) < commentLines(before),
    `comment lines must decrease from ${commentLines(before)}, found ${commentLines(source)}`);
});
