import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MAX_STALE_PROOF_CLOSES_PER_PASS, runSweep, type CiFailure, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";

const NOW = Date.parse("2026-09-30T19:00:00Z");
const WORKER_PROOF = "unit test: test/read-model-worker.test.ts";

const STALE_LOG = [
  "2026-09-30T18:16:00.0000000Z proof-discrimination: FAIL — 1 proof(s) pass at both PR head and merge base (abc123):",
  `2026-09-30T18:16:00.0000000Z   proof: ${WORKER_PROOF}`,
  "2026-09-30T18:16:00.0000000Z   head hits: 12; base hits: 12",
  "2026-09-30T18:16:00.0000000Z Remedy: replace each stale proof with one that names behavior this PR changes, then rerun this check.",
].join("\n");

function failure(name: string, logTail: string): CiFailure {
  return { name, logTail, conclusion: "FAILURE" };
}

/** One stale-proof PR; `n` keys the number, task and head so each is its own disposition. */
function pr(n: number, over: Partial<OpenPrView> = {}): OpenPrView {
  const task = `W1-T5030-FIXTURE-${n}`;
  return {
    prNumber: 9000 + n,
    prUrl: `https://github.com/acme/remudero/pull/${9000 + n}`,
    taskId: task,
    body: `Remudero-Task: ${task}\n`,
    reviewState: "pending",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-30T18:30:00.000Z", // expiring-fixture: exempt -- compared only against this suite's INJECTED now (NOW), never the wall clock
    headSha: `5030${String(n).padStart(4, "0")}`,
    autoMergeArmed: false,
    redRequiredChecks: ["proof-discrimination"],
    ciFailures: [failure("proof-discrimination", STALE_LOG)],
    changedFiles: [],
    ...over,
  };
}

/** A healthy PR beside the red ones: a check red on EVERY open PR is classed base-caused and stands down, so the
 *  pass needs a survivor for the stale-proof arm to be reached at all. */
const SURVIVOR: OpenPrView = pr(99, {
  checksState: "green",
  redRequiredChecks: [],
  ciFailures: undefined,
  changedFiles: ["src/lib/views.ts"],
  autoMergeArmed: true,
});

interface Observed {
  fixed: number[];
  closeAttempts: number[];
  rows: Array<Record<string, unknown>>;
}

async function sweep(views: OpenPrView[], ledgerPath: string, extra: Partial<SweepDeps> = {}): Promise<Observed> {
  const observed: Observed = { fixed: [], closeAttempts: [], rows: [] };
  await runSweep([...views, SURVIVOR], {
    arm: () => "armed",
    close: (closed) => {
      observed.closeAttempts.push(closed.prNumber);
    },
    dispatchFix: (fixed) => {
      observed.fixed.push(fixed.prNumber);
    },
    escalate: () => {},
    repairMetadata: () => ({ repaired: false, notMetadata: true, reason: "no deterministic acceptance repair" }),
    ledgerPath,
    runId: "SWEEP-W1-T5030",
    now: () => NOW,
    ...extra,
  });
  observed.rows = readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return observed;
}

function scratchLog(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-stale-cap-")), "ledger.ndjson");
}

function disposedFor(observed: Observed, prNumber: number): Record<string, unknown> {
  const row = observed.rows.find((r) => r.step === "sweep.disposed" && r.pr_number === prNumber);
  assert.ok(row, `a sweep.disposed row exists for #${prNumber}`);
  return row;
}

test("W1-T5030: a pass closes at most the cap of stale-proof superseded PRs", async () => {
  assert.equal(MAX_STALE_PROOF_CLOSES_PER_PASS, 2);
  const views = [pr(1), pr(2), pr(3), pr(4)];
  const attempts: number[] = [];
  const observed = await sweep(views, scratchLog(), {
    close: (closed) => {
      attempts.push(closed.prNumber);
      // The first close throws: an ATTEMPT spends its slot, so a throwing close cannot widen the burst.
      if (closed.prNumber === 9001) throw new Error("close refused by the host");
    },
  });
  assert.deepEqual(attempts, [9001, 9002], "two attempts, the throwing one included, and no third");
  assert.equal(disposedFor(observed, 9001).acted, false, "the throwing close is contained on its own row");
  assert.match(String(disposedFor(observed, 9001).action_error), /close refused/);
  assert.equal(disposedFor(observed, 9002).stale_proof_superseded, true);
});

test("W1-T5030: a PR over the cap carries with a named reason and never reaches the fix worker", async () => {
  const observed = await sweep([pr(1), pr(2), pr(3)], scratchLog());
  assert.deepEqual(observed.closeAttempts, [9001, 9002]);
  assert.deepEqual(observed.fixed, [], "a deferred superseded PR never spends a ci-log fix strike");
  const deferred = disposedFor(observed, 9003);
  assert.equal(deferred.acted, false);
  assert.equal(deferred.stale_proof_close_deferred, true);
  assert.match(String(deferred.stand_down_reason), /stale-proof supersession close deferred/);
  assert.match(String(deferred.stand_down_reason), /2 already made this pass/);
  assert.equal(deferred.stale_proof_superseded, undefined, "the deferred PR is not recorded as superseded");
});

test("W1-T5030: a carried PR is closed on the next pass", async () => {
  const ledgerPath = scratchLog();
  const views = [pr(1), pr(2), pr(3)];
  const first = await sweep(views, ledgerPath);
  assert.deepEqual(first.closeAttempts, [9001, 9002]);
  const second = await sweep([views[2]!], ledgerPath);
  assert.deepEqual(second.closeAttempts, [9003], "the carried PR is re-derived and closed");
  assert.deepEqual(second.fixed, []);
});

test("W1-T5030: a pass at the cap still closes every stale-proof superseded PR", async () => {
  const observed = await sweep([pr(1), pr(2)], scratchLog());
  assert.deepEqual(observed.closeAttempts, [9001, 9002]);
  assert.equal(observed.rows.filter((r) => r.stale_proof_close_deferred === true).length, 0);
  assert.equal(disposedFor(observed, 9001).stale_proof_superseded, true);
  assert.equal(disposedFor(observed, 9002).stale_proof_superseded, true);
});

test("W1-T5030: a stale-proof PR with a non-empty diff spends no close slot", async () => {
  const observed = await sweep(
    [
      pr(1, { changedFiles: ["src/lib/views.ts"] }),
      pr(2, { changedFiles: undefined }),
      pr(3),
      pr(4),
    ],
    scratchLog(),
    { dispatchPlanOnlyRepair: () => true },
  );
  assert.deepEqual(observed.closeAttempts, [9003, 9004], "both empty-diff PRs close; the others spent nothing");
  assert.equal(observed.rows.filter((r) => r.stale_proof_close_deferred === true).length, 0);
});

test("W1-T5030: the deferral rides the disposed row and mints no new step", async () => {
  const under = await sweep([pr(1)], scratchLog());
  const over = await sweep([pr(1), pr(2), pr(3)], scratchLog());
  const steps = (o: Observed) => [...new Set(o.rows.map((r) => String(r.step)))].sort();
  assert.deepEqual(steps(over), steps(under), "a deferral writes no step an in-cap pass does not");
  const deferred = over.rows.filter((r) => r.stale_proof_close_deferred === true);
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0]!.step, "sweep.disposed");
  assert.equal(deferred[0]!.pr_number, 9003);
});
