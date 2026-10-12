// Main health derives from the NEWEST main commit with genuine evidence, not from main's head alone.
//
// 2026-10-10: `main.health.observed` read `undetermined` on nearly every pass since ~14:40Z. Merges
// land every few minutes and main's push runs share one concurrency group, so the head's own CI has
// usually not registered yet, was cancelled by the next merge, or (a plan-only merge) skipped every
// required job. Two gaps kept the existing fallback from ever answering:
//   - an all-skipped/vacuous head was never walked past at all;
//   - the fallback read at most five completed runs, and CodeQL, Semgrep, Scorecard and main-tripwire
//     finish minutes before CI, so those five were almost never a CI run.
// A run whose own required jobs were skipped or cancelled must be walked past too, never decide.
// And an old green is reported `stale` once the oldest merge since it has waited longer than main's
// own runs have ever taken to deliver evidence.
//
// The fixtures are routed at the `fetch` level, so the rung's production readers run for real.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildMainHealthRung } from "../src/lib/main-health-rung.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { BASE_RED_STOOD_DOWN_STEP, mainLatestRunFromLedger, runSweep, type OpenPrView } from "./helpers/sweep-test.js";

const HEAD = "a".repeat(40);
const PARENT = "b".repeat(40);
const GRANDPARENT = "c".repeat(40);
const ELDER = "d".repeat(40);
const NOW = Date.parse("2026-10-10T17:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

type Check = { name: string; status: string; conclusion: string | null };
const check = (name: string, conclusion: string | null): Check => ({ name, conclusion, status: conclusion ? "completed" : "in_progress" });

interface Run {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  run_started_at?: string;
  updated_at?: string;
}
const run = (id: number, name: string, head_sha: string, conclusion: string | null, times: Partial<Run> = {}): Run => ({
  id, name, head_sha, status: conclusion ? "completed" : "in_progress", conclusion, ...times,
});

/** GitHub's `commits?sha=` page, newest first, each naming its first parent and its committer time. */
const commitsPage = (commits: ReadonlyArray<[string, number]>) =>
  commits.map(([sha, minutesAgo], i) => ({
    sha,
    parents: commits[i + 1] ? [{ sha: commits[i + 1]![0] }] : [],
    commit: { committer: { date: ago(minutesAgo) } },
  }));

const REQUIRED = ["ci", "test-slow", "coverage-ratchet", "lint-plan"];

interface World {
  head: string;
  headChecks: Check[];
  runs: Run[];
  jobs: Record<number, Check[]>;
  commits: ReadonlyArray<[string, number]>;
}

function harness(world: World) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}main-walk-`));
  const rows: Record<string, unknown>[] = [];
  const jobsRead: number[] = [];
  const rung = buildMainHealthRung("o", "r", {
    fetch: async (args) => {
      const path = args[1]!;
      if (path === "repos/o/r") return { default_branch: "main" };
      if (path === "repos/o/r/commits/main") return { sha: world.head };
      if (path.includes("/check-runs?")) return { check_runs: world.headChecks };
      if (path.endsWith("/status")) return { statuses: [] };
      if (path.includes("/actions/runs?")) return { workflow_runs: world.runs };
      if (path.startsWith("repos/o/r/commits?")) return commitsPage(world.commits);
      const jobsOf = /actions\/runs\/(\d+)\/jobs\?/.exec(path)?.[1];
      if (jobsOf) {
        jobsRead.push(Number(jobsOf));
        return { jobs: (world.jobs[Number(jobsOf)] ?? []).map((job, i) => ({ id: Number(jobsOf) * 100 + i, ...job })) };
      }
      throw new Error(`unrouted: ${path}`);
    },
    issues: { create: () => "https://github.com/o/r/issues/1", listOpen: () => [], closeWithComment: () => {} },
    ledgerPath: join(root, "ledger.ndjson"),
    runId: "MAIN-WALK",
    now: () => NOW,
    log: (step, extra) => {
      rows.push({ step, ...extra });
    },
    readRequiredChecks: () => REQUIRED,
  });
  return {
    rows,
    jobsRead,
    observe: async () => {
      await rung();
      const observed = rows.filter((r) => r.step === "main.health.observed").at(-1);
      assert.ok(observed, "the observation writes its main.health.observed row");
      return observed;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A plan-only merge: every required check on it concluded, but skipped or known-vacuous. */
const VACUOUS_HEAD = [check("ci", "skipped"), check("test-slow", "skipped"), check("coverage-ratchet", "success"), check("lint-plan", "skipped")];
const GREEN_CI = [check("ci", "success"), check("test-slow", "success"), check("coverage-ratchet", "success")];
const RED_CI = [check("ci", "success"), check("test-slow", "failure"), check("coverage-ratchet", "success")];
/** The fast push workflows: complete, but carrying none of ci-gate's required checks. */
const FAST = ["CodeQL", "Semgrep", "OpenSSF Scorecard", "main-tripwire", "Build image (ACR)", "CodeQL"];
const fastRuns = (head: string, firstId: number) => FAST.map((name, i) => run(firstId + i, name, head, "success"));
const fastJobs = (firstId: number) =>
  Object.fromEntries(FAST.map((name, i) => [firstId + i, [check(name === "main-tripwire" ? "main-tripwire" : `${name} scan`, "success")]]));

test("main health: an all-skipped plan-only head walks back to the newest main commit with genuine evidence", async () => {
  const h = harness({
    head: HEAD,
    headChecks: VACUOUS_HEAD,
    runs: [run(3, "CI", HEAD, "success"), run(2, "CI", PARENT, "cancelled"), run(1, "CI", GRANDPARENT, "success")],
    jobs: { 3: VACUOUS_HEAD, 1: GREEN_CI },
    commits: [[HEAD, 2], [PARENT, 4], [GRANDPARENT, 6], [ELDER, 8]],
  });
  try {
    const observed = await h.observe();
    assert.equal(observed.state, "green");
    assert.equal(observed.sha, HEAD);
    assert.equal(observed.decided_by_sha, GRANDPARENT);
    assert.equal(observed.evidence_depth, 2, "the deciding commit is named with how far back it is");
    assert.equal(observed.walked_past_runs, 1, "the head's own all-skipped CI run was walked past, never allowed to decide");
    assert.match(String(observed.reason), new RegExp(`skipped or a known vacuous pass.*latest completed main run \\(${GRANDPARENT}\\) decides`));
  } finally {
    h.cleanup();
  }
});

test("main health: fast workflows crowding the newest completed history never hide main's CI evidence", async () => {
  const world: World = {
    head: HEAD,
    headChecks: [],
    runs: [...fastRuns(HEAD, 20), ...fastRuns(PARENT, 30), run(2, "CI", PARENT, "cancelled"), run(1, "CI", GRANDPARENT, "failure")],
    jobs: { ...fastJobs(20), ...fastJobs(30), 1: RED_CI },
    commits: [[HEAD, 2], [PARENT, 4], [GRANDPARENT, 6], [ELDER, 8]],
  };
  const h = harness(world);
  try {
    const observed = await h.observe();
    assert.equal(observed.state, "red", "a red at the newest-evidence sha is red, though twelve newer runs completed first");
    assert.equal(observed.decided_by_sha, GRANDPARENT);
    assert.equal(observed.evidence_depth, 2);
    assert.deepEqual(observed.failing_checks, ["test-slow"]);
    // A new head: the workflows learned to carry no required check are passed over without a jobs read.
    const QUEUED = "e".repeat(40);
    world.head = QUEUED;
    world.runs = [...fastRuns(QUEUED, 40), ...world.runs];
    world.jobs = { ...world.jobs, ...fastJobs(40) };
    world.commits = [[QUEUED, 1], ...world.commits];
    h.jobsRead.length = 0;
    const next = await h.observe();
    assert.equal(next.state, "red");
    assert.equal(next.evidence_depth, 3);
    assert.deepEqual(h.jobsRead, [1], "only the CI run is read once CodeQL, Semgrep and the rest are known to carry no required check");
  } finally {
    h.cleanup();
  }
});

test("main health: a newer run whose required jobs were skipped or cancelled is walked past, and an older red decides", async () => {
  const h = harness({
    head: HEAD,
    headChecks: [check("ci", null)],
    runs: [
      run(3, "CI", PARENT, "success"),
      run(2, "CI", GRANDPARENT, "failure"),
      run(1, "CI", ELDER, "success"),
    ],
    jobs: {
      3: [check("ci", "skipped"), check("test-slow", "cancelled"), check("coverage-ratchet", "success")],
      2: RED_CI,
      1: GREEN_CI,
    },
    commits: [[HEAD, 1], [PARENT, 3], [GRANDPARENT, 5], [ELDER, 7]],
  });
  try {
    const observed = await h.observe();
    assert.equal(observed.state, "red", "newer pending and vacuous heads never mask the newest genuine red");
    assert.equal(observed.decided_by_sha, GRANDPARENT);
    assert.equal(observed.evidence_depth, 2);
    assert.equal(observed.walked_past_runs, 1);
    assert.deepEqual(observed.failing_checks, ["test-slow"]);
  } finally {
    h.cleanup();
  }
});

test("main health: a green older than main's observed evidence latency reads stale, not green", async () => {
  // The deciding CI run took 20 minutes (bound: twice that, or the longest merge-to-verdict wait).
  const deciding = run(1, "CI", GRANDPARENT, "success", { run_started_at: ago(115), updated_at: ago(95) });
  const world = (parentMinutesAgo: number): World => ({
    head: HEAD,
    headChecks: [],
    runs: [run(3, "CI", HEAD, null), run(2, "CI", PARENT, "cancelled"), deciding],
    jobs: { 1: GREEN_CI },
    commits: [[HEAD, 5], [PARENT, parentMinutesAgo], [GRANDPARENT, 118], [ELDER, 130]],
  });
  const stale = harness(world(100));
  try {
    const observed = await stale.observe();
    assert.equal(observed.state, "stale", "100 minutes unverified is past every wait main's runs have shown");
    assert.equal(observed.decided_by_sha, GRANDPARENT);
    assert.equal(observed.evidence_freshness, "stale");
    assert.equal(observed.evidence_lag_ms, 100 * 60_000);
    assert.equal(observed.evidence_latency_bound_ms, 40 * 60_000);
    assert.equal(typeof observed.merge_cadence_ms, "number");
    assert.match(String(observed.reason), /stale, not green/);
  } finally {
    stale.cleanup();
  }
  const fresh = harness(world(30));
  try {
    const observed = await fresh.observe();
    assert.equal(observed.state, "green", "30 minutes unverified is within main's own observed evidence latency");
    assert.equal(observed.evidence_freshness, "fresh");
  } finally {
    fresh.cleanup();
  }
});

test("base red reads the deciding sha: a PR failing the check main fails at that sha stands down naming it", async () => {
  const pr: OpenPrView = {
    prNumber: 10700, prUrl: "https://github.com/o/r/pull/10700", taskId: "MAIN-WALK",
    headSha: "f".repeat(40), headRefName: "run-unfiled-1", checksState: "red", reviewState: "pending",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date(NOW - 60_000).toISOString(),
    ciFailures: [{ name: "test-slow", conclusion: "FAILURE", logTail: "not ok 1 - inherited" }],
  };
  const h = harness({
    head: HEAD,
    headChecks: VACUOUS_HEAD,
    runs: [run(2, "CI", PARENT, "cancelled"), run(1, "CI", GRANDPARENT, "failure")],
    jobs: { 1: RED_CI },
    commits: [[HEAD, 2], [PARENT, 4], [GRANDPARENT, 6]],
  });
  try {
    const observed = await h.observe();
    const rows: Record<string, unknown>[] = [observed];
    const main = mainLatestRunFromLedger(rows);
    assert.equal(main?.sha, HEAD);
    assert.equal(main?.decidedBySha, GRANDPARENT);
    const dispatched: number[] = [];
    await runSweep([pr], {
      ledgerPath: "/dev/null/main-walk", runId: "MAIN-WALK", now: () => NOW,
      readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
      arm: () => {}, close: () => {}, escalate: () => {}, postReview: async () => {},
      dispatchFix: (p) => { dispatched.push(p.prNumber); }, updateBranch: () => "updated",
    });
    assert.deepEqual(dispatched, [], "a check main fails at the deciding sha is base red, never a fix");
    const stood = rows.find((r) => r.step === BASE_RED_STOOD_DOWN_STEP);
    assert.equal(stood?.main_sha, HEAD);
    assert.equal(stood?.main_decided_by_sha, GRANDPARENT);
    const reason = String(rows.filter((r) => r.step === "sweep.disposed" && r.pr_number === 10700).at(-1)?.stand_down_reason);
    assert.match(reason, new RegExp(`test-slow also fails on main's latest run \\(${GRANDPARENT}\\)`));
  } finally {
    h.cleanup();
  }
});

