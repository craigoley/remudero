import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDispatchBreakerCache,
  corroboratesForwardProgress,
  evaluateDispatchBreaker,
  evaluateDispatchBreakerCorroborated,
  isLifetimeDispatchCapExceeded,
  readLedgerLines,
  type PrRef,
} from "../src/lib/status.js";

// ── W1-T414: "the dispatch breaker's COUNT is necessarily per-host but its RESET is local for
// no reason the design requires" ───────────────────────────────────────────────────────────
//
// `dispatchesWithoutNewOwnedPr` zeroes on a local `pr.opened` ledger line, and that line is
// written only after THIS host's own worker pushes its own `run-<taskId>-<epochMs>` branch.
// A task that opened a PR from a DIFFERENT host's container stays penalised here purely
// because the proof of its success was written to a different log file — even though the
// branch that proof describes is a GitHub-visible name, identical from every host.
//
// `evaluateDispatchBreakerCorroborated` fixes the asymmetry: it defers to
// `evaluateDispatchBreaker`'s local, per-host COUNT unchanged, and only when that count says
// "tripped" does it ask whether GitHub's own batched `listOpenHeadBranches` view names a
// branch this task owns. A corroborating branch downgrades tripped -> clear, exactly as a
// local `pr.opened` line already would; anything else (no branch, or an unreadable read)
// leaves the local verdict exactly as it was.

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-breaker-corroborated-"));
}

function runStartLines(taskId: string, n: number): string {
  return Array.from({ length: n }, () => JSON.stringify({ step: "run.start", task_id: taskId })).join("\n") + "\n";
}

function openPr(headRefName: string, number = 1): PrRef {
  return { number, url: `https://github.com/o/r/pull/${number}`, state: "OPEN", headRefName };
}

// ── corroboratesForwardProgress: the pure ownership lookup ─────────────────────────────────

test("corroboratesForwardProgress: an owned run-<taskId>-<epochMs> branch corroborates", () => {
  const branches = [openPr("run-W1-CORROBORATED-1785957031821")];
  assert.equal(corroboratesForwardProgress(branches, "W1-CORROBORATED"), "corroborated");
});

test("corroboratesForwardProgress: the bare run-<taskId> form also corroborates", () => {
  const branches = [openPr("run-W1-BARE")];
  assert.equal(corroboratesForwardProgress(branches, "W1-BARE"), "corroborated");
});

test("corroboratesForwardProgress: the slug run-<taskId>-<anything> form also corroborates", () => {
  const branches = [openPr("run-W1-SLUG-open-pr-corroboration")];
  assert.equal(corroboratesForwardProgress(branches, "W1-SLUG"), "corroborated");
});

test("corroboratesForwardProgress: a prefix-colliding OTHER task's branch does not corroborate", () => {
  // run-W1-T152-... must never corroborate W1-T15 (TRAP 1: the shared prefix).
  const branches = [openPr("run-W1-T152-1785957031821")];
  assert.equal(corroboratesForwardProgress(branches, "W1-T15"), "not-corroborated");
});

test("corroboratesForwardProgress: a successful read naming no owned branch is not-corroborated, not unreadable", () => {
  assert.equal(corroboratesForwardProgress([], "W1-NONE"), "not-corroborated");
  assert.equal(corroboratesForwardProgress([openPr("feat-unrelated")], "W1-NONE"), "not-corroborated");
});

test("corroboratesForwardProgress: a failed read (null) and an unoffered read (undefined) are both unreadable", () => {
  assert.equal(corroboratesForwardProgress(null, "W1-ANY"), "unreadable");
  assert.equal(corroboratesForwardProgress(undefined, "W1-ANY"), "unreadable");
});

// ── evaluateDispatchBreakerCorroborated: the four acceptance claims ────────────────────────

test("a task at the streak threshold whose own run branch carries a PR on GitHub is no longer tripped", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "W1-CORROBORATED";
    writeFileSync(ledgerPath, runStartLines(taskId, 5));
    const cache = createDispatchBreakerCache();

    // Sanity: the LOCAL-only view (unchanged) is tripped.
    assert.equal(evaluateDispatchBreaker(ledgerPath, taskId, cache, { maxDispatches: 5 }), "tripped");

    const freshCache = createDispatchBreakerCache();
    const openHeadBranches = [openPr(`run-${taskId}-1785957031821`)];
    const state = evaluateDispatchBreakerCorroborated(ledgerPath, taskId, freshCache, openHeadBranches, {
      maxDispatches: 5,
    });
    assert.equal(
      state,
      "clear",
      "an open PR on this task's OWN run branch, visible to GitHub, must forgive the streak exactly as a local pr.opened line would",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same task with no such branch stays tripped -- corroboration discriminates rather than forgiving every task", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "W1-NOBRANCH";
    writeFileSync(ledgerPath, runStartLines(taskId, 5));
    const cache = createDispatchBreakerCache();

    // A SUCCESSFUL read that simply names no branch of THIS task (an unrelated task's PR is
    // present, proving the lookup is not merely "any read succeeded").
    const openHeadBranches = [openPr("run-W1-SOME-OTHER-TASK-1785957031821")];
    const state = evaluateDispatchBreakerCorroborated(ledgerPath, taskId, cache, openHeadBranches, {
      maxDispatches: 5,
    });
    assert.equal(state, "tripped", "no corroborating branch for THIS task must leave the local tripped verdict alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable branch read leaves the breaker deciding on the local count alone -- a network failure never changes a dispatch decision", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "W1-UNREADABLE";
    writeFileSync(ledgerPath, runStartLines(taskId, 5));

    // Tripped locally, with an UNREADABLE (failed, `null`) batched GitHub read.
    const trippedCache = createDispatchBreakerCache();
    const trippedState = evaluateDispatchBreakerCorroborated(ledgerPath, taskId, trippedCache, null, {
      maxDispatches: 5,
    });
    assert.equal(trippedState, "tripped", "unreadable must fall back to the local tripped verdict, never 'dispatch anyway'");

    // Clear locally (below threshold), with the SAME unreadable read -- must not newly trip it
    // either: unreadable degrades to the local count in BOTH directions.
    const clearDir = tmpDir();
    try {
      const clearLedgerPath = join(clearDir, "ledger.ndjson");
      const clearTaskId = "W1-UNREADABLE-CLEAR";
      writeFileSync(clearLedgerPath, runStartLines(clearTaskId, 2));
      const clearCache = createDispatchBreakerCache();
      const clearState = evaluateDispatchBreakerCorroborated(clearLedgerPath, clearTaskId, clearCache, null, {
        maxDispatches: 5,
      });
      assert.equal(clearState, "clear", "unreadable must not 'refuse' a task the local count already clears");
    } finally {
      rmSync(clearDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the lifetime cap still refuses a task over its ceiling even when a corroborating branch exists", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "W1-LIFETIME";
    // 11 lifetime run.start lines: over DEFAULT_MAX_TASK_LIFETIME_DISPATCHES (10), and none of
    // this task's own W1-T271 lifetime counter's inputs are touched by this task's change.
    writeFileSync(ledgerPath, runStartLines(taskId, 11));

    assert.equal(
      isLifetimeDispatchCapExceeded(readLedgerLines(ledgerPath), taskId),
      true,
      "test setup sanity: 11 lifetime dispatches exceeds the default cap of 10",
    );

    // The streak breaker, corroborated by an open PR on this task's own branch, forgives the
    // STREAK -- but the caller (breakerGateFor, run-task.ts) consults isLifetimeCapExceeded as
    // a SEPARATE, independent gate that this task's change never reaches or resets.
    const cache = createDispatchBreakerCache();
    const openHeadBranches = [openPr(`run-${taskId}-1785957031821`)];
    const streakState = evaluateDispatchBreakerCorroborated(ledgerPath, taskId, cache, openHeadBranches);
    assert.equal(streakState, "clear", "sanity: the streak itself IS corroborated-clear here");

    assert.equal(
      isLifetimeDispatchCapExceeded(readLedgerLines(ledgerPath), taskId),
      true,
      "the lifetime cap must still refuse -- a corroborated streak reset must never reach it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
