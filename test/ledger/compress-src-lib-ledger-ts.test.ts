// @source-text-subject: ledger.ts comment compression must preserve its pre-compression code.
// @census-reads: src/lib/ledger.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { transformSync } from "esbuild";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// scripts/ is outside tsconfig's include; load the real counter with its explicit runtime contract.
const COMMENT_LOAD_SCRIPT = "#scripts/comment-load-ratchet.mjs";
const { countCommentLines } = await import(COMMENT_LOAD_SCRIPT) as {
  countCommentLines: (text: string, path: string) => { comments: number; code: number };
};

// Snapshot: 70f5b3c4fa6ad2ed688b3b7edce8c6e9246aaf06:src/lib/ledger.ts (779 comment lines).
// Fingerprint token kinds, raw literal contents and preceding line breaks (ASI), including types.
// Intentional future code edits must review this pre-compression fingerprint.
const BEFORE_TOKENS_SHA256 = "306d418f8e01342c6d571406c142f33f01b7c9a77ccb5992ccee8b90894aae3c";
const BEFORE_COMMENT_LINES = 779;

function executableTokens(source: string): Array<[SyntaxKind, string, boolean]> {
  const scanner = createScanner(true, undefined, source);
  const tokens: Array<[SyntaxKind, string, boolean]> = [];
  const braceDepths: number[] = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    // As in runtimeSpecifiers: rescan regexes and template substitutions so their contents stay literal.
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

function emittedDigest(source: string): string {
  const { code } = transformSync(source, { loader: "ts", format: "esm", legalComments: "none" });
  return createHash("sha256").update(code).digest("hex");
}

const BEFORE_EMITTED_SHA256 = "2ab339aaae4dc38d65ea05203273aa06c79e7b351fac6e54f5de725a6e11cd46";

test("W1-T10998: comment compression preserves executable code", () => {
  const source = readFileSync(join(REPO_ROOT, "src/lib/ledger.ts"), "utf8");
  // W1-T9853 adds one decision-relevant step so failed-fire history survives rotation.
  // Remove only that reviewed addition before comparing with the pre-compression snapshot.
  const reviewedAddition = '  "auto_triage.run_failed", // W1-T9853: failedFireBackoff derives the per-entry retry from these rows.\n';
  assert.equal(source.split(reviewedAddition).length, 2, "the failed-fire retention row must occur exactly once");
  const preAdditionSource = source.replace(reviewedAddition, "");
  const tokens = executableTokens(preAdditionSource);
  assert.equal(createHash("sha256").update(JSON.stringify(tokens)).digest("hex"), BEFORE_TOKENS_SHA256,
    "all pre-compression executable tokens, literals and line-break boundaries must remain unchanged");
  assert.equal(emittedDigest(preAdditionSource), BEFORE_EMITTED_SHA256,
    "emitted JavaScript must preserve newline-sensitive behavior");
  const { comments } = countCommentLines(source, "src/lib/ledger.ts");
  assert.ok(comments < BEFORE_COMMENT_LINES,
    `expected a real reduction from ${BEFORE_COMMENT_LINES} comment lines, observed ${comments}`);
});

test("ledger compression fingerprint distinguishes comments from executable literals", () => {
  const fixture = 'const re = /https?:\\/\\//; const s = "// kept"; const t = `/* ${`// ${1}`} */`;';
  const tokens = executableTokens(fixture);
  assert.deepEqual(executableTokens(fixture + " /* extra comment */"), tokens);
  for (const changed of [fixture.replace("https?", "http"), fixture.replace("// kept", "// changed"),
    fixture.replace("${1}", "${2}")]) {
    assert.notDeepEqual(executableTokens(changed), tokens);
  }
  assert.notEqual(emittedDigest("function f() { return 1; }"),
    emittedDigest("function f() { return\n1; }"));
});
