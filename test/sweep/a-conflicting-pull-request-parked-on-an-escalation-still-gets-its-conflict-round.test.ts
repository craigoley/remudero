// W1-T12544: a merge conflict grows with every main commit, and a design question or a review question does not stop
// the branch from needing main. #18033 stayed dirty for 3.6 hours behind a needs-design escalation; #18015 and #18037
// stood down on a needs-human escalation while they were conflicted. These tests pin that the conflict round runs under
// such a hold, and that the hold still applies at the merge head the round pushes.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { systemClock } from "#src/lib/clock.js";
import { openEscalationStandDownReason, type OpenIssue } from "#src/lib/escalate.js";
import {
  DEFAULT_SWEEP_POLICY, deriveDisposition, runSweep, type FixDispatchEvidence, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const TASK = "W1-T12544";
const HELD_HEAD = "3ddaee544d2f1f0d9a3c6b1e7f1a2b3c4d5e6f70";
const MERGE_HEAD = "80aa617193a03c2fdc244b6e4f1e328e650cc4d0";
const OUTSIDE_HEAD = "c3edd4a3bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PR_URL = "https://github.com/o/r/pull/18033";
const ISSUE_URL = "https://github.com/o/r/issues/18100";
const DESIGN_REASON = "the task contract names two incompatible ledger shapes";
const EVIDENCE = { files: [{ path: "src/lib/example.ts", oursDeleted: 0, theirsDeleted: 0 }],
  oursLog: "branch changes", theirsLog: "main changes" };

type Row = Record<string, unknown>;

function prAt(now: number, headSha: string, conflicted: boolean, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 18033, prUrl: PR_URL, taskId: TASK, headSha, headRefName: `run-${TASK}-1794610450000`,
    autoMergeArmed: false, priorStrikes: 0, unmetCriteria: [],
    lastActivityAt: new Date(now).toISOString(), createdAt: new Date(now - 60_000).toISOString(),
    ...(conflicted
      ? { reviewState: "success" as const, checksState: "green" as const, mergeState: "dirty" as const, mergeConflict: EVIDENCE }
      : { reviewState: "none" as const, checksState: "red" as const, mergeState: "clean" as const,
        ciFailures: [{ name: "ci-shard (1/8)", logTail: "not ok 1 - fixture behavior" }], redRequiredChecks: ["ci-shard (1/8)"] }),
    ...over,
  };
}

/** A worker round at HELD_HEAD that ended NEEDS_DESIGN, as the fix rung writes it. */
function designRows(now: number, task = TASK, prUrl = PR_URL): Row[] {
  const common = { task_id: task, head_sha: HELD_HEAD, run_id: "DESIGN-ROUND", host: "fixture-host", actor_pid: 777 };
  const round = { ...common, round_id: "DESIGN-ROUND:1", repair_pr_url: prUrl };
  return [
    { ...round, step: "fix.dispatch", ts: new Date(now - 9000).toISOString(), mode: "ci-log" },
    { ...common, step: "fix.needs_design", ts: new Date(now - 8000).toISOString(), reason: DESIGN_REASON },
    { ...round, step: "fix.done", ts: new Date(now - 7000).toISOString(), fix_outcome: "NEEDS_DESIGN", subtype: "success" },
  ];
}

/** The conflict round at HELD_HEAD that pushed MERGE_HEAD. `mode` other than merge-conflict makes it a code round. */
function conflictRoundRows(now: number, mode = "merge-conflict"): Row[] {
  const round = { task_id: TASK, head_sha: HELD_HEAD, run_id: "CONFLICT-ROUND", host: "fixture-host", actor_pid: 778,
    round_id: "CONFLICT-ROUND:1", repair_pr_url: PR_URL };
  return [
    { ...round, step: "fix.dispatch", ts: new Date(now - 5000).toISOString(), mode },
    { ...round, step: "fix.done", ts: new Date(now - 4000).toISOString(), fix_outcome: "FIXED", subtype: "success",
      pushed_head_sha: MERGE_HEAD },
  ];
}

function openIssue(cause?: string, head = HELD_HEAD): OpenIssue {
  return { number: 18100, title: `[BLOCKED] ${TASK}: PR ${PR_URL} needs a clarification`, url: ISSUE_URL,
    body: `**Class:** BLOCKED\n**Task:** ${TASK}\n**Head:** ${head}\n${cause === undefined ? "" : `**Cause:** ${cause}\n`}\nPR ${PR_URL}\n` };
}

function fixture(t: TestContext, rows: Row[], issues: OpenIssue[] = []) {
  const now = systemClock.now(), dir = ownedFixtureDir(t, "conflict-round-under-hold").dir;
  const path = join(dir, "ledger.ndjson");
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const effects = { admissions: 0, evidence: [] as FixDispatchEvidence[], escalations: [] as string[] };
  const deps: SweepDeps = { ledgerPath: path, runId: "CONFLICT-SWEEP", now: () => now,
    arm: () => assert.fail("a held PR cannot arm"), close: () => assert.fail("a held PR cannot close"),
    dispatchFix: (_pr, facts) => { effects.evidence.push(facts); }, escalate: (_pr, why) => { effects.escalations.push(why); },
    claimFixAdmission: () => { effects.admissions++; return { admitted: true }; },
    readOpenEscalations: async () => issues,
    readActiveWorkerCount: () => 0, readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
  };
  const disposed = () => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as Row)
    .filter(row => row.step === "sweep.disposed");
  return { deps, effects, disposed, now };
}

test("W1-T12544 criterion 1: a conflicted PR under a terminal design handoff gets its conflict round", async t => {
  const now = systemClock.now();
  const f = fixture(t, designRows(now));
  const pr = prAt(f.now, HELD_HEAD, true);
  assert.equal(deriveDisposition(pr, DEFAULT_SWEEP_POLICY, f.now).disposition, "conflicted", "control: the head is conflicted");
  const summary = await runSweep([pr], f.deps);
  assert.equal(summary.actions[0]!.disposition, "conflicted");
  assert.equal(f.effects.evidence.length, 1, "one conflict round is dispatched");
  assert.deepEqual(f.effects.evidence[0]!.mergeConflict, EVIDENCE, "the round carries the captured conflict files");
  assert.equal(f.effects.escalations.length, 0, "the design question is not asked again for the conflict");
  const row = f.disposed().at(-1)!;
  assert.deepEqual([row.disposition, row.design_hold_kept, row.acted], ["conflicted", true, true]);
  assert.match(String(row.reason), /design hold still applies at the head it pushes/);
});

test("W1-T12544 criterion 2: an open escalation with no cause or another cause does not stand down a conflict round", async t => {
  for (const cause of [undefined, "review", "ci"]) {
    const issue = openIssue(cause);
    assert.equal(openEscalationStandDownReason(HELD_HEAD, issue, undefined, { conflictEvidenceCaptured: true, conflictRound: true }),
      undefined, `${cause ?? "no cause"}: a conflict round is not held`);
    assert.match(openEscalationStandDownReason(HELD_HEAD, issue, undefined, { conflictEvidenceCaptured: true })!.reason,
      /ALREADY OPEN/, `${cause ?? "no cause"}: control: a code round at the same head is still held`);
    const f = fixture(t, [], [issue]);
    const summary = await runSweep([prAt(f.now, HELD_HEAD, true)], f.deps);
    assert.equal(summary.actions[0]!.disposition, "conflicted");
    assert.equal(f.effects.evidence.length, 1, `${cause ?? "no cause"}: the conflict round is dispatched`);
    const row = f.disposed().at(-1)!;
    assert.deepEqual([row.disposition, row.escalation_hold_kept], ["conflicted", ISSUE_URL]);
  }
});

test("W1-T12544 criterion 3: the design hold and the escalation still hold at the merge head the conflict round pushed", async t => {
  const now = systemClock.now();
  const design = fixture(t, [...designRows(now), ...conflictRoundRows(now)]);
  const atMerge = await runSweep([prAt(design.now, MERGE_HEAD, false)], design.deps);
  assert.equal(atMerge.actions[0]!.disposition, "refused-escalate", "no code fix round at the merge head");
  assert.match(atMerge.actions[0]!.reason, new RegExp(DESIGN_REASON));
  assert.equal(design.effects.admissions, 0);
  assert.equal(design.effects.evidence.length, 0);
  assert.equal(design.disposed().at(-1)!.hold_head_sha, HELD_HEAD);

  const escalation = fixture(t, conflictRoundRows(now), [openIssue("review")]);
  await runSweep([prAt(escalation.now, MERGE_HEAD, false)], escalation.deps);
  assert.equal(escalation.effects.evidence.length, 0, "the open escalation at the held head holds the merge head");
  assert.match(String(escalation.disposed().at(-1)!.stand_down_reason), /ALREADY OPEN/);

  // A head the conflict round did not push is outside the carry: the hold does not follow it.
  const outsideCases: Array<[Row[], string]> = [
    [[...designRows(now), ...conflictRoundRows(now, "ci-log")], MERGE_HEAD],
    [[...designRows(now), ...conflictRoundRows(now)], OUTSIDE_HEAD],
  ];
  for (const [rows, head] of outsideCases) {
    const outside = fixture(t, rows);
    const summary = await runSweep([prAt(outside.now, head, false)], outside.deps);
    assert.equal(summary.actions[0]!.disposition, "blocked-fixable", `${head}: a code fix is admitted`);
    assert.equal(outside.effects.evidence.length, 1);
  }
  const later = fixture(t, conflictRoundRows(now), [openIssue("review")]);
  await runSweep([prAt(later.now, OUTSIDE_HEAD, false)], later.deps);
  assert.equal(later.effects.evidence.length, 1, "an escalation at the held head does not hold an outside head");
});

test("W1-T12544 criterion 4: no captured evidence, or an escalation about the conflict, keeps today's hold", async t => {
  const now = systemClock.now();
  for (const mergeConflict of [undefined, { files: [], oursLog: "", theirsLog: "" }]) {
    const f = fixture(t, designRows(now));
    await runSweep([prAt(f.now, HELD_HEAD, true, { mergeConflict })], f.deps);
    assert.equal(f.effects.evidence.length, 0, "no conflict round without captured evidence");
    assert.equal(f.disposed().at(-1)!.design_hold_kept, undefined);
  }
  // The one route to `conflicted` with no captured evidence: a fleet-owned head whose merge probe read a conflict.
  const ownedUrl = "https://github.com/o/r/pull/18034";
  const owned = (rows: Row[]) => {
    const g = fixture(t, [...rows, { step: "sweep.merge_probe", pr_number: 18034, head_sha: HELD_HEAD, main_sha: OUTSIDE_HEAD,
      verdict: "conflict", conflict_paths: ["src/lib/example.ts"] }]);
    g.deps.readMainTip = () => OUTSIDE_HEAD;
    g.deps.readPlanRepairFacts = async () => ({ authorLogin: "remudero-fleet[bot]" });
    const pr = prAt(g.now, HELD_HEAD, true, { prNumber: 18034, prUrl: ownedUrl, taskId: undefined,
      headRefName: "plan-garden-1794610450000", mergeableState: "dirty", mergeConflict: undefined });
    return { g, pr };
  };
  const control = owned([]);
  assert.equal((await runSweep([control.pr], control.g.deps)).actions[0]!.disposition, "conflicted",
    "control: the probe route reaches conflicted without captured evidence");
  const probed = owned(designRows(now, "PR-18034", ownedUrl));
  assert.equal((await runSweep([probed.pr], probed.g.deps)).actions[0]!.disposition, "refused-escalate",
    "a probe-only conflict keeps the design hold");
  assert.equal(probed.g.disposed().at(-1)!.design_hold_kept, undefined);
  const conflictCause = openIssue("conflict");
  assert.match(openEscalationStandDownReason(HELD_HEAD, conflictCause, undefined,
    { conflictEvidenceCaptured: true, conflictRound: true })!.reason, /ALREADY OPEN/, "a question about the conflict holds the round");
  const f = fixture(t, [], [conflictCause]);
  await runSweep([prAt(f.now, HELD_HEAD, true)], f.deps);
  assert.equal(f.disposed().at(-1)!.escalation_hold_kept, undefined, "the sweep does not record the conflict question as outranked");
});
