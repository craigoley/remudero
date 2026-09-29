import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultCiAnnotationFetch, extractCiFailureRegion, fetchCiFailures, isBareExitCodeAnnotation } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

// What a failing test shard's annotations really were on PR #7816 (coverage-shard (5/8), check run
// 109405184736, read 2026-09-29): GitHub's exit line WITH its trailing period, and a runner-image
// NOTICE every ubuntu-latest job carries. The fallback matched the bare exit line only without the
// period, so it took these two lines as the failure and never read the log that named the test.
const SHARD_ANNOTATIONS = JSON.stringify([
  { annotation_level: "failure", message: "Process completed with exit code 1." },
  {
    annotation_level: "notice",
    message: '"The ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026."',
  },
]);

const TAP_LOG = [
  "2026-09-29T12:40:01Z ok 11 - an earlier test",
  "not ok 12 - the shard names the test that failed",
  "  ---",
  "  error: expected 2 received 1",
  "  ...",
  "Post job cleanup.",
].join("\n");

function withShim<T>(stdout: string, run: () => T): { value: T; calls: string[] } {
  const shim = ghShim([{ when: "/annotations", stdout }], { kind: "ci-annotations-notice" });
  const originalPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${originalPath}`;
  try {
    return { value: run(), calls: shim.calls() };
  } finally {
    process.env.PATH = originalPath;
  }
}

test("a failing shard whose annotations are only the exit line and a runner notice hands the worker its log", () => {
  const { value: failures } = withShim(SHARD_ANNOTATIONS, () =>
    fetchCiFailures(
      "craigoley",
      "remudero",
      [{ name: "coverage-shard (5/8)", conclusion: "FAILURE", detailsUrl: "https://github.com/o/r/actions/runs/1/job/109405184736" }],
      60,
      { fetchJobLog: () => TAP_LOG },
    ),
  );
  assert.equal(failures[0]?.tailSource, "log");
  assert.match(failures[0]?.logTail ?? "", /not ok 12 - the shard names the test that failed/);
  assert.doesNotMatch(failures[0]?.logTail ?? "", /ubuntu-latest/);
  assert.deepEqual(failures[0]?.annotationFallback, { outcome: "bare-exit-code" });
});

test("the default annotation read keeps failure-level messages and drops a notice", () => {
  const body = JSON.stringify([
    { annotation_level: "notice", message: "The ubuntu-latest label will migrate" },
    { annotation_level: "failure", message: "diff-coverage: BLOCKED src/lib/learnings.ts:621" },
    { annotation_level: "warning", message: "a warning is not the failure" },
  ]);
  const { value, calls } = withShim(body, () => defaultCiAnnotationFetch("craigoley", "remudero", "109353868139"));
  assert.deepEqual(value, ["diff-coverage: BLOCKED src/lib/learnings.ts:621"]);
  assert.deepEqual(calls, ["api repos/craigoley/remudero/check-runs/109353868139/annotations"]);
});

test("an exit line of any code with or without its period is not evidence of why a step failed", () => {
  for (const line of ["Process completed with exit code 1.", "Process completed with exit code 2", "Error: Process completed with exit code 143."]) {
    assert.equal(isBareExitCodeAnnotation(line), true, line);
  }
  assert.equal(isBareExitCodeAnnotation("diff-coverage: BLOCKED"), false);
});

test("a real error annotation beside the exit line is kept and the exit line dropped", () => {
  const failures = fetchCiFailures(
    "o",
    "r",
    [{ name: "coverage-ratchet", conclusion: "FAILURE", detailsUrl: "https://github.com/o/r/actions/runs/1/job/7" }],
    60,
    {
      fetchAnnotations: () => ["diff-coverage: BLOCKED", "  - src/lib/learnings.ts:621", "Process completed with exit code 1."],
      fetchJobLog: () => {
        throw new Error("the log is not read when an annotation already names the failure");
      },
    },
  );
  assert.equal(failures[0]?.tailSource, "annotations");
  assert.equal(failures[0]?.logTail, "diff-coverage: BLOCKED\n  - src/lib/learnings.ts:621");
});

// The job-log endpoint stamps every line, which the TAP pattern (anchored at the line start) never
// matched: on the #7816 shard log the region was sixty copies of one FLAKE-RETRY line.
const stamp = (line: string, second: number) => `2026-09-29T12:30:${String(second).padStart(2, "0")}.6791189Z ${line}`;

test("a timestamped shard log yields the failing test and its assertion rather than retry spam", () => {
  const log = [
    ...Array.from({ length: 40 }, (_, i) => stamp("FLAKE-RETRY: tracked-tree dirt — (no test name parsed from output)", i)),
    stamp("ok 776 - an earlier test", 41),
    stamp("not ok 777 - R-50: every setup-node use declares cache: npm", 42),
    stamp("  ---", 42),
    stamp("  error: undefined !== 'npm'", 42),
    stamp("  location: '/home/runner/work/remudero/remudero/test/ci-cache.test.ts:50:1'", 42),
    stamp("  ...", 42),
    stamp("##[error]Process completed with exit code 1.", 50),
    stamp("Post job cleanup.", 51),
  ].join("\n");
  const region = extractCiFailureRegion(log, 60);
  assert.match(region, /^not ok 777 - R-50: every setup-node use declares cache: npm$/m);
  assert.match(region, /test\/ci-cache\.test\.ts:50:1/);
  assert.equal(region.split("\n").filter((l) => l.includes("tracked-tree dirt")).length, 1, "one copy of a repeated retry line");
  assert.doesNotMatch(region, /Post job cleanup/);
});

test("a job running several gates names each failed step's own output", () => {
  const log = [
    stamp("##[group]Run npm run --silent depcruise", 1),
    stamp("npm run --silent depcruise", 1),
    stamp("##[endgroup]", 1),
    stamp("  error no-circular: src/lib/learnings.ts → src/lib/standing-briefs.ts", 2),
    stamp("x 1 dependency violations (1 errors, 0 warnings).", 2),
    stamp("##[error]Process completed with exit code 1.", 3),
    stamp("##[group]Run npm run --silent cycle-ratchet", 4),
    stamp("##[endgroup]", 4),
    stamp("cycle-ratchet: BLOCKED -- 1 distinct dependency cycle(s), ceiling 0 (+1).", 5),
    stamp("##[error]Process completed with exit code 1.", 6),
    ...Array.from({ length: 80 }, (_, i) => stamp(`[command]/usr/bin/git config --local cleanup ${i}`, 7)),
  ].join("\n");
  const region = extractCiFailureRegion(log, 60);
  assert.match(region, /error no-circular: src\/lib\/learnings\.ts/);
  assert.match(region, /cycle-ratchet: BLOCKED/);
  assert.doesNotMatch(region, /git config --local cleanup/);
});
