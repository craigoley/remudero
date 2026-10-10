import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

import {
  CI_MATRIX_AGGREGATORS,
  DEFAULT_SWEEP_POLICY,
  earlyRedEvidenceRollup,
  runSweep,
  withoutDownstreamGateFailure,
  type CiFailure,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { buildOpenPrViews, fetchCiFailures } from "../src/run-task.js";

// coverage-ratchet is ci.yml's AGGREGATOR over eight coverage shards. When a shard's test fails,
// the aggregator's whole log is "a coverage shard FAILED — open the shard log". Measured
// 2026-09-29 on the core ledger: 69 of 82 red coverage-ratchet heads were a failing shard, and
// every one of them was dispatched while ci-gate was still pending, from a rollup narrowed to the
// REQUIRED names, so the fix worker read the aggregator's pointer and never the shard's failure.

const OWNER = "craigoley";
const REPO = "remudero";
const HEAD = "7816deadbeef7816deadbeef7816deadbeef7816";
const SHARD_LOG = "not ok 3 - the aggregator names the shard it failed on\n  ---\n  error: expected 2\n  ...";
const AGGREGATOR_LOG = "coverage-ratchet: a coverage shard FAILED (matrix result: failure) — open the shard log";

function ledgerPath(): string {
  const path = join(mkdtempSync(join(tmpdir(), "rmd-aggregator-shard-")), "ledger.ndjson");
  writeFileSync(path, "");
  return path;
}

function board(shardConclusion: string) {
  return (args: string[]): unknown => {
    const path = args[args.length - 1] ?? "";
    if (/state=open/.test(path)) {
      return [{
        number: 7816,
        html_url: `https://github.com/${OWNER}/${REPO}/pull/7816`,
        head: { ref: "run-W1-T4700-1", sha: HEAD },
        updated_at: "2026-09-29T09:00:00Z",
        body: "Remudero-Task: W1-T4700",
        auto_merge: null,
        state: "open",
      }];
    }
    if (/check-runs/.test(path)) {
      return { check_runs: [
        { name: "ci-gate", status: "in_progress", started_at: "2026-09-29T08:50:00Z" },
        { name: "coverage-ratchet", status: "completed", conclusion: "failure", started_at: "2026-09-29T08:59:00Z", details_url: "https://github.com/o/r/actions/runs/1/job/100" },
        { name: "coverage-shard (4/8)", status: "completed", conclusion: "success", started_at: "2026-09-29T08:51:00Z", details_url: "https://github.com/o/r/actions/runs/1/job/104" },
        { name: "coverage-shard (5/8)", status: "completed", conclusion: shardConclusion, started_at: "2026-09-29T08:51:00Z", details_url: "https://github.com/o/r/actions/runs/1/job/105" },
        { name: "ci-shard (5/8)", status: "completed", conclusion: "failure", started_at: "2026-09-29T08:51:00Z", details_url: "https://github.com/o/r/actions/runs/1/job/205" },
        { name: "ci", status: "in_progress", started_at: "2026-09-29T08:52:00Z" },
      ] };
    }
    if (/\/status$/.test(path)) return { statuses: [] };
    return [];
  };
}

const logs: Record<string, string> = { "100": AGGREGATOR_LOG, "105": SHARD_LOG, "205": "not ok 1 - ci shard" };

function viewsFor(shardConclusion: string) {
  return buildOpenPrViews(OWNER, REPO, ledgerPath(), {
    fetch: board(shardConclusion),
    requiredContexts: () => ["ci-gate", "remudero-review"],
    readCiGateRequired: () => ["ci", "coverage-ratchet"],
    fetchCiFailureEvidence: (owner, repo, rollup) =>
      fetchCiFailures(owner, repo, rollup, 60, {
        fetchAnnotations: () => ["Process completed with exit code 1"],
        fetchJobLog: (_o, _r, jobId) => logs[jobId] ?? "",
      }),
  });
}

test("a pending PR whose coverage-ratchet is red hands the fix worker the failing shard's own log", async () => {
  const views = viewsFor("failure");
  assert.equal(views[0].checksState, "pending", "ci-gate has not concluded — the early-red path");
  assert.deepEqual(views[0].ciFailures?.map((f) => f.name), ["coverage-shard (5/8)"]);
  assert.match(views[0].ciFailures?.[0].logTail ?? "", /not ok 3 - the aggregator names the shard it failed on/);

  const dispatched: CiFailure[][] = [];
  const deps: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: (_pr, evidence) => { dispatched.push(evidence.ciFailures ?? []); },
    escalate: () => {},
    ledgerPath: ledgerPath(),
    runId: "SWEEP-aggregator-shard",
    now: () => Date.parse("2026-09-29T09:05:00Z"),
  };
  await runSweep(views, deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(dispatched.map((f) => f.map((x) => x.name)), [["coverage-shard (5/8)"]]);
});

test("a shard that was only cancelled keeps the aggregator beside it — its log names the hung test", () => {
  const views = viewsFor("cancelled");
  assert.deepEqual(views[0].ciFailures?.map((f) => f.name).sort(), ["coverage-ratchet", "coverage-shard (5/8)"]);
});

test("the early rollup takes only the shards of a RED aggregator, never a sibling's", () => {
  const rollup = [
    { name: "coverage-ratchet" },
    { name: "coverage-shard (1/8)" },
    { name: "ci-shard (1/8)" },
    { name: "test-slow-shard (1/2)" },
    { name: "optional-scanner" },
  ];
  assert.deepEqual(earlyRedEvidenceRollup(rollup, ["coverage-ratchet"]).map((c) => c.name), ["coverage-ratchet", "coverage-shard (1/8)"]);
  assert.deepEqual(earlyRedEvidenceRollup(rollup, ["lint-plan"]).map((c) => c.name), []);
  assert.deepEqual(earlyRedEvidenceRollup(undefined, ["coverage-ratchet"]), []);
});

test("coverage-ratchet red on its own step stays the named failure with its own shortfall", () => {
  const own: CiFailure = { name: "coverage-ratchet", logTail: "diff-coverage: BLOCKED\n  - src/lib/learnings.ts:621", conclusion: "FAILURE" };
  const out = withoutDownstreamGateFailure([{ name: "ci-gate", logTail: "" }, own, { name: "lint-plan", logTail: "x" }]);
  assert.deepEqual(out.map((f) => f.name), ["coverage-ratchet", "lint-plan"]);
  assert.equal(out[0].logTail, own.logTail);
});

test("ci and test-slow drop the same way once their own shard failed", () => {
  const out = withoutDownstreamGateFailure([
    { name: "ci", logTail: "", conclusion: "FAILURE" },
    { name: "ci-shard (2/8)", logTail: "not ok", conclusion: "FAILURE" },
    { name: "test-slow", logTail: "", conclusion: "FAILURE" },
    { name: "test-slow-shard (1/2)", logTail: "not ok", conclusion: "FAILURE" },
  ]);
  assert.deepEqual(out.map((f) => f.name), ["ci-shard (2/8)", "test-slow-shard (1/2)"]);
});

test("each aggregator in the table is a ci.yml job that needs the matrix its pattern names", () => {
  const workflow = parse(readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8")) as {
    jobs: Record<string, { name?: string; needs?: string | string[]; strategy?: { matrix?: { shard?: unknown[] } } }>;
  };
  const jobs = Object.values(workflow.jobs);
  assert.ok(jobs.length > 5, "the workflow parsed into its jobs");
  for (const { aggregator, constituent } of CI_MATRIX_AGGREGATORS) {
    const job = jobs.find((j) => j.name === aggregator);
    assert.ok(job, `${aggregator} is a job name in ci.yml`);
    const needs = [job.needs ?? []].flat();
    const matrixNames = needs.flatMap((id) => {
      const need = workflow.jobs[id];
      const shards = need?.strategy?.matrix?.shard ?? [];
      return shards.map((shard) => (need?.name ?? "").replace("${{ matrix.shard }}", String(shard)));
    });
    assert.ok(matrixNames.length > 0, `${aggregator} needs a sharded matrix job`);
    for (const name of matrixNames) assert.match(name, constituent, `${aggregator}'s shard ${name}`);
  }
});
