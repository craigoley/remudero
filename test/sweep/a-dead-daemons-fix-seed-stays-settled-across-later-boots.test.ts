import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixSeedRead, runSweep, type OpenPrView } from "#test/helpers/sweep-test.js";

type Row = Record<string, unknown>;
const OWNER = "DAEMON-1793398033232";
const CURRENT = "DAEMON-1793601275855";
const LATER = "DAEMON-1793643571744";
const fixtures = [
  { prNumber: 15532, taskId: "W1-T10573", headSha: "25fec8e", ts: "2026-10-30T23:03:38.473Z" },
  { prNumber: 15602, taskId: "W1-T10722", headSha: "ee01645", ts: "2026-10-31T00:39:06.809Z" },
];
const seedFor = (pr: typeof fixtures[number]): Row => ({ step: "sweep.disposed", pr_number: pr.prNumber,
  task_id: pr.taskId, head_sha: pr.headSha, ts: pr.ts, run_id: OWNER, disposition: "conflicted", acted: true });
const rungFor = (pr: typeof fixtures[number]): Row => ({ step: "fix.scope_amendment", task_id: pr.taskId,
  run_id: OWNER, outcome: "resumed", ts: "2026-10-31T00:43:06.000Z" });
const seedRows = (pr: typeof fixtures[number]): Row[] => [
  { step: "fix.dispatch", task_id: pr.taskId, head_sha: pr.headSha, run_id: OWNER, mode: "conflict" },
  seedFor(pr), rungFor(pr),
];
const bootRows = (runId = CURRENT, children: Row[] = []): Row[] => [
  ...children,
  { step: "run_child.adoption_pass", task_id: "DAEMON", run_id: runId, live: children.length,
    adopted: children.length, unreadable: 0, misidentified: 0 },
  { step: "daemon.boot", task_id: "DAEMON", run_id: runId },
];
const otherChildren: Row[] = ["W1-T9001", "W1-T9002"].map(task_id =>
  ({ step: "run_child.adopted", task_id, run_id: `${task_id}-child` }));
const receiptFor = (pr: typeof fixtures[number]): Row => ({ step: "sweep.fix.seed_orphaned",
  pr_number: pr.prNumber, head_sha: pr.headSha, task_id: pr.taskId, seed_ts: pr.ts,
  seed_run_id: OWNER, reason: "owner-run-ended", run_id: CURRENT });

test("test/sweep/a-dead-daemons-fix-seed-stays-settled-across-later-boots.test.ts: other tasks' adopted children do not own either dead seed", () => {
  for (const pr of fixtures) {
    const read = fixSeedRead([...seedRows(pr), ...bootRows(CURRENT, otherChildren)], pr, CURRENT);
    assert.equal(read?.kind, "orphaned", `PR #${pr.prNumber}`);
    assert.equal(read?.orphanReason, "owner-run-ended");
    assert.deepEqual(read.seed, { ts: pr.ts, runId: OWNER });
  }
});

test("W1-T11169 criterion 2: settlement survives later boots and is scoped to its seed and head", () => {
  const pr = fixtures[1];
  const original = seedRows(pr);
  const settled = [...original, receiptFor(pr)];
  assert.equal(fixSeedRead(settled, pr, LATER)?.kind, "orphaned", "the receipt itself is read back");
  assert.equal(fixSeedRead([...settled, ...bootRows(LATER, otherChildren)], pr, LATER)?.kind, "orphaned");
  assert.equal(fixSeedRead([...original, ...bootRows(), ...bootRows(LATER, otherChildren)], pr, LATER)?.kind,
    "orphaned", "a readable earlier boot remains evidence even before a settlement is written");
  for (const changed of [{ pr_number: 15532 }, { head_sha: "another-head" }, { seed_ts: "another-seed" }]) {
    assert.equal(fixSeedRead([...original, { ...receiptFor(pr), ...changed }], pr, LATER)?.kind, "live");
  }
  const dispatch = { step: "fix.dispatch", task_id: pr.taskId, head_sha: pr.headSha, run_id: LATER };
  assert.equal(fixSeedRead([...settled, dispatch], pr, LATER)?.kind, "live", "a new dispatch supersedes settlement");
  assert.equal(fixSeedRead([...settled, { ...dispatch, task_id: "another-task" }], pr, LATER)?.kind, "orphaned");
  assert.equal(fixSeedRead([...settled, { ...dispatch, head_sha: "another-head" }], pr, LATER)?.kind, "orphaned");
  assert.equal(fixSeedRead([...settled, { ...seedFor(pr), ts: "2026-11-03T00:00:00Z", run_id: LATER },
    dispatch], pr, LATER)?.kind, "live", "a new seed gets its own read");
});

test("W1-T11169 criterion 3: own adopted or uncertain children, incomplete censuses and current owners stay live", () => {
  const pr = fixtures[0];
  const original = seedRows(pr);
  for (const step of ["run_child.adopted", "run_child.adoption_unreadable", "run_child.adoption_misidentified"]) {
    const child = { step, task_id: pr.taskId, run_id: "surviving-child" };
    const pass = { step: "run_child.adoption_pass", run_id: CURRENT, live: step.endsWith("unreadable") ? 0 : 1,
      adopted: step === "run_child.adopted" ? 1 : 0, unreadable: step.endsWith("unreadable") ? 1 : 0,
      misidentified: step.endsWith("misidentified") ? 1 : 0 };
    const boot = { step: "daemon.boot", run_id: CURRENT };
    assert.equal(fixSeedRead([...original, child, pass, boot], pr, CURRENT)?.kind, "live", step);
    assert.equal(fixSeedRead([...original, child, pass, boot, ...bootRows(LATER, otherChildren)], pr, LATER)?.kind,
      "orphaned", "only a later readable census without this task releases its previous child");
    assert.equal(fixSeedRead([...original, ...bootRows(), child, pass, { ...boot, run_id: LATER }], pr, LATER)?.kind,
      "live", `later evidence of ${step} vetoes derivation`);
  }
  for (const field of ["live", "adopted", "unreadable", "misidentified"]) {
    for (const value of [undefined, -1, "0", Number.NaN, 1]) {
      const rows = bootRows();
      rows[0] = { ...rows[0], [field]: value };
      assert.equal(fixSeedRead([...original, ...rows], pr, CURRENT)?.kind, "live", `${field}: ${value}`);
    }
  }
  assert.equal(fixSeedRead([...original, ...bootRows(CURRENT, otherChildren)], pr, OWNER)?.kind, "live");
  assert.equal(fixSeedRead([...original, receiptFor(pr)], pr, OWNER)?.kind, "live",
    "a receipt cannot release the current seed owner");
  assert.equal(fixSeedRead([...original, ...bootRows(), { step: "fix.dispatch", task_id: pr.taskId,
    head_sha: pr.headSha, run_id: CURRENT }], pr, CURRENT)?.kind, "live");
  assert.equal(fixSeedRead([...original, { step: "daemon.boot", run_id: CURRENT }], pr, CURRENT)?.kind, "live");
});

test("W1-T11169 criterion 2: the real dedup arm writes once while checkout claims still gate redispatch", async t => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-dead-seed-settlement-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  const written = (): Row[] => existsSync(ledgerPath)
    ? readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const pr = fixtures[1];
  const view: OpenPrView = { ...pr, prUrl: `https://github.com/craigoley/remudero/pull/${pr.prNumber}`,
    headRefName: "run-W1-T10722-1793398000000", reviewState: "failure", checksState: "green",
    unmetCriteria: [{ claim: "a criterion", proof: "unit test: fixture", met: false,
      reason: "not done", proof_exec: "not_executable" }], priorStrikes: 0,
    lastActivityAt: pr.ts, autoMergeArmed: false };
  const rows = [...seedRows(pr), ...bootRows()];
  let claims = 0;
  const pass = async (runId: string, held = true) => {
    await runSweep([view], { runId, ledgerPath, now: () => Date.parse("2026-11-02T21:03:00Z"),
      arm: () => assert.fail("red cannot arm"), close: () => assert.fail("not stale"), escalate: () => {},
      readLedger: () => [...rows, ...written()],
      dispatchFix: () => { claims++; return held ? { claimDeclined: true, ownerRecoveryReason: "live_claim" } : undefined; },
    });
    return written();
  };
  await pass(CURRENT);
  await pass(CURRENT);
  rows.push(...bootRows(LATER, otherChildren));
  const held = await pass(LATER);
  assert.equal(claims, 3, "each pass reaches the ordinary owner claim");
  const receipts = held.filter(row => row.step === "sweep.fix.seed_orphaned");
  assert.equal(receipts.length, 1, "one persistent receipt per seed");
  assert.equal(receipts[0].seed_ts, pr.ts);
  assert.equal(receipts[0].seed_run_id, OWNER);
  assert.equal(receipts[0].reason, "owner-run-ended");
  assert.equal(held.findLast(row => row.step === "sweep.disposed")?.acted, false);
  const admitted = await pass(LATER, false);
  assert.equal(claims, 4);
  assert.equal(admitted.findLast(row => row.step === "sweep.disposed")?.acted, true);
  assert.equal(admitted.filter(row => row.step === "sweep.fix.seed_orphaned").length, 1);
});
