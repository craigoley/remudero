import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_RED_REFRESH_STEP,
  BASE_RED_STOOD_DOWN_STEP,
  DEFAULT_SWEEP_POLICY,
  mainLatestRunFromLedger,
  runSweep,
  type CiFailure,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";

// W1-T4351 — the sweep spent its one thread on ci-log fix workers that could never commit: plan-only
// PRs (refused "the task declares no files") and reds main itself carried. Each test drives the real
// `runSweep` with in-memory ledger and effect fakes; nothing here reaches gh or git.

const NOW = Date.parse("2026-09-23T12:00:00Z");
const MAIN_RED = "b".repeat(40);
const MAIN_GREEN = "c".repeat(40);

function failure(name: string): CiFailure {
  return { name, logTail: "AssertionError: expected 160, got 161", conclusion: "FAILURE" };
}

function redPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 6854,
    prUrl: "https://github.com/acme/remudero/pull/6854",
    taskId: "W1-T4351",
    reviewState: "pending",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    headSha: "a".repeat(40),
    headRefName: "run-W1-T4351-1",
    autoMergeArmed: false,
    ciFailures: [failure("coverage")],
    ...over,
  };
}

// A green peer keeps `classifyRedCause` off "base-caused": the red is on ONE PR, not every PR.
function greenPeer(): OpenPrView {
  return redPr({
    prNumber: 6900,
    prUrl: "https://github.com/acme/remudero/pull/6900",
    taskId: "W1-T4000",
    checksState: "green",
    reviewState: "success",
    headSha: "e".repeat(40),
    headRefName: "run-W1-T4000-1",
    ciFailures: undefined,
  });
}

function mainObserved(sha: string, state: string, failing: unknown = []): Record<string, unknown> {
  return { step: "main.health.observed", sha, state, failing_checks: failing };
}

async function sweep(prs: OpenPrView[], ledger: Record<string, unknown>[], over: Partial<SweepDeps> = {}) {
  const dispatched: number[] = [];
  const escalated: Array<{ pr: number; reason: string }> = [];
  const updated: number[] = [];
  const summary = await runSweep(
    prs,
    {
      arm: () => {},
      close: () => {},
      dispatchFix: (pr) => {
        dispatched.push(pr.prNumber);
      },
      escalate: (pr, reason) => {
        escalated.push({ pr: pr.prNumber, reason });
      },
      postReview: async () => {},
      updateBranch: (pr) => {
        updated.push(pr.prNumber);
        return "updated";
      },
      ledgerPath: "/dev/null/w1-t4351.ndjson",
      runId: "W1-T4351-test",
      readLedger: () => ledger,
      // Shared with `readLedger`, so a later pass folds what an earlier one wrote.
      appendLine: (_path, line) => {
        ledger.push(line);
      },
      now: () => NOW,
      ...over,
    },
    DEFAULT_SWEEP_POLICY,
  );
  const disposed = (n: number) => ledger.filter((l) => l.step === "sweep.disposed" && l.pr_number === n).at(-1);
  return { summary, dispatched, escalated, updated, disposed };
}

test("W1-T4351: a plan-only PR's red never dispatches the code-fix lane", async () => {
  const filing = redPr({ isPlanFiling: true, planFilingSource: "github-files", ciFailures: [failure("lint-plan")] });
  const ledger: Record<string, unknown>[] = [];
  const r = await sweep([filing, greenPeer()], ledger);
  assert.deepEqual(r.dispatched, [], "a plan-only PR has no surface a code-fix worker can stage");
  assert.equal(r.escalated.length, 1);
  assert.match(r.escalated[0]!.reason, /plan-only PR is red on lint-plan/);
  assert.equal(r.disposed(6854)?.disposition, "refused-escalate");

  // Bounded: the escalation is deduped per head, never re-filed every pass.
  const again = await sweep([filing, greenPeer()], ledger);
  assert.deepEqual(again.escalated, []);
  assert.deepEqual(again.dispatched, []);

  // A filing whose red carries no failure detail still names that it is red.
  const unnamed = await sweep([redPr({ isPlanFiling: true, ciFailures: [] }), greenPeer()], []);
  assert.match(unnamed.escalated[0]!.reason, /plan-only PR is red on a required check/);
});

test("W1-T4351: a red that main also carries refreshes the branch instead of dispatching a fix", async () => {
  const pr = redPr();
  const ledger: Record<string, unknown>[] = [mainObserved(MAIN_RED, "red", ["coverage", 7])];

  // Pass 1 — main's latest run fails the same check: stand down, ledger the base red, no refresh yet.
  const waiting = await sweep([pr, greenPeer()], ledger);
  assert.deepEqual(waiting.dispatched, [], "a base red is never the fix lane's");
  assert.deepEqual(waiting.updated, [], "refreshing onto a still-red main would only re-import the red");
  assert.match(String(waiting.disposed(6854)?.stand_down_reason), /coverage also fails on main's latest run/);
  assert.equal(ledger.filter((l) => l.step === BASE_RED_STOOD_DOWN_STEP).length, 1);

  // Pass 2 — main is still red: the record is not duplicated.
  await sweep([pr, greenPeer()], ledger);
  assert.equal(ledger.filter((l) => l.step === BASE_RED_STOOD_DOWN_STEP).length, 1);

  // Pass 3 — main's fix is in flight (undetermined): still waiting, never a fix.
  ledger.push(mainObserved(MAIN_GREEN, "undetermined"));
  const pending = await sweep([pr, greenPeer()], ledger);
  assert.deepEqual(pending.dispatched, []);
  assert.deepEqual(pending.updated, []);

  // Pass 4 — main is green: the branch is refreshed ONCE, and still no fix worker.
  ledger.push(mainObserved(MAIN_GREEN, "green"));
  const refreshed = await sweep([pr, greenPeer()], ledger);
  assert.deepEqual(refreshed.dispatched, []);
  assert.deepEqual(refreshed.updated, [6854], "exactly one update-branch press, and not a second from the post-loop lane");
  assert.match(String(refreshed.disposed(6854)?.stand_down_reason), /branch refresh was requested \(updated\)/);
  assert.equal(ledger.filter((l) => l.step === BASE_RED_REFRESH_STEP).at(-1)?.outcome, "updated");

  // Pass 5 — the same head is STILL red after its one refresh: bounded, it returns to its own lane.
  const after = await sweep([pr, greenPeer()], ledger);
  assert.deepEqual(after.updated, []);
  assert.deepEqual(after.dispatched, [6854]);
});

test("W1-T4351: a base red spends ONE update-branch press per pass, and a thrown press is ledgered", async () => {
  const first = redPr();
  const second = redPr({ prNumber: 6855, prUrl: "https://github.com/acme/remudero/pull/6855", headSha: "f".repeat(40) });
  const ledger: Record<string, unknown>[] = [
    { step: BASE_RED_STOOD_DOWN_STEP, pr_number: 6854, head_sha: first.headSha, check_name: "coverage" },
    { step: BASE_RED_STOOD_DOWN_STEP, pr_number: 6855, head_sha: second.headSha, check_name: "coverage" },
    mainObserved(MAIN_GREEN, "green"),
  ];
  const r = await sweep([first, second, greenPeer()], ledger, {
    updateBranch: () => {
      throw new Error("422 merge conflict");
    },
  });
  assert.deepEqual(r.dispatched, []);
  assert.equal(ledger.filter((l) => l.step === BASE_RED_REFRESH_STEP).length, 1);
  assert.match(String(r.disposed(6854)?.stand_down_reason), /requested \(error: 422 merge conflict\)/);
  assert.match(String(r.disposed(6855)?.stand_down_reason), /one branch refresh is spent or unwired/);
});

test("W1-T4351: a red that is the PR's own still dispatches the fix lane", async () => {
  // Main red on a DIFFERENT check: this PR's red is its own.
  const otherRed = await sweep([redPr(), greenPeer()], [mainObserved(MAIN_RED, "red", ["lint"])]);
  assert.deepEqual(otherRed.dispatched, [6854]);
  assert.deepEqual(otherRed.updated, []);

  // Main green with no base-red record for this head, and no main observation at all.
  assert.deepEqual((await sweep([redPr(), greenPeer()], [mainObserved(MAIN_GREEN, "green")])).dispatched, [6854]);
  assert.deepEqual((await sweep([redPr(), greenPeer()], [])).dispatched, [6854]);

  // A code PR (not a plan filing) keeps the fix lane.
  assert.deepEqual((await sweep([redPr({ isPlanFiling: false }), greenPeer()], [])).dispatched, [6854]);
});

test("W1-T4351: main's latest run is the LAST well-formed main.health.observed row", () => {
  assert.equal(mainLatestRunFromLedger([]), undefined);
  const latest = mainLatestRunFromLedger([
    mainObserved(MAIN_RED, "red", ["coverage"]),
    mainObserved(MAIN_GREEN, "green", "not-an-array"),
    { step: "main.health.observed", sha: 7, state: "red" },
  ]);
  assert.deepEqual(latest, { sha: MAIN_GREEN, state: "green", failingChecks: [] });
});
