// @source-text-subject: measurement-cadence.ts executable tokens, syntax and comment volume.
// @census-reads: src/lib/measurement-cadence.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
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
    tokenCount: tokens.length,
    tokenDigest: digest(JSON.stringify(tokens)),
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: source.split("\n").filter((line) => /^(?:\/\/|\/\*|\*)/.test(line.trim())).length,
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T12387: comment compression preserves executable code", (t) => {
  const sourcePath = "src/lib/measurement-cadence.ts";
  const source = readFileSync(join(REPO_ROOT, sourcePath), "utf8");
  let before = compressionPinBase(sourcePath, import.meta.url);
  if (before === undefined) {
    // A second pin in an existing file retires when its own title reaches main.
    const git = (args: string[]) => {
      const result = spawnSync("git", args, {
        cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(result.status, 0, `git ${args[0]} failed: ${result.error ?? result.stderr}`);
      return result.stdout;
    };
    const base = git(["merge-base", "origin/main", "HEAD"]).trim();
    if (git(["show", `${base}:test/daemon/compress-src-lib-measurement-cadence-ts.test.ts`])
      .includes("W1-T12387: comment compression preserves executable code")) return;
    before = git(["show", `${base}:${sourcePath}`]);
  }
  const tokens = (text: string) => parse(text, {
    sourceType: "module", plugins: ["typescript"], tokens: true, attachComment: false,
  }).tokens!.filter(token => typeof token.type !== "string")
    .map(token => [token.type.label, text.slice(token.start, token.end)]);
  assertSameTokens(tokens(source), tokens(before), "executable tokens match the PR base");
  const actual = snapshot(source);
  const previous = snapshot(before);
  assert.equal(actual.astDigest, previous.astDigest, "syntax and ASI match the PR base");
  t.diagnostic(`comment lines: ${previous.commentLines} -> ${actual.commentLines}`);
  assert.ok(previous.commentLines > 0 && actual.commentLines > 0, "both measurements see comments");
  assert.ok(actual.commentLines < previous.commentLines, "comment lines decrease from the PR base");
  assert.ok(actual.commentBytes < previous.commentBytes, "comment bytes decrease, beyond rewrapping");
});

test("W1-T11007: comment compression preserves executable code", () => {
  // Frozen before compression at 6f907f51a9e0158b48f68838ebd5590621c386f7.
  // Comparative evidence for this edit, not a new hard comment ceiling.
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/measurement-cadence.ts"), "utf8"));
  const before = compressionPinBase("src/lib/measurement-cadence.ts", import.meta.url);
  if (before !== undefined) {
    // Only on the PR that adds this pin: later feature edits to the module stay free.
    const base = snapshot(before);
    assert.deepEqual([actual.tokenCount, actual.tokenDigest, actual.astDigest],
      [base.tokenCount, base.tokenDigest, base.astDigest], "executable tokens and syntax match the PR base");
    assert.ok(actual.commentLines < base.commentLines, "comment lines decrease from the PR base");
  }
  assert.ok(actual.commentLines < 756, `comment lines must decrease from 756; got ${actual.commentLines}`);
  assert.ok(actual.commentBytes < 62677, `comment bytes must decrease from 62677; got ${actual.commentBytes}`);

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
