import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judgeReview } from "../src/lib/review.js";

// W1-T389 — `walkDiff` set the current file from the diff's `+++` line, and a DELETED
// file's is `+++ /dev/null`, so every removed line was tagged `/dev/null`. `changedFiles`
// filtered exactly that, and a pure deletion contributed NOTHING to the reviewer's
// changed-file list.
//
// `changedFiles`/`walkDiff` are module-private, so every assertion below drives the REAL
// `judgeReview` and observes the list through the verdict fields it feeds — which is also
// the only form that proves the CONSEQUENCE rather than the intermediate value.

/** One file's hunk: deleted (`+++ /dev/null`) or modified (`+++ b/<path>`). */
function fileDiff(path: string, deleted: boolean): string {
  return [
    `diff --git a/${path} b/${path}`,
    deleted ? "deleted file mode 100644" : "index 1111111..4444444 100644",
    `--- a/${path}`,
    deleted ? "+++ /dev/null" : `+++ b/${path}`,
    "@@ -1,2 +0,0 @@",
    "-const gone = 1;",
    "-export default gone;",
  ].join("\n");
}

/** An ADDED file: its `---` line is `/dev/null`, the direction design (ii) asks to confirm. */
function addedFileDiff(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1,2 @@",
    "+const fresh = 1;",
    "+export default fresh;",
  ].join("\n");
}

const CRITERIA = [{ claim: "the easy thing is proven", proof: "unit test: test/easy.test.ts" }];

// ── The measured half: a deletion-heavy diff must be counted, not dropped ────────

test("a deletion-heavy changeset is counted in full, so a truthful file count is no longer failed", () => {
  // PR #1441's real shape: 48 files, 41 of them pure deletions, 7 modified.
  const parts: string[] = [];
  for (let i = 0; i < 41; i++) parts.push(fileDiff(`src/lib/retired-${i}.ts`, true));
  for (let i = 0; i < 7; i++) parts.push(fileDiff(`src/lib/kept-${i}.ts`, false));
  const diff = parts.join("\n");

  // The body states the TRUE count. Before this fix the reviewer saw 7 and failed it.
  const truthful = judgeReview(CRITERIA, { diff, report: "This changeset touches exactly 48 files." });
  assert.equal(
    truthful.changesetContradictions?.length ?? 0,
    0,
    "a body stating the true 48 must not be contradicted by the reviewer's own list",
  );

  // POSITIVE CONTRAST, same diff: the old, deletion-blind number must now BE the wrong one.
  const stale = judgeReview(CRITERIA, { diff, report: "This changeset touches exactly 7 files." });
  assert.equal(
    stale.changesetContradictions?.length ?? 0,
    1,
    "claiming the deletion-blind 7 against a 48-file diff must now contradict",
  );
});

test("additions were never affected — an added file's `--- /dev/null` is skipped, not assigned", () => {
  // design (ii) asks this be confirmed rather than assumed symmetric with the `+++` side.
  const diff = [addedFileDiff("src/lib/new-a.ts"), addedFileDiff("src/lib/new-b.ts")].join("\n");
  const ok = judgeReview(CRITERIA, { diff, report: "This changeset touches exactly 2 files." });
  assert.equal(ok.changesetContradictions?.length ?? 0, 0, "two added files must count as two");
});

// ── The scope half: Standing rule 15's exemption must not be winnable by deleting ──

/** A src/ file (deleted or modified) alongside an acceptance-criteria edit in the MONOLITH.
 *  The monolith matters: `criterionFieldTampered` filters on `plan/tasks.yaml`, so a shard
 *  edit is silent by design and a fixture built on one never reaches this branch at all. */
function ruleFifteenDiff(deleted: boolean): string {
  return [
    fileDiff("src/lib/secret.ts", deleted),
    "diff --git a/plan/tasks.yaml b/plan/tasks.yaml",
    "index 2222222..3333333 100644",
    "--- a/plan/tasks.yaml",
    "+++ b/plan/tasks.yaml",
    "@@ -1,4 +1,4 @@",
    " acceptance:",
    '-    - claim: "the hard thing is proven"',
    '-      proof: "unit test: test/hard.test.ts"',
    '+    - claim: "the easy thing is proven"',
    '+      proof: "unit test: test/easy.test.ts"',
  ].join("\n");
}

test("the rule-15 exemption cannot be won by DELETING a source file instead of editing it", () => {
  const attack = judgeReview(CRITERIA, { diff: ruleFifteenDiff(true), report: "a report" });
  assert.equal(attack.planOnly, false, "a diff touching src/ is not plan-only, however it touches it");
  assert.equal(attack.criteriaTampered, true, "the rule-15 guard must fire on the criteria edit");

  // POSITIVE CONTRAST with delete-vs-modify as the ONLY variable: the modify arm already
  // behaved correctly, and must be unchanged.
  const control = judgeReview(CRITERIA, { diff: ruleFifteenDiff(false), report: "a report" });
  assert.equal(control.planOnly, false);
  assert.equal(control.criteriaTampered, true);
});

test("a genuinely plan-scoped changeset still wins the exemption — the carve-out is not withdrawn", () => {
  // The direction that matters for not over-correcting: an Architect plan-only PR, including
  // one that DELETES a plan file, must still be exempt.
  const diff = [
    fileDiff("plan/tasks.d/W1-T900-retired.yaml", true),
    "diff --git a/plan/tasks.yaml b/plan/tasks.yaml",
    "index 2222222..3333333 100644",
    "--- a/plan/tasks.yaml",
    "+++ b/plan/tasks.yaml",
    "@@ -1,3 +1,3 @@",
    " acceptance:",
    '-    - claim: "old"',
    '+    - claim: "new"',
  ].join("\n");
  const v = judgeReview(CRITERIA, { diff, report: "a report" });
  assert.equal(v.planOnly, true, "a plan-scoped diff, deletions included, is still plan-only");
  assert.equal(v.criteriaTampered, false, "the Architect's own plan-only correction is never failed");
});

// ── The consumer inventory, locked mechanically ─────────────────────────────────

test("every consumer of the shared changed-file list is enumerated, so a new one cannot ship silently", () => {
  // Widening this list CHANGES VERDICTS, so the set of things it feeds is pinned here. A
  // new consumer added without stating its verdict change fails this test until it is
  // listed — which is the point (design iii).
  const src = readFileSync(new URL("../src/lib/review.ts", import.meta.url), "utf8");
  // REAL call sites only. A comment MENTIONING the idiom is not a consumer, and counting one
  // is the same grep-hits-a-comment error this repo has been bitten by in the other
  // direction (a proof satisfied by a comment on entirely unbuilt wiring).
  const callSites = src
    .split("\n")
    .filter((l) => l.includes("changedFiles(walkDiff(") && !/^\s*(\/\/|\*|\/\*)/.test(l)).length;
  assert.equal(
    callSites,
    3,
    "known: judgeReview (planOnly + bodyContradictsDiff + detectInstrumentEntanglement), " +
      "checkOneConcern, checkDocsAwareness. A 4th call site must state its verdict change.",
  );
  // detectInstrumentEntanglement takes the SAME list by argument rather than re-walking, so
  // it is a consumer that this regex cannot see — pinned separately.
  //
  // THE VERDICT CHANGE THIS PIN EXISTS TO FORCE A STATEMENT OF: the rule now also receives the
  // PATCH, so a `src/` path counts as the product half of an entanglement only when its own hunks
  // carry executable content. A diff whose `src/` half is comments or usage strings alone no
  // longer blocks (measured: #2884, split by hand over one appended usage sentence). A behavioural
  // `src/` change beside an instrument still blocks, unchanged (measured: #2934 pre-split, whose
  // own split commit calls it "a true positive"). The second argument is OPTIONAL and omitting it
  // reproduces the path-only reading byte for byte, so a caller that forgets fails CLOSED.
  assert.match(src, /detectInstrumentEntanglement\(diffFiles, evidence\.diff\)/);
});
