import assert from "node:assert/strict";
import { test } from "node:test";
import { lintTask, literalOnlyMetacharsIn, proofNameResolutionViolations } from "../src/lib/task-linter.js";
import type { NameFilterResolution } from "../src/lib/review.js";
import type { Task } from "../src/lib/plan.js";

/** A minimal, otherwise-clean Task fixture — mirrors test/lint-proof-scope.test.ts's own helper
 *  so this suite reads consistently with the rest of the linter's tests. */
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

// ── ACCEPTANCE 1: a name-filtered `unit test:` proof resolving to ZERO tests is
//    WARNed, naming the literal-match cause, and never blocks ────────────────

test("ACCEPTANCE 1: a name-filtered `unit test:` proof resolving to ZERO tests is WARNed and names the literal-match cause", () => {
  const t = task({
    id: "W1-T488-ZERO",
    acceptance: [
      {
        claim: "ProgramArguments end matches the recorded array shape",
        proof: "unit test: ProgramArguments end [rmd, digest]",
      },
    ],
  });
  const resolve = (): NameFilterResolution => ({ status: "absent" });
  const violations = proofNameResolutionViolations(t, { resolveNameFilteredCandidates: resolve });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "proof-name-resolution");
  assert.equal(violations[0]!.severity, "warn"); // never BLOCK — a forward reference is legitimate
  assert.match(violations[0]!.message, /LITERAL substring/);
  assert.match(violations[0]!.message, /`\[`/); // names the metacharacter it found
  assert.match(violations[0]!.message, /`\]`/);
});

test("ACCEPTANCE 1: a WARNing proof-name-resolution violation never flips lintTask's ok to false", () => {
  const t = task({
    id: "W1-T488-ZERO-NOBLOCK",
    files: ["src/lib/example.ts"],
    acceptance: [{ claim: "the retry loop halts", proof: "unit test: retry loop halts at N attempts (bounded)" }],
  });
  const resolve = (): NameFilterResolution => ({ status: "absent" });
  const res = lintTask(t, { resolveNameFilteredCandidates: resolve });
  assert.equal(res.ok, true);
  assert.ok(res.violations.some((v) => v.check === "proof-name-resolution" && v.severity === "warn"));
});

test("ACCEPTANCE 1: absent `opts.resolveNameFilteredCandidates` leaves the check silent (no predicate, no opinion)", () => {
  const t = task({
    id: "W1-T488-NO-INJECTION",
    acceptance: [{ claim: "x", proof: "unit test: a title with a . in it" }],
  });
  assert.deepEqual(proofNameResolutionViolations(t), []);
  assert.deepEqual(proofNameResolutionViolations(t, {}), []);
});

test("ACCEPTANCE 1: a zero-resolution title with NO regex metacharacter is silent (narrowed to the high-precision case)", () => {
  const t = task({
    id: "W1-T488-ZERO-NO-METACHAR",
    acceptance: [{ claim: "x", proof: "unit test: plain prose with no special characters at all" }],
  });
  const resolve = (): NameFilterResolution => ({ status: "absent" });
  assert.deepEqual(proofNameResolutionViolations(t, { resolveNameFilteredCandidates: resolve }), []);
});

test("ACCEPTANCE 1: a zero-resolution SCENARIO NARRATIVE with a metacharacter is silent (proof-dialect already warns on that shape)", () => {
  const t = task({
    id: "W1-T488-ZERO-NARRATIVE",
    acceptance: [
      {
        claim: "x",
        proof:
          "unit test: with headroom exhausted (edge case), the daemon either exits zero once, or retries, or backs off (final state)",
      },
    ],
  });
  const resolve = (): NameFilterResolution => ({ status: "absent" });
  assert.deepEqual(proofNameResolutionViolations(t, { resolveNameFilteredCandidates: resolve }), []);
});

test("ACCEPTANCE 1: a path-form `unit test:` proof (not name-filtered) is never touched by this check", () => {
  const t = task({
    id: "W1-T488-PATH-FORM",
    acceptance: [{ claim: "x", proof: "unit test: test/foo.test.ts" }],
  });
  const resolve = (): NameFilterResolution => {
    throw new Error("must not be called for a path-form proof");
  };
  assert.deepEqual(proofNameResolutionViolations(t, { resolveNameFilteredCandidates: resolve }), []);
});

// ── ACCEPTANCE 2: a substring matching MANY test titles is reported as its own
//    outcome, with the count, distinct from a zero-match ────────────────────

test("ACCEPTANCE 2: a substring resolving into MANY different test files is reported as its own outcome, with the count", () => {
  const t = task({
    id: "W1-T488-MANY",
    acceptance: [{ claim: "x", proof: "unit test: renders the expected output" }],
  });
  const resolve = (): NameFilterResolution => ({
    status: "resolved",
    files: ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"],
  });
  const violations = proofNameResolutionViolations(t, { resolveNameFilteredCandidates: resolve });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "proof-name-resolution");
  assert.equal(violations[0]!.severity, "warn");
  assert.match(violations[0]!.message, /\b3\b/); // the count
  assert.match(violations[0]!.message, /test\/a\.test\.ts/);
  assert.match(violations[0]!.message, /test\/b\.test\.ts/);
  assert.match(violations[0]!.message, /test\/c\.test\.ts/);
  // Distinct wording from the zero-match case — never says "resolves to ZERO".
  assert.doesNotMatch(violations[0]!.message, /resolves to ZERO/);
});

test("ACCEPTANCE 2: a substring resolving into exactly ONE test file is silent — that is the healthy case", () => {
  const t = task({
    id: "W1-T488-ONE",
    acceptance: [{ claim: "x", proof: "unit test: renders the expected output" }],
  });
  const resolve = (): NameFilterResolution => ({ status: "resolved", files: ["test/only.test.ts"] });
  assert.deepEqual(proofNameResolutionViolations(t, { resolveNameFilteredCandidates: resolve }), []);
});

test("ACCEPTANCE 2: an `unresolvable` resolution is silent — NOT evidence of anything, per resolveNameFilteredCandidates's own contract", () => {
  const t = task({
    id: "W1-T488-UNRESOLVABLE",
    acceptance: [{ claim: "x", proof: "unit test: a title. with (metachars)" }],
  });
  const resolve = (): NameFilterResolution => ({ status: "unresolvable", reason: "no readable test corpus" });
  assert.deepEqual(proofNameResolutionViolations(t, { resolveNameFilteredCandidates: resolve }), []);
});

// ── literalOnlyMetacharsIn: the pure detector behind the zero-match message ──

test("literalOnlyMetacharsIn: names each distinct regex metacharacter escaping made inert, once each, in first-seen order", () => {
  assert.deepEqual(literalOnlyMetacharsIn("ProgramArguments end [rmd, digest]"), ["[", "]"]);
  assert.deepEqual(literalOnlyMetacharsIn("a.b.c"), ["."]);
  assert.deepEqual(literalOnlyMetacharsIn("plain prose, no metacharacters at all"), []);
  assert.deepEqual(literalOnlyMetacharsIn("(a+b)"), ["(", "+", ")"]);
});
