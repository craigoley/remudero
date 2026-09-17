import assert from "node:assert/strict";
import { test } from "node:test";
import { lintTask, proofUnitTestBaseWrapperViolations } from "../src/lib/task-linter.js";
import type { NameFilterResolution } from "../src/lib/review.js";
import type { Task } from "../src/lib/plan.js";

/** A minimal, otherwise-clean Task fixture — mirrors the sibling proof-discrimination suites so
 *  this reads consistently with the rest of the linter's tests. */
function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "does the thing", proof: "unit test: test/foo.test.ts" }],
    ...over,
  };
}

const TARGET_FILE = "test/a-title-proof-that-passes-on-an-empty-base-is-refused.test.ts";

// ── ACCEPTANCE 1: a title-form proof whose title lives only in a file this diff adds is
//    refused, because its base reading is a false pass (#5739's own shape, reproduced) ─────

test("a title-form proof whose title lives only in a file this diff adds is refused", () => {
  const t = task({
    id: "W1-T3651-BLOCK",
    files: [TARGET_FILE],
    acceptance: [
      {
        claim: "a zero-name-pattern match still reads pass on an empty base",
        proof: "unit test: this title lives only in the file this diff adds",
      },
    ],
  });
  const resolve = (): NameFilterResolution => ({ status: "resolved", files: [TARGET_FILE] });
  const violations = proofUnitTestBaseWrapperViolations(t, {
    resolveNameFilteredCandidates: resolve,
    pathExistsAtBase: () => false, // absent at base — this diff's own new file
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "proof-unit-test-base-wrapper");
  assert.equal(violations[0]!.severity, "block");
  assert.match(violations[0]!.message, /ok 1 - <file>/);
  assert.match(violations[0]!.message, /executed_stale/);
  assert.match(violations[0]!.message, new RegExp(`unit test: ${TARGET_FILE.replace(/[.]/g, "\\.")}`));
});

test("a BLOCKing proof-unit-test-base-wrapper violation flips lintTask's ok to false", () => {
  const t = task({
    id: "W1-T3651-BLOCKS-OK",
    files: [TARGET_FILE],
    acceptance: [{ claim: "x", proof: "unit test: a title whose only home is this diff's own file" }],
  });
  const resolve = (): NameFilterResolution => ({ status: "resolved", files: [TARGET_FILE] });
  const res = lintTask(t, { resolveNameFilteredCandidates: resolve, pathExistsAtBase: () => false });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.check === "proof-unit-test-base-wrapper" && v.severity === "block"));
});

// ── ACCEPTANCE 2: the same claim proved by the file's PATH is accepted, since a missing
//    path exits non-zero at the base ──────────────────────────────────────────────────────

test("the path form of the same proof is accepted", () => {
  const t = task({
    id: "W1-T3651-PATH-FORM",
    files: [TARGET_FILE],
    acceptance: [{ claim: "x", proof: `unit test: ${TARGET_FILE}` }],
  });
  const resolve = (): NameFilterResolution => {
    throw new Error("must not be called for a pure-path proof — it carries no raw title to resolve");
  };
  const res = lintTask(t, { resolveNameFilteredCandidates: resolve, pathExistsAtBase: () => false });
  const relevant = res.violations.filter(
    (v) => v.check === "proof-unit-test-base-wrapper" || v.check === "proof-base-discrimination",
  );
  assert.deepEqual(relevant, []);
});

// ── ACCEPTANCE 3: a title-form proof against a file that already exists at the base is
//    untouched, so the existing forward-reference and repair cases keep working ────────────

test("a title in a file the base already has is not refused here", () => {
  const t = task({
    id: "W1-T3651-BASE-REPAIR",
    files: ["test/already-here.test.ts"],
    acceptance: [{ claim: "x", proof: "unit test: repairs a currently red assertion" }],
  });
  const resolve = (): NameFilterResolution => ({ status: "resolved", files: ["test/already-here.test.ts"] });
  const violations = proofUnitTestBaseWrapperViolations(t, {
    resolveNameFilteredCandidates: resolve,
    pathExistsAtBase: (p) => p === "test/already-here.test.ts", // present at base — a legitimate repair
  });
  assert.deepEqual(violations, []);
});

test("absent either injected predicate leaves the check silent — no predicate, no opinion", () => {
  const t = task({
    id: "W1-T3651-NO-INJECTION",
    files: [TARGET_FILE],
    acceptance: [{ claim: "x", proof: "unit test: a title with no injected resolver in sight" }],
  });
  assert.deepEqual(proofUnitTestBaseWrapperViolations(t), []);
  assert.deepEqual(proofUnitTestBaseWrapperViolations(t, {}), []);
  const resolve = (): NameFilterResolution => ({ status: "resolved", files: [TARGET_FILE] });
  assert.deepEqual(proofUnitTestBaseWrapperViolations(t, { resolveNameFilteredCandidates: resolve }), []);
  assert.deepEqual(proofUnitTestBaseWrapperViolations(t, { pathExistsAtBase: () => false }), []);
});

test("a title resolving to a file OUTSIDE this task's own files: is not this check's concern", () => {
  const t = task({
    id: "W1-T3651-OUT-OF-SCOPE",
    files: ["src/lib/unrelated.ts"], // this task does not ship the file the title resolves into
    acceptance: [{ claim: "x", proof: "unit test: a title living in someone else's new file" }],
  });
  const resolve = (): NameFilterResolution => ({ status: "resolved", files: ["test/someone-elses-file.test.ts"] });
  assert.deepEqual(
    proofUnitTestBaseWrapperViolations(t, { resolveNameFilteredCandidates: resolve, pathExistsAtBase: () => false }),
    [],
  );
});

test("a title resolving to MANY files is ambiguous, not an 'only home' claim", () => {
  const t = task({
    id: "W1-T3651-AMBIGUOUS",
    files: [TARGET_FILE],
    acceptance: [{ claim: "x", proof: "unit test: a title several files happen to carry" }],
  });
  const resolve = (): NameFilterResolution => ({ status: "resolved", files: [TARGET_FILE, "test/other.test.ts"] });
  assert.deepEqual(
    proofUnitTestBaseWrapperViolations(t, { resolveNameFilteredCandidates: resolve, pathExistsAtBase: () => false }),
    [],
  );
});

test("a zero-match resolution is proof-unit-test-unresolvable's concern, not this one's", () => {
  const t = task({
    id: "W1-T3651-ZERO-MATCH",
    files: [TARGET_FILE],
    acceptance: [{ claim: "x", proof: "unit test: a title that resolves to nothing at all" }],
  });
  const resolve = (): NameFilterResolution => ({ status: "absent" });
  assert.deepEqual(
    proofUnitTestBaseWrapperViolations(t, { resolveNameFilteredCandidates: resolve, pathExistsAtBase: () => false }),
    [],
  );
});

test("an Architect-only satisfied_by criterion carries no proof text and is skipped", () => {
  const t = task({
    id: "W1-T3651-SATISFIED-BY",
    files: [TARGET_FILE],
    acceptance: [{ claim: "x", proof: "", satisfied_by: "W1-T1" }],
  });
  const resolve = (): NameFilterResolution => {
    throw new Error("must not be called for a satisfied_by criterion");
  };
  assert.deepEqual(
    proofUnitTestBaseWrapperViolations(t, { resolveNameFilteredCandidates: resolve, pathExistsAtBase: () => false }),
    [],
  );
});

// ── ACCEPTANCE 4: the refusal is a named predicate rather than an inline condition ──────────
// Proved directly by `grep: proofUnitTestBaseWrapper in src/lib/task-linter.ts` (this test
// file's own criterion 4, executed by the reviewer rather than reproduced here) — the exported
// function above (`proofUnitTestBaseWrapperViolations`) carries the literal name.
