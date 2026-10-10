import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as sweep from "./helpers/sweep-test.js";
import * as entrypoint from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const PROOF = "test/a-handed-off-head-judgment-is-started-once-and-awaited-by-a-one-shot-sweep.test.ts";
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t5671-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pr: sweep.OpenPrView = {
    prNumber: 56710, prUrl: "https://github.com/craigoley/remudero/pull/56710",
    taskId: "W1-T5671", headSha: "56710aaaa", reviewState: "success", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(), autoMergeArmed: false,
  };
  const lines: Array<Record<string, unknown>> = [
    { step: "verdict", verdict: "handed_off", pr_url: pr.prUrl, reason: "pr_open_yield" },
  ];
  const armed: string[] = [];
  const deps: sweep.SweepDeps = {
    ledgerPath: join(dir, "ledger.ndjson"), runId: "SWEEP-5671",
    arm: (p) => { armed.push(p.headSha); }, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    readLedger: () => [...lines], log: (step, extra) => { lines.push({ step, ...extra }); },
    appendLine: (_path, line) => { lines.push(line); },
  };
  return { pr, lines, armed, deps };
}

for (const action of ["proceed", "escalate"] as const) {
  test(`${PROOF}: ${action} settling after the ledger snapshot is used once`, async (t) => {
    const h = fixture(t);
    const answer = deferred<sweep.HandedOffHeadJudgment>();
    const pool = sweep.handedOffHeadJudgmentPool({ schedule: () => () => {} });
    let calls = 0;
    h.deps.handedOffHeadJudgments = pool;
    h.deps.judgeHandedOffHead = () => { calls++; return answer.promise; };
    await sweep.runSweep([h.pr], h.deps);
    assert.equal(calls, 1);
    assert.equal(pool.flights.size, 1);
    h.deps.readLedger = () => {
      const snapshot = [...h.lines];
      answer.resolve({ action, reason: "judged", issueUrl: "https://example.com/escalation" });
      return snapshot;
    };
    const summary = await sweep.runSweep([h.pr], h.deps);
    assert.equal(calls, 1, "the stale snapshot must not launch another model call");
    assert.equal(pool.flights.size, 0);
    assert.deepEqual(h.armed, action === "proceed" ? [h.pr.headSha] : []);
    if (action === "escalate") {
      assert.equal(summary.actions[0].acted, false);
      assert.match(String(h.lines.findLast((l) => l.step === "sweep.disposed")?.stand_down_reason),
        /escalated.*example.com\/escalation/);
    }
  });
}

test(`${PROOF}: settled heads leave the cache only on a full open-set change`, async (t) => {
  const h = fixture(t);
  const pool = sweep.handedOffHeadJudgmentPool();
  h.deps.handedOffHeadJudgments = pool;
  let calls = 0;
  h.deps.judgeHandedOffHead = async () => { calls++; return { action: "escalate", reason: "risk" }; };
  await sweep.runSweep([h.pr], h.deps);
  assert.equal(pool.settled.size, 1);
  await sweep.runSweep([], { ...h.deps, repairAdmissionSurface: "light" });
  assert.equal(pool.settled.size, 1, "one light pass cannot evict another PR's head");
  await sweep.runSweep([{ ...h.pr, headSha: "new-head" }], h.deps);
  assert.deepEqual([...pool.settled.keys()], [`${h.pr.prNumber}@new-head`]);
  assert.equal(calls, 2);
  await sweep.runSweep([], h.deps);
  assert.equal(pool.settled.size, 0);
});

test(`${PROOF}: unavailable answers are retried rather than retained`, async (t) => {
  const h = fixture(t);
  const pool = sweep.handedOffHeadJudgmentPool();
  h.deps.handedOffHeadJudgments = pool;
  let calls = 0;
  h.deps.judgeHandedOffHead = async () => {
    calls++;
    return calls === 1 ? { action: "unavailable", reason: "offline" } : { action: "proceed", reason: "available" };
  };
  await sweep.runSweep([h.pr], h.deps);
  assert.equal(pool.settled.size, 0);
  assert.deepEqual(h.armed, []);
  await sweep.runSweep([h.pr], h.deps);
  assert.equal(calls, 2);
  assert.deepEqual(h.armed, [h.pr.headSha]);
});

test(`${PROOF}: a late outcome cannot restore a departed head to the cache`, async (t) => {
  const h = fixture(t);
  const answer = deferred<sweep.HandedOffHeadJudgment>();
  const pool = sweep.handedOffHeadJudgmentPool({ schedule: () => () => {} });
  h.deps.handedOffHeadJudgments = pool;
  h.deps.judgeHandedOffHead = () => answer.promise;
  await sweep.runSweep([h.pr], h.deps);
  await sweep.runSweep([], h.deps);
  answer.resolve({ action: "proceed", reason: "head departed while judging" });
  await sweep.awaitHandedOffHeadJudgments(pool);
  assert.equal(pool.flights.size, 0);
  assert.equal(pool.settled.size, 0);
});

test(`${PROOF}: the one-shot composition awaits its decision row`, async (t) => {
  const h = fixture(t);
  const answer = deferred<sweep.HandedOffHeadJudgment>();
  h.deps.judgeHandedOffHead = async () => {
    const judgment = await answer.promise;
    h.lines.push({ step: "risk_judge.decision", pr_number: h.pr.prNumber, head_sha: h.pr.headSha, action: judgment.action });
    return judgment;
  };
  assert.equal(typeof entrypoint.runOneShotSweep, "function");
  let returned = false;
  const pending = entrypoint.runOneShotSweep((pool) =>
    sweep.runSweep([h.pr], { ...h.deps, handedOffHeadJudgments: pool }))
    .then(() => { returned = true; });
  for (let i = 0; i < 20; i++) await turn();
  assert.equal(returned, false);
  assert.equal(h.lines.some((l) => l.step === "risk_judge.decision"), false);
  answer.resolve({ action: "proceed", reason: "judged" });
  await pending;
  assert.equal(returned, true);
  assert.equal(h.lines.filter((l) => l.step === "risk_judge.decision").length, 1);
  await sweep.awaitHandedOffHeadJudgments(sweep.handedOffHeadJudgmentPool());
});

test(`${PROOF}: the one-shot bound keeps a child alive and aborts a hung judgment`, async () => {
  for (const schedule of ["", ", schedule: () => () => {} "]) {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { handedOffHeadJudgmentPool, runSweep, awaitHandedOffHeadJudgments } from './src/lib/sweep.ts';
    const pool = handedOffHeadJudgmentPool({ timeoutMs: 20 ${schedule} });
    let signal;
    const pr = { prNumber: 56710, prUrl: 'https://example.com/56710', headSha: 'head',
      reviewState: 'success', checksState: 'green', unmetCriteria: [], priorStrikes: 0,
      lastActivityAt: new Date().toISOString(), autoMergeArmed: false };
    await runSweep([pr], { ledgerPath: '/dev/null', runId: 'TEST',
      readLedger: () => [{ step: 'verdict', verdict: 'handed_off', pr_url: pr.prUrl }],
      appendLine: () => {}, arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
      handedOffHeadJudgments: pool,
      judgeHandedOffHead: (_pr, s) => { signal = s; return new Promise(() => {}); } });
    await awaitHandedOffHeadJudgments(pool);
    console.log(JSON.stringify({ aborted: signal.aborted, flights: pool.flights.size, settled: pool.settled.size }));
    `], { cwd: process.cwd() });
    assert.deepEqual(JSON.parse(stdout), { aborted: true, flights: 0, settled: 0 });
  }
});

test(`${PROOF}: draining a mixed pool aborts only the judgment still pending`, async (t) => {
  const h = fixture(t);
  const answer = deferred<sweep.HandedOffHeadJudgment>();
  const pool = sweep.handedOffHeadJudgmentPool({ timeoutMs: 20, schedule: () => () => {} });
  h.deps.handedOffHeadJudgments = pool;
  const signals: AbortSignal[] = [];
  h.deps.judgeHandedOffHead = (_pr, signal) => {
    signals.push(signal!);
    return signals.length === 1 ? answer.promise : new Promise(() => {});
  };
  await sweep.runSweep([h.pr, { ...h.pr, prNumber: 56711 }], h.deps);
  const draining = sweep.awaitHandedOffHeadJudgments(pool);
  answer.resolve({ action: "proceed", reason: "finished before the bound" });
  await draining;
  assert.deepEqual(signals.map((signal) => signal.aborted), [false, true]);
  assert.equal(pool.flights.size, 0);
  assert.equal(pool.settled.size, 1);
  assert.equal(h.lines.filter((l) => l.step === "sweep.risk_judge_unavailable").length, 1);
});
