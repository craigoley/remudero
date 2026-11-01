import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEP_REVIEW_ENGINE_REVISION, DEP_REVIEW_LEGACY_ENGINE_REVISION, depReviewRowEngineRevision } from "#src/lib/dep-review.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

// #15176: a Docker tag bump escalated under a semver parser that #15539 later fixed. The terminal
// `escalate` was deduped by PR@head alone, so the fixed engine never saw that head again.
const HEAD = "d017fa762ea9a15e51b59f85fd3f15bd2c0a3d92";
const PR_NUMBER = 15176;
const NOW = Date.parse("2026-11-01T12:00:00Z");

function view(): OpenPrView {
  return {
    prNumber: PR_NUMBER, prUrl: `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`, isDependabot: true,
    reviewState: "none", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: "2026-11-01T11:00:00Z", headSha: HEAD, autoMergeArmed: false,
  };
}

async function sweepWith(prior: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}dep-engine-rearm-`));
  try {
    let reviews = 0;
    const deps: SweepDeps = {
      arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
      ledgerPath: join(dir, "ledger.ndjson"), runId: "dep-engine-rearm", now: () => NOW,
      readLedger: () => [{ step: "sweep.disposed", acted: true, pr_number: PR_NUMBER, head_sha: HEAD, disposition: "dep-review", ...prior }],
      depReview: async () => { reviews++; return "arm"; },
    };
    await runSweep([view()], deps);
    const row = readLedgerLines(deps.ledgerPath).find((l) => l.step === "sweep.disposed");
    return { reviews, row };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("dep-review engine rearm: a terminal outcome an older engine decided re-runs the current engine once at the same head", async () => {
  const { reviews, row } = await sweepWith({ dep_review_outcome: "escalate", dep_review_engine_revision: "dep-review-semver-parse-v0" });
  assert.equal(reviews, 1, "the corrected engine is offered the head the old engine escalated");
  assert.equal(row?.acted, true);
  assert.equal(row?.dep_review_engine_revision, DEP_REVIEW_ENGINE_REVISION, "the new decision records the engine that made it");
});

test("dep-review engine rearm: a terminal outcome the CURRENT engine decided still dedups and names that engine", async () => {
  const { reviews, row } = await sweepWith({ dep_review_outcome: "escalate", dep_review_engine_revision: DEP_REVIEW_ENGINE_REVISION });
  assert.equal(reviews, 0);
  assert.equal(row?.acted, false);
  assert.match(String(row?.stand_down_reason), new RegExp(`TERMINAL outcome .* under engine ${DEP_REVIEW_ENGINE_REVISION}`));
});

test("dep-review engine rearm: a row older than the revision field reads as the legacy engine", () => {
  assert.equal(depReviewRowEngineRevision({}), DEP_REVIEW_LEGACY_ENGINE_REVISION);
  assert.equal(depReviewRowEngineRevision({ dep_review_engine_revision: 3 }), DEP_REVIEW_LEGACY_ENGINE_REVISION);
  assert.equal(depReviewRowEngineRevision({ dep_review_engine_revision: "x" }), "x");
});
