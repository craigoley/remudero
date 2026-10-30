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
// Regenerated from the merged W1-T9114 child placement, adoption, drain and retro work plus
// W1-T9819's ended-run evidence. The original comment-reduction threshold stays fixed.
const EXPECTED_EXECUTABLE = "5b915668601f6edfdb7b31057849fc4a5d3aa7b0b3caff6c017487f322db5c25";

function emittedDigest(source: string): string {
  const { code } = transformSync(source, { loader: "ts", format: "esm", legalComments: "none" });
  return createHash("sha256").update(code).digest("hex");
}

const EXPECTED_EMITTED = "70c948681d4787399914a515e50a2566d3b00f18a11de3f2c9ea41ed5a831a1d";

test("W1-T10871: comment compression preserves executable code", () => {
  const source = readFileSync(join(REPO_ROOT, "src/lib/daemon.ts"), "utf8");
  // W1-T9912 intentionally adds these two cohort ledger fields after the compression baseline.
  // Remove only that exact addition when comparing the merged executable snapshot.
  const cohortFields = "                due_because: result.dueBecause,\n                pass_ms: result.passMs,\n";
  assert.equal(source.split(cohortFields).length, 2, "the cohort fields occur once in the daemon row");
  const baselineSource = source.replace(cohortFields, "");
  assert.equal(executableDigest(baselineSource), EXPECTED_EXECUTABLE, "all other non-comment code lines match the accepted snapshot");
  // Independently catch ASI changes and whitespace inside multiline string/template literals.
  assert.equal(emittedDigest(baselineSource), EXPECTED_EMITTED, "other emitted JavaScript matches the accepted snapshot");
  const { comments } = countCommentLines(source, "src/lib/daemon.ts");
  assert.ok(comments < BEFORE_COMMENTS, `comments must decrease from the measured ${BEFORE_COMMENTS}; got ${comments}`);
});
