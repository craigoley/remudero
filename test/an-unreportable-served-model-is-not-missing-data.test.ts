// test/an-unreportable-served-model-is-not-missing-data.test.ts — W1-T4707: a codex attempt's served
// model is UNREPORTABLE (W1-T4650 names why), not missing. The A/A report tallies it apart from
// notRecorded, runs differential-missingness:servedModel over genuinely missing evidence only, and
// reports a differing unreportable share as a non-integrity provider-mix finding. Every case writes
// real ledger rows and reads them through readAaLedgerEvidence, so the reason is threaded end to end.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { aaArmFor, buildBenchmarkAaReport, parseAaTrialManifest, readAaLedgerEvidence, type AaTrialManifest,
  type BenchmarkAaReport } from "../src/lib/benchmark-aa.js";
import type { TaskCaseFile } from "../src/lib/task-case-file.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { CASH_SERVED_MODEL_REASONS, CODEX_SERVED_MODEL_REASON } from "../src/lib/worker-provider.js";

const NOW = "2026-09-28T12:10:00.000Z";
const SHA = "b".repeat(40);
const LABELS: [string, string] = ["A1", "A2"];
const MODEL = "gpt-5-codex";
type Row = Record<string, unknown>;

function manifestOf(taskCount: number): AaTrialManifest {
  const parsed = parseAaTrialManifest({
    version: "benchmark-aa-trial-v1", trialId: "aa-unreportable-1", cohort: { kind: "public-fixture" },
    stack: { provider: "codex", model: MODEL, effort: "high", harnessRevision: SHA, promptRevision: SHA,
      toolRevision: SHA, scorerRevision: SHA, environmentRevision: SHA },
    strataRevision: "strata-v1",
    tasks: Array.from({ length: taskCount }, (_, i) => ({ taskId: `UR-T${i + 1}`, taskClass: "fix", risk: "low" })),
    protocolText: "A/A: identical arms, verified completion, task unit.\n", preRegisteredAt: "2026-09-01T00:00:00.000Z",
  });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  return parsed.manifest;
}

const observed = (value: string) => ({ state: "observed", value });

/** One task's assignment, attempt and terminal, on the pinned stack; `served` is the attempt's served-model evidence. */
function runRows(taskId: string, i: number, served: Row): Row[] {
  const ts = (second: number) => `2026-09-28T11:${String(i).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
  const call = (step: string, second: number): Row => ({ ts: ts(second), step, task_id: taskId, run_id: `${taskId}-1`,
    selection_assignment_id: `${taskId}-a1`, success: true, billing_mode: "subscription", total_cost_usd: 0.5,
    tokens: { input: 10, output: 5 }, worker_duration_ms: 1000, ...served });
  return [{
    ts: ts(0), step: "worker.assignment", task_id: taskId, run_id: `${taskId}-1`,
    worker_assignment: { id: `${taskId}-a1`, requested: { model: MODEL, effort: "high" }, selected: { provider: "codex", model: MODEL, effort: "high" } },
    benchmark_run: { work: { taskClass: observed("fix"), risk: observed("low") },
      stack: Object.fromEntries(["harnessRevision", "promptRevision", "toolRevision", "scorerRevision", "environmentRevision"]
        .map((field) => [field, observed(SHA)])),
      allocation: { method: "observational" } },
  }, call("worker.attempt", 1), call("verdict", 2)];
}

function mergedCaseFile(taskId: string, prNumber: number): TaskCaseFile {
  const at = <T>(value: T) => ({ state: "observed" as const, value, source: "fixture", asOf: NOW });
  const gone = (reason: string) => ({ state: "unavailable" as const, reason, source: "fixture", asOf: NOW });
  return {
    version: "task-case-file-v1", taskId, asOf: NOW,
    plan: at({ title: taskId, dependsOn: [], verify: "auto", risk: "low" }),
    ledger: at({ windowStart: "2026-08-29T12:10:00.000Z", forms: { gzip: 0, plain: 0, live: 1 }, matchingRows: 3 }),
    runs: [{ runId: `${taskId}-1`, startedAt: "2026-09-28T11:00:00.000Z", assignmentId: `${taskId}-a1`,
      selectedProvider: "codex", selectedModel: MODEL, servedModel: null, billingMode: "subscription", costUsd: 0.5,
      verdict: "passed", prNumber }],
    pr: at({ number: prNumber, url: `https://example.invalid/pull/${prNumber}`, headSha: SHA, state: "MERGED", taskCredit: true }),
    review: at({ headSha: SHA, status: "success" as const }), acceptance: at({ headSha: SHA, status: "success" as const }),
    ci: at({ headSha: SHA, status: "success" as const }), mergedSource: at({ prNumber, mergedAt: "2026-09-28T12:00:00.000Z" }),
    deployment: gone("not-collected"), runtime: gone("not-collected"), next: null,
  } as TaskCaseFile;
}

/** Every task runs and merges; `servedFor` decides each attempt's served-model evidence by arm. */
async function reportWith(servedFor: (arm: string) => Row, taskCount = 24): Promise<BenchmarkAaReport> {
  const manifest = manifestOf(taskCount);
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4707-`));
  try {
    const rows = manifest.tasks.flatMap((task, i) => runRows(task.taskId, i, servedFor(aaArmFor(manifest.trialId, task.taskId, LABELS))));
    writeFileSync(join(dir, "ledger.ndjson"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const evidence = await readAaLedgerEvidence(dir, new Set(manifest.tasks.map((task) => task.taskId)));
    const caseFiles = manifest.tasks.map((task, i) => mergedCaseFile(task.taskId, 700 + i));
    return buildBenchmarkAaReport({ manifest, evidence, nowIso: NOW, caseFiles });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SERVED: Row = { served_model: MODEL };
const CODEX: Row = { served_model: null, served_model_reason: CODEX_SERVED_MODEL_REASON };
const kinds = (report: BenchmarkAaReport) => report.findings.map((item) => item.kind);

test("W1-T4707 falsifier: arms identical except one is all codex attempts are not differentially missing, and report an unreportable share per arm", async () => {
  const report = await reportWith((arm) => arm === "A1" ? CODEX : SERVED);
  const [a1, a2] = [report.arms!.A1!, report.arms!.A2!];
  assert.ok(a1.assignments > 5 && a2.assignments > 5, "both arms carry enough attempts for the tests to have power");
  assert.ok(!kinds(report).includes("differential-missingness:servedModel"), kinds(report).join(", "));
  assert.deepEqual(a1.servedModelUnreportable, { assignments: a1.assignments, providers: { codex: a1.assignments } });
  assert.deepEqual(a2.servedModelUnreportable, { assignments: 0, providers: {} });
  assert.deepEqual(a1.missingness.servedModel, { observed: 0, notRecorded: 0, noAttempt: 0 }, "an unreportable attempt is not notRecorded");
  assert.deepEqual(a2.missingness.servedModel, { observed: a2.assignments, notRecorded: 0, noAttempt: 0 });
  const mix = report.findings.find((item) => item.kind === "served-model-unreportable-mix");
  assert.ok(mix, "a differing unreportable share is reported as its own finding");
  assert.equal(mix.severity, "info");
  assert.match(mix.detail, new RegExp(`A1 ${a1.assignments}/${a1.assignments} \\(codex ${a1.assignments}\\), A2 0/${a2.assignments}`));
  assert.match(mix.detail, /provider mix/);
});

test("W1-T4707: the unreportable-mix finding alone does not make the verdict integrity-concerns", async () => {
  const report = await reportWith((arm) => arm === "A1" ? CODEX : SERVED);
  assert.deepEqual(report.findings.filter((item) => item.severity === "concern").map((item) => item.kind), [],
    "the fixture is otherwise a clean, observed A/A trial");
  assert.ok(kinds(report).includes("served-model-unreportable-mix"));
  assert.equal(report.verdict, "no-integrity-concern-detected");
  assert.deepEqual(report.recommendations, []);
  assert.ok(report.receipt.findings.includes("served-model-unreportable-mix"), "the receipt still names the finding");
});

test("W1-T4707: a genuine missing-served-model imbalance with no reason, a generic reason or a cash reason still flags", async () => {
  for (const missing of [{ served_model: null }, { served_model: null, served_model_reason: "the provider reported no served model for this call" },
    { served_model: null, served_model_reason: CASH_SERVED_MODEL_REASONS.unnamed },
    { served_model: null, served_model_reason: CASH_SERVED_MODEL_REASONS.noResponse }]) {
    const report = await reportWith((arm) => arm === "A1" ? missing : SERVED);
    const a1 = report.arms!.A1!;
    assert.ok(kinds(report).includes("differential-missingness:servedModel"), JSON.stringify(missing));
    assert.deepEqual(a1.missingness.servedModel, { observed: 0, notRecorded: a1.assignments, noAttempt: 0 }, JSON.stringify(missing));
    assert.deepEqual(a1.servedModelUnreportable, { assignments: 0, providers: {} });
    assert.ok(!kinds(report).includes("served-model-unreportable-mix"));
    assert.equal(report.verdict, "integrity-concerns");
  }
});

test("W1-T4707: an older row with no served_model_reason counts as notRecorded, beside codex rows that do not", async () => {
  // Both arms mix codex attempts with older rows that predate W1-T4650's reason; only the older rows are missing.
  let n = 0;
  const report = await reportWith(() => (n++ % 2 === 0 ? CODEX : { served_model: null }), 20);
  for (const label of LABELS) {
    const arm = report.arms![label]!;
    const tally = arm.missingness.servedModel;
    assert.equal(tally.observed, 0);
    assert.ok(tally.notRecorded > 0, `${label}: an old row with no reason is notRecorded`);
    assert.equal(tally.notRecorded + arm.servedModelUnreportable!.assignments, arm.assignments,
      `${label}: every attempt is either unreportable or notRecorded, never both`);
  }
  assert.equal(report.arms!.A1!.servedModelUnreportable!.assignments + report.arms!.A2!.servedModelUnreportable!.assignments, 10);
});
