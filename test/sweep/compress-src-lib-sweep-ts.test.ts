import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { countCommentLines } from "#scripts/comment-load-ratchet.mjs";
import { stripComments } from "#src/lib/test-placement.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// @source-text-subject: this task changes source prose and must preserve every code line.
// Captured before compression at dde8a92c463ea090413f985c5d7d8c6a67f6c5e3.
const BEFORE = {
  comments: 5403,
  codeLines: 19610,
  codeHash: "d0f53000d9cc21cdc51f25515624fc67c0b2aa61fa67788f30b38ee11fae887a",
};

function executableLines(source: string): string {
  return stripComments(source).split("\n").map(line => line.trimEnd())
    .filter(line => line.trim()).join("\n");
}

test("W1-T10821: comment compression preserves executable code", () => {
  const source = readFileSync(join(REPO_ROOT, "src/lib/sweep.ts"), "utf8");
  const code = executableLines(source);
  assert.equal(code.split("\n").length, BEFORE.codeLines);
  assert.equal(createHash("sha256").update(code).digest("hex"), BEFORE.codeHash,
    "all non-comment code lines, including literal contents and types, must remain identical");
  const { comments } = countCommentLines(source, "src/lib/sweep.ts");
  assert.ok(comments > 0, "the measurement must see the retained comments");
  assert.ok(comments < BEFORE.comments,
    `comments must decrease from the measured pre-compression source: ${comments} >= ${BEFORE.comments}`);
});

test("the compression fingerprint retains literals and detects executable edits", () => {
  const source = 'const url = "https://example.com"; // explanation\nconst n = 1;';
  assert.equal(executableLines(source), 'const url = "https://example.com";\nconst n = 1;');
  assert.equal(executableLines(source), executableLines(source.replace("explanation", "shorter")));
  assert.notEqual(executableLines(source), executableLines(source.replace("n = 1", "n = 2")));
  assert.notEqual(executableLines(source), executableLines(source.replace("example.com", "other.test")));
});
