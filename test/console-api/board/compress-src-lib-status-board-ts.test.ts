// @source-text-subject: status-board.ts comment compression preserves executable tokens and output.
// @census-reads: src/lib/status-board.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { transformSync } from "esbuild";
import { assertSameTokens, compressionPinBase } from "#test/helpers/compression-pin.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// Comment floor from df6fdb07b0941efc1afb07eb6b8227c4042377c3 before compression.
const BEFORE = { comments: 666 };

function commentLines(text: string): number {
  return text.split("\n").filter(line => /^(?:\/\/|\/\*|\*)/.test(line.trim())).length;
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

function executableDigest(source: string): string {
  return createHash("sha256").update(JSON.stringify(executableTokens(source))).digest("hex");
}

function emittedDigest(source: string): string {
  const { code } = transformSync(source, { loader: "ts", format: "esm", legalComments: "none", minifyWhitespace: true });
  return createHash("sha256").update(code).digest("hex");
}

test("W1-T11016: comment compression preserves executable code", () => {
  const control = 'const re = /https?:\\/\\//; const s = `// ${name} /* text */`;';
  assert.equal(executableDigest(control), executableDigest(`// explanation\n${control}\n/* detail */`));
  for (const [before, after] of [["name", "other"], ["text", "changed"], ["https?", "http"]]) {
    assert.notEqual(executableDigest(control), executableDigest(control.replace(before, after)));
  }
  assert.notEqual(emittedDigest("function f() { return value; }"),
    emittedDigest("function f() { return\nvalue; }"), "emission detects automatic semicolon insertion");
  const source = readFileSync(join(REPO_ROOT, "src/lib/status-board.ts"), "utf8");
  const comments = commentLines(source);
  assert.ok(comments < BEFORE.comments, `comments must decrease from ${BEFORE.comments}, found ${comments}`);
  const before = compressionPinBase("src/lib/status-board.ts", import.meta.url);
  if (before === undefined) return;
  // Only on the PR that adds this pin: later feature edits to the module stay free.
  assertSameTokens(executableTokens(source), executableTokens(before), "all executable token kinds and spellings survive");
  assert.equal(emittedDigest(source), emittedDigest(before), "emitted JavaScript and ASI behavior survive");
  assert.ok(comments < commentLines(before), "comment lines decrease from the PR base");
});

// Measured before this compression at a82b5df97; comment count, not an executable digest.
test("W1-T12405: comment compression preserves executable code", () => {
  const source = readFileSync(join(REPO_ROOT, "src/lib/status-board.ts"), "utf8");
  assert.ok(commentLines(source) < 645, "comment lines decrease from the pre-compression source (645)");
  const before = compressionPinBase("src/lib/status-board.ts", import.meta.url);
  if (before === undefined) return;
  assertSameTokens(executableTokens(source), executableTokens(before), "executable tokens survive compression");
  assert.equal(emittedDigest(source), emittedDigest(before), "emitted JavaScript and ASI behavior survive");
  assert.ok(commentLines(source) < commentLines(before), "comment lines decrease from the PR base");
});
