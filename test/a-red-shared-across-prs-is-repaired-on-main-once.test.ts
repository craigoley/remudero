// test/a-red-shared-across-prs-is-repaired-on-main-once.test.ts — W1-T8042.
//
// 2026-10-11: after #10834 merged at 11:10Z, eight open PRs went red on ci-shards with the same
// pure-test-pool hang. Each was disposed own-red / fix-lane and spent fix strikes and shard re-runs,
// while main's own push runs were cancelled before concluding, so the base-red stand-down read main
// as undetermined. These fixtures replay that shape: disjoint diffs, one ci-shard signature, a green
// main commit older than the merge that broke the pool.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildMainHealthRung,
  mainRepairRecordsFromLedger,
  type MainRepairFixRequest,
  type MainRepairLane,
} from "#src/lib/main-health-rung.js";
import type { GhApiFetcher } from "#src/lib/open-prs-rest.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  MAIN_INHERITED_RED_STEP,
  restMainInheritanceReads,
  runSweep,
  type FixDispatchEvidence,
  type MainInheritanceReads,
  type OpenPrView,
  type SweepDeps,
} from "#test/helpers/sweep-test.js";

const OWNER = "craigoley";
const REPO = "remudero";
const NOW = Date.parse("2026-10-11T13:12:00Z");
const sha = (prefix: string): string => prefix.padEnd(40, "0");
// Main's first-parent line, oldest first: the last green merge, #10834's pool, then two later merges.
const GREEN = sha("9a11ee");
const POOL_MERGE = sha("10834a");
const LATER_1 = sha("4ead01");
const LATER_2 = sha("4ead02");
const MAIN_LINE = [GREEN, POOL_MERGE, LATER_1, LATER_2];
const NAMED_TEST = "test/a-worker-thread-makes-no-setup-dirs.test.ts";
const POOLED_LOG = [
  "2026-10-11T12:10:00.1Z not ok 41 - a worker thread makes no setup dirs",
  `2026-10-11T12:10:00.1Z   location: '/home/runner/work/remudero/remudero/${NAMED_TEST}:12:1'`,
  "2026-10-11T12:10:00.2Z pure-test-pool: the pool of 120 file(s) failed",
  "2026-10-11T12:12:00.3Z pure-test-pool: every pooled file passes isolated",
  "2026-10-11T12:12:01.4Z locating the leak ...",
  "2026-10-11T12:45:00.5Z ##[error]The operation was canceled.",
].join("\n");
const OWN_LOG = [
  "2026-10-11T13:30:00.1Z not ok 7 - the board renders its new column",
  "2026-10-11T13:30:00.2Z # fail 1",
].join("\n");

const tmpLedger = (): string => join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t8042-`)), "ledger.ndjson");

/** One red PR: one cancelled ci-shard whose log is `log`, its own diff, and its merge base on main. */
function redPr(prNumber: number, shard: string, base: string, changedFiles: string[], log = POOLED_LOG): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/${OWNER}/${REPO}/pull/${prNumber}`,
    taskId: `W1-T${prNumber}`,
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW).toISOString(),
    headSha: sha(`ead${prNumber}`),
    headRefName: `run-W1-T${prNumber}-1791718425961`,
    autoMergeArmed: false,
    changedFiles,
    currentMergeBaseSha: base,
    ciFailures: [{ name: shard, logTail: log, conclusion: "CANCELLED" }],
    cancelledRequiredChecks: [{ name: shard, jobId: String(114465855700 + prNumber) }],
  };
}

const shared = (): OpenPrView[] => [
  redPr(10852, "ci-shard (7/8)", LATER_2, ["src/lib/now-view.ts", "test/now-view.test.ts"]),
  redPr(10854, "ci-shard (8/8)", LATER_1, ["src/lib/inbox.ts"]),
  redPr(10829, "ci-shard (5/8)", POOL_MERGE, ["docs/forensics/sweep.md"]),
];

/** Main's history as a line: `of` contains `ancestor` when it is at or after it. */
function linearMain(over: Partial<MainInheritanceReads> = {}): MainInheritanceReads & { containsReads: number } {
  const reads = {
    containsReads: 0,
    changedFiles: async () => undefined,
    mergeBase: async () => undefined,
    contains: async (of: string, ancestor: string) => {
      reads.containsReads += 1;
      return MAIN_LINE.indexOf(ancestor) >= 0 && MAIN_LINE.indexOf(ancestor) <= MAIN_LINE.indexOf(of);
    },
    ...over,
  };
  return reads;
}

function fakeDeps(ledgerPath = tmpLedger(), over: Partial<SweepDeps> = {}) {
  const requeued: string[] = [];
  const fixed: Array<{ prNumber: number; evidence: FixDispatchEvidence }> = [];
  const refreshed: number[] = [];
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const deps: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: (pr, evidence) => {
      fixed.push({ prNumber: pr.prNumber, evidence });
    },
    escalate: () => {},
    requeueCheck: async (_pr, check) => {
      requeued.push(check.name);
    },
    escalateCancelledCheck: async () => {},
    updateBranch: async (pr) => {
      refreshed.push(pr.prNumber);
      return "updated" as const;
    },
    log: (step, extra) => {
      logged.push({ step, extra });
    },
    mainInheritance: linearMain(),
    ledgerPath,
    runId: "SWEEP-W1-T8042",
    now: () => NOW,
    ...over,
  };
  return { deps, requeued, fixed, refreshed, logged };
}

/** Main's last concluded run, green at the merge before #10834's pool. */
function seedGreenMain(ledgerPath: string): void {
  const row = { ts: "2026-10-11T11:00:00Z", step: "main.health.observed", sha: GREEN, state: "green", failing_checks: [] };
  appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
}

const disposed = (ledgerPath: string, prNumber: number) =>
  readLedgerLines(ledgerPath).filter((row) => row.step === "sweep.disposed" && row.pr_number === prNumber).at(-1);
const handoffs = (ledgerPath: string) => readLedgerLines(ledgerPath).filter((row) => row.step === MAIN_INHERITED_RED_STEP);

test("W1-T8042: a red shared by PRs with disjoint diffs is main-inherited and spends no strike", async () => {
  const { deps, requeued, fixed, refreshed } = fakeDeps();
  seedGreenMain(deps.ledgerPath);
  await runSweep(shared(), deps);

  assert.deepEqual(fixed.map((f) => f.prNumber), [], "no PR spends a fix strike on main's red");
  assert.deepEqual(requeued, [], "no shard is re-run");
  assert.deepEqual(refreshed, [], "no base refresh is pressed");
  for (const pr of shared()) {
    const row = disposed(deps.ledgerPath, pr.prNumber);
    assert.ok(row, `PR #${pr.prNumber} is disposed`);
    assert.equal(row.red_cause, "main-inherited");
    assert.equal(row.blocker, "base-red");
    assert.equal(row.blocker_owner, "main-health");
    assert.match(String(row.stand_down_reason), /^red cause: main-inherited — ci-shard \[not ok a worker thread makes no setup dirs\] is also red on /);
    const others = shared().filter((other) => other.prNumber !== pr.prNumber).map((other) => `#${other.prNumber}`);
    for (const other of others) assert.ok(String(row.stand_down_reason).includes(other), `names ${other}`);
    assert.match(String(row.stand_down_reason), new RegExp(`main ${POOL_MERGE.slice(0, 12)} is in every one's base`));
    assert.deepEqual((row.main_inherited as Array<{ pr_numbers: number[] }>)[0]!.pr_numbers, [10852, 10854, 10829]);
  }
});

test("W1-T8042: a shared red signature opens one main-repair record", async () => {
  const ledgerPath = tmpLedger();
  seedGreenMain(ledgerPath);
  await runSweep(shared(), fakeDeps(ledgerPath).deps);
  await runSweep(shared(), fakeDeps(ledgerPath).deps); // a second pass with the same PRs writes nothing
  const sixth = redPr(10864, "ci-shard (1/8)", LATER_2, ["src/lib/garden.ts"]);
  await runSweep([...shared(), sixth], fakeDeps(ledgerPath).deps); // a newly red PR advances the same record

  const rows = handoffs(ledgerPath);
  assert.deepEqual(rows.map((row) => row.outcome), ["opened", "advanced"]);
  for (const row of rows) {
    assert.equal(row.offending_sha, POOL_MERGE, "the candidate is #10834's merge, in every red base and no green one");
    assert.deepEqual(row.red_checks, ["ci-shard"]);
    assert.deepEqual(row.red_detail, ["not ok a worker thread makes no setup dirs"]);
    assert.deepEqual(row.test_files, [NAMED_TEST]);
  }
  assert.deepEqual((rows[1]!.inherited_prs as Array<{ pr_number: number }>).map((p) => p.pr_number), [10852, 10854, 10829, 10864]);

  const records = [...mainRepairRecordsFromLedger(readLedgerLines(ledgerPath)).values()];
  assert.equal(records.length, 1, "one main-repair record however many PRs carry the red");
  assert.equal(records[0]!.offendingSha, POOL_MERGE);
  assert.deepEqual(records[0]!.inherited?.prs, [10852, 10854, 10829]);

  // The lane dispatches that record's fix once, while main's own runs conclude nothing.
  const fixes: MainRepairFixRequest[] = [];
  const lane: MainRepairLane = {
    openFixPr: async (request) => {
      fixes.push(request);
      return `https://github.com/${OWNER}/${REPO}/pull/10880`;
    },
    openRevertPr: async () => ({ refused: "not expected" }),
  };
  const errors: unknown[] = [];
  let clock = NOW;
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch: undeterminedMain(),
    issues: { create: async () => `https://github.com/${OWNER}/${REPO}/issues/1`, listOpen: async () => [], comment: async () => {}, closeWithComment: async () => {} },
    ledgerPath,
    runId: "DAEMON-W1-T8042",
    log: (step, extra) => {
      if (step === "main.health.error") errors.push(extra);
    },
    now: () => clock,
    readRequiredChecks: () => ["ci"],
    repair: lane,
  });
  await rung();
  await new Promise((resolve) => setImmediate(resolve));
  clock += 10 * 60_000;
  await rung();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(errors, []);
  assert.equal(fixes.length, 1, "one fix for the shared red, however many observations pass");
  assert.equal(fixes[0]!.offendingSha, POOL_MERGE);
  assert.deepEqual(fixes[0]!.testFiles, [NAMED_TEST]);
  assert.deepEqual(fixes[0]!.failingTestTitles, ["a worker thread makes no setup dirs"]);
  assert.match(fixes[0]!.reason, /the same red is on open PRs #10852, #10854, #10829/);
  assert.equal(readLedgerLines(ledgerPath).filter((row) => row.step === "main.repair.fix_dispatched").length, 1);
});

/** Main whose head has a run still in progress: the observation is undetermined. */
function undeterminedMain(): GhApiFetcher {
  return ((args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (path === `repos/${OWNER}/${REPO}`) return { default_branch: "main" };
    if (path === `repos/${OWNER}/${REPO}/commits/main`) return { sha: LATER_2 };
    if (path === `repos/${OWNER}/${REPO}/commits/${LATER_2}/check-runs?per_page=100`) {
      return { check_runs: [{ id: 1, name: "ci", status: "in_progress", conclusion: null }] };
    }
    if (path === `repos/${OWNER}/${REPO}/commits/${LATER_2}/status`) return { statuses: [] };
    if (path.startsWith(`repos/${OWNER}/${REPO}/actions/runs?`)) return { workflow_runs: [] };
    if (path === `repos/${OWNER}/${REPO}/commits/${POOL_MERGE}`) {
      return { parents: [{ sha: GREEN }], files: [{ filename: "scripts/pure-test-pool.mjs", additions: 120, deletions: 4 }] };
    }
    throw new Error(`unrouted read: ${args.join(" ")}`);
  }) as GhApiFetcher;
}

test("W1-T8042: a PR whose diff touches the named file keeps its own lane", async () => {
  const { deps, fixed, requeued } = fakeDeps();
  seedGreenMain(deps.ledgerPath);
  const toucher = redPr(10863, "ci-shard (1/8)", LATER_2, ["src/lib/worker-thread.ts", NAMED_TEST]);
  await runSweep([...shared(), toucher], deps);

  assert.deepEqual(fixed.map((f) => f.prNumber), [10863], "only the PR that may be the cause is sent to its fix lane");
  assert.deepEqual(requeued, []);
  assert.notEqual(disposed(deps.ledgerPath, 10863)?.red_cause, "main-inherited");
  for (const pr of shared()) assert.equal(disposed(deps.ledgerPath, pr.prNumber)?.red_cause, "main-inherited");
  const prs = (handoffs(deps.ledgerPath)[0]!.inherited_prs as Array<{ pr_number: number }>).map((p) => p.pr_number);
  assert.deepEqual(prs, [10852, 10854, 10829], "the toucher is not evidence the red is main's");
});

test("W1-T8042: a PR whose signature changes returns to its own lane on the next pass", async () => {
  const ledgerPath = tmpLedger();
  seedGreenMain(ledgerPath);
  await runSweep(shared(), fakeDeps(ledgerPath).deps);
  const [first, ...rest] = shared();
  const moved = { ...first!, headSha: sha("ead10852b"), ciFailures: [{ name: "ci-shard (7/8)", logTail: OWN_LOG, conclusion: "FAILURE" }],
    cancelledRequiredChecks: [] };
  const second = fakeDeps(ledgerPath);
  await runSweep([moved, ...rest], second.deps);

  assert.deepEqual(second.fixed.map((f) => f.prNumber), [10852], "its own red is its fix lane's again");
  for (const pr of rest) assert.equal(disposed(ledgerPath, pr.prNumber)?.red_cause, "main-inherited");
});

test("W1-T8042: no green base, or an unreadable merge-base read, classifies nothing", async () => {
  const noGreen = fakeDeps();
  await runSweep(shared(), noGreen.deps); // no green PR and no concluded main run to compare against
  assert.deepEqual(noGreen.fixed.map((f) => f.prNumber).sort(), [10829, 10852, 10854]);
  assert.equal(handoffs(noGreen.deps.ledgerPath).length, 0);

  const unreadable = fakeDeps(tmpLedger(), {
    mainInheritance: linearMain({ contains: async () => { throw new Error("HTTP 502 from compare"); } }),
  });
  seedGreenMain(unreadable.deps.ledgerPath);
  await runSweep(shared(), unreadable.deps);
  assert.deepEqual(unreadable.fixed.map((f) => f.prNumber).sort(), [10829, 10852, 10854], "every red keeps its own lane");
  const row = unreadable.logged.find((entry) => entry.step === "sweep.main_inherited.unreadable");
  assert.equal(row?.extra?.reason, "HTTP 502 from compare");
});

test("W1-T8042: the production reads ask GitHub for the diff, the merge base and ancestry", async () => {
  const asked: string[] = [];
  const reads = restMainInheritanceReads(OWNER, REPO, async (args) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    asked.push(path);
    if (path.endsWith("/pulls/10852/files?per_page=100")) return [{ filename: "src/lib/now-view.ts" }, { status: "removed" }];
    if (path.endsWith("/pulls/10999/files?per_page=100")) return Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}` }));
    if (path.endsWith(`/compare/main...${sha("ead10852")}`)) return { merge_base_commit: { sha: LATER_2 } };
    if (path.endsWith(`/compare/${POOL_MERGE}...${LATER_2}`)) return { status: "ahead" };
    if (path.endsWith(`/compare/${LATER_2}...${LATER_2}`)) return { status: "identical" };
    if (path.endsWith(`/compare/${POOL_MERGE}...${GREEN}`)) return { status: "behind" };
    return undefined;
  });
  const pr = redPr(10852, "ci-shard (7/8)", LATER_2, []);
  assert.deepEqual(await reads.changedFiles(pr), ["src/lib/now-view.ts"]);
  assert.equal(await reads.changedFiles({ ...pr, prNumber: 10999 }), undefined, "a full page may be truncated: unreadable");
  assert.equal(await reads.changedFiles({ ...pr, prNumber: 10998 }), undefined);
  assert.equal(await reads.mergeBase(pr), LATER_2);
  assert.equal(await reads.contains(LATER_2, POOL_MERGE), true);
  assert.equal(await reads.contains(LATER_2, LATER_2), true);
  assert.equal(await reads.contains(GREEN, POOL_MERGE), false);
  assert.ok(asked.includes(`repos/${OWNER}/${REPO}/compare/main...${sha("ead10852")}`), asked.join("\n"));
});

test("W1-T8042: main's own later red on the shared signature advances the same record", async () => {
  const ledgerPath = tmpLedger();
  seedGreenMain(ledgerPath);
  await runSweep(shared(), fakeDeps(ledgerPath).deps);

  const fixes: MainRepairFixRequest[] = [];
  const lane: MainRepairLane = {
    openFixPr: async (request) => {
      fixes.push(request);
      return `https://github.com/${OWNER}/${REPO}/pull/10880`;
    },
    openRevertPr: async () => ({ refused: "not expected" }),
  };
  const errors: unknown[] = [];
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch: redMain(),
    issues: { create: async () => `https://github.com/${OWNER}/${REPO}/issues/1`, listOpen: async () => [], comment: async () => {}, closeWithComment: async () => {} },
    ledgerPath,
    runId: "DAEMON-W1-T8042",
    log: (step, extra) => {
      if (step === "main.health.error") errors.push(extra);
    },
    now: () => NOW,
    readRequiredChecks: () => ["ci"],
    readCiFailures: (rollup) => (rollup ?? []).map((entry) => ({
      name: entry.name ?? "", conclusion: "FAILURE", logTail: entry.name === "ci" ? "a ci shard FAILED" : POOLED_LOG })),
    mergeReader: { prMerge: () => undefined, mergeBase: () => GREEN, prsMergedBetween: () => [] },
    repair: lane,
  });
  await rung();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(errors, []);
  assert.deepEqual(fixes.map((fix) => fix.offendingSha), [POOL_MERGE], "main's red is the record the PRs opened");
  assert.equal(readLedgerLines(ledgerPath).filter((row) => row.step === "main.repair.located").length, 0, "no second record");
  assert.equal(mainRepairRecordsFromLedger(readLedgerLines(ledgerPath)).size, 1);
});

/** Main red on its own head: `ci` and the shard fail there; the merge before #10834 was green. */
function redMain(): GhApiFetcher {
  const runs = [{ id: 902, head: LATER_2, conclusion: "failure" }, { id: 601, head: GREEN, conclusion: "success" }];
  const jobs = (conclusion: string) => conclusion === "failure"
    ? [{ id: 1, name: "ci", status: "completed", conclusion }, { id: 2, name: "ci-shard (7/8)", status: "completed", conclusion }]
    : [{ id: 1, name: "ci", status: "completed", conclusion }];
  return ((args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (path === `repos/${OWNER}/${REPO}`) return { default_branch: "main" };
    if (path === `repos/${OWNER}/${REPO}/commits/main`) return { sha: LATER_2 };
    if (path === `repos/${OWNER}/${REPO}/commits/${LATER_2}/check-runs?per_page=100`) return { check_runs: jobs("failure") };
    if (path === `repos/${OWNER}/${REPO}/commits/${LATER_2}/status`) return { statuses: [] };
    if (path.startsWith(`repos/${OWNER}/${REPO}/actions/runs?`)) {
      return { workflow_runs: runs.map((run) => ({ id: run.id, name: "CI", head_sha: run.head, status: "completed", conclusion: run.conclusion })) };
    }
    const runJobs = /actions\/runs\/(\d+)\/jobs\?per_page=100$/.exec(path)?.[1];
    if (runJobs) return { jobs: jobs(runs.find((run) => run.id === Number(runJobs))?.conclusion ?? "success") };
    if (path === `repos/${OWNER}/${REPO}/commits/${POOL_MERGE}`) {
      return { parents: [{ sha: GREEN }], files: [{ filename: "scripts/pure-test-pool.mjs", additions: 120, deletions: 4 }] };
    }
    throw new Error(`unrouted read: ${args.join(" ")}`);
  }) as GhApiFetcher;
}
