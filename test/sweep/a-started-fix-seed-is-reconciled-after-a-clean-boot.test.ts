import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixSeedRead, runSweep, type OpenPrView } from "#test/helpers/sweep-test.js";
import { readLedgerLines } from "#src/lib/status.js";

const HEAD = "6ed36e359c78e9bce1864fc05c5321457e5844a3";
const OLD = "DAEMON-1792393697581";
const CURRENT = "DAEMON-1792398312339";
const TASK = "W1-T9739";
const pr = { prNumber: 12904, taskId: TASK, headSha: HEAD };
const seed = { step: "sweep.disposed", pr_number: pr.prNumber, task_id: TASK, head_sha: HEAD,
  disposition: "blocked-fixable", acted: true, run_id: OLD, ts: "2026-10-19T07:16:56.752Z" };
const dispatch = { step: "fix.dispatch", task_id: TASK, head_sha: HEAD, run_id: OLD,
  mode: "ci-log", ts: "2026-10-19T07:30:16.677Z" };
const adoption = { step: "run_child.adoption_pass", task_id: "DAEMON", run_id: CURRENT,
  live: 0, adopted: 0, unreadable: 0, misidentified: 0, ts: "2026-10-19T08:26:04.295Z" };
const boot = { step: "daemon.boot", task_id: "DAEMON", run_id: CURRENT, ts: "2026-10-19T08:26:04.493Z" };
const timeline = () => [seed, dispatch, adoption, boot];

test("a started fix seed is orphaned after a new boot records an empty adoption pass", () => {
  const read = fixSeedRead(timeline(), pr, CURRENT);
  assert.equal(read?.kind, "orphaned");
  assert.equal(read?.orphanReason, "owner-run-ended");
  assert.deepEqual(read?.seed, { ts: seed.ts, runId: OLD });
  assert.equal(fixSeedRead([...timeline(), { step: "fix.progress_judged", task_id: TASK,
    run_id: CURRENT }], pr, CURRENT)?.kind, "orphaned", "judgment alone is not a new worker dispatch");
});

test("a started fix seed stays held without a complete current boot adoption receipt", () => {
  const variants = [
    [seed, dispatch],
    [seed, dispatch, boot],
    [seed, dispatch, adoption],
    [seed, dispatch, { ...adoption, run_id: OLD }, boot],
    [seed, dispatch, adoption, { ...boot, run_id: OLD }],
    [adoption, seed, dispatch, boot],
    [seed, dispatch, boot, adoption],
    [seed, { ...dispatch, run_id: undefined }, adoption, boot],
  ];
  for (const rows of variants) assert.equal(fixSeedRead(rows, pr, CURRENT)?.kind, "live", JSON.stringify(rows));
});

test("a started fix seed never releases a live or indeterminate adopted child", () => {
  for (const field of ["live", "adopted", "unreadable", "misidentified"] as const) {
    assert.equal(fixSeedRead([seed, dispatch, { ...adoption, [field]: 1 }, boot], pr, CURRENT)?.kind, "live", field);
    assert.equal(fixSeedRead([seed, dispatch, { ...adoption, [field]: undefined }, boot], pr, CURRENT)?.kind, "live", `${field} unreadable`);
  }
  for (const step of ["run_child.adopted", "run_child.adoption_unreadable", "run_child.adoption_misidentified"]) {
    assert.equal(fixSeedRead([...timeline(), { step, task_id: TASK, run_id: "surviving-child" }], pr, CURRENT)?.kind, "live", step);
  }
});

test("a started fix seed keeps current-run ownership and a newer rung intact", () => {
  assert.equal(fixSeedRead(timeline(), pr, OLD)?.kind, "live");
  assert.equal(fixSeedRead([...timeline(), { ...dispatch, run_id: CURRENT }], pr, CURRENT)?.kind, "live");
  assert.equal(fixSeedRead([...timeline(), { ...boot, run_id: "a-later-daemon" }], pr, CURRENT)?.kind, "live");
});

test("a started fix seed still recognizes an explicit terminal outcome before boot recovery", () => {
  assert.equal(fixSeedRead([...timeline(), { step: "fix.done", task_id: TASK, run_id: OLD,
    head_sha: HEAD, worker_exit: "unobserved" }], pr, CURRENT)?.kind, "ended");
});

test("a started fix seed preserves a sweep hand-off until it is received", () => {
  const rows = [seed, dispatch, { step: "fix.stood_down", task_id: TASK, run_id: OLD,
    sha: HEAD, outcome: "handed_off" }, adoption, boot];
  assert.equal(fixSeedRead(rows, pr, CURRENT)?.kind, "live");
  assert.equal(fixSeedRead([...rows, { ...seed, run_id: CURRENT, acted: false }], pr, CURRENT)?.kind, "ended");
});

test("a started fix seed re-enters the normal checkout claim without waiving a live owner", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-started-fix-seed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  const view: OpenPrView = { ...pr, prUrl: "https://github.com/example/fixture/pull/12904",
    headRefName: "run-W1-T9739-1792389480000", reviewState: "failure", checksState: "green",
    unmetCriteria: [{ claim: "a criterion", proof: "unit test: fixture", met: false,
      reason: "not done", proof_exec: "not_executable" }], priorStrikes: 0,
    lastActivityAt: seed.ts, autoMergeArmed: false };
  let claims = 0;
  const pass = async (held: boolean) => {
    await runSweep([view], { runId: CURRENT, ledgerPath, now: () => Date.parse(boot.ts),
      arm: () => assert.fail("red input cannot arm"), close: () => assert.fail("not stale"), escalate: () => {},
      readLedger: () => [...timeline(), ...readLedgerLines(ledgerPath)],
      dispatchFix: () => { claims++; return held ? { claimDeclined: true, ownerRecoveryReason: "live_claim" } : undefined; },
    });
    return readLedgerLines(ledgerPath);
  };
  const held = await pass(true);
  assert.equal(claims, 1, "the existing checkout-owner guard, not the dead seed, decides");
  assert.equal(held.findLast(row => row.step === "sweep.disposed")?.acted, false);
  assert.equal(held.findLast(row => row.step === "sweep.fix.seed_orphaned")?.reason, "owner-run-ended");
  const admitted = await pass(false);
  assert.equal(claims, 2, "a later pass can recheck the owner rather than awaiting a dead continuation");
  assert.equal(admitted.findLast(row => row.step === "sweep.disposed")?.acted, true);
});
