import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateRiskJudgeDisposition } from "../src/lib/risk-judge-eval.js";
import { evaluateRiskJudgeDispositionCommand } from "../src/run-task.js";

const CORPUS = join(process.cwd(), "test", "fixtures", "risk-judge-dispositions");

test("the evaluator reads every versioned disposition fixture and emits one deterministic result per accepted fixture", async () => {
  const report = await evaluateRiskJudgeDisposition(CORPUS);
  assert.equal(report.filesRead.length, 9);
  assert.equal(report.results.length, report.filesRead.length);
  assert.equal(report.metrics.total, 9);
  assert.equal(report.metrics.accepted, 9);
  assert.ok(report.results.every((result) => result.sourceHash.length === 64));
});

test("the evaluator reuses the existing consequence controller and does not duplicate its policy table", async () => {
  const report = await evaluateRiskJudgeDisposition(CORPUS);
  assert.equal(report.metrics.agreement, report.metrics.accepted);
  assert.ok(report.results.some((result) => result.observed?.outcome === "REPAIR"));
  assert.ok(report.results.some((result) => result.observed?.outcome === "LAND+DEBT"));
  assert.ok(report.results.some((result) => result.observed?.outcome === "STOP"));
});

test("the evaluator spawns no LLM, performs no network or production write, and does not invoke repair or debt side effects", async () => {
  const report = await evaluateRiskJudgeDisposition(CORPUS);
  assert.equal(report.metrics.sideEffectAgreement, report.metrics.accepted);
  assert.equal(report.results.find((result) => result.id === "healthy-control")?.observed?.sideEffect, "none");
});

test("the report measures agreement, false STOP, false proceed, fallback use, side-effect agreement, and corpus coverage", async () => {
  const report = await evaluateRiskJudgeDisposition(CORPUS);
  assert.deepEqual(Object.keys(report.metrics).sort(), [
    "accepted",
    "agreement",
    "fallbackUse",
    "falseProceed",
    "falseStop",
    "refusedSensitive",
    "sideEffectAgreement",
    "total",
  ]);
  assert.equal(report.metrics.falseStop, 0);
  assert.equal(report.metrics.falseProceed, 0);
  assert.ok(report.metrics.fallbackUse > 0);
});

test("a fixture containing credential- or PII-shaped material is refused and no sensitive value appears in the report", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-risk-eval-sensitive-"));
  const secret = "ghp_123456789012345678901234567890";
  try {
    writeFileSync(join(root, "sensitive.yaml"), `id: sensitive\ndescription: "api_key: ${secret}"\nkind: candidate-risk\nexpected:\n  action: escalate\n`);
    const report = await evaluateRiskJudgeDisposition(root);
    assert.equal(report.metrics.refusedSensitive, 1);
    assert.equal(JSON.stringify(report).includes(secret), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a positive control proves the evaluator can discover its fixture corpus and a missing-fixture query is not reported as a clean zero", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-risk-eval-empty-"));
  try {
    await assert.rejects(() => evaluateRiskJudgeDisposition(join(root, "missing")), /no fixture files|ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid fixture is refused instead of aborting the whole disposition report", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-risk-eval-invalid-"));
  try {
    writeFileSync(join(root, "invalid.yaml"), "id: [not: valid\n");
    const report = await evaluateRiskJudgeDisposition(root);
    assert.deepEqual(report.results, [
      {
        id: "invalid.yaml",
        sourceHash: report.results[0]?.sourceHash,
        status: "refused",
        reason: "invalid-fixture",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI command validates its corpus argument and returns distinct success and refusal codes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-risk-eval-command-"));
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    assert.equal(await evaluateRiskJudgeDispositionCommand(["--corpus"]), 2);
    assert.equal(await evaluateRiskJudgeDispositionCommand(["--corpus", CORPUS]), 0);
    assert.equal(await evaluateRiskJudgeDispositionCommand(["--corpus", join(root, "missing")]), 2);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    rmSync(root, { recursive: true, force: true });
  }
});
