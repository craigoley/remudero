import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchCiFailures } from "../src/run-task.js";
import type { RollupCheckEntry } from "../src/lib/sweep.js";

function failedAttempt(
  name: string,
  startedAt: string,
  jobId?: string,
): RollupCheckEntry {
  return {
    name,
    conclusion: "FAILURE",
    startedAt,
    ...(jobId ? { detailsUrl: `https://github.com/acme/remudero/actions/runs/1/job/${jobId}` } : {}),
  };
}

test("a check whose latest attempt passed is absent from the actionable failures", () => {
  const failures = fetchCiFailures("acme", "remudero", [
    failedAttempt("acceptance-author-gate", "2026-09-04T13:49:20Z"),
    {
      name: "acceptance-author-gate",
      conclusion: "SUCCESS",
      startedAt: "2026-09-04T13:50:02Z",
    },
  ]);

  assert.deepEqual(failures, []);
});

test("the reported attempt is the most recent for its check name", () => {
  const logJobIds: string[] = [];
  const failures = fetchCiFailures(
    "acme",
    "remudero",
    [
      failedAttempt("acceptance-author-gate", "2026-09-04T13:49:20Z", "1001"),
      failedAttempt("acceptance-author-gate", "2026-09-04T13:50:02Z", "1002"),
    ],
    60,
    {
      fetchAnnotations: () => [],
      fetchJobLog: (_owner, _repo, jobId) => {
        logJobIds.push(jobId);
        return `failure from ${jobId}`;
      },
    },
  );

  assert.deepEqual(logJobIds, ["1002"]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].jobId, "1002");
  assert.equal(failures[0].logTail, "failure from 1002");
});

test("a single failed attempt with no later run is still actionable", () => {
  const failures = fetchCiFailures("acme", "remudero", [failedAttempt("ci-gate", "2026-09-04T13:50:02Z")]);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, "ci-gate");
  assert.equal(failures[0].conclusion, "FAILURE");
});
