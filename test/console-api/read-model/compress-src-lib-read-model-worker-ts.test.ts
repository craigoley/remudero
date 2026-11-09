// @source-text-subject: read-model-worker.ts comment compression and executable-token preservation.
// @census-reads: src/lib/read-model-worker.ts
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
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    tokens: digest(tokens),
    syntax: digest(JSON.parse(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value))),
    lines: parsed.comments!.reduce((n, c) => n + source.slice(c.start!, c.end!).split("\n").length, 0),
    bytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T11218: comment compression preserves executable code", (t) => {
  const fixture = 'const re = /https?:\\/\\//; const s = "// kept"; const t = `/* ${`// ${1}`} */`;';
  const control = snapshot(fixture);
  const commented = snapshot(`/** explanation */\n${fixture}\n// detail`);
  assert.equal(control.tokens, commented.tokens);
  assert.equal(control.syntax, commented.syntax);
  assert.ok(control.lines < commented.lines && control.bytes < commented.bytes);
  for (const [before, after] of [["https?", "http"], ["// kept", "// changed"], ["${1}", "${2}"]]) {
    assert.notEqual(snapshot(fixture.replace(before, after)).tokens, control.tokens);
  }
  assert.notEqual(snapshot("function f() { return 1; }").syntax,
    snapshot("function f() { return\n1; }").syntax, "syntax detects automatic semicolon insertion");

  const before = compressionPinBase("src/lib/read-model-worker.ts", import.meta.url);
  if (before === undefined) return; // This PR's pin must not freeze later feature edits.
  const base = snapshot(before);
  const actual = snapshot(readFileSync(join(REPO_ROOT, "src/lib/read-model-worker.ts"), "utf8"));
  assert.equal(actual.tokens, base.tokens, "executable token kinds and spellings survive");
  assert.equal(actual.syntax, base.syntax, "syntax and newline-sensitive behavior survive");
  assert.ok(actual.lines < base.lines, `comment lines decrease: ${base.lines} -> ${actual.lines}`);
  assert.ok(actual.bytes < base.bytes, `comment bytes decrease: ${base.bytes} -> ${actual.bytes}`);
  t.diagnostic(`comments: ${base.lines} -> ${actual.lines} lines; ${base.bytes} -> ${actual.bytes} bytes`);
});
