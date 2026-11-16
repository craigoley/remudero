/**
 * A RED MAIN WHOSE RUN HISTORY WINDOW HOLDS NO GREEN RUN REUSES ITS LOCATED CULPRIT (W1-T13135).
 *
 * 2026-11-15: main was red for 13 hours. The lane located 580877d7c (test-slow) at 15:54Z; a false green
 * closed that repair at 18:06Z (`main.repair.resolved` by "other", no PR closed). The same red came back
 * at 18:25Z, and by then main's one page of 100 push runs held no green CI run, so every pass wrote
 * `main.repair.unlocated` "window holds no green run" until an unrelated merge ended the red at 03:09Z.
 *
 * These fixtures replay that ledger against the real rung, with a run history of red and cancelled CI only.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AsyncIssueGateway } from "#src/lib/escalate.js";
import {
  buildMainHealthRung,
  MAIN_REPAIR_REUSE_WINDOW_MS,
  mainRedSignature,
  mainRepairRecordsFromLedger,
  type MainRepairFixRequest,
  type MainRepairLane,
} from "#src/lib/main-health-rung.js";
import type { GhApiFetcher } from "#src/lib/open-prs-rest.js";
import { readLedgerLines } from "#src/lib/status.js";
import { mainRedFields, type CiFailure, type RollupCheckEntry } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const OWNER = "craigoley";
const REPO = "remudero";
const sha = (prefix: string): string => prefix.padEnd(40, "0");
const CULPRIT = sha("580877d7"); // located for this red at 15:54Z
const SHARD = "ci-shard (5/8)";
const SLOW_LOG = "not ok 7 - test-slow: a suite ran over its time budget\n";
const OTHER_LOG = "not ok 2 - a ledger row names its run\n";
const FIX_PR = `https://github.com/${OWNER}/${REPO}/pull/18790`;
const START_MS = Date.parse("2026-11-15T18:25:00Z");

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The red as the rung reads it from a shard log. */
const redOf = (log: string) =>
  mainRedFields(mainRedSignature(["ci", SHARD], [
    { name: "ci", conclusion: "FAILURE", logTail: "a ci shard FAILED" },
    { name: SHARD, conclusion: "FAILURE", logTail: log },
  ]));

/** Main as GitHub answers it: a red head and a push run page of red and cancelled CI runs, no green. */
function rig(ledgerPath: string, lane: MainRepairLane, shardLog: string) {
  let clock = START_MS;
  let head = sha("a0");
  const runs = (): Array<{ id: number; head: string; conclusion: string }> => [
    { id: 903, head, conclusion: "failure" },
    { id: 902, head: sha("c2"), conclusion: "cancelled" },
    { id: 901, head: sha("c1"), conclusion: "failure" },
    { id: 900, head: sha("c0"), conclusion: "cancelled" },
  ];
  const fetch = ((args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (args.includes("--method")) return {};
    if (path === `repos/${OWNER}/${REPO}`) return { default_branch: "main" };
    if (path === `repos/${OWNER}/${REPO}/commits/main`) return { sha: head };
    if (path === `repos/${OWNER}/${REPO}/commits/${head}/check-runs?per_page=100`) {
      return {
        check_runs: [
          { id: 1, name: "ci", status: "completed", conclusion: "failure" },
          { id: 2, name: SHARD, status: "completed", conclusion: "failure" },
        ],
      };
    }
    if (path === `repos/${OWNER}/${REPO}/commits/${head}/status`) return { statuses: [] };
    if (path.startsWith(`repos/${OWNER}/${REPO}/actions/runs?`)) {
      return {
        workflow_runs: runs().map((run) => ({
          id: run.id, name: "CI", head_sha: run.head, status: "completed", conclusion: run.conclusion, pull_requests: [{ number: run.id }],
        })),
      };
    }
    const jobs = /actions\/runs\/(\d+)\/jobs\?per_page=100$/.exec(path)?.[1];
    if (jobs) {
      const run = runs().find((r) => r.id === Number(jobs));
      return {
        jobs: run?.conclusion === "failure"
          ? [
              { id: run.id * 10, name: "ci", status: "completed", conclusion: "failure" },
              { id: run.id * 10 + 5, name: SHARD, status: "completed", conclusion: "failure" },
            ]
          : [{ id: Number(jobs) * 10, name: "ci", status: "completed", conclusion: "cancelled" }],
      };
    }
    if (/^repos\/craigoley\/remudero\/commits\/[0-9a-f]{40}$/.test(path)) {
      return { parents: [], files: [{ filename: "test/slow-suite.test.ts", additions: 40, deletions: 0 }] };
    }
    if (path === `repos/${OWNER}/${REPO}/pulls/18790`) return { state: "open", merged: false, head: { sha: sha("f1") } };
    throw new Error(`unrouted gh api call: ${args.join(" ")}`);
  }) as GhApiFetcher;
  const issues: AsyncIssueGateway = {
    create: async () => `https://github.com/${OWNER}/${REPO}/issues/18801`,
    listOpen: async () => [],
    comment: async () => {},
    closeWithComment: async () => {},
  };
  const logged: string[] = [];
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch,
    issues,
    ledgerPath,
    runId: "DAEMON-REUSE",
    log: (step) => logged.push(step),
    now: () => clock,
    readRequiredChecks: () => ["ci"],
    readCiFailures: (rollup: readonly RollupCheckEntry[] | undefined): CiFailure[] =>
      (rollup ?? []).map((entry) => ({ name: entry.name ?? "", conclusion: "FAILURE", logTail: entry.name === "ci" ? "a ci shard FAILED" : shardLog })),
    mergeReader: { prMerge: () => undefined, mergeBase: () => sha("9a"), prsMergedBetween: () => [] },
    repair: lane,
  });
  return {
    logged,
    observe: async (nextHead: string) => {
      head = nextHead;
      clock += 60_000;
      await rung();
      await flush();
    },
  };
}

function fakeLane(): MainRepairLane & { fixes: MainRepairFixRequest[] } {
  const fixes: MainRepairFixRequest[] = [];
  return { fixes, openFixPr: async (request) => (fixes.push(request), FIX_PR), openRevertPr: async () => ({ prUrl: FIX_PR }) };
}

/** The earlier repair of the red, as the ledger holds it: located, then resolved by `by`. */
function priorRepair(ledgerPath: string, opts: { ageMs: number; log?: string; by?: string }): string {
  const locatedAt = new Date(START_MS - opts.ageMs).toISOString();
  const rows = [
    { ts: locatedAt, step: "main.repair.located", surface: "main", head_sha: sha("b0"), offending_sha: CULPRIT, offending_pr: 18744,
      failing_checks: ["ci", SHARD], test_files: [], method: "first-red-run", ...redOf(opts.log ?? SLOW_LOG) },
    { ts: new Date(START_MS - opts.ageMs + 60_000).toISOString(), step: "main.repair.fix_dispatched", surface: "main", offending_sha: CULPRIT, head_sha: sha("b0") },
    { ts: new Date(START_MS - 20 * 60_000).toISOString(), step: "main.repair.resolved", surface: "main", offending_sha: CULPRIT,
      head_sha: sha("b1"), by: opts.by ?? "other", closed_prs: [] },
  ];
  appendFileSync(ledgerPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return locatedAt;
}

const rowsOf = (ledgerPath: string, step: string) => readLedgerLines(ledgerPath).filter((row) => row.step === step); // ledger-read-intent: live

function inScratchDir(body: (ledgerPath: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reuse-located-`));
    try {
      await body(join(root, "ledger.ndjson"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  "W1-T13135 criterion 1: a red whose run history window holds no green run reuses the culprit located for the same red",
  inScratchDir(async (ledgerPath) => {
    const locatedAt = priorRepair(ledgerPath, { ageMs: 2.5 * 60 * 60_000 });
    const lane = fakeLane();
    const daemon = rig(ledgerPath, lane, SLOW_LOG);
    await daemon.observe(sha("a1"));
    assert.equal(rowsOf(ledgerPath, "main.repair.unlocated").length, 0, "the red is not filed as unlocated");
    const located = rowsOf(ledgerPath, "main.repair.located");
    assert.equal(located.length, 2);
    assert.equal(located[1]?.offending_sha, CULPRIT);
    assert.equal(located[1]?.offending_pr, 18744);
    assert.equal(located[1]?.method, "reused-located");
    assert.equal(located[1]?.reused_from, locatedAt, "the reused row names the earlier location's ts");
    assert.equal(located[1]?.head_sha, sha("a1"));
    assert.equal(lane.fixes.length, 1, "openFixPr is called once");
    assert.equal(lane.fixes[0]?.offendingSha, CULPRIT);
    assert.match(lane.fixes[0]!.reason, /holds no green run/);
    assert.equal(rowsOf(ledgerPath, "main.repair.fix_dispatched").at(-1)?.offending_sha, CULPRIT);
  }),
);

for (const [name, opts] of [
  ["a different red", { log: OTHER_LOG }],
  ["a record resolved by its fix", { by: "fix" }],
  ["a record resolved by its revert", { by: "revert" }],
] as const) {
  test(
    `W1-T13135 criterion 2: ${name} is not reused, and the red is filed as unlocated`,
    inScratchDir(async (ledgerPath) => {
      priorRepair(ledgerPath, { ageMs: 2.5 * 60 * 60_000, ...opts });
      const lane = fakeLane();
      const daemon = rig(ledgerPath, lane, SLOW_LOG);
      await daemon.observe(sha("a1"));
      const [unlocated, ...more] = rowsOf(ledgerPath, "main.repair.unlocated");
      assert.equal(more.length, 0);
      assert.match(String(unlocated?.reason), /window holds no green run/);
      assert.equal(rowsOf(ledgerPath, "main.repair.located").length, 1, "no location is reused");
      assert.equal(lane.fixes.length, 0);
    }),
  );
}

test(
  "W1-T13135 criterion 3: a location older than MAIN_REPAIR_REUSE_WINDOW_MS is not reused",
  inScratchDir(async (ledgerPath) => {
    assert.equal(MAIN_REPAIR_REUSE_WINDOW_MS, 24 * 60 * 60_000);
    priorRepair(ledgerPath, { ageMs: MAIN_REPAIR_REUSE_WINDOW_MS });
    const lane = fakeLane();
    const daemon = rig(ledgerPath, lane, SLOW_LOG);
    await daemon.observe(sha("a1")); // one minute later: 24 h and 1 min after the location
    assert.equal(rowsOf(ledgerPath, "main.repair.unlocated").length, 1);
    assert.equal(rowsOf(ledgerPath, "main.repair.located").length, 1);
    assert.equal(lane.fixes.length, 0);
  }),
);

test(
  "W1-T13135 criterion 3: a location just inside MAIN_REPAIR_REUSE_WINDOW_MS is reused",
  inScratchDir(async (ledgerPath) => {
    priorRepair(ledgerPath, { ageMs: MAIN_REPAIR_REUSE_WINDOW_MS - 2 * 60_000 });
    const lane = fakeLane();
    const daemon = rig(ledgerPath, lane, SLOW_LOG);
    await daemon.observe(sha("a1"));
    assert.equal(rowsOf(ledgerPath, "main.repair.unlocated").length, 0);
    assert.equal(rowsOf(ledgerPath, "main.repair.located").at(-1)?.method, "reused-located");
    assert.equal(lane.fixes.length, 1);
  }),
);

test(
  "W1-T13135 criterion 4: a reused location is written once per streak; the next red pass advances its record",
  inScratchDir(async (ledgerPath) => {
    priorRepair(ledgerPath, { ageMs: 2.5 * 60 * 60_000 });
    const lane = fakeLane();
    const daemon = rig(ledgerPath, lane, SLOW_LOG);
    await daemon.observe(sha("a1"));
    await daemon.observe(sha("a2"));
    await daemon.observe(sha("a3"));
    assert.equal(rowsOf(ledgerPath, "main.repair.located").length, 2, "one reused location for the streak");
    assert.equal(rowsOf(ledgerPath, "main.repair.unlocated").length, 0);
    assert.equal(lane.fixes.length, 1, "the reopened record's fix PR is advanced, not dispatched again");
    const record = mainRepairRecordsFromLedger(readLedgerLines(ledgerPath)).get(CULPRIT); // ledger-read-intent: live
    assert.equal(record?.resolved, false, "the reused location opened a fresh record");
    assert.equal(record?.fixPrUrl, FIX_PR);
  }),
);
