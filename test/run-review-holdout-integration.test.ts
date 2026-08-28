import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import type { WorkerResult } from "../src/lib/worker.js";

// ── W1-T166 (end-to-end): runReview's POSTING PATH filters holdout criteria out of the
// ledger's `unmet_criteria`/PR-comment display and writes the `reward_hacking_gap` field,
// while the FAIL decision still counts the holdout. The posting tail (visibleCriteria filter,
// the reward_hacking_gap ledger field, the failure-comment body) had no coverage because the
// whole `runReview` was never exercised — this drives the REAL runReview against a PATH-stubbed
// `gh` (the same technique test/review-status-gate.test.ts uses for execGhStatusPost), with the
// LLM reviewer disabled (`spawnReviewer: false`) so only the deterministic keyword floor runs.

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

/** A `gh` stub that answers the four subcommands runReview drives: pr view (headRefOid + state),
 *  pr diff, api statuses (the status post), and pr comment (the failure comment). */
function writeGhStub(binDir: string): void {
  const script = `#!/bin/sh
case "$1 $2" in
  "api "*)
    # runReview reads the head sha over REST now, not pr view --json headRefOid.
    # Answered in REST's own shape (mapRestPr reads head.sha), same sha as below.
    # No backticks in here: this script sits inside a JS template literal.
    case "$*" in
      *pulls/*) echo '{"number":1,"html_url":"https://github.com/o/r/pull/1","updated_at":"t","body":"","head":{"ref":"b","sha":"abc1234def5678"}}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr view")
    case "$*" in
      *headRefOid*) echo '{"headRefOid":"abc1234def5678"}' ;;
      *state*) echo '{"state":"OPEN"}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr diff") echo "diff --git a/README.md b/README.md" ;;
  "pr comment") exit 0 ;;
  *) exit 0 ;;
esac
`;
  writeFileSync(join(binDir, "gh"), script, { mode: 0o755 });
}

test("runReview (W1-T166 end-to-end): the review.posted ledger filters the holdout claim out of unmet_criteria and carries reward_hacking_gap, while the FAIL still counts the holdout", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-run-review-holdout-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const binDir = mkdtempSync(join(tmpdir(), "rmd-gh-stub-"));
  writeGhStub(binDir);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;

  // One VISIBLE and one HOLDOUT criterion, both worded so the keyword floor cannot substantiate
  // them from the (empty) report -> both judged unmet -> overall FAIL. The holdout must vanish
  // from the DISPLAY (unmet_criteria) while still driving the FAIL; the visible one must remain.
  const acceptance: AcceptanceCriterion[] = [
    { claim: "VISIBLE-CLAIM-TOKEN the observable surface behaves", proof: "unit test: never-matches-VISIBLE" },
    { claim: "HOLDOUT-CLAIM-TOKEN the hidden reward-hack guard holds", proof: "unit test: never-matches-HOLDOUT", holdout: true },
  ];
  const config: Config = { claudeBin: "/bin/true", root };
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];

  try {
    const verdict = await runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: "https://github.com/acme/remudero/pull/1",
      task: { id: "W1-T166", acceptance },
      report: "", // substantiates nothing -> the keyword floor leaves every criterion unmet
      settingsFile: join(root, "settings.json"), // unused: spawnReviewer is false
      config,
      log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
      say: () => {},
      account: (r: WorkerResult) => r,
      spawnReviewer: false,
      reviewerMount: MOUNT,
      // no headCheckoutDir -> the floor is keyword-only (no proof execution)
      ledgerPath,
      runId: "REVIEW-TEST-1",
      // W1-T2347: this verdict fails (both criteria unmet), so withdrawArmIfVerdictRefuses
      // reaches its `disarm` fallback — supplied so it never falls through to the real
      // disarmAutoMerge default, which this fixture has nothing to do with.
      disarm: () => "not-armed" as const,
    });

    assert.equal(verdict.state, "failure", "an unmet visible+holdout set fails overall");

    const posted = lines.find((l) => l.step === "review.posted");
    assert.ok(posted, "runReview writes a review.posted ledger line");

    const unmet = posted.extra.unmet_criteria as string[];
    assert.ok(
      unmet.some((c) => c.includes("VISIBLE-CLAIM-TOKEN")),
      "the visible unmet criterion is displayed in the ledger",
    );
    assert.ok(
      !unmet.some((c) => c.includes("HOLDOUT-CLAIM-TOKEN")),
      "the HOLDOUT criterion is filtered OUT of the displayed unmet_criteria (visibleCriteria)",
    );

    assert.ok(
      Object.prototype.hasOwnProperty.call(posted.extra, "reward_hacking_gap"),
      "the review.posted line carries the reward_hacking_gap field",
    );
    assert.notEqual(
      posted.extra.reward_hacking_gap,
      undefined,
      "reward_hacking_gap is measurable (a holdout criterion is declared)",
    );
    // Reaching here means the failure-comment path (state != success + a visible unmet criterion)
    // built its body and posted against the stubbed `gh pr comment` without throwing.
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});
