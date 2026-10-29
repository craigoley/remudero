import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { countCommentLines } from "#scripts/comment-load-ratchet.mjs";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// @source-text-subject: this task preserves status.ts tokens while compressing its comments.
// Frozen before compression at dde8a92c463ea090413f985c5d7d8c6a67f6c5e3; no moving git ref.
const BEFORE = { comments: 1798, tokens: "3bad233be41eea7b48449da606a005dc14aa7c1b2bbef5f1093169f411a27b23" };

function executableDigest(text: string): string {
  const scanner = createScanner(true, undefined, text);
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
  return createHash("sha256").update(JSON.stringify(tokens)).digest("hex");
}

test("W1-T10884: comment compression preserves executable code", () => {
  const source = readFileSync(join(REPO_ROOT, "src/lib/status.ts"), "utf8");
  const control = 'const re = /https?:\\/\\//; const s = `// ${name} /* text */`;';
  assert.equal(executableDigest(control), executableDigest(`// explanation\n${control}\n/* detail */`));
  assert.notEqual(executableDigest(control), executableDigest(control.replace("name", "other")));
  assert.notEqual(executableDigest(control), executableDigest(control.replace("text", "changed")));
  assert.notEqual(executableDigest(control), executableDigest(control.replace("https?", "http")));
  assert.equal(executableDigest(source), BEFORE.tokens, "all executable token kinds and spellings must survive");
  const { comments } = countCommentLines(source, "src/lib/status.ts");
  assert.ok(comments < BEFORE.comments, `comments must decrease from ${BEFORE.comments}, found ${comments}`);
});
