import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger, rotateLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";

const NOW = Date.now();
const INTERVAL = 60_000;
const POLICY = { ...DEFAULT_SWEEP_POLICY, repeatDispositionBound: Infinity, staleAfterDays: Infinity };

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-contradictory-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  const pr: OpenPrView = {
    prNumber: 1866, prUrl: "https://github.com/o/r/pull/1866", taskId: "W1-T4935",
    headSha: "head-a", reviewState: "failure", checksState: "green", unmetCriteria: [],
    priorStrikes: 0, lastActivityAt: new Date(NOW).toISOString(), autoMergeArmed: false,
    reviewSummary: "contradictory decision", reviewInputDigest: "input-a",
  };
  const escalations: OpenPrView[] = [];
  let now = NOW;
  const deps: SweepDeps = {
    ledgerPath, runId: "contradictory", now: () => now,
    arm: () => assert.fail("unexpected arm"), close: () => assert.fail("unexpected close"),
    dispatchFix: () => assert.fail("unexpected fix"),
    escalate: (view) => { escalations.push(view); },
  };
  const review = (digest: string, view = pr) => appendLedger(ledgerPath, {
    run_id: "review", task_id: view.taskId!, step: "review.posted", pr_url: view.prUrl,
    head_sha: view.headSha, review_input_digest: view.reviewInputDigest,
    review_decision_digest: digest, state: "failure", unmet_criteria: [], reasons: [],
  });
  const pass = (at: number, view = pr) => {
    now = at;
    return runSweep([view], deps, POLICY);
  };
  return { pr, deps, escalations, ledgerPath, review, pass };
}

function dispositions(path: string) {
  return readLedgerLines(path).filter((row) => row.step === "sweep.disposed");
}

test("a contradictory review on an unchanged head escalates once across many passes", async (t) => {
  const f = fixture(t);
  f.review("decision-a");
  for (let i = 0; i < 40; i++) {
    const result = await f.pass(NOW + i * 90_000);
    assert.equal(result.actions[0].disposition, "blocked-ambiguous");
    assert.equal(result.actions[0].acted, i === 0);
  }
  assert.equal(f.escalations.length, 1);
  const rows = dispositions(f.ledgerPath);
  assert.ok(rows.length < 10, `${rows.length} disposition rows for 40 passes`);
  assert.equal(rows[0].contradictory_first_escalation_at, NOW);
  assert.equal(rows[0].contradictory_pass_count, 1);
  assert.equal(rows.at(-1)?.contradictory_pass_count, 24);
  assert.equal(rows.at(-1)?.contradictory_first_escalation_at, NOW);
  assert.equal(rows.filter((row) => row.acted === true).length, 1);
  assert.ok(rows.slice(1).every((row) => row.deduped === true));
});

test("a new head sha re-arms the contradictory escalation", async (t) => {
  const f = fixture(t);
  f.review("decision-a");
  await f.pass(NOW);
  await f.pass(NOW + 1);
  const moved = { ...f.pr, headSha: "head-b" };
  f.review("decision-a", moved);
  await f.pass(NOW + 2, moved);
  assert.deepEqual(f.escalations.map((pr) => pr.headSha), ["head-a", "head-b"]);
  f.review("decision-b", moved);
  await f.pass(NOW + 3, moved);
  await f.pass(NOW + 4, moved);
  assert.equal(f.escalations.length, 3, "a review change at the same head must re-arm");
  assert.ok(dispositions(f.ledgerPath).every((row) => row.contradictory_pass_count === 1));
});

test("a legacy escalation seeds contradictory backoff without escalating again", async (t) => {
  const f = fixture(t);
  appendLedger(f.ledgerPath, {
    run_id: "legacy", task_id: f.pr.taskId!, step: "sweep.disposed", pr_url: f.pr.prUrl,
    pr_number: f.pr.prNumber, head_sha: f.pr.headSha, disposition: "blocked-ambiguous", acted: true,
  });
  f.review("decision-a");
  const first = (await f.pass(NOW)).actions[0];
  assert.equal(first.disposition, "blocked-ambiguous");
  assert.equal(first.acted, false);
  assert.match(String(dispositions(f.ledgerPath).at(-1)?.stand_down_reason),
    /escalation was already filed for this head/);
  assert.equal(dispositions(f.ledgerPath).at(-1)?.contradictory_pass_count, 1);
  for (let i = 1; i < 40; i++) {
    assert.equal((await f.pass(NOW + i * 90_000)).actions[0].acted, false);
  }
  assert.equal(f.escalations.length, 0);
  assert.ok(dispositions(f.ledgerPath).length < 10);
  appendLedger(f.ledgerPath, { run_id: "noise", task_id: "noise", step: "noise", text: "x".repeat(10_000) });
  assert.equal(rotateLedger(f.ledgerPath, { ceilingBytes: 5_000, smoothingWindowMs: 0 }).rotated, true);
  assert.equal(dispositions(f.ledgerPath).length, 1, "rotation retains the legacy acted row");
  f.review("decision-b");
  assert.equal((await f.pass(NOW + 40 * 90_000)).actions[0].acted, true);
  assert.equal(f.escalations.length, 1);
  const moved = { ...f.pr, headSha: "head-b" };
  f.review("decision-b", moved);
  assert.equal((await f.pass(NOW + 40 * 90_000 + 1, moved)).actions[0].acted, true);
  assert.equal(f.escalations.length, 2);
});

test("the contradictory escalation backoff survives a restart", async (t) => {
  for (const rotated of [false, true]) {
    const f = fixture(t);
    f.review("decision-a");
    await f.pass(NOW);
    await f.pass(NOW + INTERVAL);
    if (rotated) {
      appendLedger(f.ledgerPath, { run_id: "noise", task_id: "noise", step: "noise", text: "x".repeat(10_000) });
      assert.equal(rotateLedger(f.ledgerPath, { ceilingBytes: 5_000, smoothingWindowMs: 0 }).rotated, true);
      assert.equal(dispositions(f.ledgerPath).length, 1, "rotation carries the acted row, archives the checkpoint");
    }
    const before = dispositions(f.ledgerPath).length;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { runSweep, DEFAULT_SWEEP_POLICY } from './src/lib/sweep.ts';
    import { readLedgerLines } from './src/lib/status.ts';
    let escalations = 0;
    const pr = ${JSON.stringify(f.pr)};
    await runSweep([pr], {
      ledgerPath: ${JSON.stringify(f.ledgerPath)}, runId: 'restarted', now: () => ${NOW + INTERVAL + 1},
      arm() { throw new Error('unexpected arm'); }, close() { throw new Error('unexpected close'); },
      dispatchFix() { throw new Error('unexpected fix'); }, escalate() { escalations++; },
    }, { ...DEFAULT_SWEEP_POLICY, repeatDispositionBound: Infinity, staleAfterDays: Infinity });
    console.log(JSON.stringify({ escalations,
      rows: readLedgerLines(${JSON.stringify(f.ledgerPath)}).filter(r => r.step === 'sweep.disposed').length }));
    `], { cwd: process.cwd(), encoding: "utf8" });
    assert.deepEqual(JSON.parse(output.trim()), { escalations: 0, rows: before });
    await f.pass(NOW + 3 * INTERVAL);
    assert.equal(f.escalations.length, 1);
    assert.equal(dispositions(f.ledgerPath).length, before + 1);
  }
});

test("contradictory backoff doubles its interval and caps it at four hours", async (t) => {
  const f = fixture(t);
  f.review("decision-a");
  await f.pass(NOW);
  let at = NOW;
  let interval = INTERVAL;
  for (let i = 0; i < 12; i++) {
    const before = dispositions(f.ledgerPath).length;
    await f.pass(at + interval - 1);
    assert.equal(dispositions(f.ledgerPath).length, before);
    at += interval;
    await f.pass(at);
    const rows = dispositions(f.ledgerPath);
    assert.equal(rows.length, before + 1);
    interval = Math.min(interval * 2, 4 * 60 * INTERVAL);
    assert.equal(rows.at(-1)?.contradictory_next_row_at, at + interval);
    assert.equal(rows.at(-1)?.stand_down_reason,
      `contradictory review unchanged — pass ${3 + i * 2}; first escalation ` +
      `${new Date(NOW).toISOString()}; next backoff row ${new Date(at + interval).toISOString()}`);
  }
  assert.equal(f.escalations.length, 1);
});

test("a failed escalation retries and a preview never seeds contradictory backoff", async (t) => {
  const f = fixture(t);
  f.review("decision-a");
  await runSweep([f.pr], { ...f.deps, dryRun: true }, POLICY);
  assert.equal(readLedgerLines(f.ledgerPath).filter((row) => row.step === "sweep.disposed").length, 0);
  let attempts = 0;
  f.deps.escalate = () => {
    attempts++;
    if (attempts === 1) throw new Error("issue gateway unavailable");
  };
  assert.equal((await f.pass(NOW)).actionsFailed, 1);
  assert.equal((await f.pass(NOW + 1)).actionsTaken, 1);
  await f.pass(NOW + 2);
  assert.equal(attempts, 2);
});

test("contradictory backoff separates PRs and legacy review decisions", async (t) => {
  const f = fixture(t);
  await f.pass(NOW);
  await f.pass(NOW + 1);
  await f.pass(NOW + 2, { ...f.pr, reviewSummary: "a different contradictory decision" });
  await f.pass(NOW + 3, { ...f.pr, prNumber: 1867, prUrl: "https://github.com/o/r/pull/1867" });
  assert.equal(f.escalations.length, 3);
});
