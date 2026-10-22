// @source-text-subject: the second test checks the workflow reporter's own job-id field and API payload.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { readFileSync } from "node:fs";
import { ghJson } from "#src/lib/worker.js";
import { ghShim } from "./helpers/gh-shim.js";
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
  assert.equal(reporter?.env?.POSTING_RUN_ID, "${{ github.run_id }}");
  assert.equal(reporter?.env?.POSTING_RUN_ATTEMPT, "${{ github.run_attempt }}");
  assert.match(reporter?.run ?? "", /external_id=run:\$\{POSTING_RUN_ID\}:\$\{POSTING_RUN_ATTEMPT\}:job:\$\{POSTING_JOB_ID\}/);
});


const LINK_HEAD = "6f9313fb89989914f77dcd770b0cc490bb12a0e2";
function linkedChecks() {
  return [
    { id: 119601912896, name: "light-gates", status: "completed", conclusion: "cancelled", head_sha: LINK_HEAD,
      details_url: "https://github.com/owner/repo/actions/runs/39710957377/job/119601912896", started_at: "2026-10-22T02:21:49Z" },
    { id: 119606381286, name: "claims", status: "completed", conclusion: "failure", head_sha: LINK_HEAD,
      details_url: "https://github.com/owner/repo/runs/119606381286", external_id: "run:39710957377:1:job:119601912896",
      started_at: "2026-10-22T02:36:53Z", output: { summary: "W1-T4399: reported by this job's claims step(s) (outcome(s): cancelled)" } },
    { id: 119601900001, name: "claims", status: "completed", conclusion: "skipped", head_sha: LINK_HEAD,
      details_url: "https://github.com/owner/repo/actions/runs/39710957377/job/119601900001", started_at: "2026-10-22T02:21:47Z" },
  ];
}

test("the default REST transport binds cancelled posted claims to exactly one physical producer", () => {
  const shim = ghShim([
    { when: "/pulls?", stdout: JSON.stringify([{ number: 13501, html_url: "https://github.com/owner/repo/pull/13501", head: { ref: "run-unfiled-1", sha: LINK_HEAD }, updated_at: "2026-10-22T02:36:53Z" }]) },
    { when: "/check-runs?", stdout: JSON.stringify({ check_runs: linkedChecks() }) },
    { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
  ], { kind: "cancelled-producer-rest" });
  const originalPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${originalPath}`;
  try {
    const prs = fetchOpenPrsWithPostedIds(OWNER, REPO, ghJson);
    const checks = prs[0].statusCheckRollup;
    const cancelled = cancelledRequiredChecks(checks, ["ci-gate"], LINK_HEAD);
    assert.deepEqual(cancelled, [{ name: "light-gates", jobId: "119601912896", runAttempt: 1, explainedFailures: [{ name: "claims", checkRunId: 119606381286 }] }]);
    assert.equal(checks?.find(c => c.name === "claims")?.conclusion?.toUpperCase(), "FAILURE", "cancellation explanation cannot make merge green");
    assert.equal(shim.calls().length, 3, "the default really shells out for pulls/check-runs/status");
    assert.ok(shim.calls().some(call => call.includes(`/commits/${LINK_HEAD}/check-runs?`)));
  } finally { process.env.PATH = originalPath; }
});

test("posted cancellation evidence refuses wrong or missing heads, jobs, runs, attempts and constituent outcomes", () => {
  const raw = linkedChecks();
  const read = (checks = raw) => fetchOpenPrsWithPostedIds(OWNER, REPO, args => {
    if (args[1].includes("/pulls?")) return [{ number: 13501, html_url: "https://github.com/owner/repo/pull/13501", head: { ref: "run-unfiled-1", sha: LINK_HEAD }, updated_at: "2026-10-22T02:36:53Z" }];
    if (args[1].includes("/check-runs?")) return { check_runs: checks };
    if (args[1].endsWith("/status")) return { statuses: [] };
    throw Error("unexpected fixture route");
  })[0].statusCheckRollup!;
  for (const mutate of [
    (checks: typeof raw) => { checks[0].head_sha = "a".repeat(40); },
    (checks: typeof raw) => { checks[1].head_sha = "a".repeat(40); },
    (checks: typeof raw) => { checks[1].head_sha = ""; },
    (checks: typeof raw) => { checks[1].id = 0; },
    (checks: typeof raw) => { checks[1].details_url = "https://github.com/owner/repo/actions/runs/39710957377/job/9"; },
    (checks: typeof raw) => { checks[0].status = "in_progress"; },
    (checks: typeof raw) => { checks[1].external_id = "job:119601912896"; },
    (checks: typeof raw) => { checks[1].external_id = "run:9:1:job:119601912896"; },
    (checks: typeof raw) => { checks[1].external_id = "run:39710957377:1:job:9"; },
    (checks: typeof raw) => { checks[1].external_id = "run:39710957377:0:job:119601912896"; },
    (checks: typeof raw) => { checks[1].external_id = "run:39710957377:9007199254740992:job:119601912896"; },
    (checks: typeof raw) => { checks[1].output = { summary: "W1-T4399: reported by this job's claims step(s) (outcome(s): failure)" }; },
    (checks: typeof raw) => { checks[1].output = { summary: "W1-T4399: reported by this job's different step(s) (outcome(s): cancelled)" }; },
    (checks: typeof raw) => { checks[1].output = { summary: "" }; },
    (checks: typeof raw) => { checks[1].output = { summary: "W1-T4399: reported by this job's claims step(s) (outcome(s): success cancelled)" }; },
    (checks: typeof raw) => { checks[1].output = { summary: "W1-T4399: reported by this job's claims step(s) (outcome(s): failure cancelled)" }; },
    (checks: typeof raw) => { checks[1].status = "in_progress"; },
    (checks: typeof raw) => { checks[0].details_url = "https://github.com/owner/repo/runs/119601912896"; },
    (checks: typeof raw) => { checks.push({ ...checks[1], name: "other", external_id: "run:39710957377:2:job:119601912896",
      output: { summary: "W1-T4399: reported by this job's other step(s) (outcome(s): cancelled)" } }); },
  ]) {
    const checks = linkedChecks(); mutate(checks);
    assert.equal(cancelledRequiredChecks(read(checks), ["ci-gate"], LINK_HEAD)[0]?.explainedFailures, undefined);
  }
  assert.equal(cancelledRequiredChecks(read(), ["ci-gate"])[0]?.explainedFailures, undefined, "unknown current head grants no explanation");
  const privateOutput = linkedChecks();
  privateOutput[1].output = { summary: "PRIVATE_OTHER_CHECK_OUTPUT" };
  assert.equal(Object.hasOwn(read(privateOutput)[1], "outputSummary"), false, "unrelated check output is not retained in the cancellation read model");
});
