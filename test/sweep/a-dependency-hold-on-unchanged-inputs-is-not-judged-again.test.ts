import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { DEP_REVIEW_ENGINE_REVISION } from "#src/lib/dep-review.js";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY, dependabotCheckStates, depReviewHoldInputsDigest, runSweep, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const run = promisify(execFile);
const HEAD = "a".repeat(40);
const PR = 2517;
const PR_URL = `https://github.com/fixture/console/pull/${PR}`;

function heldView(): OpenPrView {
  return {
    prNumber: PR, prUrl: PR_URL, isDependabot: true, headSha: HEAD, reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: "2026-11-15T01:44:21Z", autoMergeArmed: false,
    mergeable: true, mergeState: "clean", mergeableState: "clean",
    checkStates: [
      { name: "ci-gate", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "osv-scan", status: "IN_PROGRESS" },
      { name: "codeql", status: "COMPLETED", conclusion: "NEUTRAL" },
    ],
  };
}

function fixture(scope: TestContext, judge: () => Promise<string> | string = () => "hold") {
  const ledgerPath = join(ownedFixtureDir(scope, "dep-hold-dedup").dir, "ledger.ndjson");
  const pr = heldView();
  const unexpected = () => { assert.fail("only the dependency lane may act in this fixture"); };
  let calls = 0;
  const deps: SweepDeps = {
    ledgerPath, runId: "SWEEP-dep-hold-dedup", now: () => Date.parse("2026-11-15T12:00:00Z"),
    arm: unexpected, close: unexpected, dispatchFix: unexpected, escalate: unexpected,
    depReview: async () => { calls++; return judge(); },
  };
  const statePath = join(dirname(ledgerPath), "dep-review-holds", "fixture", "console", `PR${PR}.json`);
  return {
    pr, deps, calls: () => calls,
    pass: () => runSweep([pr], deps, DEFAULT_SWEEP_POLICY),
    rows: () => readLedgerLines(ledgerPath).filter((r) => r.step === "sweep.disposed" && r.disposition === "dep-review"),
    // The W1-T9818 escalation as reconcileDepReviewHold leaves it: an unretired ask for this head.
    fileAsk: (retired = false, heads: readonly string[] = [HEAD]) => {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, `${JSON.stringify({ headSha: heads.at(-1), heldSinceMs: 1794707218266,
        asks: heads.map((headSha) => ({ headSha, issueUrl: "https://github.com/fixture/console/issues/2524", retired })) })}\n`);
    },
    corruptAsk: () => { mkdirSync(dirname(statePath), { recursive: true }); writeFileSync(statePath, "{not json\n"); },
    escalationRow: (headSha = HEAD) => appendLedger(ledgerPath, { run_id: "dep-review-prior", task_id: `dep-review-PR${PR}`,
      step: "dep-review.hold_escalated", lane: "dep-review", head_sha: headSha, issue_url: "https://github.com/fixture/console/issues/2524" }),
    seed: (fields: Record<string, unknown>) => appendLedger(ledgerPath, { run_id: "prior", task_id: "SWEEP", step: "sweep.disposed",
      disposition: "dep-review", pr_number: PR, head_sha: HEAD, acted: true, ...fields }),
  };
}

test("W1-T12951 criterion 1: a held Dependabot PR seen again with unchanged inputs is not judged again", async (t) => {
  const f = fixture(t);
  f.fileAsk();
  await f.pass();
  await f.pass();
  assert.equal(f.calls(), 1, "depReview runs once in two passes");
  const [first, second] = f.rows();
  assert.equal(first?.acted, true);
  assert.equal(first?.dep_review_outcome, "hold");
  assert.equal(first?.dep_review_inputs_digest, depReviewHoldInputsDigest(f.pr));
  assert.equal(second?.acted, false);
  assert.match(String(second?.stand_down_reason), /dependency hold inputs have not changed/);
});

const CHANGES: Array<[string, (pr: OpenPrView) => void]> = [
  ["a new head", (pr) => { pr.headSha = "b".repeat(40); }],
  ["a check's status", (pr) => { pr.checkStates = pr.checkStates!.map((c) => c.name === "osv-scan" ? { ...c, status: "QUEUED" } : c); }],
  ["a check's conclusion", (pr) => { pr.checkStates = pr.checkStates!.map((c) => c.name === "codeql" ? { ...c, conclusion: "SUCCESS" } : c); }],
  ["a new check", (pr) => { pr.checkStates = [...pr.checkStates!, { name: "dependency-review", status: "QUEUED" }]; }],
  ["the review state", (pr) => { pr.reviewState = "pending"; }],
  ["the mergeable state", (pr) => { pr.mergeState = "behind"; pr.mergeableState = "behind"; }],
];
for (const [what, change] of CHANGES) {
  test(`W1-T12951 criterion 2: ${what} makes the next pass judge the held PR again`, async (t) => {
    const f = fixture(t);
    f.fileAsk(false, [HEAD, "b".repeat(40)]);
    await f.pass();
    change(f.pr);
    await f.pass();
    assert.equal(f.calls(), 2, `${what} is an input the hold decision reads`);
    await f.pass();
    assert.equal(f.calls(), 2, "the changed inputs dedup again once judged");
  });
}

test("W1-T12951 criterion 2: a hold judged under another dep-review engine is judged again", async (t) => {
  const f = fixture(t);
  f.fileAsk();
  f.seed({ dep_review_outcome: "hold", dep_review_engine_revision: "dep-review-older-engine",
    dep_review_inputs_digest: depReviewHoldInputsDigest(f.pr) });
  await f.pass();
  assert.equal(f.calls(), 1, "an engine change re-judges the same inputs");
  f.seed({ dep_review_outcome: "hold", dep_review_engine_revision: DEP_REVIEW_ENGINE_REVISION, dep_review_inputs_digest: "0".repeat(64) });
  await f.pass();
  assert.equal(f.calls(), 2, "a digest that differs from this view re-judges");
});

test("W1-T12951 criterion 3: a hold whose escalation is not filed for its head is judged on every pass", async (t) => {
  const f = fixture(t);
  await f.pass();
  await f.pass();
  assert.equal(f.calls(), 2, "no ask and no hold_escalated row: W1-T9818 may escalate on this pass");
  f.fileAsk(true);
  await f.pass();
  assert.equal(f.calls(), 3, "a retired ask does not count");
  f.fileAsk(false, ["c".repeat(40)]);
  await f.pass();
  assert.equal(f.calls(), 4, "an ask for another head does not count");
  f.corruptAsk();
  await f.pass();
  assert.equal(f.calls(), 5, "an unreadable hold state cannot prove the escalation");
  f.escalationRow();
  await f.pass();
  assert.equal(f.calls(), 6, "a hold_escalated row with no ask in the state file does not count");
  f.fileAsk();
  await f.pass();
  assert.equal(f.calls(), 6, "the ask for this head lets the unchanged pass dedup");
});

test("W1-T12951 criterion 4: the terminal dedup and the stands-aside rule answer as before", async (t) => {
  const f = fixture(t, () => "arm");
  f.seed({ dep_review_outcome: "arm", dep_review_engine_revision: DEP_REVIEW_ENGINE_REVISION });
  await f.pass();
  assert.equal(f.calls(), 0);
  assert.match(String(f.rows().at(-1)?.stand_down_reason), /already reached a TERMINAL outcome/);
  f.pr.autoMergeArmed = true;
  f.pr.mergeableState = "blocked";
  await f.pass();
  assert.equal(f.calls(), 1, "W1-T9913: an armed head GitHub blocks is re-reviewed at the same head");

  const h = fixture(t);
  h.fileAsk();
  h.pr.autoMergeArmed = true;
  h.pr.mergeableState = "blocked";
  await h.pass();
  await h.pass();
  assert.equal(h.calls(), 2, "the stands-aside rule also stops the hold dedup");
});

test("W1-T12951 criterion 5: ten passes over a gh shim make one judgement and no dep-review reads after the first", async (t) => {
  await withGhShim([
    { when: "pr view", stdout: JSON.stringify({ number: PR, url: PR_URL, headRefOid: HEAD }) },
    { when: "pr diff", stdout: "diff --git a/package.json b/package.json" },
    { when: "check-runs", stdout: JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: "osv-scan", status: "in_progress" }] }) },
  ], async (shim) => {
    const f = fixture(t, async () => {
      await run("gh", ["pr", "view", PR_URL, "--json", "number,url,headRefOid"]);
      await run("gh", ["pr", "diff", PR_URL]);
      await run("gh", ["api", `repos/fixture/console/commits/${HEAD}/check-runs?filter=all`]);
      return "hold";
    });
    f.fileAsk();
    const readsAfter: number[] = [];
    for (let pass = 0; pass < 10; pass++) {
      await f.pass();
      readsAfter.push(shim.calls().length);
    }
    assert.equal(f.calls(), 1, "one dep-review judgement in ten passes");
    assert.equal(readsAfter[0], 3, "the first pass reads the PR, its diff and its checks");
    assert.deepEqual(new Set(readsAfter), new Set([3]), "no dep-review read after the first pass");
    assert.equal(f.rows().filter((r) => r.acted === false).length, 9);
  });
});

const NO_DIGEST: Array<[string, (pr: OpenPrView) => void]> = [
  ["checks state red", (pr) => { pr.checksState = "red"; }],
  ["a red required check", (pr) => { pr.redRequiredChecks = ["ci-gate"]; }],
  ["a CI failure", (pr) => { pr.ciFailures = [{ name: "ci-gate", logTail: "" }]; }],
  ["a failed check in the rollup", (pr) => { pr.checkStates = [{ name: "lint", status: "COMPLETED", conclusion: "FAILURE" }]; }],
  ["no check states", (pr) => { pr.checkStates = undefined; }],
  ["no merge state", (pr) => { pr.mergeState = undefined; pr.mergeableState = undefined; }],
];
for (const [what, change] of NO_DIGEST) {
  test(`W1-T12951 criterion 7: a hold with ${what} is judged on every pass`, async (t) => {
    const f = fixture(t);
    f.fileAsk();
    change(f.pr);
    assert.equal(depReviewHoldInputsDigest(f.pr), undefined);
    await f.pass();
    await f.pass();
    assert.equal(f.calls(), 2);
    assert.equal(f.rows()[0]?.dep_review_inputs_digest, undefined);
  });
}

test("W1-T12951: the view producer keeps check states for Dependabot PRs only", () => {
  const rollup = [{ name: "ci-gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-15T01:00:00Z" }];
  assert.deepEqual(dependabotCheckStates(true, rollup),
    [{ name: "ci-gate", context: undefined, status: "COMPLETED", conclusion: "SUCCESS", state: undefined }]);
  assert.equal(dependabotCheckStates(false, rollup), undefined);
  assert.equal(dependabotCheckStates(true, undefined), undefined);
});
