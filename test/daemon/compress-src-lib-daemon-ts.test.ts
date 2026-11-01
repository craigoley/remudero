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
// Regenerated again for the observed-overlap shadow wiring (operator ruling 2026-11-01).
const EXPECTED_EXECUTABLE = "cd517372000196faa7df4371658a6968e87fa8d3840c2fc63d76fa115b319f7a";

function emittedDigest(source: string): string {
  const { code } = transformSync(source, { loader: "ts", format: "esm", legalComments: "none" });
  return createHash("sha256").update(code).digest("hex");
}

const EXPECTED_EMITTED = "f51d98e48fc34f95eaaf6f12a3d87f4bb64e00f9506524527cbabe0653eda271";

test("W1-T10871: comment compression preserves executable code", () => {
  const source = readFileSync(join(REPO_ROOT, "src/lib/daemon.ts"), "utf8");
  // W1-T9912 intentionally adds these two cohort ledger fields after the compression baseline.
  // Remove only that exact addition when comparing the merged executable snapshot.
  const cohortFields = "                due_because: result.dueBecause,\n                pass_ms: result.passMs,\n";
  assert.equal(source.split(cohortFields).length, 2, "the cohort fields occur once in the daemon row");
  // W1-T9914 adds the landing meter; its behavior is pinned by the cadence meter tests.
  const meterFields = [
    '                      git_driver: result.git?.driver ?? "none",',
    '                      git_calls: result.git?.calls ?? 0,',
    '                      git_wall_ms: Math.round(result.git?.wallMs ?? 0),',
    '                      git_loop_ms: Math.round(result.git?.loopMs ?? 0),',
    "",
  ].join("\n");
  assert.equal(source.split(meterFields).length, 2, "the landing meter occurs once in the daemon row");
  const landingModule = "./feedback-landing.js";
  const meterImport = `import type { FeedbackRefusal, LandFeedbackResult, LandingGitMeter } from "${landingModule}";`;
  const meterType = "      git?: LandingGitMeter;\n";
  assert.equal(source.split(meterImport).length, 2, "the meter type is imported once");
  assert.equal(source.split(meterType).length, 2, "the cadence result declares its meter once");
  const baselineSource = source.replace(cohortFields, "").replace(meterFields, "")
    .replace(meterImport, `import type { FeedbackRefusal, LandFeedbackResult } from "${landingModule}";`)
    .replace(meterType, "");
  assert.equal(executableDigest(baselineSource), EXPECTED_EXECUTABLE, "all other non-comment code lines match the accepted snapshot");
  // Independently catch ASI changes and whitespace inside multiline string/template literals.
  assert.equal(emittedDigest(baselineSource), EXPECTED_EMITTED, "other emitted JavaScript matches the accepted snapshot");
  const { comments } = countCommentLines(source, "src/lib/daemon.ts");
  assert.ok(comments < BEFORE_COMMENTS, `comments must decrease from the measured ${BEFORE_COMMENTS}; got ${comments}`);
});
