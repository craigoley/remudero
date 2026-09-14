/**
 * test/plan-resequence-pr-invalidation-wiring.test.ts — W1-T3585.
 *
 * Proves the WIRING half of the current-plan invalidation guard: `buildSweepHook` (the full daemon
 * sweep) and `buildSweepLightHook` (the light daemon sweep) both reach `buildOpenPrViews` with the
 * SAME `isMerged`/`readMainPlan` seams, so a task the current plan can no longer run gets the SAME
 * `planResequenceIneligible` verdict — and the SAME reversible close — on either path. Runs each
 * hook end-to-end over a stubbed `gh` binary and a fixture plan/merged-set, never a source-text scan.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildSweepHook, buildSweepLightHook } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { ghShim } from "./helpers/gh-shim.js";

const TASK_ID = "W1-T9001";
const DEP_ID = "W1-T9002";
const PR_NUMBER = 9001;
const SHA = "c".repeat(40);

/** The current plan: TASK_ID now depends on DEP_ID, and DEP_ID has not merged — an unmet
 *  dependency added AFTER the fixture PR below was already open, replaying the #5545 shape. */
function fixturePlan(): Plan {
  const dep: Task = {
    id: DEP_ID,
    title: "the resequenced predecessor",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
  };
  const task: Task = {
    id: TASK_ID,
    title: "the resequenced worker",
    repo: "remudero",
    depends_on: [DEP_ID],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
  };
  return { tasks: [task, dep], byId: new Map([[task.id, task], [dep.id, dep]]) };
}

const NOTHING_MERGED = () => false;

/** Shared PATH shim routes for both sweeps. The helper owns the executable script and call log,
 * so this wiring test does not add another hand-rolled `gh` fixture. */
function resequenceGh() {
  return ghShim([
    { when: "pr close", exit: 0 },
    { when: "required_status_checks", stdout: JSON.stringify({ contexts: ["ci-gate", "remudero-review"] }) },
    {
      when: "pulls?state=open",
      stdout: JSON.stringify([{
        number: PR_NUMBER,
        html_url: `https://github.com/o/r/pull/${PR_NUMBER}`,
        state: "open",
        body: `Remudero-Task: ${TASK_ID}\\u000a`,
        updated_at: "2026-09-14T00:00:00Z",
        head: { ref: `run-${TASK_ID}-1789232400000`, sha: SHA },
        auto_merge: null,
      }]),
    },
    { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] }) },
    { when: "/status", stdout: JSON.stringify({ statuses: [{ context: "remudero-review", state: "success" }] }) },
    { when: "/files", stdout: JSON.stringify([{ filename: "src/lib/sweep.ts" }]) },
    { when: "", stdout: "[]" },
  ], { kind: "plan-resequence" });
}

function readDisposedLines(ledgerPath: string): Array<Record<string, unknown>> {
  let raw = "";
  try {
    raw = readFileSync(ledgerPath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.step === "sweep.disposed" && line.pr_number === PR_NUMBER);
}

test("W1-T3585 plan invalidation uses current plan eligibility in both sweep paths", async () => {
  // (a) the full daemon sweep: `buildSweepHook` closes the plan-invalidated task-owned PR via the
  // SAME isMerged/readMainPlan seam runSweep's stale-close effect uses.
  {
    const root = mkdtempSync(join(tmpdir(), "rmd-plan-resequence-full-"));
    const ledgerPath = join(root, "ledger.ndjson");
    const shim = resequenceGh();
    const oldPath = process.env.PATH;
    process.env.PATH = `${shim.dir}:${oldPath}`;
    try {
      const hook = buildSweepHook(
        "o",
        "r",
        { root, claudeBin: "/bin/true" } as Config,
        ledgerPath,
        "RUN-FULL-1",
        { tasks: [], byId: new Map() },
        () => {},
        undefined, // tmpMaxAgeMs
        undefined, // github
        undefined, // pacer
        undefined, // workerStallMs
        undefined, // mainHealthRung
        undefined, // snapshotCache
        NOTHING_MERGED,
        fixturePlan,
      );
      await hook();

      const disposed = readDisposedLines(ledgerPath);
      assert.equal(disposed.length, 1, "the full sweep disposed the fixture PR exactly once");
      assert.equal(disposed[0].disposition, "stale", "the current-plan invalidation guard fired, not the ordinary path");
      assert.match(String(disposed[0].reason), new RegExp(DEP_ID));
      assert.equal(disposed[0].acted, true, "the reversible close effect actually ran");

      const closeCall = shim.calls().find((call) => call.includes("pr close"));
      assert.match(closeCall ?? "", new RegExp(`pull/${PR_NUMBER}`), "gh pr close was invoked for the invalidated PR");
      assert.doesNotMatch(closeCall ?? "", /--delete-branch/, "the close stays reversible — the head branch is preserved");
    } finally {
      process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  }

  // (b) the light daemon sweep: `buildSweepLightHook` reaches the SAME current-plan eligibility
  // verdict via the identical isMerged/readMainPlan seam — the pre-existing dangerous-lane
  // restriction still defers the close itself.
  {
    const root = mkdtempSync(join(tmpdir(), "rmd-plan-resequence-light-"));
    const ledgerPath = join(root, "ledger.ndjson");
    const shim = resequenceGh();
    const oldPath = process.env.PATH;
    process.env.PATH = `${shim.dir}:${oldPath}`;
    try {
      const hook = buildSweepLightHook(
        "o",
        "r",
        { root, claudeBin: "/bin/true" } as Config,
        ledgerPath,
        "RUN-LIGHT-1",
        { tasks: [], byId: new Map() },
        () => {},
        NOTHING_MERGED,
        fixturePlan,
      );
      await hook();

      const disposed = readDisposedLines(ledgerPath);
      assert.equal(disposed.length, 1, "the light sweep disposed the fixture PR exactly once");
      assert.equal(disposed[0].disposition, "stale", "the light path reaches the SAME current-plan invalidation guard as the full sweep");
      assert.match(String(disposed[0].reason), new RegExp(DEP_ID), "the SAME planResequenceIneligible reason reached the light path");
      // W1-T254's pre-existing, UNCHANGED restriction: "stale" is a dangerous (close) lane, so the
      // light pass computes the identical disposition and then defers ACTING on it to the full
      // sweep — proving the predicate is shared without widening what the light path is allowed to do.
      assert.equal(disposed[0].acted, false, "the light path defers the close itself to the full sweep");
      assert.equal(disposed[0].stand_down_reason, "deferred to full sweep (light pass)");

      assert.ok(!shim.calls().some((call) => call.includes("pr close")), "the light path never invokes gh pr close directly — that stays the full sweep's job");
    } finally {
      process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  }
});
