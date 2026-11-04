// @source-text-subject: worker-home.ts comment compression preserves pre-compression executable code.
// @census-reads: src/lib/worker-home.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { compressionPinBase } from "#test/helpers/compression-pin.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const COMMENT_LOAD_SCRIPT = "#scripts/comment-load-ratchet.mjs";
const { countCommentLines } = await import(COMMENT_LOAD_SCRIPT) as {
  countCommentLines: (text: string, path: string) => { comments: number; code: number };
};

// Pre-compression snapshot: cdb5188e7f81427f9ad041a1249ee539621c67db.
// Future executable edits require review of this fingerprint, including ASI boundaries and types.
const BEFORE_COMMENT_LINES = 519;

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

test("W1-T11050: comment compression preserves executable code", () => {
  const control = 'const re = /https?:\\/\\//; const s = `// ${name} /* text */`;';
  assert.deepEqual(executableTokens(control), executableTokens(`/* explanation */ ${control}`));
  for (const [before, after] of [["name", "other"], ["text", "changed"], ["https?", "http"]]) {
    assert.notDeepEqual(executableTokens(control), executableTokens(control.replace(before, after)));
  }
  assert.notDeepEqual(executableTokens("return value"), executableTokens("return\nvalue"));
  const source = readFileSync(join(REPO_ROOT, "src/lib/worker-home.ts"), "utf8");
  const before = compressionPinBase("src/lib/worker-home.ts", import.meta.url);
  if (before !== undefined) {
    // Only on the PR that adds this pin: later feature edits to the module stay free (#16082).
    assert.equal(createHash("sha256").update(JSON.stringify(executableTokens(source))).digest("hex"),
      createHash("sha256").update(JSON.stringify(executableTokens(before))).digest("hex"),
      "pre-compression executable tokens, literals and line breaks must survive");
  }
  const { comments } = countCommentLines(source, "src/lib/worker-home.ts");
  assert.ok(comments < BEFORE_COMMENT_LINES,
    `expected a real reduction from ${BEFORE_COMMENT_LINES} comment lines, observed ${comments}`);
});
