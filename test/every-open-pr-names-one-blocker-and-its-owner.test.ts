import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PR_BLOCKERS, PR_BLOCKER_OWNERS, blockerFields, finalBlocker, priorBlockersFromLedger,
} from "../src/lib/pr-blocker.js";
import {
  DEFAULT_SWEEP_POLICY, DISPOSITION_RULES, deriveDisposition, runSweep,
  type OpenPrView, type SweepDeps,
} from "./helpers/sweep-test.js";
import { readLedgerLines } from "../src/lib/status.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const NOW = Date.UTC(2026, 9, 4, 12);
function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 71, prUrl: "url/71", taskId: "W1-T5537", headSha: "head-71",
    checksState: "green", reviewState: "success", autoMergeArmed: false,
    priorStrikes: 0, unmetCriteria: [], lastActivityAt: new Date(NOW).toISOString(), ...over,
  };
}
function deps(over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath: writeLedger().path, runId: "blocker-test", now: () => NOW, ...over,
  };
}
function disposed(d: SweepDeps) {
  return readLedgerLines(d.ledgerPath).filter(row => row.step === "sweep.disposed");
}

test("W1-T5537: every disposition row declares a blocker from the closed set", () => {
  const census = (rows: readonly { blocker?: unknown; disposition: string }[]) => {
    for (const [index, row] of rows.entries()) {
      assert.ok(PR_BLOCKERS.includes(row.blocker as typeof PR_BLOCKERS[number]),
        `row ${index} (${row.disposition}) has invalid blocker ${String(row.blocker)}`);
    }
  };
  census(DISPOSITION_RULES);
  assert.equal(PR_BLOCKERS.length, 14);
  assert.equal(new Set(PR_BLOCKERS).size, 14);
  assert.deepEqual(Object.keys(PR_BLOCKER_OWNERS).sort(), [...PR_BLOCKERS].sort());
  assert.throws(() => census([{ disposition: "wait" }]), /row 0 \(wait\).*undefined/);
  assert.throws(() => census([{ disposition: "wait", blocker: "invented" }]), /invented/);
  assert.equal(deriveDisposition(pr(), DEFAULT_SWEEP_POLICY, NOW).blocker, "awaiting-arm");
  assert.equal(deriveDisposition(pr({ checksState: "pending" }), DEFAULT_SWEEP_POLICY, NOW).blocker, "awaiting-ci");
});

test("W1-T5537: one disposition splits into the blocker each PR actually waits on", async () => {
  const cases: [Partial<OpenPrView>, string, string][] = [
    [{ checksState: "red", priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap }, "strikes-exhausted", "strike-ladder"],
    [{ checksState: "red", isPlanFiling: true, priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap }, "plan-proof-unrunnable", "NONE"],
    [{ mergeState: "dirty" }, "conflict", "conflict-rebase"],
    [{ autoMergeArmed: true }, "armed-idle", "armed-idle-merge"],
  ];
  for (const [over, blocker, owner] of cases) {
    const view = pr(over);
    // W1-T7096: the sweep's unwired stand-in rules a PR at the former ceiling a loop; the pure derivation is
    // given that same ruling so both readers see one decision.
    const ruled = (view.priorStrikes ?? 0) >= DEFAULT_SWEEP_POLICY.strikeCap
      ? { ...view, progressEscalation: { loop: "former fixed bound reached (no progress judge wired)", reason: "unwired caller keeps the pre-W1-T7096 bound", judged: false } }
      : view;
    const before = deriveDisposition(ruled, DEFAULT_SWEEP_POLICY, NOW);
    const d = deps();
    const summary = await runSweep([view], d);
    const [row] = disposed(d);
    assert.equal(row.blocker, blocker);
    assert.equal(row.blocker_owner, owner);
    assert.equal(row.disposition, before.disposition);
    assert.equal(row.reason, before.reason);
    assert.equal(summary.actions[0].disposition, before.disposition);
  }
});

test("W1-T5537: a blocker keeps its since across passes and resets on change", async () => {
  let now = NOW;
  const d = deps({ now: () => now });
  await runSweep([pr({ autoMergeArmed: true })], d);
  now += 60_000;
  await runSweep([pr({ autoMergeArmed: true, headSha: "new-head" })], d);
  now += 60_000;
  await runSweep([pr({ checksState: "pending" })], d);
  const rows = disposed(d);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => [row.blocker, row.blocker_owner, row.blocker_since, row.blocker_age_ms]), [
    ["armed-idle", "armed-idle-merge", new Date(NOW).toISOString(), 0],
    ["armed-idle", "armed-idle-merge", new Date(NOW).toISOString(), 60_000],
    ["awaiting-ci", "ci", new Date(now).toISOString(), 0],
  ]);
  assert.equal(rows[0].blocker_since_source, "first-seen");
  assert.equal(rows[2].blocker_since_source, undefined);
});

test("blocker refinement uses named facts and prioritizes base red and withheld reviews", () => {
  assert.equal(finalBlocker("own-red", { baseRedStandDown: true }), "base-red");
  assert.equal(finalBlocker("own-red", { baseCaused: true }), "base-red");
  assert.equal(finalBlocker("awaiting-review", { reviewerCodeStaleThisPass: true }), "stale-reviewer-withheld");
  assert.equal(finalBlocker("awaiting-arm", { mergeable: true, autoMergeArmed: true }), "armed-idle");
  assert.equal(finalBlocker("awaiting-arm", { mergeable: true, autoMergeArmed: false }), "awaiting-arm");
  assert.equal(finalBlocker("strikes-exhausted", { planProofUnrunnable: true, strikesExhausted: true }), "plan-proof-unrunnable");
  assert.equal(finalBlocker("escalated", { strikesExhausted: true }), "strikes-exhausted");
  assert.equal(finalBlocker("other", {}), "other");
  assert.equal(blockerFields("plan-proof-unrunnable", undefined, NOW, true).blocker_owner, "plan-repair");
  assert.equal(blockerFields("plan-proof-unrunnable", undefined, NOW, false).blocker_owner, "NONE");
});

test("blocker history ignores unrelated rows and never recovers age from a malformed latest observation", () => {
  const row = { step: "sweep.disposed", pr_number: 71, blocker: "awaiting-ci", blocker_since: new Date(NOW).toISOString() };
  const prior = priorBlockersFromLedger([
    row, { ...row, step: "other" }, { ...row, pr_number: "71" },
    { ...row, blocker: "invented" }, { ...row, pr_number: 72, blocker_since: "invalid" },
    { ...row, pr_number: 73, blocker_since: undefined },
  ]);
  assert.equal(prior.size, 3);
  assert.equal(blockerFields("awaiting-ci", prior.get(71), NOW + 1000).blocker_age_ms, 1000);
  assert.equal(blockerFields("awaiting-ci", prior.get(72), NOW).blocker_since_source, "first-seen");
  assert.equal(blockerFields("awaiting-ci", prior.get(73), NOW).blocker_since_source, "first-seen");
  assert.equal(blockerFields("awaiting-ci", prior.get(71), NOW - 1000).blocker_age_ms, 0);
  const latest = priorBlockersFromLedger([row, { ...row, blocker_since: "invalid" }]);
  assert.equal(blockerFields("awaiting-ci", latest.get(71), NOW + 1000).blocker_age_ms, 0);
});

test("the dry-run view carries the same blocker fields without persisting a disposition", async () => {
  const logs: Record<string, unknown>[] = [];
  const d = deps({ dryRun: true, log: (step, fields) => { logs.push({ step, ...fields }); } });
  await runSweep([pr({ autoMergeArmed: true })], d);
  assert.equal(disposed(d).length, 0);
  const row = logs.find(row => row.step === "sweep.dispose");
  assert.equal(row?.blocker, "armed-idle");
  assert.equal(row?.blocker_owner, "armed-idle-merge");
  assert.equal(row?.blocker_since, new Date(NOW).toISOString());
  assert.equal(row?.blocker_age_ms, 0);
});

test("deferred review finalization observes the stale reviewer read-back", async () => {
  let stale: { oldSha: string; newSha: string } | undefined;
  const ledger = writeLedger();
  const d = deps({
    ledgerPath: ledger.path,
    postReview: (view) => {
      stale = { oldSha: "old", newSha: "new" };
      ledger.append([{ step: "review.skipped_stale_reviewer_code", pr: String(view.prNumber), run_id: "blocker-test" }]);
    },
    reviewerCodeStaleThisPass: () => stale,
  });
  await runSweep([pr({ reviewState: "none" })], d);
  const [row] = disposed(d);
  assert.equal(row.disposition, "post-review");
  assert.equal(row.blocker, "stale-reviewer-withheld");
  assert.equal(row.blocker_owner, "deploy-freshness");
});

test("a pass-wide stale read-back does not label a delivered review or an armed PR withheld", async () => {
  const ledger = writeLedger();
  const d = deps({
    ledgerPath: ledger.path,
    reviewerCodeStaleThisPass: () => ({ oldSha: "old", newSha: "new" }),
    postReview: (view) => {
      ledger.append([{ step: "review.posted", task_id: view.taskId, head_sha: view.headSha }]);
    },
  });
  await runSweep([pr({ reviewState: "none" }), pr({ prNumber: 72, autoMergeArmed: true })], d);
  const rows = disposed(d);
  assert.equal(rows.find(row => row.pr_number === 71)?.blocker, "awaiting-review");
  assert.equal(rows.find(row => row.pr_number === 72)?.blocker, "armed-idle");
});

test("the final write distinguishes plan and metadata waits from own and base reds", async () => {
  const views = [
    pr({ checksState: "red", isPlanFiling: true }),
    pr({ prNumber: 72, checksState: "red", ciFailures: [{ name: "acceptance-author-gate", logTail: "body" }] }),
    pr({ prNumber: 73, checksState: "red", ciFailures: [{ name: "ci-gate", logTail: "own code" }] }),
  ];
  const d = deps({ repairMetadata: () => ({ repaired: false, reason: "unrepairable" }) });
  await runSweep(views, d);
  assert.deepEqual(disposed(d).map(row => [row.blocker, row.blocker_owner]), [
    ["plan-proof-unrunnable", "NONE"], ["plan-proof-unrunnable", "plan-repair"], ["own-red", "fix-lane"],
  ]);
});

test("main-health stand-downs and common failing checks name base-red without spending a fix", async () => {
  let fixes = 0;
  const ledger = writeLedger([{ step: "main.health.observed", sha: "main-sha", state: "red", failing_checks: ["ci-gate"] }]);
  const d = deps({ ledgerPath: ledger.path, dispatchFix: () => { fixes++; } });
  await runSweep([pr({ checksState: "red", ciFailures: [{ name: "ci-gate", logTail: "main red" }] })], d);
  assert.equal(disposed(d)[0].blocker, "base-red");
  assert.equal(disposed(d)[0].blocker_owner, "main-health");
  assert.equal(fixes, 0);
  const common = deps({ dispatchFix: () => { fixes++; } });
  await runSweep([71, 72].map(prNumber => pr({
    prNumber, checksState: "red", ciFailures: [{ name: "ci-gate", logTail: "common red" }],
  })), common);
  assert.ok(disposed(common).every(row => row.blocker === "base-red"));
  assert.equal(fixes, 0);
});

test("an unreadable withheld-review observation names other and preserves the completed action", async () => {
  let reviewFinished = false;
  const ledger = writeLedger();
  const d = deps({
    ledgerPath: ledger.path,
    readLedger: path => {
      if (reviewFinished) throw new Error("blocker history unavailable");
      return readLedgerLines(path);
    },
    postReview: () => { reviewFinished = true; },
    reviewerCodeStaleThisPass: () => ({ oldSha: "old", newSha: "new" }),
  });
  await runSweep([pr({ reviewState: "none" })], d);
  const [row] = disposed(d);
  assert.equal(row.blocker, "other");
  assert.equal(row.blocker_owner, "NONE");
  assert.equal(row.acted, true);
  assert.equal(row.action_error, undefined);
  assert.equal(row.blocker_read_error, "Error: blocker history unavailable");
});

test("a dated stale-review refusal keeps its blocker during the existing retry backoff", async () => {
  const view = pr({ reviewState: "none" });
  const ledger = writeLedger([{
    step: "review.post_refused", task_id: view.taskId, head_sha: view.headSha,
    reviewer_code_freshness: "stale", ts: new Date(NOW - 60_000).toISOString(),
  }]);
  let reviews = 0;
  const d = deps({ ledgerPath: ledger.path, postReview: () => { reviews++; } });
  await runSweep([view], d);
  assert.equal(disposed(d)[0].blocker, "stale-reviewer-withheld");
  assert.equal(reviews, 0);
});

test("the unreachable disposition fallback still reports a blocker", () => {
  const rows = DISPOSITION_RULES as unknown as Array<typeof DISPOSITION_RULES[number]>;
  const saved = rows.splice(0);
  try {
    assert.deepEqual(deriveDisposition(pr(), DEFAULT_SWEEP_POLICY, NOW), {
      disposition: "blocked-ambiguous", blocker: "other", reason: "default (no rule matched) — escalating",
    });
  } finally {
    rows.push(...saved);
  }
});

test("a capped-green exhausted body repair names a plan-proof wait and its available shard owner", async () => {
  const view = pr({ priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap });
  const criterion = { claim: "works", proof: "unit test: stale proof", met: true, reason: "stale", proof_exec: "executed_stale" };
  for (const capable of [false, true]) {
    const ledger = writeLedger([{
      step: "review.posted", task_id: view.taskId, pr_url: view.prUrl, head_sha: view.headSha,
      state: "success", capped: true, plan_only: false,
      decision_verdict: { state: "success", capped: true, planOnly: false, criteria: [criterion] },
    }]);
    const d = deps({ ledgerPath: ledger.path,
      ...(capable ? { dispatchPlanOnlyRepair: () => {} } : {}),
    });
    await runSweep([view], d);
    const [row] = disposed(d);
    assert.equal(row.blocker, "plan-proof-unrunnable");
    assert.equal(row.blocker_owner, capable ? "plan-repair" : "NONE");
    assert.equal(row.disposition, capable ? "blocked-fixable" : "blocked-ambiguous");
  }
});
