/**
 * W1-T9995 — A SUPERSEDED RED ON A DEPENDABOT HEAD IS RE-RUN IN ITS OWN OLD RUN.
 *
 * #11968 at 676bed094 (2026-10-16): W1-T9828's retitle at 22:54:33Z re-ran PR title lint and CI gate green, but the
 * pre-retitle runs dependabot[bot] started at 16:44Z kept their FAILUREs in their own check suites: PR title lint
 * 38934326485 and CI 38934327039 (its ci-gate job 117095262265). On 10-17 the session ran `gh run rerun --failed` on
 * each by hand; both attempt 2s concluded success (03:24:25Z, 03:34:00Z), the live proof of this remedy.
 * The fixtures below are those runs as `actions/runs?head_sha=` and `actions/runs/{id}/attempts/1/jobs` listed them.
 */
// @census-reads: .github/workflows/pr-title-lint.yml .github/workflows/ci.yml .github/workflows/ci-gate.yml scripts/acceptance-author-gate.mjs scripts/proof-discrimination-gate.mjs — what each re-runnable check reads
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  LIVE_READING_RERUN_CHECKS,
  dependabotActionsPort,
  isLiveReadingCheck,
  reconcileSupersededRedReruns,
  supersededRedReruns,
  type DependabotActionsPort,
  type DependabotHeadRun,
} from "../src/lib/dep-review.js";
import { supersededRedsNowPassing } from "./helpers/sweep-test.js";

const HEAD = "676bed0941f224b2e03146f3cf339f7458f2eccb";
const TITLE_LINT_OLD = 38934326485;
const CI_OLD = 38934327039;
const CI_GATE_JOB = 117095262265;
const COMMITLINT_JOB = 117085868891;

// #11968's rollup at 676bed094 before the hand re-runs; times are the job's where its jobs were read, else its run's.
const ROLLUP = [
  { name: "commitlint", conclusion: "FAILURE", startedAt: "2026-10-16T16:44:39Z", completedAt: "2026-10-16T16:44:58Z" },
  { name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-10-16T17:06:23Z", completedAt: "2026-10-16T17:16:56Z" },
  { name: "Semgrep", conclusion: "FAILURE", startedAt: "2026-10-16T16:44:37Z", completedAt: "2026-10-16T16:45:23Z" },
  { name: "commitlint", conclusion: "SUCCESS", startedAt: "2026-10-16T22:54:34Z", completedAt: "2026-10-16T22:54:57Z" },
  { name: "ci-gate", conclusion: "SUCCESS", startedAt: "2026-10-16T22:54:35Z", completedAt: "2026-10-16T22:55:30Z" },
  { context: "remudero-review", state: "SUCCESS", startedAt: "2026-10-17T02:58:23Z" },
];

const run = (id: number, path: string, conclusion: string, over: Partial<DependabotHeadRun> = {}): DependabotHeadRun =>
  ({ id, path: `.github/workflows/${path}`, status: "completed", conclusion, run_attempt: 1, ...over });

/** The 18 runs at 676bed094; the two old reds carry the jobs their attempt 1 listed. */
function headRuns(): DependabotHeadRun[] {
  return [
    run(38978493967, "ci-gate.yml", "success"), run(38978493961, "acceptance-author-gate.yml", "success"),
    run(38978493953, "pr-title-lint.yml", "success"), run(38978493941, "proof-discrimination-gate.yml", "success"),
    run(38934326511, "proof-discrimination-gate.yml", "success"), run(38934327145, "osv-scanner-pr.yml", "success"),
    run(38934326463, "gate-monotonic.yml", "success"), run(38934326547, "docs-index-check.yml", "success"),
    run(38934326598, "dependency-review.yml", "success"), run(38934326473, "semgrep.yml", "failure"),
    run(38934326443, "acceptance-author-gate.yml", "success"), run(38934326591, "coverage-session-blanking.yml", "success"),
    run(38934326542, "unwired-gate.yml", "success"), run(38934326544, "head-identity-gate.yml", "success"),
    run(CI_OLD, "ci.yml", "failure", { jobs: [
      { id: 117085873530, name: "light-gates", status: "completed", conclusion: "success" },
      { id: 117085874724, name: "claims", status: "completed", conclusion: "skipped" },
      { id: 117086223726, name: "coverage-ratchet", status: "completed", conclusion: "success" },
      { id: 117087456422, name: "ci", status: "completed", conclusion: "success" },
      { id: 117095025657, name: "test-slow", status: "completed", conclusion: "success" },
      { id: CI_GATE_JOB, name: "ci-gate", status: "completed", conclusion: "failure" },
    ] }),
    run(TITLE_LINT_OLD, "pr-title-lint.yml", "failure", { jobs: [
      { id: COMMITLINT_JOB, name: "commitlint", status: "completed", conclusion: "failure" },
    ] }),
    run(38934326332, "codeql.yml", "success"), run(38934321862, "security-merge-policy.yml", "success"),
  ];
}

test("W1-T9995: a superseded live-reading red selects its old run for a failed-job re-run", () => {
  const superseded = supersededRedsNowPassing(ROLLUP).sort();
  assert.deepEqual(superseded, ["ci-gate", "commitlint"], "Semgrep's newest run is still red, so it is not superseded");
  const selected = supersededRedReruns(headRuns(), superseded);
  assert.deepEqual(selected, [
    { runId: TITLE_LINT_OLD, attempt: 1, checks: ["commitlint"], jobIds: [COMMITLINT_JOB], kind: "rerun-failed-jobs",
      endpoint: `actions/runs/${TITLE_LINT_OLD}/rerun-failed-jobs` },
    { runId: CI_OLD, attempt: 1, checks: ["ci-gate"], jobIds: [CI_GATE_JOB], kind: "rerun-failed-jobs",
      endpoint: `actions/runs/${CI_OLD}/rerun-failed-jobs` },
  ], "commitlint first, even though the runs list CI before it; ci-gate aggregates the re-run commitlint");

  // W1-T1223: a sibling red in the same run is not this check's to re-run, so the job alone is.
  const sibling = headRuns().map((r) => r.id !== CI_OLD ? r : { ...r, jobs: r.jobs!.map((j) =>
    j.name === "ci" ? { ...j, conclusion: "failure" } : j) });
  assert.deepEqual(supersededRedReruns(sibling, superseded).map((s) => [s.kind, s.endpoint]), [
    ["rerun-failed-jobs", `actions/runs/${TITLE_LINT_OLD}/rerun-failed-jobs`], ["job", `actions/jobs/${CI_GATE_JOB}/rerun`]]);

  // A newest run that is red or still running is not superseded, so nothing names it.
  const newestRed = [...ROLLUP, { name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-10-16T23:10:00Z", completedAt: "2026-10-16T23:20:00Z" }];
  assert.deepEqual(supersededRedReruns(headRuns(), supersededRedsNowPassing(newestRed)).map((s) => s.runId), [TITLE_LINT_OLD]);
  assert.deepEqual(supersededRedReruns(headRuns(), []), []);
  const inFlight = headRuns().map((r) => r.id === CI_OLD ? { ...r, status: "in_progress", conclusion: null } : r);
  assert.deepEqual(supersededRedReruns(inFlight, superseded).map((s) => s.runId), [TITLE_LINT_OLD], "a run already re-running is left alone");
  const noJobs = headRuns().map((r) => r.id === CI_OLD ? { ...r, jobs: undefined } : r);
  assert.deepEqual(supersededRedReruns(noJobs, superseded).map((s) => s.runId), [TITLE_LINT_OLD], "an unread run's jobs select nothing");
});

test("W1-T9995: a superseded red in a payload-reading check is never re-run", async (t) => {
  // acceptance-author-gate and proof-discrimination read $GITHUB_EVENT_PATH: a re-run replays the old body.
  const payload = ["acceptance-author-gate", "proof-discrimination", "Semgrep"];
  for (const check of payload) assert.equal(isLiveReadingCheck(check), false, check);
  const runs = [
    run(38934326443, "acceptance-author-gate.yml", "failure", { jobs: [{ id: 1, name: "acceptance-author-gate", conclusion: "failure" }] }),
    run(38934326511, "proof-discrimination-gate.yml", "failure", { jobs: [{ id: 2, name: "proof-discrimination", conclusion: "failure" }] }),
    run(38934326473, "semgrep.yml", "failure", { jobs: [{ id: 3, name: "Semgrep", conclusion: "failure" }] }),
    // A live-reading name in a payload-reading run is still not that run's to re-run.
    run(4, "acceptance-author-gate.yml", "failure", { jobs: [{ id: 5, name: "commitlint", conclusion: "failure" }] }),
  ];
  assert.deepEqual(supersededRedReruns(runs, [...payload, "commitlint"]), []);
  const f = fixture(t);
  assert.deepEqual(await f.reconcile(payload), { kind: "none", checks: [] });
  assert.deepEqual(f.calls, [], "a payload-only block reads and POSTs nothing");
});

test("W1-T9995: the re-runnable checks are the ones whose workflow reads live state", () => {
  const workflow = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const evidence = [
    // pr-title-lint.yml lints the title it reads through the API at run time, never the event's.
    { check: "commitlint", workflow: ".github/workflows/pr-title-lint.yml", reads: [/gh pr view "\$PR_NUMBER" --repo "\$GITHUB_REPOSITORY" --json title/] },
    // Both legitimate ci-gate producers aggregate live check runs for the selected head.
    { check: "ci-gate", workflow: ".github/workflows/ci.yml", reads: [/node scripts\/ci-gate-from-contract\.mjs/] },
    { check: "ci-gate", workflow: ".github/workflows/ci-gate.yml", reads: [/types: \[edited\]/, /commits\/\$\{SHA\}\/check-runs/] },
  ];
  assert.deepEqual(LIVE_READING_RERUN_CHECKS, evidence.map(({ check, workflow }) => ({ check, workflow })), "every exact producer carries its evidence");
  for (const { check, workflow: path, reads } of evidence) {
    const text = workflow(path);
    assert.match(text, new RegExp(`^ {4}name: ${check}$`, "m"), `${path} runs a job named ${check}`);
    for (const read of reads) assert.match(text, read, `${path}: ${check} reads live state`);
    assert.doesNotMatch(text, /github\.event\.pull_request\.(title|body)|GITHUB_EVENT_PATH/, `${path} reads no frozen title/body payload`);
  }
  // The two frozen-body gates read the payload, which is why neither is in the set.
  assert.match(workflow("scripts/acceptance-author-gate.mjs"), /GITHUB_EVENT_PATH/);
  assert.match(workflow("scripts/proof-discrimination-gate.mjs"), /GITHUB_EVENT_PATH/);
});

test("W1-T9995: the arm pass re-runs a superseded Dependabot red once per head before it arms", async (t) => {
  // The reconciler takes no armed or mergeability input: it fires on the superseded red alone.
  const f = fixture(t);
  const superseded = supersededRedsNowPassing(ROLLUP);
  assert.deepEqual(await f.reconcile(superseded), { kind: "requested", checks: ["ci-gate", "commitlint"] });
  assert.deepEqual(f.posts, [`actions/runs/${TITLE_LINT_OLD}/rerun-failed-jobs`, `actions/runs/${CI_OLD}/rerun-failed-jobs`]);
  assert.deepEqual(f.calls.filter((c) => c.startsWith("jobs:")), [`jobs:${CI_OLD}`, `jobs:${TITLE_LINT_OLD}`], "only the old live reds' jobs are read");
  assert.deepEqual(f.rows("dep-review.superseded_red.rerun_requested"), [
    { step: "dep-review.superseded_red.rerun_requested", pr_number: 11968, head_sha: HEAD, checks: ["commitlint"], run_id: TITLE_LINT_OLD,
      job_ids: [COMMITLINT_JOB], endpoint: `actions/runs/${TITLE_LINT_OLD}/rerun-failed-jobs`, attempt: 1 },
    { step: "dep-review.superseded_red.rerun_requested", pr_number: 11968, head_sha: HEAD, checks: ["ci-gate"], run_id: CI_OLD,
      job_ids: [CI_GATE_JOB], endpoint: `actions/runs/${CI_OLD}/rerun-failed-jobs`, attempt: 1 },
  ]);
  assert.deepEqual(f.state().supersededReruns.map((r: Record<string, unknown>) => [r.headSha, r.runId, r.attempt]),
    [[HEAD, TITLE_LINT_OLD, 1], [HEAD, CI_OLD, 1]]);

  // While attempt 2 runs, and while the rollup still lists the old red, nothing is re-run again.
  f.setRun(TITLE_LINT_OLD, { status: "in_progress", conclusion: null, run_attempt: 2 });
  assert.deepEqual(await f.reconcile(superseded), { kind: "pending", checks: ["ci-gate", "commitlint"] });
  assert.equal(f.posts.length, 2, "once per (head, run)");
  // 10-17: attempt 2 of each concluded success (03:24:25Z, 03:34:00Z); the pass after confirms both.
  f.setRun(TITLE_LINT_OLD, { status: "completed", conclusion: "success", run_attempt: 2 });
  f.setRun(CI_OLD, { status: "completed", conclusion: "success", run_attempt: 2 });
  assert.deepEqual(await f.reconcile([]), { kind: "verified", checks: ["ci-gate", "commitlint"] });
  assert.deepEqual(f.rows("dep-review.superseded_red.rerun_verified").map((r) => [r.run_id, r.attempt, r.conclusion]),
    [[TITLE_LINT_OLD, 2, "success"], [CI_OLD, 2, "success"]]);
  const reads = f.calls.length;
  assert.deepEqual(await f.reconcile([]), { kind: "verified", checks: ["ci-gate", "commitlint"] });
  assert.equal(f.calls.length, reads, "a settled head reads nothing");
  f.setRun(TITLE_LINT_OLD, { conclusion: "failure", run_attempt: 1 });
  f.setRun(CI_OLD, { conclusion: "failure", run_attempt: 1 });
  const other = await f.reconcile(superseded, "a".repeat(40));
  assert.equal(other.kind, "requested", "a new head re-earns its own re-runs");
});

test("W1-T9995: a red re-run is confirmed once and never re-run; a failed POST or read retries", async (t) => {
  const f = fixture(t);
  const superseded = supersededRedsNowPassing(ROLLUP);
  f.failPost(`actions/runs/${CI_OLD}/rerun-failed-jobs`);
  assert.deepEqual(await f.reconcile(superseded), { kind: "failed", checks: ["ci-gate", "commitlint"] });
  assert.deepEqual(f.rows("dep-review.superseded_red.rerun_failed").map((r) => [r.action, r.run_id, r.error]),
    [["rerun", CI_OLD, "HTTP 403: rerun refused"]]);
  f.failPost(undefined);
  assert.equal((await f.reconcile(superseded)).kind, "requested", "the unrecorded run is re-run on the next pass");
  assert.equal(f.posts.filter((p) => p.includes(String(CI_OLD))).length, 2, "the refused POST and its retry");
  assert.equal(f.posts.filter((p) => p.includes(String(TITLE_LINT_OLD))).length, 1);

  f.setRun(CI_OLD, { status: "completed", conclusion: "failure", run_attempt: 2 });
  assert.deepEqual(await f.reconcile(superseded), { kind: "red", checks: ["ci-gate", "commitlint"], redNow: true });
  assert.deepEqual(f.rows("dep-review.superseded_red.rerun_red").map((r) => [r.run_id, r.attempt, r.conclusion]), [[CI_OLD, 2, "failure"]]);
  assert.deepEqual(await f.reconcile(superseded), { kind: "red", checks: ["ci-gate", "commitlint"] }, "red is reported, not re-announced");
  assert.equal(f.posts.length, 3, "a red attempt is never re-run");

  const unreadable = fixture(t);
  unreadable.failRead("runs");
  assert.deepEqual(await unreadable.reconcile(superseded), { kind: "failed", checks: ["ci-gate", "commitlint"] });
  unreadable.failRead("jobs");
  assert.equal((await unreadable.reconcile(superseded)).kind, "failed");
  assert.deepEqual(unreadable.rows("dep-review.superseded_red.rerun_failed").map((r) => r.action), ["read-runs", "read-jobs", "read-jobs"]);
  assert.deepEqual(unreadable.posts, []);

  const portless = fixture(t);
  assert.deepEqual(await portless.reconcile(superseded, HEAD, null), { kind: "unavailable", checks: ["ci-gate", "commitlint"] });
  const selectsNothing = fixture(t);
  assert.deepEqual(await selectsNothing.reconcile(["commitlint"], HEAD, undefined, []), { kind: "unselected", checks: ["commitlint"] });

  const corrupt = fixture(t);
  mkdirSync(dirname(corrupt.statePath), { recursive: true });
  writeFileSync(corrupt.statePath, JSON.stringify({ headSha: HEAD, heldSinceMs: null, asks: [], supersededReruns: [{ headSha: HEAD }] }));
  await assert.rejects(corrupt.reconcile(superseded), /refusing to re-run a run twice/);
  assert.deepEqual(corrupt.posts, []);
});

test("W1-T9995: the Actions port reads the head's runs and a run's jobs, and re-runs the endpoint", async () => {
  const reads: string[][] = [];
  const posts: string[] = [];
  const port = dependabotActionsPort("craigoley", "remudero", async (args) => {
    reads.push(args);
    return args[1].includes("/jobs") ? { total_count: 1, jobs: [{ id: CI_GATE_JOB, name: "ci-gate" }] } : { total_count: 0, workflow_runs: [] };
  }, async (path) => { posts.push(path); return ""; });
  assert.deepEqual(await port.runs(HEAD), []);
  assert.deepEqual(await port.jobs(CI_OLD), [{ id: CI_GATE_JOB, name: "ci-gate" }]);
  await port.rerun(`actions/runs/${CI_OLD}/rerun-failed-jobs`);
  assert.deepEqual(reads, [["api", `repos/craigoley/remudero/actions/runs?head_sha=${HEAD}&per_page=100`],
    ["api", `repos/craigoley/remudero/actions/runs/${CI_OLD}/jobs?per_page=100`]]);
  assert.deepEqual(posts, [`repos/craigoley/remudero/actions/runs/${CI_OLD}/rerun-failed-jobs`]);
  const empty = dependabotActionsPort("craigoley", "remudero", async () => null, async () => "");
  await assert.rejects(empty.runs(HEAD), /no workflow_runs array in the response/);
});

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9995-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "dep-review-holds", "craigoley", "remudero", "PR11968.json");
  const runs = headRuns();
  const calls: string[] = [];
  const posts: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  let refusedPost: string | undefined;
  let refusedRead: "runs" | "jobs" | undefined;
  let now = Date.parse("2026-10-17T02:58:23Z");
  const port: DependabotActionsPort = {
    runs: async (headSha) => {
      calls.push(`runs:${headSha.slice(0, 7)}`);
      if (refusedRead === "runs") { refusedRead = undefined; throw new Error("HTTP 502"); }
      return runs.map(({ jobs: _jobs, ...r }) => ({ ...r }));
    },
    jobs: async (runId) => {
      calls.push(`jobs:${runId}`);
      if (refusedRead === "jobs") throw new Error("HTTP 502");
      return runs.find((r) => r.id === runId)?.jobs ?? [];
    },
    rerun: async (endpoint) => {
      posts.push(endpoint);
      if (endpoint === refusedPost) throw new Error("HTTP 403: rerun refused");
    },
  };
  return {
    statePath, calls, posts,
    rows: (step: string) => logged.filter((r) => r.step === step),
    state: () => JSON.parse(readFileSync(statePath, "utf8")),
    setRun: (id: number, over: Partial<DependabotHeadRun>) => { Object.assign(runs.find((r) => r.id === id)!, over); },
    failPost: (endpoint: string | undefined) => { refusedPost = endpoint; },
    failRead: (what: "runs" | "jobs") => { refusedRead = what; },
    reconcile: (superseded: readonly string[], headSha = HEAD, actions: DependabotActionsPort | null = port, onlyRuns?: DependabotHeadRun[]) =>
      reconcileSupersededRedReruns({
        statePath, prNumber: 11968, headSha, superseded, nowMs: (now += 60_000),
        actions: actions === null ? undefined : onlyRuns === undefined ? actions : { ...actions, runs: async () => onlyRuns },
        log: (step, extra) => { logged.push({ step, ...extra }); },
      }),
  };
}


test("an edited-only ci-gate producer is reconciled once in its exact old run through the Actions port", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-edited-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "PR13354.json");
  const head = "e68c847d3fe7be5ddf6d79fd897393e73c2e1d65";
  const editedRun = 39670716213, editedJob = 119467554871;
  const reads: string[][] = [], posts: string[] = [];
  let attempt = 1;
  const port = dependabotActionsPort("craigoley", "remudero", async (args) => {
    reads.push(args);
    if (args[1] === `repos/craigoley/remudero/actions/runs?head_sha=${head}&per_page=100`) {
      return { workflow_runs: [
        run(editedRun, "ci-gate.yml", attempt === 1 ? "failure" : "success", { run_attempt: attempt }),
        run(42, "ci.yml", "success"),
        // A same-name check in another producer must not acquire rerun authority.
        run(43, "security-merge-policy.yml", "failure"),
      ] };
    }
    assert.equal(args[1], `repos/craigoley/remudero/actions/runs/${editedRun}/jobs?per_page=100`);
    return { jobs: [{ id: editedJob, name: "ci-gate", status: "completed", conclusion: "failure" }] };
  }, async (path) => { posts.push(path); });
  const reconcile = () => reconcileSupersededRedReruns({ statePath, prNumber: 13354, headSha: head,
    superseded: ["ci-gate"], actions: port, nowMs: 1792620900000, log: () => {} });
  assert.deepEqual(await reconcile(), { kind: "requested", checks: ["ci-gate"] });
  assert.deepEqual(posts, [`repos/craigoley/remudero/actions/runs/${editedRun}/rerun-failed-jobs`]);
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")).supersededReruns.map((r: Record<string, unknown>) =>
    [r.headSha, r.runId, r.attempt, r.checks, r.endpoint]),
    [[head, editedRun, 1, ["ci-gate"], `actions/runs/${editedRun}/rerun-failed-jobs`]]);
  assert.deepEqual(await reconcile(), { kind: "pending", checks: ["ci-gate"] });
  assert.equal(posts.length, 1, "unchanged older failure is not requested again");
  attempt = 2;
  assert.deepEqual(await reconcile(), { kind: "verified", checks: ["ci-gate"] });
  assert.equal(posts.length, 1, "successful next attempt is verified, never rerun again");
  assert.equal(reads.filter(args => args[1].includes("/jobs")).length, 1, "only the selected producer's jobs are read once");
});

test("an edited-only ci-gate keeps exact producer and failed-job selection", () => {
  const job = { id: 119467554871, name: "ci-gate", status: "completed", conclusion: "failure" };
  const edited = run(39670716213, "ci-gate.yml", "failure", { jobs: [job] });
  assert.deepEqual(supersededRedReruns([edited], ["ci-gate"])[0], {
    runId: edited.id, attempt: 1, checks: ["ci-gate"], jobIds: [job.id], kind: "rerun-failed-jobs",
    endpoint: `actions/runs/${edited.id}/rerun-failed-jobs`,
  });
  assert.deepEqual(supersededRedReruns([{ ...edited, path: ".github/workflows/other.yml" }], ["ci-gate"]), []);
  assert.deepEqual(supersededRedReruns([{ ...edited, status: "in_progress" }], ["ci-gate"]), []);
  assert.deepEqual(supersededRedReruns([{ ...edited, jobs: [{ ...job, name: "ci" }] }], ["ci-gate"]), []);
  assert.deepEqual(supersededRedReruns([edited], []), []);
  const sibling = { ...edited, jobs: [job, { ...job, id: 9, name: "test-slow" }] };
  assert.deepEqual(supersededRedReruns([sibling], ["ci-gate"])[0].endpoint, `actions/jobs/${job.id}/rerun`,
    "another failed job is not rerun merely because it shares the aggregator's workflow");
});
