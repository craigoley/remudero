import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import { readLedgerLines } from "../src/lib/status.js";
import { appendLedger } from "../src/lib/ledger.js";

// ── W1-T2520 — THE FIX-RUNG STRIKE CAP DOES NOT BIND ─────────────────────────────────────────
//
// `priorStrikesFor` (run-task.ts) derives `OpenPrView.priorStrikes` by counting the current head's
// `fix.dispatch` ledger rows at OpenPrView-build time — a read-modify-write with no mutual exclusion — while
// `deps.dispatchFix` ("the one lane W1-T1211 admits into the light pass that spends a worker",
// sweep.ts's own doc) had no claim at all, unlike the review lane's `inFlightReviewKeys`
// (W1-T513). Live: 13 fix-worker dispatches across two PRs against a `strikeCap` of 2, and one
// review posted three times to one sha. These fixtures pin `claimFixDispatch`
// (src/lib/sweep.ts) — module-scoped, `${taskId}@${headSha}`-keyed exactly like the review
// mutex, and RE-READING the ledger the instant the claim is taken so two callers can never act
// on the same stale strike count.
//
// Deliberately a SEPARATE file from test/sweep.test.ts (that file's own convention for a
// concurrency-shaped fix: a race regression wants a file whose failures cannot be confused with
// the disposition-routing surface). Every fixture below routes to `blocked-fixable` via the
// SAME ci-log shape `blockedCiPr()` (test/sweep.test.ts) already proves dispatches — checks red,
// no review posted, one named failing check — so the only thing under test is what happens at
// the dispatch site itself, never disposition routing.

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fix-cap-")), "ledger.ndjson");
}

const NOW = Date.parse("2026-07-17T12:00:00Z");

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    taskId: "W1-TX",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-07-16T12:00:00Z",
    headSha: "aaaa111",
    autoMergeArmed: false,
    ciFailures: [{ name: "ci", logTail: "tsc: error TS2322: ..." }],
    ...over,
  };
}

function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  fixed: Array<{ pr: OpenPrView; evidence: unknown }>;
  escalated: Array<{ pr: OpenPrView; reason: string }>;
} {
  const fixed: Array<{ pr: OpenPrView; evidence: unknown }> = [];
  const escalated: Array<{ pr: OpenPrView; reason: string }> = [];
  return {
    fixed,
    escalated,
    arm: () => {},
    close: () => {},
    dispatchFix: (p, evidence) => {
      fixed.push({ pr: p, evidence });
    },
    escalate: (candidate, reason) => { escalated.push({ pr: candidate, reason }); },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-1",
    now: () => NOW,
    ...overrides,
  };
}

/** Flush pending microtasks without advancing real time — the same idiom
 *  test/sweep.test.ts's own concurrency fixtures use to let a gated call reach its claim. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** `SweepAction` carries no `standDownReason` field — only the ledgered `sweep.disposed` row
 *  does, as `stand_down_reason` (see `finalizeDisposition`, src/lib/sweep.ts). The most RECENT
 *  such row for this PR, since several of these fixtures sweep the same PR more than once. */
function standDownReasonFor(ledgerPath: string, prNumber: number): string | undefined {
  const rows = readLedgerLines(ledgerPath).filter((l) => l.step === "sweep.disposed" && l.pr_number === prNumber);
  const last = rows[rows.length - 1];
  return typeof last?.stand_down_reason === "string" ? last.stand_down_reason : undefined;
}

test("acceptance 1 — two concurrent sweeps dispatch at most one fix worker for the same PR", async () => {
  const lp = ledgerPath();
  let releaseFirst: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const deps = fakeDeps({
    ledgerPath: lp,
    dispatchFix: async (p) => {
      await gate;
      appendLedger(lp, { run_id: "SWEEP-1", task_id: p.taskId ?? "", step: "fix.dispatch", strike: 1 });
    },
  });
  const target = pr({ prNumber: 2001, prUrl: "url/2001", taskId: "W1-CAP1", headSha: "sha-cap1" });

  const first = runSweep([target], deps, DEFAULT_SWEEP_POLICY);
  await flush(); // let `first` reach and hold its claim, without ever settling it

  const second = await runSweep([target], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(second.actions[0].acted, false, "the second, genuinely concurrent call never dispatches");
  assert.match(String(standDownReasonFor(lp, target.prNumber)), /duplicate fix-dispatch key/);

  releaseFirst?.();
  const firstSummary = await first;
  assert.equal(firstSummary.actions[0].acted, true, "the first call's own dispatch still completed");
  const dispatches = readLedgerLines(lp).filter((l) => l.step === "fix.dispatch");
  assert.equal(dispatches.length, 1, "exactly one fix.dispatch row was ever written for this PR");
});

test("acceptance 2 — fix history is re-read under the claim, so judgment cannot race a new round", async () => {
  const lp = ledgerPath();
  const taskId = "W1-CAP2";
  appendLedger(lp, { run_id: "SWEEP-0", task_id: taskId, step: "fix.dispatch", round_id: "old-round", head_sha: "sha-cap2", strike: 1 });
  let judgeCalls = 0;
  const staleView = pr({ prNumber: 2002, prUrl: "url/2002", taskId, headSha: "sha-cap2", priorStrikes: 0 });
  const deps = fakeDeps({ ledgerPath: lp, fixProgressJudge: async () => {
    judgeCalls++;
    appendLedger(lp, { run_id: "SWEEP-racing", task_id: taskId, step: "fix.dispatch", round_id: "new-round", head_sha: "sha-cap2", strike: 2 });
    return { verdict: "continue", reason: "fixture permits the next attempt" };
  } });

  const summary = await runSweep([staleView], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(judgeCalls, 1);
  assert.equal(deps.fixed.length, 0, "the fresh round history invalidates the judgment made against the older snapshot");
  assert.equal(summary.actions[0].acted, false);
  assert.match(String(standDownReasonFor(lp, staleView.prNumber)), /fix round history changed during judgment/);
});

test("acceptance 3 — reaching the former strike cap does not stop a judge-authorized fix round", async () => {
  const lp = ledgerPath();
  const taskId = "W1-CAP3";
  const staleView = pr({ prNumber: 2003, prUrl: "url/2003", taskId, headSha: "sha-cap3", priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap });
  const deps = fakeDeps({ ledgerPath: lp, fixProgressJudge: async () => ({ verdict: "continue", reason: "the regression fixture explicitly permits another round" }) });

  const summary = await runSweep([staleView], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(deps.fixed.length, 1);
  assert.equal(summary.actions[0].acted, true);
});

test("acceptance 4 — the claim is released when the attempt settles, including when it throws", async () => {
  const lp = ledgerPath();
  const target = pr({ prNumber: 2004, prUrl: "url/2004", taskId: "W1-CAP4", headSha: "sha-cap4" });

  const throwingDeps = fakeDeps({
    ledgerPath: lp,
    dispatchFix: () => {
      throw new Error("boom — the worktree checkout raced .git/config's lock");
    },
  });
  const thrownSummary = await runSweep([target], throwingDeps, DEFAULT_SWEEP_POLICY);
  assert.equal(thrownSummary.actions[0].acted, false);
  assert.ok(thrownSummary.actions[0].actionError, "the throw is recorded as an action error, never swallowed silently");

  // A LATER sweep for the exact same PR/head must find the claim already released — never
  // wedged forever by the throw — and dispatch normally.
  const succeedingDeps = fakeDeps({ ledgerPath: lp });
  const secondSummary = await runSweep([target], succeedingDeps, DEFAULT_SWEEP_POLICY);
  assert.equal(succeedingDeps.fixed.length, 1, "the claim from the throwing attempt was released, so this later sweep dispatched normally");
  assert.equal(secondSummary.actions[0].acted, true);
});

test("acceptance 5 — a PR with strikes left still gets its strike: this adds exclusion, never a refusal", async () => {
  const lp = ledgerPath();
  const target = pr({ prNumber: 2005, prUrl: "url/2005", taskId: "W1-CAP5", headSha: "sha-cap5", priorStrikes: 0 });
  const deps = fakeDeps({ ledgerPath: lp });

  const summary = await runSweep([target], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(deps.fixed.length, 1, "a PR nowhere near its cap still gets its fix-rung strike");
  assert.equal(summary.actions[0].acted, true);
});

test("acceptance 6 — two DIFFERENT PRs still dispatch independently, neither blocking the other's claim", async () => {
  const lp = ledgerPath();
  const order: number[] = [];
  let releaseA: (() => void) | undefined;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const depsA = fakeDeps({
    ledgerPath: lp,
    dispatchFix: async (p) => {
      await gateA;
      order.push(p.prNumber);
    },
  });
  const depsB = fakeDeps({
    ledgerPath: lp,
    dispatchFix: (p) => {
      order.push(p.prNumber);
    },
  });
  const a = pr({ prNumber: 3001, prUrl: "url/3001", taskId: "W1-CAPA", headSha: "sha-capa" });
  const b = pr({ prNumber: 3002, prUrl: "url/3002", taskId: "W1-CAPB", headSha: "sha-capb" });

  const pendingA = runSweep([a], depsA, DEFAULT_SWEEP_POLICY); // A's claim taken and held open
  await flush();

  await runSweep([b], depsB, DEFAULT_SWEEP_POLICY); // B's own, distinct key
  assert.deepEqual(order, [3002], "PR B dispatched while PR A's own claim/dispatch was still in flight — distinct keys never cross-block");

  releaseA?.();
  await pendingA;
  assert.deepEqual(order.slice().sort((x, y) => x - y), [3001, 3002], "both PRs' own dispatches completed");
});

test("acceptance 7 — the existing stand-down reasons still fire unchanged, ahead of any claim or dispatch", async () => {
  const lp = ledgerPath();
  const deps = fakeDeps({ ledgerPath: lp });
  // Two open PRs sharing the SAME failing check name -> classifyRedCause reads "base-caused"
  // ("failing on all open PRs this pass, so it is not this diff") and stands down BEFORE the
  // fix-dispatch claim is ever reached — this stand-down predates W1-T2520 and must stay
  // byte-identical: no claim taken, no strike spent, for a reason that has nothing to do with
  // the strike cap at all.
  const shared = { name: "flaky-infra-check", logTail: "connection reset by peer" };
  const a = pr({ prNumber: 4001, prUrl: "url/4001", taskId: "W1-CAPC", headSha: "sha-capc", ciFailures: [shared] });
  const b = pr({ prNumber: 4002, prUrl: "url/4002", taskId: "W1-CAPD", headSha: "sha-capd", ciFailures: [shared] });

  const summary = await runSweep([a, b], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(deps.fixed.length, 0, "no fix worker dispatched — the base-caused stand-down fires first");
  for (const action of summary.actions) {
    assert.equal(action.acted, false);
    assert.match(String(standDownReasonFor(lp, action.prNumber)), /red cause: base-caused/);
  }
});

test("acceptance 8 — removing (releasing) the claim lets a later sweep dispatch again, proving the claim — not something else — was what blocked the concurrent one", async () => {
  assert.ok(DEFAULT_SWEEP_POLICY.strikeCap >= 2, "this fixture needs headroom for two strikes under the default cap");
  const lp = ledgerPath();
  const target = pr({ prNumber: 5001, prUrl: "url/5001", taskId: "W1-CAP8", headSha: "sha-cap8" });

  // Control: A holds its claim open; B, genuinely concurrent, is refused — the SAME mechanism
  // acceptance 1 pins, repeated here as this test's own baseline.
  let releaseA: (() => void) | undefined;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const depsA = fakeDeps({
    ledgerPath: lp,
    dispatchFix: async (p) => {
      await gateA;
      appendLedger(lp, { run_id: "SWEEP-1", task_id: p.taskId ?? "", step: "fix.dispatch", strike: 1 });
    },
  });
  const pendingA = runSweep([target], depsA, DEFAULT_SWEEP_POLICY);
  await flush();

  const depsB = fakeDeps({ ledgerPath: lp });
  await runSweep([target], depsB, DEFAULT_SWEEP_POLICY);
  assert.equal(depsB.fixed.length, 0, "the concurrent second claim, taken while A's is still held, is refused");

  // Remove A's claim by letting its dispatch settle.
  releaseA?.();
  await pendingA;

  // A THIRD, later sweep — not concurrent with anything now — is free to claim again: the
  // release did not wedge this PR out of the fix rung. A NEW head sha (the fix rung's own
  // re-earns-a-strike push, `OpenPrView.headSha`'s own doc — unrelated to this task, and
  // deliberately untouched by it) so the head-keyed dedup that seeds `prior.fixed` off A's
  // now-settled dispatch does not itself explain a second dispatch here; only the claim/strike
  // machinery this task changed can.
  const pushedTarget = { ...target, headSha: "sha-cap8-v2" };
  const depsC = fakeDeps({ ledgerPath: lp });
  await runSweep([pushedTarget], depsC, DEFAULT_SWEEP_POLICY);
  assert.equal(depsC.fixed.length, 1, "once the claim is removed, a later sweep dispatches again — its own (second, still-under-cap) strike");
});

test("W1-T2788: tagged strikes on the unchanged head are given to the progress judge, not auto-exhausted", async () => {
  const lp = ledgerPath();
  const taskId = "W1-T2788-SAME";
  const headSha = "sha-current";
  for (let i = 0; i < DEFAULT_SWEEP_POLICY.strikeCap; i++) {
    appendLedger(lp, {
      run_id: "SWEEP-0",
      task_id: taskId,
      step: "fix.dispatch",
      strike: i + 1,
      head_sha: headSha,
    });
  }
  const staleView = pr({ prNumber: 6001, prUrl: "url/6001", taskId, headSha, priorStrikes: 0 });
  let observedRounds = 0;
  const deps = fakeDeps({ ledgerPath: lp, fixProgressJudge: async input => {
    observedRounds = input.rounds.length;
    return { verdict: "escalate", loop: "same head remains red", reason: "the judge declines another round" };
  } });

  const summary = await runSweep([staleView], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(observedRounds, DEFAULT_SWEEP_POLICY.strikeCap);
  assert.equal(deps.fixed.length, 0, "the explicit judge verdict declines another round");
  assert.equal(deps.escalated.length, 1);
  assert.match(deps.escalated[0]?.reason ?? "", /same head remains red/);
  assert.match(String(standDownReasonFor(lp, staleView.prNumber)), /same head remains red/);
});

test("W1-T2788: concurrent observations of one task at different heads never share a fix claim or strike budget", async () => {
  const lp = ledgerPath();
  const taskId = "W1-T2788-CHANGED";
  const oldHead = pr({ prNumber: 6002, prUrl: "url/6002", taskId, headSha: "sha-old" });
  const newHead = { ...oldHead, headSha: "sha-new" };
  let releaseOld: (() => void) | undefined;
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const oldDeps = fakeDeps({
    ledgerPath: lp,
    dispatchFix: async () => {
      await oldGate;
    },
  });
  const newDeps = fakeDeps({ ledgerPath: lp });

  const pendingOld = runSweep([oldHead], oldDeps, DEFAULT_SWEEP_POLICY);
  await flush();
  const newSummary = await runSweep([newHead], newDeps, DEFAULT_SWEEP_POLICY);

  assert.equal(newDeps.fixed.length, 1, "the current head dispatches while the stale head's distinct claim is still held");
  assert.equal(newSummary.actions[0].acted, true);
  releaseOld?.();
  await pendingOld;
});
