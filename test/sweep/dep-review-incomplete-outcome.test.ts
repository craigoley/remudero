import assert from "node:assert/strict";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { ownedFixtureDir } from "../helpers/owned-fixture-dir.js";

function fixture(scope: TestContext, outcome: () => string | void) {
  const ledgerPath = join(ownedFixtureDir(scope, "dep-incomplete").dir, "ledger.ndjson");
  const pr: OpenPrView = {
    prNumber: 2197, prUrl: "https://github.com/fixture/repo/pull/2197", isDependabot: true,
    headSha: "a".repeat(40), reviewState: "none", checksState: "green", unmetCriteria: [],
    priorStrikes: 0, lastActivityAt: new Date().toISOString(), autoMergeArmed: false,
    mergeable: true, mergeState: "clean",
  };
  const unexpected = () => { assert.fail("only the dependency lane may act in this fixture"); };
  let calls = 0;
  const deps: SweepDeps = {
    ledgerPath, runId: "SWEEP-dep-incomplete", now: () => Date.now(),
    arm: unexpected, close: unexpected, dispatchFix: unexpected, escalate: unexpected,
    depReview: () => { calls++; return outcome(); },
  };
  return { pr, deps, calls: () => calls,
    pass: () => runSweep([pr], deps, DEFAULT_SWEEP_POLICY),
    seed: (prior: unknown) => appendLedger(ledgerPath, {
      run_id: "prior-attempt", task_id: "SWEEP", step: "sweep.disposed", disposition: "dep-review",
      pr_number: pr.prNumber, head_sha: pr.headSha, acted: true,
      ...(prior === undefined ? {} : { dep_review_outcome: prior }),
    }),
  };
}

test("an incomplete dependency review is retried at the same head after a retitle", async (t) => {
  const f = fixture(t, () => f.calls() === 1 ? "unknown" : "arm");
  await f.pass();
  await f.pass();
  assert.equal(f.calls(), 2, "retitling did not complete a dependency decision");
  assert.deepEqual(readLedgerLines(f.deps.ledgerPath).filter(r => r.step === "sweep.disposed" && r.acted === true)
    .map(r => r.dep_review_outcome), ["unknown", "arm"]);
  await f.pass();
  assert.equal(f.calls(), 2, "the subsequent explicit arm still deduplicates");
});

for (const prior of [undefined, "unknown", "retitled", "unrecognized-future-value", "hold", null]) {
  test(`a stored ${String(prior)} dependency outcome cannot claim terminal completion`, async (t) => {
    const f = fixture(t, () => "hold");
    f.seed(prior);
    await f.pass();
    assert.equal(f.calls(), 1);
  });
}

for (const prior of ["arm", "escalate", "refuse", "migrate"]) {
  test(`an explicit ${prior} dependency outcome remains terminal only at its own head`, async (t) => {
    const f = fixture(t, () => "hold");
    f.seed(prior);
    await f.pass();
    assert.equal(f.calls(), 0, "a known terminal decision must not be repeated");
    f.pr.headSha = "b".repeat(40);
    await f.pass();
    assert.equal(f.calls(), 1, "another head earns a new dependency decision");
  });
}

test("an invoked dependency lane returning no decision remains retryable", async (t) => {
  const f = fixture(t, () => undefined);
  await f.pass();
  await f.pass();
  assert.equal(f.calls(), 2);
});
