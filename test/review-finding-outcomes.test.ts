import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deriveReviewFindingOutcomes, type VerifiedFindingEvidence } from "../src/lib/review-finding-outcomes.js";
import { buildFieldTrialsFlowSnapshot, buildFieldTrialsRelease, projectFlowRow, readFieldTrialsLedger, type FieldTrialsSource } from "../src/lib/field-trials-flow.js";
import { emptyRepoStore } from "../src/lib/field-trials-github.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const at = "2026-09-30T00:00:00Z";
const pr = "https://github.com/acme/core/pull/1";
const head = "a".repeat(40);
const row = (step: string, extra: Record<string, unknown>, n: number) => projectFlowRow({
  step, ts: at, task_id: "W1-T1", pr_url: pr, head_sha: head, ...extra,
}, `row-${n}`);
const posted = row("review.posted", { finding_capture_state: "captured", finding_invalid_count: 0,
  finding_dropped_count: 0, finding_verified_count: 1, finding_unverified_count: 0,
  evaluator_provenance: { servedModel: "model-a" } }, 1);
const finding = row("review.finding", { finding_id: "finding-1", category: "wiring", capture_state: "verified",
  served_model: "model-a" }, 2);
const repair: VerifiedFindingEvidence = { findingId: "finding-1", prUrl: pr, headSha: head,
  kind: "mechanism-falsifier", provenance: "case-file:1", observedAt: at,
  beforeFails: true, afterPasses: true, mechanismMatched: true };

test("W1-T4849: a resolved thread is not a correct finding", () => {
  const activity = row("review.thread", { action: "resolved" }, 3);
  const noProof = deriveReviewFindingOutcomes([posted, finding, activity], []);
  assert.equal(noProof.findings[0]?.outcome, "unknown");
  assert.equal(noProof.cells[0]?.confirmedUseful, 0);
  const withProof = deriveReviewFindingOutcomes([posted, finding, activity], [repair]);
  assert.equal(withProof.findings[0]?.outcome, "confirmed-repair");
  assert.equal(withProof.cells[0]?.confirmedUseful, 1);
  const disputed = deriveReviewFindingOutcomes([posted, finding], [repair, { ...repair, kind: "human-rejection",
    provenance: "github-verified:human-1", reason: "falsifier tests a different mechanism" }]);
  assert.equal(disputed.findings[0]?.outcome, "conflicting");
  assert.equal(disputed.cells[0]?.confirmedUseful, 0);
});

test("W1-T4849: unsupported reviewer winners remain unknown", () => {
  const missing = row("review.posted", { finding_capture_state: "unavailable", evaluator_provenance: { servedModel: "model-a" },
    pr_url: "https://github.com/acme/core/pull/2" }, 4);
  const unsupported = row("review.finding", { finding_id: "finding-2", category: "wiring", capture_state: "unsupported",
    served_model: "model-a" }, 5);
  const result = deriveReviewFindingOutcomes([posted, finding, missing, unsupported], [
    { ...repair, findingId: "absent" }, { ...repair, findingId: "finding-2", headSha: "b".repeat(40) },
  ]);
  const cell = result.cells.find((candidate) => candidate.category === "wiring")!;
  assert.equal(cell.reviewedPrs, 2);
  assert.equal(cell.unknown, 2);
  assert.equal(cell.unmatchableEvidence, 2);
  assert.equal(cell.captureMissingPrs, 1);
  assert.equal(cell.missingReceiptCount, 0);
  assert.equal(cell.knownIssueRecall, null);
  assert.equal(cell.cashCostUsd, null);
  assert.equal(cell.notionalCostUsd, null);
  assert.equal(cell.winnerClaim, "unsupported");
});

test("a declared finding whose receipt write failed remains missing, and reviewer cash stays separate from subscription notional", () => {
  const cash = row("review.reviewer", { run_id: "cash-run", cost_usd: 0.4, billing_mode: "api" }, 9);
  const cashReview = row("review.posted", { run_id: "cash-run", finding_capture_state: "captured", finding_verified_count: 2, finding_unverified_count: 0,
    evaluator_provenance: { servedModel: "model-a" } }, 10);
  const notional = row("review.reviewer", { run_id: "sub-run", cost_usd: 1.2, billing_mode: "subscription" }, 11);
  const subReview = row("review.posted", { run_id: "sub-run", finding_capture_state: "zero", finding_verified_count: 0,
    pr_url: "https://github.com/acme/core/pull/2", evaluator_provenance: { servedModel: "model-a" } }, 12);
  const result = deriveReviewFindingOutcomes([cash, cashReview, notional, subReview, finding]);
  const cell = result.cells[0]!;
  assert.equal(cell.missingReceiptCount, 1);
  assert.equal(cell.captureMissingPrs, 1);
  assert.equal(cell.cashCostUsd, 0.4);
  assert.equal(cell.notionalCostUsd, 1.2);
  assert.equal(cell.costMissingReviews, 0);
});

test("W1-T4849: field trials reads finding outcomes without gating", () => {
  const source: FieldTrialsSource = { label: "core", repo: "acme/core", ledger: { state: "observed", reason: null,
    forms: { gzip: 0, plain: 0, live: 1 }, malformedRows: 0, duplicateRows: 0, futureRows: 0,
    unreadSources: 0, newestTs: at, rows: [posted, finding] } };
  const snapshot = buildFieldTrialsFlowSnapshot({ asOf: at, sources: [source],
    github: { version: "field-trials-github-v1", repos: { "acme/core": emptyRepoStore() } } });
  assert.equal(snapshot.reviewFindingOutcomes.cells[0]?.unknown, 1);
  assert.equal(snapshot.reviewFindingOutcomes.cells[0]?.winnerClaim, "unsupported");
  assert.ok(!JSON.stringify(snapshot.reviewFindingOutcomes).includes("mechanism"));
  const released = buildFieldTrialsRelease(snapshot, { version: "field-trials-consent-v1",
    repos: [{ repo: "acme/core", rights: "aggregate-opt-in", receipt: "operator-opt-in" }] }, "test-salt");
  assert.equal(released.state, "candidate");
  assert.ok(!JSON.stringify(released).includes("finding-1"), "private finding ids never enter the publication path");
  assert.ok(!JSON.stringify(released).includes("reviewFindingOutcomes"), "finding quality is not released without a reviewed contract");
});

test("the three-form ledger reader retains finding receipts but not finding prose", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}finding-outcomes-`));
  try {
    writeFileSync(join(stateDir, "ledger.ndjson"), [
      { step: "review.posted", ts: at, task_id: "W1-T1", pr_url: pr, head_sha: head,
        finding_capture_state: "captured", finding_verified_count: 1, finding_unverified_count: 0,
        evaluator_provenance: { servedModel: "model-a" } },
      { step: "review.finding", ts: at, task_id: "W1-T1", pr_url: pr, head_sha: head,
        finding_id: "finding-1", category: "wiring", capture_state: "verified", served_model: "model-a",
        mechanism: "private diagnosis text", remedy: "private repair text" },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const read = await readFieldTrialsLedger(stateDir, Date.parse(at));
    assert.equal(read.state, "observed");
    assert.deepEqual(read.rows.map((value) => value.step), ["review.posted", "review.finding"]);
    assert.equal(read.rows[1]?.findingId, "finding-1");
    assert.ok(!JSON.stringify(read.rows).includes("private diagnosis text"));
    assert.equal(deriveReviewFindingOutcomes(read.rows).findings[0]?.outcome, "unknown");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
