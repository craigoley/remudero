/**
 * W1-T3015 — THE COMMENT-LOAD BASELINE WAS THE ONE GATE REMEDY THE SCOPE GUARD STILL REFUSED.
 *
 * W1-T2650/W1-T2651 closed this trap for `scripts/source-size-baseline.json`: a failing gate
 * printed an edit as its own remedy, the DECLARED SCOPE sentence forbade every path outside
 * `task.files`, and the fix rung stood down over the very path the gate demanded — "no lane in the
 * fleet could clear it either way." The fix was to admit the path to
 * `REGENERABLE_ARTIFACT_GENERATORS` and read the exemption off that one registry.
 *
 * `comment-load-ratchet` is the same gate shape — an enforcing script beside a `--no-record`
 * signal twin, printing "record it in scripts/comment-load-baseline.json" — and its path was never
 * registered. This suite asserts the three consumers that behaviour flows through, and, in the
 * other direction, that registering one key relaxed NOTHING for a path the table does not name.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fixRungScopeStandDownReason,
  outOfDeclaredScopeFiles,
  renderFixPrompt,
  scopeGuardOutOfScopeFiles,
} from "../src/run-task.js";
import { REGENERABLE_ARTIFACT_GENERATORS, isRegenerableArtifactConflict } from "../src/lib/sweep.js";

const COMMENT_LOAD = "scripts/comment-load-baseline.json";
const SIZE_TWIN = "scripts/source-size-baseline.json";
const UNDECLARED = "src/lib/rogue.ts";
const DECLARED = ["src/lib/worker.ts"];

/** A conflict-file record with no deletions on either side — deletions are irrelevant to the
 *  registry arm (the generator re-run supersedes both recorded values), and using zeroes keeps
 *  this suite from accidentally passing through `isPureConcurrentAddition` instead. */
const conflict = (path: string, oursDeleted = 1, theirsDeleted = 1) => ({ path, oursDeleted, theirsDeleted });

const ciEvidence = () => ({ ciFailures: [{ name: "comment-load-ratchet", logTail: "comment-load-ratchet: BLOCKED" }] });
const promptFor = (files: readonly string[] | undefined) =>
  renderFixPrompt({ task: { id: "W1-T3015X", title: "some task", ...(files ? { files } : {}) }, round: 1, branch: "run-W1-T3015X-1", evidence: ciEvidence() as never });

// ── criterion 1: the conflict rung admits it and names its generator ─────────────────────────

test("W1-T3015: a conflict confined to the comment-load baseline is admitted as a regenerable-artifact conflict", () => {
  assert.equal(isRegenerableArtifactConflict([conflict(COMMENT_LOAD)]), true);
});

test("W1-T3015: the registry names the RECORDING script, not the --no-record signal twin", () => {
  // `comment-load-signal` passes --no-record and by construction leaves the file byte-identical;
  // registering it would declare a generator that regenerates nothing.
  assert.equal(REGENERABLE_ARTIFACT_GENERATORS[COMMENT_LOAD], "comment-load-ratchet");
  assert.notEqual(REGENERABLE_ARTIFACT_GENERATORS[COMMENT_LOAD], "comment-load-signal");
});

test("W1-T3015: it is admitted ALONGSIDE its twin, so a conflict straddling both baselines still resolves", () => {
  assert.equal(isRegenerableArtifactConflict([conflict(COMMENT_LOAD), conflict(SIZE_TWIN)]), true);
});

// ── criterion 2: the scope guard no longer flags it ──────────────────────────────────────────

test("W1-T3015: committing the comment-load baseline alongside a task's declared scope is no longer out-of-scope", () => {
  assert.deepEqual(scopeGuardOutOfScopeFiles([...DECLARED, COMMENT_LOAD], DECLARED), []);
  assert.deepEqual(outOfDeclaredScopeFiles([...DECLARED, COMMENT_LOAD], DECLARED), []);
});

test("W1-T3015: and the fix rung no longer stands down over it — obeying the gate is not punished", () => {
  assert.equal(fixRungScopeStandDownReason([...DECLARED, COMMENT_LOAD], [...DECLARED], DECLARED), undefined);
});

// ── criterion 3 & 4: what the worker is told ─────────────────────────────────────────────────

test("W1-T3015: the registry exception a non-plan-only worker is shown NAMES the comment-load baseline", () => {
  const prompt = promptFor(DECLARED);
  assert.match(prompt, /REGISTRY EXCEPTION/);
  assert.ok(prompt.includes(COMMENT_LOAD), "the enumerated registry paths must include it, or the worker is still told not to touch it");
  assert.match(prompt, /MAY commit it alongside the declared scope/);
});

test("W1-T3015: a PLAN-ONLY task is still shown no registry exception — that regime is untouched", () => {
  // A plan-only PR's scope regime is plan membership, which this registry was never wired into;
  // promising the exception there would tell a worker something the pre-strike gate would refuse.
  assert.doesNotMatch(promptFor(["plan/tasks.d/W1-T3015X-x.yaml"]), /REGISTRY EXCEPTION/);
});

// ── THE FALSIFIER: registering one key must relax NOTHING for a path the table does not name ──

test("W1-T3015 (falsifier): a conflict straddling an UNDECLARED path is still refused WHOLE", () => {
  assert.equal(isRegenerableArtifactConflict([conflict(COMMENT_LOAD), conflict(UNDECLARED)]), false,
    "the mixed case is the mechanism — one hand-written path refuses the whole conflict");
  assert.equal(isRegenerableArtifactConflict([conflict(UNDECLARED)]), false);
});

test("W1-T3015 (falsifier): an UNDECLARED path is still reported out of scope, even beside the newly admitted one", () => {
  // Deliberately a MEMBERSHIP assertion, not a whole-set one. Asserting the set were exactly
  // [UNDECLARED] would fold row 4's claim (the baseline is admitted) into this row, and the two
  // would then redden together — leaving no row that holds the refusal fixed while the admission
  // moves. What is under test here is only that an admitted path travelling in the same diff does
  // not launder an undeclared one; whether COMMENT_LOAD is itself admitted is row 4's business.
  assert.ok(
    scopeGuardOutOfScopeFiles([...DECLARED, UNDECLARED, COMMENT_LOAD], DECLARED).includes(UNDECLARED),
    "an undeclared path must stay out of scope no matter what it travels beside",
  );
  const stood = fixRungScopeStandDownReason([...DECLARED, UNDECLARED, COMMENT_LOAD], [...DECLARED], DECLARED);
  assert.ok(stood, "a genuinely out-of-scope path must still stand the rung down");
  assert.ok(stood?.newOutOfScopePaths.includes(UNDECLARED));
});

test("W1-T3015 (falsifier): an UNDECLARED path is still absent from the rendered exception", () => {
  assert.ok(!promptFor(DECLARED).includes(UNDECLARED));
});

test("W1-T3015 (falsifier): THE UNDECLARED-TASK ARM — a task declaring NO scope still has every file refused, registry path included", () => {
  // This is the row a careless implementation leaks the exemption into: the exemptions are only
  // ever consulted alongside a declared scope, and an undeclared task refuses every non-empty diff.
  assert.deepEqual(scopeGuardOutOfScopeFiles([COMMENT_LOAD], undefined), [COMMENT_LOAD]);
  assert.deepEqual(scopeGuardOutOfScopeFiles([COMMENT_LOAD], []), [COMMENT_LOAD]);
});
