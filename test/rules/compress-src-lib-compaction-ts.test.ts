// @source-text-subject: compaction.ts comment compression preserves executable tokens and syntax.
// @census-reads: src/lib/compaction.ts
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
const SOURCE_PATH = "src/lib/compaction.ts";

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

function emittedCode(source: string): string {
  return transformSync(source, {
    loader: "ts", format: "esm", legalComments: "none", minifyWhitespace: true,
  }).code;
}

test("W1-T11298: comment compression preserves executable code", () => {
  const source = readFileSync(join(REPO_ROOT, SOURCE_PATH), "utf8");
  const before = compressionPinBase(SOURCE_PATH, import.meta.url);
  if (before === undefined) return;
  assertSameTokens(executableTokens(source), executableTokens(before),
    "executable tokens, literal contents, types and line-break boundaries match the PR base");
  assert.equal(emittedCode(source), emittedCode(before), "emitted JavaScript stays identical");
  const comments = countCommentLines(source, SOURCE_PATH).comments;
  const previousComments = countCommentLines(before, SOURCE_PATH).comments;
  assert.ok(comments > 0 && previousComments > 0, "both sources retain measured comments");
  assert.ok(comments < previousComments,
    `comment lines decrease from the PR base: ${comments} >= ${previousComments}`);
  assert.ok(source.length < before.length, "compression removes prose rather than merely rewrapping it");
});

test("compaction compression fingerprint preserves literals and newline-sensitive behavior", () => {
  const fixture = 'const re = /https?:\\/\\//; const s = "// kept"; const t = `/* ${`// ${1}`} */`;';
  const tokens = executableTokens(fixture);
  assert.deepEqual(executableTokens(fixture + " /* extra comment */"), tokens);
  for (const changed of [fixture.replace("https?", "http"), fixture.replace("// kept", "// changed"),
    fixture.replace("${1}", "${2}")]) {
    assert.notDeepEqual(executableTokens(changed), tokens);
  }
  assert.notEqual(emittedCode("function f() { return 1; }"),
    emittedCode("function f() { return\n1; }"));
});
