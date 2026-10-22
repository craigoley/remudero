import { REPO_ROOT as __workspaceRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL as __workspaceUrl } from "node:url";
const __workspaceRootUrl = __workspaceUrl(__workspaceRoot + "/");
import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire, syncBuiltinESMExports } from "node:module";
// A positively absent feature must fail inside a real test at the base. Other
// import failures still propagate as environment gaps; never catch them here.
const codingLedger = existsSync(new URL("src/lib/model-canary-ledger.ts", __workspaceRootUrl))
  ? await import("#src/lib/model-canary-ledger.js") : undefined;
function requiredCodingLedger() {
  assert.ok(codingLedger, "the coding receipt producer and observer must exist");
  return codingLedger;
}
import { meaningOfStep } from "#src/lib/ledger-steps.js";
import { resolveProducerIdentity } from "#src/lib/producer-identity.js";
import type { CanaryRun } from "#src/lib/model-canary-metrics.js";
const codingCases = existsSync(new URL("src/lib/model-canary-coding.ts", __workspaceRootUrl))
  ? await import("#src/lib/model-canary-coding.js") : undefined;
function codingCaseRequests() {
  assert.ok(codingCases, "the real coding case producer must exist in this source tree");
  return codingCases.codingCaseRequests();
}
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

export const measuredCodingRun = (id = "receipt-1"): CanaryRun => ({ id, caseId: "coding-parser",
  suiteHash: codingCaseRequests()[0]!.suiteHash, model: "requested-model", route: "fixture-subscription", effort: "medium",
  family: "coding", verified: null, totalDurationMs: 100, attempts: [{ id: "attempt-" + id, durationMs: 20,
    firstTextMs: 3, generationMs: 10, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: null, usageRatedUsd: null, billing: "subscription", servedModel: "observed-model", terminal: "complete" }] });
const row = (run: CanaryRun) => ({ step: requiredCodingLedger().CANARY_CODING_OBSERVED_STEP, run_id: run.id, task_id: "MODEL-CANARY",
  canary_coding: { version: "canary-coding-ledger-v1", qualification: "unregistered-mechanics-only", run } });

test("canonical coding save uses the real existing ledger and redacts transport extras without inventing billing or grades", async t => {
  const { codingLedgerSave, codingLedgerObserver, CANARY_CODING_OBSERVED_STEP } = requiredCodingLedger();
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}coding-receipt-`)); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true })); const path = join(dir, "ledger.ndjson");
  const input = Object.assign(measuredCodingRun(), { secret: "MUST-NOT-RETAIN" });
  Object.assign(input.attempts[0]!, { raw: "MUST-NOT-RETAIN" });
  await codingLedgerSave(path)(input, null);
  const text = readFileSync(path, "utf8"); assert.ok(!text.includes("MUST-NOT-RETAIN"));
  const saved = JSON.parse(text.trim()); assert.equal(saved.step, CANARY_CODING_OBSERVED_STEP);
  assert.equal(saved.task_id, "MODEL-CANARY"); assert.equal(resolveProducerIdentity(saved.task_id).id, "model-canary");
  assert.ok(meaningOfStep(saved.step)!.writer.includes("codingLedgerSave"));
  assert.equal(saved.canary_coding.run.verified, null); assert.equal(saved.canary_coding.run.attempts[0].usageRatedUsd, null);
  const observer = codingLedgerObserver(); observer.observe(saved);
  const report = observer.report(true); assert.equal(report.retainedRuns, 1); assert.equal(report.state, "observed");
  assert.equal(report.measurements!.groups[0]!.servedMismatch, 1); assert.equal(report.measurements!.groups[0]!.passRate, null);
});

test("critical coding receipt save refuses a real torn write rather than releasing ownership on ledger's ordinary warning", async t => {
  const { codingLedgerSave } = requiredCodingLedger();
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}coding-short-`)); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fs = createRequire(import.meta.url)("node:fs"), original = fs.writeSync;
  fs.writeSync = (fd: number, buffer: Buffer) => original(fd, buffer.subarray(0, 3)); syncBuiltinESMExports();
  try { await assert.rejects(codingLedgerSave(join(dir, "ledger.ndjson"))(measuredCodingRun(), null), /durable-write-incomplete/); }
  finally { fs.writeSync = original; syncBuiltinESMExports(); }
});

test("coding receipts reject qualified grades missing measurements oversized identity and widened byte bounds", async () => {
  const { codingLedgerSave, codingRunReceipt } = requiredCodingLedger();
  const run = measuredCodingRun();
  assert.throws(() => codingRunReceipt({ ...run, verified: true }), /contract-invalid/);
  assert.throws(() => codingRunReceipt({ ...run, model: "x".repeat(129) }), /contract-invalid/);
  assert.throws(() => codingRunReceipt(run, 1), /receipt-bound/);
  assert.throws(() => codingRunReceipt(run, 65_537), /byte-bound-invalid/);
  assert.throws(() => codingRunReceipt({ ...run, outcomeReason: "raw private error" }), /reason-invalid/);
  await assert.rejects(codingLedgerSave("unused", () => { throw new Error("must-not-write"); })(run, { passed: true, reason: "forged", schemaValid: true }), /grade-unqualified/);
  await assert.rejects(codingLedgerSave("unused", () => { throw new Error("write-refused"); })(run, null), /write-refused/);
});

test("collector exact receipt duplicates are idempotent while conflicting IDs damage and overflow stay explicit", () => {
  const { codingLedgerObserver, CANARY_CODING_OBSERVED_STEP } = requiredCodingLedger();
  const observer = codingLedgerObserver(1), run = measuredCodingRun();
  observer.observe(row(run)); observer.observe(row(run)); observer.observe(row(measuredCodingRun("receipt-2")));
  observer.observe(row({ ...run, model: "conflicting" }));
  assert.equal(observer.observe({ step: CANARY_CODING_OBSERVED_STEP })!.state, "invalid");
  const report = observer.report(false);
  assert.equal(report.duplicates, 1); assert.equal(report.omitted, 1); assert.equal(report.conflicts, 1); assert.equal(report.invalid, 1);
  assert.equal(report.state, "observed-partial"); assert.equal(report.measurements, null); assert.equal(report.pairs, null);
  assert.throws(() => codingLedgerObserver(8193), /observer-bound/);
});


test("coding receipt drill-down stays bounded and unavailable evidence stays unavailable", () => {
  const { codingLedgerObserver } = requiredCodingLedger();
  const empty = codingLedgerObserver().report(false);
  assert.equal(empty.state, "unavailable"); assert.equal(empty.measurements, null); assert.equal(empty.pairs, null);
  const observer = codingLedgerObserver(129);
  for (let n = 0; n < 129; n++) observer.observe(row(measuredCodingRun("bounded-" + n)));
  const report = observer.report(true);
  assert.equal(report.state, "observed"); assert.equal(report.retainedRuns, 129);
  assert.equal(report.runDetails.length, 128); assert.equal(report.detailsOmitted, 1);
  assert.equal(report.measurements!.uniqueRuns, 129);
});

test("coding receipt invalid outcomes retain bounded error types without private messages", () => {
  const { codingLedgerObserver, CANARY_CODING_OBSERVED_STEP } = requiredCodingLedger();
  const observer = codingLedgerObserver();
  const result = observer.observe({ step: CANARY_CODING_OBSERVED_STEP,
    get canary_coding(): never { throw new RangeError("MUST-NOT-RETAIN"); } });
  assert.deepEqual(result, { state: "invalid", reason: "canary-coding-ledger-receipt-invalid", errorType: "RangeError" });
  const report = observer.report(true);
  assert.deepEqual(report.invalidErrorTypes, ["RangeError"]);
  assert.equal(report.invalid, 1); assert.equal(report.state, "observed-partial");
  assert.ok(!JSON.stringify({ result, report }).includes("MUST-NOT-RETAIN"));
});

test("coding receipt byte ceilings reject invalid limits and keep the fixed maximum", () => {
  const { codingRunReceipt } = requiredCodingLedger();
  const input = measuredCodingRun();
  for (const max of [0, -1, 1.5, NaN, Infinity, 65_537])
    assert.throws(() => codingRunReceipt(input, max), /byte-bound-invalid/);
  const normalized = codingRunReceipt(input);
  assert.deepEqual(codingRunReceipt(input, Buffer.byteLength(JSON.stringify(normalized), "utf8")), normalized);
  assert.throws(() => codingRunReceipt({ ...input, caseId: "undeclared-case" }), /contract-invalid/);
});
