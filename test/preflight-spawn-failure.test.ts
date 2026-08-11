/**
 * A preflight step whose subprocess NEVER STARTED must say so, not report a verdict about the code.
 *
 * MEASURED, three times across two drains: `commitlint: FAIL` on commit subjects of 71, 75 and 81
 * characters against a limit of 100 — and the same command, run by hand in the same worktree,
 * exited 0 with no output. The run's own summary recorded `durationMs: 1` for the WHOLE preflight
 * (`preflightCommand` stamps `Date.now() - startedAtMs` across all three steps, one of which is
 * `tsc --noEmit`). A millisecond is not a lint. Whatever ran, it did not lint.
 *
 * THE CONTRACT WAS ALREADY WRITTEN DOWN AND ALREADY BROKEN. `PreflightSpawn`'s `error` field says
 * it is set "only when the child never produced an exit status at all … a caller must treat this as
 * a distinct 'the spawn itself failed' outcome, NEVER as an ordinary nonzero exit whose output
 * happens to be empty." `shellOut` (lib/ci-parity.ts) honours it. `commitlintStep`, `typecheckStep`
 * and `readRangeCommitMessages` — in the file that DECLARES the contract — went straight to
 * `res.status === 0`, so `status: null` read as a failed check with the tool's own (empty) output
 * quoted as its verdict.
 *
 * BOTH DIRECTIONS, EVERY TIME. A test asserting only the spawn-failure wording would pass against a
 * change that stopped linting altogether, so each step is driven with a GENUINE nonzero exit
 * carrying real tool output and must still report that unchanged — including a real
 * `header-max-length` violation, the very rule that was being misreported.
 *
 * THE EMITTER STEP'S FAILURE IS THE OPPOSITE POLARITY AND WORSE. A `git log` that never ran returns
 * empty stdout, which the split/trim/filter turns into ZERO messages — and zero messages is a PASS
 * over an empty set. That direction is asserted explicitly.
 *
 * Its own file per CLAUDE.md's coverage rule.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  commitlintStep,
  emitterChecksStep,
  spawnFailureDetail,
  typecheckStep,
  type PreflightSpawn,
} from "../src/lib/commit-message.js";

/** A spawn whose child NEVER STARTED — `status: null` plus an `error`, exactly the shape
 *  `defaultPreflightSpawn` returns for ENOENT, a signal kill or a buffer ceiling. */
const neverStarted = (message: string): PreflightSpawn => () => ({ status: null, stdout: "", stderr: "", error: message });

/** A spawn whose child RAN and reported a real violation. */
const ranAndFailed = (out: string): PreflightSpawn => () => ({ status: 1, stdout: out, stderr: "" });

/** A spawn whose child ran cleanly. */
const ranClean = (out = ""): PreflightSpawn => () => ({ status: 0, stdout: out, stderr: "" });

// ── the pure predicate ───────────────────────────────────────────────────────

test("spawnFailureDetail speaks ONLY when the child produced no exit status", () => {
  assert.equal(spawnFailureDetail("commitlint", { status: 0 }), undefined, "a clean exit is not a spawn failure");
  assert.equal(spawnFailureDetail("commitlint", { status: 1 }), undefined, "an ordinary nonzero exit is a real verdict");

  const d = spawnFailureDetail("commitlint", { status: null, error: "spawnSync ENOENT" });
  assert.ok(d);
  assert.match(d, /SPAWN FAILURE/);
  assert.match(d, /spawnSync ENOENT/, "the reason the runtime gave must survive to the reader");
  assert.match(d, /did NOT run/, "the reader must be told this is not a result about the code");
});

test("a null status with NO error message still speaks, rather than falling through silently", () => {
  const d = spawnFailureDetail("typecheck", { status: null });
  assert.ok(d);
  assert.match(d, /no exit status and no error message/);
});

// ── commitlint: both directions ──────────────────────────────────────────────

test("commitlint: a child that never started is reported as a SPAWN FAILURE, not as a lint verdict", () => {
  const r = commitlintStep("/repo", { from: "origin/main", to: "HEAD" }, neverStarted("spawnSync /repo/node_modules/.bin/commitlint ENOENT"));
  assert.equal(r.ok, false, "it still fails — the polarity is unchanged");
  assert.match(r.detail, /SPAWN FAILURE/);
  assert.match(r.detail, /ENOENT/);
  assert.doesNotMatch(r.detail, /conform to Conventional Commits/);
  // THE DEFECT, PINNED: the old shape rendered `FAIL — origin/main..HEAD` with an empty body, which
  // reads as "your commits are bad" and sent three investigations at the commit messages.
  assert.doesNotMatch(r.detail, /^commitlint: FAIL — origin\/main\.\.HEAD\s*$/m);
});

test("commitlint: a GENUINE header-max-length violation is still reported verbatim — the control", () => {
  const real = "✖   header must not be longer than 100 characters, current length is 106 [header-max-length]";
  const r = commitlintStep("/repo", { from: "origin/main", to: "HEAD" }, ranAndFailed(real));
  assert.equal(r.ok, false);
  assert.match(r.detail, /header-max-length/, "a real violation must survive the change untouched");
  assert.match(r.detail, /FAIL — origin\/main\.\.HEAD/);
  assert.doesNotMatch(r.detail, /SPAWN FAILURE/, "a child that ran must never be described as one that did not");
});

test("commitlint: a clean run still passes", () => {
  const r = commitlintStep("/repo", { from: "origin/main", to: "HEAD" }, ranClean());
  assert.equal(r.ok, true);
  assert.match(r.detail, /PASS/);
});

// ── typecheck: both directions ───────────────────────────────────────────────

test("typecheck: a child that never started is a SPAWN FAILURE, and a real tsc error is still a real error", () => {
  const dead = typecheckStep("/repo", neverStarted("spawnSync tsc EACCES"));
  assert.equal(dead.ok, false);
  assert.match(dead.detail, /SPAWN FAILURE/);
  assert.match(dead.detail, /EACCES/);

  const real = typecheckStep("/repo", ranAndFailed("src/x.ts(1,1): error TS2304: Cannot find name 'foo'."));
  assert.equal(real.ok, false);
  assert.match(real.detail, /TS2304/, "the compiler's own diagnostic must survive");
  assert.doesNotMatch(real.detail, /SPAWN FAILURE/);
});

// ── emitter-checks: the vacuous-PASS direction ───────────────────────────────

test("emitter-checks: a git log that never ran FAILS instead of passing over zero messages", () => {
  // The opposite polarity and the more dangerous one: empty stdout means zero messages, and zero
  // messages satisfied "every message is clean" trivially — a green light for a check that never ran.
  const r = emitterChecksStep("/repo", { from: "origin/main", to: "HEAD" }, neverStarted("spawnSync git ENOENT"));
  assert.equal(r.ok, false, "an unrun check must never report PASS");
  assert.match(r.detail, /SPAWN FAILURE/);
  assert.doesNotMatch(r.detail, /0 commit message\(s\)/, "the vacuous-pass sentence must not be reachable this way");
});

test("emitter-checks: a genuinely over-length header is still caught — the control", () => {
  const long = "fix(x): " + "y".repeat(120);
  const r = emitterChecksStep("/repo", { from: "origin/main", to: "HEAD" }, ranClean("\0" + long + "\n"));
  assert.equal(r.ok, false);
  assert.match(r.detail, /header-max-length/, "the real rule must still fire on a real violation");
});

test("emitter-checks: a clean message still passes, and the count is real", () => {
  const r = emitterChecksStep("/repo", { from: "origin/main", to: "HEAD" }, ranClean("\0fix(x): a compliant subject\n"));
  assert.equal(r.ok, true);
  assert.match(r.detail, /1 commit message\(s\)/, "a PASS must be over a non-empty set to mean anything");
});

// ── the falsifier ────────────────────────────────────────────────────────────

test("MUTANT: every hand-route step consults the contract, and none reads status before it", () => {
  const src = readFileSync(new URL("../src/lib/commit-message.ts", import.meta.url), "utf8");

  const decl = "export function spawnFailureDetail(";
  assert.equal(src.split(decl).length - 1, 1, "the substitution target must be UNIQUE or the mutant proves nothing");

  // Three call sites: commitlintStep, typecheckStep, readRangeCommitMessages. The declaration line
  // is excluded by matching the CALL form, which carries a string literal first argument.
  const calls = src.match(/spawnFailureDetail\("/g) ?? [];
  assert.equal(calls.length, 3, "all three hand-route steps must consult it — a fix to one is a fix to a third");

  // ORDERING IS THE WHOLE POINT: a call placed BELOW `res.status === 0` would never be reached on a
  // null status, so the mutant asserts each guard precedes its step's ordinary reading.
  for (const step of ["commitlint", "typecheck"]) {
    const guard = src.indexOf(`spawnFailureDetail("${step}"`);
    const ordinary = src.indexOf("const ok = res.status === 0;", guard);
    assert.ok(guard > 0 && ordinary > guard, `${step}'s spawn guard must precede its status reading`);
  }
});
