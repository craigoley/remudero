// @source-text-subject: github-transport.ts comment compression and executable-token preservation.
// @census-reads: src/lib/github-transport.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "@babel/parser";
import { compressionPinBase } from "#test/helpers/compression-pin.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function snapshot(source: string) {
  const parsed = parse(source, {
    sourceType: "module", plugins: ["typescript"], tokens: true, attachComment: false,
  });
  const tokens = parsed.tokens!.filter(token => typeof token.type !== "string")
    .map(token => [token.type.label, source.slice(token.start, token.end)]);
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    tokenCount: tokens.length,
    tokenDigest: digest(JSON.stringify(tokens)),
    astDigest: digest(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)),
    commentLines: source.split("\n").filter(line => /^(?:\/\/|\/\*|\*)/.test(line.trim())).length,
    commentBytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T11059: comment compression preserves executable code", () => {
  // W1-T11103: compare the declared fresh-read edit with this PR's base.
  const source = readFileSync(join(REPO_ROOT, "src/lib/github-transport.ts"), "utf8");
  const actual = snapshot(source);
  // Remove only this task's declared behavior and retain the original compression identity proof.
  const withoutFresh = source
    .replace("env?: NodeJS.ProcessEnv; fresh?: true } = {}", "env?: NodeJS.ProcessEnv } = {}")
    .replace('${opts.fresh === true ? "fresh:" : ""}${JSON.stringify(args)}', '${JSON.stringify(args)}')
    .replace("ghBrokeredAsync(args, opts, env)", "ghBrokeredAsync(args, {}, env)");
  const originalTransport = snapshot(withoutFresh);
  const before = compressionPinBase("src/lib/github-transport.ts", import.meta.url);
  if (before !== undefined) {
    const base = snapshot(before);
    assert.deepEqual(
      [originalTransport.tokenCount, originalTransport.tokenDigest, originalTransport.astDigest],
      [base.tokenCount, base.tokenDigest, base.astDigest],
      "removing only this task's fresh-read behavior restores the PR base executable code",
    );
  }
  assert.ok(actual.commentLines > 0 && actual.commentLines < 439,
    `comment lines must decrease from 439, found ${actual.commentLines}`);
  assert.ok(actual.commentBytes > 0 && actual.commentBytes < 35881,
    "comment bytes must decrease; rewrapping alone is insufficient");

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
