// @source-text-subject: inbox.ts comment compression preserves the pre-edit executable tokens.
// @census-reads: src/lib/inbox.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// Frozen before compression at f134daa07bf5ca8467f7c699968ef6e2051b6e5a; no moving branch ref.
const BEFORE = { comments: 1059, tokens: "a3f45aea9c004bfc40bbd2fcf15291c397525d1c15b7374b972caf5f55a865a5" };

function executableDigest(source: string): string {
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
  return createHash("sha256").update(JSON.stringify(tokens)).digest("hex");
}

test("W1-T10939: comment compression preserves executable code", () => {
  const control = 'const re = /https?:\\/\\//; const s = `// ${name} /* text */`;';
  assert.equal(executableDigest(control), executableDigest(`/* explanation */ ${control}`));
  for (const [before, after] of [["name", "other"], ["text", "changed"], ["https?", "http"]]) {
    assert.notEqual(executableDigest(control), executableDigest(control.replace(before, after)));
  }
  assert.notEqual(executableDigest("return\nvalue"), executableDigest("return value"));
  const source = readFileSync(join(REPO_ROOT, "src/lib/inbox.ts"), "utf8");
  assert.equal(executableDigest(source), BEFORE.tokens,
    "all executable token kinds, spellings and line-break boundaries must survive");
  // Match the repository's .ts comment-load measure; this is a reduction, not a new ceiling.
  const comments = source.split("\n").filter((line) => /^(?:\/\/|\/\*|\*)/.test(line.trim())).length;
  assert.ok(comments < BEFORE.comments, `comments must decrease from ${BEFORE.comments}, found ${comments}`);
});
