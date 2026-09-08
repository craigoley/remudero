import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPrChecks, reportPrChecks } from "../src/lib/pr-checks.js";

/**
 * test/a-commit-status-is-not-a-check-run.test.ts — W1-T3083.
 *
 * The two ways a hand-rolled rollup query answers confidently and wrongly. Both were MEASURED in
 * one session on 2026-09-07, from real queries written at a terminal, and both are the reason this
 * derivation needed a caller rather than a convention.
 */

test("(a) a COMMIT STATUS is classified — reading `conclusion` alone drops remudero-review", () => {
  // #4493's real shape: every check run green, and the refusal living in the combined status, which
  // carries `state` where a run carries `conclusion`. The query that missed this reported red=[]
  // on a pull request the reviewer had refused under Standing rule 25.
  const report = reportPrChecks(
    [{ name: "ci", status: "completed", conclusion: "success" }],
    [{ context: "remudero-review", state: "failure" }],
  );
  assert.deepEqual(report.red, ["remudero-review"], "the status half must reach the verdict");
  assert.deepEqual(report.green, ["ci"]);
});

test("(b) a superseded attempt does not outrank its own later SUCCESS", () => {
  // #4485's real shape: `source-size` failed, main was fixed, the re-run passed — and a query with
  // no latest-attempt dedupe kept reporting the older FAILURE forever.
  const report = reportPrChecks(
    [
      { name: "source-size", status: "completed", conclusion: "failure", started_at: "2026-09-07T20:00:00Z" },
      { name: "source-size", status: "completed", conclusion: "success", started_at: "2026-09-07T20:35:00Z" },
    ],
    [],
  );
  assert.deepEqual(report.red, [], "the latest attempt decides");
  assert.deepEqual(report.green, ["source-size"]);
  assert.equal(report.checks.length, 1, "and the superseded entry is collapsed, not counted twice");
});

test("(b, control) the ORDER of attempts does not decide it — the timestamp does", () => {
  // Without this the test above would pass on a "last one wins" implementation that is wrong the
  // moment GitHub returns attempts newest-first.
  const report = reportPrChecks(
    [
      { name: "source-size", status: "completed", conclusion: "success", started_at: "2026-09-07T20:35:00Z" },
      { name: "source-size", status: "completed", conclusion: "failure", started_at: "2026-09-07T20:00:00Z" },
    ],
    [],
  );
  assert.deepEqual(report.red, [], "newest-first input must reach the same verdict");
});

test("an in-progress run is PENDING, never green — a check with no verdict has not passed", () => {
  const report = reportPrChecks([{ name: "ci-shard (1/4)", status: "in_progress" }], []);
  assert.deepEqual(report.pending, ["ci-shard (1/4)"]);
  assert.deepEqual(report.green, []);
});

test("an UNRECOGNISED outcome is PENDING, never green — fail closed on a word we cannot name", () => {
  // A required check must never pass a state it does not understand. If GitHub adds a conclusion
  // this repo has not seen, treating it as green is the failure that matters.
  const report = classifyPrChecks([{ name: "future", conclusion: "SOMETHING_NEW" }]);
  assert.deepEqual(report.green, []);
  assert.deepEqual(report.pending, ["future"]);
});

test("SKIPPED and NEUTRAL are green — the sweep's own OK set, not a second opinion", () => {
  const report = classifyPrChecks([
    { name: "skipped-job", conclusion: "SKIPPED" },
    { name: "osv-scanner", conclusion: "NEUTRAL" },
  ]);
  assert.deepEqual(report.red, []);
  assert.equal(report.green.length, 2, "a required check that SKIPS is not a failure");
});
