/**
 * A RED MAIN IS REPAIRED ONCE PER RED, AND REVERTED ONLY OVER A PROVEN CULPRIT.
 *
 * 2026-10-10: main went red on the comment-load ceiling alone; no test failed, and #10712 fixed it.
 * The red-main repair lane (W1-T6403) meanwhile wrote `main.repair.located` seven times, naming a
 * different "offending merge" on each pass (b90cb519, e91d490f, faca80c7, 4624f3707, 4e1831b94,
 * 4f2a2ee8b, de219e4fd), and dispatched a fresh LLM fix worker after each — because the locator
 * counted a CANCELLED push run as red, and the lane deduped by the located sha. Every located row had
 * `test_files: []`: only the `ci` aggregator's log was read, never the failing shard's. And the
 * revert-after-stall step would have reverted whichever sha was located when the stall fired.
 *
 * These fixtures replay that red against the real rung.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AsyncIssueGateway } from "../src/lib/escalate.js";
import type { FixProgressInput, FixProgressVerdict } from "../src/lib/fix-progress-judge.js";
import {
  buildMainHealthRung,
  describeMainRed,
  MAIN_HEALTH_RUN_HISTORY_TTL_MS,
  mainRedSignature,
  mainRedSignaturesMatch,
  mainRepairRecordsFromLedger,
  type MainHealthRungDeps,
  type MainRepairFixRequest,
  type MainRepairLane,
  type MainRepairRevertRequest,
} from "../src/lib/main-health-rung.js";
import type { GhApiFetcher } from "../src/lib/open-prs-rest.js";
import { readLedgerLines } from "../src/lib/status.js";
import { mainHealthFirstRedCommitFromRunHistory, type CiFailure, type RollupCheckEntry } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const OWNER = "craigoley";
const REPO = "remudero";
const sha = (prefix: string): string => prefix.padEnd(40, "0");
const GREEN = sha("9a11ee00"); // main's last green merge
const CULPRIT = sha("de219e4f"); // the merge that crossed the ceiling
const PARENT = sha("5ba5e0"); // its first parent
const FIX_PR = `https://github.com/${OWNER}/${REPO}/pull/10790`;
const REVERT_PR = `https://github.com/${OWNER}/${REPO}/pull/10791`;
const SHARD = "ci-shard (3/8)";
const CEILING_LOG = [
  "2026-10-10T18:40:01.0000000Z ℹ fail 0",
  "2026-10-10T18:40:02.0000000Z ##[group]main-ceiling-drift:comment-load-ratchet",
  "2026-10-10T18:40:02.1000000Z comment-load-ratchet: BLOCKED -- 1 file(s) carry more comment lines than their recorded ceiling:",
  "2026-10-10T18:40:02.2000000Z main-ceiling-drift: comment-load-ratchet BLOCKED on main itself",
].join("\n");
const AGGREGATOR_LOG = "a ci shard FAILED — open the shard log";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Run {
  id: number;
  head: string;
  conclusion: "success" | "failure" | "cancelled";
}

/** Main as GitHub answers it: the head and its check runs, the push run history, each run's jobs,
 *  each commit's first parent, and the repair PRs. */
interface World {
  head: string;
  runs: Run[];
  parents: Map<string, string>;
  shardLog: string;
  prs: Map<string, { state: "open" | "closed"; merged: boolean; head: string }>;
  jobsUnreadable?: boolean;
}

function world(): World {
  return {
    head: sha("4624f370"),
    runs: [],
    parents: new Map([[CULPRIT, PARENT]]),
    shardLog: CEILING_LOG,
    prs: new Map([
      ["10790", { state: "open", merged: false, head: sha("f1") }],
      ["10791", { state: "open", merged: false, head: sha("7e") }],
    ]),
  };
}

/** Main's red streak as the 2026-10-10 locator saw it on one pass: the head red, `located` the first
 *  completed red after the green, and a cancelled run between them that concluded nothing. */
function streak(w: World, located: string, n: number): void {
  w.runs = [
    { id: 900 + n, head: w.head, conclusion: "failure" },
    { id: 800 + n, head: sha(`c${n}`), conclusion: "cancelled" },
    { id: 700 + n, head: located, conclusion: "failure" },
    { id: 600 + n, head: GREEN, conclusion: "success" },
  ];
}

function rig(w: World, lane: MainRepairLane, ledgerPath: string, overrides: Partial<MainHealthRungDeps> = {}) {
  let clock = Date.parse("2026-10-10T18:38:00Z");
  const jobsOf = (run: Run) =>
    run.conclusion === "failure"
      ? [
          { id: run.id * 10, name: "ci", status: "completed", conclusion: "failure" },
          { id: run.id * 10 + 3, name: SHARD, status: "completed", conclusion: "failure" },
        ]
      : [{ id: run.id * 10, name: "ci", status: "completed", conclusion: run.conclusion }];
  const fetch = ((args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (args.includes("--method")) {
      const pr = /pulls\/(\d+)$/.exec(path)?.[1];
      if (pr && args.includes("state=closed")) w.prs.get(pr)!.state = "closed";
      return {};
    }
    if (path === `repos/${OWNER}/${REPO}`) return { default_branch: "main" };
    if (path === `repos/${OWNER}/${REPO}/commits/main`) return { sha: w.head };
    if (path === `repos/${OWNER}/${REPO}/commits/${w.head}/check-runs?per_page=100`) {
      return {
        check_runs: [
          { id: 1, name: "ci", status: "completed", conclusion: "failure" },
          { id: 2, name: SHARD, status: "completed", conclusion: "failure" },
          { id: 3, name: "ci-shard (4/8)", status: "completed", conclusion: "success" },
        ],
      };
    }
    if (path === `repos/${OWNER}/${REPO}/commits/${w.head}/status`) return { statuses: [] };
    if (path.startsWith(`repos/${OWNER}/${REPO}/actions/runs?`)) {
      return {
        workflow_runs: w.runs.map((run) => ({
          id: run.id,
          name: "CI",
          head_sha: run.head,
          status: "completed",
          conclusion: run.conclusion,
          pull_requests: [{ number: run.id }],
        })),
      };
    }
    const jobs = /actions\/runs\/(\d+)\/jobs\?per_page=100$/.exec(path)?.[1];
    if (jobs) {
      if (w.jobsUnreadable) throw new Error("HTTP 502");
      const run = w.runs.find((r) => r.id === Number(jobs));
      return { jobs: run ? jobsOf(run) : [] };
    }
    const commit = /^repos\/craigoley\/remudero\/commits\/([0-9a-f]{40})$/.exec(path)?.[1];
    if (commit) {
      const parent = w.parents.get(commit);
      return { ...(parent ? { parents: [{ sha: parent }] } : { parents: [] }), files: [{ filename: "src/lib/daemon.ts", additions: 9, deletions: 0 }] };
    }
    const pull = /^repos\/craigoley\/remudero\/pulls\/(\d+)$/.exec(path)?.[1];
    if (pull && w.prs.has(pull)) {
      const pr = w.prs.get(pull)!;
      return { state: pr.state, merged: pr.merged, head: { sha: pr.head } };
    }
    throw new Error(`unrouted gh api call: ${args.join(" ")}`);
  }) as GhApiFetcher;
  const created: Array<{ title: string; body: string }> = [];
  const issues: AsyncIssueGateway = {
    create: async (title, body) => {
      created.push({ title, body });
      return `https://github.com/${OWNER}/${REPO}/issues/${10800 + created.length}`;
    },
    listOpen: async () => [],
    comment: async () => {},
    closeWithComment: async () => {},
  };
  const logReads: string[][] = [];
  const readCiFailures = (rollup: readonly RollupCheckEntry[] | undefined): CiFailure[] => {
    const names = (rollup ?? []).map((entry) => entry.name ?? "");
    logReads.push(names);
    return names.map((name) => ({ name, conclusion: "FAILURE", logTail: name === "ci" ? AGGREGATOR_LOG : w.shardLog }));
  };
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch,
    issues,
    ledgerPath,
    runId: "DAEMON-REDKEY",
    log: () => {},
    now: () => clock,
    readRequiredChecks: () => ["ci"],
    readCiFailures,
    mergeReader: { prMerge: () => undefined, mergeBase: () => GREEN, prsMergedBetween: () => [] },
    repair: lane,
    ...overrides,
  });
  return {
    created,
    logReads,
    observe: async (advanceMs = 60_000) => {
      clock += advanceMs;
      await rung();
      await flush();
    },
  };
}

interface FakeLane extends MainRepairLane {
  fixes: MainRepairFixRequest[];
  reverts: MainRepairRevertRequest[];
}

function fakeLane(opts: { noPr?: boolean } = {}): FakeLane {
  const fixes: MainRepairFixRequest[] = [];
  const reverts: MainRepairRevertRequest[] = [];
  return {
    fixes,
    reverts,
    openFixPr: async (request) => {
      fixes.push(request);
      return opts.noPr ? undefined : FIX_PR;
    },
    openRevertPr: async (request) => {
      reverts.push(request);
      return { prUrl: REVERT_PR };
    },
  };
}

const rowsOf = (ledgerPath: string, step: string) => readLedgerLines(ledgerPath).filter((row) => row.step === step); // ledger-read-intent: live

function withLedger(body: (ledgerPath: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}redkey-`));
    try {
      await body(join(root, "ledger.ndjson"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  "red-main repair: a red whose locator names a new merge each pass dispatches ONE fix, keyed by its red signature",
  withLedger(async (ledgerPath) => {
    const w = world();
    const lane = fakeLane();
    const daemon = rig(w, lane, ledgerPath);
    // Four passes, each on a new head of the same red, each naming a different "first red" merge.
    const located = [sha("b90cb519"), sha("e91d490f"), sha("faca80c7"), sha("4e1831b9")];
    for (const [n, merge] of located.entries()) {
      w.head = sha(`a${n}`);
      w.parents.set(merge, sha(`e${n}`));
      streak(w, merge, n);
      await daemon.observe();
    }
    assert.equal(lane.fixes.length, 1, "one fix worker for one red, however many merges the locator names");
    assert.equal(rowsOf(ledgerPath, "main.repair.located").length, 1);
    assert.equal(rowsOf(ledgerPath, "main.repair.fix_dispatched").length, 1);
    const [row] = rowsOf(ledgerPath, "main.repair.located");
    assert.deepEqual(row?.red_checks, ["ci", "ci-shard"], "the failing shard, its index folded, is part of the red");
    assert.deepEqual(row?.red_detail, ["BLOCKED comment-load-ratchet"], "read from the failing SHARD's own log");
    assert.ok(
      daemon.logReads.some((names) => names.includes(SHARD)),
      "the failing shard's log is read, not only the ci aggregator's",
    );
    assert.ok(!daemon.logReads.some((names) => names.includes("ci-shard (4/8)")), "a passing shard's log is not read");
    assert.match(lane.fixes[0]!.logExcerpt, /comment-load-ratchet BLOCKED on main itself/, "the worker sees the shard's log");
    assert.equal(daemon.created.length, 0);

    // A DIFFERENT red on a later head is its own repair.
    w.head = sha("a9");
    w.shardLog = "not ok 3 - a ledger row names its run\n";
    streak(w, sha("4f2a2ee8"), 9);
    await daemon.observe();
    assert.equal(lane.fixes.length, 2, "a new red signature gets its own fix");
    assert.deepEqual(rowsOf(ledgerPath, "main.repair.located").at(-1)?.red_detail, ["not ok a ledger row names its run"]);
  }),
);

test(
  "red-main repair: an attempt that ended without a PR asks the fix-progress judge, never re-dispatches by rote",
  withLedger(async (ledgerPath) => {
    const w = world();
    const lane = fakeLane({ noPr: true }); // every fix run ends `main-repair.no_pr`
    const asked: FixProgressInput[] = [];
    const rulings: FixProgressVerdict[] = [
      { verdict: "change-approach", approach: "record the ceiling with the ratchet's own writer", reason: "the worker never saw the shard log" },
      { verdict: "escalate", loop: "no-pr", reason: "two attempts opened nothing" },
    ];
    const daemon = rig(w, lane, ledgerPath, {
      judgeRepairProgress: async (input) => {
        asked.push(input);
        return rulings[asked.length - 1];
      },
    });
    // The culprit is provable throughout: its own run is red on this red, its first parent's is green.
    const proven: Run[] = [
      { id: 1, head: CULPRIT, conclusion: "failure" },
      { id: 2, head: PARENT, conclusion: "success" },
    ];
    streak(w, CULPRIT, 0);
    await daemon.observe(); // located; attempt 1 ends no_pr
    assert.equal(lane.fixes.length, 1);
    for (const n of [1, 2, 3]) {
      w.head = sha(`b${n}`);
      streak(w, sha(`d${n}`), n); // the locator drifts; the red does not
      w.runs.unshift(...proven);
      await daemon.observe();
    }
    assert.equal(asked.length, 2, "the judge is asked once per ended attempt, not once per pass");
    assert.equal(lane.fixes.length, 2, "the judge's change-approach is the ONLY second attempt");
    assert.equal(asked[0]!.rounds.length, 1);
    assert.equal(asked[0]!.signals.noOpRounds, 1);
    assert.match(asked[0]!.parkedReason ?? "", /opened no fix PR/);
    assert.match(lane.fixes[1]!.reason, /record the ceiling with the ratchet's own writer/);
    assert.equal(lane.fixes[1]!.offendingSha, CULPRIT, "the further attempt stays on the repair's own merge");
    assert.deepEqual(
      rowsOf(ledgerPath, "main.repair.progress_judged").map((row) => [row.attempt, row.verdict]),
      [
        [1, "change-approach"],
        [2, "escalate"],
      ],
    );
    assert.equal(rowsOf(ledgerPath, "main.repair.located").length, 1);
    // The judge ruled no further attempt and the culprit is proven, so the one revert follows.
    assert.equal(lane.reverts.length, 1);
    assert.match(lane.reverts[0]!.whyFixInsufficient, /judge ruled no further attempt/);
    assert.match(lane.reverts[0]!.whyFixInsufficient, /culprit proven: .*first parent .* is green/);
  }),
);

test(
  "red-main repair: a judge that cannot rule decides nothing, and the next pass asks again",
  withLedger(async (ledgerPath) => {
    const w = world();
    const lane = fakeLane({ noPr: true });
    let calls = 0;
    const daemon = rig(w, lane, ledgerPath, {
      judgeRepairProgress: async () => {
        calls += 1;
        return undefined;
      },
    });
    streak(w, CULPRIT, 0);
    await daemon.observe();
    await daemon.observe();
    await daemon.observe();
    assert.equal(calls, 2, "an unavailable ruling is asked for again on the next pass");
    assert.equal(lane.fixes.length, 1);
    assert.equal(lane.reverts.length, 0);
    assert.equal(rowsOf(ledgerPath, "main.repair.progress_judged").length, 0);
    assert.equal(daemon.created.length, 0, "the lane still owns the red while the judge is asked");
  }),
);

test(
  "red-main repair: a revert is withheld and escalated once unless the located merge is proven the culprit",
  withLedger(async (ledgerPath) => {
    const cases: Array<{ name: string; arrange: (w: World) => void; reason: RegExp }> = [
      {
        name: "the first parent's run was cancelled",
        arrange: (w) => w.runs.push({ id: 2, head: PARENT, conclusion: "cancelled" }),
        reason: new RegExp(`first parent \`${PARENT}\` has no completed run`),
      },
      {
        name: "the first parent's run is red too",
        arrange: (w) => w.runs.push({ id: 2, head: PARENT, conclusion: "failure" }),
        reason: new RegExp(`first parent \`${PARENT}\`'s completed run 2 is red, not green`),
      },
      {
        name: "the located merge's own run is red on another red",
        arrange: (w) => {
          w.runs.push({ id: 2, head: PARENT, conclusion: "success" });
          w.shardLog = "not ok 1 - an unrelated test\n";
        },
        reason: /own completed run \d+ is red on ci, ci-shard \[not ok an unrelated test\], not on this repair's/,
      },
      {
        name: "the located merge's own run is green",
        arrange: (w) => {
          w.runs.find((run) => run.head === CULPRIT)!.conclusion = "success";
          w.runs.push({ id: 2, head: PARENT, conclusion: "success" });
        },
        reason: /own completed run \d+ is green, not red/,
      },
      {
        name: "GitHub names no first parent",
        arrange: (w) => {
          w.runs.push({ id: 2, head: PARENT, conclusion: "success" });
          w.parents.delete(CULPRIT);
        },
        reason: /^$/, // unreadable: decides nothing, so no withheld row and no revert
      },
    ];
    for (const c of cases) {
      const w = world();
      const lane = fakeLane();
      const path = `${ledgerPath}.${cases.indexOf(c)}`;
      const daemon = rig(w, lane, path);
      streak(w, CULPRIT, 0);
      await daemon.observe();
      w.prs.get("10790")!.state = "closed"; // the fix PR closed unmerged: the revert step is reached
      c.arrange(w);
      await daemon.observe(MAIN_HEALTH_RUN_HISTORY_TTL_MS); // a fresh read of main's push run history
      await daemon.observe();
      await daemon.observe();
      assert.equal(lane.reverts.length, 0, `${c.name}: no revert of an unproven culprit`);
      const withheld = rowsOf(path, "main.repair.revert_withheld");
      if (c.reason.source === "^$") {
        assert.equal(withheld.length, 0, `${c.name}: an unreadable proof decides nothing`);
        assert.equal(daemon.created.length, 0, c.name);
        continue;
      }
      assert.equal(withheld.length, 1, `${c.name}: withheld once`);
      assert.match(String(withheld[0]?.reason), c.reason, c.name);
      assert.equal(withheld[0]?.offending_sha, CULPRIT);
      assert.equal(daemon.created.length, 1, `${c.name}: escalated once`);
      assert.match(daemon.created[0]!.body, /withheld its revert of `de219e4f\d*`/, `${c.name}: the escalation carries the evidence`);
      assert.equal(lane.fixes.length, 1, `${c.name}: and no further fix worker`);
    }

    // The 2026-10-10 shape: the located merge's own push run was cancelled, so nothing is proven.
    const w = world();
    const lane = fakeLane({ noPr: true });
    const daemon = rig(w, lane, `${ledgerPath}.cancelled`);
    streak(w, CULPRIT, 0);
    await daemon.observe();
    w.runs = w.runs.filter((run) => run.head !== CULPRIT);
    w.runs.push({ id: 2, head: PARENT, conclusion: "success" });
    await daemon.observe(MAIN_HEALTH_RUN_HISTORY_TTL_MS);
    assert.equal(lane.reverts.length, 0);
    assert.match(String(rowsOf(`${ledgerPath}.cancelled`, "main.repair.revert_withheld")[0]?.reason), /has no completed run carrying the required checks/);

    // An unreadable jobs page decides nothing either.
    const w2 = world();
    const lane2 = fakeLane({ noPr: true });
    const daemon2 = rig(w2, lane2, `${ledgerPath}.jobs`);
    streak(w2, CULPRIT, 0);
    await daemon2.observe();
    w2.jobsUnreadable = true;
    await daemon2.observe();
    assert.equal(lane2.reverts.length, 0);
    assert.equal(rowsOf(`${ledgerPath}.jobs`, "main.repair.revert_withheld").length, 0);
  }),
);

test("red-main repair: the first red never names a merge whose only run was cancelled", () => {
  const history = [
    { headSha: "R", runId: 4, conclusion: "failure" },
    { headSha: "C2", runId: 3, conclusion: "cancelled" },
    { headSha: "C1", runId: 2, conclusion: "cancelled" },
    { headSha: "G", runId: 1, conclusion: "success" },
  ];
  assert.deepEqual(mainHealthFirstRedCommitFromRunHistory(history), { headSha: "R", afterGreenSha: "G" });
  assert.equal(
    mainHealthFirstRedCommitFromRunHistory([history[1]!, history[3]!]),
    undefined,
    "a streak of only cancelled runs names no first red",
  );
});

test("red-main repair: a red signature folds shard indices and reads BLOCKED gates and failing tests", () => {
  const red = mainRedSignature(["ci", "ci-shard (3/8)", "ci-shard (5/8)"], [
    { name: "ci-shard (3/8)", conclusion: "FAILURE", logTail: CEILING_LOG },
    { name: "ci-shard (5/8)", conclusion: "FAILURE", logTail: "not ok 2 - a row names its run\n" },
    { name: "ci", conclusion: "FAILURE", logTail: "", logUnavailable: { kind: "fetch-failed", detail: "HTTP 502" } },
  ]);
  assert.deepEqual(red, { checks: ["ci", "ci-shard"], detail: ["BLOCKED comment-load-ratchet", "not ok a row names its run"] });
  const unread = mainRedSignature(["ci-shard (7/8)", "ci"], undefined);
  assert.deepEqual(unread, { checks: ["ci", "ci-shard"] });
  assert.equal(describeMainRed(unread), "ci, ci-shard [no log read]");
  assert.equal(describeMainRed({ checks: ["ci"], detail: [] }), "ci [no gate or test named]");
  assert.ok(mainRedSignaturesMatch(red, unread), "an unread log matches on the failing checks alone");
  assert.ok(!mainRedSignaturesMatch(red, { checks: ["ci", "ci-shard"], detail: ["not ok another"] }));
  assert.ok(!mainRedSignaturesMatch(red, { checks: ["ci"] }));

  // The ledger fold keeps the red, every attempt, and the judge's rulings of each verdict shape.
  const at = { task_id: "MAIN-HEALTH", offending_sha: CULPRIT };
  const records = mainRepairRecordsFromLedger([
    { ...at, step: "main.repair.located", red_checks: ["ci"], red_detail: null },
    { ...at, step: "main.repair.fix_dispatched", head_sha: "h1" },
    { ...at, step: "main.repair.fix_opened", pr_url: FIX_PR },
    { ...at, step: "main.repair.progress_judged", attempt: 1, verdict: "continue", reason: "r" },
    { ...at, step: "main.repair.fix_dispatched" },
    { ...at, step: "main.repair.progress_judged", attempt: 2, verdict: "nonsense", reason: "r" },
  ]);
  const record = records.get(CULPRIT)!;
  assert.deepEqual(record.red, { checks: ["ci"] });
  assert.deepEqual(record.attempts, [{ headSha: "h1", outcome: "opened" }, {}]);
  assert.equal(record.fixPrUrl, undefined, "a further attempt starts clean");
  assert.deepEqual(record.judgement, { attempt: 1, verdict: { verdict: "continue", reason: "r" } }, "an unparseable verdict is not a ruling");
});
