import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  REGENERABLE_ARTIFACT_GENERATORS,
  conflictRefusalCause,
  deriveDisposition,
  isPureConcurrentAddition,
  isRegenerableArtifactConflict,
  type ConflictFileDiff,
  type OpenPrView,
} from "../src/lib/sweep.js";

/**
 * W1-T2548 — MEASURED 2026-08-30, six merge conflicts in one evening, every one the SAME shape:
 * two PRs each changing the SAME key of `scripts/source-size-baseline.json` to a DIFFERENT
 * number — a deleted line plus an added line under an existing key, never a pure addition. The
 * merged truth matched NEITHER recorded side, every time (#3417: 32759/32767 -> 32778; #3391:
 * 32788/32767 -> 32807). `isPureConcurrentAddition` (W1-T94) requires ZERO deletions on BOTH
 * sides, so it refuses this shape BY CONSTRUCTION — the rung W1-T2536 turned on has admitted
 * nothing since, because the population it exists to admit never once matched.
 *
 * The fix (rationale (3)/(4)): a DECLARED generator registry ({@link
 * REGENERABLE_ARTIFACT_GENERATORS}) — data a human wrote, never an inference — names which paths
 * are reproduced from the tree by a generator. For such a path the resolution is not a merge:
 * re-run the generator on the MERGED tree and its output is correct by construction, so a
 * same-key value conflict confined to declared paths is admitted; anything else (an undeclared
 * path, or a mix of declared and undeclared) stays refused exactly as before this task.
 */

const NOW = Date.parse("2026-08-31T00:00:00.000Z");

/** A green, review-passing, dirty PR carrying the given conflict-file evidence — mirrors
 *  `reconstructedConflict` (test/sweep-conflicted-disposition.test.ts), reused as a bare fixture
 *  here so this file stays self-contained per its own declared scope. */
function dirtyPr(files: ConflictFileDiff[]): OpenPrView {
  return {
    prNumber: 2548,
    prUrl: "https://github.com/craigoley/remudero/pull/2548",
    taskId: "W1-T2548",
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    strikeHistory: [],
    lastActivityAt: "2026-08-30T23:55:00.000Z",
    headSha: "cafef00d",
    autoMergeArmed: false,
    isDependabot: false,
    mergeState: "dirty",
    mergeConflict: { files, oursLog: "abc1234 (reconstructed)", theirsLog: "def5678 (reconstructed)" },
  } as OpenPrView;
}

const REGISTERED_PATH = "scripts/source-size-baseline.json";
const HAND_WRITTEN_PATH = "src/lib/hand-written.ts";

/** The exact shape MEASURED on this repo: a same-key VALUE change (a deletion on each side) on a
 *  path this task's registry declares a generator for. */
function sameKeyValueChange(over: Partial<ConflictFileDiff> = {}): ConflictFileDiff {
  return { path: REGISTERED_PATH, oursDeleted: 1, theirsDeleted: 1, ...over };
}

// ── isRegenerableArtifactConflict: the predicate itself ──────────────────────────────────────

test("isRegenerableArtifactConflict: every conflicting path declared -> true, REGARDLESS of deletions (the whole point: a same-key value change always carries one)", () => {
  assert.equal(isRegenerableArtifactConflict([sameKeyValueChange()]), true);
  assert.equal(
    isRegenerableArtifactConflict([sameKeyValueChange({ oursDeleted: 0, theirsDeleted: 0 })]),
    true,
    "also true for a pure addition on a declared path — the registry arm does not care about deletions either way",
  );
});

test("isRegenerableArtifactConflict: any undeclared path -> false, including a mix of declared and undeclared", () => {
  assert.equal(isRegenerableArtifactConflict([{ path: HAND_WRITTEN_PATH, oursDeleted: 1, theirsDeleted: 1 }]), false);
  assert.equal(
    isRegenerableArtifactConflict([sameKeyValueChange(), { path: HAND_WRITTEN_PATH, oursDeleted: 1, theirsDeleted: 1 }]),
    false,
    "one undeclared path sinks the WHOLE conflict — never a partial admission",
  );
  assert.equal(isRegenerableArtifactConflict([]), false, "no captured file evidence never defaults to safe");
});

// ── acceptance 1: a same-key value conflict on a declared path is ADMITTED ───────────────────

test("acceptance 1 — a same-key value conflict in a file with a declared generator is admitted (disposition 'conflicted'), not refused", () => {
  const pr = dirtyPr([sameKeyValueChange()]);
  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "conflicted", "the exact shape isPureConcurrentAddition refuses by construction is now admitted");
  assert.notEqual(r.disposition, "blocked-ambiguous");

  // The falsifier this predicate exists to distinguish from: the SAME file evidence reads FALSE
  // on the pure-addition arm, so admission here comes from the registry arm, never a widened
  // pure-addition predicate.
  assert.equal(isPureConcurrentAddition([sameKeyValueChange()]), false, "sanity: this shape is NOT a pure concurrent addition");
});

// ── acceptance 2: the resolution is the generator's OWN output, never either recorded side ──

test("acceptance 2 — the dispatch reason names the declared generator and says the resolution is its OWN output on the merged tree, never either side's recorded value", () => {
  const pr = dirtyPr([sameKeyValueChange()]);
  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "conflicted");
  assert.equal(REGENERABLE_ARTIFACT_GENERATORS[REGISTERED_PATH], "source-size-ratchet", "the registry names the actual npm-run generator id");
  assert.match(r.reason, /declared generator/);
  assert.match(r.reason, new RegExp(REGENERABLE_ARTIFACT_GENERATORS[REGISTERED_PATH]), "names the generator id itself, not merely 'a generator'");
  assert.match(r.reason, /merged tree/);
  assert.match(r.reason, /never either side's recorded value/, "explicitly rules out picking ours/theirs — the generator's output is authoritative");
});

// ── acceptance 3: a conflicted path with NO declared generator is still refused ──────────────

test("acceptance 3 — a same-key value conflict on a path with no declared generator is still refused, so admission is bounded by a written list, not an inference", () => {
  const pr = dirtyPr([{ path: HAND_WRITTEN_PATH, oursDeleted: 1, theirsDeleted: 1 }]);
  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.notEqual(r.disposition, "conflicted", "no entry in REGENERABLE_ARTIFACT_GENERATORS for this path -> never auto-resolved");
  assert.equal(HAND_WRITTEN_PATH in REGENERABLE_ARTIFACT_GENERATORS, false, "sanity: this path really is undeclared");
});

// ── acceptance 4: hand-written + regenerable mixed -> refused WHOLE ─────────────────────────

test("acceptance 4 — a conflict touching hand-written source alongside a regenerable path is refused WHOLE, never partially admitted", () => {
  const pr = dirtyPr([sameKeyValueChange(), { path: HAND_WRITTEN_PATH, oursDeleted: 1, theirsDeleted: 1 }]);
  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous", "one undeclared path in the conflict refuses the ENTIRE conflict, including its declared sibling");
  assert.notEqual(r.disposition, "conflicted");
});

// ── acceptance 5: the refusal cause names which condition failed ────────────────────────────

test("acceptance 5 — the refusal cause names WHICH path lacks a declared generator in a mixed conflict, so a refusal is diagnosable without re-deriving it", () => {
  const files: ConflictFileDiff[] = [sameKeyValueChange(), { path: HAND_WRITTEN_PATH, oursDeleted: 1, theirsDeleted: 1 }];
  const cause = conflictRefusalCause(files, DEFAULT_SWEEP_POLICY);
  assert.match(cause, /involves a deletion/);
  assert.match(cause, new RegExp(HAND_WRITTEN_PATH.replace(/[/.]/g, "\\$&")), "names the SPECIFIC undeclared path, not a generic refusal");
  assert.doesNotMatch(cause, new RegExp(REGISTERED_PATH.replace(/[/.]/g, "\\$&")), "the DECLARED sibling is not named as a problem — only the undeclared one is");

  // The full escalation reason (what actually posts) carries the same diagnosis.
  const pr = dirtyPr(files);
  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.match(r.reason, /no declared generator/);
});

test("acceptance 5 (contrast) — an all-hand-written deletion conflict keeps the plain 'involves a deletion' cause, since the registry has nothing to say about it", () => {
  const cause = conflictRefusalCause([{ path: HAND_WRITTEN_PATH, oursDeleted: 1, theirsDeleted: 1 }], DEFAULT_SWEEP_POLICY);
  assert.equal(cause, "involves a deletion");
});
