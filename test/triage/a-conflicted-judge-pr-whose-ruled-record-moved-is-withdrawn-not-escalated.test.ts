import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MACHINE_JUDGE_STATE_FILE, staleRulingPins, withdrawStaleConflictedJudgePr } from "#src/lib/machine-filing-judge.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";
import { taskRulingPin } from "#src/lib/task-linter.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

const HEAD = "a".repeat(40);
const SHARD = "plan/tasks.d/W1-T1-a.yaml";
const RULED = "- id: W1-T1\n  title: a\n  repo: remudero\n  depends_on: []\n  priority: 1\n  type: implement\n  verify: human\n  status: queued\n  attempts: 0\n  acceptance:\n    - claim: c\n      proof: \"unit test: x\"\n";
const MOVED = RULED.replace("unit test: x", "unit test: y");
const pinOf = (text: string): string => taskRulingPin(parseTasksFromYaml(text, SHARD)[0]!);
const URL_ = "https://github.com/acme/remudero/pull/16824";

const conflicted = (headRefName: string): OpenPrView => ({
  prNumber: 16824, prUrl: URL_, headSha: HEAD, headRefName, isPlanFiling: true, planFilingSource: "github-files",
  checksState: "none", reviewState: "none", mergeState: "dirty", unmetCriteria: [], priorStrikes: 0,
  lastActivityAt: new Date().toISOString(), autoMergeArmed: false, body: "## Acceptance\n- x | grep: y in z",
  mergeConflict: { files: [{ path: SHARD, oursDeleted: 0, theirsDeleted: 1 }], oursLog: "", theirsLog: "" },
});

/** A judge state with #16824 pending on W1-T1's ruling, and the sweep deps wired to the REAL withdraw. */
function fixture(mainText: string) {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-judge-withdraw-"));
  const pin = pinOf(RULED);
  const state = {
    pending: { prUrl: URL_, ids: ["W1-T1"], records: [{ id: "W1-T1", relPath: SHARD, pin, sourcePin: pin }] },
    rulings: { "W1-T1": { pin, ruling: { action: "proceed" }, bar: 1 }, "W1-T9": { pin: "keep", ruling: {}, bar: 1 } },
  };
  writeFileSync(join(stateDir, MACHINE_JUDGE_STATE_FILE), JSON.stringify(state));
  const closed: { url: string; comment: string }[] = [];
  const ledger: Record<string, unknown>[] = [];
  const escalations: string[] = [];
  let rounds = 0;
  const deps = {
    runId: "judge-withdraw-test", ledgerPath: "/dev/null/ledger", readLedger: () => ledger,
    appendLine: (_: string, line: Record<string, unknown>) => ledger.push(line),
    arm() {}, close() {}, postReview: async () => {},
    dispatchFix() { assert.fail("a plan filing must never enter the code rung"); },
    escalate(_pr: OpenPrView, reason: string) { escalations.push(reason); },
    readPlanRepairFacts: () => ({ authorLogin: "remudero-fleet[bot]" }),
    repairPlanPr() { assert.fail("the mechanical cures read check logs, never a merge state"); },
    dispatchPlanGateRound: async () => { rounds++; return { outcome: "refused", reason: "lint-plan-precheck [machine-author-verify]" }; },
    withdrawStaleJudgePr: (pr: OpenPrView) => withdrawStaleConflictedJudgePr({
      stateDir, prUrl: pr.prUrl, log: (step, fields) => ledger.push({ step, ...fields }),
      readMain: async (paths) => new Map(paths.map((p) => [p, mainText] as const)),
      closePr: async (url, comment) => { closed.push({ url, comment }); },
    }),
  } as unknown as SweepDeps;
  const stateNow = () => JSON.parse(readFileSync(join(stateDir, MACHINE_JUDGE_STATE_FILE), "utf8"));
  return { deps, ledger, closed, escalations, rounds: () => rounds, stateNow, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

const policy = { ...DEFAULT_SWEEP_POLICY, mergeConflictAdmissionEnabled: true };

test("a conflicted machine-judge PR whose ruled record moved on main is withdrawn, not given a round or escalated", async () => {
  const f = fixture(MOVED);
  try {
    await runSweep([conflicted("machine-judge-garden-1793833454070")], f.deps, policy);
    assert.equal(f.rounds(), 0, "no plan-scoped conflict round is dispatched");
    assert.deepEqual(f.escalations, [], "nothing escalates");
    assert.equal(f.ledger.some((l) => l.step === "sweep.plan_round.dispatched" || l.step === "sweep.plan_round.refused"), false);
    assert.equal(f.closed.length, 1);
    assert.equal(f.closed[0]!.url, URL_);
    assert.match(f.closed[0]!.comment, /Withdrawing stale machine-filing rulings after origin\/main changed/);
    assert.match(f.closed[0]!.comment, new RegExp(`W1-T1: ruling pin ${pinOf(RULED)}; main pin ${pinOf(MOVED)}`));
    const row = f.ledger.find((l) => l.step === "machine_judge.withdrawn")!;
    assert.equal(row.reason, "conflict-stale-pin");
    assert.equal(row.pr_url, URL_);
    const state = f.stateNow();
    assert.equal(state.pending, undefined, "the pending entry is cleared");
    assert.deepEqual(Object.keys(state.rulings), ["W1-T9"], "only the withdrawn ids' rulings are cleared");
    const disposed = f.ledger.findLast((l) => l.step === "sweep.disposed")!;
    assert.notEqual(disposed.disposition, "blocked-ambiguous");
    assert.match(String(disposed.reason), /withdrawn for a re-judge/);
  } finally { f.cleanup(); }
});

test("W1-T11388 criterion 2: a conflicted machine-judge PR whose rulings all match main keeps its plan-scoped round", async () => {
  const f = fixture(RULED);
  try {
    await runSweep([conflicted("machine-judge-garden-1793833454070")], f.deps, policy);
    assert.equal(f.rounds(), 1, "the round dispatches as today");
    assert.deepEqual(f.closed, []);
    assert.equal(f.ledger.some((l) => l.step === "machine_judge.withdrawn"), false);
    assert.notEqual(f.stateNow().pending, undefined, "the judge's pending entry stands");
  } finally { f.cleanup(); }
});

test("a conflicted non-judge plan PR is never withdrawn, whatever the judge state says", async () => {
  const f = fixture(MOVED);
  try {
    await runSweep([conflicted("backlog-garden-1793833454070")], f.deps, policy);
    assert.equal(f.rounds(), 1);
    assert.deepEqual(f.closed, []);
    assert.notEqual(f.stateNow().pending, undefined);
  } finally { f.cleanup(); }
});

test("a record removed on main is stale, and a PR the judge does not name as pending is never withdrawn", async () => {
  const pin = pinOf(RULED);
  const record = { id: "W1-T1", relPath: SHARD, pin, sourcePin: pin };
  assert.deepEqual(staleRulingPins([record], new Map()), [{ id: "W1-T1", pin, main_pin: null }]);
  assert.deepEqual(staleRulingPins([record], new Map([[SHARD, RULED]])), []);
  assert.deepEqual(staleRulingPins([record], new Map([[SHARD, MOVED]])), [{ id: "W1-T1", pin, main_pin: pinOf(MOVED) }]);
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-judge-withdraw-none-"));
  try {
    writeFileSync(join(stateDir, MACHINE_JUDGE_STATE_FILE), JSON.stringify({ pending: { prUrl: "https://github.com/acme/remudero/pull/1", ids: ["W1-T1"], records: [record] } }));
    const other = await withdrawStaleConflictedJudgePr({ stateDir, prUrl: URL_, log() {},
      readMain: async () => new Map(), closePr: async () => assert.fail("another PR's pending entry is not this one's to close") });
    assert.deepEqual(other, { withdrawn: false });
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
