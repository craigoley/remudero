/**
 * W1-T2690 — THE MANUAL-REAP RULING WAS COSTED AGAINST 51 BRANCHES AND THE POPULATION HAS TRIPLED
 * UNRE-MEASURED.
 *
 * W1-T448 priced the REAP itself (~8 `gh api` `state=all` pages, 6.4s) and, on that number, ruled
 * the verb stays MANUAL rather than wired into every sweep pass. This task does not re-litigate
 * that: the verb stays manual here too. What W1-T448 never priced was the CHECK for whether it is
 * TIME to run the manual verb — measured 2026-09-02, `git ls-remote --heads origin` (already
 * `remoteBranchNames`) answers that in 670ms as ONE request, no `gh api` page at all.
 * `readOrphanedHeadCount`/`countOrphanedHeads` are that cheap count, and nothing else: they report
 * a number, they delete nothing, and they change no existing verb's behaviour.
 *
 * ANCESTRY ALONE OVERCOUNTS AS "SAFE": `main` only squash-merges, so a genuinely merged branch is
 * never `main`'s ancestor either — `git merge-base --is-ancestor` says false for a merged branch
 * exactly as it does for one still in flight. A head only counts as ORPHANED when BOTH hold: no
 * open PR, AND absent from the base's history. Criterion 3 below is the test that catches ancestry
 * being used ALONE — a head with an open PR but no ancestry is still excluded.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { countOrphanedHeads, readOrphanedHeadCount } from "../src/lib/branch-reaper.js";

// ── CRITERION 1: one remote listing, never an eight-page enumeration ─────────────────────────

test("the count is read from exactly one exec call — one `git ls-remote`, never a page loop", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec = (cmd: string, args: string[]): string => {
    calls.push({ cmd, args });
    return "abc123\trefs/heads/run-W1-T1-1784457601815\n";
  };
  const reading = readOrphanedHeadCount(exec, new Set(), () => false);
  assert.equal(calls.length, 1, "exactly one exec call — never an 8-page gh api enumeration");
  assert.deepEqual(calls[0], { cmd: "git", args: ["ls-remote", "--heads", "origin"] });
  assert.equal(reading.kind, "counted");
});

// ── CRITERION 2: an open-PR head is excluded, an ancestry-absent head is included ─────────────

test("a head with an open PR is excluded; a head with neither an open PR nor ancestry is counted", () => {
  const remoteNames = ["run-W1-T1-1784457601815", "run-W1-T2-1784457601999"];
  const openPrHeads = new Set(["run-W1-T2-1784457601999"]); // has an open PR — must be excluded
  const counts = countOrphanedHeads(remoteNames, openPrHeads, () => false); // neither is in base history
  assert.equal(counts.kind, "counted");
  assert.equal(counts.totalHeads, 2);
  assert.equal(counts.runShapedHeads, 2);
  assert.equal(counts.orphanedHeads, 1, "only the head with no open PR is orphaned");
});

// ── CRITERION 3: ancestry is not the sole reapability test ────────────────────────────────────

test("ancestry-absent alone does not orphan a head — an open PR still excludes it", () => {
  // Both heads read identically on ancestry (main only squash-merges, so `isInBaseHistory` says
  // false for BOTH a merged and an in-flight branch). If ancestry were the sole test, both would
  // be reported orphaned. It is not: the open-PR head must still be excluded.
  const remoteNames = ["run-W1-T3-1784457602111", "run-W1-T4-1784457602222"];
  const openPrHeads = new Set(["run-W1-T3-1784457602111"]);
  const isInBaseHistory = () => false; // squash merge: never an ancestor, for either head
  const counts = countOrphanedHeads(remoteNames, openPrHeads, isInBaseHistory);
  assert.equal(counts.orphanedHeads, 1, "the open-PR head must stay excluded despite absent ancestry");

  // And the converse holds too: a head actually IN the base's history is excluded even with no
  // open PR — ancestry still matters, it is just not sufficient ALONE (the case above).
  const mergedByFastForward = countOrphanedHeads(
    ["run-W1-T5-1784457602333"],
    new Set(),
    () => true,
  );
  assert.equal(mergedByFastForward.orphanedHeads, 0, "in the base's history, and no open PR — not orphaned");
});

// ── CRITERION 4: nothing is deleted, no existing verb's behaviour changes ─────────────────────

test("the count issues no destructive git command — this reports only", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec = (cmd: string, args: string[]): string => {
    calls.push({ cmd, args });
    return "";
  };
  const reading = readOrphanedHeadCount(exec, new Set(), () => false);
  assert.equal(reading.kind, "counted");
  for (const call of calls) {
    assert.equal(call.cmd, "git");
    assert.deepEqual(call.args, ["ls-remote", "--heads", "origin"], "read-only listing, never push/branch -D");
  }
});

test("an empty remote listing counts zero orphans without deleting anything", () => {
  const counts = countOrphanedHeads([], new Set(), () => false);
  assert.equal(counts.kind, "counted");
  assert.equal(counts.orphanedHeads, 0);
});

// ── CRITERION 5: an unreadable remote listing is a named cannot-determine, never a healthy zero ─

test("an exec failure reads as cannot-determine, not a healthy zero orphan count", () => {
  const exec = (): string => {
    throw new Error("fatal: unable to access 'origin': Could not resolve host");
  };
  const reading = readOrphanedHeadCount(exec, new Set(), () => false);
  assert.equal(reading.kind, "cannot-determine");
  if (reading.kind === "cannot-determine") {
    assert.match(reading.reason, /Could not resolve host/);
  }
  // The failure state and the healthy-zero state must never be structurally interchangeable —
  // a caller checking `.kind` cannot mistake one for the other the way a bare `0` could be.
  assert.notEqual((reading as { orphanedHeads?: number }).orphanedHeads, 0);
});
