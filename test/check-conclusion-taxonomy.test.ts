// W1-T2275 (retired as a duplicate of W1-T2274, "the work is still wanted, it is simply carried
// by the other id" — this shard's own §5): W1-T2274's PR #2910 already deleted the wait path's
// private `RED_CONCLUSIONS` set and wired `checkWaitStalled`/`ciGateFromRollup`
// (`src/run-task.ts`) onto `src/lib/sweep.ts`'s own `REQUIRED_CHECK_OK`/`REQUIRED_CHECK_FAIL` —
// confirmed by reading `src/run-task.ts` fresh in this worktree, not carried from that PR's own
// claim. What #2910 did NOT deliver is a suite at THIS path, under THIS task's own acceptance
// wording, naming the GitHub conclusion vocabulary the way this task's rationale enumerates it
// (the eight-member `success/failure/neutral/cancelled/skipped/timed_out/action_required/stale`
// set). This file is that suite, added with NO production change (`src/run-task.ts` and
// `src/lib/sweep.ts` are untouched by this commit) because none is needed — every assertion
// below passes against the code already on `origin/main`.
//
// Every predicate under test here is PURE — no I/O, no clock — so all assertions run in-process.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWaitStalled, ciGateFromRollup, STALL_WINDOW } from "../src/run-task.js";
import { checksStateFromRollup, REQUIRED_CHECK_OK, type RollupCheckEntry } from "../src/lib/sweep.js";

/** GitHub's own check-run/status-context conclusion vocabulary, verbatim from this task's own
 *  rationale (§1): "GitHub's conclusion set is eight values". */
const GITHUB_CONCLUSIONS = [
  "SUCCESS",
  "FAILURE",
  "NEUTRAL",
  "CANCELLED",
  "SKIPPED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STALE",
] as const;

/** `STALL_WINDOW` identical copies of `reading` — the minimum a real caller would have
 *  accumulated before {@link checkWaitStalled} has enough evidence to conclude stalled. */
function identicalWindow(
  reading: { name?: string; context?: string; conclusion?: string; status?: string; state?: string }[],
) {
  return Array.from({ length: STALL_WINDOW }, () => reading);
}

// ── acceptance 1: a clean no-findings result is not reported as still pending ────────────────

test("a NEUTRAL check (a clean no-findings result) is not named in a stalled wait's still-pending list", () => {
  const result = checkWaitStalled(identicalWindow([{ name: "osv-scanner", conclusion: "NEUTRAL" }]));
  assert.equal(result.stalled, true, "an unchanging, nothing-running rollup is still a stall");
  assert.deepEqual(result.pending, [], "NEUTRAL is a concluded, clean result — it must not read as pending");
});

// ── acceptance 2: a check excluded by a condition is not reported as still pending ───────────

test("a SKIPPED check (excluded by a condition) is not named in a stalled wait's still-pending list", () => {
  const result = checkWaitStalled(identicalWindow([{ name: "lint", conclusion: "SKIPPED" }]));
  assert.equal(result.stalled, true);
  assert.deepEqual(result.pending, [], "SKIPPED is a condition-excluded check — it must not read as pending");
});

// ── acceptance 3: a check that never reported is distinguishable from one that objected ──────

test("CANCELLED (nobody reached a verdict) does not gate red the way a genuine FAILURE does", () => {
  assert.notEqual(
    ciGateFromRollup([{ name: "coverage-ratchet", conclusion: "CANCELLED" }]),
    "red",
    "CANCELLED means no verdict was reached — folding it into red asserts a finding never made",
  );
  assert.equal(
    ciGateFromRollup([{ name: "ci", conclusion: "FAILURE" }]),
    "red",
    "control: a genuine FAILURE must still gate red, so the exemption above is narrow, not a removal",
  );
});

test("CANCELLED and a genuine FAILURE take different, distinguishable paths through checkWaitStalled", () => {
  // FAILURE is terminal red and never reaches checkWaitStalled's pending accounting in the real
  // poll loop (`isTerminalRed` short-circuits pollToGate first) — here it is proven directly: a
  // FAILURE is excluded from `pending` exactly like a genuinely done check would be, whereas
  // CANCELLED is a "never reported" state and is named pending so the bounded stall path (not a
  // false terminal verdict) is what eventually surfaces it.
  const cancelled = checkWaitStalled(identicalWindow([{ name: "coverage-ratchet", conclusion: "CANCELLED" }]));
  const failed = checkWaitStalled(identicalWindow([{ name: "ci", conclusion: "FAILURE" }]));
  assert.deepEqual(cancelled.pending, ["coverage-ratchet"], "CANCELLED is 'never reported' — it surfaces via pending, not a false red");
  assert.deepEqual(failed.pending, [], "FAILURE is a real verdict — checkWaitStalled does not also carry it as pending");
});

// ── acceptance 4: an unrecognised conclusion never resolves to green ─────────────────────────

test("a conclusion no set names never resolves to green, in either the wait path or the sweep", () => {
  const unknown = "GITHUB_INVENTS_THIS_TOMORROW";
  assert.ok(!REQUIRED_CHECK_OK.has(unknown), "test fixture sanity: must be unrecognised");

  assert.notEqual(
    ciGateFromRollup([{ name: "ci", conclusion: unknown }]),
    "green",
    "an unrecognised conclusion on the named ci check must never gate green",
  );

  const stallResult = checkWaitStalled(identicalWindow([{ name: "mystery", conclusion: unknown }]));
  assert.deepEqual(stallResult.pending, ["mystery"], "an unrecognised conclusion must read as pending, never as done");

  const rollup: RollupCheckEntry[] = [{ name: "ci-gate", conclusion: unknown, startedAt: "2026-08-01T00:00:00Z" }];
  assert.notEqual(checksStateFromRollup(rollup, ["ci-gate"]), "green", "the sweep must not manufacture a green either");
});

// ── acceptance 5: the wait still stops after five polls without movement ─────────────────────

test("STALL_WINDOW identical readings with nothing running still stops the wait", () => {
  const result = checkWaitStalled(identicalWindow([{ name: "lint", status: "QUEUED" }]));
  assert.equal(STALL_WINDOW, 5, "this task's note pins the window at 5 — it is not this task's to widen");
  assert.equal(result.stalled, true);
});

test("fewer than STALL_WINDOW identical readings is never enough evidence to conclude stalled", () => {
  const short = Array.from({ length: STALL_WINDOW - 1 }, () => [{ name: "lint", status: "QUEUED" }]);
  const result = checkWaitStalled(short);
  assert.equal(result.stalled, false, "an unbounded wait is worse than a wrong verdict, but this is not yet the bound");
});

// ── acceptance 6: the wait path and the sweep agree on every one of the eight conclusions ────

test("every one of GitHub's eight conclusions is green to the wait path if and only if it is green (OK) to the sweep", () => {
  for (const conclusion of GITHUB_CONCLUSIONS) {
    const sweepIsOk = REQUIRED_CHECK_OK.has(conclusion);

    // checkWaitStalled's `pending` filter excludes BOTH a done/green check AND a terminal-red
    // one (the real poll loop never reaches checkWaitStalled on a terminal-red conclusion —
    // `isTerminalRed` short-circuits `pollToGate` first — but the pure function still filters
    // both out), so "not pending" alone conflates the two. Disambiguate with `ciGateFromRollup`,
    // whose red scan (`isTerminalRed`) is NOT restricted to the `ci` check name, so it reports
    // the wait path's own red verdict for ANY conclusion regardless of which check reported it.
    const stallResult = checkWaitStalled(identicalWindow([{ name: "x", conclusion }]));
    const notPending = stallResult.pending.length === 0;
    const isRedToWait = ciGateFromRollup([{ name: "x", conclusion }]) === "red";
    const waitIsGreen = notPending && !isRedToWait;

    assert.equal(
      waitIsGreen,
      sweepIsOk,
      `${conclusion}: wait path green=${waitIsGreen} but sweep's own REQUIRED_CHECK_OK says ${sweepIsOk} — ` +
        "the wait path must consult the SAME green set the sweep already does, not a fourth hand-copy",
    );
  }
});
