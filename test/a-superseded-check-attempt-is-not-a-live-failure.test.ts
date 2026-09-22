import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fetchCiFailures, type CiAnnotationFetch, type CiJobLogFetch } from "../src/run-task.js";

/**
 * W1-T3363 — a repair reads ONE job's log and cannot see that a LATER run superseded it.
 *
 * MEASURED 2026-09-10, twice in one hour (this task's own rationale):
 *
 * #5039: the head carried TWO `acceptance-author-gate` runs on the same name; a failing attempt
 * was read as live even though a later attempt of the same check had already run against the PR.
 *
 * #5029: a failing `diff-coverage` log was read as live while the branch owner had already
 * pushed `831d25491`, the correct fix. A repair was authored against a failure that was already
 * handled and nearly pushed on top of concurrent work.
 *
 * `fetchCiFailures` (src/run-task.ts) is the failure-reading path repair actually drives: it
 * already composes with `dedupeRollupByLatestAttempt` (src/lib/sweep.ts) — the SAME rule
 * `checksStateFromRollup` uses (W1-T457) and `ciGateFromRollup` uses (W1-T2804) — before it
 * filters to `REQUIRED_CHECK_FAIL`, so it never grows a second "which attempt counts" rule that
 * could disagree with theirs.
 *
 * These tests drive that REAL reader directly — the falsifier's own instruction: "construct a
 * head with a failed attempt followed by a passing one and drive the real reader" — to PROVE the
 * three acceptance claims. `test/sweep-superseded-check-run.test.ts` (W1-T457) already proves
 * claims 1 and 3 by CONCLUSION; this file adds the proof claim 2 needs and no existing test
 * gives: that the reported attempt IS the latest one, identified by its OWN jobId and its OWN
 * log read, not merely by an aggregate conclusion the dedupe could get right by coincidence.
 */

function recordingFetch(): { fetchAnnotations: CiAnnotationFetch; fetchJobLog: CiJobLogFetch; jobLogCalls: string[] } {
  const jobLogCalls: string[] = [];
  return {
    fetchAnnotations: () => [],
    fetchJobLog: (_owner, _repo, jobId) => {
      jobLogCalls.push(jobId);
      return "";
    },
    jobLogCalls,
  };
}

// ── acceptance 1 — a check with a later successful attempt on the same head is not a live failure ─

test("a check whose latest attempt succeeded is absent from the actionable failures, even though an EARLIER attempt of the same name failed", () => {
  const rollup = [
    { name: "acceptance-author-gate", conclusion: "FAILURE", startedAt: "2026-09-10T23:36:00Z" },
    { name: "acceptance-author-gate", conclusion: "SUCCESS", startedAt: "2026-09-10T23:37:42Z" },
  ];
  const { fetchAnnotations, fetchJobLog } = recordingFetch();
  assert.deepEqual(
    fetchCiFailures("craigoley", "remudero", rollup, 60, { fetchAnnotations, fetchJobLog }),
    [],
    "the check's newest attempt succeeded — an earlier failed attempt of the SAME name must not surface as a live failure",
  );
});

test("array order does not matter: the success-after-failure fixture reads healthy whichever attempt is listed first", () => {
  const rollup = [
    { name: "diff-coverage", conclusion: "SUCCESS", startedAt: "2026-09-10T00:05:00Z" },
    { name: "diff-coverage", conclusion: "FAILURE", startedAt: "2026-09-10T00:00:00Z" },
  ];
  const { fetchAnnotations, fetchJobLog } = recordingFetch();
  assert.deepEqual(fetchCiFailures("craigoley", "remudero", rollup, 60, { fetchAnnotations, fetchJobLog }), []);
});

// ── acceptance 2 — the reported attempt is the LATEST for that name, not the first encountered ──

test("the reported attempt is the most recent for its check name — when a check fails twice, it is identified by its OWN jobId, listed FIRST in the array", () => {
  const rollup = [
    { name: "diff-coverage", conclusion: "FAILURE", startedAt: "2026-09-10T00:10:00Z", detailsUrl: "https://github.com/o/r/actions/runs/9/job/222" },
    { name: "diff-coverage", conclusion: "FAILURE", startedAt: "2026-09-10T00:00:00Z", detailsUrl: "https://github.com/o/r/actions/runs/9/job/111" },
  ];
  const { fetchAnnotations, fetchJobLog, jobLogCalls } = recordingFetch();
  const failing = fetchCiFailures("craigoley", "remudero", rollup, 60, { fetchAnnotations, fetchJobLog });
  assert.equal(failing.length, 1);
  assert.equal(failing[0].jobId, "222", "the reported attempt must be the latest attempt's own job, not the earlier attempt's");
  assert.deepEqual(jobLogCalls, ["222"], "the log read itself must target the latest attempt's job id, not the earlier one's");
});

test("the same fixture with the latest attempt listed LAST in the array still reports its jobId, not the first-encountered one", () => {
  const rollup = [
    { name: "diff-coverage", conclusion: "FAILURE", startedAt: "2026-09-10T00:00:00Z", detailsUrl: "https://github.com/o/r/actions/runs/9/job/111" },
    { name: "diff-coverage", conclusion: "FAILURE", startedAt: "2026-09-10T00:10:00Z", detailsUrl: "https://github.com/o/r/actions/runs/9/job/222" },
  ];
  const { fetchAnnotations, fetchJobLog, jobLogCalls } = recordingFetch();
  const failing = fetchCiFailures("craigoley", "remudero", rollup, 60, { fetchAnnotations, fetchJobLog });
  assert.equal(failing.length, 1);
  assert.equal(failing[0].jobId, "222", "the LATEST attempt (00:10:00) is reported even though it is the SECOND entry the reader encounters");
  assert.deepEqual(jobLogCalls, ["222"], "only the latest attempt's job is ever read — the earlier, superseded attempt's log is never fetched");
});

// ── acceptance 3 — a single failed attempt with no later run is still actionable ─────────────────

test("a check whose only attempt failed, with no later run of the same name, is still reported — the narrowing must not blind the repair path", () => {
  const rollup = [{ name: "diff-coverage", conclusion: "FAILURE", startedAt: "2026-09-10T00:00:00Z", detailsUrl: "https://github.com/o/r/actions/runs/9/job/333" }];
  const { fetchAnnotations, fetchJobLog } = recordingFetch();
  const failing = fetchCiFailures("craigoley", "remudero", rollup, 60, { fetchAnnotations, fetchJobLog });
  assert.equal(failing.length, 1, "the #5029 shape's mirror image: nothing superseded this attempt, so it must still be named");
  assert.equal(failing[0].name, "diff-coverage");
  assert.equal(failing[0].jobId, "333");
});

test("acceptance 3 holds beside an UNRELATED check that DID get superseded: the narrowing is per-name, not a wholesale drop of every entry", () => {
  const rollup = [
    { name: "diff-coverage", conclusion: "FAILURE", startedAt: "2026-09-10T00:00:00Z", detailsUrl: "https://github.com/o/r/actions/runs/9/job/333" },
    { name: "acceptance-author-gate", conclusion: "FAILURE", startedAt: "2026-09-10T00:00:00Z" },
    { name: "acceptance-author-gate", conclusion: "SUCCESS", startedAt: "2026-09-10T00:05:00Z" },
  ];
  const { fetchAnnotations, fetchJobLog } = recordingFetch();
  const failing = fetchCiFailures("craigoley", "remudero", rollup, 60, { fetchAnnotations, fetchJobLog });
  assert.equal(failing.length, 1, "only the genuinely-failing, non-superseded check is reported");
  assert.equal(failing[0].name, "diff-coverage");
});
