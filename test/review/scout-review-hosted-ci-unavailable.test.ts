import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { reviewHostedCiFileEvidence } from "#src/cli/commands/review.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

test("W1-T12443: review.hosted_ci.unavailable no longer recurs", async t => {
  const headSha = "judged-head";
  const passedFile = "test/passed.test.ts";
  const failedFile = "test/failed.test.ts";
  const name = "coverage-shard (2/8)";
  const logFile = join(ownedFixtureDir(t, "review-hosted-ci-log").dir, "job.log");
  const timestamp = "2026-11-23T00:00:00.000Z ";
  const completed = JSON.stringify({ phase: "completed", file: passedFile });
  writeFileSync(logFile, `${timestamp}RMD-TEST-FILE-DIAGNOSTIC ${completed}\n`);
  // Model a verbose job whose proof evidence straddles the old 64 MiB limit.
  const chunk = `${timestamp}${"x".repeat(999)}\n`.repeat(1024);
  for (let i = 0; i < 65; i++) appendFileSync(logFile, chunk);
  appendFileSync(logFile, `${timestamp}✖ failing tests:\n${timestamp}test at ${failedFile}:3:1`);

  const check = { id: 12, name, status: "completed", conclusion: "success",
    details_url: "https://github.com/craigoley/remudero/actions/runs/4/job/7" };
  const rows: Record<string, unknown>[] = [];
  await withGhShim([
    { when: `/commits/${headSha}/check-runs?`, stdout: JSON.stringify({ check_runs: [check] }) },
    { when: `/commits/${headSha}/status`, stdout: '{"statuses":[]}' },
    { when: "actions/jobs/7/logs", stdoutFile: logFile },
    { when: "actions/jobs/7", stdout: JSON.stringify({ head_sha: headSha, name, conclusion: "success" }) },
  ], async () => {
    const evidence = await reviewHostedCiFileEvidence({
      owner: "craigoley", repo: "remudero", headSha,
      criteria: [passedFile, failedFile].map(file => ({ claim: file, proof: `unit test: ${file}` })),
      log: (step, extra) => rows.push({ step, ...extra }),
    });
    assert.deepEqual(evidence, new Map([[passedFile, "passed"], [failedFile, "failed"]]), JSON.stringify(rows));
    assert.deepEqual(rows, []);
  });
});
