/**
 * W1-T14871 — an empty-CI-evidence stand-down waits for CI to settle, and its hold is released when the red checks change.
 *
 * A fix round whose rollup was still pending stood down on an empty evidence read, before the shard that named the
 * failure had finished; the sweep's hold then never released, because it compared only the head, task contract and
 * PR body. The round now waits for CI to settle first, and the stand-down row records the rollup state and red checks
 * it read, so the hold is released once either changes. A settled red that still names nothing stands down and stays held.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFixRung } from "#test/helpers/run-task-test.js";
import type { CiFailure } from "#test/helpers/sweep-test.js";
import { fixRungInputsUnchanged } from "#src/lib/sweep.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import type { IssueGateway, OpenIssue } from "#src/lib/escalate.js";
import type { Mount } from "#src/lib/mounts.js";
import type { Config } from "#src/lib/config.js";
import type { WorkerResult } from "#src/lib/worker.js";

const HEAD = "deadbeef";
const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function result(): WorkerResult {
  return {
    sessionId: "s", costUsd: 0, numTurns: 0, text: "", blocks: [], stderr: "", subtype: "success", isError: false,
    apiError: false, permissionDenials: [], childEnvKeys: [], model: "default", effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

function ciLogReview(headSha = HEAD): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return { state: "failure", criteria: [], testTheater: false, summary: "sweep-reconstructed: required checks red — ci-log dispatch",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha, reviewerOutcome: "sweep-reconstructed-ci-log" };
}

function issues(): IssueGateway {
  const open: OpenIssue[] = [];
  return { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => open, comment: () => {} };
}

/** One ci-log round on an empty evidence read, dispatched while the rollup read `checksState` with `redChecks` red. */
async function round(checksState: "green" | "none" | "pending" | "red", settled: { state: "red"; sha: string; checks: string[] }, mined: CiFailure[]) {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let waits = 0;
  let spawns = 0;
  const outcome = await runFixRung({
    taskId: "W1-T14871X", runId: "W1-T14871X-1730000000000", task: { id: "W1-T14871X", title: "fix red required checks" },
    prUrl: "https://github.com/acme/remudero/pull/20923", branch: "run-W1-T14871X-1730000000000",
    worktreePath: "/tmp/rmd-w1-t14871-wt", initialSessionId: "", mount: MOUNT, settingsFile: "/tmp/rmd-w1-t14871-settings.json",
    config: {} as Config, budgetUsd: 10, strikeCap: 3, initialReview: ciLogReview(),
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-w1-t14871-wt", reviewerMount: MOUNT },
    ciFailures: [],
    ciEvidenceDisagreement: { sha: HEAD, rollup: { checks_state: checksState, red_checks: ["coverage-ratchet"] }, miner: { enumerable_failures: [] } },
    deps: {
      spawn: async () => { spawns++; return result(); },
      // The first wait settles on the named red; the fix worker's push then goes green.
      waitForCiGreen: async () => (++waits === 1 ? settled : { state: "green" as const, sha: "sha-2" }),
      fetchCiFailures: async () => mined,
      fetchPrBody: async () => "Implements the task.\n\nRemudero-Task: fixture",
      runReview: async () => ({ ...ciLogReview("sha-2"), state: "success", criteria: [] }),
      push: () => {},
      issues: issues(),
      ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-w1-t14871-")), "ledger.ndjson"),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });
  const standDowns = logs.filter((l) => l.step === "fix.stood_down" && l.extra?.site === "rung.empty_ci_failures");
  return { outcome, logs, waits, spawns, standDowns };
}

test("W1-T14871 a round whose rollup is still pending waits for CI instead of standing down", async () => {
  const shard: CiFailure = { name: "coverage-shard (13/16)", logTail: "not ok 1 - a named test" };
  const pending = await round("pending", { state: "red", sha: HEAD, checks: ["coverage-shard (13/16)"] }, [shard]);
  assert.equal(pending.waits >= 1, true, "the round waits for CI to settle");
  assert.equal(pending.standDowns.length, 0, "it never stands down on the pending empty read");
  assert.equal(pending.spawns, 1, "the settled shard failure is handed to a fix worker");
  assert.equal(pending.logs.filter((l) => l.step === "fix.dispatch").length, 1);
});

test("W1-T14871 the stand-down hold is released when the red checks differ from those it stood down on", async () => {
  const settled = await round("red", { state: "red", sha: HEAD, checks: ["coverage-ratchet"] }, []);
  assert.equal(settled.standDowns.length, 1);
  const row = settled.standDowns[0].extra!;
  assert.deepEqual(row.read_red_checks, ["coverage-ratchet"], "the row names the red checks it stood down on");
  assert.equal(row.read_checks_state, "red");
  assert.equal(fixRungInputsUnchanged(row, { headSha: HEAD, checksState: "red", redChecks: ["coverage-ratchet", "coverage-shard (13/16)"] }), false,
    "a different red set on the same head releases the hold");
  // A stand-down taken while CI was still pending is released once the rollup settles.
  assert.equal(fixRungInputsUnchanged({ ...row, read_checks_state: "pending" }, { headSha: HEAD, checksState: "red", redChecks: ["coverage-ratchet"] }), false);
});

test("W1-T14871 a settled red with no enumerable failure still stands down and stays held", async () => {
  const settled = await round("red", { state: "red", sha: HEAD, checks: ["coverage-ratchet"] }, []);
  assert.equal(settled.waits, 0, "a settled rollup is not waited on again");
  assert.equal(settled.spawns, 0, "no fix worker on empty evidence");
  assert.equal(settled.outcome.outcome, "stood_down");
  assert.equal(settled.standDowns.length, 1);
  const row = settled.standDowns[0].extra!;
  assert.equal(row.read_head_sha, HEAD);
  assert.equal(row.read_checks_state, "red", "the hold is keyed on the settled rollup it stood down on");
  assert.deepEqual(row.read_red_checks, ["coverage-ratchet"]);
  assert.equal(fixRungInputsUnchanged(row, { headSha: HEAD, checksState: "red", redChecks: ["coverage-ratchet"] }), true,
    "the same head and the same red checks keep the hold");
  assert.equal(fixRungInputsUnchanged({ read_head_sha: HEAD, site: "rung.empty_ci_failures" }, { headSha: HEAD, checksState: "red", redChecks: ["x"] }), true,
    "a row written before these fields keeps today's hold");
});
