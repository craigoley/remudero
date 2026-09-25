// test/a-mechanical-census-red-fixes-itself.test.ts — W1-T4434: `runCensusFix` (lib/census-fix.ts)
// applies each census red's registered MECHANICAL remedy before the implement worker's final
// commit — record a new file's baseline row at its measured value, never raise an existing one.
//
// FIXTURES: the shared git-repo fixture (test/helpers/git-repo.ts, W1-T2903), reused rather than a
// hand-rolled `mkdtemp` + `git init` + identity dance — this task's own rationale names that as one
// of the three observed mechanical remedies, so its own test practises it.
//
// The source-size legacy baseline (scripts/source-size-baseline.json, via
// scripts/source-size-ratchet.mjs's `--baseline` mode) is the remedy driven here: it needs no
// comment-syntax fixture, only a line count, and its recording contract is identical in shape to
// the comment-load sibling `runCensusFix` also drives — see src/lib/census-fix.ts's own module doc.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "./helpers/git-repo.js";
import { runCensusFix } from "../src/lib/census-fix.js";
import { commitWorkerEditsWithCensusFix } from "../src/run-task.js";

/** `scripts/source-size-ratchet.mjs`'s own bucket — matches its exported `CEILING_BUCKET_LINES`,
 *  restated rather than imported: this suite proves the OUTCOME a real subprocess produced, not a
 *  shared constant with it. */
const CEILING_BUCKET_LINES = 500;

function plantSourceFile(repoDir: string, relativePath: string, lines: number): void {
  const full = join(repoDir, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, `${Array.from({ length: lines }, (_, i) => `// line ${i}`).join("\n")}\n`);
}

function sourceSizeBaselinePath(repoDir: string): string {
  return join(repoDir, "scripts", "source-size-baseline.json");
}

test("W1-T4434: a new file's missing baseline row is added at its measured value", () => {
  const repo = gitRepo();
  try {
    mkdirSync(join(repo.dir, "scripts"), { recursive: true });
    writeFileSync(sourceSizeBaselinePath(repo.dir), "{}\n");
    plantSourceFile(repo.dir, "src/lib/new-thing.ts", 17);
    repo.git("add", "-A");
    repo.git("commit", "-m", "add a new source file with no baseline row");

    const result = runCensusFix(repo.dir);

    const sourceSize = result.outcomes.find((o) => o.remedy === "source-size-baseline-row");
    assert.ok(sourceSize, "runCensusFix must report a source-size-baseline-row outcome");
    assert.equal(sourceSize!.applied, true, sourceSize!.detail);
    assert.deepEqual(sourceSize!.added, [
      { baselinePath: "scripts/source-size-baseline.json", file: "src/lib/new-thing.ts", value: CEILING_BUCKET_LINES },
    ]);
    assert.deepEqual(JSON.parse(readFileSync(sourceSizeBaselinePath(repo.dir), "utf8")), {
      "src/lib/new-thing.ts": CEILING_BUCKET_LINES,
    });
    assert.ok(result.changed, "the result must report a real change");
    assert.ok(
      result.summaryLines.some((line) => line.includes("source-size-baseline-row")),
      "the summary must name the applied remedy",
    );
  } finally {
    repo.cleanup();
  }
});

test("W1-T4434: an existing ceiling is never raised by census fix", () => {
  const repo = gitRepo();
  try {
    mkdirSync(join(repo.dir, "scripts"), { recursive: true });
    const recorded = `${JSON.stringify({ "src/lib/grown.ts": CEILING_BUCKET_LINES }, null, 2)}\n`;
    writeFileSync(sourceSizeBaselinePath(repo.dir), recorded);
    // Grown well past its recorded ceiling -- a real census red a human must review, never one
    // census fix may paper over by advancing the ceiling to match.
    plantSourceFile(repo.dir, "src/lib/grown.ts", CEILING_BUCKET_LINES * 2 + 5);
    repo.git("add", "-A");
    repo.git("commit", "-m", "grow a file past its recorded baseline");

    const result = runCensusFix(repo.dir);

    const sourceSize = result.outcomes.find((o) => o.remedy === "source-size-baseline-row");
    assert.ok(sourceSize, "runCensusFix must report a source-size-baseline-row outcome");
    assert.equal(sourceSize!.applied, false, "growth past a recorded ceiling must never be applied");
    assert.deepEqual(sourceSize!.added, []);
    assert.equal(
      readFileSync(sourceSizeBaselinePath(repo.dir), "utf8"),
      recorded,
      "the recorded ceiling must be byte-identical to what it was before the fix ran",
    );
    assert.deepEqual(JSON.parse(readFileSync(sourceSizeBaselinePath(repo.dir), "utf8")), {
      "src/lib/grown.ts": CEILING_BUCKET_LINES,
    });
  } finally {
    repo.cleanup();
  }
});

test("W1-T4434: the harness's own commit step applies census fix first and stages its remedy", () => {
  const repo = gitRepo();
  try {
    // commitWorkerEditsWithCensusFix shells git itself, outside gitRepo's identity-bearing wrapper.
    // Give that real subprocess the same fixture-local identity; CI has no global identity to borrow.
    repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
    repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
    mkdirSync(join(repo.dir, "scripts"), { recursive: true });
    writeFileSync(sourceSizeBaselinePath(repo.dir), "{}\n");
    repo.git("add", "-A");
    repo.git("commit", "-m", "seed an empty source-size baseline");

    // The worker's own declared edit -- a new src file it never told census fix about.
    plantSourceFile(repo.dir, "src/lib/worker-added.ts", 17);

    const result = commitWorkerEditsWithCensusFix(repo.dir, ["src/lib/worker-added.ts"], "feat: add worker-added.ts");

    assert.equal(result.committed, true, result.reason);
    assert.equal(result.censusFix.changed, true);
    assert.deepEqual(result.censusFix.changedFiles, ["scripts/source-size-baseline.json"]);
    // The remedied baseline is staged and committed even though `declaredPaths` never named it --
    // it is a REGENERABLE_ARTIFACT_GENERATORS entry (lib/sweep.ts), exactly like the worker's own
    // regenerable-artifact allowance already grants for a gate-printed remedy (W1-T3015).
    const committedFiles = repo.git("show", "--name-only", "--pretty=format:", "HEAD").split("\n").filter(Boolean);
    assert.ok(committedFiles.includes("scripts/source-size-baseline.json"), committedFiles.join(", "));
    assert.ok(committedFiles.includes("src/lib/worker-added.ts"), committedFiles.join(", "));
  } finally {
    repo.cleanup();
  }
});

test("W1-T4434: a clean tree with no census red reports no change", () => {
  const repo = gitRepo();
  try {
    mkdirSync(join(repo.dir, "scripts"), { recursive: true });
    plantSourceFile(repo.dir, "src/lib/settled.ts", 17);
    writeFileSync(
      sourceSizeBaselinePath(repo.dir),
      `${JSON.stringify({ "src/lib/settled.ts": CEILING_BUCKET_LINES }, null, 2)}\n`,
    );
    repo.git("add", "-A");
    repo.git("commit", "-m", "a settled tree");

    const result = runCensusFix(repo.dir);

    assert.equal(result.changed, false);
    assert.deepEqual(result.changedFiles, []);
    assert.deepEqual(result.summaryLines, []);
  } finally {
    repo.cleanup();
  }
});
