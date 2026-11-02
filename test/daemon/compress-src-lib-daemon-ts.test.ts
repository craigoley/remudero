// @source-text-subject: compare daemon.ts's executable text and comment volume before/after compression.
// @census-reads: src/lib/daemon.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { transformSync } from "esbuild";
import { stripComments } from "#src/lib/test-placement.js";
import { compressionPinBase } from "#test/helpers/compression-pin.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// This executable script has no declaration file; load its real export with an explicit type.
const { countCommentLines } = await import(import.meta.resolve("#scripts/comment-load-ratchet.mjs")) as {
  countCommentLines: (text: string, path: string) => { comments: number; code: number };
};

// Comment floor from 8c654c1a3cf7265719d1162ac1862ffd77c41f91:src/lib/daemon.ts, before compression.
// Keep code lines (including types and punctuation); only blank lines and trailing spaces are ignored.
function executableDigest(source: string): string {
  const code = stripComments(source).split("\n").map(line => line.trimEnd())
    .filter(line => line.trim().length > 0).join("\n");
  return createHash("sha256").update(code).digest("hex");
}

const BEFORE_COMMENTS = 2085;

function emittedDigest(source: string): string {
  const { code } = transformSync(source, { loader: "ts", format: "esm", legalComments: "none" });
  return createHash("sha256").update(code).digest("hex");
}

test("W1-T10871: comment compression preserves executable code", () => {
  const source = readFileSync(join(REPO_ROOT, "src/lib/daemon.ts"), "utf8");
  const { comments } = countCommentLines(source, "src/lib/daemon.ts");
  assert.ok(comments < BEFORE_COMMENTS, `comments must decrease from the measured ${BEFORE_COMMENTS}; got ${comments}`);
  const before = compressionPinBase("src/lib/daemon.ts", import.meta.url);
  if (before === undefined) return;
  // Only on the PR that adds this pin: later feature edits to the module stay free.
  assert.equal(executableDigest(source), executableDigest(before), "all non-comment code lines match the PR base");
  // Independently catch ASI changes and whitespace inside multiline string/template literals.
  assert.equal(emittedDigest(source), emittedDigest(before), "emitted JavaScript matches the PR base");
  assert.ok(comments < countCommentLines(before, "src/lib/daemon.ts").comments,
    "comment lines decrease from the PR base");
});

test("daemon compression digests ignore comments and catch executable edits", () => {
  const control = 'const url = "https://example.com"; // explanation\nconst n = 1;';
  assert.equal(executableDigest(control), executableDigest(control.replace("explanation", "shorter")));
  assert.equal(emittedDigest(control), emittedDigest(`/* detail */\n${control}`));
  for (const [from, to] of [["n = 1", "n = 2"], ["example.com", "other.test"]]) {
    assert.notEqual(executableDigest(control), executableDigest(control.replace(from, to)));
    assert.notEqual(emittedDigest(control), emittedDigest(control.replace(from, to)));
  }
  assert.notEqual(emittedDigest("function f() { return 1; }"), emittedDigest("function f() { return\n1; }"));
});
