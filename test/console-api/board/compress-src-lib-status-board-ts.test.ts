// @source-text-subject: status-board.ts comment compression preserves executable tokens and output.
// @census-reads: src/lib/status-board.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { transformSync } from "esbuild";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// Frozen from df6fdb07b0941efc1afb07eb6b8227c4042377c3 before compression.
const BEFORE = {
  comments: 666,
  tokens: "58187cdaae0dc2b9982bb3c3b51225e2880f2dcffe5b58fd70ef5cd720ffd135",
  emitted: "0134268ba477688e872c48bd93ecda0fd34c5a8bae5b83d0eddd25a7d85c6872",
};

function executableDigest(source: string): string {
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
  return createHash("sha256").update(JSON.stringify(tokens)).digest("hex");
}

function emittedDigest(source: string): string {
  const { code } = transformSync(source, { loader: "ts", format: "esm", legalComments: "none" });
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
  assert.equal(executableDigest(source), BEFORE.tokens, "all executable token kinds and spellings survive");
  assert.equal(emittedDigest(source), BEFORE.emitted, "emitted JavaScript and ASI behavior survive");
  const comments = source.split("\n").filter(line => /^(?:\/\/|\/\*|\*)/.test(line.trim())).length;
  assert.ok(comments < BEFORE.comments, `comments must decrease from ${BEFORE.comments}, found ${comments}`);
});
