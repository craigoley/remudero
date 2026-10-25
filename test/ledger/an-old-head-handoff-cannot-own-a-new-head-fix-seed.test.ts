import assert from "node:assert/strict";
import { test } from "node:test";
import { fixSeedRead } from "#src/lib/sweep.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rotateLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { runSweep, type OpenPrView } from "#test/helpers/sweep-test.js";

const OWNER = "DAEMON-1000";
const CURRENT = "DAEMON-2000";
const PRIOR = "DAEMON-500";
const pr = { prNumber: 50, taskId: "W1-T9000", headSha: "new-head" };
type Row = Record<string, unknown>;

// Rotation can retain an old rung while dropping the intervening non-acted dispositions.
function history(): Row[] {
  return [
    { step: "fix.dispatch", task_id: pr.taskId, run_id: PRIOR, head_sha: "old-head" },
    { step: "fix.stood_down", task_id: pr.taskId, run_id: PRIOR, outcome: "handed_off", sha: pr.headSha },
    { step: "fix.progress_judged", task_id: pr.taskId, run_id: OWNER, head_sha: pr.headSha },
    { step: "sweep.disposed", pr_number: pr.prNumber, task_id: pr.taskId, run_id: OWNER, acted: true,
      disposition: "blocked-fixable", head_sha: pr.headSha },
    { step: "run_child.adoption_pass", run_id: CURRENT, live: 0, adopted: 0, unreadable: 0, misidentified: 0 },
    { step: "daemon.boot", run_id: CURRENT },
    { step: "fix.progress_judged", task_id: pr.taskId, run_id: CURRENT, head_sha: pr.headSha },
  ];
}

test("an old-head handoff cannot own a new-head fix seed after an empty boot", () => {
  assert.deepEqual(fixSeedRead(history(), pr, CURRENT), {
    kind: "orphaned", seed: { runId: OWNER }, orphanReason: "owner-run-ended",
  });
});

test("head-specific orphan recovery preserves foreign and unread dispatch owners", () => {
  for (const head of [pr.headSha, undefined, null]) {
    const rows = history();
    rows[0]!.head_sha = head;
    assert.equal(fixSeedRead(rows, pr, CURRENT)?.kind, "live", String(head));
  }
});

test("a seed owner's own or unattributed handoff remains a live continuation", () => {
  for (const owner of [OWNER, `${OWNER}-round-1`, undefined]) {
    const rows = history();
    rows[1]!.run_id = owner;
    assert.equal(fixSeedRead(rows, pr, CURRENT)?.kind, "live", String(owner));
  }
});

test("an old-head handoff is not discarded without this boot's complete empty adoption", () => {
  for (const key of ["live", "adopted", "unreadable", "misidentified"]) {
    const rows = history();
    rows[4]![key] = 1;
    assert.equal(fixSeedRead(rows, pr, CURRENT)?.kind, "live", key);
  }
  const missing = history().filter(row => row.step !== "run_child.adoption_pass");
  assert.equal(fixSeedRead(missing, pr, CURRENT)?.kind, "live", "missing receipt");
  const foreign = history();
  foreign[4]!.run_id = PRIOR;
  assert.equal(fixSeedRead(foreign, pr, CURRENT)?.kind, "live", "foreign receipt");
});

test("the current daemon's own pending seed remains live", () => {
  const rows = history();
  rows[3]!.run_id = CURRENT;
  assert.equal(fixSeedRead(rows, pr, CURRENT)?.kind, "live");
});

test("a task continuation adopted after boot still refuses orphan recovery", () => {
  const rows = history();
  rows.push({ step: "run_child.adopted", task_id: pr.taskId, run_id: CURRENT });
  assert.equal(fixSeedRead(rows, pr, CURRENT)?.kind, "live");
});


test("the sweep rechecks the normal checkout claim for a recovered old-head window", async t => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-old-head-seed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  const rows = history();
  const at = "2026-10-24T18:00:00.000Z";
  rows[3]!.ts = at;
  const view: OpenPrView = { ...pr, prUrl: "https://github.com/example/fixture/pull/50",
    headRefName: "run-W1-T9000-1792860000000", reviewState: "failure", checksState: "green",
    unmetCriteria: [{ claim: "a criterion", proof: "unit test: fixture", met: false,
      reason: "not done", proof_exec: "not_executable" }], priorStrikes: 0,
    lastActivityAt: at, autoMergeArmed: false };
  let claims = 0;
  const pass = async (held: boolean) => {
    await runSweep([view], { runId: CURRENT, ledgerPath, now: () => Date.parse(at),
      arm: () => assert.fail("red cannot arm"), close: () => assert.fail("not stale"), escalate: () => {},
      readLedger: () => [...rows, ...readLedgerLines(ledgerPath)],
      dispatchFix: () => { claims++; return held ? { claimDeclined: true, ownerRecoveryReason: "live_claim" } : undefined; },
    });
    return readLedgerLines(ledgerPath);
  };
  const held = await pass(true);
  assert.equal(claims, 1);
  assert.equal(held.findLast(row => row.step === "sweep.disposed")?.acted, false);
  assert.equal(held.findLast(row => row.step === "sweep.fix.seed_orphaned")?.reason, "owner-run-ended");
  const free = await pass(false);
  assert.equal(claims, 2);
  assert.equal(free.findLast(row => row.step === "sweep.disposed")?.acted, true);
});

test("real rotation preserves the exact old-head recovery and its uncertain-owner controls", t => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-old-head-seed-rotation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [index, uncertain] of [false, true].entries()) {
    const own = join(dir, String(index));
    mkdirSync(own);
    const ledgerPath = join(own, "ledger.ndjson");
    const rows = history();
    if (uncertain) rows[4]!.unreadable = 1;
    const core = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
    const bytes = Buffer.byteLength(core);
    writeFileSync(ledgerPath, core + JSON.stringify({ step: "ci.polling", padding: "x".repeat(bytes * 4) }) + "\n");
    assert.equal(rotateLedger(ledgerPath, { ceilingBytes: bytes * 2 }).rotated, true);
    const after = readLedgerLines(ledgerPath);
    assert.ok(after.some(row => row.step === "fix.stood_down"), "the older handoff is really retained");
    assert.equal(fixSeedRead(after, pr, CURRENT)?.kind, uncertain ? "live" : "orphaned");
  }
});
