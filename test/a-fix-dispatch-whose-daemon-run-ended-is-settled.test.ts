// test/a-fix-dispatch-whose-daemon-run-ended-is-settled.test.ts — W1-T9999.
//
// LIVE 2026-10-17: #12390 (W1-T9722, head b15c181) was disposed `conflicted` acted:true at 03:14:38Z by
// one daemon run, whose detached dispatch died with its process at ~03:18Z having written no fix row.
// Every pass after the 03:19Z boot read the PREVIOUS round's 02:26:51Z `fix.stood_down` handed_off as a
// live wait: "fix already dispatched for this head (b15c181) — awaiting its outcome" until a hand push.
// The dedup now reads only the seed's own rung, settles an ended run's seed with no rung row, and ends
// a hand-off once the sweep has disposed the same head after it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIX_SEED_ORPHANED_STEP, fixSeedRead, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const NOW = Date.parse("2026-10-17T03:30:00Z");
const PR = 12390;
const TASK = "W1-T9722";
const HEAD = "b15c1819e0aa";
const EARLIER_HEAD = "9a0e33c1d2bb";
const RUN_A = "DAEMON-1792196664607";
const RUN_B = "DAEMON-1792204349717";
const RUN_C = "DAEMON-1792207115995";
const SEED_TS = "2026-10-17T03:14:38.000Z";
const HELD = /fix already dispatched for this head/;
const UNMET = [{ claim: "a criterion", proof: "unit test: x", met: false, reason: "not done", proof_exec: "not_executable" as const }];

function view(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR, prUrl: `https://github.com/craigoley/remudero/pull/${PR}`, taskId: TASK,
    reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: "2026-10-17T03:00:00Z", headSha: HEAD, headRefName: "run-W1-T9722-1792150906434",
    autoMergeArmed: false, ...over,
  };
}

const conflictedView = () => view({
  mergeState: "dirty",
  mergeConflict: { files: [{ path: "src/a.ts", oursDeleted: 1, theirsDeleted: 1 }], oursLog: "b15c181 ours", theirsLog: "733bb46 theirs" },
});
const blockedFixableView = () => view({ reviewState: "failure", unmetCriteria: UNMET });

function disposed(runId: string, disposition: string, ts: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { run_id: runId, ts, step: "sweep.disposed", acted: true, pr_number: PR, head_sha: HEAD, disposition, ...extra };
}

/** A round that pushed `pushed`, then handed its CI wait to the sweep at the recycle (rung.ci_handoff). */
function handedOffRound(runId: string, dispatchHead: string, pushed = HEAD): Array<Record<string, unknown>> {
  return [
    { run_id: runId, task_id: TASK, step: "fix.dispatch", head_sha: dispatchHead, strike: 1 },
    { run_id: runId, task_id: TASK, step: "fix.done", head_sha: dispatchHead, subtype: "success", pushed_head_sha: pushed },
    { run_id: runId, task_id: TASK, step: "fix.ci_not_green", strike: 1, ci: "freshness_handoff", sha: pushed },
    { run_id: runId, task_id: TASK, step: "fix.stood_down", site: "rung.ci_handoff", strike: 1, outcome: "handed_off",
      owner: "sweep", trigger: "recycle", reason: "recycle_yield", sha: pushed },
  ];
}

/** #12390 in miniature: run A hands off at HEAD, run B receives it, then seeds a fix at HEAD and dies. */
function timeline(seedDisposition: "conflicted" | "blocked-fixable"): Array<Record<string, unknown>> {
  return [
    ...handedOffRound(RUN_A, EARLIER_HEAD),
    disposed(RUN_B, "post-review", "2026-10-17T02:36:28.000Z"),
    disposed(RUN_B, "mergeable", "2026-10-17T03:12:05.000Z"),
    disposed(RUN_B, seedDisposition, SEED_TS),
  ];
}

async function pass(pr: OpenPrView, seed: Array<Record<string, unknown>>, runId: string, ledgerPath?: string) {
  const path = ledgerPath ?? join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9999-`)), "ledger.ndjson");
  let dispatched = 0;
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, escalate: () => {},
    dispatchFix: () => { dispatched++; },
    runId, now: () => NOW, ledgerPath: path,
    readLedger: () => [...seed, ...readLedgerLines(path)],
  };
  await runSweep([pr], deps);
  const own = readLedgerLines(path);
  const rows = own.filter((l) => l.step === "sweep.disposed");
  return { row: rows[rows.length - 1], dispatched, orphaned: own.filter((l) => l.step === FIX_SEED_ORPHANED_STEP), ledgerPath: path };
}

test("W1-T9999: an earlier rung hand-off does not hold a later dispatch head", async () => {
  // Run A handed off at an EARLIER head, so the sweep can never receive it at HEAD; only the window frees HEAD.
  const seed = [...handedOffRound(RUN_A, "5e7a0d9c4f11", EARLIER_HEAD), ...timeline("blocked-fixable").slice(4)];
  const next = await pass(blockedFixableView(), seed, RUN_C);
  assert.equal(next.row.disposition, "blocked-fixable");
  assert.doesNotMatch(String(next.row.stand_down_reason), HELD, "run A's hand-off never speaks for run B's later seed");
  assert.equal(next.row.acted, true);
  assert.equal(next.dispatched, 1);
});

test("W1-T9999: a seed from an ended daemon run is settled and re-dispatched", async () => {
  const next = await pass(conflictedView(), timeline("conflicted"), RUN_C);
  assert.equal(next.row.disposition, "conflicted");
  assert.equal(next.dispatched, 1, "the orphaned seed no longer parks the head");
  assert.equal(next.orphaned.length, 1, "the settle is ledgered by name");
  const [row] = next.orphaned;
  assert.equal(row.pr_number, PR);
  assert.equal(row.head_sha, HEAD);
  assert.equal(row.seed_ts, SEED_TS);
  assert.equal(row.seed_run_id, RUN_B);
  assert.equal(row.run_id, RUN_C);
});

test("W1-T9999: a seed from this daemon run with no rung row stays deduped", async () => {
  // The same seed read by the run that wrote it: its detached dispatch may still be waiting in admission.
  const same = await pass(conflictedView(), timeline("conflicted"), RUN_B);
  assert.equal(same.dispatched, 0, "settling a live seed would double-dispatch (W1-T2520)");
  assert.equal(same.orphaned.length, 0);
  assert.equal(same.row.stand_down_reason,
    `fix already dispatched for this head (b15c181) at ${SEED_TS} by ${RUN_B} — awaiting its outcome before spending another strike`,
    "the held seed is named, so a reader can tell a live wait from an orphan");
});

test("W1-T9999: a received hand-off at the same head no longer reads live", async () => {
  // Run B's OWN rung handed off at HEAD after its seed. The first pass at HEAD is the hand-off's first
  // sighting and still waits; its own disposed row at HEAD is the receipt, so the next pass dispatches.
  const seed = [disposed(RUN_B, "conflicted", SEED_TS), ...handedOffRound(RUN_B, HEAD)];
  const first = await pass(conflictedView(), seed, RUN_C);
  assert.equal(first.dispatched, 0, "an unreceived hand-off is still a live wait");
  assert.match(String(first.row.stand_down_reason), HELD);
  const second = await pass(conflictedView(), seed, RUN_C, first.ledgerPath);
  assert.equal(second.dispatched, 1, "the sweep received the hand-off at this head, so the rung reads ended");
  assert.doesNotMatch(String(second.row.stand_down_reason), HELD);
  assert.equal(second.orphaned.length, 0, "a received hand-off is ended, not orphaned");
});

test("W1-T9999: a synchronous dispatch's rung written before its seed still speaks for it", () => {
  const pr = { prNumber: PR, headSha: HEAD, taskId: TASK };
  const lines = [
    ...handedOffRound(RUN_A, EARLIER_HEAD),
    disposed(RUN_B, "mergeable", "2026-10-17T03:12:05.000Z"),
    { run_id: RUN_B, task_id: TASK, step: "fix.dispatch", head_sha: HEAD, strike: 2 },
    disposed(RUN_B, "conflicted", SEED_TS),
  ];
  assert.equal(fixSeedRead(lines, pr, RUN_C)?.kind, "live", "the in-pass rung is the seed's own, still in flight");
  assert.equal(fixSeedRead([...lines, { run_id: RUN_B, task_id: TASK, step: "fix.ci_not_green", sha: HEAD }], pr, RUN_C)?.kind, "ended");
  assert.equal(fixSeedRead(lines.slice(0, -2).concat(lines.slice(-1)), pr, RUN_C)?.kind, "orphaned",
    "control: without the in-pass row the same seed is an orphan");
});
