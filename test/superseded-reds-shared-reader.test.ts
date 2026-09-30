// W1-T4908 — one classifier ({ latest, superseded }) feeds the SRE failedCi reader, the task case
// file and `rmd board`, so a superseded red is never re-run, never read as a duplicate, never silent.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { caseFileCommand, parseCasePrSnapshot } from "../src/lib/report-commands.js";
import { surveyPullRequestBoard } from "../src/lib/pr-board.js";
import { daemonSreRunbookHost } from "../src/lib/sre-runbooks.js";
import { classifyRollupSupersession, type RollupCheckEntry } from "../src/lib/sweep.js";
import type { Task } from "../src/lib/plan.js";
import type { StatusProjection } from "../src/lib/status.js";
import { boardCommand } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

const OLD = "2026-09-30T10:00:00Z";
const NEW = "2026-09-30T11:00:00Z";
const fail = (name: string, startedAt = OLD, extra: Partial<RollupCheckEntry> = {}): RollupCheckEntry =>
  ({ name, status: "COMPLETED", conclusion: "FAILURE", startedAt, ...extra });
const pass = (name: string, startedAt = NEW): RollupCheckEntry =>
  ({ name, status: "COMPLETED", conclusion: "SUCCESS", startedAt });

test("an older failure outvoted by a later success is classified superseded", () => {
  const older = fail("ci-gate");
  const later = pass("ci-gate");
  const still = fail("lint", NEW);
  const { latest, superseded } = classifyRollupSupersession([older, later, still]);
  assert.deepEqual(latest, [later, still]);
  assert.deepEqual(superseded, [{ entry: older, supersededBy: later, pendingRerun: false }]);
  assert.deepEqual(classifyRollupSupersession([still]).superseded, []);
});

test("a rerun in progress leaves the earlier failure listed as a pending rerun", () => {
  const older = fail("ci-gate");
  const running: RollupCheckEntry = { name: "ci-gate", status: "IN_PROGRESS", conclusion: "", startedAt: NEW };
  const { latest, superseded } = classifyRollupSupersession([older, running]);
  assert.deepEqual(latest, [running]);
  assert.deepEqual(superseded, [{ entry: older, supersededBy: running, pendingRerun: true }]);
});

test("the sre failedCi reader names no job for a superseded failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-superseded-sre-"));
  const shim = ghShim([
    {
      when: "pr view 91",
      stdout: JSON.stringify({
        headRefOid: "head-91",
        statusCheckRollup: [
          fail("lint", OLD, { detailsUrl: "https://github.com/o/r/actions/runs/1/job/501" }),
          { ...pass("lint"), detailsUrl: "https://github.com/o/r/actions/runs/2/job/502" },
          fail("tests", NEW, { detailsUrl: "https://github.com/o/r/actions/runs/2/job/503" }),
        ],
      }),
    },
    { when: "api", stdout: JSON.stringify([{ name: "tests", conclusion: "success" }]) },
  ], { kind: "superseded-sre" });
  const originalPath = process.env.PATH;
  const originalCache = process.env.RMD_GH_CACHE_HOME;
  process.env.PATH = `${shim.dir}:${originalPath ?? ""}`;
  process.env.RMD_GH_CACHE_HOME = join(root, "cache");
  try {
    const host = daemonSreRunbookHost({ root, repoDir: root, owner: "o", repo: "r" });
    assert.deepEqual(await host.failedCi(91), {
      headSha: "head-91", unrelated: true, jobIds: [503], observed: "red: tests; green on main: true",
    });
  } finally {
    process.env.PATH = originalPath ?? "";
    if (originalCache === undefined) delete process.env.RMD_GH_CACHE_HOME;
    else process.env.RMD_GH_CACHE_HOME = originalCache;
  }
});

test("the case file resolves a re-run check to its latest verdict", async () => {
  const task = { id: "W1-T4908", title: "Case file", repo: "remudero", depends_on: [], type: "implement",
    verify: "auto", risk: "high", status: "queued", attempts: 0 } as Task;
  const head = "b".repeat(40);
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-superseded-case-"));
  writeFileSync(join(stateDir, "ledger.ndjson"), JSON.stringify({ ts: "2026-09-30T09:00:00.000Z", step: "run.start",
    task_id: task.id, run_id: `${task.id}-1790793300001` }) + "\n");
  const pr = (rollup: unknown[]) => parseCasePrSnapshot({ number: 8200, url: "https://github.com/craigoley/remudero/pull/8200",
    state: "OPEN", headRefOid: head, body: `Remudero-Task: ${task.id}`, mergedAt: null, statusCheckRollup: rollup },
  "2026-09-30T12:00:00.000Z");
  const read = async (rollup: unknown[]) => {
    const printed: string[] = [];
    const code = await caseFileCommand([task.id, "--json"], {
      stateDir, nowIso: () => "2026-09-30T12:00:00.000Z", resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
      readTask: () => task,
      readProjection: () => ({ taskId: task.id, status: "running", merged: false, source: "ledger", prNumber: 8200 } as StatusProjection),
      readPr: () => pr(rollup), out: (line) => printed.push(line),
    });
    assert.equal(code, 0);
    return JSON.parse(printed[0]);
  };
  const rerun = await read([
    { __typename: "CheckRun", name: "acceptance-author-gate", conclusion: "FAILURE", startedAt: OLD },
    { __typename: "CheckRun", name: "acceptance-author-gate", conclusion: "SUCCESS", startedAt: NEW },
    { __typename: "CheckRun", name: "ci-gate", conclusion: "SUCCESS", startedAt: OLD },
    { __typename: "CheckRun", name: "ci-gate", conclusion: "FAILURE", startedAt: NEW },
  ]);
  assert.equal(rerun.acceptance.state, "observed");
  assert.equal(rerun.ci.state, "unavailable");
  assert.equal(rerun.ci.reason, "check-failure");
  const running = await read([
    { __typename: "CheckRun", name: "ci-gate", conclusion: "FAILURE", startedAt: OLD },
    { __typename: "CheckRun", name: "ci-gate", status: "IN_PROGRESS", startedAt: NEW },
  ]);
  assert.equal(running.ci.state, "pending");
  assert.equal(running.ci.reason, "check-pending");
});

test("the board names a superseded red beside the failing checks", () => {
  const rows = [{ number: 41, title: "rerun", isDraft: false, headRefName: "run-x-1", statusCheckRollup: [
    fail("ci-gate"), pass("ci-gate"), fail("lint", OLD), fail("lint", NEW), fail("tests", OLD),
    { name: "tests", status: "IN_PROGRESS", startedAt: NEW }, { context: "", state: "FAILURE", startedAt: OLD }, { context: "", state: "FAILURE", startedAt: NEW }, pass("build"),
  ] }];
  const board = surveyPullRequestBoard(["acme/w"], () => rows);
  const repo = board.repos[0];
  assert.ok(repo.available);
  if (repo.available) {
    assert.deepEqual(repo.pullRequests[0].failingChecks, ["lint"]);
    assert.deepEqual(repo.pullRequests[0].supersededChecks, ["ci-gate", "tests"]);
  }
  const lines: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    assert.equal(boardCommand(["--repo", "acme/w"], { survey: () => board }), 0);
  } finally {
    console.log = real;
  }
  assert.ok(lines.some((l) => l.includes("failing=lint") && l.includes("pending=tests") && l.endsWith("superseded: ci-gate,tests")), lines.join("\n"));
});
