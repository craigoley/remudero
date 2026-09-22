import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claimReviewDecision, reviewDecisionDigest } from "../src/lib/review.js";
import {
  reviewLedgerReasonFields,
  reviewVerdictAnnotation,
  runReview,
} from "../src/run-task.js";

const HEAD_SHA = "abc1234def5678";
const PR_URL = "https://github.com/acme/remudero/pull/1";
const DIFF = "diff --git a/README.md b/README.md";

function writeGhStub(binDir: string): void {
  writeFileSync(
    join(binDir, "gh"),
    `#!/bin/sh
case "$1 $2" in
  "api "*)
    case "$*" in
      *pulls/*) echo '{"number":1,"html_url":"${PR_URL}","updated_at":"t","body":"","head":{"ref":"run-W1-T3365-1790054788234","sha":"${HEAD_SHA}"}}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr diff") printf '%s' '${DIFF}' ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
}

test("a held verdict's description names the in-flight decision", () => {
  const annotation = reviewVerdictAnnotation({ keywordOnly: true, decisionDisposition: "in_flight" });

  assert.equal(annotation, "HELD: identical review decision is already in flight");
  assert.doesNotMatch(annotation, /no PR-head checkout/);
});

test("a materialization failure still reports the absent checkout", () => {
  const annotation = reviewVerdictAnnotation({ keywordOnly: true, decisionDisposition: "computed" });

  assert.equal(annotation, "KEYWORD-ONLY: no proof was executed (no PR-head checkout)");
});

test("the two causes carry different ledger reasons", async () => {
  const held = reviewLedgerReasonFields({ decisionDisposition: "in_flight" });
  const materializationFailure = reviewLedgerReasonFields({
    decisionDisposition: "computed",
    materializationFailure: { errorClass: "fetch-failure", message: "head fetch failed" },
  });

  assert.equal(held.review_reason, "decision_in_flight");
  assert.equal(held.review_reason_detail, "identical review decision is already in flight");
  assert.equal(materializationFailure.review_reason, "materialization_failure");
  assert.notEqual(held.review_reason, materializationFailure.review_reason);
  assert.equal(materializationFailure.degraded_reason, "head fetch failed");
  assert.equal(materializationFailure.degraded_reason_class, "fetch-failure");

  const root = mkdtempSync(join(tmpdir(), "rmd-held-review-"));
  const binDir = mkdtempSync(join(tmpdir(), "rmd-held-review-bin-"));
  const oldPath = process.env.PATH;
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeGhStub(binDir);
  process.env.PATH = `${binDir}:${oldPath}`;
  const claim = await claimReviewDecision({
    ledgerPath,
    taskId: "W1-T3365",
    prUrl: PR_URL,
    digest: reviewDecisionDigest({ headSha: HEAD_SHA, diff: DIFF, report: "", body: "", acceptance: [] }),
  });
  assert.equal(claim.kind, "owned");
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  try {
    const verdict = await runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: PR_URL,
      task: { id: "W1-T3365", acceptance: [] },
      report: "",
      settingsFile: "",
      config: { root } as never,
      log: (step, extra = {}) => lines.push({ step, extra }),
      say: () => {},
      account: (result) => result,
      spawnReviewer: false,
      disarm: () => "not-armed" as const,
      ledgerPath,
      runId: "held-review-test",
    });
    assert.equal(verdict.decisionDisposition, "in_flight");
    const stoodDown = lines.find((line) => line.step === "review.stood_down");
    assert.ok(stoodDown, "the held branch must write a ledger row");
    assert.equal(stoodDown.extra.review_reason, held.review_reason);
    assert.equal(stoodDown.extra.review_reason_detail, held.review_reason_detail);
  } finally {
    if (claim.kind === "owned") claim.release();
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});
