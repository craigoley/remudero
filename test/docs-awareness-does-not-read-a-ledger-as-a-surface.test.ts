import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDocsAwareness } from "../src/lib/review.js";
import { GENERATED_LEDGER_CLASSES, isCompanionPath } from "../src/lib/task-linter.js";

// W1-T2547: `USER_VISIBLE_SURFACE_RE` matches `scripts/*-baseline.json` by filename alone (W1-T212,
// Standing rule 25's instrument surface) -- but `scripts/source-size-baseline.json` is a GENERATED
// LEDGER, not a user-visible surface: it records how long a file is and grades no falsifier
// (W1-T2526's own reasoning, cited rather than re-derived). Before this task every PR that recorded
// a line-count growth -- exactly what `source-size-ratchet`'s own remedy text instructs the author
// to do -- was told "user-visible surface changed ... with no docs/ update and no stated reason",
// pointing the gate that demands the edit at the rubric that penalises it. #3422 observed this
// verbatim. These fixtures drive the real checkDocsAwareness the same way
// test/awareness-surface-ratchet.test.ts drives the surface it widens.

function surfaceDiffNoDocs(...files: string[]): string {
  return files
    .flatMap((file) => [`diff --git a/${file} b/${file}`, `+++ b/${file}`, "@@", "+changed"])
    .join("\n");
}

function surfaceDiffWithDocs(file: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    `+++ b/${file}`,
    "@@",
    "+changed",
    "diff --git a/docs/gates.md b/docs/gates.md",
    "+++ b/docs/gates.md",
    "@@",
    "+Documented the gate change.",
  ].join("\n");
}

// ── criterion 1: a generated size ledger is not read as a user-visible surface ─────────────────

test("docs-awareness-does-not-read-a-ledger-as-a-surface: scripts/source-size-baseline.json alone, no docs, no stated reason -- PASSES", () => {
  const result = checkDocsAwareness(surfaceDiffNoDocs("scripts/source-size-baseline.json"), "");
  assert.equal(result.pass, true, result.reason);
  assert.match(result.reason, /ledger/i);
  assert.match(result.reason, /source-size-baseline/);
});

test("docs-awareness-does-not-read-a-ledger-as-a-surface: the #3422 shape -- a size ledger plus the ordinary src/ change it records -- PASSES with no docs/ and no stated reason", () => {
  // #3422's observed pair, verbatim from this task's rationale.
  const result = checkDocsAwareness(
    surfaceDiffNoDocs("scripts/source-size-baseline.json", "src/lib/sweep.ts"),
    "",
  );
  assert.equal(result.pass, true, result.reason);
});

test("docs-awareness-does-not-read-a-ledger-as-a-surface: the sibling ledger (scripts/knowledge-budget-baseline.json) is exempt too, driven by the table's own pattern, not a hardcoded single path", () => {
  const result = checkDocsAwareness(surfaceDiffNoDocs("scripts/knowledge-budget-baseline.json"), "");
  assert.equal(result.pass, true, result.reason);
});

// ── criterion 2: a real user-visible surface change still reports -- the arm is not disabled ────

test("docs-awareness-does-not-read-a-ledger-as-a-surface: a REAL surface change (.github/workflows/ci.yml) with no docs update still FAILS", () => {
  const result = checkDocsAwareness(surfaceDiffNoDocs(".github/workflows/ci.yml"), "Tweaked a CI job.");
  assert.equal(result.pass, false);
  assert.match(result.reason, /docs/i);
});

test("docs-awareness-does-not-read-a-ledger-as-a-surface: a SCORE FLOOR (scripts/coverage-baseline.json, not a ledger) still FAILS -- the discount stays narrow", () => {
  const result = checkDocsAwareness(surfaceDiffNoDocs("scripts/coverage-baseline.json"), "Lowered a floor.");
  assert.equal(result.pass, false);
  assert.match(result.reason, /docs/i);
});

test("docs-awareness-does-not-read-a-ledger-as-a-surface: a real surface change accompanied by the exempt ledger still FAILS on the real surface, naming only it", () => {
  const result = checkDocsAwareness(
    surfaceDiffNoDocs("src/lib/config.ts", "scripts/source-size-baseline.json"),
    "",
  );
  assert.equal(result.pass, false);
  assert.match(result.reason, /src\/lib\/config\.ts/);
  assert.doesNotMatch(result.reason, /source-size-baseline/);
});

test("docs-awareness-does-not-read-a-ledger-as-a-surface: a real surface change accompanied by the exempt ledger PASSES once docs/ is updated, same as today", () => {
  const result = checkDocsAwareness(surfaceDiffWithDocs("src/lib/config.ts"), "");
  assert.equal(result.pass, true, result.reason);
});

// ── criterion 3: the exemption is a table row shared with the one-concern arm, not a second
//    mechanism (W1-T2543's isCompanionPath, injected with GENERATED_LEDGER_CLASSES rather than a
//    private list re-declared in review.ts) ──────────────────────────────────────────────────────

test("docs-awareness-does-not-read-a-ledger-as-a-surface: the exemption is GENERATED_LEDGER_CLASSES read through isCompanionPath -- task-linter.ts's own mechanism, not a private review.ts copy", () => {
  assert.ok(
    GENERATED_LEDGER_CLASSES.some((c) => c.tag === "generated-ledger"),
    "the shipped row lives in task-linter.ts, next to COMPANION_PATH_CLASSES",
  );
  assert.equal(isCompanionPath("scripts/source-size-baseline.json", GENERATED_LEDGER_CLASSES), true);
  assert.equal(isCompanionPath("scripts/coverage-baseline.json", GENERATED_LEDGER_CLASSES), false);
  // Widen the injected table by one row -- with ZERO changes to checkDocsAwareness -- and a
  // previously-blocking path clears the rung. Proves the arm reads THIS table live, not a
  // hardcoded string equal to "scripts/source-size-baseline.json".
  const widened = [...GENERATED_LEDGER_CLASSES, { tag: "bench-ledger", pathPattern: /^bench\/throughput-baseline\.json$/ }];
  assert.equal(isCompanionPath("bench/throughput-baseline.json", GENERATED_LEDGER_CLASSES), false);
  assert.equal(isCompanionPath("bench/throughput-baseline.json", widened), true);
});

test("docs-awareness-does-not-read-a-ledger-as-a-surface: the one-concern arm's own pinned behavior for this exact ledger is UNCHANGED (out of scope, named) -- source-size-baseline.json still counts as its own Rule 19 concern", async () => {
  // Imported dynamically so a failure to resolve subsystemsOf never masks this suite's own review.ts
  // assertions above -- this criterion is about NOT touching the other arm, proven directly against it.
  const { subsystemsOf } = await import("../src/lib/task-linter.js");
  const t = {
    id: "W1-TX",
    repo: "remudero",
    type: "implement",
    risk: "medium",
    files: ["src/lib/sweep.ts", "test/sweep-conflicted-disposition.test.ts", "scripts/source-size-baseline.json"],
  } as import("../src/lib/plan.js").Task;
  assert.deepEqual(
    [...subsystemsOf(t)].sort(),
    ["source-size-baseline", "sweep"],
    "GENERATED_LEDGER_CLASSES is its OWN table -- subsystemsOf's default classes (COMPANION_PATH_CLASSES) are untouched",
  );
});

// ── criterion 4: a stated reason still satisfies the arm exactly as it does today ───────────────

test("docs-awareness-does-not-read-a-ledger-as-a-surface: a stated reason still excuses a REAL surface change, unaffected by the ledger discount", () => {
  const result = checkDocsAwareness(
    surfaceDiffNoDocs("scripts/coverage-baseline.json"),
    "Recaptured the coverage baseline. no docs update because this is an internal ratchet number, never user-facing.",
  );
  assert.equal(result.pass, true, result.reason);
});

test("docs-awareness-does-not-read-a-ledger-as-a-surface: an ordinary src/lib file outside the surface never trips the item, ledger discount aside", () => {
  const result = checkDocsAwareness(surfaceDiffNoDocs("src/lib/sweep.ts"), "");
  assert.equal(result.pass, true, result.reason);
});
