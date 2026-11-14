// @source-text-subject: compare status.ts comments, tokens and emitted JavaScript against the PR base.
// @census-reads: src/lib/status.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { transformSync } from "esbuild";
import { assertSameTokens, compressionPinBase } from "#test/helpers/compression-pin.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function commentLines(source: string): number {
  return source.split("\n").filter(line => /^(?:\/\/|\/\*|\*)/.test(line.trim())).length;
}

function executableTokens(source: string): Array<[number, string]> {
  const scanner = createScanner(true, undefined, source);
  const tokens: Array<[number, string]> = [];
  const braces: number[] = [];
  let previous = "=";
  for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
    if ((token === SyntaxKind.SlashToken || token === SyntaxKind.SlashEqualsToken) &&
        /^(?:=|\(|\[|\{|,|:|\?|return|case|=>|!|&&|\|\||\?\?)$/.test(previous)) {
      token = scanner.reScanSlashToken();
    }
    if (token === SyntaxKind.TemplateHead) braces.push(0);
    else if (token === SyntaxKind.OpenBraceToken && braces.length) braces[braces.length - 1]++;
    else if (token === SyntaxKind.CloseBraceToken && braces.length) {
      if (braces[braces.length - 1] === 0) {
        token = scanner.reScanTemplateToken(false);
        if (token === SyntaxKind.TemplateTail) braces.pop();
      } else braces[braces.length - 1]--;
    }
    assert.ok(scanner.getTokenEnd() > scanner.getTokenStart(), "scanner must advance");
    tokens.push([token, scanner.getTokenText()]);
    previous = scanner.getTokenText();
  }
  assert.ok(tokens.length > 0, "the token corpus must be nonempty");
  return tokens;
}

function emitted(source: string): string {
  return transformSync(source, { loader: "ts", format: "esm", legalComments: "none" }).code;
}

test("W1-T12285: comment compression preserves executable code", () => {
  const control = 'const re = /https?:\\/\\//; const s = `// ${name} /* text */`;';
  assertSameTokens(executableTokens(control), executableTokens(`// detail\n${control}\n/* detail */`),
    "comment-only edits preserve tokens");
  for (const [before, after] of [["name", "other"], ["text", "changed"], ["https?", "http"]]) {
    assert.throws(() => assertSameTokens(executableTokens(control),
      executableTokens(control.replace(before, after)), "executable edits must differ"), assert.AssertionError);
  }
  assert.notEqual(emitted("function f() { return value; }"), emitted("function f() { return\nvalue; }"),
    "emission detects automatic semicolon insertion");
  const before = compressionPinBase("src/lib/status.ts", import.meta.url);
  // This comparison belongs to this PR; later feature edits must not inherit a frozen pin.
  if (before === undefined) return;
  const source = readFileSync(join(REPO_ROOT, "src/lib/status.ts"), "utf8");
  assertSameTokens(executableTokens(source), executableTokens(before), "all executable tokens survive");
  assert.equal(emitted(source), emitted(before), "emitted JavaScript and ASI behavior survive");
  assert.ok(commentLines(source) < commentLines(before),
    `comment lines must decrease: before=${commentLines(before)}, after=${commentLines(source)}`);
});
