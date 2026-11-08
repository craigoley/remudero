import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { extractReviewFindings, recordReviewFindings } from "#src/lib/review-findings.js";
import { deriveReviewFindingOutcomes, type FindingFlowRow } from "#src/lib/review-finding-outcomes.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const prUrl = "https://github.com/acme/remudero/pull/1";
const base = { owner: "acme", repo: "remudero", prUrl, criteriaCount: 1 };
const line = "export const changed = true;";
const text = (path: string, n: number) => `REVIEW_FINDING ${JSON.stringify({ criterion: 1, category: "wiring", severity: "medium",
  mechanism: "The new producer does not reach the consumer", remedy: null, anchor: { path, line: n, kind: "changed" } })}`;
const diffAt = (n: number) => `diff --git a/src/changed.ts b/src/changed.ts\n+++ b/src/changed.ts\n@@ -0,0 +1,${n} @@\n${"+\n".repeat(n - 1)}+${line}\n`;
const provenance = { provider: "codex", requestedModel: "reviewer", servedModel: "model-a", effort: "high", sessionId: "s" };

const flow = (step: string, ts: string, headSha: string, extra: Partial<FindingFlowRow> = {}): FindingFlowRow => ({
  fingerprint: `${step}-${ts}`, ts, step, prRepo: "acme/remudero", prNumber: 1, headSha, runId: null, servedModel: "model-a",
  reviewModel: "model-a", findingId: null, lineageKey: null, findingCategory: null, findingAnchorStatus: null, findingCaptureState: "captured",
  findingInvalidCount: 0, findingDroppedCount: 0, findingVerifiedCount: 1, findingUnverifiedCount: 0, costUsd: null, billingMode: null, ...extra,
});
const received = (ts: string, headSha: string, id: string, lineageKey: string | null) =>
  flow("review.finding", ts, headSha, { findingId: id, lineageKey, findingCategory: "wiring", findingAnchorStatus: "verified" });
const posted = (ts: string, headSha: string) => flow("review.posted", ts, headSha);

function receipts(root: string, headSha: string, n: number) {
  const capture = extractReviewFindings({ ...base, root, headSha, diff: diffAt(n), text: text("src/changed.ts", n) });
  const rows: Array<Record<string, unknown>> = [];
  recordReviewFindings(capture, { taskId: "W1-T9649", prUrl, headSha, decisionDigest: "d", provenance, log: (step, row) => rows.push({ step, ...row }) });
  assert.equal(capture.verifiedCount, 1);
  return { finding: capture.findings[0]!, receipt: rows[0]! };
}

test("W1-T9649: a finding raised again at a later head on a moved line is persisted", () => {
  const repo = gitRepo({ kind: "review-finding-lineage" });
  try {
    mkdirSync(join(repo.dir, "src"));
    writeFileSync(join(repo.dir, "src", "changed.ts"), `${line}\n`);
    repo.git("add", ".");
    repo.git("commit", "-qm", "round one");
    const one = receipts(repo.dir, repo.git("rev-parse", "HEAD"), 1);
    writeFileSync(join(repo.dir, "src", "changed.ts"), `\n${line}\n`);
    repo.git("commit", "-qam", "round two: the line moved");
    const headTwo = repo.git("rev-parse", "HEAD");
    const two = receipts(repo.dir, headTwo, 2);
    assert.notEqual(one.finding.id, two.finding.id, "the id still hashes the head and line");
    assert.equal(one.receipt.lineage_key, one.finding.lineageKey, "the receipt carries the lineage key");
    assert.equal(one.finding.lineageKey, two.finding.lineageKey, "a moved line keeps its lineage key");

    const headOne = String(one.receipt.head_sha);
    const report = deriveReviewFindingOutcomes([
      posted("2026-10-01T00:00:00Z", headOne), received("2026-10-01T00:00:01Z", headOne, one.finding.id, String(one.receipt.lineage_key)),
      posted("2026-10-01T01:00:00Z", headTwo), received("2026-10-01T01:00:01Z", headTwo, two.finding.id, String(two.receipt.lineage_key)),
    ]);
    assert.equal(report.findings.find((item) => item.findingId === one.finding.id)?.outcome, "persisted");
    assert.equal(report.cells[0]?.persisted, 1);
    assert.equal(report.cells[0]?.notReRaised, 0);
  } finally {
    repo.cleanup();
  }
});

test("W1-T9649: a finding no later head raises is not re-raised and repairs are unchanged", () => {
  const rows = [
    posted("2026-10-01T00:00:00Z", "a".repeat(40)),
    received("2026-10-01T00:00:01Z", "a".repeat(40), "gone", "key-gone"),
    received("2026-10-01T00:00:02Z", "a".repeat(40), "repaired", "key-repaired"),
    received("2026-10-01T00:00:03Z", "a".repeat(40), "legacy", null),
    posted("2026-10-01T01:00:00Z", "b".repeat(40)),
    received("2026-10-01T01:00:01Z", "b".repeat(40), "other", "key-other"),
    received("2026-10-01T01:00:02Z", "b".repeat(40), "latest", "key-latest"),
  ];
  const repair = { findingId: "repaired", prUrl, headSha: "a".repeat(40), kind: "mechanism-falsifier" as const,
    provenance: "case-file:1", observedAt: "2026-10-01T00:30:00Z", beforeFails: true, afterPasses: true, mechanismMatched: true };
  const report = deriveReviewFindingOutcomes(rows, [repair]);
  const outcome = (id: string) => report.findings.find((item) => item.findingId === id)?.outcome;
  assert.equal(outcome("gone"), "not-re-raised");
  assert.equal(outcome("repaired"), "confirmed-repair", "evidence-based outcomes win over lineage");
  assert.equal(outcome("legacy"), "unknown", "a receipt without a lineage key cannot be told apart");
  assert.equal(outcome("latest"), "unknown", "no later reviewed head exists yet");
  const cell = report.cells[0]!;
  assert.equal(cell.notReRaised, 1, "only the finding that no later head raised");
  assert.equal(cell.persisted, 0);
  assert.equal(cell.confirmedUseful, 1);
  assert.equal(cell.unknown, 3);
});
