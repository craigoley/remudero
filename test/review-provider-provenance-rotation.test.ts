import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  appendLedger,
  DECISION_RELEVANT_LEDGER_STEPS,
  ledgerExceedsRotationCeiling,
  rotateLedger,
  type LedgerLine,
} from "../src/lib/ledger.js";
import { resolveReviewProviderProvenance } from "../src/lib/review-provider-provenance.js";
import { readLedgerLines } from "../src/lib/status.js";

test("W1-T2594: rotation retains the exact-head producer row needed by reviewer routing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-provider-rotation-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const key = {
    taskId: "W1-T2594",
    prUrl: "https://github.com/craigoley/remudero/pull/99",
    headSha: "abcdef0123456789",
  };
  try {
    assert.equal(DECISION_RELEVANT_LEDGER_STEPS.has("pr.head_provider"), true);
    appendLedger(
      ledgerPath,
      {
        run_id: "producer-run",
        task_id: key.taskId,
        step: "pr.head_provider",
        pr_url: key.prUrl,
        head_sha: key.headSha,
        provider: "codex",
        model: "gpt-5.6-sol",
        source: "implement",
        availability: "known",
      } as LedgerLine,
      { ceilingBytes: Number.MAX_SAFE_INTEGER },
    );
    const producerBytes = statSync(ledgerPath).size;
    for (let i = 0; i < 100; i++) {
      writeFileSync(
        ledgerPath,
        `${JSON.stringify({ run_id: `noise-${i}`, task_id: "NOISE", step: "ci.polling", detail: "x".repeat(80) })}\n`,
        { flag: "a" },
      );
    }
    const ceilingBytes = producerBytes + 128;
    assert.equal(ledgerExceedsRotationCeiling(ledgerPath, ceilingBytes), true);
    assert.equal(rotateLedger(ledgerPath, { ceilingBytes }).rotated, true);

    assert.deepEqual(resolveReviewProviderProvenance(readLedgerLines(ledgerPath), key), {
      state: "known",
      provider: "codex",
      model: "gpt-5.6-sol",
      source: "implement",
      claimCount: 1,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
