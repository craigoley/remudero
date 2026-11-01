import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// @source-text-subject: this task preserves status.ts tokens while compressing its comments.
// Frozen before compression at dde8a92c463ea090413f985c5d7d8c6a67f6c5e3; no moving git ref.
// Regenerated for the observed-overlap producer, which moves prOwningTaskIds out of projectPlan (operator ruling
// 2026-11-01). The comment-reduction threshold stays fixed.
const BEFORE = { comments: 1798, tokens: "e6e0928d925dcde36a3d9b3952597e25c1c3c551e0e4f36a0ec3a27370f8570c" };

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
  // For a .ts file, the comment-load measure counts lines starting with //, /*, or *.
  const comments = source.split("\n").filter((line) => /^(?:\/\/|\/\*|\*)/.test(line.trim())).length;
  assert.ok(comments < BEFORE.comments, `comments must decrease from ${BEFORE.comments}, found ${comments}`);
});
