/**
 * W1-T14871 — an empty-CI-evidence stand-down waits for CI to settle, and its hold is released when the red checks change.
 *
 * A fix round whose rollup was still pending stood down on an empty evidence read, before the shard that named the
 * failure had finished; the sweep's hold then never released, because it compared only the head, task contract and
 * PR body. The round now waits for CI to settle first, and the stand-down row records the rollup state and red checks
 * as the sweep's own readers see them at that moment, so the hold is released once either changes. A settled red that
 * still names nothing stands down and stays held.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFixRung } from "#test/helpers/run-task-test.js";
import type { CiFailure } from "#test/helpers/sweep-test.js";
import { checksStateFromRollup, fixRungInputsUnchanged, redQualityGateNames } from "#src/lib/sweep.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import type { IssueGateway, OpenIssue } from "#src/lib/escalate.js";
import type { Mount } from "#src/lib/mounts.js";
import type { Config } from "#src/lib/config.js";
import type { WorkerResult } from "#src/lib/worker.js";

const HEAD = "deadbeef";
const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };
const SHARD = "coverage-shard (13/16)";
const REQUIRED = ["coverage-ratchet", "ci"];

type Rollup = NonNullable<Parameters<typeof redQualityGateNames>[0]>;
type Gate = { state: "green" | "red" | "timeout"; sha: string };

const check = (name: string, conclusion?: string) =>
  conclusion === undefined ? { name, status: "IN_PROGRESS" } : { name, status: "COMPLETED", conclusion };
/** One shard has failed while its aggregator still runs: the sweep names the shard. */
const PENDING: Rollup = [check(SHARD, "FAILURE"), check("coverage-ratchet"), check("ci", "SUCCESS")];
/** The aggregator has concluded: the sweep names it in the shard's place. */
const SETTLED: Rollup = [check(SHARD, "FAILURE"), check("coverage-ratchet", "FAILURE"), check("ci", "SUCCESS")];
/** A different red set on the same head. */
const OTHER_RED: Rollup = [check("coverage-ratchet", "SUCCESS"), check("ci", "FAILURE")];

const settledRed: Gate = { state: "red", sha: HEAD };
const stalled: Gate = { state: "timeout", sha: HEAD };

/** What the sweep passes its hold for this head: the same two readers over the same rollup. */
const sweepReads = (rollup: Rollup) =>
  ({ headSha: HEAD, checksState: checksStateFromRollup(rollup, REQUIRED), redChecks: redQualityGateNames(rollup, REQUIRED) });

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

/** A configured root whose checkout of the target declares the ci-gate's required names, as the sweep reads them. */
function configRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t14871-"));
  const workflows = join(root, "repos", "remudero", ".github", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(workflows, "ci-gate.yml"), `jobs:\n  ci-gate:\n    env:\n      REQUIRED: '${JSON.stringify(REQUIRED)}'\n`);
  return root;
}

interface Round {
  /** The rollup the sweep dispatched on; omitted, the dispatch carries no reading of its own (the run loop's shape). */
  dispatched?: Rollup;
  /** The failing checks the dispatch handed the rung. */
  ciFailures?: CiFailure[];
  /** What the first gate wait returns; a later one goes green. */
  settled: Gate;
  mined: CiFailure[];
  /** The live rollup once the rung has waited; omitted, no live reader is wired. */
  live?: Rollup | Error;
}

/** One ci-log round driven through the production rung. */
async function round(input: Round) {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let waits = 0;
  let spawns = 0;
  let rollupReads = 0;
  const root = configRoot();
  const dispatched = input.dispatched === undefined ? undefined : sweepReads(input.dispatched);
  const live = input.live;
  const outcome = await runFixRung({
    ...({ requiredContexts: REQUIRED } as object),
    taskId: "W1-T14871X", runId: "W1-T14871X-1730000000000", task: { id: "W1-T14871X", title: "fix red required checks" },
    prUrl: "https://github.com/acme/remudero/pull/20923", branch: "run-W1-T14871X-1730000000000",
    worktreePath: "/tmp/rmd-w1-t14871-wt", initialSessionId: "", mount: MOUNT, settingsFile: "/tmp/rmd-w1-t14871-settings.json",
    config: { root } as Config, budgetUsd: 10, strikeCap: 3, initialReview: ciLogReview(),
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-w1-t14871-wt", reviewerMount: MOUNT },
    ciFailures: input.ciFailures ?? [],
    ...(dispatched === undefined ? {} : { ciEvidenceDisagreement: { sha: HEAD,
      rollup: { checks_state: dispatched.checksState, red_checks: dispatched.redChecks }, miner: { enumerable_failures: [] } } }),
    deps: {
      spawn: async () => { spawns++; return result(); },
      waitForCiGreen: async () => (++waits === 1 ? input.settled : { state: "green" as const, sha: "sha-2" }),
      fetchCiFailures: async () => input.mined,
      ...(live === undefined ? {} : { readCiRollup: async () => {
        rollupReads++;
        // Before any wait the live rollup is still the dispatched one.
        if (waits === 0 && input.dispatched !== undefined) return input.dispatched;
        if (live instanceof Error) throw live;
        return live;
      } }),
      fetchPrBody: async () => "Implements the task.\n\nRemudero-Task: fixture",
      runReview: async () => ({ ...ciLogReview("sha-2"), state: "success", criteria: [] }),
      push: () => {},
      issues: issues(),
      ledgerPath: join(root, "ledger.ndjson"),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });
  const standDowns = logs.filter((l) => l.step === "fix.stood_down" && l.extra?.site === "rung.empty_ci_failures");
  return { outcome, logs, waits, spawns, rollupReads, standDowns };
}

/** The one empty-evidence stand-down row a round wrote. */
function standDownRow(run: Awaited<ReturnType<typeof round>>): Record<string, unknown> {
  assert.equal(run.standDowns.length, 1);
  return run.standDowns[0].extra!;
}

test("W1-T14871 a round whose rollup is still pending waits for CI instead of standing down", async () => {
  const shard: CiFailure = { name: SHARD, logTail: "not ok 1 - a named test" };
  const pending = await round({ dispatched: PENDING, settled: settledRed, mined: [shard] });
  assert.equal(pending.waits >= 1, true, "the round waits for CI to settle");
  assert.equal(pending.standDowns.length, 0, "it never stands down on the pending empty read");
  assert.equal(pending.spawns, 1, "the settled shard failure is handed to a fix worker");
  assert.equal(pending.logs.filter((l) => l.step === "fix.dispatch").length, 1);
});

test("W1-T14871 the stand-down hold is released when the red checks differ from those it stood down on", async () => {
  // Dispatched pending on a shard; the aggregator replaces it once settled, and the miner still names nothing.
  const waited = await round({ dispatched: PENDING, settled: settledRed, mined: [], live: SETTLED });
  assert.equal(waited.waits, 1, "one wait, then the stand-down");
  assert.equal(waited.spawns, 0);
  const row = standDownRow(waited);
  assert.deepEqual(row.read_red_checks, ["coverage-ratchet"], "the row names the settled red checks, not the dispatched shard");
  assert.equal(row.read_checks_state, "red");
  assert.equal(fixRungInputsUnchanged(row, sweepReads(SETTLED)), true, "the sweep's reading of the same rollup keeps the hold");
  assert.equal(fixRungInputsUnchanged(row, sweepReads(PENDING)), false, "the dispatched red set is now a different one");
  assert.equal(fixRungInputsUnchanged(row, sweepReads(OTHER_RED)), false, "a different red set on the same head releases the hold");

  // The wait stalls: the stand-down is taken while CI is still pending, and settling releases it.
  const stuck = await round({ dispatched: PENDING, settled: stalled, mined: [], live: PENDING });
  assert.equal(stuck.waits, 1, "a stalled wait is not repeated");
  const stuckRow = standDownRow(stuck);
  assert.equal(stuckRow.read_checks_state, "pending");
  assert.deepEqual(stuckRow.read_red_checks, [SHARD]);
  assert.equal(fixRungInputsUnchanged(stuckRow, sweepReads(PENDING)), true, "still pending on the same red keeps the hold");
  assert.equal(fixRungInputsUnchanged(stuckRow, { ...sweepReads(PENDING), checksState: "red" }), false,
    "pending -> settled releases the hold even on the same red names");

  // With no live reader the gate's own "timeout" is recorded as the sweep's "pending", and no stale red names.
  const blind = standDownRow(await round({ dispatched: PENDING, settled: stalled, mined: [] }));
  assert.equal(blind.read_checks_state, "pending");
  assert.equal(blind.read_red_checks, undefined);
  assert.equal(fixRungInputsUnchanged(blind, sweepReads(SETTLED)), false);

  // An unreadable rollup after the wait records the gate's state and never the dispatched names.
  const unread = await round({ dispatched: PENDING, settled: settledRed, mined: [], live: new Error("rollup unreadable") });
  const unreadRow = standDownRow(unread);
  assert.equal(unreadRow.read_checks_state, "red");
  assert.equal(unreadRow.read_red_checks, undefined);
  assert.equal(unread.logs.filter((l) => l.step === "fix.stand_down_checks_unread").length, 1, "the unread is ledgered");

  // The same rule after a strike's own wait: the red set read then is recorded, not the dispatch's.
  const struck = await round({ dispatched: SETTLED, ciFailures: [{ name: SHARD, logTail: "boom" }], settled: settledRed,
    mined: [], live: OTHER_RED });
  assert.equal(struck.spawns, 1, "one strike on the dispatched failure, none on the empty read");
  assert.deepEqual(standDownRow(struck).read_red_checks, ["ci"]);

  // A dispatch that carried no reading of its own records the live one, so its hold can be released too.
  const unseeded = standDownRow(await round({ settled: settledRed, mined: [], live: SETTLED }));
  assert.equal(unseeded.read_checks_state, "red");
  assert.deepEqual(unseeded.read_red_checks, ["coverage-ratchet"]);
});

test("W1-T14871 a settled red with no enumerable failure still stands down and stays held", async () => {
  const settled = await round({ dispatched: SETTLED, settled: settledRed, mined: [], live: SETTLED });
  assert.equal(settled.waits, 0, "a settled rollup is not waited on again");
  assert.equal(settled.rollupReads, 0, "the dispatching sweep's own reading is what the rung stood down on");
  assert.equal(settled.spawns, 0, "no fix worker on empty evidence");
  assert.equal(settled.outcome.outcome, "stood_down");
  const row = standDownRow(settled);
  assert.equal(row.read_head_sha, HEAD);
  assert.equal(row.read_checks_state, "red", "the hold is keyed on the settled rollup it stood down on");
  assert.deepEqual(row.read_red_checks, ["coverage-ratchet"]);
  assert.equal(fixRungInputsUnchanged(row, sweepReads(SETTLED)), true, "the same head and the same red checks keep the hold");

  // The same holds when the round first had to wait for that settled red.
  const waited = await round({ dispatched: PENDING, settled: settledRed, mined: [], live: SETTLED });
  assert.equal(waited.outcome.outcome, "stood_down");
  assert.equal(fixRungInputsUnchanged(standDownRow(waited), sweepReads(SETTLED)), true);

  assert.equal(fixRungInputsUnchanged({ read_head_sha: HEAD, site: "rung.empty_ci_failures" }, sweepReads(OTHER_RED)), true,
    "a row written before these fields keeps today's hold");
});
