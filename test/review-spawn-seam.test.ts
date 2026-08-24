import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import type { WorkerResult, SpawnWorkerArgs } from "../src/lib/worker.js";

// W1-T2205's coverage gap, closed at the seam rather than by disabling the block.
//
// `runReview` is EXPORTED and several tests already drive it — but every one of them passes
// `spawnReviewer: false`, because that DISABLE switch was the only way to avoid a real LLM call.
// The consequence: the reviewer block (its transcript parse, its `review.reviewer` ledger row and
// its subtype handling) had no covering test at all. `spawnReviewerWorker` is the seam that lets
// the block RUN against a fixture worker, so these assertions drive the REAL path instead of a
// stub of it.

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

/** A COMPLETE WorkerResult — the same shape test/body-claim-recognition.test.ts builds. The
 *  reviewer block folds `workerLedgerFields(reviewer)` into its ledger row, which reads the usage
 *  fields, so a partial fixture makes the block throw into its own catch and the test would pass
 *  vacuously against `review.reviewer.error` instead of the row it means to assert. */
function workerResult(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  } as WorkerResult;
}

function writeGhStub(binDir: string): void {
  const script = `#!/bin/sh
case "$1 $2" in
  "api "*)
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

test("runReview: the reviewer spawn is injectable, so the block RUNS and its FAIL verdict downgrades a criterion the floor would have left alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-seam-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const binDir = mkdtempSync(join(tmpdir(), "rmd-gh-stub-seam-"));
  writeGhStub(binDir);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;

  // Worded so the keyword floor cannot substantiate it from the report — the criterion is unmet
  // either way. What this test proves is that the REVIEWER's own FAIL was read: `downgrades` on
  // the `review.reviewer` row is only non-zero when parseReviewerVerdicts saw the transcript.
  const acceptance: AcceptanceCriterion[] = [
    { claim: "SEAM-CLAIM-TOKEN the observable surface behaves", proof: "unit test: never-matches-SEAM" },
  ];
  const config: Config = { claudeBin: "/bin/true", root };
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const seen: SpawnWorkerArgs[] = [];

  try {
    const verdict = await runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: "https://github.com/acme/remudero/pull/1",
      task: { id: "W1-T2205", acceptance },
      report: "",
      settingsFile: join(root, "settings.json"),
      config,
      log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
      say: () => {},
      account: (r: WorkerResult) => r,
      // NOT `spawnReviewer: false` — the block is allowed to run, against this fixture.
      spawnReviewerWorker: async (a: SpawnWorkerArgs): Promise<WorkerResult> => {
        seen.push(a);
        return workerResult({
          text: "REVIEW_VERDICT 1: FAIL",
          blocks: ["the proof names a test that does not exist"],
          sessionId: "sess-seam-1",
        });
      },
      reviewerMount: MOUNT,
      ledgerPath,
      runId: "REVIEW-SEAM-1",
    });

    assert.equal(verdict.state, "failure", "an unmet criterion still fails overall");

    // THE BLOCK RAN: the fixture was called exactly once, and with the MOUNT's values rather than
    // a hardcoded literal — the mount-governed invariant W1-T63/P10 exists to protect.
    assert.equal(seen.length, 1, "the reviewer spawn ran exactly once through the seam");
    assert.equal(seen[0].model, MOUNT.model, "the spawn is mount-governed, not hardcoded");
    assert.equal(seen[0].effort, MOUNT.effort, "effort comes from the resolved reviewer mount");
    assert.equal(seen[0].maxTurns, MOUNT.maxTurns, "max turns come from the resolved reviewer mount");

    // THE TRANSCRIPT WAS PARSED: `downgrades` is derived from parseReviewerVerdicts over the
    // fixture's text+blocks, so a non-zero count can only come from the real parse of a real
    // transcript — the line the coverage gate flagged.
    const reviewer = lines.find((l) => l.step === "review.reviewer");
    assert.ok(reviewer, "the reviewer block writes a review.reviewer ledger line");
    assert.equal(reviewer.extra.downgrades, 1, "the reviewer's FAIL was parsed out of the transcript");
    assert.equal(reviewer.extra.session_id, "sess-seam-1", "the row carries the spawn's own session id");
    assert.equal(reviewer.extra.subtype, "success", "the row carries the spawn's own subtype");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("runReview: with no seam supplied the production default is untouched, and spawnReviewer:false still skips the block entirely", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-seam-off-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const binDir = mkdtempSync(join(tmpdir(), "rmd-gh-stub-seam-off-"));
  writeGhStub(binDir);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  const lines: Array<{ step: string }> = [];
  try {
    await runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: "https://github.com/acme/remudero/pull/1",
      task: { id: "W1-T2205", acceptance: [{ claim: "SEAM-OFF-TOKEN holds", proof: "unit test: never-matches-OFF" }] },
      report: "",
      settingsFile: join(root, "settings.json"),
      config: { claudeBin: "/bin/true", root } as Config,
      log: (step) => lines.push({ step }),
      say: () => {},
      account: (r: WorkerResult) => r,
      spawnReviewer: false, // the existing disable switch, unchanged
      reviewerMount: MOUNT,
      ledgerPath: join(root, "state", "ledger.ndjson"),
      runId: "REVIEW-SEAM-OFF-1",
    });
    // No seam was supplied AND the switch is false: the block must not run, so no reviewer row.
    // This is the falsifier for the test above — without it, an always-skipped block would look
    // identical to a block that ran.
    assert.ok(!lines.some((l) => l.step === "review.reviewer"), "spawnReviewer:false still skips the reviewer block");
  } finally {
    process.env.PATH = oldPath;
  }
});
