import assert from "node:assert/strict";
import { test } from "node:test";
import { lintTask, proofUnitTestUnresolvableViolations } from "../src/lib/task-linter.js";
import type { NameFilterResolution } from "../src/lib/review.js";
import type { Task } from "../src/lib/plan.js";

/** A minimal, otherwise-clean Task fixture — mirrors test/lint-proof-name-resolution.test.ts's own
 *  helper so this suite reads consistently with the rest of the linter's tests. */
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

// ── ACCEPTANCE 1: a changed task whose `unit test:` proof names a title no test in the
//    head tree carries is refused, before the push rather than at review ────────────────

test("a unit test proof naming a title no test carries is refused", () => {
  const t = task({
    id: "W1-T3639-ZERO",
    files: ["test/a-unit-test-proof-that-resolves-to-no-test-is-refused.test.ts"],
    acceptance: [
      {
        claim: "the check refuses a title no test carries",
        proof: "unit test: a title that no test in the head tree carries",
      },
    ],
  });
  const resolve = (): NameFilterResolution => ({ status: "absent" });
  const violations = proofUnitTestUnresolvableViolations(t, { resolveNameFilteredCandidates: resolve });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "proof-unit-test-unresolvable");
  assert.equal(violations[0]!.severity, "block"); // review already refuses it — no forward-reference excuse
  assert.match(violations[0]!.message, /resolves to ZERO tests/);
});

test("a BLOCKing proof-unit-test-unresolvable violation flips lintTask's ok to false", () => {
  const t = task({
    id: "W1-T3639-ZERO-BLOCKS",
    files: ["test/example.test.ts"],
    acceptance: [{ claim: "x", proof: "unit test: a title that resolves to nothing at all" }],
  });
  const resolve = (): NameFilterResolution => ({ status: "absent" });
  const res = lintTask(t, { resolveNameFilteredCandidates: resolve });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.check === "proof-unit-test-unresolvable" && v.severity === "block"));
});

test("absent opts.resolveNameFilteredCandidates leaves the check silent (no predicate, no opinion — the whole-plan pass and pre-dispatch never inject it)", () => {
  const t = task({
    id: "W1-T3639-NO-INJECTION",
    files: ["test/example.test.ts"],
    acceptance: [{ claim: "x", proof: "unit test: a title with a . in it" }],
  });
  assert.deepEqual(proofUnitTestUnresolvableViolations(t), []);
  assert.deepEqual(proofUnitTestUnresolvableViolations(t, {}), []);
});

test("a resolved (non-zero) resolution is silent — the healthy case", () => {
  const t = task({
    id: "W1-T3639-RESOLVED",
    files: ["test/example.test.ts"],
    acceptance: [{ claim: "x", proof: "unit test: renders the expected output" }],
  });
  const resolve = (): NameFilterResolution => ({ status: "resolved", files: ["test/example.test.ts"] });
  assert.deepEqual(proofUnitTestUnresolvableViolations(t, { resolveNameFilteredCandidates: resolve }), []);
});

test("an unresolvable resolution is silent — NOT evidence of anything, per resolveNameFilteredCandidates's own contract", () => {
  const t = task({
    id: "W1-T3639-UNRESOLVABLE",
    files: ["test/example.test.ts"],
    acceptance: [{ claim: "x", proof: "unit test: a title. with (metachars)" }],
  });
  const resolve = (): NameFilterResolution => ({ status: "unresolvable", reason: "no readable test corpus" });
  assert.deepEqual(proofUnitTestUnresolvableViolations(t, { resolveNameFilteredCandidates: resolve }), []);
});

test("a path-form unit test: proof (not name-filtered) is never touched by this check", () => {
  const t = task({
    id: "W1-T3639-PATH-FORM",
    files: ["test/foo.test.ts"],
    acceptance: [{ claim: "x", proof: "unit test: test/foo.test.ts" }],
  });
  const resolve = (): NameFilterResolution => {
    throw new Error("must not be called for a path-form proof");
  };
  assert.deepEqual(proofUnitTestUnresolvableViolations(t, { resolveNameFilteredCandidates: resolve }), []);
});

test("an Architect-only satisfied_by criterion carries no proof text and is skipped", () => {
  const t = task({
    id: "W1-T3639-SATISFIED-BY",
    files: ["test/example.test.ts"],
    acceptance: [{ claim: "x", proof: "", satisfied_by: "W1-T1" }],
  });
  const resolve = (): NameFilterResolution => {
    throw new Error("must not be called for a satisfied_by criterion");
  };
  assert.deepEqual(proofUnitTestUnresolvableViolations(t, { resolveNameFilteredCandidates: resolve }), []);
});

// ── ACCEPTANCE 2: the check matches the title the way the executor does, as a literal
//    substring, so it never disagrees with the reviewer it protects ─────────────────────

test("the title predicate matches literally, not as a regex", () => {
  // A title carrying regex metacharacters ('.', '+', '*') that, read as a REGEX, would mean
  // "any char" / "one-or-more" / "zero-or-more" rather than themselves.
  const rawTitle = "computes a.b+c* in one pass";
  let received: string | undefined;
  const resolve = (rawName: string): NameFilterResolution => {
    received = rawName;
    return { status: "absent" };
  };
  const t = task({
    id: "W1-T3639-LITERAL",
    files: ["test/example.test.ts"],
    acceptance: [{ claim: "x", proof: `unit test: ${rawTitle}` }],
  });
  const violations = proofUnitTestUnresolvableViolations(t, { resolveNameFilteredCandidates: resolve });
  // The resolver receives the EXACT raw title, metacharacters and all — this function performs no
  // escaping or regex compilation of its own before delegating, so it can never disagree with the
  // reviewer's own literal-substring matcher (parseTestTarget, review.ts) over what "matches" means.
  // Had this check instead matched via its OWN regex against `rawTitle`, either the resolver would
  // never see the unmodified title (this assertion fails) or a metacharacter-bearing title would
  // be judged by two different rules than the executor uses.
  assert.equal(received, rawTitle);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /LITERAL SUBSTRING/);
  assert.match(violations[0]!.message, /never a regex/);
});

// ── ACCEPTANCE 3: a task that is only filed, whose suite is not written yet, is not
//    refused, so the full plan pass stays green on queued work ──────────────────────────

test("a filed task with no test file in scope is skipped", () => {
  const t = task({
    id: "W1-T3639-NO-SUITE",
    files: ["src/lib/example.ts"], // no test/ path in files: — the suite is not part of this diff
    acceptance: [{ claim: "x", proof: "unit test: a title that resolves to nothing yet" }],
  });
  const resolve = (): NameFilterResolution => {
    throw new Error("must not be called when the task declares no test/ path in files:");
  };
  assert.deepEqual(proofUnitTestUnresolvableViolations(t, { resolveNameFilteredCandidates: resolve }), []);
});

test("a task with no files: at all is skipped, same as one naming only non-test paths", () => {
  const t = task({
    id: "W1-T3639-NO-FILES",
    acceptance: [{ claim: "x", proof: "unit test: a title that resolves to nothing yet" }],
  });
  delete t.files;
  const resolve = (): NameFilterResolution => ({ status: "absent" });
  assert.deepEqual(proofUnitTestUnresolvableViolations(t, { resolveNameFilteredCandidates: resolve }), []);
});
