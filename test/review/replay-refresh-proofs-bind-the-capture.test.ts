import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CHECK_PROOF_EXIT } from "#src/lib/check-proof.js";
import { classifyReviewOutcome, reviewReplayLedgerFields, type ReviewReplayInput } from "#src/lib/review-outcome-class.js";
import { deriveReviewReplaySample, REVIEW_REPLAY_SAMPLE_PATH, reviewReplayGardenSpec, serializeReviewReplaySample } from "#src/lib/review-replay-sample.js";
import { parseAcceptanceBlock } from "#src/lib/review.js";
// @ts-expect-error -- the standalone proof-discrimination CLI has no declaration file.
import { evaluateProofDiscrimination, runCheckProof } from "#scripts/proof-discrimination-gate.mjs";
import { gitRepo } from "#test/helpers/git-repo.js";

const input = (extra: Partial<ReviewReplayInput> = {}): ReviewReplayInput => ({ stage: "semantic", plan_only: false,
  required_semantic: true, criteria_count: 1, risk_present: true, budget_present: true, untasked: false,
  head_task_resolved: true, own_task_record_missing: false, reviewer_outcome: "success", verdict_lines: ["REVIEW_VERDICT 1: PASS"], ...extra });
const row = (i: ReviewReplayInput, ts: string, run: string) => ({ ts, step: "review.replay_input", run_id: run,
  ...reviewReplayLedgerFields(i, classifyReviewOutcome(i), { pr_url: "https://github.com/acme/remudero/pull/1",
    head_sha: "e".repeat(40), reviewer_code_sha: "f".repeat(40) }) });

test("generated refresh proofs discriminate the exact capture and retain replay validation", async t => {
  for (const metadataOnly of [true, false]) await t.test(metadataOnly ? "window-only capture" : "new input capture", t => {
    const repo = gitRepo({ scope: t }), now = Date.now();
    const at = new Date(now - 2_000).toISOString(), later = new Date(now - 1_000).toISOString();
    const rows = [row(input(), at, "pass"), row(input({ verdict_lines: [] }), at, "withheld"),
      row(input({ stage: "setup", setup_unavailable: true }), at, "refused")];
    const revision = "revision.[literal]*^$\\quoted'";
    const oldSample = deriveReviewReplaySample(rows, { generatorRevision: revision });
    const newSample = deriveReviewReplaySample([...rows, row(metadataOnly ? input() :
      input({ criteria_count: 2, verdict_lines: ["REVIEW_VERDICT 1: PASS", "REVIEW_VERDICT 2: PASS"] }), later, "new")], { generatorRevision: revision });
    assert.equal(oldSample.header.digest === newSample.header.digest, metadataOnly);
    const path = join(repo.dir, REVIEW_REPLAY_SAMPLE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serializeReviewReplaySample(oldSample));
    repo.git("add", REVIEW_REPLAY_SAMPLE_PATH); repo.git("commit", "--quiet", "-m", "test: seed replay capture");
    const base = repo.git("rev-parse", "HEAD").trim();
    const spec = reviewReplayGardenSpec({ repoRoot: repo.dir, stateDir: join(repo.dir, "state"), log: () => {},
      openWorkspace: () => { throw new Error("no external workspace is requested"); } }, () => revision);
    const content = serializeReviewReplaySample(newSample);
    const landing = spec.apply({ root: repo.dir, branch: "fixture", land: () => { throw new Error("no publication is requested"); }, dispose: () => {} },
      { actions: [{ class: "refresh", target: REVIEW_REPLAY_SAMPLE_PATH, reason: "new recorded inputs", content }], acting: ["refresh"] }, {})!;
    assert.deepEqual(landing.paths, [REVIEW_REPLAY_SAMPLE_PATH]);
    assert.equal(readFileSync(path, "utf8"), content);
    const criteria = parseAcceptanceBlock(landing.body);
    assert.equal(criteria.length, 1);
    assert.equal(criteria[0]!.claim, "the refreshed capture header is present");
    assert.match(landing.body, /Validation: unit test: test\/review\/a-review-path-change-replays-recorded-reviews\.test\.ts/);
    repo.git("add", REVIEW_REPLAY_SAMPLE_PATH); repo.git("commit", "--quiet", "-m", "test: refresh replay capture");
    const result = evaluateProofDiscrimination(criteria, base, (proof: string) => {
      assert.ok(proof.startsWith("grep:"), "the refresh criterion executes the real capture proof");
      const result = runCheckProof(proof, base, { root: repo.dir });
      assert.equal(result.status, CHECK_PROOF_EXIT.pass, result.stdout + result.stderr);
      assert.match(result.stdout, /^hits:\s*1$/m);
      assert.match(result.stdout, /^base hits:\s*0$/m);
      return result;
    });
    assert.equal(result.executed, 1);
    assert.equal(result.guarded, 0);
    assert.deepEqual(result.stale, []);
    assert.deepEqual(result.unreadable, []);
  });
});
