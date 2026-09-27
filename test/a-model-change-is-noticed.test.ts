import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runBenchmarkCohortPass } from "../src/lib/benchmark-cohort.js";
import {
  DRIFT_BLOCK_SIZE, DRIFT_FAMILY_ALPHA, MAX_DRIFT_SERIES, MAX_TIMELINE_ENTRIES, MODEL_DRIFT_VERSION,
  deriveModelDrift, unavailableModelDrift, upperNormalQuantile, wilsonInterval, type ModelExposure,
} from "../src/lib/model-drift.js";
import type { TaskCaseFile } from "../src/lib/task-case-file.js";

// Minute `i` after 10:00 on 2026-09-27, as the canonical ISO form the ledger writes.
const at = (i: number, seconds = 0): string => {
  const hour = 10 + Math.floor(i / 60);
  return `2026-09-27T${String(hour).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.000Z`;
};
const HARNESS = "c".repeat(40);

const exposure = (i: number, changes: Partial<ModelExposure> = {}): ModelExposure => ({
  at: at(i), fleet: "core", harnessRevision: HARNESS, taskClass: "fix", requestedModel: "luna",
  selectedModel: "gpt-luna", servedModel: i < DRIFT_BLOCK_SIZE ? "gpt-5.6-luna" : "gpt-6-luna", servedAt: at(i, 30),
  verified: { state: "resolved", completed: i < DRIFT_BLOCK_SIZE ? i % 10 !== 0 : i % 10 < 2 },
  cost: { state: "observed", billingMode: "api", usd: 0.02 + (i % 3) * 0.001 },
  ...changes,
});
const series = (report: ReturnType<typeof deriveModelDrift>, metric: string, model = "gpt-luna") =>
  report.series.find((entry) => entry.metric === metric && entry.selectedModel === model)!;

test("a served model's first and last exposure is recorded per fleet and harness revision", () => {
  const rows = Array.from({ length: 60 }, (_, i) => exposure(i, i >= 50 ? { fleet: "site", harnessRevision: "d".repeat(40) } : {}));
  const report = deriveModelDrift(rows, "2026-09-27T12:00:00.000Z");
  const served = report.timeline.filter((entry) => entry.kind === "served");
  const find = (model: string, fleet: string) => served.find((entry) => entry.model === model && entry.fleet === fleet)!;
  assert.deepEqual(find("gpt-5.6-luna", "core"), { kind: "served", model: "gpt-5.6-luna", fleet: "core",
    harnessRevision: HARNESS, firstSeen: at(0, 30), lastSeen: at(29, 30), exposures: 30 });
  assert.deepEqual([find("gpt-6-luna", "core").firstSeen, find("gpt-6-luna", "core").lastSeen, find("gpt-6-luna", "core").exposures],
    [at(30, 30), at(49, 30), 20]);
  assert.equal(find("gpt-6-luna", "site").harnessRevision, "d".repeat(40), "a new harness revision is its own exposure row");
  assert.equal(find("gpt-6-luna", "site").firstSeen, at(50, 30));
  const requested = report.timeline.filter((entry) => entry.kind === "requested");
  assert.deepEqual(requested.map((entry) => [entry.model, entry.fleet, entry.firstSeen, entry.lastSeen, entry.exposures]),
    [["luna", "site", at(50), at(59), 10], ["luna", "core", at(0), at(49), 50]], "newest lastSeen first");
  const shuffled = deriveModelDrift([...rows].reverse(), "2026-09-27T12:00:00.000Z");
  assert.deepEqual(shuffled.timeline, report.timeline, "first/last seen come from time, not input order");
});

test("a completion shift across a model swap is reported as drift with its window, sample sizes and uncertainty", () => {
  const report = deriveModelDrift(Array.from({ length: 60 }, (_, i) => exposure(i)), "2026-09-27T12:00:00.000Z");
  assert.equal(report.version, MODEL_DRIFT_VERSION);
  assert.equal(report.claim, "descriptive-not-causal");
  assert.equal(report.routingInput, "never");
  const completion = series(report, "verified-completion");
  assert.equal(completion.state, "drift");
  assert.equal(completion.reason, null);
  assert.equal(completion.observed, 60);
  assert.deepEqual(completion.window!.reference, { from: at(0), to: at(29), n: 30, estimate: 0.9,
    servedModels: ["gpt-5.6-luna"], servedUnrecorded: 0 });
  assert.deepEqual([completion.window!.recent.from, completion.window!.recent.to, completion.window!.recent.n,
    completion.window!.recent.servedModels], [at(30), at(59), 30, ["gpt-6-luna"]]);
  assert.ok(Math.abs(completion.window!.recent.estimate - 0.2) < 1e-12);
  const difference = completion.difference!;
  assert.ok(Math.abs(difference.estimate + 0.7) < 1e-12);
  assert.ok(difference.lower < difference.estimate && difference.estimate < difference.upper && difference.upper < 0,
    "the interval brackets the estimate and excludes zero");
  assert.equal(report.series[0]!.state, "drift", "drift rows sort first");
});

test("a stationary series is judged and not called drift", () => {
  const rows = Array.from({ length: 75 }, (_, i) => exposure(i, {
    verified: { state: "resolved", completed: i % 2 === 0 }, servedModel: null }));
  const report = deriveModelDrift(rows, null);
  const completion = series(report, "verified-completion");
  assert.equal(completion.state, "no-drift");
  assert.equal(completion.observed, 75);
  assert.deepEqual([completion.window!.reference.from, completion.window!.recent.to], [at(0), at(59)],
    "only complete blocks are judged; the partial block waits");
  assert.equal(completion.window!.recent.servedUnrecorded, 30);
  assert.ok(completion.difference!.lower < 0 && completion.difference!.upper > 0);
  assert.equal(report.coverage.servedUnrecorded, 75);
});

test("a thin or unjoined sample reads insufficient with its reason, never a zero rate", () => {
  const rows = Array.from({ length: 2 * DRIFT_BLOCK_SIZE - 1 }, (_, i) => exposure(i, i % 2
    ? { verified: { state: "unavailable", reason: "no-verified-outcome-join" } }
    : { cost: { state: "unavailable", reason: "no-attempt" } }));
  const report = deriveModelDrift([...rows,
    exposure(90, { at: "not-a-time" }), exposure(91, { selectedModel: null, requestedModel: null })], null);
  for (const metric of ["verified-completion", "api-cost-usd", "subscription-notional-cost-usd"]) {
    const entry = series(report, metric);
    assert.equal(entry.state, "insufficient", metric);
    assert.equal(entry.reason, "fewer-than-two-complete-blocks", metric);
    assert.equal(entry.window, null, metric);
    assert.equal(entry.difference, null, metric);
  }
  assert.deepEqual(series(report, "verified-completion").excluded, { "no-verified-outcome-join": 29 });
  assert.equal(series(report, "verified-completion").observed, 30);
  assert.deepEqual(series(report, "subscription-notional-cost-usd").excluded, { "no-attempt": 30 });
  assert.equal(series(report, "subscription-notional-cost-usd").observed, 0);
  assert.equal(report.method.testsInFamily, 0);
  assert.equal(report.method.z, null);
  assert.deepEqual(report.coverage, { rows: 61, unorderedRows: 1, unattributedRows: 1,
    requestedUnrecorded: 1, servedUnrecorded: 0 });
});

test("cash and subscription-notional cost are separate series and never summed", () => {
  const rows = Array.from({ length: 120 }, (_, i) => {
    const step = Math.floor(i / 2);
    return i % 2 === 0
      ? exposure(step, { cost: { state: "observed", billingMode: "api", usd: (step < 30 ? 0.02 : 0.2) + (step % 3) * 0.001 } })
      : exposure(step, { cost: { state: "observed", billingMode: "subscription", usd: 1 + (step % 4) * 0.01 } });
  });
  const report = deriveModelDrift(rows, null);
  const api = series(report, "api-cost-usd");
  const notional = series(report, "subscription-notional-cost-usd");
  assert.equal(api.state, "drift");
  assert.equal(api.observed, 60);
  assert.ok(api.difference!.lower > 0.15, "the cash shift is visible without subscription values diluting it");
  assert.equal(notional.state, "no-drift");
  assert.equal(notional.observed, 60);
  assert.ok(notional.window!.reference.estimate > 1 && api.window!.recent.estimate < 0.3, "no series mixes the two bases");
  assert.equal(report.method.costInterval, "welch-normal");
});

test("the false-alarm budget is split across every judged block pair", () => {
  const one = deriveModelDrift(Array.from({ length: 60 }, (_, i) => exposure(i)), null);
  const two = deriveModelDrift([...Array.from({ length: 60 }, (_, i) => exposure(i)),
    ...Array.from({ length: 60 }, (_, i) => exposure(i, { selectedModel: "claude-opus" }))], null);
  assert.equal(one.method.testsInFamily, 2, "completion and cash cost are judged; notional has no values");
  assert.equal(two.method.testsInFamily, 4);
  assert.ok(Math.abs(one.method.z! - upperNormalQuantile(DRIFT_FAMILY_ALPHA / 4)) < 1e-12);
  assert.ok(two.method.z! > one.method.z!, "more judged pairs demand a wider interval");
  assert.equal(series(two, "verified-completion", "claude-opus").difference!.confidence, 1 - DRIFT_FAMILY_ALPHA / 4);
  assert.equal(one.method.detector, "tumbling-two-block-comparison");
  assert.equal(one.method.blockSize, DRIFT_BLOCK_SIZE);
});

test("the snapshot stays bounded and counts what it drops", () => {
  const wide = Array.from({ length: MAX_DRIFT_SERIES + 1 }, (_, i) => exposure(i, { selectedModel: `m${i}`,
    requestedModel: `r${i}`, servedModel: `s${i}`, cost: { state: "unavailable", reason: "cost-not-recorded" } }));
  const report = deriveModelDrift(wide, null);
  assert.equal(report.series.length, MAX_DRIFT_SERIES);
  assert.equal(report.seriesTruncated, 3 * (MAX_DRIFT_SERIES + 1) - MAX_DRIFT_SERIES);
  const entries = 2 * (MAX_DRIFT_SERIES + 1);
  assert.equal(report.timeline.length, Math.min(entries, MAX_TIMELINE_ENTRIES));
  assert.equal(report.timelineTruncated, Math.max(0, entries - MAX_TIMELINE_ENTRIES));
  assert.equal(report.timeline[0]!.lastSeen >= report.timeline.at(-1)!.lastSeen, true, "the newest exposures survive a cut");
});

test("the interval primitives match their published values and refuse an unapproximated tail", () => {
  assert.ok(Math.abs(upperNormalQuantile(0.005) - 2.5758293) < 1e-6);
  assert.ok(Math.abs(upperNormalQuantile(0.0005) - 3.2905267) < 1e-6);
  assert.throws(() => upperNormalQuantile(0.05), RangeError);
  assert.throws(() => upperNormalQuantile(0), RangeError);
  const interval = wilsonInterval(0, 30, 1.96);
  assert.equal(interval.lower, 0);
  assert.ok(interval.upper > 0.1, "zero successes is not a zero rate");
  assert.equal(wilsonInterval(30, 30, 1.96).upper, 1);
  const missing = unavailableModelDrift("ledger-source-missing");
  assert.deepEqual([missing.state, missing.reason, missing.asOf, missing.series.length], ["unavailable", "ledger-source-missing", null, 0]);
});

const sha = "a".repeat(40);
const cutoff = "2026-09-27T23:00:00.000Z";
const observed = <T>(value: T) => ({ state: "observed" as const, value, source: "fixture", asOf: cutoff });
const notCollected = { state: "unavailable" as const, reason: "not-collected", source: "fixture", asOf: cutoff };
const caseFile = (i: number): TaskCaseFile => ({
  version: "task-case-file-v1", taskId: `W1-T${i}`, asOf: cutoff,
  plan: observed({ title: "example", dependsOn: [], verify: "auto", risk: "low" }),
  ledger: observed({ windowStart: "2026-08-28T12:10:00.000Z", forms: { gzip: 0, plain: 0, live: 1 }, matchingRows: 2 }),
  runs: [{ runId: `r${i}`, startedAt: at(i), assignmentId: `a${i}`, selectedProvider: "codex", selectedModel: "gpt-luna",
    servedModel: null, billingMode: "api", costUsd: 0.02, verdict: "passed", prNumber: 1000 + i }],
  pr: observed({ number: 1000 + i, url: `https://github.com/craigoley/remudero/pull/${1000 + i}`, headSha: sha,
    state: i < DRIFT_BLOCK_SIZE ? "MERGED" : "CLOSED", taskCredit: i < DRIFT_BLOCK_SIZE }),
  review: observed({ headSha: sha, status: "success" }),
  acceptance: observed({ headSha: sha, status: "success" }),
  ci: observed({ headSha: sha, status: "success" }),
  mergedSource: i < DRIFT_BLOCK_SIZE ? observed({ prNumber: 1000 + i, mergedAt: "2026-09-27T22:00:00Z" }) : notCollected,
  deployment: notCollected, runtime: notCollected, next: null,
});

function writeLedger(dir: string): void {
  const lines: string[] = [];
  for (let i = 0; i <= 2 * DRIFT_BLOCK_SIZE; i++) {
    lines.push(JSON.stringify({ ts: at(i), host: "core-host", task_id: `W1-T${i}`, run_id: `r${i}`, step: "worker.assignment",
      worker_assignment: { id: `a${i}`, requested: { model: "luna" }, selected: { provider: "codex", model: "gpt-luna" } },
      benchmark_run: { work: { taskClass: { state: "observed", value: "fix" } },
        stack: { harnessRevision: { state: "observed", value: HARNESS } } } }));
    lines.push(JSON.stringify({ ts: at(i, 40), host: "core-host", task_id: `W1-T${i}`, run_id: `r${i}`, step: "worker.attempt",
      selection_assignment_id: `a${i}`, success: true, served_model: i < DRIFT_BLOCK_SIZE ? "gpt-5.6-luna" : "gpt-6-luna",
      billing_mode: "api", total_cost_usd: (i < DRIFT_BLOCK_SIZE ? 0.02 : 0.2) + (i % 3) * 0.001 }));
  }
  writeFileSync(join(dir, "ledger.ndjson"), lines.join("\n") + "\n");
}

test("the benchmark cohort pass carries the drift record, joined to verified outcomes and never faked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-model-drift-"));
  try {
    const missing = await runBenchmarkCohortPass(dir, { nowIso: cutoff });
    assert.deepEqual([missing.snapshot.modelDrift.state, missing.snapshot.modelDrift.reason], ["unavailable", "ledger-source-missing"]);
    writeLedger(dir);
    const plain = await runBenchmarkCohortPass(dir, { nowIso: cutoff });
    const drift = plain.snapshot.modelDrift;
    assert.equal(drift.state, "observed");
    assert.equal(drift.asOf, cutoff);
    const served = drift.timeline.find((entry) => entry.kind === "served" && entry.model === "gpt-6-luna")!;
    assert.deepEqual([served.fleet, served.harnessRevision, served.firstSeen, served.lastSeen, served.exposures],
      ["core-host", HARNESS, at(30, 40), at(60, 40), 31]);
    assert.equal(drift.timeline.find((entry) => entry.kind === "requested")!.model, "luna");
    assert.equal(series(drift, "api-cost-usd").state, "drift");
    assert.equal(series(drift, "api-cost-usd").taskClass, "fix");
    const unjoined = series(drift, "verified-completion");
    assert.equal(unjoined.state, "insufficient", "a worker call's success is never read as a verified outcome");
    assert.deepEqual(unjoined.excluded, { "no-verified-outcome-join": 61 });

    const files = Array.from({ length: 61 }, (_, i) => caseFile(i));
    files[60] = { ...caseFile(60), pr: observed({ number: 1060, url: "https://github.com/craigoley/remudero/pull/1060",
      headSha: sha, state: "OPEN", taskCredit: false }) };
    const joined = await runBenchmarkCohortPass(dir, { nowIso: cutoff, caseFiles: files });
    assert.equal(joined.scannedSources, 0, "the overlay refreshes the cached snapshot without rescanning");
    const completion = series(joined.snapshot.modelDrift, "verified-completion");
    assert.equal(completion.state, "drift");
    assert.deepEqual([completion.window!.reference.estimate, completion.window!.recent.estimate], [1, 0]);
    assert.deepEqual(completion.excluded, { "censored-open-at-cutoff": 1 }, "open work is censored, not counted as a non-completion");
    assert.equal(completion.observed, 60);
    const noFiles = await runBenchmarkCohortPass(dir, { nowIso: cutoff, caseFiles: [] });
    assert.deepEqual(series(noFiles.snapshot.modelDrift, "verified-completion").excluded, { "case-file-missing": 61 });

    const checkpointPath = join(dir, "benchmark-cohort-v1.json");
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    delete checkpoint.lastGood.modelDrift;
    writeFileSync(checkpointPath, JSON.stringify(checkpoint));
    const upgraded = await runBenchmarkCohortPass(dir, { nowIso: cutoff });
    assert.equal(upgraded.scannedSources, 0);
    assert.equal(upgraded.snapshot.modelDrift?.version, MODEL_DRIFT_VERSION,
      "a checkpoint written before the drift record is re-derived, not served without one");
    assert.equal(series(upgraded.snapshot.modelDrift, "api-cost-usd").state, "drift");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
