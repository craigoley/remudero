import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T2215: the claims harness gets a THIRD state ──────────────────────────
//
// `runClaim`'s old `ok: result.status === 0` collapsed every non-zero exit into "the claim is
// false" -- an assertion that COULD NOT RUN at all (a missing file, an unresolvable test loader)
// got rendered under "THE PLAN IS LYING ABOUT THE SYSTEM" exactly like a claim that genuinely
// disagreed with the system. Worse, 13 of plan/claims.yaml's 14 assertions are third-party
// binaries (grep/test/node --test) whose exit codes this repo does not own, so no exit-code
// convention could ever tell the two apart -- the third state has to be decided BEFORE the
// assertion runs, from a declared `precondition_paths` list checked with a plain `fs.existsSync`,
// never from an exit code. This also closes a FAIL-OPEN hazard: a negated assertion
// (`! grep -q needle missing-file`) exits 0 -- a silent, undiagnosed PASS -- when its target is
// simply absent, because `!` negates whatever grep's error exit happens to produce.
//
// (scripts/claims-check.mjs is a plain .mjs file outside tsconfig's `include`, so -- mirroring
// test/claims-check.test.ts's own convention -- it is exercised here only via its CLI surface,
// never imported, keeping this test file itself clean under `tsc --noEmit`.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "claims-check.mjs");
const FIXTURES = join(__dirname, "fixtures", "claims-check");

function runCli(file: string) {
  return spawnSync(process.execPath, [SCRIPT, "--file", join(FIXTURES, file)], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

/** The index in `output` of the FIRST character of `needle` at or after `from`, or throws with
 *  `output` attached so a failed ordering assertion below shows the actual CLI output, not just
 *  "not found". */
function indexOfOrThrow(output: string, needle: string, from = 0): number {
  const i = output.indexOf(needle, from);
  assert.notEqual(i, -1, `expected to find ${JSON.stringify(needle)} (from ${from}) in:\n${output}`);
  return i;
}

// ── Criterion 1: a missing-input assertion is COULD-NOT-RUN, never FALSE ────────────────────────

test("claims-check CLI: a claim whose precondition_paths input is missing is reported COULD-NOT-RUN, never PASS or FAIL", () => {
  const result = runCli("could-not-run.yaml");
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /COULD-NOT-RUN {2}fixture-could-not-run-would-pass/);
  assert.doesNotMatch(output, /PASS {2}fixture-could-not-run-would-pass/);
  assert.doesNotMatch(output, /FAIL {2}fixture-could-not-run-would-pass/);
  assert.match(output, /missing precondition input\(s\): definitely-not-a-real-precondition-input-xyz/);
});

test("claims-check CLI: a could-not-run claim is never rendered under the THE PLAN IS LYING banner", () => {
  const result = runCli("could-not-run.yaml");
  const output = result.stdout + result.stderr;
  assert.doesNotMatch(output, /THE PLAN IS LYING ABOUT THE SYSTEM/);
  assert.match(output, /SOME CLAIM\(S\) COULD NOT BE CHECKED/);
  assert.match(output, /NOT a claim that the plan is lying/);
});

// ── Criterion 2: a genuinely false claim is reported false exactly as it is today ───────────────

test("claims-check CLI: a genuinely false claim (no precondition declared) is still named under THE PLAN IS LYING ABOUT THE SYSTEM, unchanged", () => {
  // Same fixture test/claims-check.test.ts's own "ONE-FALSE" case exercises -- pinned again here
  // because acceptance criterion 2 is this shard's own responsibility to prove, not on loan from
  // a sibling suite that could be edited independently of this one.
  const result = runCli("one-false.yaml");
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /PASS {2}fixture-true\b/);
  assert.match(output, /FAIL {2}fixture-false-planted-lie/);
  assert.match(output, /THE PLAN IS LYING ABOUT THE SYSTEM/);
  assert.match(output, /\[fixture-false-planted-lie\]/);
  assert.match(output, /deliberately false claim/);
  assert.match(output, /assertion:\s+test -e \/definitely-not-a-real-path-xyz/);
  assert.match(output, /exit code:\s+1/);
});

// ── Criterion 3: the could-not-run rendering names the cause BEFORE the claim's own prose ───────

test("claims-check CLI: a could-not-run block prints the missing-input cause before the claim's own prose, in one run alongside a PASS and a FAIL", () => {
  const result = runCli("mixed-states.yaml");
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);

  // All three states appear, distinctly labelled.
  assert.match(output, /PASS {2}fixture-mixed-true/);
  assert.match(output, /FAIL {2}fixture-mixed-false-planted-lie/);
  assert.match(output, /COULD-NOT-RUN {2}fixture-mixed-could-not-run/);

  // The false claim still gets the lying banner; the could-not-run claim gets its own banner and
  // is never inside the false claim's block.
  const lyingBannerAt = indexOfOrThrow(output, "THE PLAN IS LYING ABOUT THE SYSTEM");
  const couldNotRunBannerAt = indexOfOrThrow(output, "SOME CLAIM(S) COULD NOT BE CHECKED");
  const falseClaimBlockAt = indexOfOrThrow(output, "[fixture-mixed-false-planted-lie]");
  assert.ok(falseClaimBlockAt > lyingBannerAt, "the false claim's block must follow the lying banner");

  // Design (iv): within the could-not-run claim's own BLOCK (not the earlier one-line PASS/FAIL/
  // COULD-NOT-RUN summary every claim gets, which necessarily names every claim's prose up front),
  // the CAUSE (the missing path) prints before the claim's own prose text -- what an accusatory
  // reading would foreground. Both are searched for starting at the could-not-run banner so this
  // does not accidentally match the earlier one-line summary, which also contains the claim prose.
  const causeAt = indexOfOrThrow(
    output,
    "missing precondition input(s): definitely-not-a-real-precondition-input-xyz",
    couldNotRunBannerAt,
  );
  const claimProseInBlockAt = indexOfOrThrow(
    output,
    "This claim's own prose should never be printed before its missing-input cause.",
    couldNotRunBannerAt,
  );
  assert.ok(causeAt > couldNotRunBannerAt, "the cause line must be inside the could-not-run section");
  assert.ok(causeAt < claimProseInBlockAt, "the cause must print BEFORE the claim's own prose, not after");
});

// ── Criterion 4: a negated assertion no longer passes when the file it reads is absent ──────────

test("claims-check CLI: a negated assertion (`! grep ...`) over a DECLARED-missing input is COULD-NOT-RUN, not a silent PASS", () => {
  const result = runCli("negated-fail-open.yaml");
  const output = result.stdout + result.stderr;

  // Guarded: precondition_paths names the file the negated grep reads -- the fail-open exit-0 is
  // intercepted before the shell ever runs.
  assert.match(output, /COULD-NOT-RUN {2}fixture-negated-missing-file-guarded/);
  assert.doesNotMatch(output, /PASS {2}fixture-negated-missing-file-guarded/);

  // Unguarded sibling, IDENTICAL assertion, no precondition declared: documents that today, absent
  // an explicit guard, `! grep -q needle <missing file>` still exits 0 -- proving the fix is the
  // declared precondition, not some change to what grep/`!` themselves exit (design (i): this repo
  // cannot own a third-party binary's exit codes).
  assert.match(output, /PASS {2}fixture-negated-missing-file-unguarded/);
});

// ── Criterion 5: the third state is decided WITHOUT consulting the assertion's exit code ────────

test("claims-check CLI: could-not-run fires identically whether the (never-run) assertion would have PASSED or FAILED", () => {
  const wouldPass = runCli("could-not-run.yaml");
  const wouldFail = runCli("could-not-run-would-fail.yaml");
  const passOutput = wouldPass.stdout + wouldPass.stderr;
  const failOutput = wouldFail.stdout + wouldFail.stderr;

  // Both assertions ("true" and "false") declare the SAME missing precondition_paths input, and
  // neither is ever spawned -- so both report the identical COULD-NOT-RUN state despite what their
  // own exit codes would have been (0 and 1 respectively) had they run. If the decision consulted
  // the assertion's exit code at all, these two fixtures would diverge (PASS vs FAIL).
  assert.match(passOutput, /COULD-NOT-RUN {2}fixture-could-not-run-would-pass/);
  assert.match(failOutput, /COULD-NOT-RUN {2}fixture-could-not-run-would-fail/);
  assert.doesNotMatch(passOutput, /PASS {2}fixture-could-not-run-would-pass/);
  assert.doesNotMatch(failOutput, /FAIL {2}fixture-could-not-run-would-fail/);
});

test("claims-check: a structurally invalid precondition_paths (not a non-empty string array) is rejected at parse time, same discipline as a missing required field", () => {
  const result = runCli("precondition-paths-invalid.yaml");
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /invalid "precondition_paths"/);
});

// ── Criterion 6: an unloadable plan still fails the gate and the gate still exits non-zero ──────

test("claims-check CLI: a could-not-run claim STILL turns the overall gate non-zero -- the fix renames a red, it never removes one", () => {
  const result = runCli("could-not-run.yaml");
  assert.notEqual(result.status, 0, "a claim whose input cannot be found must still fail the gate");
  assert.notEqual(result.status, null);

  // Same invariant holds for the mixed fixture (a PASS, a FAIL, and a COULD-NOT-RUN together): the
  // presence of ANY could-not-run or false claim keeps the whole run red.
  const mixed = runCli("mixed-states.yaml");
  assert.notEqual(mixed.status, 0, "could-not-run claims must not be able to quietly let a run go green");
});

// ── Criterion 7: no claim that fails today passes after the change ──────────────────────────────

test("claims-check CLI: every failure shape that was red before W1-T2215 is still red -- ALL-TRUE stays green, ONE-FALSE/EMPTY/MISSING-FIELD/unreadable-file all stay red", () => {
  const allTrue = runCli("all-true.yaml");
  assert.equal(allTrue.status, 0, allTrue.stdout + allTrue.stderr);
  assert.match(allTrue.stdout, /OK -- all 2 claim\(s\) hold/);

  const oneFalse = runCli("one-false.yaml");
  assert.notEqual(oneFalse.status, 0, oneFalse.stdout + oneFalse.stderr);

  const empty = runCli("empty.yaml");
  assert.notEqual(empty.status, 0, empty.stdout + empty.stderr);
  assert.match(empty.stdout + empty.stderr, /ZERO claims/);

  const missingField = runCli("missing-field.yaml");
  assert.notEqual(missingField.status, 0, missingField.stdout + missingField.stderr);
  assert.match(missingField.stdout + missingField.stderr, /missing required string field "assertion"/);

  const doesNotExist = runCli("does-not-exist.yaml");
  assert.notEqual(doesNotExist.status, 0, doesNotExist.stdout + doesNotExist.stderr);
});

test("claims-check: the real plan/claims.yaml (now carrying precondition_paths on 14 of its 15 claims) still holds end-to-end -- adding the third-state mechanism did not turn a true claim red", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /OK -- all 15 claim\(s\) hold/);
});
