// @source-text-subject: status-board.ts comment compression preserves executable tokens and output.
// @census-reads: src/lib/status-board.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { assertSameTokens, compressionPinBase } from "#test/helpers/compression-pin.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { commentLines, emittedDigest, executableTokens } from "#test/console-api/board/compress-src-lib-status-board-ts.test.js";

test("W1-T12405: comment compression preserves executable code", () => {
  const source = readFileSync(join(REPO_ROOT, "src/lib/status-board.ts"), "utf8");
  assert.ok(commentLines(source) < 645, "comment lines decrease from the pre-compression source (645)");
  // This newly added pin activates on this PR; later feature edits remain free.
  const before = compressionPinBase("src/lib/status-board.ts", import.meta.url);
  if (before === undefined) return;
  assertSameTokens(executableTokens(source), executableTokens(before), "executable tokens survive compression");
  assert.equal(emittedDigest(source), emittedDigest(before), "emitted JavaScript and ASI behavior survive");
  assert.ok(commentLines(source) < commentLines(before), "comment lines decrease from the PR base");
});
