// test/acceptance-preflight-agrees-with-gate.test.ts
//
// W1-T2251. `checkAcceptanceCommand` (`rmd check-acceptance`) used to read a PR body's own
// `## Acceptance` block ALONE — `acceptanceBlockDiagnostics(body)` / `parseAcceptanceBlock(body)`,
// nothing else — while `reviewCommand` (the gate) resolves a trailered PR's criteria from the
// `Remudero-Task:` trailer's plan/tasks.yaml (or tasks.d/ shard) record FIRST, falling back to the
// body block only when that resolves zero criteria. On a trailered PR (every implementation PR, by
// convention) the two could therefore judge DIFFERENT criteria from the SAME body: the filing
// measured this at 74 of 300 recently-merged PRs, where the preflight called a body block
// DEFECTIVE that the gate never read because the trailer's shard supplied real criteria instead
// (#2773 is the reproduction quoted in the filing rationale).
//
// THE FIX moves the preflight to the SAME resolution order the gate uses (trailer → shard, body
// as fallback) and reports which source supplied the criteria — never relaxing either side, and
// never touching W1-T1097's zero-criteria handling.
//
// WHAT IS REAL HERE: `checkAcceptanceCommand` is the production command, invoked directly with a
// `planPath` override (its own, injectable seam — never a second resolver) pointed at a temp
// `tasks.yaml` written by each test. `acceptanceBlockDiagnostics`/`parseAcceptanceBlock` are the
// same real functions the pre-existing `test/acceptance-block-diagnostics.test.ts` exercises.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkAcceptanceCommand } from "../src/run-task.js";

function tmpFile(contents: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-accept-preflight-body-"));
  const path = join(dir, "body.md");
  writeFileSync(path, contents);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A temp `tasks.yaml` — no `tasks.d/` sibling needed; `loadPlan` treats a missing shard
 *  directory as "no shards" (back-compat), so a single monolith file is a complete plan. */
function tmpPlan(yaml: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-accept-preflight-plan-"));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, yaml);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A fixture task carrying three real, non-empty-proof acceptance criteria — the shard a
 *  trailer resolves to when the reproduction below is judged the way the gate judges it. */
const PLAN_WITH_HEALTHY_TASK = `- id: W1-T9001
  title: "fixture: a task with real, non-empty-proof acceptance criteria"
  repo: remudero
  type: implement
  acceptance:
    - claim: "criterion one, the one the gate actually judges"
      proof: "unit test: test/fixture-one.test.ts"
    - claim: "criterion two"
      proof: "unit test: test/fixture-two.test.ts"
    - claim: "criterion three"
      proof: "unit test: test/fixture-three.test.ts"
`;

/** The #2773 shape named in the filing rationale: five criteria in the shard. */
const PLAN_WITH_FIVE_CRITERIA_TASK = `- id: W1-T9002
  title: "fixture: five criteria, mirroring #2773's shard"
  repo: remudero
  type: implement
  acceptance:
    - claim: "one"
      proof: "unit test: test/f1.test.ts"
    - claim: "two"
      proof: "unit test: test/f2.test.ts"
    - claim: "three"
      proof: "unit test: test/f3.test.ts"
    - claim: "four"
      proof: "unit test: test/f4.test.ts"
    - claim: "five"
      proof: "unit test: test/f5.test.ts"
`;

/** A task with NO `acceptance:` field at all — resolves to zero criteria, so the preflight must
 *  fall through to the body exactly as W1-T1097 already governs (untouched by this task). */
const PLAN_WITH_EMPTY_TASK = `- id: W1-T9003
  title: "fixture: a task with no acceptance criteria of its own"
  repo: remudero
  type: implement
`;

const WRAPPED_BODY = `## Acceptance

- claim: a claim long enough that an author wrapped it onto
  a second line for readability
  proof: unit test: test/foo.test.ts
- claim: the second criterion
  proof: unit test: test/bar.test.ts
- claim: the third criterion
  proof: unit test: test/baz.test.ts
`;

const UNWRAPPED_BODY = `## Acceptance

- claim: a claim long enough that an author wrapped it onto a second line for readability
  proof: unit test: test/foo.test.ts
- claim: the second criterion
  proof: unit test: test/bar.test.ts
- claim: the third criterion
  proof: unit test: test/baz.test.ts
`;

const NO_HEADER_BODY = `## Validation

- claim: something was proved
  proof: unit test: test/foo.test.ts
`;

function withCapturedConsole(fn: () => number): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
  try {
    const code = fn();
    return { code, out, err };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

// ── criterion 1 + 2: trailer resolves from the shard, and the report names that source ─────────

test("W1-T2251: a trailered body's criteria resolve from the task's shard, the same source the gate uses", () => {
  const plan = tmpPlan(PLAN_WITH_HEALTHY_TASK);
  // No `## Acceptance` block in the body at all — only the trailer. If the preflight still read
  // the body alone (the pre-fix behaviour) this would fail closed with zero criteria; resolving
  // from the shard is the only way this can pass.
  const body = tmpFile("Some PR description with no Acceptance block of its own.\n\nRemudero-Task: W1-T9001\n");
  try {
    const { code, out } = withCapturedConsole(() => checkAcceptanceCommand([body.path], { planPath: plan.path }));
    assert.equal(code, 0, "criteria resolved from the shard, all three proofs non-empty — must pass");
    assert.ok(
      out.some((l) => l.includes("criteria parsed: 3")),
      "all three of the shard's criteria must be reported as parsed",
    );
    assert.ok(
      out.some((l) => /criteria source:.*W1-T9001's shard via the body trailer/.test(l)),
      "the report must name the SOURCE (the shard, via the trailer) rather than only the count",
    );
    // The claims printed must be the SHARD's, not anything invented from the (headerless) body.
    assert.ok(out.some((l) => l.includes("criterion one, the one the gate actually judges")));
  } finally {
    plan.cleanup();
    body.cleanup();
  }
});

test("W1-T2251: the untrailered report also names its source, not only a count", () => {
  const body = tmpFile(UNWRAPPED_BODY);
  try {
    const { out } = withCapturedConsole(() => checkAcceptanceCommand([body.path]));
    assert.ok(
      out.some((l) => /criteria source:.*the body Acceptance: block/.test(l)),
      "a body with no trailer must be named as the source, distinctly from the shard case",
    );
  } finally {
    body.cleanup();
  }
});

// ── criterion 3: a defective body block on a trailered PR is reported as unused, not a refusal ──

test("W1-T2251: a defective body block is UNUSED (not a refusal) once the trailer resolves — the #2773 shape", () => {
  const plan = tmpPlan(PLAN_WITH_HEALTHY_TASK);
  // The WRAPPED shape (truncates, leaves an empty proof) PLUS a trailer that resolves real
  // criteria from the shard — exactly the #2773 reproduction quoted in the filing rationale.
  const body = tmpFile(`${WRAPPED_BODY}\nRemudero-Task: W1-T9001\n`);
  try {
    const { code, out, err } = withCapturedConsole(() => checkAcceptanceCommand([body.path], { planPath: plan.path }));
    assert.equal(code, 0, "the trailer resolves real criteria — the defective body block cannot fail this PR");
    assert.equal(err.length, 0, "not a refusal: nothing goes to stderr — DEFECTIVE: lines are the refusal channel");
    assert.ok(
      out.some((l) => l.includes("UNUSED") && l.includes("DEFECTIVE")),
      "the body's own defect is still NAMED, but as unused rather than as a refusal",
    );
    assert.ok(out.some((l) => l.includes("W1-T9001's shard")), "the note names which shard the gate actually reads");
  } finally {
    plan.cleanup();
    body.cleanup();
  }
});

// ── criterion 4: an untrailered body is judged exactly as before — no change in verdict ─────────

test("W1-T2251: an untrailered body's verdict is unchanged — wrapped fails, clean passes, no-header fails", () => {
  const wrapped = tmpFile(WRAPPED_BODY);
  const unwrapped = tmpFile(UNWRAPPED_BODY);
  const noHeader = tmpFile(NO_HEADER_BODY);
  try {
    assert.equal(checkAcceptanceCommand([wrapped.path]), 1, "a truncating body must still refuse");
    assert.equal(checkAcceptanceCommand([unwrapped.path]), 0, "a clean body must still pass");
    assert.equal(checkAcceptanceCommand([noHeader.path]), 1, "a missing header must still refuse");

    const { err: wrappedErr } = withCapturedConsole(() => checkAcceptanceCommand([wrapped.path]));
    assert.ok(
      wrappedErr.some((l) => l.includes("DEFECTIVE") && l.includes("bullets written but only")),
      "the SAME DEFECTIVE diagnostic text (truncation) is still emitted for an untrailered body",
    );
  } finally {
    wrapped.cleanup();
    unwrapped.cleanup();
    noHeader.cleanup();
  }
});

test("W1-T2251: a trailer that resolves to nothing (unknown task, or a task with no acceptance) falls through to the body, unchanged", () => {
  const plan = tmpPlan(PLAN_WITH_EMPTY_TASK);
  // W1-T9003 exists in the plan but declares no `acceptance:` — resolves zero criteria, so this
  // must fall through to the body exactly as it did before this task (W1-T1097's territory,
  // untouched here: `defective`'s criteriaParsed-vs-bulletsWritten comparison is not this task's).
  const body = tmpFile(`${WRAPPED_BODY}\nRemudero-Task: W1-T9003\n`);
  const withoutTrailer = tmpFile(WRAPPED_BODY);
  try {
    const withTrailerResult = checkAcceptanceCommand([body.path], { planPath: plan.path });
    const withoutTrailerResult = checkAcceptanceCommand([withoutTrailer.path]);
    assert.equal(withTrailerResult, withoutTrailerResult, "an unresolving trailer must not change the verdict");
    assert.equal(withTrailerResult, 1, "the body's own truncation still refuses when nothing else resolved");
  } finally {
    plan.cleanup();
    body.cleanup();
    withoutTrailer.cleanup();
  }
});

// ── criterion 5: the exit code follows what the gate would do with the same body ────────────────

test("W1-T2251: exit code tracks the gate — PASS when the shard supplies criteria, exactly as #2773 merged", () => {
  const plan = tmpPlan(PLAN_WITH_FIVE_CRITERIA_TASK);
  // A body with an EMPTY-PROOF Acceptance block (the shape the filing's live reproduction printed
  // as `DEFECTIVE: 1 parsed criterion/criteria have an EMPTY proof`) plus a trailer that resolves
  // five real criteria — the gate posted PASS on this exact shape; the preflight now must too.
  const body = tmpFile("## Acceptance\n\n- claim: a claim with nothing to execute\n  proof:\n\nRemudero-Task: W1-T9002\n");
  try {
    const code = checkAcceptanceCommand([body.path], { planPath: plan.path });
    assert.equal(code, 0, "the gate reads the shard's five criteria and would pass this PR — the preflight must agree");
  } finally {
    plan.cleanup();
    body.cleanup();
  }
});

test("W1-T2251: exit code tracks the gate — fail closed when NEITHER source has anything to judge", () => {
  // No trailer, no Acceptance header at all: nothing to judge from either source, which is a
  // refusal on BOTH sides (the reviewer's own "NONE (fail closed — nothing to judge is never a
  // pass)" arm, untouched by this task).
  const body = tmpFile("Just prose. No header, no trailer, nothing to judge.\n");
  try {
    const { code, out } = withCapturedConsole(() => checkAcceptanceCommand([body.path]));
    assert.equal(code, 1, "nothing to judge is never a pass, on either side of the gate");
    assert.ok(out.some((l) => l.includes("NONE (fail closed")), "the source line must say so explicitly");
  } finally {
    body.cleanup();
  }
});
