import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T2662: the coverage-ratchet aggregator merges the four shards' lcov into
// coverage/lcov.info and then discards it with the runner. W1-T2661's tier-two reader
// (src/lib/coverage-improvement.ts's fetchMergedCoverageArtifact) needs it as an artifact
// literally named `coverage-merged`, published by the aggregator (`coverage-ratchet-required`,
// display name `coverage-ratchet`) on pull-request runs.
//
// This file is the CI-wiring proof, in the shape of test/coverage-ratchet.test.ts's own
// CI-wiring tests: parse ci.yml as text, slice the one job's body out, assert on that slice.
// It is a NEW file rather than an addition to an existing passing one, per W1-T362 -- a new
// file's assertions can only pass on head, discriminating head from base, where an addition to
// an already-green file could accidentally pass on both.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

async function aggregatorJobBody(): Promise<string> {
  const ciYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const jobStart = ciYml.indexOf("\n  coverage-ratchet-required:");
  assert.notEqual(jobStart, -1, "ci.yml must declare a coverage-ratchet-required job");
  const nextJobStart = ciYml.indexOf("\n  mutation-ratchet:", jobStart);
  assert.notEqual(nextJobStart, -1, "coverage-ratchet-required job body must be findable in ci.yml");
  return ciYml.slice(jobStart, nextJobStart);
}

test("coverage-merged-artifact CI wiring: the aggregator uploads a pinned artifact named coverage-merged", async () => {
  const jobBody = await aggregatorJobBody();
  assert.match(
    jobBody,
    /uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1\r?\n\s*with:\r?\n\s*name: coverage-merged\b/,
    "the aggregator must upload an artifact named coverage-merged, pinned by sha like the shard upload step already is",
  );
});

test("coverage-merged-artifact CI wiring: the upload step textually follows the Coverage ratchet step", async () => {
  const jobBody = await aggregatorJobBody();
  const ratchetIdx = jobBody.indexOf(
    "Coverage ratchet (blocks a PR whose branch coverage is below the absolute floor)",
  );
  assert.notEqual(ratchetIdx, -1, "the Coverage ratchet step must be present in this job");
  const uploadIdx = jobBody.indexOf("name: coverage-merged");
  assert.notEqual(uploadIdx, -1, "the coverage-merged upload step must be present in this job");
  assert.ok(
    uploadIdx > ratchetIdx,
    "the coverage-merged artifact must be staged/uploaded after the Coverage ratchet step, per this task's design",
  );
});

test("coverage-merged-artifact CI wiring: absent coverage/lcov.info stages a skipped marker under the same artifact name", async () => {
  const jobBody = await aggregatorJobBody();
  // A push run (the merge step above skips real work; see its own push guard) or an all-skipped
  // matrix (every shard staged its own `skipped` marker because the fast-lane class was not
  // SOURCE, so nothing was merged) both leave coverage/lcov.info absent here. Staging must fall
  // back to a `skipped` marker so the reader's "no artifact" vs. "skipped" refusals stay
  // distinguishable. This deliberately does NOT reuse the shards' own GITHUB_EVENT_NAME:class
  // marker text: test/push-ci-on-main.test.ts requires every step in THIS job that mentions
  // GITHUB_EVENT_NAME to PR-guard itself as PR-only work, which this step is not (it must
  // produce a marker on a push too).
  assert.match(
    jobBody,
    /if \[ -s coverage\/lcov\.info \]; then\s*\n\s*cp coverage\/lcov\.info coverage-merged-artifact\/lcov\.info\s*\n\s*else\s*\n\s*echo "skipped" > coverage-merged-artifact\/skipped\s*\n\s*fi/,
    "absent coverage/lcov.info must fall back to staging a skipped marker under coverage-merged-artifact/",
  );
  assert.doesNotMatch(
    jobBody.slice(jobBody.indexOf("Stage the merged lcov for the coverage-merged artifact")),
    /GITHUB_EVENT_NAME/,
    "the new staging step must not reference GITHUB_EVENT_NAME (test/push-ci-on-main.test.ts requires any step " +
      "that does to PR-guard itself as PR-only work, which this step is not)",
  );
});

test("coverage-merged-artifact CI wiring: the upload step publishes the staged directory, not a raw file path", async () => {
  const jobBody = await aggregatorJobBody();
  assert.match(
    jobBody,
    /path: coverage-merged-artifact\b/,
    "the upload step must publish the staged coverage-merged-artifact directory (holding either lcov.info or a skipped marker)",
  );
});

test("coverage-merged-artifact CI wiring: the new steps carry no step-level `if:` (the job's own no-conditional-steps invariant)", async () => {
  const jobBody = await aggregatorJobBody();
  const uploadIdx = jobBody.indexOf("name: Upload merged coverage artifact");
  assert.notEqual(uploadIdx, -1, "the upload step must be present");
  const stageIdx = jobBody.indexOf("name: Stage the merged lcov for the coverage-merged artifact");
  assert.notEqual(stageIdx, -1, "the staging step must be present");
  const newStepsBody = jobBody.slice(Math.min(stageIdx, uploadIdx));
  assert.doesNotMatch(
    newStepsBody,
    /\n\s*if:/,
    "no step in coverage-ratchet-required may carry a step-level `if:` (test/fast-lane-classifier.test.ts's acceptance 6)",
  );
});
