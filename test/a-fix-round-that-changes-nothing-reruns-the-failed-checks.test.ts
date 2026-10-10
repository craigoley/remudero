import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import {
  buildSweepEffects, DEFAULT_SWEEP_POLICY, fixRoundTally, fixRungStalledWithoutNewHead, runSweep,
  type OpenPrView, type SweepDeps,
} from "./helpers/sweep-test.js";

type Row = Record<string, unknown>;
const HEAD = "a".repeat(40);
const NOW = Date.parse("2026-10-08T08:00:00Z");
const TASK = "W1-T6353";

function round(id: string, head = HEAD): Row[] {
  const identity = { task_id: TASK, head_sha: head, round_id: id, strike: 1 };
  return [
    { ...identity, step: "fix.dispatch", mode: "ci-log", verdict_regime: "executed" },
    { ...identity, step: "fix.done", subtype: "success" },
  ];
}

function fixture(rows: Row[] = round("first")) {
  const ledger: Row[] = [{ step: "sweep.disposed", task_id: TASK, pr_number: 10012,
    head_sha: HEAD, disposition: "blocked-fixable", acted: true }, ...rows];
  const writes: string[][] = [];
  const reads: string[][] = [];
  const dispatched: number[] = [];
  const escalated: string[] = [];
  let liveHead = HEAD;
  let runState = "failure";
  let writeError: string | undefined;
  let readError: string | undefined;
  const effects = buildSweepEffects({
    owner: "acme", repo: "remudero", config: { root: "/tmp/w1-t6353" } as Config,
    ledgerPath: "/dev/null/w1-t6353", runId: "test", log: () => {},
    plan: { tasks: [], byId: new Map() } as unknown as Plan,
    issuesImpl: { create: () => "unused" }, registeredWorktreeOwnerImpl: () => undefined,
    readJsonImpl: async (args) => {
      reads.push(args);
      if (readError) throw new Error(readError);
      if (args[1] === "repos/acme/remudero/pulls/10012") {
        return { state: "open", head: { sha: liveHead } };
      }
      assert.match(args[1]!, /actions\/runs\?head_sha=/);
      return { total_count: 4, workflow_runs: [
        { id: 41, head_sha: liveHead, status: "completed", conclusion: runState },
        { id: 42, head_sha: liveHead, status: "completed", conclusion: "success" },
        { id: 43, head_sha: "old-head", status: "completed", conclusion: "failure" },
        { id: 44, head_sha: liveHead, status: "in_progress", conclusion: null },
      ] };
    },
    ghRunImpl: (_file, args) => {
      writes.push([...args]);
      if (writeError) throw new Error(writeError);
    },
  });
  const pr = (): OpenPrView => ({
    prNumber: 10012, prUrl: "https://github.com/acme/remudero/pull/10012", taskId: TASK,
    headSha: liveHead, headRefName: "run-W1-T6353-1", reviewState: "none", checksState: "red",
    unmetCriteria: [], priorStrikes: fixRoundTally(ledger, TASK, liveHead).strikes,
    ciFailures: [{ name: "test-slow-shard (2/2)", logTail: "AssertionError: elapsed bound", conclusion: "FAILURE" }],
    lastActivityAt: new Date(NOW).toISOString(), autoMergeArmed: false,
  });
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, dispatchFix: (view) => { dispatched.push(view.priorStrikes); },
    escalate: (_view, reason) => { escalated.push(reason); },
    rerunFailedChecks: effects.rerunFailedChecks,
    readLiveState: () => ({ ok: true, state: "OPEN", headSha: liveHead }),
    ledgerPath: "/dev/null/w1-t6353", runId: "test", now: () => NOW,
    readLedger: () => ledger, appendLine: (_path, line) => { ledger.push(line); },
  };
  return {
    ledger, writes, reads, dispatched, escalated, effects, pr, deps,
    pass: () => runSweep([pr()], deps, DEFAULT_SWEEP_POLICY),
    moveHead: (head: string) => { liveHead = head; },
    setRunState: (state: string) => { runState = state; },
    failWrite: (reason: string) => { writeError = reason; },
    failRead: (reason: string) => { readError = reason; },
  };
}

test("W1-T6353: a fix round with no commit reruns the failed checks once", async () => {
  const f = fixture();
  await f.pass();
  assert.deepEqual(f.writes, [["api", "-X", "POST", "repos/acme/remudero/actions/runs/41/rerun-failed-jobs"]]);
  assert.deepEqual(f.dispatched, []);
  const receipt = f.ledger.findLast(row => row.no_commit_rerun_outcome === "rerun");
  assert.equal(receipt?.head_sha, HEAD);
  assert.equal(receipt?.no_commit_rerun_round_id, "first");
  assert.deepEqual(receipt?.no_commit_rerun_run_ids, [41]);
  await f.pass();
  assert.equal(f.writes.length, 1, "a later pass cannot rerun this head again");
  assert.equal(f.dispatched.length, 1, "after the one retry a still-red head earns another round");

  f.moveHead("b".repeat(40));
  f.ledger.push(...round("new-head", "b".repeat(40)));
  await f.pass();
  assert.equal(f.writes.length, 2, "a new head earns its own retry");
});

test("W1-T6353: a repeated no-commit round at one head counts a strike", async () => {
  const f = fixture();
  await f.pass();
  f.ledger.push(...round("second").map(row => row.step === "fix.done" ? { ...row, pushed_head_sha: HEAD } : row));
  assert.equal(fixRoundTally(f.ledger, TASK, HEAD).strikes, 1);
  await f.pass();
  assert.deepEqual(f.dispatched, [1]);
  assert.equal(f.writes.length, 1);
  f.ledger.push(...round("third"));
  assert.equal(fixRoundTally(f.ledger, TASK, HEAD).strikes, 2);
  await f.pass();
  assert.equal(f.escalated.length, 1, "the existing strike cap ends the retry loop");
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.writes.length, 1);
});

test("W1-T6353: explicit flake outcomes keep their accounting without a second rerun", async () => {
  for (const claim of ["confirmed", "refuted", "requeue_deferred"] as const) {
    const rows = round(`flake-${claim}`).map(row => row.step === "fix.done" ? { ...row, flake_claim: claim } : row);
    const f = fixture(rows);
    assert.equal(fixRungStalledWithoutNewHead(rows, TASK), claim === "requeue_deferred");
    assert.deepEqual(fixRoundTally(rows, TASK, HEAD).noCommitRounds, []);
    await f.pass();
    assert.deepEqual(f.writes, [], "the explicit flake route already owns the rerun decision");
    const mixed = [...rows, ...round("first-no-commit")];
    assert.deepEqual(fixRoundTally(mixed, TASK, HEAD).noCommitRounds, ["first-no-commit"]);
    assert.equal(fixRoundTally(mixed, TASK, HEAD).strikes, 0, "a flake receipt cannot spend the first no-commit retry");
    assert.equal(fixRoundTally([...mixed, ...round("second-no-commit")], TASK, HEAD).strikes, 1);
  }
});

test("W1-T6353: in-flight, pushed, refused and non-ci rounds do not earn a no-commit rerun", async () => {
  for (const rows of [
    round("in-flight").slice(0, 1),
    round("pushed").map(row => row.step === "fix.done" ? { ...row, pushed_head_sha: "new-head" } : row),
    round("refused").map(row => row.step === "fix.done" ? { ...row, subtype: "commit_refused" } : row),
    round("review").map(row => row.step === "fix.dispatch" ? { ...row, mode: "reviewer-unmet" } : row),
    round("other-head", "old-head"),
  ]) {
    const f = fixture(rows);
    await f.pass();
    assert.deepEqual(f.writes, []);
  }
  const duplicate = round("same");
  assert.equal(fixRoundTally([...duplicate, ...duplicate], TASK, HEAD).strikes, 0);
  assert.equal(fixRoundTally([...round("one"), ...round("two", "other-head")], TASK).strikes, 0);
});

test("W1-T6353: a rerun failure records its reason and cannot retry the same head", async () => {
  for (const phase of ["read", "write"] as const) {
    const f = fixture();
    if (phase === "read") f.failRead("runs unavailable");
    else f.failWrite("403 rerun refused");
    await f.pass();
    const receipt = f.ledger.findLast(row => row.no_commit_rerun_outcome === "failed");
    assert.match(String(receipt?.no_commit_rerun_reason), /runs unavailable|403 rerun refused/);
    assert.equal(receipt?.no_commit_rerun_round_id, "first");
    const attempts = f.reads.length;
    await f.pass();
    assert.equal(f.reads.length, attempts);
    assert.equal(f.dispatched.length, 1);
  }
});

test("W1-T6353: reruns hold on a moved head, missing gateway or dry run", async () => {
  const moved = fixture();
  const snapshot = moved.pr();
  moved.moveHead("b".repeat(40));
  assert.equal((await moved.effects.rerunFailedChecks!(snapshot)).outcome, "head-moved");
  assert.deepEqual(moved.writes, []);
  for (const over of [{ dryRun: true }, { rerunFailedChecks: undefined }]) {
    const f = fixture();
    await runSweep([f.pr()], { ...f.deps, ...over }, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.dispatched, []);
  }
  const green = fixture();
  green.setRunState("success");
  assert.equal((await green.effects.rerunFailedChecks!(green.pr())).outcome, "unavailable");
  assert.deepEqual(green.writes, []);
});

test("W1-T6353: the one-rerun receipt survives ledger rotation after another dispatch", async () => {
  const f = fixture();
  await f.pass();
  await f.pass();
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t6353-rotation-"));
  try {
    const path = join(root, "ledger.ndjson");
    const rows = f.ledger.map(row => ({ run_id: "test", ts: new Date(NOW).toISOString(), ...row }));
    const noise = Array.from({ length: 100 }, () => ({ step: "ci.polling", detail: "x".repeat(100) }));
    writeFileSync(path, [...rows, ...noise].map(row => JSON.stringify(row)).join("\n") + "\n");
    assert.equal(rotateLedger(path, { ceilingBytes: 5000, smoothingWindowMs: 0, now: () => new Date(NOW) }).rotated, true);
    f.ledger.splice(0, f.ledger.length, ...readLedgerLines(path));
    assert.equal(f.ledger.find(row => row.step === "sweep.disposed")?.no_commit_rerun_attempted, true);
    await f.pass();
    assert.equal(f.writes.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T6353: concurrent passes claim one failed-job rerun before awaiting its gateway", async () => {
  const f = fixture();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let attempts = 0;
  const deps: SweepDeps = { ...f.deps,
    readLedger: () => f.ledger.map(row => ({ ...row })),
    rerunFailedChecks: async () => {
      attempts++;
      started();
      await pending;
      return { outcome: "rerun", runIds: [41] };
    },
  };
  const passes = [runSweep([f.pr()], deps, DEFAULT_SWEEP_POLICY), runSweep([f.pr()], deps, DEFAULT_SWEEP_POLICY)];
  await ready;
  finish();
  await Promise.all(passes);
  assert.equal(attempts, 1);
  assert.equal(f.dispatched.length, 0);
  assert.ok(f.ledger.some(row => String(row.stand_down_reason).includes("already claimed by another pass")));
});

test("W1-T6353: the gateway pages failed runs and rejects an unreadable run list", async () => {
  for (const malformed of [false, true]) {
    const writes: string[][] = [];
    const effects = buildSweepEffects({
      owner: "acme", repo: "remudero", config: { root: "/tmp/w1-t6353" } as Config,
      ledgerPath: "/dev/null/w1-t6353", runId: "test", log: () => {},
      plan: { tasks: [], byId: new Map() } as unknown as Plan,
      issuesImpl: { create: () => "unused" }, registeredWorktreeOwnerImpl: () => undefined,
      ghRunImpl: (_file, args) => { writes.push([...args]); },
      readJsonImpl: async args => {
        if (args[1]?.endsWith("/pulls/10012")) return { state: "open", head: { sha: HEAD } };
        if (malformed) return {};
        return args[1]?.endsWith("page=1")
          ? { total_count: 101, workflow_runs: Array.from({ length: 100 }, () => ({
              id: 41, head_sha: HEAD, status: "completed", conclusion: "failure",
            })) }
          : { total_count: 101, workflow_runs: [{ id: 45, head_sha: HEAD, status: "completed", conclusion: "failure" }] };
      },
    });
    if (malformed) {
      await assert.rejects(effects.rerunFailedChecks!(fixture().pr()), /failed workflow runs could not be read/);
      assert.deepEqual(writes, []);
    } else {
      assert.deepEqual((await effects.rerunFailedChecks!(fixture().pr())).runIds, [41, 45]);
      assert.deepEqual(writes.map(args => args[3]), [
        "repos/acme/remudero/actions/runs/41/rerun-failed-jobs",
        "repos/acme/remudero/actions/runs/45/rerun-failed-jobs",
      ]);
    }
  }
});
