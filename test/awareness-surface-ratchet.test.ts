import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDocsAwareness } from "../src/lib/review.js";

// ── W1-T212 (recon R-15): the review floor's docs-awareness surface used to omit every CI
// workflow and every ratchet gate script/baseline it exists to police -- USER_VISIBLE_SURFACE_RE
// matched bin/, run-task.ts, spike.ts and nine named src/lib files, but NOT .github/workflows/,
// scripts/*-ratchet.mjs, scripts/*-baseline.json, or stryker.conf.json. A PR that lowered a
// coverage/mutation floor, or deleted a required check from ci-gate.yml, therefore cleared the
// docs-awareness rung SILENTLY -- "no CLI/config/gate/verdict surface changed" -- even though it
// had just weakened the exact measurement the gate is trusted to enforce. These fixtures drive
// the real checkDocsAwareness against diffs touching each newly-widened path, the same way
// test/review.test.ts's SURFACE_NO_DOCS_DIFF/SURFACE_WITH_DOCS_DIFF drive the original nine.

function surfaceDiffNoDocs(file: string, addedLine = "+changed"): string {
  return [
    `diff --git a/${file} b/${file}`,
    `+++ b/${file}`,
    "@@",
    addedLine,
  ].join("\n");
}

function surfaceDiffWithDocs(file: string, addedLine = "+changed"): string {
  return [
    `diff --git a/${file} b/${file}`,
    `+++ b/${file}`,
    "@@",
    addedLine,
    "diff --git a/docs/gates.md b/docs/gates.md",
    "+++ b/docs/gates.md",
    "@@",
    "+Documented the gate change.",
  ].join("\n");
}

// A diff touching an ordinary src/lib file that is NOT part of the surface (before or after this
// widening) -- must never trip the item, so the rung stays useful rather than becoming noise.
const ORDINARY_SRC_DIFF = [
  "diff --git a/src/lib/sweep.ts b/src/lib/sweep.ts",
  "+++ b/src/lib/sweep.ts",
  "@@",
  "+export const x = 1;",
].join("\n");

test("awareness-surface-ratchet: editing a CI workflow (.github/workflows/ci.yml) with no docs update FAILS; a doc update PASSES", () => {
  const noDocs = checkDocsAwareness(surfaceDiffNoDocs(".github/workflows/ci.yml"), "Tweaked a CI job.");
  assert.equal(noDocs.pass, false);
  assert.match(noDocs.reason, /docs/i);
  assert.equal(
    checkDocsAwareness(surfaceDiffWithDocs(".github/workflows/ci.yml"), "Tweaked a CI job.").pass,
    true,
  );
});

test("awareness-surface-ratchet: editing another workflow file (.github/workflows/ci-gate.yml) also trips the surface, not just ci.yml", () => {
  const noDocs = checkDocsAwareness(
    surfaceDiffNoDocs(".github/workflows/ci-gate.yml"),
    "Removed a name from REQUIRED.",
  );
  assert.equal(noDocs.pass, false);
});

test("awareness-surface-ratchet: lowering a ratchet baseline (scripts/coverage-baseline.json) with no docs update FAILS; a doc update PASSES", () => {
  const noDocs = checkDocsAwareness(
    surfaceDiffNoDocs("scripts/coverage-baseline.json", '+  "linesPct": 10.0,'),
    "Recaptured the coverage baseline.",
  );
  assert.equal(noDocs.pass, false);
  assert.match(noDocs.reason, /docs/i);
  assert.equal(
    checkDocsAwareness(
      surfaceDiffWithDocs("scripts/coverage-baseline.json", '+  "linesPct": 10.0,'),
      "Recaptured the coverage baseline.",
    ).pass,
    true,
  );
});

test("awareness-surface-ratchet: every *-baseline.json ratchet floor trips the surface (mutation, learnings-budget, complexity, dup, fitness, cve), not just coverage", () => {
  const baselines = [
    "scripts/mutation-baseline.json",
    "scripts/learnings-budget-baseline.json",
    "scripts/complexity-baseline.json",
    "scripts/dup-baseline.json",
    "scripts/fitness-baseline.json",
    "scripts/cve-baseline.json",
  ];
  for (const file of baselines) {
    const result = checkDocsAwareness(surfaceDiffNoDocs(file), "Adjusted a floor.");
    assert.equal(result.pass, false, `${file} should trip the awareness surface`);
  }
});

test("awareness-surface-ratchet: editing a ratchet gate script (scripts/coverage-ratchet.mjs, scripts/mutation-ratchet.mjs) trips the surface", () => {
  assert.equal(
    checkDocsAwareness(surfaceDiffNoDocs("scripts/coverage-ratchet.mjs"), "Tweaked the ratchet.").pass,
    false,
  );
  assert.equal(
    checkDocsAwareness(surfaceDiffNoDocs("scripts/mutation-ratchet.mjs"), "Tweaked the ratchet.").pass,
    false,
  );
});

test("awareness-surface-ratchet: editing mutation-ratchet's diff-scoping config (scripts/mutation-relevant-paths.json) trips the surface", () => {
  const result = checkDocsAwareness(
    surfaceDiffNoDocs("scripts/mutation-relevant-paths.json"),
    "Widened mutation scope.",
  );
  assert.equal(result.pass, false);
});

test("awareness-surface-ratchet: editing stryker.conf.json (the mutation ratchet's mutate scope) trips the surface", () => {
  const result = checkDocsAwareness(surfaceDiffNoDocs("stryker.conf.json"), "Widened mutate glob.");
  assert.equal(result.pass, false);
});

test("awareness-surface-ratchet: a stated reason still excuses a widened-surface diff, same as the original nine paths", () => {
  const result = checkDocsAwareness(
    surfaceDiffNoDocs("scripts/coverage-baseline.json", '+  "linesPct": 95.0,'),
    "Recaptured the coverage baseline. no docs update because this is an internal ratchet number, never user-facing.",
  );
  assert.equal(result.pass, true);
});

test("awareness-surface-ratchet: an ordinary src/lib file outside the widened set never trips the item (no new noise)", () => {
  assert.equal(checkDocsAwareness(ORDINARY_SRC_DIFF, "").pass, true);
});

test("awareness-surface-ratchet: a scripts/ file that is neither *-ratchet.mjs nor *-baseline.json (e.g. a generator) never trips the item", () => {
  const result = checkDocsAwareness(
    surfaceDiffNoDocs("scripts/generate-cli-reference.mjs"),
    "",
  );
  assert.equal(result.pass, true);
});
