import { strict as assert } from "node:assert";
import { test } from "node:test";

import { fetchCiFailures } from "../src/run-task.js";
import type { RollupCheckEntry } from "../src/lib/sweep.js";

const OWNER = "acme";
const REPO = "remudero";

function attempt(startedAt: string, jobId: string, conclusion: string): RollupCheckEntry {
  return {
    name: "acceptance-author-gate",
    conclusion,
    startedAt,
    detailsUrl: `https://github.com/${OWNER}/${REPO}/actions/runs/1/job/${jobId}`,
  };
}

function readFailures(rollup: RollupCheckEntry[], readJobs: string[]): ReturnType<typeof fetchCiFailures> {
  return fetchCiFailures(OWNER, REPO, rollup, 60, {
    fetchAnnotations: () => [],
    fetchJobLog: (_owner, _repo, jobId) => {
      readJobs.push(jobId);
      return "failure output";
    },
  });
}

test("a check whose latest attempt passed is absent from the actionable failures", () => {
  const readJobs: string[] = [];
  const failures = readFailures(
    [
      attempt("2026-09-04T13:49:20Z", "101", "FAILURE"),
      attempt("2026-09-04T13:50:02Z", "102", "SUCCESS"),
    ],
    readJobs,
  );

  assert.deepEqual(failures, []);
  assert.deepEqual(readJobs, [], "a superseded failure's job log must not be read");
});

test("the reported attempt is the most recent for its check name", () => {
  const readJobs: string[] = [];
  const failures = readFailures(
    [
      attempt("2026-09-04T13:49:20Z", "101", "FAILURE"),
      attempt("2026-09-04T13:50:02Z", "102", "FAILURE"),
    ],
    readJobs,
  );

  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.jobId, "102");
  assert.deepEqual(readJobs, ["102"], "only the latest attempt's job log is actionable");
});

test("a single failed attempt with no later run is still actionable", () => {
  const readJobs: string[] = [];
  const failures = readFailures([attempt("2026-09-04T13:49:20Z", "103", "FAILURE")], readJobs);

  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.jobId, "103");
  assert.deepEqual(readJobs, ["103"]);
});
