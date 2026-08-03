import assert from "node:assert/strict";
import { test } from "node:test";
import { lintTask, proofScopeViolations } from "../src/lib/task-linter.js";
import { parseWhitelistedProof } from "../src/lib/review.js";
import type { Task } from "../src/lib/plan.js";

/** A minimal, otherwise-clean Task fixture — mirrors task-linter.test.ts's own helper so this
 *  suite reads consistently with the rest of the linter's tests. */
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

// ── ACCEPTANCE 1: a proof naming a path OUTSIDE declared files: is reported,
//    naming both the path and the declared list ────────────────────────────

test("ACCEPTANCE 1: a `unit test:` proof naming a path outside declared files: is flagged, naming the path and the declared list", () => {
  const t = task({
    id: "W1-T309-SHAPE",
    files: ["src/lib/status-board.ts"],
    acceptance: [
      {
        claim: "a live-status ledger candidate is re-checked against its own current state",
        proof: "unit test: test/status-blockers-live.test.ts",
      },
    ],
  });
  const violations = proofScopeViolations(t);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "proof-scope");
  assert.match(violations[0]!.message, /test\/status-blockers-live\.test\.ts/);
  assert.match(violations[0]!.message, /src\/lib\/status-board\.ts/);
  // WARN by default (the measured 102/338 retrofit cost — see the check's own module
  // comment) — reported, but does not itself flip lintTask's `ok`.
  assert.equal(violations[0]!.severity, "warn");
  const res = lintTask(t);
  assert.equal(res.ok, true);
  assert.ok(res.violations.some((v) => v.check === "proof-scope"));
});

test("ACCEPTANCE 1: a `grep: <pattern> in <path>` proof naming a path outside declared files: is flagged the same way", () => {
  const t = task({
    id: "GREP-OUT-OF-SCOPE",
    files: ["src/lib/foo.ts"],
    acceptance: [{ claim: "no window arithmetic references the wrong field", proof: "grep: totalCostUsd in test/bar.test.ts" }],
  });
  const violations = proofScopeViolations(t);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /test\/bar\.test\.ts/);
  assert.match(violations[0]!.message, /src\/lib\/foo\.ts/);
});

test("ACCEPTANCE 1: `opts.proofScope` lets a call site promote the check to BLOCK", () => {
  const t = task({
    id: "W1-T309-SHAPE-BLOCK",
    files: ["src/lib/status-board.ts"],
    acceptance: [{ claim: "same as above", proof: "unit test: test/status-blockers-live.test.ts" }],
  });
  const res = lintTask(t, { proofScope: "block" });
  assert.equal(res.ok, false);
  assert.equal(res.violations.find((v) => v.check === "proof-scope")?.severity, "block");
});

// ── ACCEPTANCE 2: a proof naming no path, and one whose path IS inside the
//    declared files, are both silent ────────────────────────────────────────

test("ACCEPTANCE 2: a `unit test:` proof naming a path INSIDE declared files: is silent", () => {
  const t = task({
    id: "IN-SCOPE-TEST",
    files: ["src/lib/foo.ts", "test/foo.test.ts"],
    acceptance: [{ claim: "does the thing", proof: "unit test: test/foo.test.ts" }],
  });
  assert.equal(proofScopeViolations(t).length, 0);
});

test("ACCEPTANCE 2: a `grep:` proof naming a path INSIDE declared files: is silent", () => {
  const t = task({
    id: "IN-SCOPE-GREP",
    files: ["src/lib/foo.ts"],
    acceptance: [{ claim: "the guard has no TODOs left", proof: "grep: TODO in src/lib/foo.ts" }],
  });
  assert.equal(proofScopeViolations(t).length, 0);
});

test("ACCEPTANCE 2: a bare, name-filtered `unit test: <title>` proof names NO path — silent regardless of declared files:", () => {
  const t = task({
    id: "NAME-FILTERED-SILENT",
    files: ["src/lib/foo.ts"],
    acceptance: [{ claim: "does the thing", proof: "unit test: parses the fixture correctly" }],
  });
  const whitelisted = parseWhitelistedProof("unit test: parses the fixture correctly");
  assert.equal(whitelisted?.kind, "test");
  assert.equal(whitelisted?.nameFiltered, true);
  assert.equal(proofScopeViolations(t).length, 0);
});

test("ACCEPTANCE 2: free prose (no dialect prefix) is silent — this check never touches prose", () => {
  const t = task({
    id: "PROSE-SILENT",
    files: ["src/lib/foo.ts"],
    acceptance: [{ claim: "does the thing", proof: "the fixture asserts all five fields resolve" }],
  });
  assert.equal(proofScopeViolations(t).length, 0);
});

test("ACCEPTANCE 2: a `satisfied_by` (Architect-only) criterion has no proof text to parse — silent", () => {
  const t = task({
    id: "SATISFIED-BY-SILENT",
    files: ["src/lib/foo.ts"],
    acceptance: [{ claim: "does the thing", proof: "", satisfied_by: "some-other-task" }],
  });
  assert.equal(proofScopeViolations(t).length, 0);
});

// ── ACCEPTANCE 3: the check uses the SAME proof parse the reviewer's executor
//    uses (parseWhitelistedProof), so linter and gate can never disagree about
//    what a proof names ────────────────────────────────────────────────────

test("ACCEPTANCE 3: a proof that parseWhitelistedProof REFUSES (e.g. path traversal) is silent here too — never independently re-derived", () => {
  // A `grep:` proof naming a path outside the checkout via `..` — parseDialectGrep
  // (review.ts) refuses this outright (returns null), so the reviewer's executor
  // never runs it. Were this check to re-derive "does the proof text LOOK like it
  // names an out-of-scope path" independently of parseWhitelistedProof, this proof
  // (naming a path that is obviously not in files:) would flag. It must not: the
  // SAME parse the executor uses says this proof names nothing executable at all.
  const proof = "grep: TODO in ../outside/escape.ts";
  assert.equal(parseWhitelistedProof(proof), null);
  const t = task({
    id: "TRAVERSAL-NOT-REDERIVED",
    files: ["src/lib/foo.ts"],
    acceptance: [{ claim: "does the thing", proof }],
  });
  assert.equal(proofScopeViolations(t).length, 0);
});

test("ACCEPTANCE 3: the flagged path is EXACTLY the path parseWhitelistedProof resolves for the same proof text", () => {
  const proofText = "unit test: test/status-blockers-live.test.ts";
  const whitelisted = parseWhitelistedProof(proofText);
  assert.equal(whitelisted?.kind, "test");
  assert.equal(whitelisted?.nameFiltered, undefined);
  assert.equal(whitelisted?.label, "test/status-blockers-live.test.ts");

  const t = task({
    id: "PATH-MATCHES-PARSER",
    files: ["src/lib/status-board.ts"],
    acceptance: [{ claim: "does the thing", proof: proofText }],
  });
  const violations = proofScopeViolations(t);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, new RegExp(whitelisted!.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("ACCEPTANCE 3: a grep proof's flagged path is the SAME path parseDialectGrep resolves (args[3], after the `--` separator)", () => {
  const proofText = "grep: TODO in test/bar.test.ts";
  const whitelisted = parseWhitelistedProof(proofText);
  assert.equal(whitelisted?.kind, "grep");
  assert.equal(whitelisted?.args[1], "--");
  assert.equal(whitelisted?.args[3], "test/bar.test.ts");

  const t = task({
    id: "GREP-PATH-MATCHES-PARSER",
    files: ["src/lib/foo.ts"],
    acceptance: [{ claim: "does the thing", proof: proofText }],
  });
  const violations = proofScopeViolations(t);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /test\/bar\.test\.ts/);
});

// ── declared-scope comparison mirrors the live scope guard's EXACT Set
//    membership (design point 2) — not a prefix or glob ────────────────────

test("declared-files comparison is EXACT Set membership, like scopeGuardOutOfScopeFiles — a directory prefix match does not count as in-scope", () => {
  const t = task({
    id: "PREFIX-IS-NOT-SCOPE",
    files: ["test/"],
    acceptance: [{ claim: "does the thing", proof: "unit test: test/foo.test.ts" }],
  });
  // "test/" does not exactly equal "test/foo.test.ts" — exact string comparison, no
  // prefix/glob semantics, matching run-task.ts's scopeGuardOutOfScopeFiles.
  assert.equal(proofScopeViolations(t).length, 1);
});

test("an empty/absent files: list flags every proof naming a path — fail-closed, like scopeGuardOutOfScopeFiles refusing an undeclared scope", () => {
  const t = task({
    id: "NO-DECLARED-FILES",
    acceptance: [{ claim: "does the thing", proof: "unit test: test/foo.test.ts" }],
  });
  assert.equal(t.files, undefined);
  const violations = proofScopeViolations(t);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /declared files: \[\]/);
});
