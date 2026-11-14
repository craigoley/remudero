// @source-text-subject: executable tokens, syntax and comment volume in tick-read-worker.ts.
// @census-reads: src/lib/tick-read-worker.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "@babel/parser";
import { assertSameTokens, compressionPinBase } from "#test/helpers/compression-pin.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function snapshot(source: string) {
  const parsed = parse(source, {
    sourceType: "module", plugins: ["typescript"], tokens: true, attachComment: false,
  });
  const tokens = parsed.tokens!.filter((token) => typeof token.type !== "string")
    .map((token) => [token.type.label, source.slice(token.start, token.end)]);
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    tokens,
    tokenCount: tokens.length,
    tokenDigest: digest(JSON.stringify(tokens)),
    // Preserve newline-sensitive syntax, including automatic semicolon insertion.
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: source.split("\n").filter((line) => /^(?:\/\/|\/\*|\*)/.test(line.trim())).length,
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T12339: comment compression preserves executable code", (t) => {
  const sourcePath = "src/lib/tick-read-worker.ts";
  let before = compressionPinBase(sourcePath, import.meta.url);
  if (before === undefined) {
    // This pin extends an existing test file, which compressionPinBase does not activate.
    // Compare while this proof is absent at the merge base; retire it after merge so later
    // executable edits remain free, just as they do for newly added compression pins.
    const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
    const base = git("merge-base", "origin/main", "HEAD").trim();
    const oldTest = git("show", `${base}:test/infra/compress-src-lib-tick-read-worker-ts.test.ts`);
    if (oldTest.includes("W1-T12339: comment compression preserves executable code")) return;
    before = git("show", `${base}:${sourcePath}`);
  }
  const actual = snapshot(readFileSync(join(REPO_ROOT, sourcePath), "utf8"));
  const base = snapshot(before);
  t.diagnostic(`comment lines ${base.commentLines} -> ${actual.commentLines}; bytes ${base.commentBytes} -> ${actual.commentBytes}`);
  assertSameTokens(actual.tokens, base.tokens, "executable tokens match the pre-compression source");
  assert.equal(actual.astDigest, base.astDigest, "newline-sensitive syntax is preserved");
  assert.ok(actual.commentLines < base.commentLines, "comment lines decrease from the pre-compression source");
  assert.ok(actual.commentBytes < base.commentBytes, "comment bytes decrease from the pre-compression source");
});

test("W1-T10963: comment compression preserves executable code", () => {
  // Frozen before compression at f134daa07bf5ca8467f7c699968ef6e2051b6e5a.
  // Comparative evidence for this edit, not a new comment-volume ceiling.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/tick-read-worker.ts"), "utf8"));
  const before = compressionPinBase("src/lib/tick-read-worker.ts", import.meta.url);
  if (before !== undefined) {
    // Only on the PR that adds this pin: later feature edits to the module stay free.
    const base = snapshot(before);
    assert.deepEqual([actual.tokenCount, actual.tokenDigest, actual.astDigest],
      [base.tokenCount, base.tokenDigest, base.astDigest], "executable tokens and syntax match the PR base");
    assert.ok(actual.commentLines < base.commentLines, "comment lines decrease from the PR base");
  }
  assert.ok(actual.commentLines < 1053, `comment lines must decrease from 1053; got ${actual.commentLines}`);
  assert.ok(actual.commentBytes < 82761, `comment bytes must decrease from 82761; got ${actual.commentBytes}`);

  const fixture = 'const re = /https?:\\/\\//; const s = "// kept"; const t = `/* ${`// ${1}`} */`;';
  const original = snapshot(fixture);
  const commented = snapshot(`/** extra */\n${fixture}\n// extra`);
  assert.equal(commented.tokenDigest, original.tokenDigest);
  assert.equal(commented.astDigest, original.astDigest);
  for (const changed of [fixture.replace("https?", "http"), fixture.replace("// kept", "// changed"),
    fixture.replace("${1}", "${2}")]) {
    assert.notEqual(snapshot(changed).tokenDigest, original.tokenDigest);
  }
  assert.notEqual(snapshot("function f() { return 1; }").astDigest,
    snapshot("function f() { return\n1; }").astDigest);
});
