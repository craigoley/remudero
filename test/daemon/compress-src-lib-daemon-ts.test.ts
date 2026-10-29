// @source-text-subject: compare daemon.ts's executable text and comment volume before/after compression.
// @census-reads: src/lib/daemon.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { transformSync } from "esbuild";
import { stripComments } from "#src/lib/test-placement.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// This executable script has no declaration file; load its real export with an explicit type.
const { countCommentLines } = await import(import.meta.resolve("#scripts/comment-load-ratchet.mjs")) as {
  countCommentLines: (text: string, path: string) => { comments: number; code: number };
};

// Pre-compression source: 8c654c1a3cf7265719d1162ac1862ffd77c41f91:src/lib/daemon.ts.
// Keep code lines (including types and punctuation); only blank lines and trailing spaces are ignored.
function executableDigest(source: string): string {
  const code = stripComments(source).split("\n").map(line => line.trimEnd())
    .filter(line => line.trim().length > 0).join("\n");
  return createHash("sha256").update(code).digest("hex");
}

const BEFORE_COMMENTS = 2085;
// Refreshed at 6aa3094dd12209442ffee296bf1132c27e63f02d for W1-T9114's child placement,
// adoption, drain reporting and retro handoff. The original comment-reduction threshold stays fixed.
const EXPECTED_EXECUTABLE = "19b221e5427367fc8106cc77d640dfe02998ca306d8157a8815c2191ff5d27c7";

function emittedDigest(source: string): string {
  const { code } = transformSync(source, { loader: "ts", format: "esm", legalComments: "none" });
  return createHash("sha256").update(code).digest("hex");
}

const EXPECTED_EMITTED = "8be41929a68c9f1e328e990100037fccf49e7d942cf1a8c76641ffda42943f96";

test("W1-T10871: comment compression preserves executable code", () => {
  const source = readFileSync(join(REPO_ROOT, "src/lib/daemon.ts"), "utf8");
  assert.equal(executableDigest(source), EXPECTED_EXECUTABLE, "all non-comment code lines remain unchanged");
  // Independently catch ASI changes and whitespace inside multiline string/template literals.
  assert.equal(emittedDigest(source), EXPECTED_EMITTED, "emitted JavaScript remains unchanged");
  const { comments } = countCommentLines(source, "src/lib/daemon.ts");
  assert.ok(comments < BEFORE_COMMENTS, `comments must decrease from the measured ${BEFORE_COMMENTS}; got ${comments}`);
});
