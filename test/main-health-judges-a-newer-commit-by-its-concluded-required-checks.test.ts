// W1-T7757 — main health judges a newer commit by its CONCLUDED required checks, not by its workflow
// run's status.
//
// 2026-10-10 15:03:50Z: main read RED from f76df1f45's completed run while the newer 916e5ced0's
// required `ci` check had concluded green at 15:01:01. 916e5ced0's workflow run was still in progress
// (other jobs were going), and the walk back kept only completed runs, so it never saw that verdict.
// A required check concludes per job, before its run does: the walk now reads queued and running runs
// too, visits main's commits in FIRST-PARENT order, and lets a commit decide once its required jobs
// have concluded. A required job still running decides nothing: a pending commit over older green
// reads `undetermined`, and over older red main stays red, because red is only ever a concluded check.
//
// The fixtures are routed at the `fetch` level, so the rung's production readers run for real.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildMainHealthRung } from "../src/lib/main-health-rung.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const HEAD = "a".repeat(40);
const NEWER = "916e5ced0".padEnd(40, "1");
const OLDER = "f76df1f45".padEnd(40, "2");
const ELDER = "d".repeat(40);
const NOW = Date.parse("2026-10-10T15:03:50Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

type Check = { name: string; status: string; conclusion: string | null };
const check = (name: string, conclusion: string | null): Check => ({ name, conclusion, status: conclusion ? "completed" : "in_progress" });

interface Run {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
}
const run = (id: number, head_sha: string, conclusion: string | null): Run => ({
  id, name: "CI", head_sha, status: conclusion ? "completed" : "in_progress", conclusion,
});

const commitsPage = (commits: ReadonlyArray<[string, number]>) =>
  commits.map(([sha, minutesAgo], i) => ({
    sha,
    parents: commits[i + 1] ? [{ sha: commits[i + 1]![0] }] : [],
    commit: { committer: { date: ago(minutesAgo) } },
  }));

const REQUIRED = ["ci", "test-slow", "coverage-ratchet", "lint-plan"];
const GREEN = [check("ci", "success"), check("test-slow", "success"), check("coverage-ratchet", "success"), check("lint-plan", "success")];
/** The required checks all concluded green while a non-required job of the same run is still going. */
const GREEN_RUN_STILL_GOING = [...GREEN, check("docs-build", null)];
const RED_RUN_STILL_GOING = [check("ci", "success"), check("test-slow", "failure"), check("coverage-ratchet", null), check("lint-plan", "success")];
const RUNNING = [check("ci", "success"), check("test-slow", null), check("coverage-ratchet", null), check("lint-plan", "success")];
const RED = [check("ci", "failure"), check("test-slow", "success"), check("coverage-ratchet", "success"), check("lint-plan", "success")];
/** The head's own checks have not registered yet, so the head concluded nothing and main walks back. */
const HEAD_CHECKS: Check[] = [];

function harness(world: { runs: Run[]; jobs: Record<number, Check[]>; commits: ReadonlyArray<[string, number]> }) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t7757-`));
  const rows: Record<string, unknown>[] = [];
  const jobsRead: number[] = [];
  let tick = 0;
  const rung = buildMainHealthRung("o", "r", {
    fetch: async (args) => {
      const path = args[1]!;
      if (path === "repos/o/r") return { default_branch: "main" };
      if (path === "repos/o/r/commits/main") return { sha: HEAD };
      if (path.includes("/check-runs?")) return { check_runs: HEAD_CHECKS };
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
    runId: "T7757",
    now: () => NOW + 1_000 * tick++,
    log: (step, extra) => {
      rows.push({ step, ...extra });
    },
    readRequiredChecks: () => REQUIRED,
  });
  return {
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

const COMMITS: ReadonlyArray<[string, number]> = [[HEAD, 1], [NEWER, 3], [OLDER, 6], [ELDER, 9]];

test("W1-T7757: a newer commit whose required checks concluded green outranks an older completed red while its run is still in progress", async () => {
  const h = harness({
    runs: [run(3, OLDER, "failure"), run(2, NEWER, null)],
    jobs: { 3: RED, 2: GREEN_RUN_STILL_GOING },
    commits: COMMITS,
  });
  try {
    const observed = await h.observe();
    assert.equal(observed.state, "green");
    assert.equal(observed.decided_by_sha, NEWER);
    assert.equal(observed.evidence_depth, 1);
    assert.deepEqual(observed.failing_checks, []);
  } finally {
    h.cleanup();
  }
});

test("W1-T7757: a newer commit whose required checks concluded red decides red at that commit while its run is still in progress", async () => {
  const h = harness({
    runs: [run(3, OLDER, "success"), run(2, NEWER, null)],
    jobs: { 3: GREEN, 2: RED_RUN_STILL_GOING },
    commits: COMMITS,
  });
  try {
    const observed = await h.observe();
    assert.equal(observed.state, "red");
    assert.equal(observed.decided_by_sha, NEWER);
    assert.deepEqual(observed.failing_checks, ["test-slow"]);
  } finally {
    h.cleanup();
  }
});

test("W1-T7757: a newer commit with required checks still running reads pending, never green, and names the older evidence", async () => {
  const h = harness({
    runs: [run(3, OLDER, "success"), run(2, NEWER, null)],
    jobs: { 3: GREEN, 2: RUNNING },
    commits: COMMITS,
  });
  try {
    const observed = await h.observe();
    assert.equal(observed.state, "undetermined");
    assert.match(String(observed.reason), /^pending/);
    assert.ok(String(observed.reason).includes(NEWER), "names the pending commit");
    assert.ok(String(observed.reason).includes(OLDER), "names the older green commit");
    assert.deepEqual(observed.pending_checks, ["test-slow"], "coverage-ratchet is a known vacuous pass, never pending evidence");
  } finally {
    h.cleanup();
  }
});

test("W1-T7757: a running required check never decides red, and an older concluded red stays red beside it", async () => {
  const alone = harness({ runs: [run(2, NEWER, null)], jobs: { 2: RUNNING }, commits: COMMITS });
  try {
    const observed = await alone.observe();
    assert.notEqual(observed.state, "red", "a running check is no red");
    assert.notEqual(observed.state, "green");
  } finally {
    alone.cleanup();
  }
  const h = harness({
    runs: [run(3, OLDER, "failure"), run(2, NEWER, null)],
    jobs: { 3: RED, 2: RUNNING },
    commits: COMMITS,
  });
  try {
    const observed = await h.observe();
    assert.equal(observed.state, "red", "the older concluded red is not downgraded to pending");
    assert.equal(observed.decided_by_sha, OLDER);
    assert.deepEqual(observed.failing_checks, ["ci"]);
    assert.ok(String(observed.reason).includes(NEWER), "the reason names the newer commit still running");
  } finally {
    h.cleanup();
  }
});

test("W1-T7757: the 15:03:50Z replay decides from 916e5ced0, not from the older red at f76df1f45", async () => {
  // f76df1f45's run was created AFTER 916e5ced0's began (newest-created first), yet 916e5ced0 is the newer commit.
  const h = harness({
    runs: [run(3, OLDER, "failure"), run(2, NEWER, null), run(1, ELDER, "success")],
    jobs: { 3: RED, 2: GREEN_RUN_STILL_GOING, 1: GREEN },
    commits: COMMITS,
  });
  try {
    const observed = await h.observe();
    assert.equal(observed.state, "green");
    assert.equal(observed.decided_by_sha, NEWER);
    assert.ok(!h.jobsRead.includes(3), "the older commit's red run is never consulted once a newer commit decides");
  } finally {
    h.cleanup();
  }
});

test("W1-T7757: only a run whose required jobs all concluded has its jobs cached", async () => {
  const pending = harness({ runs: [run(2, NEWER, null), run(1, OLDER, "success")], jobs: { 2: RUNNING, 1: GREEN }, commits: COMMITS });
  try {
    await pending.observe();
    await pending.observe();
    assert.equal(pending.jobsRead.filter((id) => id === 2).length, 2, "a pending run's jobs are read again on the next observation");
  } finally {
    pending.cleanup();
  }
  const concluded = harness({ runs: [run(2, NEWER, null)], jobs: { 2: GREEN_RUN_STILL_GOING }, commits: COMMITS });
  try {
    await concluded.observe();
    await concluded.observe();
    assert.equal(concluded.jobsRead.filter((id) => id === 2).length, 1, "a run with every required job concluded is read once");
  } finally {
    concluded.cleanup();
  }
});
