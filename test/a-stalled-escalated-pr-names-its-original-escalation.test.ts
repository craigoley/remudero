// test/a-stalled-escalated-pr-names-its-original-escalation.test.ts
//
// LIVE 2026-10-26: PR 14326 (W1-T9338, head bd1bee9) failed remudero-review twice on the same criterion
// (04:55Z, 05:28Z). The progress judge ruled the fix loop and escalated it at that head, and every later
// pass stood down as "already escalated; awaiting new evidence or an operator answer". At 10:05:49Z the rule
// table read the same identical repeat as `blocked-ambiguous`, so the blocker became `escalated`, whose owner
// is NONE. A light pass defers that disposition to the full sweep, so the stage-stall arm reported it on its
// first sight and filed issue 14390: "escalated for 0 minutes (owner: none) ... DIAGNOSIS: unknown signature".
// The operator got a second, unactionable question and the progress judge's reason was nowhere in it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readLedgerLines } from "#src/lib/status.js";
import { ownEscalationAtHead, runSweep, runSweepLightPass, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const NOW = Date.parse("2026-10-26T10:05:49.864Z");
const HEAD = "bd1bee9288e82a86e43c04c613c04425dcbd6282";
const TASK = "W1-T9338";
const CLAIM = "sweepCommand is defined in the sweep module, and src/run-task.ts only delegates to it";
const LOOP = "the same unmet criterion failed review twice at this head";
const JUDGED = `fix progress loop: ${LOOP} — another round would repeat the refused edit`;
const at = (iso: string) => `2026-10-26T${iso}Z`;

const stalled: OpenPrView = {
  prNumber: 14326, prUrl: "https://github.com/craigoley/remudero/pull/14326", taskId: TASK,
  headSha: HEAD, headRefName: "run-W1-T9338-1792980000000", reviewState: "failure", checksState: "green",
  unmetCriteria: [{ claim: CLAIM, reason: "src/run-task.ts still defines the handler" }] as OpenPrView["unmetCriteria"],
  priorStrikes: 1, lastActivityAt: at("05:28:03"), autoMergeArmed: false,
  strikeHistory: [{ strike: 1, round: "fresh", unmetCount: 1, unmetClaims: [CLAIM], ciGreen: true, reviewState: "failure" }],
  progressEscalation: { loop: LOOP, reason: "another round would repeat the refused edit", judged: true },
};

/** The progress judge's escalation at 05:31 and the latched passes after it, each blocker `review-failed`. */
function judgedAtHead(): Record<string, unknown>[] {
  const row = (ts: string, standDown: string) => ({
    ts: at(ts), run_id: "DAEMON-1793004859639", task_id: TASK, step: "sweep.disposed", pr_number: stalled.prNumber,
    pr_url: stalled.prUrl, head_sha: HEAD, disposition: "blocked-fixable", acted: false, blocker: "review-failed",
    blocker_owner: "fix-lane", blocker_since: at("04:55:12"),
    reason: `review failing on 1 unmet criterion — would dispatch the fix rung — NOT DISPATCHED this pass: ${standDown}`,
    stand_down_reason: standDown, progress_escalated_key: "input-key-0531",
  });
  return [row("05:31:40", JUDGED),
    row("07:12:05", "this fix progress loop is already escalated; awaiting new evidence or an operator answer"),
    row("09:58:31", "this fix progress loop is already escalated; awaiting new evidence or an operator answer")];
}

function scene(seed: Record<string, unknown>[]) {
  const ledger = writeLedger(seed);
  const escalations: { reason: string; cause?: string }[] = [];
  const deps: SweepDeps = {
    ledgerPath: ledger.path, runId: "DAEMON-1793004859639", now: () => NOW,
    arm: () => "hold-refused", close: () => {}, dispatchFix: () => {}, postReview: () => {},
    escalate: (_pr, reason, question) => { escalations.push({ reason, cause: question.cause }); },
  };
  const rows = (step: string) => readLedgerLines(ledger.path).filter(row => row.step === step);
  return { ledger, deps, escalations, rows };
}

/** The daemon's light ticker: only the review lane acts, so a blocked-ambiguous escalation waits for the full sweep. */
const lightPass = (prs: OpenPrView[], deps: SweepDeps) => runSweepLightPass(prs, { ...deps,
  actionable: (d) => d === "post-review", standDownReasonFor: () => "deferred to full sweep (light pass)" });

test("a stalled PR whose own escalation is still open escalates once, naming that escalation", async () => {
  const s = scene(judgedAtHead());
  await lightPass([stalled], s.deps);
  const disposed = s.rows("sweep.disposed").at(-1)!;
  assert.equal(disposed.disposition, "blocked-ambiguous");
  assert.equal(disposed.blocker, "escalated");
  assert.equal(disposed.blocker_owner, "NONE");
  assert.equal(disposed.blocker_age_ms, 0);
  assert.equal(disposed.acted, false);
  // The original may never have reached a person, so the stall is still reported -- by name, not as unknown.
  assert.equal(s.escalations.length, 1, JSON.stringify(s.escalations));
  assert.match(s.escalations[0].reason, new RegExp(`already escalated at ${at("05:31:40").replace(/[.]/g, "\\.")}, still awaiting an operator`));
  assert.doesNotMatch(s.escalations[0].reason, /unknown signature/);
  assert.equal(s.escalations[0].cause, "stage-stall");
  const stuck = s.rows("pr.stuck");
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].original_escalation, "open");
  assert.equal(stuck[0].original_escalation_at, at("05:31:40"));
  assert.equal(disposed.stage_stuck, true);
  // The next pass is the same stage: no second escalation, and no second stuck row.
  await lightPass([stalled], s.deps);
  assert.equal(s.escalations.length, 1);
  assert.equal(s.rows("pr.stuck").length, 1);
});

test("a stalled escalated PR names the original escalation's reason instead of unknown signature", async () => {
  const open = scene(judgedAtHead());
  await lightPass([stalled], open.deps);
  const diagnosis = String(open.rows("pr.stuck")[0].diagnosis);
  assert.doesNotMatch(diagnosis, /unknown signature/);
  assert.equal(diagnosis, `already escalated at ${at("05:31:40")}, still awaiting an operator: ${JUDGED}`);
  // The operator answered, which re-armed the fix rung, but the dispatch backstop that escalated at 09:40 still
  // holds this head: the stage is stalled again, so it escalates, naming that original escalation.
  const hold = "detached fix dispatch failed before fix.dispatch 3 times on #14326 at head bd1bee9 (spawn EAGAIN)";
  const answered = scene([
    ...[1, 2, 3].map(n => ({ ts: at(`09:3${n}:00`), step: "sweep.fix.dispatch_failed", task_id: TASK,
      pr_number: stalled.prNumber, head_sha: HEAD, error: "spawn EAGAIN" })),
    { ts: at("09:40:00"), run_id: "full", task_id: TASK, step: "sweep.disposed", pr_number: stalled.prNumber, head_sha: HEAD,
      disposition: "blocked-fixable", acted: false, blocker: "escalated", blocker_since: at("09:40:00"),
      reason: `would dispatch — NOT DISPATCHED this pass: ${hold}`, stand_down_reason: hold,
      fix_dispatch_failed_escalated: true, dispatch_held: "fix_dispatch_failed" },
    { ts: at("10:00:00"), run_id: "full", task_id: TASK, step: "sweep.disposed", pr_number: stalled.prNumber, head_sha: HEAD,
      disposition: "blocked-fixable", acted: false, blocker: "review-failed", blocker_since: at("10:00:00") },
  ]);
  await lightPass([{ ...stalled, pendingAnswer: { constraint: "keep the handler in src/cli/commands/sweep.ts" } }],
    answered.deps);
  assert.equal(answered.rows("sweep.disposed").at(-1)?.blocker, "escalated");
  assert.equal(answered.escalations.length, 1);
  assert.equal(answered.escalations[0].cause, "stage-stall");
  assert.match(answered.escalations[0].reason, /escalated for 0 minutes \(owner: none\)/);
  assert.ok(answered.escalations[0].reason.includes(
    `DIAGNOSIS: already escalated at ${at("09:40:00")} and answered, yet still stalled: ${hold}`), answered.escalations[0].reason);
  assert.equal(answered.rows("pr.stuck")[0].original_escalation, "answered");
  // A filed blocked-ambiguous escalation at this head is read the same way, by its own reason.
  const filed = ownEscalationAtHead([
    { ts: at("06:00:00"), step: "sweep.disposed", pr_number: stalled.prNumber, head_sha: HEAD,
      disposition: "blocked-ambiguous", acted: true, reason: "post-review-loop: the same input reviewed 4 times" },
    { ts: at("06:02:00"), step: "sweep.disposed", pr_number: stalled.prNumber, head_sha: HEAD,
      disposition: "blocked-ambiguous", acted: false, deduped: true, reason: "post-review-loop: deduped" },
    { ts: at("06:03:00"), step: "sweep.disposed", pr_number: stalled.prNumber, head_sha: "another-head",
      disposition: "blocked-ambiguous", acted: true, reason: "another head's escalation" },
  ], stalled);
  assert.deepEqual(filed, { ts: at("06:00:00"), reason: "post-review-loop: the same input reviewed 4 times" });
  const held = ownEscalationAtHead([
    { ts: at("06:10:00"), step: "sweep.disposed", pr_number: stalled.prNumber, head_sha: HEAD,
      fix_dispatch_failed_escalated: true, stand_down_reason: "detached fix dispatch failed 3 times", reason: "x" },
    { ts: at("06:12:00"), step: "sweep.disposed", pr_number: stalled.prNumber, head_sha: HEAD,
      fix_dispatch_failed_escalated: true, stand_down_reason: "repeat", reason: "x" },
  ], stalled);
  assert.deepEqual(held, { ts: at("06:10:00"), reason: "detached fix dispatch failed 3 times" });
});

test("a stalled escalated PR whose original reason is unreadable still escalates and says so", async () => {
  // No escalation of this PR at this head is in the ledger: fail closed, but say what the stage is.
  const absent = scene([]);
  await lightPass([stalled], absent.deps);
  assert.equal(absent.escalations.length, 1);
  const reason = absent.escalations[0].reason;
  assert.doesNotMatch(reason, /unknown signature/);
  assert.match(reason, /DIAGNOSIS: already escalated \(reason unreadable: no escalation of this PR at head bd1bee9 is in the ledger\); this pass: fix strike repeated the identical unmet criteria/);
  assert.equal(absent.rows("pr.stuck")[0].original_escalation, "unreadable");
  // The escalation's row is there but carries no sentence.
  const blank = scene(judgedAtHead().map(row => ({ ...row, reason: undefined, stand_down_reason: undefined })));
  await lightPass([stalled], blank.deps);
  assert.equal(blank.escalations.length, 1);
  assert.ok(blank.escalations[0].reason.includes(`DIAGNOSIS: already escalated at ${at("05:31:40")} (reason unreadable)`),
    blank.escalations[0].reason);
  assert.equal(blank.rows("pr.stuck")[0].original_escalation, "unreadable");
  // An escalation at a superseded head is not this head's.
  const moved = scene(judgedAtHead().map(row => ({ ...row, head_sha: "0123456789abcdef0123456789abcdef01234567" })));
  await lightPass([stalled], moved.deps);
  assert.equal(moved.escalations.length, 1);
  assert.match(moved.escalations[0].reason, /already escalated \(reason unreadable/);
});

test("every other stalled blocker escalates exactly as before", async () => {
  const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
  const green: OpenPrView = { ...stalled, reviewState: "success", unmetCriteria: [], strikeHistory: [],
    progressEscalation: undefined, priorStrikes: 0 };
  for (const [blocker, minutes, view, deps] of [
    ["awaiting-arm", 40, green, {}],
    ["conflict", 31, { ...green, mergeState: "dirty" as const }, { actionable: () => false }],
    ["own-red", 46, { ...green, checksState: "red" as const }, { actionable: () => false }],
  ] as const) {
    // Even with an open escalation of this very head in the ledger, a non-escalated stage files as before.
    const s = scene([...judgedAtHead(), { ts: ago(minutes), run_id: "old", task_id: TASK, step: "sweep.disposed",
      pr_number: stalled.prNumber, head_sha: HEAD, disposition: "mergeable", acted: false, blocker, blocker_since: ago(minutes) }]);
    await runSweep([view], { ...s.deps, ...deps });
    const stuck = s.rows("pr.stuck");
    assert.equal(stuck.length, 1, blocker);
    assert.equal(stuck[0].blocker, blocker);
    assert.equal(stuck[0].diagnosis, "unknown signature", blocker);
    assert.equal(stuck[0].original_escalation, undefined, blocker);
    assert.equal(s.escalations.length, 1, blocker);
    assert.match(s.escalations[0].reason, new RegExp(`${blocker} for ${minutes} minutes.*DIAGNOSIS: unknown signature`), blocker);
  }
});
