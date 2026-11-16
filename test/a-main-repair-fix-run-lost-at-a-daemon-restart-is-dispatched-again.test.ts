/**
 * W1-T13134 — A MAIN-REPAIR FIX RUN LOST AT A DAEMON RESTART IS DISPATCHED AGAIN.
 *
 * 2026-11-15: the red-main repair lane dispatched its fix run for 580877d7c at 15:54:32Z under daemon
 * run DAEMON-1794753773792-7. That process drained and restarted at 16:00Z; the fix run never
 * reported. The next process waited out the stall window and went to the revert, which was withheld:
 * no fix attempt ever ran for that red. The fix run lives only in the process that dispatched it, so a
 * `fix_dispatched` row from another daemon run with no outcome after it is a lost run. These fixtures
 * drive the real rung with a fake lane over a ledger fixture, one rig per daemon run id.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AsyncIssueGateway } from "../src/lib/escalate.js";
import {
  buildMainHealthRung,
  MAIN_REPAIR_LOST_RUN_LIMIT,
  MAIN_REPAIR_STALL_MS,
  type MainRepairFixRequest,
  type MainRepairLane,
  type MainRepairRevertRequest,
} from "../src/lib/main-health-rung.js";
import type { GhApiFetcher } from "../src/lib/open-prs-rest.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { readLedgerLines } from "../src/lib/status.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const OWNER = "craigoley";
const REPO = "remudero";
const HEAD = "a52dd276".padEnd(40, "0");
const RED_MERGE = "580877d7".padEnd(40, "0");
const GREEN = "5e1f0a00".padEnd(40, "0");
const FIX_PR = `https://github.com/${OWNER}/${REPO}/pull/10102`;
const REVERT_PR = `https://github.com/${OWNER}/${REPO}/pull/10103`;
const LOG = "# Subtest: test/test-slow.test.ts\nnot ok 1 - a slow test\n  error: 'timed out'";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface FakeLane extends MainRepairLane {
  fixes: MainRepairFixRequest[];
  reverts: MainRepairRevertRequest[];
}

/** A lane whose fix runs never settle unless `settle` is given: the run is still in flight. */
function fakeLane(settle?: () => Promise<string | undefined>): FakeLane {
  const fixes: MainRepairFixRequest[] = [];
  const reverts: MainRepairRevertRequest[] = [];
  return {
    fixes,
    reverts,
    openFixPr: (request) => {
      fixes.push(request);
      return settle ? settle() : new Promise<string>(() => {});
    },
    openRevertPr: async (request) => {
      reverts.push(request);
      return { prUrl: REVERT_PR };
    },
  };
}

let clock = Date.parse("2026-11-15T16:10:00Z");

function rig(runId: string, lane: MainRepairLane, ledgerPath: string) {
  const fetch = ((args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (args.includes("--method")) return {};
    if (path === `repos/${OWNER}/${REPO}`) return { default_branch: "main" };
    if (path === `repos/${OWNER}/${REPO}/commits/main`) return { sha: HEAD };
    if (path === `repos/${OWNER}/${REPO}/commits/${HEAD}/check-runs?per_page=100`) {
      return { check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] };
    }
    if (path === `repos/${OWNER}/${REPO}/commits/${HEAD}/status`) return { statuses: [] };
    if (path.startsWith(`repos/${OWNER}/${REPO}/actions/runs?`)) {
      return {
        workflow_runs: [
          { id: 3, name: "ci", head_sha: HEAD, status: "completed", conclusion: "failure" },
          {
            id: 2,
            name: "ci",
            head_sha: RED_MERGE,
            status: "completed",
            conclusion: "failure",
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/2`,
            pull_requests: [{ number: 18700, html_url: `https://github.com/${OWNER}/${REPO}/pull/18700` }],
          },
          { id: 1, name: "ci", head_sha: GREEN, status: "completed", conclusion: "success" },
        ],
      };
    }
    if (path === `repos/${OWNER}/${REPO}/commits/${RED_MERGE}`) {
      return { parents: [{ sha: GREEN }], files: [{ filename: "test/test-slow.test.ts", additions: 1, deletions: 1 }] };
    }
    const runJobs = /^repos\/craigoley\/remudero\/actions\/runs\/(\d+)\/jobs\?per_page=100$/.exec(path)?.[1];
    if (runJobs) {
      return { jobs: [{ id: Number(runJobs) * 100, name: "ci", status: "completed", conclusion: runJobs === "1" ? "success" : "failure" }] };
    }
    throw new Error(`unrouted gh api call: ${args.join(" ")}`);
  }) as GhApiFetcher;
  const issues: AsyncIssueGateway = {
    create: async () => `https://github.com/${OWNER}/${REPO}/issues/1`,
    listOpen: async () => [],
    comment: async () => {},
    closeWithComment: async () => {},
  };
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch,
    issues,
    ledgerPath,
    runId,
    log: () => {},
    now: () => clock,
    readRequiredChecks: () => ["ci"],
    readCiFailures: () => [{ name: "ci", conclusion: "FAILURE", logTail: LOG }],
    mergeReader: { prMerge: () => undefined, mergeBase: () => GREEN, prsMergedBetween: () => [] },
    repair: lane,
  });
  return {
    observe: async (advanceMs = 60_000) => {
      clock += advanceMs;
      await rung();
      await flush();
    },
  };
}

const row = (runId: string, step: string, extra: Record<string, unknown> = {}) =>
  ({ run_id: runId, task_id: "MAIN-HEALTH", step, surface: "main", offending_sha: RED_MERGE, ...extra });
const located = row("DAEMON-OLD", "main.repair.located", { offending_pr: 18700, failing_checks: ["ci"], head_sha: HEAD });
const lostRows = (ledgerPath: string) =>
  readLedgerLines(ledgerPath).filter((line) => line.step === "main.repair.fix_refused" && line.lost === true); // ledger-read-intent: live

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13134-`));
}

test("W1-T13134 criterion 1: a fix run dispatched by another daemon run that never reported is written lost and dispatched again once", async () => {
  const root = tmpRoot();
  try {
    const ledgerPath = writeLedger([located, row("DAEMON-OLD", "main.repair.fix_dispatched", { head_sha: HEAD })], { dir: root }).path;
    const lane = fakeLane();
    await rig("DAEMON-NEW", lane, ledgerPath).observe();

    const lost = lostRows(ledgerPath);
    assert.equal(lost.length, 1, "the lost run is written once, as fix_refused with lost true");
    assert.equal(lost[0]!.run_id, "DAEMON-NEW");
    assert.match(String(lost[0]!.reason), /the fix run was lost: daemon run DAEMON-OLD ended before it reported/);
    assert.equal(lane.fixes.length, 1, "the first red observation of the same red dispatches the fix again");
    assert.match(lane.fixes[0]!.reason, /repeats a lost fix run: daemon run DAEMON-OLD/);
    assert.equal(lane.reverts.length, 0, "the revert path does not run");
    const dispatched = readLedgerLines(ledgerPath).filter((line) => line.step === "main.repair.fix_dispatched"); // ledger-read-intent: live
    assert.deepEqual(dispatched.map((line) => line.run_id), ["DAEMON-OLD", "DAEMON-NEW"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T13134 criterion 2: invariant:one-live-fix-run, the run id that dispatched a fix run in flight never reads it as lost", async () => {
  const root = tmpRoot();
  try {
    const ledgerPath = writeLedger([], { dir: root }).path;
    const lane = fakeLane();
    const daemon = rig("DAEMON-LIVE", lane, ledgerPath);
    await daemon.observe(); // locate + dispatch; openFixPr never settles
    assert.equal(lane.fixes.length, 1);
    await daemon.observe();
    await daemon.observe(MAIN_REPAIR_STALL_MS);
    // The same daemon run reads the same ledger through a second rung: its in-process set is empty,
    // so only the run id says the fix run is still its own.
    const sameRun = rig("DAEMON-LIVE", lane, ledgerPath);
    await sameRun.observe();
    await sameRun.observe();
    assert.equal(lane.fixes.length, 1, "the live fix run is not dispatched a second time");
    assert.equal(lostRows(ledgerPath).length, 0, "no lost row for a run of this daemon run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T13134 criterion 3: invariant:lost-redispatch-is-bounded, fix runs lost the limit times go to the revert", async () => {
  assert.equal(MAIN_REPAIR_LOST_RUN_LIMIT, 2);
  const root = tmpRoot();
  try {
    const ledgerPath = writeLedger(
      [
        located,
        row("DAEMON-1", "main.repair.fix_dispatched", { head_sha: HEAD }),
        row("DAEMON-2", "main.repair.fix_refused", { lost: true, reason: "the fix run was lost: daemon run DAEMON-1 ended before it reported" }),
        row("DAEMON-2", "main.repair.fix_dispatched", { head_sha: HEAD }),
      ],
      { dir: root },
    ).path;
    const lane = fakeLane();
    const daemon = rig("DAEMON-3", lane, ledgerPath);
    await daemon.observe();
    assert.equal(lostRows(ledgerPath).length, 2, "the second lost run is written too");
    assert.equal(lane.fixes.length, 0, "a record lost the limit times is not dispatched again");
    await daemon.observe();
    await daemon.observe(MAIN_REPAIR_STALL_MS);
    assert.equal(lane.fixes.length, 0);
    assert.equal(lostRows(ledgerPath).length, 2, "a lost run is written lost once");
    assert.equal(lane.reverts.length, 1, "the stall goes to the revert path as today");
    assert.match(lane.reverts[0]!.whyFixInsufficient, /fix runs, lost at restarts \(daemon runs DAEMON-1, DAEMON-2 ended before they reported/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
