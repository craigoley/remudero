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
function dirtyPr(files: ConflictFileDiff[], over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 2548,
    prUrl: "https://github.com/craigoley/remudero/pull/2548",
    taskId: "W1-T2548",
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    strikeHistory: [],
    lastActivityAt: "2026-08-30T23:55:00.000Z", // expiring-fixture: exempt -- aged 10d past the rung, nothing failed; this case ignores the disposition
    headSha: "cafef00d",
    headRefName: "run-W1-T2548-1789430000000",
    autoMergeArmed: false,
    isDependabot: false,
    mergeState: "dirty",
    mergeConflict: { files, oursLog: "abc1234 (reconstructed)", theirsLog: "def5678 (reconstructed)" },
    ...over,
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
  assert.equal(REGENERABLE_ARTIFACT_GENERATORS[REGISTERED_PATH], "source-size-baseline:legacy", "the registry names the explicit legacy generator id");
  assert.match(r.reason, /declared generator/);
  assert.match(r.reason, new RegExp(REGENERABLE_ARTIFACT_GENERATORS[REGISTERED_PATH]), "names the generator id itself, not merely 'a generator'");
  assert.match(r.reason, /merged tree/);
  assert.match(r.reason, /never either side's recorded value/, "explicitly rules out picking ours/theirs — the generator's output is authoritative");
});

// ── acceptance 3: a conflicted rmd-owned path without a generator gets bounded semantic repair ─

test("acceptance 3 — a same-key value conflict on an rmd-owned hand-written path dispatches bounded hunk-level repair, never a generator or side-take", () => {
  const pr = dirtyPr([{ path: HAND_WRITTEN_PATH, oursDeleted: 1, theirsDeleted: 1 }]);
  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "conflicted");
  assert.match(r.reason, /bounded merge-conflict fix worker/);
  assert.match(r.reason, /actual hunks/);
  assert.equal(HAND_WRITTEN_PATH in REGENERABLE_ARTIFACT_GENERATORS, false, "sanity: this path really is undeclared");
});

// ── acceptance 4: hand-written + regenerable mixed remains a worker-owned semantic repair ───

test("acceptance 4 — a conflict touching hand-written source alongside a regenerable path is a semantic repair, never partial generator resolution", () => {
  const pr = dirtyPr([sameKeyValueChange(), { path: HAND_WRITTEN_PATH, oursDeleted: 1, theirsDeleted: 1 }]);
  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "conflicted");
  assert.match(r.reason, /bounded merge-conflict fix worker/);
  assert.doesNotMatch(r.reason, /RE-RUN the generator/);
});

// ── acceptance 5: a non-rmd branch remains blocked ──────────────────────────────────────────

test("acceptance 5 — a contributor branch with the same mixed conflict is blocked without an unattended write", () => {
  const files: ConflictFileDiff[] = [sameKeyValueChange(), { path: HAND_WRITTEN_PATH, oursDeleted: 1, theirsDeleted: 1 }];
  const pr = dirtyPr(files, { headRefName: "feature/contributor-change" });
  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.match(r.reason, /not this PR task's rmd-owned run branch/);
  assert.match(r.reason, /not dispatched/);
});

test("acceptance 5 (contrast) — the explicit policy switch still refuses valid evidence", () => {
  const cause = conflictRefusalCause(
    [{ path: HAND_WRITTEN_PATH, oursDeleted: 1, theirsDeleted: 1 }],
    { ...DEFAULT_SWEEP_POLICY, mergeConflictAdmissionEnabled: false },
  );
  assert.match(cause, /admission is disabled/);
});

// ── the fall-through arm: admitted evidence, enabled policy, no redundant-refix decline ──────
//
// Every other call site returns at one of the THREE earlier disjuncts -- absent evidence, the
// policy switch, or a redundant-refix decline -- so before this pair nothing reached the final
// return at all, and neither of its two arms had a falsifier. The pair below is what makes the
// registry half of the refusal text load-bearing: one arm must NAME the undeclared path, the
// other must not, and each asserts the other's text is absent so a single constant string
// cannot satisfy both.

test("a refusal that reaches the registry check names the path the registry declares no generator for", () => {
  const cause = conflictRefusalCause(
    [{ path: HAND_WRITTEN_PATH, oursDeleted: 1, theirsDeleted: 1 }],
    { mergeConflictAdmissionEnabled: true },
  );
  assert.equal(cause, `conflict repair was not admitted for ${HAND_WRITTEN_PATH}`);
  // It reached the FINAL return, not one of the three earlier disjuncts.
  assert.doesNotMatch(cause, /evidence was captured|admission is disabled|redundant re-fix/);
});

test("the same refusal names no path when every conflicting path has a declared generator", () => {
  const cause = conflictRefusalCause(
    [{ path: REGISTERED_PATH, oursDeleted: 1, theirsDeleted: 1 }],
    { mergeConflictAdmissionEnabled: true },
  );
  assert.equal(cause, "conflict repair was not admitted");
  // The discriminator: the registered path is NOT named, so the arm above is genuinely reached
  // by the undeclared case alone rather than by a constant that happens to contain a path.
  assert.doesNotMatch(cause, new RegExp(REGISTERED_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(REGENERABLE_ARTIFACT_GENERATORS[REGISTERED_PATH], "the fixture path must really be registered");
});
