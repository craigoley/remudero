import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkRunbookCoverage, isRunbookFullyCovered, REQUIRED_PROCEDURES } from "../src/lib/runbook-coverage.js";

// ── W1-T217: runbook coverage (RECON R-25 / the runbook half of R-30) ───────────────────────
//
// The procedures an operator needs at 3am — restarting the supervised daemon, rotating the
// service tokens, first-run setup on a new machine, the ANTHROPIC_* billing boundary — existed
// only as tribal knowledge, unchecked, so they rotted silently. This suite proves the check is
// REAL (a fixture missing a procedure, or one with only a stub heading, actually fails it) and
// that the real docs/operator-guide.md currently satisfies it for every required procedure.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

test("checkRunbookCoverage: a fixture with every required heading + a real paragraph under each is fully covered", () => {
  const body =
    "This section explains the procedure in enough sentences to be genuinely non-trivial, " +
    "covering the exact commands an operator runs and what to check afterward before moving on.";
  const guide = REQUIRED_PROCEDURES.map((p) => `## ${p.exampleHeading}\n\n${body}\n`).join("\n");

  const results = checkRunbookCoverage(guide);
  assert.equal(results.length, REQUIRED_PROCEDURES.length);
  for (const r of results) {
    assert.equal(r.covered, true, `expected "${r.id}" covered, got ${JSON.stringify(r)}`);
  }
  assert.equal(isRunbookFullyCovered(guide), true);
});

test("checkRunbookCoverage: a required procedure with NO heading at all FAILS with heading-not-found", () => {
  const present = REQUIRED_PROCEDURES.slice(1); // drop the first procedure entirely
  const body =
    "This section explains the procedure in enough sentences to be genuinely non-trivial, " +
    "covering the exact commands an operator runs and what to check afterward before moving on.";
  const guide = present.map((p) => `## ${p.exampleHeading}\n\n${body}\n`).join("\n");

  const results = checkRunbookCoverage(guide);
  const missing = REQUIRED_PROCEDURES[0];
  const missingResult = results.find((r) => r.id === missing.id);
  assert.ok(missingResult, "missing procedure must still appear in the result set");
  assert.equal(missingResult?.covered, false);
  assert.equal(missingResult?.reason, "heading-not-found");
  assert.equal(isRunbookFullyCovered(guide), false, "one missing procedure must fail the overall gate");

  // every OTHER procedure is still reported covered — a gap in one entry never hides another
  for (const other of present) {
    const r = results.find((x) => x.id === other.id);
    assert.equal(r?.covered, true, `"${other.id}" should still be covered`);
  }
});

test("checkRunbookCoverage: a heading present with only a stub line under it FAILS with section-too-short", () => {
  const body =
    "This section explains the procedure in enough sentences to be genuinely non-trivial, " +
    "covering the exact commands an operator runs and what to check afterward before moving on.";
  const guide = REQUIRED_PROCEDURES.map((p, i) =>
    i === 0 ? `## ${p.exampleHeading}\n\nTODO.\n` : `## ${p.exampleHeading}\n\n${body}\n`,
  ).join("\n");

  const results = checkRunbookCoverage(guide);
  const stub = results.find((r) => r.id === REQUIRED_PROCEDURES[0].id);
  assert.equal(stub?.covered, false);
  assert.equal(stub?.reason, "section-too-short");
  assert.equal(isRunbookFullyCovered(guide), false);
});

test("checkRunbookCoverage: an empty guide fails every required procedure, none silently pass", () => {
  const results = checkRunbookCoverage("");
  assert.equal(results.length, REQUIRED_PROCEDURES.length);
  assert.ok(results.every((r) => r.covered === false));
  assert.equal(isRunbookFullyCovered(""), false);
});

test("checkRunbookCoverage: a section's content does not leak into the NEXT procedure's word count", () => {
  // First procedure has only a stub; the SECOND procedure's long body must not rescue it —
  // proves sectionBody() actually stops at the next heading rather than reading to EOF.
  const long = "word ".repeat(50);
  const guide = `## ${REQUIRED_PROCEDURES[0].exampleHeading}\n\nTODO.\n\n## ${REQUIRED_PROCEDURES[1].exampleHeading}\n\n${long}\n`;
  const results = checkRunbookCoverage(guide);
  assert.equal(results.find((r) => r.id === REQUIRED_PROCEDURES[0].id)?.covered, false);
  assert.equal(results.find((r) => r.id === REQUIRED_PROCEDURES[1].id)?.covered, true);
});

// ── The real docs/operator-guide.md: every required procedure actually documented ───────────

test("runbook coverage: docs/operator-guide.md has a non-trivial entry for every required crisis procedure", async () => {
  const guide = await readFile(join(REPO_ROOT, "docs", "operator-guide.md"), "utf8");
  const results = checkRunbookCoverage(guide);
  const uncovered = results.filter((r) => !r.covered);
  assert.deepEqual(uncovered, [], `docs/operator-guide.md is missing runbook coverage for: ${JSON.stringify(uncovered)}`);
  assert.equal(isRunbookFullyCovered(guide), true);
});

test("runbook coverage: the required-procedure list covers the four named in W1-T217's acceptance criteria", () => {
  const ids = new Set(REQUIRED_PROCEDURES.map((p) => p.id));
  for (const expected of ["supervisor-restart", "token-rotation", "first-run-setup", "billing-boundary"]) {
    assert.ok(ids.has(expected), `REQUIRED_PROCEDURES is missing "${expected}"`);
  }
});
