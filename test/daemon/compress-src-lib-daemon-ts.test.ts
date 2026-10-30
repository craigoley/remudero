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
// W1-T9819 intentionally adds ended-run evidence; refresh code snapshots, retaining comment ceilings.
const EXPECTED_EXECUTABLE = "395efc78fd6af0f8a01c91670ab7801af651684a92e1d37a27f84b2bae08d9be";

function emittedDigest(source: string): string {
  const { code } = transformSync(source, { loader: "ts", format: "esm", legalComments: "none" });
  return createHash("sha256").update(code).digest("hex");
}

const EXPECTED_EMITTED = "4831fdc63eba6ea903fc370ea77fde702c2f5dd272684e77c0ef34c305947265";

test("W1-T10871: comment compression preserves executable code", () => {
  const source = readFileSync(join(REPO_ROOT, "src/lib/daemon.ts"), "utf8");
  assert.equal(executableDigest(source), EXPECTED_EXECUTABLE, "all non-comment code lines match the accepted snapshot");
  // Independently catch ASI changes and whitespace inside multiline string/template literals.
  assert.equal(emittedDigest(source), EXPECTED_EMITTED, "emitted JavaScript matches the accepted snapshot");
  const { comments } = countCommentLines(source, "src/lib/daemon.ts");
  assert.ok(comments < BEFORE_COMMENTS, `comments must decrease from the measured ${BEFORE_COMMENTS}; got ${comments}`);
});
