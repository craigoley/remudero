import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GhPaceFloorStandDownError } from "../src/lib/open-prs-rest.js";
import { appendLedger } from "../src/lib/ledger.js";
import {
  DEFAULT_SWEEP_POLICY,
  runSweep,
  type OpenPrView,
  type SweepDeps,
  type SweepPolicy,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-event-review-drain-")), "ledger.ndjson");
}

function reviewablePr(prNumber: number, createdAt: string): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/o/r/pull/${prNumber}`,
    taskId: `W1-DRAIN-${prNumber}`,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    createdAt,
    lastActivityAt: createdAt,
    headSha: `sha-${prNumber}`,
    autoMergeArmed: false,
  };
}

function fakeDeps(path: string, overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: path,
    runId: "W1-T2584-1",
    now: () => Date.parse("2026-09-01T20:00:00Z"),
    ...overrides,
  };
}

const OLDEST_FIRST = [
  reviewablePr(1, "2026-09-01T15:00:00Z"),
  reviewablePr(2, "2026-09-01T16:00:00Z"),
  reviewablePr(3, "2026-09-01T17:00:00Z"),
  reviewablePr(4, "2026-09-01T18:00:00Z"),
  reviewablePr(5, "2026-09-01T19:00:00Z"),
];

test("W1-T2584: one full sweep drains five eligible reviews through two lanes without exceeding two in flight", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const started: number[] = [];
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 2 };
  const deps = fakeDeps(ledgerPath(), {
    postReview: async (pr) => {
      started.push(pr.prNumber);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => setImmediate(resolve));
      inFlight -= 1;
    },
  });

  const summary = await runSweep([...OLDEST_FIRST].reverse(), deps, policy);

  assert.deepEqual(started, [1, 2, 3, 4, 5], "every eligible head starts, in oldest-first order");
  assert.equal(maxInFlight, 2, "reviewLanes bounds simultaneous reviewers, not pass throughput");
  assert.equal(summary.actionsTaken, 5);
});

test("W1-T2584: a provider-headroom stand-down closes later admissions and every unstarted head recovers next pass", async () => {
  const path = ledgerPath();
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1 };
  const firstPassAttempts: number[] = [];
  const firstDeps = fakeDeps(path, {
    postReview: (pr) => {
      firstPassAttempts.push(pr.prNumber);
      throw new GhPaceFloorStandDownError({ resource: "core", remaining: 20, limit: 5000 });
    },
  });

  await runSweep([...OLDEST_FIRST.slice(0, 3)].reverse(), firstDeps, policy);

  assert.deepEqual(firstPassAttempts, [1], "no later reviewer starts after the capacity refusal is observed");
  const firstLines = readLedgerLines(path);
  assert.equal(firstLines.some((line) => line.step === "review.post_refused"), false, "capacity writes no review outcome key");
  const unstarted = firstLines.filter(
    (line) => line.step === "sweep.disposed" && [2, 3].includes(Number(line.pr_number)),
  );
  assert.equal(unstarted.length, 2);
  assert.ok(unstarted.every((line) => line.acted === false && /provider capacity/.test(String(line.stand_down_reason))));

  const recovered: number[] = [];
  await runSweep(
    [...OLDEST_FIRST.slice(0, 3)].reverse(),
    fakeDeps(path, { runId: "W1-T2584-2", postReview: (pr) => { recovered.push(pr.prNumber); } }),
    policy,
  );
  assert.deepEqual(recovered, [1, 2, 3], "the refused and unstarted heads remain level-trigger eligible");
});

test("W1-T2584: the continuation gate is checked before every later admission and releases unstarted keys", async () => {
  const path = ledgerPath();
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1 };
  let continueAdmissions = true;
  const firstPassAttempts: number[] = [];
  await runSweep(
    OLDEST_FIRST.slice(0, 3),
    fakeDeps(path, {
      continueReviewAdmissions: () => continueAdmissions,
      postReview: (pr) => {
        firstPassAttempts.push(pr.prNumber);
        continueAdmissions = false;
      },
    }),
    policy,
  );
  assert.deepEqual(firstPassAttempts, [1], "the closed continuation gate admits no later reviewer");

  continueAdmissions = true;
  const recovered: number[] = [];
  await runSweep(
    OLDEST_FIRST.slice(0, 3),
    fakeDeps(path, {
      runId: "W1-T2584-2",
      continueReviewAdmissions: () => continueAdmissions,
      postReview: (pr) => { recovered.push(pr.prNumber); },
    }),
    policy,
  );
  assert.deepEqual(recovered, [1, 2, 3], "released keys let the ordinary next pass recover every head");
});

test("W1-T2584/W1-T2771: an active review remains exclusive while an unstarted queued review may be overtaken", async () => {
  const path = ledgerPath();
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1 };
  let releaseFirst: () => void = () => {};
  let announceFirst: () => void = () => {};
  const firstStarted = new Promise<void>((resolve) => { announceFirst = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const fullAttempts: number[] = [];
  const lightAttempts: number[] = [];

  const fullPass = runSweep(
    OLDEST_FIRST.slice(0, 2),
    fakeDeps(path, {
      postReview: async (pr) => {
        fullAttempts.push(pr.prNumber);
        if (pr.prNumber === 1) {
          announceFirst();
          await firstGate;
        }
      },
    }),
    policy,
  );
  await firstStarted;

  const activeLightSummary = await runSweep(
    [OLDEST_FIRST[0]],
    fakeDeps(path, { runId: "W1-T2584-LIGHT-ACTIVE", postReview: (pr) => { lightAttempts.push(pr.prNumber); } }),
    policy,
  );
  assert.equal(lightAttempts.length, 0, "the concurrent pass cannot double-post the actively running first head");
  assert.equal(activeLightSummary.actions[0].acted, false);

  const pendingLightSummary = await runSweep(
    [OLDEST_FIRST[1]],
    fakeDeps(path, {
      runId: "W1-T2584-LIGHT-PENDING",
      postReview: (pr) => {
        lightAttempts.push(pr.prNumber);
        appendLedger(path, {
          run_id: "W1-T2584-LIGHT-PENDING",
          task_id: pr.taskId ?? "",
          step: "review.posted",
          head_sha: pr.headSha,
          state: "success",
        });
      },
    }),
    policy,
  );
  assert.deepEqual(lightAttempts, [2], "the queued second head owns no mutex until the full sweep starts it");
  assert.equal(pendingLightSummary.actions[0].acted, true);

  releaseFirst();
  await fullPass;
  assert.deepEqual(fullAttempts, [1], "the full sweep re-reads the overtaking pass's durable outcome and never double-posts");
});

test("W1-T2584: the shipped review width remains two", () => {
  assert.equal(DEFAULT_SWEEP_POLICY.reviewLanes, 2);
});

test("W1-T2584: the daemon sweep hook forwards its production continuation callback into runSweep", () => {
  const source = readFileSync(join(process.cwd(), "src", "run-task.ts"), "utf8");
  const start = source.indexOf("export function buildSweepHook(");
  const end = source.indexOf("export function lightPassActionable(", start);
  assert.ok(start >= 0 && end > start, "the production daemon sweep hook is present");
  const body = source.slice(start, end);
  assert.match(body, /return async \(continueReviewAdmissions = \(\) => true\) =>/);
  assert.match(
    body,
    /updatedForWorkflow,\s+\/\/ W1-T2584:[\s\S]*?continueReviewAdmissions,/,
    "the callback received from runGatedSweep reaches SweepDeps rather than ending at a dead seam",
  );
});
