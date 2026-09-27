// @source-text-subject: the second test checks the workflow reporter's own job-id field and API payload.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { readFileSync } from "node:fs";
import { checkJobId } from "../src/lib/sweep.js";
import { buildOpenPrViews, buildSweepEffects, cancelledRequiredChecks, fetchCiFailures, fetchOpenPrsWithPostedIds } from "../src/run-task.js";

const OWNER = "owner";
const REPO = "repo";
const SHA = "abc123";
const POSTED = {
  name: "leak-grep",
  status: "completed",
  conclusion: "failure",
  details_url: "https://github.com/owner/repo/runs/900",
  external_id: "job:12345",
  started_at: "2026-09-27T06:00:00Z",
};

test("W1-T4438: a posted gate's job id is read from external_id", () => {
  const urls: string[] = [];
  const prs = fetchOpenPrsWithPostedIds(OWNER, REPO, (args) => {
    const url = args[1];
    urls.push(url);
    if (url.includes("/pulls?")) return [{ number: 1, html_url: "https://github.com/owner/repo/pull/1", updated_at: POSTED.started_at, head: { ref: "fix", sha: SHA } }];
    if (url.includes("/check-runs?")) return { check_runs: [POSTED] };
    if (url.endsWith("/status")) return { statuses: [] };
    throw new Error(`unexpected read: ${url}`);
  });
  assert.equal(urls.length, 3);
  const check = prs[0].statusCheckRollup?.[0];
  assert.equal(check?.detailsUrl, POSTED.details_url);
  assert.equal((check as typeof check & { externalId?: string })?.externalId, POSTED.external_id);
  assert.equal(checkJobId(check ?? {}), "12345");
  const failures = fetchCiFailures(OWNER, REPO, prs[0].statusCheckRollup, 60, {
    fetchAnnotations: () => [],
    fetchJobLog: (_owner, _repo, jobId) => `failed job ${jobId}`,
  });
  assert.equal(failures[0].jobId, "12345");
  assert.match(failures[0].logTail, /failed job 12345/);
  assert.equal(cancelledRequiredChecks([{ ...check, conclusion: "CANCELLED" }], ["leak-grep"])[0].jobId, "12345");
  assert.equal(checkJobId({ detailsUrl: "https://github.com/owner/repo/runs/900", externalId: "check:900" }), undefined);
  assert.equal(checkJobId({ detailsUrl: "https://github.com/owner/repo/actions/runs/1/job/55", externalId: "job:12345" }), "55");

  const root = mkdtempSync(join(tmpdir(), "rmd-posted-gate-view-"));
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const views = buildOpenPrViews(OWNER, REPO, ledgerPath, {
    fetch: (args) => {
      const url = args[1];
      if (url.includes("/pulls?")) return [{ number: 1, html_url: "https://github.com/owner/repo/pull/1", updated_at: POSTED.started_at, head: { ref: "fix", sha: SHA } }];
      if (url.includes("/check-runs?")) return { check_runs: [POSTED] };
      if (url.endsWith("/status")) return { statuses: [] };
      return [];
    },
    requiredContexts: () => [POSTED.name],
    fetchCiFailureEvidence: (_owner, _repo, rollup) => fetchCiFailures(OWNER, REPO, rollup, 60, {
      fetchAnnotations: () => [],
      fetchJobLog: () => "posted gate failed",
    }),
  });
  assert.equal(views[0].ciFailures?.[0].jobId, "12345");
});

test("W1-T4438: a re-drive of a failed posted gate reruns its job", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-posted-gate-"));
  const calls: string[][] = [];
  const effects = buildSweepEffects({
    owner: OWNER,
    repo: REPO,
    config: { root } as never,
    ledgerPath: join(root, "ledger.ndjson"),
    runId: "test",
    plan: {} as never,
    log: () => {},
    readJsonImpl: async (args) => {
      if (args[1].includes("/check-runs?")) return { check_runs: [{ ...POSTED, name: "ci-gate" }] };
      if (args[1].endsWith("/status")) return { statuses: [] };
      throw new Error(`unexpected read: ${args[1]}`);
    },
    ghRunImpl: (_file, args) => { calls.push([...args]); },
  });
  await effects.reaggregateCiGate?.(
    { prNumber: 1, headSha: SHA } as never,
    { siblingName: "leak-grep", siblingStartedAt: POSTED.started_at, jobId: undefined } as never,
  );
  const failedJob = checkJobId({ detailsUrl: POSTED.details_url, externalId: POSTED.external_id });
  assert.equal(effects.requeueCheck?.({ prNumber: 1 } as never, { name: POSTED.name, jobId: failedJob }), true);
  assert.deepEqual(calls, [
    ["api", "-X", "POST", `repos/${OWNER}/${REPO}/actions/jobs/12345/rerun`],
    ["api", "-X", "POST", `repos/${OWNER}/${REPO}/actions/jobs/12345/rerun`],
  ]);
  const workflow = parseYaml(readFileSync(".github/workflows/ci.yml", "utf8")) as { jobs: Record<string, { steps: Array<{ env?: Record<string, string>; run?: string }> }> };
  const reporter = workflow.jobs.commitlint.steps.find((step) => step.run?.includes("report()"));
  assert.equal(reporter?.env?.POSTING_JOB_ID, "${{ job.check_run_id }}");
  assert.match(reporter?.run ?? "", /external_id=job:\$\{POSTING_JOB_ID\}/);
});
