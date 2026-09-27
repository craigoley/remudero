// W1-T4636: W1-T4629 ledgers a worker's SELF_FORECAST on `implement.done` beside its
// `selection_assignment_id`, and W1-T4623 joins each assignment to its own verified outcome inside the
// cohort snapshot. This suite proves the cohort pass pairs the two and scores them per model x task
// class: completed counts 1, closed-unmerged-unadjudicated counts 0, an open (censored) or unavailable
// outcome is counted and never scored, and an absent or invalid forecast is counted, never imputed.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runBenchmarkCohortPass } from "../src/lib/benchmark-cohort.js";
import {
  SELF_FORECAST_CALIBRATION_VERSION, parseSelfForecast, readSelfForecastRecord, unavailableSelfForecastCalibration,
  type SelfForecast,
} from "../src/lib/self-forecast.js";
import type { TaskCaseFile } from "../src/lib/task-case-file.js";

const cutoff = "2026-09-27T23:00:00.000Z";
const sha = "a".repeat(40);
const at = (i: number, seconds = 0): string =>
  `2026-09-27T10:${String(i).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.000Z`;
const observed = <T>(value: T) => ({ state: "observed" as const, value, source: "fixture", asOf: cutoff });
const notCollected = { state: "unavailable" as const, reason: "not-collected", source: "fixture", asOf: cutoff };

type PrState = "MERGED" | "CLOSED" | "OPEN";
type Case = { model: string; taskClass: string; forecast?: unknown; pr?: PrState };

// Assignments a0..a9. `forecast` undefined = an implement.done row written before W1-T4629 (no field);
// `pr` undefined = no case file for that task.
const CASES: Case[] = [
  { model: "gpt-luna", taskClass: "fix", forecast: parseSelfForecast("SELF_FORECAST: p=0.9"), pr: "MERGED" },
  { model: "gpt-luna", taskClass: "fix", forecast: parseSelfForecast("SELF_FORECAST: p=0.8"), pr: "CLOSED" },
  { model: "gpt-luna", taskClass: "fix", forecast: parseSelfForecast("SELF_FORECAST: p=0.7"), pr: "OPEN" },
  { model: "gpt-luna", taskClass: "fix", forecast: parseSelfForecast("no forecast line"), pr: "MERGED" },
  { model: "gpt-luna", taskClass: "fix", forecast: parseSelfForecast("SELF_FORECAST: p=high"), pr: "MERGED" },
  { model: "gpt-luna", taskClass: "fix", forecast: parseSelfForecast("SELF_FORECAST: p=0.6") },
  { model: "gpt-luna", taskClass: "fix", pr: "MERGED" },
  { model: "gpt-luna", taskClass: "fix", forecast: { state: "present", p: 7 }, pr: "MERGED" },
  { model: "claude-opus", taskClass: "feature", forecast: parseSelfForecast("SELF_FORECAST: p=0.2"), pr: "MERGED" },
  { model: "claude-opus", taskClass: "feature", pr: "MERGED" },
];

function caseFile(i: number, state: PrState): TaskCaseFile {
  const merged = state === "MERGED";
  return {
    version: "task-case-file-v1", taskId: `W1-T${9000 + i}`, asOf: cutoff,
    plan: observed({ title: "example", dependsOn: [], verify: "auto", risk: "low" }),
    ledger: observed({ windowStart: "2026-08-28T12:10:00.000Z", forms: { gzip: 0, plain: 0, live: 1 }, matchingRows: 2 }),
    runs: [{ runId: `run-${i}`, startedAt: at(i), assignmentId: `assign-${i}`, selectedProvider: "codex",
      selectedModel: CASES[i]!.model, servedModel: null, billingMode: "api", costUsd: 0.02, verdict: "passed", prNumber: 2000 + i }],
    pr: observed({ number: 2000 + i, url: `https://github.com/craigoley/remudero/pull/${2000 + i}`, headSha: sha,
      state, taskCredit: merged }),
    review: observed({ headSha: sha, status: "success" }),
    acceptance: observed({ headSha: sha, status: "success" }),
    ci: observed({ headSha: sha, status: "success" }),
    mergedSource: merged ? observed({ prNumber: 2000 + i, mergedAt: "2026-09-27T22:00:00Z" }) : notCollected,
    deployment: notCollected, runtime: notCollected, next: null,
  };
}
const caseFiles = (): TaskCaseFile[] => CASES.flatMap((entry, i) => entry.pr ? [caseFile(i, entry.pr)] : []);

function ledgerLines(): string[] {
  const lines: string[] = [];
  CASES.forEach((entry, i) => {
    lines.push(JSON.stringify({ ts: at(i), host: "core-host", task_id: `W1-T${9000 + i}`, run_id: `run-${i}`,
      step: "worker.assignment",
      worker_assignment: { id: `assign-${i}`, requested: { model: entry.model }, selected: { provider: "codex", model: entry.model } },
      benchmark_run: { work: { taskClass: { state: "observed", value: entry.taskClass } },
        stack: { harnessRevision: { state: "observed", value: "c".repeat(40) } } } }));
    lines.push(JSON.stringify({ ts: at(i, 30), host: "core-host", task_id: `W1-T${9000 + i}`, run_id: `run-${i}`,
      step: "worker.attempt", selection_assignment_id: `assign-${i}`, success: true, billing_mode: "api", total_cost_usd: 0.02 }));
    // a9 is a worker call with no implement row at all: it is not a forecast opportunity.
    if (i === 9) return;
    lines.push(JSON.stringify({ ts: at(i, 40), host: "core-host", task_id: `W1-T${9000 + i}`, run_id: `run-${i}`,
      step: "implement.done", cost_usd: 0.02, selection_assignment_id: `assign-${i}`,
      ...(entry.forecast === undefined ? {} : { self_forecast: entry.forecast }) }));
  });
  lines.push(JSON.stringify({ ts: at(50), task_id: "W1-T9050", run_id: "run-ghost", step: "implement.done",
    selection_assignment_id: "assign-ghost", self_forecast: parseSelfForecast("SELF_FORECAST: p=0.5") }));
  lines.push(JSON.stringify({ ts: at(51), task_id: "W1-T9051", run_id: "run-51", step: "implement.done",
    self_forecast: parseSelfForecast("SELF_FORECAST: p=0.5") }));
  return lines;
}

test("a ledgered forecast reads back exactly as parsed, and a damaged record is never a worker's absent answer", () => {
  for (const report of ["SELF_FORECAST: p=0.35", "none", "SELF_FORECAST: p=x", "SELF_FORECAST: p=2",
    "SELF_FORECAST: p=0.1\nSELF_FORECAST: p=0.2"]) {
    const parsed: SelfForecast = parseSelfForecast(report);
    assert.deepEqual(readSelfForecastRecord(JSON.parse(JSON.stringify(parsed))), parsed, report);
  }
  for (const damaged of [undefined, null, "0.7", 0.7, { state: "present" }, { state: "present", p: -0.1 },
    { state: "present", p: 1.5 }, { state: "absent", reason: "other" }, { state: "invalid", reason: "other" },
    { state: "record-invalid" }]) {
    assert.equal(readSelfForecastRecord(damaged), null, JSON.stringify(damaged));
  }
  assert.deepEqual(unavailableSelfForecastCalibration("ledger-source-missing", null), {
    version: SELF_FORECAST_CALIBRATION_VERSION, state: "unavailable", reason: "ledger-source-missing", asOf: null,
    claim: "descriptive-not-causal", routingInput: "never", coverage: null, score: null });
});

test("each implement self-forecast is paired with its assignment's verified outcome and scored per model and task class", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-forecast-outcome-"));
  try {
    const missing = await runBenchmarkCohortPass(dir, { nowIso: cutoff });
    assert.deepEqual([missing.snapshot.selfForecastCalibration.state, missing.snapshot.selfForecastCalibration.reason],
      ["unavailable", "ledger-source-missing"]);

    writeFileSync(join(dir, "ledger.ndjson"), ledgerLines().join("\n") + "\n");
    const unjoined = await runBenchmarkCohortPass(dir, { nowIso: cutoff });
    assert.equal(unjoined.state, "complete");
    assert.deepEqual(unjoined.snapshot.selfForecastCalibration, unavailableSelfForecastCalibration("no-verified-outcome-join", cutoff),
      "without a verified-outcome join nothing is paired, and nothing is scored as failure");

    const joined = await runBenchmarkCohortPass(dir, { nowIso: cutoff, caseFiles: caseFiles() });
    assert.equal(joined.scannedSources, 0, "the overlay recomputes calibration on the cached snapshot");
    const calibration = joined.snapshot.selfForecastCalibration;
    assert.equal(calibration.version, SELF_FORECAST_CALIBRATION_VERSION);
    assert.deepEqual([calibration.state, calibration.reason, calibration.asOf, calibration.claim, calibration.routingInput],
      ["observed", null, cutoff, "descriptive-not-causal", "never"]);
    assert.deepEqual(calibration.coverage, {
      paired: 7,
      forecasts: { present: 5, absent: 1, invalid: 1 },
      outcomes: { completed: 4, notCompleted: 1, excluded: { "censored-open-at-cutoff": 1, "case-file-missing": 1 } },
      unpaired: { "implement-row-without-assignment-id": 1, "forecast-not-recorded": 1, "forecast-record-invalid": 1,
        "assignment-not-in-cohort": 1 },
    });

    const groups = calibration.score!.groups;
    assert.deepEqual(groups.map((group) => [group.model, group.taskClass]), [["claude-opus", "feature"], ["gpt-luna", "fix"]]);
    const luna = groups[1]!;
    assert.deepEqual([luna.pairs, luna.scored, luna.forecastAbsent, luna.outcomeUnverified], [6, 2, 2, 2],
      "only a present forecast with a resolved outcome is scored: absent/invalid and censored/unavailable are counted");
    assert.equal(luna.brier.state, "observed");
    assert.ok(Math.abs((luna.brier as { value: number }).value - ((0.9 - 1) ** 2 + (0.8 - 0) ** 2) / 2) < 1e-12,
      "completed scores 1 and closed-unmerged scores 0");
    assert.ok(Math.abs(luna.meanForecast! - 0.85) < 1e-12);
    assert.equal(luna.observedRate, 0.5);
    assert.ok(Math.abs(luna.perceptionGap! - 0.35) < 1e-12, "over-confidence reads positive");
    assert.deepEqual(luna.reliability.filter((bin) => bin.count > 0).map((bin) => [bin.lo, bin.count, bin.observedRate]),
      [[0.8, 1, 0], [0.9, 1, 1]]);
    const opus = groups[0]!;
    assert.deepEqual([opus.pairs, opus.scored, opus.meanForecast, opus.observedRate], [1, 1, 0.2, 1],
      "an assignment with no implement row is not a forecast opportunity");
    assert.ok(Math.abs((opus.brier as { value: number }).value - 0.64) < 1e-12);

    const published = JSON.stringify(calibration);
    for (const id of ["W1-T9", "run-", "assign-"]) assert.ok(!published.includes(id), `no ${id} id leaks into the record`);

    const none = await runBenchmarkCohortPass(dir, { nowIso: cutoff, caseFiles: [] });
    const unscored = none.snapshot.selfForecastCalibration;
    assert.deepEqual([unscored.state, unscored.reason, unscored.score!.state], ["unavailable", "no-scored-pair", "unavailable"]);
    assert.deepEqual(unscored.coverage!.outcomes, { completed: 0, notCompleted: 0, excluded: { "case-file-missing": 7 } },
      "a missing join is excluded with its reason, never a zero");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an older checkpoint is recomputed, and a live source scanned without implement rows is rescanned whole", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-forecast-outcome-"));
  try {
    const ledger = join(dir, "ledger.ndjson");
    writeFileSync(ledger, ledgerLines().join("\n") + "\n");
    await runBenchmarkCohortPass(dir, { nowIso: cutoff });
    const checkpointFile = join(dir, "benchmark-cohort-v1.json");

    const checkpoint = JSON.parse(readFileSync(checkpointFile, "utf8"));
    delete checkpoint.lastGood.selfForecastCalibration;
    writeFileSync(checkpointFile, JSON.stringify(checkpoint));
    const upgraded = await runBenchmarkCohortPass(dir, { nowIso: cutoff });
    assert.equal(upgraded.scannedSources, 0);
    assert.equal(upgraded.snapshot.selfForecastCalibration?.version, SELF_FORECAST_CALIBRATION_VERSION,
      "a snapshot cached before the calibration record is re-derived, not served without one");

    // A checkpoint written before implement.done was retained: no marker, no implement rows.
    const legacy = JSON.parse(readFileSync(checkpointFile, "utf8"));
    for (const source of legacy.sources) {
      delete source.projection;
      source.rows = source.rows.filter((entry: { row: { step: string } }) => entry.row.step !== "implement.done");
    }
    delete legacy.lastGood.selfForecastCalibration;
    writeFileSync(checkpointFile, JSON.stringify(legacy));
    appendFileSync(ledger, JSON.stringify({ ts: at(55), step: "worker.attempt", run_id: "run-55" }) + "\n");
    const rescanned = await runBenchmarkCohortPass(dir, { nowIso: cutoff, caseFiles: caseFiles() });
    assert.equal(rescanned.scannedSources, 1);
    const calibration = rescanned.snapshot.selfForecastCalibration;
    assert.equal(calibration.coverage!.paired, 7, "rows the legacy scan never retained are read again, not lost");
    assert.equal(calibration.state, "observed");
    const stored = JSON.parse(readFileSync(checkpointFile, "utf8"));
    assert.deepEqual(stored.sources.map((source: { projection?: string }) => source.projection), ["implement-forecast-v1"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
