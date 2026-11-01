// @source-text-subject: inbox.ts comment compression preserves the approved executable tokens.
// @census-reads: src/lib/inbox.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// Comment count was frozen before compression at f134daa07bf5ca8467f7c699968ef6e2051b6e5a.
// W1-T10876 intentionally changed executable tokens to record draft model attribution; pin that result.
const BEFORE_COMMENTS = 1059;
const APPROVED_TOKENS = "14be39081dd6a6f00f028e431d473bcded8355d1281aec4fa1f55c0b4a68d345";

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
  assert.equal(executableDigest(source), APPROVED_TOKENS,
    "all approved executable token kinds, spellings and line-break boundaries must survive");
  // Match the repository's .ts comment-load measure; this is a reduction, not a new ceiling.
  const comments = source.split("\n").filter((line) => /^(?:\/\/|\/\*|\*)/.test(line.trim())).length;
  assert.ok(comments < BEFORE_COMMENTS, `comments must decrease from ${BEFORE_COMMENTS}, found ${comments}`);
});
