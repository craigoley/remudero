import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchCiFailuresAsync } from "../src/run-task.js";
import { ciFailureSignature } from "../src/lib/ci-friction-gardener.js";
import { decideRedBaseRefresh } from "../src/lib/sweep.js";

// 2026-10-11, PR #10829: ci-shard (7/8) and (8/8) were cancelled at ci.yml's 35-minute ceiling. Their
// annotations held only the runner's own timeout lines, the job log held the pooled `not ok`, the isolated
// pass and the POOL DEFECT line, and the fix round recorded signature null for every check.

const at = (n: number) => `2026-10-11T12:${String(40 + n).padStart(2, "0")}:01.0000000Z `;
const RUNNER_TIMEOUT = [
  "The job running on runner GitHub Actions 12 has exceeded the maximum execution time of 35 minutes.",
  "The operation was canceled.",
];
const rollup = (name: string) => [
  { name, conclusion: "CANCELLED", detailsUrl: "https://github.com/o/r/actions/runs/1/job/555" },
];
const poolDefectLog = [
  "# Subtest: test/the-leaker.test.ts",
  "ok 6 - test/the-leaker.test.ts",
  "not ok 7 - test/the-victim.test.ts",
  "  ---",
  "  error: 'expected 1 got 2'",
  "  ...",
  "pure-test-pool: the pool of 40 file(s) failed (status 1); re-running them isolated once.",
  "pure-test-pool: rerun run complete — 40/40 file(s) reported, # tests 812, # fail 0.",
  "pure-test-pool: every pooled file passes isolated; locating the leak among 40 file(s) (shard status 0 is already final).",
  "pure-test-pool: locate probe 1: 20 file(s) ending test/x.test.ts -> status 1",
  "pure-test-pool: POOL DEFECT — every pooled file passes isolated but the pool failed; leaking file: test/the-leaker.test.ts " +
    "(first failing alongside it: test/the-victim.test.ts) after 6 probe(s). Add the leak to the census in scripts/pure-test-pool.mjs.",
  "##[error]The operation was canceled.",
]
  .map((l, i) => `${at(i % 10)}${l}`)
  .join("\n");

const read = (name: string, log: string, calls: string[] = []) =>
  fetchCiFailuresAsync("o", "r", rollup(name), 60, {
    fetchAnnotations: async () => RUNNER_TIMEOUT,
    fetchJobLog: async (_o, _r, id) => {
      calls.push(id);
      return log;
    },
  });

test("W1-T8038: a timed-out shard whose annotations only name the timeout reads its job log", async () => {
  const calls: string[] = [];
  const [f] = await read("ci-shard (7/8)", poolDefectLog, calls);
  assert.deepEqual(calls, ["555"], "the job log is read although the annotations were not bare");
  assert.equal(f?.tailSource, "log");
  assert.match(f?.logTail ?? "", /exceeded the maximum execution time/, "the runner line stays beside the region");
  assert.match(f?.logTail ?? "", /not ok 7 - test\/the-victim\.test\.ts/);
  assert.match(f?.logTail ?? "", /pure-test-pool: POOL DEFECT/);
  assert.equal(f?.annotationFallback?.outcome, "runner-timeout-only");
  assert.ok(ciFailureSignature(f?.logTail ?? "") !== undefined, "a readable red log never has a null signature");

  // A log that cannot be read keeps exactly the runner lines the annotations gave.
  const [unread] = await fetchCiFailuresAsync("o", "r", rollup("ci-shard (8/8)"), 60, {
    fetchAnnotations: async () => RUNNER_TIMEOUT,
    fetchJobLog: async () => {
      throw new Error("HTTP 403");
    },
  });
  assert.equal(unread?.tailSource, "annotations");
  assert.match(unread?.logTail ?? "", /operation was canceled/);

  // Annotations that name something else are still the whole tail when the log names no failure. W1-T9434 reads
  // the log once to check for a `not ok` that would win over them.
  const calls2: string[] = [];
  const [other] = await fetchCiFailuresAsync("o", "r", rollup("lint"), 60, {
    fetchAnnotations: async () => ["src/a.ts:3 error TS2304: Cannot find name 'x'"],
    fetchJobLog: async (_o, _r, id) => {
      calls2.push(id);
      return "unused";
    },
  });
  assert.deepEqual(calls2, ["555"]);
  assert.equal(other?.tailSource, "annotations");
});

test("W1-T8038: a pool defect names its leaking and victim files in the signature", async () => {
  const [f] = await read("ci-shard (7/8)", poolDefectLog);
  assert.equal(
    ciFailureSignature(f?.logTail ?? ""),
    "pool defect: test/the-leaker.test.ts leaks into test/the-victim.test.ts",
  );
  // The defect line lost to the kill: the pooled not ok that passed isolated is still a named pool failure.
  const killed = poolDefectLog.split("\n").filter((l) => !/POOL DEFECT/.test(l)).join("\n");
  assert.equal(
    ciFailureSignature(killed),
    "pool failure: test/the-victim.test.ts fails pooled, passes isolated",
  );
  // A pooled file that also fails isolated is an ordinary test failure, not a pool failure.
  const real = [
    "pure-test-pool: the pool of 3 file(s) failed (status 1); re-running them isolated once.",
    "not ok 2 - test/real.test.ts",
    "pure-test-pool: the pooled files also fail isolated — a test failure, not a pool defect.",
    "The operation was canceled.",
  ].join("\n");
  assert.equal(ciFailureSignature(real), "test/real.test.ts");
});

test("W1-T8038: a shard cancelled after a passing summary reads as timed out after a passing summary", async () => {
  const log = [
    "pure-test-pool: pool run complete — 40/40 file(s) reported, # tests 812, # fail 0.",
    "# tests 90",
    "# pass 90",
    "# fail 0",
    "##[error]The job running on runner GitHub Actions 12 has exceeded the maximum execution time of 35 minutes.",
    "##[error]The operation was canceled.",
  ]
    .map((l, i) => `${at(i)}${l}`)
    .join("\n");
  const [f] = await read("ci-shard (8/8)", log);
  assert.equal(ciFailureSignature(f?.logTail ?? ""), "timed out after a passing summary");
  assert.match(f?.logTail ?? "", /pure-test-pool: pool run complete/, "the pool verdict is retained in the tail");

  // No summary at all: the last started unfinished test if the log names one, else a named absence.
  const hung = ["ok 1 - test/a.test.ts", "The operation was canceled."].join("\n");
  assert.equal(ciFailureSignature(hung), "timed out with no test result");
  const named = `${hung}\n  Last started unfinished test: test/b.test.ts > slow case (ci-shard (7/8)).`;
  assert.equal(ciFailureSignature(named), "timed out during test/b.test.ts > slow case");
  // The aggregator's SHARD HANG block is a ceiling kill too.
  assert.equal(
    ciFailureSignature("ci: SHARD HANG — the matrix was cancelled while the PR head\n  Last started unfinished test: unavailable (x)."),
    "timed out with no test result",
  );
  // Text that is no timeout and no test runner stays unsigned.
  assert.equal(ciFailureSignature("all green"), undefined);
});

test("W1-T8038: a timed-out red behind a main that changed its job harness refreshes before the strike", () => {
  const timedOut = [
    { name: "ci-shard (7/8)", conclusion: "CANCELLED", logTail: RUNNER_TIMEOUT.join("\n") },
    { name: "ci", conclusion: "FAILURE", logTail: "ci: SHARD HANG — the matrix was cancelled" },
  ];
  const harness = decideRedBaseRefresh(timedOut, {
    behindBy: 7,
    baseChangedFiles: ["scripts/pure-test-pool.mjs", "src/lib/unrelated.ts"],
  });
  assert.equal(harness.refresh, true);
  assert.deepEqual(harness.matchingBaseFiles, ["scripts/pure-test-pool.mjs"]);
  assert.equal(harness.behindBy, 7);

  // CONTROL: main moved, but nothing the job runs — the strike proceeds unchanged.
  const unrelated = decideRedBaseRefresh(timedOut, { behindBy: 7, baseChangedFiles: ["src/lib/unrelated.ts"] });
  assert.equal(unrelated.refresh, false);
  assert.deepEqual(unrelated.matchingBaseFiles, []);

  // A branch that is not behind falls through even when the harness differs.
  assert.equal(decideRedBaseRefresh(timedOut, { behindBy: 0, baseChangedFiles: ["scripts/pure-test-pool.mjs"] }).refresh, false);

  // A red that names a failing test file does not borrow the harness arm: only an exact match refreshes.
  const named = [{ name: "ci-shard (1/8)", conclusion: "FAILURE", logTail: "not ok 1 - test/real.test.ts" }];
  assert.equal(decideRedBaseRefresh(named, { behindBy: 3, baseChangedFiles: ["scripts/pure-test-pool.mjs"] }).refresh, false);
  assert.deepEqual(
    decideRedBaseRefresh(named, { behindBy: 3, baseChangedFiles: ["test/real.test.ts"] }).matchingBaseFiles,
    ["test/real.test.ts"],
  );
});
