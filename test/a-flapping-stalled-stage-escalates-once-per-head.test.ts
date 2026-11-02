// test/a-flapping-stalled-stage-escalates-once-per-head.test.ts
//
// LIVE 2026-10-27: PR 14763 (W1-T10618, head 50628d6) filed three identical stage-stall issues in ten minutes:
// #14777 (09:01Z), #14779 (09:06Z) and #14783 (09:11Z), each "escalated for 0 minutes (owner: none)" with a fresh
// `since`. PR 14691 did the same on `plan-proof-unrunnable` (#14736 05:30Z, #14739 05:37Z). The stage dedup keys on
// [pr, blocker, blocker_since], and blocker_since restarts whenever the PR's newest `sweep.disposed` row names a
// different blocker, so a blocker that flaps between passes at one head is a "new" stage on every flip.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { test } from "node:test";
import { readLedgerLines } from "#src/lib/status.js";
import { runSweepLightPass, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const T0 = Date.parse("2026-10-27T09:01:04.429Z");
const HEAD = "50628d6f807f0a075388c51fb3b98acd6cfdd967";
const TASK = "W1-T10618";
const CLAIM = "approved Wreckterra cases reach a guarded build";
const LOOP = "the same unmet criterion failed review twice at this head";

const stalled: OpenPrView = {
  prNumber: 14763, prUrl: "https://github.com/craigoley/remudero/pull/14763", taskId: TASK,
  headSha: HEAD, headRefName: "run-W1-T10618-1793082123892", reviewState: "failure", checksState: "green",
  unmetCriteria: [{ claim: CLAIM, reason: "no registered execution consumer" }] as OpenPrView["unmetCriteria"],
  priorStrikes: 1, lastActivityAt: "2026-10-27T08:40:00Z", autoMergeArmed: false,
  strikeHistory: [{ strike: 1, round: "fresh", unmetCount: 1, unmetClaims: [CLAIM], ciGreen: true, reviewState: "failure" }],
  progressEscalation: { loop: LOOP, reason: "another round would repeat the refused edit", judged: true },
};

function scene() {
  const ledger = writeLedger([]);
  const escalations: string[] = [];
  let now = T0;
  const deps: SweepDeps = {
    ledgerPath: ledger.path, runId: "DAEMON-1793088011402", now: () => now,
    arm: () => "hold-refused", close: () => {}, dispatchFix: () => {}, postReview: () => {},
    escalate: (_pr, reason) => { escalations.push(reason); },
  };
  const pass = (view: OpenPrView = stalled) => runSweepLightPass([view], { ...deps,
    actionable: (d) => d === "post-review", standDownReasonFor: () => "deferred to full sweep (light pass)" });
  /** Another pass at the same head reads a different blocker, which is what restarts blocker_since. */
  const interleave = (minutes: number) => {
    now += minutes * 60_000;
    appendFileSync(ledger.path, `${JSON.stringify({ ts: new Date(now - 1000).toISOString(), run_id: "full", task_id: TASK,
      step: "sweep.disposed", pr_number: stalled.prNumber, head_sha: HEAD, disposition: "blocked-fixable", acted: true,
      blocker: "review-failed", blocker_owner: "fix-lane", blocker_since: new Date(now - 1000).toISOString() })}\n`);
  };
  const stuck = () => readLedgerLines(ledger.path).filter(row => row.step === "pr.stuck");
  return { deps, escalations, pass, interleave, stuck, advance: (ms: number) => { now += ms; } };
}

test("a stalled stage whose blocker flaps between passes at one head escalates once", async () => {
  const s = scene();
  await s.pass();
  assert.equal(s.escalations.length, 1, "positive control: the first sight of the ownerless stage escalates");
  for (const minutes of [5, 5, 5]) {
    s.interleave(minutes);
    await s.pass();
  }
  // Each flip restarted blocker_since, so without the head bound this filed four issues (one per pass).
  assert.equal(s.escalations.length, 1, s.escalations.join("\n---\n"));
  assert.equal(new Set(s.stuck().map(row => row.blocker_since)).size, 1, "only the first stage was recorded as stuck");
});

test("a flapping stalled stage re-escalates on a new head, and at one head only after the renotify interval", async () => {
  const s = scene();
  await s.pass();
  s.interleave(5);
  await s.pass({ ...stalled, headSha: "0123456789abcdef0123456789abcdef01234567" });
  assert.equal(s.escalations.length, 2, "a new head is a new stage");
  s.interleave(5);
  await s.pass();
  assert.equal(s.escalations.length, 2, "back at the first head, still inside the interval");
  s.advance(24 * 3_600_000);
  s.interleave(1);
  await s.pass();
  assert.equal(s.escalations.length, 3, "a stall nobody acted on for a day is reported again");
});
