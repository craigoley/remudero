// W1-T12544: a merge conflict grows with every main commit, and a design question or a review question does not stop
// the branch from needing main. #18033 stayed dirty for 3.6 hours behind a needs-design escalation; #18015 and #18037
// stood down on a needs-human escalation while they were conflicted. These tests pin that the conflict round runs under
// such a hold, and that the hold still applies at the merge head the round pushes.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { systemClock } from "#src/lib/clock.js";
import { openEscalationStandDownReason, type OpenIssue } from "#src/lib/escalate.js";
import type { FixProgressJudge } from "#src/lib/fix-progress-judge.js";
import { MAX_RETAINED_LINES_PER_STEP, rotateLedger } from "#src/lib/ledger.js";
import { readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import { readLedgerLines } from "#src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY, conflictRoundHeldHead, deriveDisposition, runSweep, type FixDispatchEvidence, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { buildFixRungDispatchArgs, runFixRung } from "#test/helpers/run-task-test.js";
import type { Config } from "#src/lib/config.js";
import type { Mount } from "#src/lib/mounts.js";
import type { SpawnWorkerArgs, WorkerResult } from "#src/lib/worker.js";

const TASK = "W1-T12544";
const HELD_HEAD = "3ddaee544d2f1f0d9a3c6b1e7f1a2b3c4d5e6f70";
const MERGE_HEAD = "80aa617193a03c2fdc244b6e4f1e328e650cc4d0";
const NEXT_MERGE_HEAD = "90aa617193a03c2fdc244b6e4f1e328e650cc4d1";
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
function designRows(now: number, task = TASK, prUrl = PR_URL, head = HELD_HEAD): Row[] {
  const common = { task_id: task, head_sha: head, run_id: "DESIGN-ROUND", host: "fixture-host", actor_pid: 777 };
  const round = { ...common, round_id: "DESIGN-ROUND:1", repair_pr_url: prUrl };
  return [
    { ...round, step: "fix.dispatch", ts: new Date(now - 9000).toISOString(), mode: "ci-log" },
    { ...common, step: "fix.needs_design", ts: new Date(now - 8000).toISOString(), reason: DESIGN_REASON },
    { ...round, step: "fix.done", ts: new Date(now - 7000).toISOString(), fix_outcome: "NEEDS_DESIGN", subtype: "success" },
  ];
}

/** The conflict round at HELD_HEAD that pushed MERGE_HEAD. `mode` other than merge-conflict makes it a code round. */
function conflictRoundRows(now: number, mode = "merge-conflict", from = HELD_HEAD, to = MERGE_HEAD): Row[] {
  const round = { task_id: TASK, head_sha: from, run_id: `CONFLICT-ROUND-${from}`, host: "fixture-host", actor_pid: 778,
    round_id: "CONFLICT-ROUND:1", repair_pr_url: PR_URL };
  return [
    { ...round, step: "fix.dispatch", ts: new Date(now - 5000).toISOString(), mode },
    { ...round, step: "fix.done", ts: new Date(now - 4000).toISOString(), fix_outcome: "FIXED", subtype: "success",
      pushed_head_sha: to },
  ];
}

function retriggerConflictRoundRows(now: number, from = HELD_HEAD, to = MERGE_HEAD): Row[] {
  const round = { task_id: TASK, head_sha: from, run_id: `RETRIGGER-CONFLICT-${from}`, host: "fixture-host", actor_pid: 779,
    round_id: "RETRIGGER-CONFLICT:1", repair_pr_url: PR_URL };
  return [
    { ...round, step: "fix.retrigger", ts: new Date(now - 5000).toISOString(), mode: "merge-conflict" },
    { ...round, step: "fix.done", ts: new Date(now - 4000).toISOString(), fix_outcome: "FIXED", subtype: "success",
      pushed_head_sha: to },
  ];
}

function openIssue(cause?: string, head = HELD_HEAD): OpenIssue {
  return { number: 18100, title: `[BLOCKED] ${TASK}: PR ${PR_URL} needs a clarification`, url: ISSUE_URL,
    body: `**Class:** BLOCKED\n**Task:** ${TASK}\n**Head:** ${head}\n${cause === undefined ? "" : `**Cause:** ${cause}\n`}\nPR ${PR_URL}\n` };
}

function metadataIssueAtB(): OpenIssue {
  const issue = openIssue("ci", MERGE_HEAD);
  const question = "metadata-only required checks proof-discrimination need title/body repair: stale proof";
  return { ...issue, number: 18102, url: "https://github.com/o/r/issues/18102",
    body: issue.body + `\nThe CLARIFICATION-QUESTION rung reconciled this PR to BLOCKED-AMBIGUOUS: ${question}\n\n${question}\n` };
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

test("W1-T12544 criterion 1: a design handoff first recorded at B survives an earlier A→B conflict push", async t => {
  const now = systemClock.now();
  const f = fixture(t, [...conflictRoundRows(now), ...designRows(now, TASK, PR_URL, MERGE_HEAD)]);
  const summary = await runSweep([prAt(f.now, MERGE_HEAD, true)], f.deps);
  assert.equal(summary.actions[0]!.disposition, "conflicted");
  assert.equal(f.effects.evidence.length, 1, "B receives a conflict worker under its own design hold");
  assert.equal(f.disposed().at(-1)!.design_hold_kept, true);
  assert.equal(f.disposed().at(-1)!.hold_head_sha, undefined, "the hold belongs to current head B, not A");
});

test("W1-T12544 criterion 1: a recorded needs-design stand-down cannot override the conflict round", async t => {
  const now = systemClock.now();
  for (const site of ["rung.needs_design", "rung.empty_review_evidence"]) {
    const f = fixture(t, [...designRows(now),
      { step: "fix.stood_down", task_id: TASK, head_sha: HELD_HEAD, read_head_sha: HELD_HEAD,
        site, reason: DESIGN_REASON, ts: new Date(now - 6000).toISOString(), run_id: "DESIGN-ROUND" },
      { step: "sweep.disposed", pr_number: 18033, head_sha: HELD_HEAD, disposition: "blocked-fixable",
        acted: true, run_id: "DESIGN-ROUND", ts: new Date(now - 5500).toISOString() },
    ]);
    const summary = await runSweep([prAt(f.now, HELD_HEAD, true)], f.deps);
    const row = f.disposed().at(-1)!;
    if (site === "rung.needs_design") {
      assert.equal(summary.actions[0]!.disposition, "conflicted");
      assert.equal(f.effects.admissions, 1);
      assert.equal(f.effects.evidence.length, 1, "the production stand-down still permits one conflict round");
      assert.deepEqual(f.effects.evidence[0]!.mergeConflict, EVIDENCE);
      assert.deepEqual([row.disposition, row.design_hold_kept, row.acted], ["conflicted", true, true]);
      assert.equal(f.effects.escalations.length, 0);
    } else {
      assert.equal(summary.actions[0]!.disposition, "refused-escalate", "an unrelated stand-down still holds");
      assert.equal(f.effects.admissions, 0);
      assert.equal(f.effects.evidence.length, 0);
    }
  }
});

test("W1-T12544 criterion 1: the rung's own design stand-down at the conflicted head does not refuse the conflict round", async t => {
  // The production shape after a design round: the sweep dispatched at A, the rung stood down at rung.needs_design and
  // filed its question. The stand-down hold reads that row; it must not turn the conflict round into refused-escalate.
  const now = systemClock.now();
  const at = (ms: number) => new Date(now - ms).toISOString();
  const standDown: Row[] = [
    { step: "sweep.disposed", ts: at(6500), run_id: "EARLIER-SWEEP", task_id: TASK, pr_number: 18033, head_sha: HELD_HEAD,
      disposition: "blocked-fixable", acted: true },
    { step: "fix.stood_down", ts: at(6000), run_id: "DESIGN-ROUND", task_id: TASK, head_sha: HELD_HEAD,
      site: "rung.needs_design", reason: DESIGN_REASON, read_head_sha: HELD_HEAD, issue_url: ISSUE_URL },
  ];
  const control = fixture(t, [...designRows(now), ...standDown]);
  const held = await runSweep([prAt(control.now, HELD_HEAD, false)], control.deps);
  assert.equal(held.actions[0]!.disposition, "refused-escalate", "control: a code round at A is still held");
  const f = fixture(t, [...designRows(now), ...standDown]);
  const summary = await runSweep([prAt(f.now, HELD_HEAD, true)], f.deps);
  assert.equal(summary.actions[0]!.disposition, "conflicted");
  assert.equal(f.effects.evidence.length, 1, "one conflict round is dispatched");
  const row = f.disposed().at(-1)!;
  assert.deepEqual([row.disposition, row.design_hold_kept, row.stand_down_hold], ["conflicted", true, undefined]);
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

test("W1-T12544 criterion 3: a new hold at B survives the B→C conflict push without a code round", async t => {
  const now = systemClock.now();
  const pushes = [...conflictRoundRows(now), ...conflictRoundRows(now, "merge-conflict", MERGE_HEAD, NEXT_MERGE_HEAD)];
  for (const hold of ["design", "escalation"] as const) {
    const rows = hold === "design" ? [...pushes, ...designRows(now, TASK, PR_URL, MERGE_HEAD)] : pushes;
    const issues = hold === "escalation" ? [openIssue("review", MERGE_HEAD)] : [];
    const f = fixture(t, rows, issues);
    const atB = await runSweep([prAt(f.now, MERGE_HEAD, true)], f.deps);
    assert.equal(atB.actions[0]!.disposition, "conflicted", `${hold}: B still gets its conflict round`);
    assert.equal(f.effects.evidence.length, 1);
    assert.equal(f.disposed().at(-1)![hold === "design" ? "design_hold_kept" : "escalation_hold_kept"],
      hold === "design" ? true : ISSUE_URL);
    const atC = await runSweep([prAt(f.now, NEXT_MERGE_HEAD, false)], f.deps);
    assert.equal(f.effects.evidence.length, 1, `${hold}: C admits no code worker`);
    assert.equal(f.effects.admissions, 1, `${hold}: only B's conflict admission occurred`);
    assert.equal(f.disposed().at(-1)!.hold_head_sha, MERGE_HEAD, `${hold}: C carries B's question`);
    if (hold === "design") assert.equal(atC.actions[0]!.disposition, "refused-escalate");
    else assert.match(String(f.disposed().at(-1)!.stand_down_reason), /ALREADY OPEN/);
  }
});

test("W1-T12544 criterion 3: a cleared conflict escalation cannot mask a surviving review hold", async t => {
  for (const receipt of ["fix.done", "fix.retrigger", "sweep.conflict_regenerated"] as const) {
    for (const intermediate of [false, true]) {
      for (const conflictFirst of [true, false]) {
        await t.test(`${receipt}: ${intermediate ? "B→C" : "A→B"}: conflict first ${conflictFirst}`, async t => {
          const now = systemClock.now();
          const from = intermediate ? MERGE_HEAD : HELD_HEAD;
          const to = intermediate ? NEXT_MERGE_HEAD : MERGE_HEAD;
          const conflict = { ...openIssue("conflict", from),
            body: openIssue("conflict", from).body +
              `**Raised-by:** conflict-not-admitted\n**Base:** ${HELD_HEAD}\n` };
          const review = { ...openIssue("review", from), number: 18101,
            url: "https://github.com/o/r/issues/18101" };
          const issues = conflictFirst ? [conflict, review] : [review, conflict];
          const rows = receipt === "fix.done" ? conflictRoundRows(now, "merge-conflict", from, to) :
            receipt === "fix.retrigger" ? retriggerConflictRoundRows(now, from, to) : [{
              step: receipt, ts: new Date(now - 4000).toISOString(), pr_number: 18033,
              head_sha: from, new_head_sha: to, outcome: "pushed",
            }];
          const f = fixture(t, [...(intermediate ? conflictRoundRows(now) : []), ...rows], issues);
          f.deps.readMainTip = () => OUTSIDE_HEAD;
          const facts = { conflictEvidenceCaptured: false, baseSha: OUTSIDE_HEAD };
          assert.equal(openEscalationStandDownReason(from, conflict, undefined, facts), undefined,
            "control: the conflict issue's recorded base has moved");
          assert.match(openEscalationStandDownReason(from, review, undefined, facts)!.reason, /18101/,
            "control: the independent review question is still unanswered");
          await runSweep([prAt(f.now, to, false)], f.deps);
          assert.equal(f.effects.admissions, 0, "no code admission while any matching question survives");
          assert.equal(f.effects.evidence.length, 0);
          assert.equal(f.disposed().at(-1)!.hold_head_sha, from, "the nearest surviving hold owns the merge head");
          assert.match(String(f.disposed().at(-1)!.stand_down_reason), /18101/);

          await runSweep([prAt(f.now, OUTSIDE_HEAD, false)], f.deps);
          assert.equal(f.effects.evidence.length, 1, "control: an outside head is admitted despite both open issues");
          issues.splice(issues.indexOf(review), 1);
          await runSweep([prAt(f.now, to, false)], f.deps);
          assert.equal(f.effects.admissions, 2, "closing the review question releases the merge head");
          assert.equal(f.effects.evidence.length, 2, "the cleared conflict issue alone does not block code repair");
        });
      }
    }
  }
});

test("W1-T12544 criterion 3: newest-200 retention archives conflict pushes without releasing their holds", async t => {
  for (const receipt of ["fix.done", "fix.retrigger", "sweep.conflict_regenerated"] as const) {
    for (const hold of ["design", "review", "ci", "legacy"] as const) {
      await t.test(`${receipt}: ${hold}`, async t => {
        const now = systemClock.now();
        const pushRows = receipt === "fix.done" ? conflictRoundRows(now) : receipt === "fix.retrigger" ?
          retriggerConflictRoundRows(now) : [{
            step: receipt, ts: new Date(now - 4000).toISOString(), pr_number: 18033,
            head_sha: HELD_HEAD, new_head_sha: MERGE_HEAD, outcome: "pushed",
          }];
        const newer = Array.from({ length: MAX_RETAINED_LINES_PER_STEP }, (_, i) =>
          ["fix.dispatch", "fix.retrigger", "fix.done", "sweep.conflict_regenerated"].map(step => ({
            step, ts: new Date(now - 3000 + i).toISOString(), task_id: `W1-T${20000 + i}`,
            pr_number: 20000 + i, run_id: `OTHER-${i}`, head_sha: OUTSIDE_HEAD,
          }))).flat();
        const f = fixture(t, [...(hold === "design" ? designRows(now) : []), ...pushRows, ...newer,
          { step: "cli.invoked", ts: new Date(now).toISOString(), pad: "x".repeat(300_000) }],
        hold === "design" ? [] : [openIssue(hold === "legacy" ? undefined : hold)]);
        const path = f.deps.ledgerPath;
        assert.equal(rotateLedger(path, { ceilingBytes: 256_000, smoothingWindowMs: 0,
          now: () => new Date(now) }).rotated, true, "control: production rotation ran");
        const live = readLedgerLines(path);
        for (const step of ["fix.dispatch", "fix.retrigger", "fix.done", "sweep.conflict_regenerated"]) {
          assert.equal(live.filter(row => row.step === step).length, MAX_RETAINED_LINES_PER_STEP);
          assert.equal(live.some(row => row.step === step && row.head_sha === HELD_HEAD), false,
            `${step}: the conflict-push and design-round receipts left the live file`);
        }
        assert.equal(live.some(row => row.step === "ledger.rotation_shed"), false, "the per-step bound caused the loss");
        if (hold === "design") assert.equal(live.find(row => row.step === "fix.needs_design")!.reason, DESIGN_REASON,
          "the unanswered design question survives retention");
        const pr = prAt(f.now, MERGE_HEAD, false);
        await t.test("ancestry", () => {
          assert.equal(conflictRoundHeldHead(pr, live), MERGE_HEAD, "control: live receipts alone cannot recover the held head");
          assert.equal(conflictRoundHeldHead(pr, live, path), HELD_HEAD);
        });
        await t.test("sweep admission", async () => {
          const summary = await runSweep([pr], f.deps);
          assert.equal(f.effects.admissions, 0, "no code admission while the question remains unanswered");
          assert.equal(f.effects.evidence.length, 0, "no code worker dispatched after retention");
          if (hold === "design") {
            assert.equal(summary.actions[0]!.disposition, "refused-escalate");
            assert.match(summary.actions[0]!.reason, new RegExp(DESIGN_REASON));
          } else assert.match(String(f.disposed().at(-1)!.stand_down_reason), /ALREADY OPEN/);
          assert.equal(f.disposed().at(-1)!.hold_head_sha, HELD_HEAD);
        });
        const outside = await runSweep([prAt(f.now, OUTSIDE_HEAD, false)], f.deps);
        assert.equal(outside.actions[0]!.disposition, "blocked-fixable");
        assert.equal(f.effects.evidence.length, 1, "control: a later outside head is admitted with the same archives");
      });
    }
  }
});

test("W1-T12544 criterion 3: a complete archive keeps the design hold when its live question is absent", async t => {
  for (const receipt of ["fix.done", "fix.retrigger", "sweep.conflict_regenerated"] as const) {
    await t.test(receipt, async t => {
      const now = systemClock.now();
      const pushRows = receipt === "fix.done" ? conflictRoundRows(now) : receipt === "fix.retrigger" ? retriggerConflictRoundRows(now) : [{
        step: receipt, ts: new Date(now - 4000).toISOString(), pr_number: 18033,
        head_sha: HELD_HEAD, new_head_sha: MERGE_HEAD, outcome: "pushed",
      }];
      const newer = Array.from({ length: MAX_RETAINED_LINES_PER_STEP }, (_, i) =>
        ["fix.dispatch", "fix.done", "fix.needs_design", "sweep.conflict_regenerated"].map(step => ({
          step, ts: new Date(now - 3000 + i).toISOString(), task_id: `W1-T${20000 + i}`,
          pr_number: 20000 + i, run_id: `OTHER-${i}`, head_sha: OUTSIDE_HEAD,
        }))).flat();
      const f = fixture(t, [...designRows(now), ...pushRows, ...newer,
        { step: "cli.invoked", ts: new Date(now).toISOString(), pad: "x".repeat(300_000) }]);
      const path = f.deps.ledgerPath;
      assert.equal(rotateLedger(path, { ceilingBytes: 256_000, smoothingWindowMs: 0,
        now: () => new Date(now) }).rotated, true);
      const live = readLedgerLines(path);
      assert.equal(live.filter(row => row.step === "fix.needs_design").length, MAX_RETAINED_LINES_PER_STEP);
      assert.equal(live.some(row => row.task_id === TASK && row.step === "fix.needs_design"), false,
        "the held question itself has left the live ledger");
      const union = readLedgerUnionRecordsSync(dirname(path), {
        step: ["fix.dispatch", "fix.retrigger", "fix.done", "fix.needs_design", "sweep.conflict_regenerated"], refuseIncomplete: true });
      assert.equal(union.ok, true, "control: the archive is complete and readable");
      assert.equal(union.rows.some(row => row.task_id === TASK && row.step === "fix.needs_design" &&
        row.reason === DESIGN_REASON), true, "control: the archived question is present");
      assert.equal(conflictRoundHeldHead(prAt(f.now, MERGE_HEAD, false), live, path), HELD_HEAD);
      const summary = await runSweep([prAt(f.now, MERGE_HEAD, false)], f.deps);
      assert.equal(summary.actions[0]!.disposition, "refused-escalate");
      assert.match(summary.actions[0]!.reason, new RegExp(DESIGN_REASON));
      assert.equal(f.effects.admissions, 0, "an archived unanswered question prevents code admission");
      assert.equal(f.effects.evidence.length, 0);
      assert.equal(f.disposed().at(-1)!.hold_head_sha, HELD_HEAD);
      const outside = await runSweep([prAt(f.now, OUTSIDE_HEAD, false)], f.deps);
      assert.equal(outside.actions[0]!.disposition, "blocked-fixable");
      assert.equal(f.effects.evidence.length, 1, "control: the archive does not hold an outside head");
    });
  }
});

/** Newer rows of other tasks that push this PR's fix rows, its question included, out of the live file on rotation. */
function archivingRows(now: number): Row[] {
  return [...Array.from({ length: MAX_RETAINED_LINES_PER_STEP }, (_, i) =>
    ["fix.dispatch", "fix.retrigger", "fix.done", "fix.needs_design"].map(step => ({
      step, ts: new Date(now - 3000 + i).toISOString(), task_id: `W1-T${20000 + i}`,
      pr_number: 20000 + i, run_id: `OTHER-${i}`, head_sha: OUTSIDE_HEAD, reason: "another task's question",
    }))).flat(), { step: "cli.invoked", ts: new Date(now).toISOString(), pad: "x".repeat(300_000) }];
}

test("W1-T12544 criterion 3: a conflict retrigger receipt carries the design hold to its pushed head", async t => {
  const now = systemClock.now();
  const rows = [...designRows(now), ...retriggerConflictRoundRows(now)];
  const pr = prAt(now, MERGE_HEAD, false);
  assert.equal(conflictRoundHeldHead(pr, rows), HELD_HEAD, "control: the retrigger receipt links B to held head A");
  const f = fixture(t, rows);
  const summary = await runSweep([prAt(f.now, MERGE_HEAD, false)], f.deps);
  assert.equal(summary.actions[0]!.disposition, "refused-escalate");
  assert.match(summary.actions[0]!.reason, new RegExp(DESIGN_REASON));
  assert.equal(f.effects.admissions, 0, "no code fix is admitted at the retrigger-pushed head");
  assert.equal(f.effects.evidence.length, 0);
  assert.equal(f.disposed().at(-1)!.hold_head_sha, HELD_HEAD);
});

test("W1-T12544 criterion 3: a design question that retention archived still holds the conflict-pushed head", async t => {
  // Rotation keeps the newest rows per step for every PR, so a busy fleet archives this PR's fix.needs_design row too.
  const now = systemClock.now();
  const f = fixture(t, [...designRows(now), ...conflictRoundRows(now), ...archivingRows(now)]);
  assert.equal(rotateLedger(f.deps.ledgerPath, { ceilingBytes: 256_000, smoothingWindowMs: 0,
    now: () => new Date(now) }).rotated, true, "control: production rotation ran");
  const live = readLedgerLines(f.deps.ledgerPath);
  assert.equal(live.some(row => row.step === "fix.needs_design" && row.task_id === TASK), false,
    "control: the question is only in the archive");
  const summary = await runSweep([prAt(f.now, MERGE_HEAD, false)], f.deps);
  assert.equal(f.effects.admissions, 0, "no code admission while the archived question is unanswered");
  assert.equal(f.effects.evidence.length, 0);
  assert.equal(summary.actions[0]!.disposition, "refused-escalate");
  assert.match(summary.actions[0]!.reason, new RegExp(DESIGN_REASON));
  assert.equal(f.disposed().at(-1)!.hold_head_sha, HELD_HEAD);
  const outside = await runSweep([prAt(f.now, OUTSIDE_HEAD, false)], f.deps);
  assert.equal(outside.actions[0]!.disposition, "blocked-fixable", "control: an outside head is still admitted");
});

async function activeConflictRung(t: TestContext, hold: "design" | "review" | "ci" | "legacy" | "none", answered = false,
  heads: { from: string; to: string; prior: Row[] } = { from: HELD_HEAD, to: MERGE_HEAD, prior: [] },
  ci: "green" | "red" | "red-unpinned" = "green", archived = false,
  openEscalations?: { issues: OpenIssue[]; closeFails: boolean; baseSha: string; judge?: FixProgressJudge }) {
  const f = fixture(t, [...heads.prior, ...(hold === "design" ? designRows(systemClock.now(), TASK, PR_URL, heads.from) : []),
    ...(archived ? archivingRows(systemClock.now()) : [])]);
  if (archived) assert.equal(rotateLedger(f.deps.ledgerPath, { ceilingBytes: 256_000, smoothingWindowMs: 0 }).rotated, true);
  const root = dirname(f.deps.ledgerPath);
  const mount: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
  const issues = openEscalations?.issues ??
    (hold === "none" || hold === "design" ? [] : [openIssue(hold === "legacy" ? undefined : hold, heads.from)]);
  const spawned: SpawnWorkerArgs[] = [], rows: Row[] = [];
  const closeAttempts: string[] = [];
  let pushedHead = heads.from, reviews = 0, closed = 0, ciReads = 0;
  const minedHeads: Array<string | undefined> = [];
  const args = buildFixRungDispatchArgs({
    task: { id: TASK, title: "conflict round under a hold" }, runId: "ACTIVE-CONFLICT-ROUND", prUrl: PR_URL,
    branch: `run-${TASK}-1794610450000`, worktreePath: join(root, "wt"), mount,
    settingsFile: join(root, "settings.json"), config: { root } as Config, budgetUsd: 5, strikeCap: 3,
    evidence: { unmetCriteria: [], mergeConflict: EVIDENCE, baseSha: openEscalations?.baseSha }, pr: { headSha: heads.from },
    reviewBase: { owner: "o", repo: "r", headCheckoutDir: join(root, "wt"), reviewerMount: mount },
  });
  const outcome = await runFixRung({ ...args,
    escalationJudge: async () => ({ decision: "deliver", reason: "fixture" }),
    deps: {
      ...(openEscalations?.judge ? { fixProgressJudge: openEscalations.judge } : {}),
      spawn: async (workerArgs: SpawnWorkerArgs): Promise<WorkerResult> => {
        spawned.push(workerArgs);
        return { sessionId: "conflict-session", costUsd: 0, numTurns: 1,
          text: "REPORT\nresolved the conflict\nFIX_OUTCOME: FIXED\nPR_URL: (unchanged)", blocks: [], stderr: "",
          subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
          model: "default", effort: "default", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          modelUsage: {}, compactionEvents: [], qualitySuspect: false };
      },
      push: () => { pushedHead = heads.to; return { fixRoundPushedHead: heads.to }; },
      readRemoteBranchHead: async () => pushedHead,
      readHeadShaForProvenance: async () => pushedHead,
      waitForCiGreen: async () => {
        ciReads++;
        if (ci !== "green" && ciReads === 1) {
          if (answered) issues.length = 0;
          return ci === "red" ? { state: "red" as const, sha: pushedHead } : "red" as const;
        }
        return "green" as const;
      },
      fetchCiFailures: async (_url: string, sha?: string) => {
        minedHeads.push(sha);
        return [{ name: "ci-shard (1/8)", logTail: "not ok 1 - fixture behavior" }];
      },
      fetchPrBody: async () => "PR body",
      runReview: async () => {
        reviews++;
        if (answered) issues.length = 0;
        const unmet = ci === "green" && reviews === 1;
        return { ...args.initialReview, headSha: heads.to, state: unmet ? "failure" as const : "success" as const,
          criteria: [{ claim: "the review question still needs an answer", met: !unmet, reason: "observed failure" }] };
      },
      issues: { listOpen: () => issues, create: () => ISSUE_URL, comment: () => {}, closeWithComment: (url: string) => {
        closeAttempts.push(url);
        if (openEscalations?.closeFails) throw new Error("HTTP 502: conflict issue close failed");
        closed++;
      } },
      ledgerPath: f.deps.ledgerPath,
      log: (step: string, extra?: Record<string, unknown>) => {
        const row = { ts: new Date().toISOString(), run_id: "ACTIVE-CONFLICT-ROUND", task_id: TASK, step, ...extra };
        rows.push(row);
        appendFileSync(f.deps.ledgerPath, JSON.stringify(row) + "\n");
      },
      say: () => {}, account: (result: WorkerResult) => result,
      readLiveState: async () => ({ ok: true as const, state: "OPEN" as const }),
    },
  } as never);
  return { f, outcome, spawned, rows, pushedHead, reviews, issues, closed, minedHeads, closeAttempts };
}

test("W1-T12544 criterion 3: a released metadata question at B cannot mask A's unanswered hold at C", async t => {
  for (const receipt of ["fix.done", "fix.retrigger", "sweep.conflict_regenerated"] as const) {
    for (const hold of ["design", "review"] as const) {
      await t.test(`${receipt}: ${hold}`, async t => {
        const now = systemClock.now();
        const push = (from: string, to: string): Row[] => receipt === "fix.done"
          ? conflictRoundRows(now, "merge-conflict", from, to)
          : receipt === "fix.retrigger" ? retriggerConflictRoundRows(now, from, to)
            : [{ step: receipt, pr_number: 18033, head_sha: from, new_head_sha: to, outcome: "pushed" }];
        const metadata = metadataIssueAtB();
        const older = hold === "design" ? designRows(now) : [];
        const issues = hold === "design" ? [metadata] : [metadata, openIssue("review")];
        const f = fixture(t, [...older, ...push(HELD_HEAD, MERGE_HEAD), ...push(MERGE_HEAD, NEXT_MERGE_HEAD)], issues);
        const facts = { conflictEvidenceCaptured: false };
        assert.ok(openEscalationStandDownReason(MERGE_HEAD, metadata, undefined, facts, ["proof-discrimination"]),
          "control: B's metadata issue holds its original red checks");
        assert.equal(openEscalationStandDownReason(MERGE_HEAD, metadata, undefined, facts, ["ci-shard (1/8)"]), undefined,
          "control: the current code red releases B's metadata question");
        await runSweep([prAt(f.now, NEXT_MERGE_HEAD, false)], f.deps);
        assert.equal(f.effects.admissions, 0, "A's unanswered hold prevents code admission at C");
        assert.equal(f.effects.evidence.length, 0);
        assert.equal(f.disposed().at(-1)!.hold_head_sha, HELD_HEAD);

        const released = fixture(t, [...push(HELD_HEAD, MERGE_HEAD), ...push(MERGE_HEAD, NEXT_MERGE_HEAD)], [metadata]);
        await runSweep([prAt(released.now, NEXT_MERGE_HEAD, false)], released.deps);
        assert.equal(released.effects.evidence.length, 1, "control: the released metadata question alone admits code");
      });
    }
  }
});

test("W1-T12544 criterion 3: the active B→C rung checks A's hold before any code-strike judgment", async t => {
  for (const hold of ["design", "review"] as const) {
    await t.test(hold, async t => {
      const heads = { from: MERGE_HEAD, to: NEXT_MERGE_HEAD,
        prior: [...(hold === "design" ? designRows(systemClock.now()) : []), ...conflictRoundRows(systemClock.now())] };
      const judgedHeads: string[] = [];
      const judge: FixProgressJudge = async input => {
        judgedHeads.push(input.headSha);
        return { verdict: "continue", reason: "fixture permits code only after the hold check" };
      };
      const metadata = metadataIssueAtB();
      const issues = hold === "design" ? [metadata] : [metadata, openIssue("review")];
      const r = await activeConflictRung(t, "none", false, heads, "red", false,
        { issues, closeFails: false, baseSha: OUTSIDE_HEAD, judge });
      assert.equal(r.pushedHead, NEXT_MERGE_HEAD, "the conflict round pushes B→C in this invocation");
      assert.deepEqual(r.minedHeads, [NEXT_MERGE_HEAD], "the admission facts are the actual code reds at C");
      assert.deepEqual(judgedHeads, [], "the unanswered hold is checked before the code-strike judge");
      assert.deepEqual(r.rows.filter(row => row.step === "fix.dispatch").map(row => row.mode), ["merge-conflict"]);
      assert.equal(r.spawned.length, 1);
      assert.equal(r.outcome.outcome, hold === "design" ? "needs_design" : "stood_down");
      assert.match(String(r.outcome.reason), hold === "design" ? new RegExp(DESIGN_REASON) : /ALREADY OPEN.*18100/);
      assert.equal(r.closed, 0, "the original question remains unanswered");

      judgedHeads.length = 0;
      const released = await activeConflictRung(t, "none", false,
        { ...heads, prior: conflictRoundRows(systemClock.now()) }, "red", false,
        { issues: [metadata], closeFails: false, baseSha: OUTSIDE_HEAD, judge });
      assert.ok(judgedHeads.length > 0, "control: removing A's hold reaches the code-strike judge");
      assert.deepEqual(released.rows.filter(row => row.step === "fix.dispatch").map(row => row.mode), ["merge-conflict", "ci-log"]);
      assert.equal(released.outcome.outcome, "fixed");
    });
  }
});

test("W1-T12544 criterion 3: the active rung keeps every unanswered hold when closing a cleared conflict issue fails", async t => {
  for (const heads of [
    { from: HELD_HEAD, to: MERGE_HEAD, prior: [] },
    { from: MERGE_HEAD, to: NEXT_MERGE_HEAD, prior: conflictRoundRows(systemClock.now()) },
  ]) {
    for (const conflictFirst of [true, false]) {
      for (const ci of ["green", "red"] as const) {
        await t.test(`${heads.from === HELD_HEAD ? "A→B" : "B→C"}: conflict first ${conflictFirst}: ${ci}`, async t => {
          const conflict = { ...openIssue("conflict", heads.from), body: openIssue("conflict", heads.from).body +
            `**Raised-by:** conflict-not-admitted\n**Base:** ${HELD_HEAD}\n` };
          const review = { ...openIssue("review", heads.from), number: 18101, url: "https://github.com/o/r/issues/18101" };
          const issues = conflictFirst ? [conflict, review] : [review, conflict];
          assert.equal(openEscalationStandDownReason(heads.from, conflict, undefined,
            { conflictEvidenceCaptured: false, baseSha: OUTSIDE_HEAD }), undefined,
            "control: the conflict issue stays cleared after conflict mode ends");
          const r = await activeConflictRung(t, "review", false, heads, ci, false,
            { issues, closeFails: true, baseSha: OUTSIDE_HEAD });
          assert.equal(r.pushedHead, heads.to, "the conflict round pushes the merge head in this invocation");
          assert.equal(r.rows.find(row => row.step === "fix.done")!.pushed_head_sha, heads.to);
          assert.deepEqual(r.rows.filter(row => row.step === "fix.dispatch").map(row => row.mode), ["merge-conflict"],
            "the failed close cannot admit reviewer-unmet or ci-log after the conflict push");
          assert.equal(r.outcome.review.headSha, ci === "green" ? heads.to : heads.from);
          assert.equal(r.reviews, ci === "green" ? 1 : 0);
          assert.ok(r.closeAttempts.length > 0, "the cleared conflict issue's close was attempted");
          assert.ok(r.closeAttempts.every(url => url === conflict.url), "the review issue is never closed");
          assert.equal(r.closed, 0);
          assert.equal(r.issues.includes(review), true, "the review question remains unanswered");
          const failedClose = r.rows.find(row => row.step === "escalation.superseded" && row.delivered === false)!;
          assert.match(String(failedClose.failure), /HTTP 502/);
          assert.equal(r.spawned.length, 1);
          assert.equal(r.outcome.strikes, 1);
          assert.equal(r.outcome.outcome, "stood_down");
          assert.match(String(r.outcome.reason), /ALREADY OPEN.*18101/);
          assert.equal(r.rows.find(row => row.step === "fix.contract_hold")!.issue_url, review.url);

          const released = await activeConflictRung(t, "none", false, heads, ci, false,
            { issues: [conflict], closeFails: true, baseSha: OUTSIDE_HEAD });
          assert.deepEqual(released.rows.filter(row => row.step === "fix.dispatch").map(row => row.mode),
            ["merge-conflict", ci === "green" ? "reviewer-unmet" : "ci-log"],
            "control: removing the review issue admits code despite the remaining cleared conflict issue");
          assert.equal(released.spawned.length, 2);
          assert.equal(released.outcome.outcome, "fixed");
        });
      }
    }
  }
});

test("W1-T12544 criterion 3: red CI after the active conflict push keeps the hold despite a stale review head", async t => {
  for (const ci of ["red", "red-unpinned"] as const) {
    for (const hold of ["design", "review", "ci", "legacy"] as const) {
      await t.test(`${ci}: ${hold}`, async t => {
        const r = await activeConflictRung(t, hold, false, undefined, ci);
        assert.equal(r.pushedHead, MERGE_HEAD);
        assert.equal(r.reviews, 0, "red CI prevents a review at B, leaving the persisted review at A");
        assert.equal(r.outcome.review.headSha, HELD_HEAD);
        assert.deepEqual(r.minedHeads, [ci === "red" ? MERGE_HEAD : undefined], "the red evidence is mined once");
        assert.equal(r.rows.find(row => row.step === "fix.ci_not_green")!.ci, "red");
        assert.equal(r.rows.find(row => row.step === "fix.merge_mode_cleared")!.site, "rung.ci_red");
        assert.deepEqual(r.rows.filter(row => row.step === "fix.dispatch").map(row => row.mode), ["merge-conflict"]);
        assert.equal(r.rows.find(row => row.step === "fix.done")!.head_sha, HELD_HEAD);
        assert.equal(r.rows.find(row => row.step === "fix.done")!.pushed_head_sha, MERGE_HEAD);
        assert.equal(r.spawned.length, 1, "the red merge head admits no ci-log worker");
        assert.equal(r.outcome.strikes, 1);
        assert.equal(r.outcome.outcome, hold === "design" ? "needs_design" : "stood_down");
        assert.match(String(r.outcome.reason), hold === "design" ? new RegExp(DESIGN_REASON) : /ALREADY OPEN/);
        assert.equal(r.closed, 0);
        if (hold !== "design") assert.equal(r.issues[0]!.url, ISSUE_URL, "the original question stays open");
        await runSweep([prAt(r.f.now, MERGE_HEAD, false)], { ...r.f.deps, readOpenEscalations: async () => r.issues });
        assert.equal(r.f.effects.admissions, 0, "a fresh sweep also holds B with red CI");
        assert.equal(r.f.effects.evidence.length, 0);
        assert.equal(r.f.disposed().at(-1)!.hold_head_sha, HELD_HEAD);
      });
    }
  }
});

test("W1-T12544 criterion 3: red CI after B→C keeps a question introduced at B", async t => {
  const heads = { from: MERGE_HEAD, to: NEXT_MERGE_HEAD, prior: conflictRoundRows(systemClock.now()) };
  for (const hold of ["design", "review"] as const) {
    const r = await activeConflictRung(t, hold, false, heads, "red");
    assert.equal(r.pushedHead, NEXT_MERGE_HEAD);
    assert.equal(r.outcome.review.headSha, MERGE_HEAD, "the last review still names B");
    assert.equal(r.reviews, 0);
    assert.deepEqual(r.minedHeads, [NEXT_MERGE_HEAD]);
    assert.deepEqual(r.rows.filter(row => row.step === "fix.dispatch").map(row => row.mode), ["merge-conflict"]);
    assert.equal(r.spawned.length, 1);
    assert.equal(r.outcome.outcome, hold === "design" ? "needs_design" : "stood_down");
    assert.equal(r.closed, 0);
  }
});

test("W1-T12544 criterion 3: red CI at the merge head admits a code worker without a hold or after an answer", async t => {
  for (const answered of [false, true]) {
    const r = await activeConflictRung(t, answered ? "review" : "none", answered, undefined, "red");
    assert.equal(r.spawned.length, 2, "control: red CI is actionable when no unanswered question holds it");
    assert.deepEqual(r.rows.filter(row => row.step === "fix.dispatch").map(row => row.mode), ["merge-conflict", "ci-log"]);
    assert.equal(r.outcome.outcome, "fixed");
    assert.equal(r.outcome.review.state, "success");
  }
});

test("W1-T12544 criterion 3: the active rung preserves the hold through a conflict push and failed merge-head review", async t => {
  for (const hold of ["design", "review", "ci", "legacy"] as const) {
    await t.test(hold, async t => {
      const r = await activeConflictRung(t, hold);
      assert.equal(r.pushedHead, MERGE_HEAD, `${hold}: the conflict round really pushes in this invocation`);
      assert.equal(r.reviews, 1, `${hold}: the merge head gets a failing review`);
      assert.equal(r.outcome.review.headSha, MERGE_HEAD);
      assert.equal(r.outcome.review.state, "failure");
      assert.equal(r.spawned.length, 1, `${hold}: no code worker after the conflict worker`);
      assert.equal(r.outcome.strikes, 1);
      assert.equal(r.outcome.outcome, hold === "design" ? "needs_design" : "stood_down");
      assert.match(String(r.outcome.reason), hold === "design" ? new RegExp(DESIGN_REASON) : /ALREADY OPEN/);
      assert.equal(r.rows.filter(row => row.step === "fix.dispatch").length, 1);
      assert.equal(r.rows.find(row => row.step === "fix.dispatch")!.mode, "merge-conflict");
      assert.equal(r.rows.find(row => row.step === "fix.done")!.pushed_head_sha, MERGE_HEAD);
      assert.equal(r.closed, 0, "the unrelated question is never closed by resolving the conflict");
      if (hold !== "design") assert.equal(r.issues[0]!.url, ISSUE_URL);
      await runSweep([prAt(r.f.now, MERGE_HEAD, false)], { ...r.f.deps, readOpenEscalations: async () => r.issues });
      assert.equal(r.f.effects.evidence.length, 0, `${hold}: a subsequent sweep also admits no code round`);
    });
  }
});

test("W1-T12544 criterion 3: archived design holds survive green and red CI after a conflict push", async t => {
  for (const ci of ["green", "red"] as const) {
    await t.test(ci, async t => {
      const r = await activeConflictRung(t, "design", false, undefined, ci, true);
      assert.equal(readLedgerLines(r.f.deps.ledgerPath).some(row => row.step === "fix.needs_design" && row.task_id === TASK &&
        row.head_sha === HELD_HEAD), false, "control: the question is only in the archive");
      const union = readLedgerUnionRecordsSync(dirname(r.f.deps.ledgerPath), {
        step: ["fix.dispatch", "fix.done", "fix.needs_design"], refuseIncomplete: true });
      assert.equal(union.ok, true, "control: the archive is readable");
      assert.equal(union.rows.some(row => row.step === "fix.needs_design" && row.task_id === TASK &&
        row.head_sha === HELD_HEAD && row.reason === DESIGN_REASON), true,
      "control: recovery sees the archived question");
      assert.equal(r.pushedHead, MERGE_HEAD);
      assert.deepEqual(r.rows.filter(row => row.step === "fix.dispatch").map(row => row.mode), ["merge-conflict"],
        "the unanswered archived question prevents a code fix round");
      assert.equal(r.outcome.review.headSha, ci === "red" ? HELD_HEAD : MERGE_HEAD,
        "red CI leaves the review at the held head");
      assert.equal(r.spawned.length, 1, "no code worker after the conflict worker");
      assert.equal(r.outcome.outcome, "needs_design");
      assert.match(String(r.outcome.reason), new RegExp(DESIGN_REASON));
    });
  }
});

test("W1-T12544 criterion 3: the active B→C rung keeps a question introduced after A→B", async t => {
  const heads = { from: MERGE_HEAD, to: NEXT_MERGE_HEAD, prior: conflictRoundRows(systemClock.now()) };
  for (const hold of ["design", "review"] as const) {
    const r = await activeConflictRung(t, hold, false, heads);
    assert.equal(r.pushedHead, NEXT_MERGE_HEAD);
    assert.equal(r.outcome.review.headSha, NEXT_MERGE_HEAD);
    assert.equal(r.spawned.length, 1, `${hold}: the conflict worker is the only worker`);
    assert.equal(r.outcome.outcome, hold === "design" ? "needs_design" : "stood_down");
    assert.equal(r.rows.filter(row => row.step === "fix.dispatch").length, 1);
    assert.equal(r.closed, 0);
  }
});

test("W1-T12544 criterion 3: the active rung admits code at the merge head without a hold or after the issue is answered", async t => {
  for (const answered of [false, true]) {
    const r = await activeConflictRung(t, answered ? "review" : "none", answered);
    assert.equal(r.spawned.length, 2, "control: the failed review has actionable evidence for a code round");
    assert.deepEqual(r.rows.filter(row => row.step === "fix.dispatch").map(row => row.mode), ["merge-conflict", "reviewer-unmet"]);
    assert.equal(r.outcome.outcome, "fixed");
    assert.equal(r.outcome.review.state, "success");
  }
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
  const owned = (rows: Row[], head = HELD_HEAD) => {
    const g = fixture(t, [...rows, { step: "sweep.merge_probe", pr_number: 18034, head_sha: head, main_sha: OUTSIDE_HEAD,
      verdict: "conflict", conflict_paths: ["src/lib/example.ts"] }]);
    g.deps.readMainTip = () => OUTSIDE_HEAD;
    g.deps.readPlanRepairFacts = async () => ({ authorLogin: "remudero-fleet[bot]" });
    const pr = prAt(g.now, head, true, { prNumber: 18034, prUrl: ownedUrl, taskId: undefined,
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
  const pushed = owned([
    { step: "sweep.conflict_regenerated", pr_number: 18034, head_sha: HELD_HEAD,
      new_head_sha: MERGE_HEAD, outcome: "pushed" },
    ...designRows(now, "PR-18034", ownedUrl, MERGE_HEAD),
  ], MERGE_HEAD);
  assert.equal((await runSweep([pushed.pr], pushed.g.deps)).actions[0]!.disposition, "refused-escalate",
    "a probe-only conflict after A→B keeps the new design hold at B");
  assert.equal(pushed.g.effects.evidence.length, 0);
  assert.equal(pushed.g.disposed().at(-1)!.design_hold_kept, undefined);
  assert.equal(pushed.g.disposed().at(-1)!.hold_head_sha, undefined);
  const conflictCause = openIssue("conflict");
  assert.match(openEscalationStandDownReason(HELD_HEAD, conflictCause, undefined,
    { conflictEvidenceCaptured: true, conflictRound: true })!.reason, /ALREADY OPEN/, "a question about the conflict holds the round");
  const f = fixture(t, [], [conflictCause]);
  await runSweep([prAt(f.now, HELD_HEAD, true)], f.deps);
  assert.equal(f.disposed().at(-1)!.escalation_hold_kept, undefined, "the sweep does not record the conflict question as outranked");
});
