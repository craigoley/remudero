// test/benchmark-aa.test.ts — W1-T4575: the A/A integrity report over a pinned-stack trial.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  aaArmFor, aaStackHash, buildAaAllocationReceipt, buildBenchmarkAaReport, exactBinomialHalfPValue,
  IMMUTABLE_REVISION_RE, parseAaTrialManifest, readAaLedgerEvidence, TRIAL_ID_RE, twoProportionPValue,
  type AaTrialManifest, type BenchmarkAaReport,
} from "../src/lib/benchmark-aa.js";
import { runBenchmarkCohortPass } from "../src/lib/benchmark-cohort.js";
import type { TaskCaseFile } from "../src/lib/task-case-file.js";

const NOW = "2026-09-27T12:10:00.000Z";
const SHA = "a".repeat(40);
const LABELS: [string, string] = ["A1", "A2"];
type Row = Record<string, unknown>;

function manifestWith(taskCount: number, changes: Record<string, unknown> = {}): AaTrialManifest {
  const parsed = parseAaTrialManifest({
    version: "benchmark-aa-trial-v1", trialId: "aa-fixture-1", cohort: { kind: "public-fixture" },
    stack: { provider: "claude", model: "claude-sonnet-5", effort: "high", harnessRevision: SHA, promptRevision: SHA,
      toolRevision: SHA, scorerRevision: SHA, environmentRevision: SHA },
    strataRevision: "strata-v1",
    tasks: Array.from({ length: taskCount }, (_, i) => ({ taskId: `FX-T${i + 1}`, taskClass: i % 2 === 0 ? "fix" : "feature", risk: "low" })),
    protocolText: "A/A: identical arms, verified completion, task unit.\n", preRegisteredAt: "2026-09-01T00:00:00.000Z",
    ...changes,
  });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  return parsed.manifest;
}

const observed = (value: string) => ({ state: "observed", value });

function assignmentRow(taskId: string, n: number, ts: string, changes: { model?: string; effort?: string; provider?: string;
  arm?: string; routing?: boolean; taskClass?: string; revision?: string | null } = {}): Row {
  return {
    ts, step: "worker.assignment", task_id: taskId, run_id: `${taskId}-${n}`, host: "private-host",
    worker_assignment: { id: `${taskId}-a${n}`, requested: { model: "claude-sonnet-5", effort: "high" },
      selected: { provider: changes.provider ?? "claude", model: changes.model ?? "claude-sonnet-5", effort: changes.effort ?? "high" },
      ...(changes.routing ? { routing: { decision: { ab: "sol-vs-sonnet" } } } : {}) },
    benchmark_run: {
      work: { taskClass: observed(changes.taskClass ?? (Number(taskId.slice(4)) % 2 === 1 ? "fix" : "feature")), risk: observed("low") },
      stack: { harnessRevision: changes.revision === null ? { state: "unavailable", reason: "not-pinned-by-harness" } : observed(changes.revision ?? SHA),
        promptRevision: observed(SHA), toolRevision: observed(SHA), scorerRevision: observed(SHA), environmentRevision: observed(SHA) },
      allocation: changes.arm ? { method: "randomized", experimentId: "aa-fixture-1", arm: changes.arm } : { method: "observational" },
    },
  };
}

function callRow(step: "worker.attempt" | "verdict", taskId: string, n: number, ts: string, changes: Row = {}): Row {
  return { ts, step, task_id: taskId, run_id: `${taskId}-${n}`, selection_assignment_id: `${taskId}-a${n}`, success: true,
    served_model: "claude-sonnet-5", billing_mode: "subscription", total_cost_usd: 0.5, tokens: { input: 10, output: 5 },
    worker_duration_ms: 1000, ...changes };
}

/** A full receipt set for one task's run: assignment, attempt and terminal. */
function runRows(taskId: string, n: number, minute: number, changes: Row = {}): Row[] {
  const ts = (offset: number) => `2026-09-27T11:${String(minute).padStart(2, "0")}:${String(offset).padStart(2, "0")}.000Z`;
  return [assignmentRow(taskId, n, ts(0)), callRow("worker.attempt", taskId, n, ts(1), changes), callRow("verdict", taskId, n, ts(2), changes)];
}

function writeCorpus(dir: string, forms: { gz?: Row[][]; plain?: Row[][]; live?: Row[] }): void {
  mkdirSync(dir, { recursive: true });
  const encode = (rows: Row[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  (forms.gz ?? []).forEach((rows, i) => writeFileSync(join(dir, `ledger.2026-09-2${i}T00-00-00-000Z.ndjson.gz`), gzipSync(encode(rows))));
  (forms.plain ?? []).forEach((rows, i) => writeFileSync(join(dir, `ledger.2026-09-25T0${i}-00-00-000Z.ndjson`), encode(rows)));
  if (forms.live) writeFileSync(join(dir, "ledger.ndjson"), encode(forms.live));
}

function caseFileFor(taskId: string, n: number, prState: "OPEN" | "CLOSED" | "MERGED", prNumber: number): TaskCaseFile {
  const at = <T>(value: T) => ({ state: "observed" as const, value, source: "fixture", asOf: NOW });
  const gone = (reason: string) => ({ state: "unavailable" as const, reason, source: "fixture", asOf: NOW });
  return {
    version: "task-case-file-v1", taskId, asOf: NOW,
    plan: at({ title: taskId, dependsOn: [], verify: "auto", risk: "low" }),
    ledger: at({ windowStart: "2026-08-28T12:10:00.000Z", forms: { gzip: 1, plain: 1, live: 1 }, matchingRows: 3 }),
    runs: [{ runId: `${taskId}-${n}`, startedAt: "2026-09-27T11:00:00.000Z", assignmentId: `${taskId}-a${n}`,
      selectedProvider: "claude", selectedModel: "claude-sonnet-5", servedModel: "claude-sonnet-5",
      billingMode: "subscription", costUsd: 0.5, verdict: "passed", prNumber }],
    pr: at({ number: prNumber, url: `https://example.invalid/pull/${prNumber}`, headSha: SHA, state: prState, taskCredit: prState === "MERGED" }),
    review: at({ headSha: SHA, status: "success" as const }), acceptance: at({ headSha: SHA, status: "success" as const }),
    ci: at({ headSha: SHA, status: "success" as const }),
    mergedSource: prState === "MERGED" ? at({ prNumber, mergedAt: "2026-09-27T12:00:00.000Z" }) : gone("not-merged"),
    deployment: gone("not-collected"), runtime: gone("not-collected"), next: null,
  };
}

async function withDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "rmd-benchmark-aa-"));
  try { return await body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function reportOver(dir: string, manifest: AaTrialManifest, extra: Partial<Parameters<typeof buildBenchmarkAaReport>[0]> = {}): Promise<BenchmarkAaReport> {
  const evidence = await readAaLedgerEvidence(dir, new Set(manifest.tasks.map((task) => task.taskId)));
  return buildBenchmarkAaReport({ manifest, evidence, nowIso: NOW, ...extra });
}

const tasksIn = (manifest: AaTrialManifest, label: string) =>
  manifest.tasks.map((task) => task.taskId).filter((id) => aaArmFor(manifest.trialId, id, LABELS) === label);

test("benchmark aa assigns stable task labels to one pinned stack, and retries never reallocate", async () => {
  const manifest = manifestWith(40);
  const receipt = buildAaAllocationReceipt(manifest);
  assert.equal(receipt.arms.A1!.stackHash, receipt.arms.A2!.stackHash, "both labels carry the one pinned stack");
  assert.equal(receipt.arms.A1!.stackHash, aaStackHash(manifest.stack));
  assert.equal(receipt.unit, "task");
  assert.deepEqual(receipt.plannedAllocation, { A1: 0.5, A2: 0.5 });
  for (const task of manifest.tasks) {
    const first = aaArmFor(manifest.trialId, task.taskId, LABELS);
    for (let retry = 0; retry < 5; retry += 1) assert.equal(aaArmFor(manifest.trialId, task.taskId, LABELS), first, "a retry reads the same draw");
  }
  const shuffled = { ...manifest, tasks: [...manifest.tasks].reverse() };
  assert.equal(buildAaAllocationReceipt(shuffled).receiptHash, receipt.receiptHash, "task order is not an input to allocation");
  const otherTrial = manifest.tasks.filter((task) => aaArmFor("aa-fixture-2", task.taskId, LABELS) !== aaArmFor(manifest.trialId, task.taskId, LABELS));
  assert.ok(otherTrial.length > 0, "the trial id seeds the draw");
  assert.ok(tasksIn(manifest, "A1").length > 0 && tasksIn(manifest, "A2").length > 0);

  await withDir(async (dir) => {
    const retried = tasksIn(manifest, "A2")[0]!;
    const starter = tasksIn(manifest, "A1")[0]!;
    // Three runs of one task, the last recording the OTHER label: all stay in the allocated arm.
    const rows = [...runRows(retried, 1, 1), ...runRows(retried, 2, 2), ...runRows(starter, 1, 3)];
    rows.push(assignmentRow(retried, 3, "2026-09-27T11:04:00.000Z", { arm: "A1" }));
    writeCorpus(dir, { live: rows });
    const report = await reportOver(dir, manifest);
    const a2 = report.arms!.A2!;
    assert.equal(a2.exposedUnits, 1, "a retried task is one unit");
    assert.equal(a2.assignments, 3);
    assert.equal(a2.retries, 2, "every retry stays in the task's original arm");
    assert.equal(a2.crossovers, 1, "a relabeled exposure is recorded as a crossover, never moved");
    assert.equal(report.arms!.A1!.assignments, 1);
    assert.equal(a2.nonStarters + report.arms!.A1!.nonStarters, 38, "non-starters stay in their arm's denominator");
    assert.equal(a2.allocatedUnits + report.arms!.A1!.allocatedUnits, 40);
    const rebuilt = await reportOver(dir, manifest);
    assert.equal(rebuilt.allocation.receiptHash, report.allocation.receiptHash, "a replay reallocates nothing");
    assert.deepEqual(report.allocation.units.map((unit) => unit.arm).sort(),
      manifest.tasks.map((task) => aaArmFor(manifest.trialId, task.taskId, LABELS)).sort(), "the receipt records the draw");
    assert.ok(report.findings.some((item) => item.kind === "crossover"));
    assert.equal(report.evalCard!.sampleRatio.state, "observed");
  });
});

test("benchmark aa exposes imbalance and missingness without a winner", async () => {
  const manifest = manifestWith(60);
  const a1 = tasksIn(manifest, "A1");
  const a2 = tasksIn(manifest, "A2");
  await withDir(async (dir) => {
    // The pipeline starts every A1 task but only one A2 task, which also loses its served model and terminal.
    const rows: Row[] = [];
    a1.forEach((taskId, i) => rows.push(...runRows(taskId, 1, i % 50)));
    rows.push(assignmentRow(a2[0]!, 1, "2026-09-27T11:59:00.000Z"),
      callRow("worker.attempt", a2[0]!, 1, "2026-09-27T11:59:30.000Z", { served_model: undefined }));
    const replayed = rows.slice(0, 3);
    writeCorpus(dir, { gz: [replayed], plain: [[]], live: rows });
    const caseFiles = [caseFileFor(a1[0]!, 1, "OPEN", 11), caseFileFor(a1[1]!, 1, "MERGED", 12)];
    const report = await reportOver(dir, manifest, { caseFiles });
    assert.deepEqual(report.sources.forms, { gzip: 1, plain: 1, live: 1 }, "every form of the union was opened");
    assert.equal(report.sources.duplicateRows, 3, "rows replayed across rotations count once");
    assert.equal(report.arms!.A1!.assignments, a1.length);
    const exposed = report.sampleRatio.exposed;
    assert.equal(exposed.state, "observed");
    assert.ok(exposed.state === "observed" && exposed.mismatch && exposed.exactBinomialPValue < 0.001, "selection imbalance is a sample-ratio mismatch");
    assert.ok(exposed.state === "observed" && exposed.chiSquare.pValue < 0.001);
    assert.equal(report.sampleRatio.allocated.state === "observed" && report.sampleRatio.allocated.mismatch, false);
    assert.deepEqual(report.arms!.A2!.missingness.servedModel, { observed: 0, notRecorded: 1, noAttempt: 0 });
    assert.equal(report.arms!.A1!.missingness.servedModel.observed, a1.length);
    assert.equal(report.arms!.A2!.joins.terminal, 0, "a missing terminal is a join gap, not a failure");
    assert.equal(report.arms!.A2!.outcomes.failed, 0);
    assert.equal(report.arms!.A1!.outcomes.censored, 1, "an open PR is censored at the cutoff");
    assert.equal(report.arms!.A1!.outcomes.completed, 1);
    assert.equal(report.maturity.mature, false);
    const kinds = report.findings.map((item) => item.kind);
    for (const kind of ["sample-ratio-mismatch-exposed", "terminal-join-incomplete", "verified-join-incomplete",
      "immature-outcomes", "duplicate-evidence", "differential-missingness:servedModel"]) assert.ok(kinds.includes(kind), kind);
    assert.equal(report.verdict, "integrity-concerns");
    assert.equal(report.winnerDeclared, false);
    assert.equal(report.receipt.winnerDeclared, false);
    assert.equal(report.publicClaim, "requires-reviewed-release");
    assert.ok(report.recommendations.length > 0, "each concern can recommend a follow-up task");
  });

  await withDir(async (dir) => {
    // Balanced exposure, but every A1 task merges and every A2 task closes unmerged: a difference
    // between identical arms is the pipeline's, and is reported as such with no winner.
    const rows: Row[] = [];
    const picked = [...a1.slice(0, 12), ...a2.slice(0, 12)];
    picked.forEach((taskId, i) => rows.push(...runRows(taskId, 1, i)));
    writeCorpus(dir, { live: rows });
    const caseFiles = picked.map((taskId, i) => caseFileFor(taskId, 1, a1.includes(taskId) ? "MERGED" : "CLOSED", 100 + i));
    const report = await reportOver(dir, manifest, { caseFiles });
    const aa = report.evalCard!.aa;
    assert.equal(aa.state, "observed");
    assert.ok(aa.state === "observed" && aa.winnerDeclared === false && aa.difference.low > 0);
    assert.ok(report.findings.some((item) => item.kind === "spurious-difference"));
    assert.equal(report.arms!.A2!.outcomes.failed, 12);
    assert.ok("pValue" in report.receipt.difference);
    assert.equal(report.winnerDeclared, false);
    assert.doesNotMatch(JSON.stringify(report), /"winner":/, "no field names a winning label or model");
  });
});

test("benchmark aa keeps cash notional and unknown separate", async () => {
  const manifest = manifestWith(40);
  const a1 = tasksIn(manifest, "A1").slice(0, 6);
  const a2 = tasksIn(manifest, "A2").slice(0, 6);
  await withDir(async (dir) => {
    const rows: Row[] = [];
    a1.forEach((taskId, i) => rows.push(...runRows(taskId, 1, i, { billing_mode: "api", total_cost_usd: 0.25 * (i + 1) })));
    a2.forEach((taskId, i) => rows.push(...runRows(taskId, 1, 10 + i, i === 0 ? { billing_mode: undefined }
      : i === 1 ? { total_cost_usd: undefined } : { billing_mode: "subscription", total_cost_usd: 0 })));
    rows.push(assignmentRow(tasksIn(manifest, "A2")[7]!, 1, "2026-09-27T11:40:00.000Z"));
    writeCorpus(dir, { live: rows });
    const report = await reportOver(dir, manifest);
    const cash = report.arms!.A1!.accounting;
    assert.deepEqual(cash.apiCashEstimate, { assignments: 6, usd: 0.25 * 21 });
    assert.deepEqual(cash.subscriptionNotional, { assignments: 0, usd: 0 });
    const notional = report.arms!.A2!.accounting;
    assert.deepEqual(notional.subscriptionNotional, { assignments: 4, usd: 0 }, "a reported zero-dollar subscription call is notional, not cash");
    assert.deepEqual(notional.apiCashEstimate, { assignments: 0, usd: 0 });
    assert.deepEqual(notional.unknown, { assignments: 3,
      reasons: { "billing-mode-not-reported": 1, "cost-not-reported": 1, "no-attempt": 1 } }, "unknown carries reasons, never dollars");
    assert.equal("usd" in notional.unknown, false);
    assert.doesNotMatch(JSON.stringify(report.arms), /total/i, "cash and notional are never summed into one total");
    assert.ok(report.findings.some((item) => item.kind === "billing-mode-imbalance"), "a billing-mode split is an accounting artifact");
    assert.ok(report.findings.some((item) => item.kind === "unknown-cost" && item.severity === "info"));
    assert.deepEqual(report.invoice, { state: "unavailable", reason: "no-invoice-receipt" });
    assert.deepEqual(report.receipt.accountingKinds, ["api-cash-estimate", "subscription-notional", "invoice", "unknown"]);
    assert.equal(report.receipt.invoiceObserved, false);
    const invoiced = await reportOver(dir, manifestWith(40, { invoice: { usd: 12.5, reference: "INV-1" } }));
    assert.deepEqual(invoiced.invoice, { state: "observed", usd: 12.5, attribution: "trial-level-not-per-arm" });
    assert.equal(invoiced.receipt.invoiceObserved, true);
    assert.doesNotMatch(JSON.stringify(invoiced.receipt), /INV-1/, "the invoice reference stays out of the receipt");
  });
});

test("benchmark aa replays late evidence and preserves stale state", async () => {
  const manifest = manifestWith(20);
  const a1 = tasksIn(manifest, "A1");
  const a2 = tasksIn(manifest, "A2");
  await withDir(async (dir) => {
    writeCorpus(dir, { live: [...runRows(a1[0]!, 1, 1), ...runRows(a1[1]!, 1, 30),
      assignmentRow(a2[0]!, 1, "2026-09-27T11:05:00.000Z")] });
    const first = await reportOver(dir, manifest);
    assert.equal(first.lateEvidence.state, "no-prior");
    assert.equal(first.arms!.A2!.joins.terminal, 0);
    // A terminal stamped before the first report's watermark arrives in a later rotation.
    writeCorpus(dir, { plain: [[callRow("verdict", a2[0]!, 1, "2026-09-27T11:06:00.000Z")]] });
    const repaired = await reportOver(dir, manifest, { prior: first });
    assert.equal(repaired.lateEvidence.state, "replayed");
    assert.equal(repaired.lateEvidence.rows, 1);
    assert.deepEqual(repaired.lateEvidence.affectedArms, ["A2"], "only the arm the late row belongs to is named");
    assert.equal(repaired.arms!.A2!.joins.terminal, 1, "the late terminal repairs the arm it belongs to");
    assert.ok(repaired.findings.some((item) => item.kind === "late-evidence-replayed"));
    const unchanged = await reportOver(dir, manifest, { prior: repaired });
    assert.equal(unchanged.lateEvidence.state, "none");

    // An unreadable archive: the last dated report survives, marked stale, never a healthy empty trial.
    writeFileSync(join(dir, "ledger.2026-09-20T00-00-00-000Z.ndjson.gz"), "not gzip at all");
    const evidence = await readAaLedgerEvidence(dir, new Set(manifest.tasks.map((task) => task.taskId)));
    assert.equal(evidence.state, "unavailable");
    assert.deepEqual(evidence.unreadSources, ["ledger.2026-09-20T00-00-00-000Z.ndjson.gz"]);
    const stale = buildBenchmarkAaReport({ manifest, evidence, nowIso: "2026-09-27T13:00:00.000Z", prior: repaired });
    assert.equal(stale.state, "stale");
    assert.equal(stale.reason, "ledger-source-unreadable");
    assert.equal(stale.lastGoodAt, repaired.asOf);
    assert.equal(stale.asOf, "2026-09-27T13:00:00.000Z");
    assert.deepEqual(stale.arms, repaired.arms, "stale keeps the last measured arms");
    assert.equal(stale.receipt.state, "stale");
    assert.ok(stale.findings.some((item) => item.kind === "source-unavailable"));
    const staleAgain = buildBenchmarkAaReport({ manifest, evidence, nowIso: "2026-09-27T14:00:00.000Z", prior: stale });
    assert.equal(staleAgain.findings.filter((item) => item.kind === "source-unavailable").length, 1);
    assert.equal(staleAgain.lastGoodAt, repaired.asOf);
    const blind = buildBenchmarkAaReport({ manifest, evidence, nowIso: NOW });
    assert.equal(blind.state, "unavailable");
    assert.equal(blind.arms, null, "no prior: unavailable, never zero counts");
    assert.equal(blind.verdict, "unavailable");
    assert.deepEqual(blind.sampleRatio.exposed, { state: "unknown", reason: "ledger-source-unreadable" });
    assert.equal(blind.receipt.mature, false);
    assert.equal(blind.receipt.joinRates.A1!.terminal, null);
    assert.equal(buildBenchmarkAaReport({ manifest, evidence: { ...evidence, reason: undefined }, nowIso: NOW }).reason, "ledger-source-unavailable");
  });
  await withDir(async (dir) => {
    assert.equal((await readAaLedgerEvidence(join(dir, "absent"), new Set())).reason, "ledger-source-unreadable");
    assert.equal((await readAaLedgerEvidence(dir, new Set())).reason, "ledger-source-missing");
    writeFileSync(join(dir, "ledger.ndjson"), `${JSON.stringify(assignmentRow(a1[0]!, 1, "2026-09-27T11:00:00.000Z"))}\n{torn\n`);
    const partial = await readAaLedgerEvidence(dir, new Set([a1[0]!]));
    assert.equal(partial.state, "observed-partial");
    const report = buildBenchmarkAaReport({ manifest, evidence: partial, nowIso: NOW });
    assert.equal(report.state, "observed-partial");
    assert.ok(report.findings.some((item) => item.kind === "source-malformed-rows"));
  });
});

test("benchmark aa trial regexes accept an immutable id and refuse a mutable one", () => {
  assert.equal(TRIAL_ID_RE.test("aa-fixture-1"), true);
  assert.equal(TRIAL_ID_RE.test("../escape"), false);
  assert.equal(IMMUTABLE_REVISION_RE.test(SHA), true);
  assert.equal(IMMUTABLE_REVISION_RE.test("main"), false);
});

test("benchmark aa manifest refuses an ineligible cohort or an unpinned stack by name", () => {
  const base = { version: "benchmark-aa-trial-v1", trialId: "aa-x", cohort: { kind: "public-fixture" },
    stack: manifestWith(1).stack, strataRevision: "s1", tasks: [{ taskId: "T1", taskClass: "fix", risk: "low" }] };
  const refused = (changes: Record<string, unknown>) => {
    const parsed = parseAaTrialManifest({ ...base, ...changes });
    return parsed.ok ? "accepted" : parsed.reason;
  };
  assert.equal(refused({ version: "v0" }), "manifest-version-unsupported");
  assert.equal(refused({ trialId: "../x" }), "trial-id-invalid");
  assert.equal(refused({ cohort: { kind: "live-fleet" } }), "cohort-not-public-fixture-or-opted-in");
  assert.equal(refused({ cohort: { kind: "opted-in", consentReceipt: "c1" } }), "opted-in-cohort-needs-consent-receipt-and-salt");
  assert.equal(refused({ stack: { ...base.stack, model: "" } }), "stack-not-pinned:model");
  assert.equal(refused({ stack: { ...base.stack, promptRevision: "main" } }), "stack-not-pinned:promptRevision");
  assert.equal(refused({ labels: ["A", "A"] }), "labels-must-be-two-distinct-names");
  assert.equal(refused({ strataRevision: " " }), "strata-revision-missing");
  assert.equal(refused({ tasks: [] }), "tasks-missing");
  assert.equal(refused({ tasks: [{ taskId: "T1" }] }), "task-entry-invalid");
  assert.equal(refused({ tasks: [...base.tasks, ...base.tasks] }), "task-duplicated");
  assert.equal(refused({ invoice: { usd: -1, reference: "r" } }), "invoice-invalid");
  assert.equal(refused({ labels: ["X", "Y"], registeredAllocationHash: "b".repeat(64) }), "accepted");
  const optedIn = parseAaTrialManifest({ ...base, cohort: { kind: "opted-in", consentReceipt: "consent-7", pseudonymSalt: "local-salt" } });
  assert.ok(optedIn.ok);
  const receipt = buildAaAllocationReceipt(optedIn.manifest);
  assert.doesNotMatch(JSON.stringify(receipt), /T1|local-salt|consent-7/, "an opted-in receipt carries pseudonyms only");
  assert.notEqual(receipt.units[0]!.unit, buildAaAllocationReceipt({ ...optedIn.manifest, cohort: { kind: "public-fixture" } }).units[0]!.unit);
});

test("benchmark aa exact binomial and two-proportion tests match their closed forms", () => {
  assert.equal(exactBinomialHalfPValue(10, 20), 1);
  assert.equal(exactBinomialHalfPValue(0, 0), 1);
  assert.ok(Math.abs(exactBinomialHalfPValue(0, 20) - 2 * 0.5 ** 20) < 1e-12);
  assert.ok(Math.abs(exactBinomialHalfPValue(3, 10) - 0.34375) < 1e-9);
  assert.equal(twoProportionPValue(1, 0, 1, 2), 1);
  assert.equal(twoProportionPValue(2, 2, 3, 3), 1, "a degenerate pooled rate is no evidence of a difference");
  assert.ok(twoProportionPValue(0, 6, 6, 6) < 0.001);
});

test("benchmark aa reports stack deviations, routing overlap and rewritten receipts against the pin", async () => {
  const manifest = manifestWith(20, { registeredAllocationHash: "c".repeat(64) });
  const [t1, t2, t3] = tasksIn(manifest, "A1");
  await withDir(async (dir) => {
    const rows: Row[] = [
      assignmentRow(t1!, 1, "2026-09-27T11:00:00.000Z", { model: "claude-opus-5", effort: "low", provider: "codex", routing: true, taskClass: "docs" }),
      callRow("worker.attempt", t1!, 1, "2026-09-27T11:00:01.000Z", { served_model: "claude-haiku-5" }),
      assignmentRow(t2!, 1, "2026-09-27T11:01:00.000Z", { revision: "b".repeat(40) }),
      assignmentRow(t2!, 1, "2026-09-27T11:01:05.000Z", { revision: null }),
      assignmentRow(t3!, 1, "2026-09-27T11:02:00.000Z", { revision: null }),
      callRow("verdict", t3!, 1, "2026-09-27T11:02:01.000Z"),
      callRow("verdict", t3!, 1, "2026-09-27T11:02:02.000Z", { evidence_action: "retract" }),
      { ts: "2026-09-27T11:03:00.000Z", step: "worker.assignment", task_id: t3, worker_assignment: {} },
      callRow("worker.attempt", t3!, 9, "2026-09-27T11:03:01.000Z", { selection_assignment_id: undefined }),
    ];
    writeCorpus(dir, { live: rows });
    const cohort = (await runBenchmarkCohortPass(dir, { maxSources: 4, nowIso: NOW })).snapshot;
    const report = await reportOver(dir, manifest, { cohort });
    const arm = report.arms!.A1!;
    assert.deepEqual(arm.fallbacks, { provider: 1, selectedModel: 1, effort: 1, servedModel: 1 });
    assert.deepEqual(arm.revisions, { different: 1, unpinned: 1 });
    assert.equal(arm.routingOverlap, 1);
    assert.equal(arm.stratumMismatches, 1);
    assert.equal(arm.joins.terminal, 0, "a retracted terminal no longer joins");
    assert.equal(report.sources.conflictingAssignments, 1);
    const kinds = report.findings.map((item) => item.kind);
    for (const kind of ["stack-deviation", "unpinned-revision-at-run", "observational-routing-overlap", "stratum-mismatch",
      "conflicting-assignment-receipts", "allocation-receipt-changed"]) assert.ok(kinds.includes(kind), kind);
    assert.equal(report.cohortReconciliation.state, "unavailable", "the cohort projection refuses conflicting assignment ids");
    const clean = (await withDir(async (other) => {
      writeCorpus(other, { gz: [runRows(t1!, 1, 1)], live: runRows(t2!, 1, 2) });
      const snapshot = (await runBenchmarkCohortPass(other, { maxSources: 4, nowIso: NOW })).snapshot;
      const reconciled = await reportOver(other, manifestWith(20), { cohort: snapshot });
      const drifted = await reportOver(other, manifestWith(20), { cohort: { ...snapshot, sourceRows: { ...snapshot.sourceRows, assignments: 9 } } });
      return { reconciled, drifted };
    }));
    assert.equal(clean.reconciled.cohortReconciliation.state, "reconciled");
    assert.ok(clean.reconciled.cohortReconciliation.state === "reconciled"
      && clean.reconciled.cohortReconciliation.cohortSourceForms.gzip === 1);
    assert.equal(clean.drifted.cohortReconciliation.state, "mismatch");
    assert.ok(clean.drifted.findings.some((item) => item.kind === "cohort-reconciliation-mismatch"));
    const unavailable = await reportOver(dir, manifest, { cohort: { state: "unavailable", reason: "scan-incomplete" } });
    assert.deepEqual(unavailable.cohortReconciliation, { state: "unavailable", reason: "scan-incomplete", lastGoodAt: null });
    assert.ok(unavailable.findings.some((item) => item.kind === "cohort-unavailable"));
    const receiptText = JSON.stringify(report.receipt);
    for (const secret of [t1!, `${t1}-1`, "private-host", `${t1}-a1`]) assert.equal(receiptText.includes(secret), false, secret);
  });
});

test("benchmark aa reads an untouched trial as inconclusive, not as a pass", async () => {
  const manifest = manifestWith(4);
  await withDir(async (dir) => {
    writeCorpus(dir, { live: [assignmentRow("OTHER-T1", 1, "2026-09-27T11:00:00.000Z")] });
    const report = await reportOver(dir, manifest);
    assert.equal(report.sources.trialRows, 0);
    assert.equal(report.verdict, "inconclusive");
    assert.ok(report.findings.some((item) => item.kind === "no-exposures"));
    assert.equal(report.sampleRatio.exposed.state, "unknown");
    assert.equal(report.maturity.mature, false, "non-starters are unavailable outcomes, so nothing is mature");
  });
});
