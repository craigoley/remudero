import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { fixedClock } from "#src/lib/clock.js";
import { runGardenerOverseer } from "#src/lib/gardener-overseer.js";
import { classifyReviewOutcome, reviewReplayLedgerFields, type ReviewReplayInput } from "#src/lib/review-outcome-class.js";
import { deriveReviewReplaySample, REVIEW_REPLAY_SAMPLE_PATH, serializeReviewReplaySample } from "#src/lib/review-replay-sample.js";
import { emptyReviewerHealthState, loadedReviewerCodeSha, reviewerHealthStatePath, saveReviewerHealthState } from "#src/lib/reviewer-health.js";
import { runRegisteredGardenPass, type GardenBuildContext } from "#src/run-task.js";
import { gitRepo } from "#test/helpers/git-repo.js";

function context(root: string, rows: Record<string, unknown>[], now: number): GardenBuildContext {
  return { config: { claudeBin: "/bin/true", root } as GardenBuildContext["config"], repoRoot: root, owner: "acme", repo: "remudero",
    log: (step, fields) => rows.push({ ts: new Date(now).toISOString(), step, ...fields }),
    raiseDuplicate: () => { throw new Error("this fixture must perform no external effect"); } };
}

test("a handled garden inventory failure exits nonzero and cannot clear overseer health", async t => {
  const repo = gitRepo({ scope: t }), now = Date.now(), rows: Record<string, unknown>[] = [];
  mkdirSync(join(repo.dir, "state"));
  const exit = await runRegisteredGardenPass("review-replay", [], context(repo.dir, rows, now));
  assert.ok(rows.some(row => row.step === "review-replay.gardener_failed"));
  assert.equal(exit, 1);
  rows.push({ step: "garden.pass", name: "review-replay", exit, ts: new Date(now + 1).toISOString() });
  const observed: Record<string, unknown>[] = [];
  runGardenerOverseer({ stateDir: join(repo.dir, "state"), clock: fixedClock(now + 1), readRows: () => rows,
    registeredGardenNames: () => ["review-replay"], stateMtime: () => undefined,
    log: (step, fields) => observed.push({ step, ...fields }),
    escalate: () => { throw new Error("first notice is not an escalation"); } });
  assert.ok(observed.some(row => row.step === "gardener_overseer.noticed" && row.gardener === "review-replay" && row.kind === "failure"));
});

test("a healthy garden with an unchanged replay sample still exits zero", async t => {
  const repo = gitRepo({ scope: t }), now = Date.now(), rows: Record<string, unknown>[] = [];
  const stateDir = join(repo.dir, "state"), ts = new Date(now).toISOString();
  mkdirSync(stateDir);
  const input: ReviewReplayInput = { stage: "semantic", plan_only: false, required_semantic: true, criteria_count: 1,
    risk_present: true, budget_present: true, untasked: false, head_task_resolved: true, own_task_record_missing: false,
    reviewer_outcome: "success", verdict_lines: ["REVIEW_VERDICT 1: PASS"] };
  const row = { ts, step: "review.replay_input", run_id: "fixture-review", ...reviewReplayLedgerFields(input,
    classifyReviewOutcome(input), { pr_url: "https://github.com/acme/remudero/pull/1", head_sha: "e".repeat(40), reviewer_code_sha: "f".repeat(40) }) };
  writeFileSync(join(stateDir, `ledger.${ts.replace(/[.:]/g, "-")}.ndjson.gz`), gzipSync(JSON.stringify(row) + "\n"));
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  const health = emptyReviewerHealthState(); health.seededAt = ts; health.cursor = { liveOffset: 0 };
  saveReviewerHealthState(reviewerHealthStatePath(stateDir), health);
  const sample = deriveReviewReplaySample([row], { generatorRevision: loadedReviewerCodeSha()! });
  const samplePath = join(repo.dir, REVIEW_REPLAY_SAMPLE_PATH);
  mkdirSync(join(repo.dir, "test/fixtures/review-replay"), { recursive: true });
  writeFileSync(samplePath, serializeReviewReplaySample(sample));
  assert.equal(await runRegisteredGardenPass("review-replay", [], context(repo.dir, rows, now)), 0);
  assert.equal(rows.some(row => row.step === "review-replay.gardener_failed"), false);
});

test("a stopped garden pass remains a successful no-op", async t => {
  const repo = gitRepo({ scope: t }), rows: Record<string, unknown>[] = [];
  assert.equal(await runRegisteredGardenPass("review-replay", [], context(repo.dir, rows, Date.now()), { stopped: true }), 0);
  assert.deepEqual(rows, []);
});
