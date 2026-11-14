// @source-text-subject: task-linter comment volume and executable syntax (W1-T12300).
// @census-reads: src/lib/task-linter.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "@babel/parser";
import { grepProofTargetRefusal } from "#src/lib/task-linter.js";
import { assertSameTokens, compressionPinBase } from "#test/helpers/compression-pin.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function snapshot(source: string) {
  const parsed = parse(source, {
    sourceType: "module", plugins: ["typescript"], tokens: true, attachComment: false,
  });
  return {
    tokens: parsed.tokens!.filter((token) => typeof token.type !== "string")
      .map((token) => [token.type.label, source.slice(token.start, token.end)]),
    ast: createHash("sha256").update(JSON.stringify(parsed.program,
      (key, value) => ["start", "end", "loc", "extra"].includes(key) ? undefined : value)).digest("hex"),
    lines: parsed.comments!.reduce((n, c) => n + source.slice(c.start!, c.end!).split("\n").length, 0),
    bytes: parsed.comments!.reduce((n, c) => n + Buffer.byteLength(source.slice(c.start!, c.end!)), 0),
  };
}

test("W1-T12300: comment compression preserves executable code", () => {
  assert.equal(grepProofTargetRefusal("hooks/pre-push", () => "file"), undefined);
  assert.match(grepProofTargetRefusal("src/lib", () => "directory")!, /is a directory/);
  assert.match(grepProofTargetRefusal("typo.ts", () => "absent")!, /does not exist/);
  assert.equal(grepProofTargetRefusal("src/lib/task-linter.ts"), undefined);
  const sourcePath = "src/lib/task-linter.ts";
  const before = compressionPinBase(sourcePath, import.meta.url);
  // Only this compression PR is pinned; subsequent feature edits remain free.
  if (before === undefined) return;
  const base = snapshot(before);
  const actual = snapshot(readFileSync(join(REPO_ROOT, sourcePath), "utf8"));
  assertSameTokens(actual.tokens, base.tokens, "task-linter executable tokens match the PR base");
  assert.equal(actual.ast, base.ast, "newline-sensitive executable syntax matches the PR base");
  assert.ok(actual.lines < base.lines, "comment lines decrease from the PR base");
  assert.ok(actual.bytes < base.bytes, "comment bytes decrease from the PR base");
});
