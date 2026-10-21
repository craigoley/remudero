// test/a-stood-down-fix-rung-re-derives-its-remedy.test.ts
//
// LIVE 2026-10-09: a fix rung that STANDS DOWN (pre-strike, no commit) wrote `fix.stood_down` and
// nothing else. `fixRungStalledWithoutNewHead` never read that step, so when the task's last
// dispatch had ended cleanly (an earlier head's successful push) the stand-down left `stalled`
// false and every later sweep deduped the head with "fix already dispatched for this head —
// awaiting its outcome". Nothing would ever arrive. The 2026-10-09 ledger window holds 130
// stand-downs; the two largest reasons ("the fix has no surface to stage", "blocked_ci dispatch with
// zero enumerable failing check(s)") are pre-strike and carry no follow-up row of their own.
import assert from "node:assert/strict";
import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { systemClock } from "#src/lib/clock.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import {
  DEFAULT_SWEEP_POLICY, deriveDisposition, drainDetachedSweepActions, fixRungStalledWithoutNewHead,
  runSweep, terminalFixDesignHandoff, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";

const TASK = "W1-T5808";
const OLD_HEAD = "3ddaee544d2f1f0d9a3c6b1e7f1a2b3c4d5e6f70";
const NEW_HEAD = "80aa617193a03c2fdc244b6e4f1e328e650cc4d0";

/** The task's previous round ended cleanly: it pushed a new head. */
function cleanEarlierRound(): Array<Record<string, unknown>> {
  return [
    { task_id: TASK, step: "fix.dispatch", mode: "ci-log", head_sha: OLD_HEAD, strike: 1 },
    { task_id: TASK, step: "fix.done", head_sha: OLD_HEAD, subtype: "success", pushed_head_sha: NEW_HEAD },
  ];
}

test("a rung that stands down without a commit no longer dedups its head", () => {
  assert.equal(fixRungStalledWithoutNewHead(cleanEarlierRound(), TASK), false, "control: a clean push is not stalled");
  const lines = [...cleanEarlierRound(), {
    task_id: TASK, step: "fix.stood_down", site: "rung.empty_ci_failures", strike: 2,
    reason: "blocked_ci dispatch with zero enumerable failing check(s) — the checks-red rollup and the ci-log evidence miner disagree",
  }];
  assert.equal(fixRungStalledWithoutNewHead(lines, TASK), true);
});

test("an empty-commit-surface stand-down ends the rung too", () => {
  const lines = [...cleanEarlierRound(), {
    task_id: TASK, step: "fix.stood_down", site: "rung.empty_commit_surface", strike: 2,
    reason: "the fix has no surface to stage — declare task files or restore the PR diff before dispatch",
  }];
  assert.equal(fixRungStalledWithoutNewHead(lines, TASK), true);
});

test("a hand-off to the sweep is still a live wait, not a stall", () => {
  const lines = [...cleanEarlierRound(), {
    task_id: TASK, step: "fix.stood_down", site: "rung.ci_handoff", strike: 2, outcome: "handed_off", owner: "sweep",
  }];
  assert.equal(fixRungStalledWithoutNewHead(lines, TASK), false);
});

test("a fresh dispatch after the stand-down is the live rung again", () => {
  const lines = [...cleanEarlierRound(),
    { task_id: TASK, step: "fix.stood_down", site: "rung.strike", strike: 2, reason: "recycle_yield" },
    { task_id: TASK, step: "fix.dispatch", mode: "ci-log", head_sha: NEW_HEAD, strike: 2 }];
  assert.equal(fixRungStalledWithoutNewHead(lines, TASK), false);
});

function designFixture(t: TestContext, mode: "conflict" | "ci" = "conflict") {
  const now = systemClock.now(), dir = ownedFixtureDir(t, "terminal-design-route").dir;
  const ledgerPath = join(dir, "ledger.ndjson"), reason = "pending main merge needs a harness correction";
  const pr: OpenPrView = {
    prNumber: 77, prUrl: "https://github.com/o/r/pull/77", taskId: TASK, headSha: NEW_HEAD,
    headRefName: `run-${TASK}-1792554338769`, autoMergeArmed: false, priorStrikes: 0,
    reviewState: "success", checksState: "green", unmetCriteria: [],
    lastActivityAt: new Date(now).toISOString(), createdAt: new Date(now - 60_000).toISOString(),
    mergeState: "dirty", mergeConflict: { files: [{ path: "src/lib/example.ts", oursDeleted: 0, theirsDeleted: 0 }],
      oursLog: "branch changes", theirsLog: "main changes" },
    ...(mode === "ci" ? { mergeState: "clean" as const, mergeConflict: undefined, checksState: "red" as const,
      reviewState: "none" as const, ciFailures: [{ name: "ci-shard (1/8)", logTail: "not ok 1 - fixture behavior" }],
      redRequiredChecks: ["ci-shard (1/8)"] } : {}),
  };
  const common = { task_id: TASK, head_sha: NEW_HEAD, run_id: "DESIGN-ROUND", host: "fixture-host", actor_pid: 777 };
  const round = { ...common, round_id: "DESIGN-ROUND:1", repair_pr_url: pr.prUrl };
  const rows: Array<Record<string, unknown>> = [
    { ...round, step: "fix.dispatch", ts: new Date(now - 3000).toISOString(), mode: "merge-conflict" },
    { ...common, step: "fix.needs_design", ts: new Date(now - 2000).toISOString(), reason },
    { ...round, step: "fix.done", ts: new Date(now - 1000).toISOString(), fix_outcome: "NEEDS_DESIGN", subtype: "success" },
  ];
  const write = (entries = rows) => writeFileSync(ledgerPath, entries.map(row => JSON.stringify(row)).join("\n") + "\n");
  const effects = { admissions: 0, fixes: 0, escalations: [] as string[] };
  const deps: SweepDeps = { ledgerPath, runId: "DESIGN-SWEEP", now: () => now,
    arm: () => assert.fail("a held red cannot arm"), close: () => assert.fail("a held red cannot close"),
    dispatchFix: () => { effects.fixes++; }, escalate: (_pr, why) => { effects.escalations.push(why); },
    claimFixAdmission: () => { effects.admissions++; return { admitted: true }; },
    readActiveWorkerCount: () => 0, readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
  };
  return { pr, rows, write, deps, effects, reason, now };
}

test("the sweep escalates an exact-head design handoff before admitting another fix", async t => {
  for (const mode of ["conflict", "ci"] as const) {
    const f = designFixture(t, mode); f.write();
    assert.equal(deriveDisposition(f.pr, DEFAULT_SWEEP_POLICY, f.now).disposition,
      mode === "conflict" ? "conflicted" : "blocked-fixable", "control: this head ordinarily enters the fix lane");
    for (let pass = 0; pass < 2; pass++) {
      const summary = await runSweep([f.pr], f.deps);
      assert.equal(summary.actions[0]!.disposition, "refused-escalate");
      assert.match(summary.actions[0]!.reason, /pending main merge needs a harness correction/);
    }
    assert.equal(f.effects.admissions, 0); assert.equal(f.effects.fixes, 0);
    assert.equal(f.effects.escalations.length, 1, "the native head-bound escalation dedup remains in charge");
    assert.ok(f.effects.escalations[0]!.includes(f.reason));
  }
});

test("a design handoff does not hold another task or a newer head", async t => {
  for (const otherTask of [false, true]) {
    const f = designFixture(t);
    if (otherTask) for (const row of f.rows) row.task_id = "unrelated-task";
    else f.pr.headSha = OLD_HEAD;
    f.write();
    assert.deepEqual(terminalFixDesignHandoff(f.pr, f.rows), { kind: "none" });
    await runSweep([f.pr], f.deps);
    assert.equal(f.effects.admissions, 1); assert.equal(f.effects.fixes, 1);
    assert.equal(f.effects.escalations.length, 0);
  }
});

test("an unbound or malformed design handoff stays unknown without a repair admission", async t => {
  const changes: Array<(f: ReturnType<typeof designFixture>) => void> = [
    f => { f.rows[1]!.reason = ""; }, f => { f.rows[1]!.ts = "unknown"; },
    f => { delete f.rows[1]!.host; }, f => { f.rows[1]!.actor_pid = 0; },
    f => { f.rows[1]!.run_id = ""; }, f => { f.rows[1]!.pr_number = 78; },
    f => { f.rows[1]!.repair_pr_url = "https://github.com/o/r/pull/78"; },
    f => { f.rows[0]!.round_id = "another-round"; }, f => { f.rows[2]!.fix_outcome = "FIXED"; },
    f => { f.rows[2]!.repair_pr_url = "https://github.com/o/r/pull/78"; },
    f => { f.rows.push({ ...f.rows[0], round_id: "ambiguous-round" }, { ...f.rows[2], round_id: "ambiguous-round" }); },
  ];
  for (const change of changes) {
    const f = designFixture(t); change(f); f.write();
    assert.equal(terminalFixDesignHandoff(f.pr, f.rows).kind, "unavailable");
    const result = await runSweep([f.pr], f.deps);
    assert.equal(result.actions[0]!.disposition, "wait");
    assert.match(result.actions[0]!.reason, /context unavailable/);
    assert.deepEqual(f.effects, { admissions: 0, fixes: 0, escalations: [] });
  }
  const badHead = designFixture(t); badHead.pr.headSha = "not-a-commit";
  for (const row of badHead.rows) row.head_sha = badHead.pr.headSha;
  assert.equal(terminalFixDesignHandoff(badHead.pr, badHead.rows).kind, "unavailable");
});

test("a live fix claim keeps its ordinary wait ahead of a cached design handoff", async t => {
  const f = designFixture(t); f.write([]);
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  f.deps.detachFixWait = true;
  f.deps.dispatchFix = () => { f.effects.fixes++; return pending; };
  try {
    await runSweep([f.pr], f.deps);
    assert.equal(f.effects.admissions, 1); assert.equal(f.effects.fixes, 1);
    appendFileSync(f.deps.ledgerPath, f.rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    await runSweep([f.pr], f.deps);
    assert.equal(f.effects.admissions, 1); assert.equal(f.effects.fixes, 1);
    assert.equal(f.effects.escalations.length, 0, "a still-owned worker is never displaced by the projection");
  } finally { release(); await drainDetachedSweepActions(); }
});

test("a later unfinished round stays live and a completed round cannot silently release the design hold", t => {
  const f = designFixture(t), start = { ...f.rows[0], ts: new Date(f.now).toISOString(), round_id: "later-round" };
  f.rows.push(start);
  assert.deepEqual(terminalFixDesignHandoff(f.pr, f.rows), { kind: "none" });
  f.rows.push({ ...f.rows[2], ts: new Date(f.now + 1).toISOString(), round_id: "later-round", fix_outcome: "FIXED" });
  assert.equal(terminalFixDesignHandoff(f.pr, f.rows).kind, "handoff", "the rung's protective first handoff still needs a person at this head");
});

for (const mode of ["conflict", "ci"] as const) {
  test(`operator-amended terminal design handoff adopts main before admission (${mode})`, async t => {
    const f = designFixture(t, mode); f.rows[1]!.contract_revision = "contract-A"; f.write();
    let revision = "contract-A", refreshed = 0;
    f.deps.readTaskContractRevision = () => revision;
    f.deps.updateBranch = async () => { refreshed++; return "updated"; };
    await runSweep([f.pr], f.deps);
    assert.equal(f.effects.escalations.length, 1); assert.equal(refreshed, 0);
    revision = "contract-B";
    await runSweep([f.pr], f.deps);
    assert.equal(refreshed, 1, "a protected-main operator amendment must reach the existing ordinary base-adoption path");
    assert.equal(f.effects.admissions, 0, "base adoption cannot consume a new code-fix admission");
    assert.equal(f.effects.fixes, 0); assert.equal(f.effects.escalations.length, 1);
    await runSweep([f.pr], f.deps);
    assert.equal(refreshed, 1, "an unchanged head and amendment is taken only once");
  });
}

test("a design amendment defers without branch-update capability and remains pending for the full pass", async t => {
  const f = designFixture(t, "ci"); f.rows[1]!.contract_revision = "contract-A"; f.write();
  let refreshed = 0;
  f.deps.readTaskContractRevision = () => "contract-B";
  const light = await runSweep([f.pr], f.deps);
  assert.match(light.actions[0]!.reason, /deferred to full sweep/);
  f.deps.updateBranch = async () => { refreshed++; return "updated"; };
  await runSweep([f.pr], f.deps);
  assert.equal(refreshed, 1); assert.equal(f.effects.admissions, 0); assert.equal(f.effects.fixes, 0);
});

test("an unreadable design contract stays unavailable before an admission or write", async t => {
  const f = designFixture(t, "ci"); f.rows[1]!.contract_revision = "contract-A"; f.write();
  f.deps.readTaskContractRevision = () => { throw new Error("plan source unavailable"); };
  f.deps.updateBranch = async () => assert.fail("unknown contract cannot authorize a refresh");
  const result = await runSweep([f.pr], f.deps);
  assert.equal(result.actions[0]!.disposition, "wait");
  assert.match(result.actions[0]!.reason, /contract revision unavailable/);
  assert.deepEqual(f.effects, { admissions: 0, fixes: 0, escalations: [] });
});

test("a design amendment that changes during observation never admits the old head", async t => {
  const f = designFixture(t, "ci"); f.rows[1]!.contract_revision = "contract-A"; f.write();
  let read = 0, refreshed = 0;
  f.deps.readTaskContractRevision = () => ++read === 1 ? "contract-B" : "contract-A";
  f.deps.updateBranch = async () => { refreshed++; return "updated"; };
  const result = await runSweep([f.pr], f.deps);
  assert.equal(refreshed, 0); assert.equal(f.effects.admissions, 0); assert.equal(f.effects.fixes, 0);
  assert.match(result.actions[0]!.reason, /changed during/);
});
