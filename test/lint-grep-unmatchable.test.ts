import assert from "node:assert/strict";
import { test } from "node:test";
import { lintTask, proofGrepUnmatchableViolations } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

// ── W1-T1225: WARN, at filing time, on a `grep:` proof whose pattern CANNOT MATCH ANY SINGLE LINE
//    of a file already on disk — but stay silent on every zero that is merely "not written yet".
//
// Nothing before this check ever opened the file a `grep:` proof names, so a phrase that wraps
// across a line break (a YAML fold, a wrapped markdown paragraph — grep is line-based and can never
// match it) or a phrase present only under different capitalisation (grep has no case-fold by
// default) both read byte-identical to a correct forward reference. Both were hit live in #1336 and
// repaired by hand. `proofGrepUnmatchableViolations` consumes W1-T1224's `classifyGrepZeroHit` — the
// SAME classifier `rmd check-proof` uses to explain a real zero-hit run — so filing-time and runtime
// can never disagree about why a pattern misses.

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
    files: ["src/lib/example.ts"],
    acceptance: [{ claim: "does the thing", proof: "unit test: test/foo.test.ts" }],
    ...over,
  };
}

const WRAP_FILE_TEXT =
  "Some preamble text.\n" +
  "The eventual design phrase splits across a line\n" +
  "because of a wrap that the author never typed.\n";
const WRAP_PATTERN = "design phrase splits across a line because";
const WRAP_PATH = "docs/wrap-fixture.md";

const CASE_FILE_TEXT = "The Widget Registry becomes authoritative here.\n";
const CASE_PATTERN = "widget registry becomes authoritative";
const CASE_PATH = "docs/case-fixture.md";

function reader(files: Record<string, string>): (rel: string) => string | undefined {
  return (rel) => files[rel];
}

// ── CLAIM 1: a phrase present only across a line break is WARNed with the wrapped line quoted ──

test("CLAIM 1: a grep proof whose phrase wraps across a line break is WARNed, quoting the wrapped lines", () => {
  const t = task({
    id: "W1-T1225-LINE-SEAM",
    acceptance: [{ claim: "the design phrase is present", proof: `grep: ${WRAP_PATTERN} in ${WRAP_PATH}` }],
  });
  const violations = proofGrepUnmatchableViolations(t, { readGrepProofFile: reader({ [WRAP_PATH]: WRAP_FILE_TEXT }) });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "proof-grep-unmatchable");
  assert.equal(violations[0]!.severity, "warn"); // never BLOCK
  assert.match(violations[0]!.message, /line break/);
  assert.match(violations[0]!.message, /can NEVER match/);
  // The two raw lines the phrase actually straddles, quoted verbatim (copy-paste material).
  assert.match(violations[0]!.message, /The eventual design phrase splits across a line/);
  assert.match(violations[0]!.message, /because of a wrap that the author never typed\./);
});

// ── CLAIM 2: a phrase present only under different capitalisation is WARNed, quoting the file's
//    own casing ──────────────────────────────────────────────────────────────────────────────

test("CLAIM 2: a grep proof whose phrase differs only in case is WARNed, quoting the file's own casing", () => {
  const t = task({
    id: "W1-T1225-CASE-ONLY",
    acceptance: [{ claim: "the widget registry line is present", proof: `grep: ${CASE_PATTERN} in ${CASE_PATH}` }],
  });
  const violations = proofGrepUnmatchableViolations(t, { readGrepProofFile: reader({ [CASE_PATH]: CASE_FILE_TEXT }) });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "proof-grep-unmatchable");
  assert.equal(violations[0]!.severity, "warn");
  assert.match(violations[0]!.message, /DIFFERENT CAPITALISATION/);
  assert.match(violations[0]!.message, /can NEVER match/);
  // The file's OWN capitalisation, quoted verbatim — not the pattern's lowercase spelling.
  assert.match(violations[0]!.message, /The Widget Registry becomes authoritative here\./);
});

// ── CLAIM 3: a path not yet on disk, and a phrase absent in every form, both stay silent ────────

test("CLAIM 3: a grep proof naming a path NOT YET on disk is silent (a legitimate forward reference)", () => {
  const t = task({
    id: "W1-T1225-FORWARD-PATH",
    acceptance: [{ claim: "x", proof: "grep: some future phrase in docs/not-written-yet.md" }],
  });
  const violations = proofGrepUnmatchableViolations(t, { readGrepProofFile: reader({}) });
  assert.deepEqual(violations, []);
});

test("CLAIM 3: a grep proof whose phrase is absent from an EXISTING file in every probed form is silent", () => {
  const t = task({
    id: "W1-T1225-FORWARD-TEXT",
    acceptance: [{ claim: "x", proof: "grep: totally unrelated future phrase in docs/case-fixture.md" }],
  });
  const violations = proofGrepUnmatchableViolations(t, { readGrepProofFile: reader({ [CASE_PATH]: CASE_FILE_TEXT }) });
  assert.deepEqual(violations, []);
});

test("bonus: a grep proof whose phrase already matches a real line today is silent here (executed_stale's business)", () => {
  const t = task({
    id: "W1-T1225-ALREADY-MATCHES",
    acceptance: [{ claim: "x", proof: `grep: widget registry becomes authoritative here in ${CASE_PATH}` }],
  });
  const violations = proofGrepUnmatchableViolations(t, {
    readGrepProofFile: reader({ [CASE_PATH]: "the widget registry becomes authoritative here.\n" }),
  });
  assert.deepEqual(violations, []);
});

// ── CLAIM 4: no injected reader ⇒ silent — the linter stays pure ────────────────────────────────

test("CLAIM 4: absent opts.readGrepProofFile leaves the check silent (no predicate, no opinion)", () => {
  const t = task({
    id: "W1-T1225-NO-INJECTION",
    acceptance: [{ claim: "x", proof: `grep: ${WRAP_PATTERN} in ${WRAP_PATH}` }],
  });
  assert.deepEqual(proofGrepUnmatchableViolations(t), []);
  assert.deepEqual(proofGrepUnmatchableViolations(t, {}), []);
});

// ── CLAIM 5: a task whose only violation is this one does not fail the lint run ─────────────────

test("CLAIM 5: a task whose only violation is proof-grep-unmatchable never fails the lint run", () => {
  const t = task({
    id: "W1-T1225-NEVER-BLOCKS",
    files: ["docs/wrap-fixture.md"],
    acceptance: [{ claim: "the design phrase is present", proof: `grep: ${WRAP_PATTERN} in ${WRAP_PATH}` }],
  });
  const opts = { readGrepProofFile: reader({ [WRAP_PATH]: WRAP_FILE_TEXT }) };
  // Mirrors exactly how run-task.ts's lintPlanCommand merges the two result sets (this check is
  // called directly there, alongside — never inside — lintTask's own aggregate).
  const merged = [...lintTask(t, opts).violations, ...proofGrepUnmatchableViolations(t, opts)];
  assert.ok(merged.some((v) => v.check === "proof-grep-unmatchable" && v.severity === "warn"));
  assert.equal(
    merged.every((v) => v.severity !== "block"),
    true,
  );
});

// ── shape guards: proofs this check must never touch ────────────────────────────────────────────

test("shape guard: a `unit test:` proof (not grep) is never touched by this check", () => {
  const t = task({
    id: "W1-T1225-NOT-GREP",
    acceptance: [{ claim: "x", proof: "unit test: test/foo.test.ts" }],
  });
  const violations = proofGrepUnmatchableViolations(t, { readGrepProofFile: reader({ [WRAP_PATH]: WRAP_FILE_TEXT }) });
  assert.deepEqual(violations, []);
});

test("shape guard: the legacy fenced `grep -rn x y` proof shape (no dialect `--` separator) is silent", () => {
  const t = task({
    id: "W1-T1225-LEGACY-FENCE",
    acceptance: [{ claim: "x", proof: `\`grep -rn ${WRAP_PATTERN.split(" ")[0]} ${WRAP_PATH}\`` }],
  });
  const violations = proofGrepUnmatchableViolations(t, { readGrepProofFile: reader({ [WRAP_PATH]: WRAP_FILE_TEXT }) });
  assert.deepEqual(violations, []);
});

test("shape guard: an Architect-only satisfied_by criterion (no proof text) is never touched", () => {
  const t = task({
    id: "W1-T1225-SATISFIED-BY",
    acceptance: [{ claim: "x", proof: `grep: ${WRAP_PATTERN} in ${WRAP_PATH}`, satisfied_by: "W1-T1" }],
  });
  const violations = proofGrepUnmatchableViolations(t, { readGrepProofFile: reader({ [WRAP_PATH]: WRAP_FILE_TEXT }) });
  assert.deepEqual(violations, []);
});
