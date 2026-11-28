import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";

import {
  HELD_REBUILD_RATIONALE_RE, heldRebuildOf, heldRebuildsOfTaskText, PARKED_PR_REMEDY_STEP, takeParkedPrRemedy,
  type HeldRebuild, type ParkedPrHost,
} from "#src/lib/parked-pr-remedy.js";
import {
  DESIGN_HOLD_MAIN_ADOPTION_FIELD, designHoldMainAdoptionDeferred, HELD_ESCALATION_SLO_MS, runSweep, type OpenPrView, type SweepDeps,
  type UpdateBranchOutcome,
} from "#src/lib/sweep.js";

// W1-T15108: core #21068 (W1-T14905) was green but for one red step main had already fixed. Its fix round stood down on
// "fix needs design at this exact head", and at 06:32:20Z on 2026-11-27 a pass whose main-adoption decision was
// "updater-unavailable" closed it and filed held rebuild W1-T15095; at 06:47:27Z another pass filed W1-T15101 for the same
// head. An unspent main adoption now waits for a pass that takes it, and one head gets one rebuild.

type Row = { step: string } & Record<string, unknown>;

const TASK = "W1-T15108-FIXTURE";
const PR = 21068;
const PR_URL = `https://github.com/o/remudero/pull/${PR}`;
const HEAD = "2106800".padEnd(40, "1");
const MAIN = "a".repeat(40);
const NOW = Date.parse("2026-11-27T06:32:20Z");
const CHECK = "comment-load-ratchet";
const CLAIMS = ["the first criterion holds", "the second criterion holds"];
const SHARD_REL = `plan/tasks.d/${TASK}-a-fixture-task.yaml`;
const shard = [`- id: ${TASK}`, "  title: \"A fixture task\"", "  repo: remudero", "  files:", "    - src/x.ts", "  status: queued",
  "  attempts: 0", "  acceptance:", ...CLAIMS.flatMap(c => [`    - claim: "${c}"`, `      proof: "grep: ${c} in src/x.ts"`]),
  "  rationale: |", "    WHY: a fixture.", ""].join("\n");

function parkedHost(rebuilds: () => readonly HeldRebuild[] = () => []) {
  const landed: { relPath: string; content: string }[][] = [];
  const closed: string[] = [];
  let next = 95000;
  const h: ParkedPrHost = {
    readTaskShard: async (id) => id === TASK
      ? { outcome: "read", shard: { relPath: SHARD_REL, text: shard }, target: { owner: "o", repo: "remudero", checkoutDir: "/unused/checkout" } }
      : { outcome: "refused", reason: "task-absent" },
    reserveTaskId: () => `W1-T${++next}`,
    landTaskFiles: async (files) => { landed.push(files.map(f => ({ relPath: f.relPath, content: f.content }))); return { prUrl: "https://github.com/o/remudero/pull/99998" }; },
    closePr: async (prUrl) => { closed.push(prUrl); },
    readHeldRebuilds: () => rebuilds(),
  };
  return { h, landed, closed };
}

const view = (over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: PR, prUrl: PR_URL, taskId: TASK, headSha: HEAD, checksState: "red", reviewState: "pending", unmetCriteria: [],
  priorStrikes: 1, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(),
  ciFailures: [{ name: CHECK, logTail: "expiring-fixture-census: 2 crossings [inherited from the base]" }], ...over,
});

/** The fix round that stood down on the design hold, `ageMs` before NOW; it covers the one red check. */
function designRows(ageMs = 2000): Row[] {
  const common = { task_id: TASK, head_sha: HEAD, run_id: "DESIGN-ROUND", host: "fixture-host", actor_pid: 777 };
  const round = { ...common, round_id: "DESIGN-ROUND:1", repair_pr_url: PR_URL };
  return [
    { ...round, step: "fix.dispatch", ts: new Date(NOW - ageMs - 2000).toISOString(), mode: "ci-log" },
    { ...common, step: "fix.needs_design", ts: new Date(NOW - ageMs).toISOString(), contract_revision: "contract-A",
      reason: "the remedy for this red is upstream, reachable only by taking main", covers_checks: [CHECK] },
    { ...round, step: "fix.done", ts: new Date(NOW - ageMs + 1000).toISOString(), fix_outcome: "NEEDS_DESIGN", subtype: "success" },
  ];
}

/** A pass; `light` has no branch updater, as the 06:32:20Z pass had none. */
function sweepWorld(rows: Row[], parked: ParkedPrHost, opts: { behind?: number; light?: boolean } = {}) {
  const state = { escalated: 0, dispatched: 0, refreshed: 0 };
  const deps: SweepDeps = {
    ledgerPath: "/unused/w1-t15108-ledger", runId: "W1-T15108-test", now: () => NOW,
    readLedger: () => rows, readHeadContractRefreshHistory: async () => ({ complete: true, lines: rows }),
    appendLine: (_path, row) => { rows.push(row as Row); },
    fixProgressJudge: async () => ({ verdict: "continue", reason: "the judge permits another round" }),
    readTaskContractRevision: () => "contract-A",
    readMainTip: async () => MAIN,
    behindMainByPr: new Map([[PR, opts.behind ?? 3]]),
    updateBranch: async (): Promise<UpdateBranchOutcome> => { state.refreshed++; return "updated"; },
    arm: () => {}, close: () => {},
    escalate: () => { state.escalated++; },
    dispatchFix: () => { state.dispatched++; },
    claimFixAdmission: () => ({ admitted: true }),
    parkedPr: parked,
  };
  // The production light pass: no updater, and the light repair surface (src/cli/commands/sweep.ts).
  if (opts.light === true) { delete deps.updateBranch; deps.repairAdmissionSurface = "light"; }
  return { deps, state, remedies: () => rows.filter(r => r.step === PARKED_PR_REMEDY_STEP) };
}

const lastDisposed = (rows: Row[]) => rows.findLast(r => r.step === "sweep.disposed" && r.pr_number === PR)!;

test("W1-T15108 criterion 1: an unspent main adoption on a light pass files no close-and-rebuild", async () => {
  const parked = parkedHost();
  const rows = designRows();
  const light = sweepWorld(rows, parked.h, { light: true });
  await runSweep([view()], light.deps);
  assert.deepEqual(light.remedies(), [], "no parked-PR remedy runs on the pass that cannot take main");
  assert.deepEqual(parked.closed, [], "the pull request is not closed");
  assert.equal(parked.landed.length, 0, "no rebuild is filed");
  assert.equal(light.state.escalated, 0, "no person is asked while main is untaken");
  const disposed = lastDisposed(rows);
  assert.equal(disposed.disposition, "wait");
  assert.equal(disposed.design_hold_main_adoption_decision, "updater-unavailable");
  assert.match(String(disposed.reason), /cannot take it \(updater-unavailable\) — waiting for a pass that takes main/);

  // The next pass that has an updater takes main, the adoption that was unspent.
  const full = sweepWorld(rows, parked.h);
  await runSweep([view()], full.deps);
  assert.equal(full.state.refreshed, 1, "the following full pass takes main into the branch");
  assert.equal(lastDisposed(rows).design_hold_main_adoption_decision, "due");
  assert.deepEqual(parked.closed, []);

  for (const [decision, configure] of [
    ["main-tip-unavailable", (d: SweepDeps) => { d.readMainTip = async () => undefined; }],
    ["distance-unavailable", (d: SweepDeps) => { d.behindMainByPr = new Map(); }],
    ["updater-unavailable", (d: SweepDeps) => { delete d.updateBranch; }],
  ] as const) {
    for (const light of [true, false]) {
      const p = parkedHost();
      const r = designRows();
      const w = sweepWorld(r, p.h, { light });
      configure(w.deps);
      await runSweep([view()], w.deps);
      // A light pass has no updater, so it names that decision first whatever else is unavailable.
      assert.equal(lastDisposed(r).design_hold_main_adoption_decision, light ? "updater-unavailable" : decision);
      if (light) assert.equal(lastDisposed(r).disposition, "wait", `${decision} on a light pass waits`);
      // A full pass escalates as before, and its escalation rung may still take fix-on-pr, never a close-and-rebuild.
      assert.deepEqual(w.remedies().filter(row => row.remedy === "close-and-rebuild"), [],
        `${decision} (${light ? "light" : "full"} pass) takes no close-and-rebuild`);
      if (light) assert.deepEqual(w.remedies(), [], `${decision} on a light pass takes no parked-PR remedy`);
      assert.deepEqual(p.closed, [], `${decision} (${light ? "light" : "full"} pass) closes nothing`);
    }
  }

  // A full pass whose one adoption went to another held pull request leaves this one open for a later pass.
  const second = { prNumber: PR + 1, prUrl: `https://github.com/o/remudero/pull/${PR + 1}`, taskId: TASK, headSha: "c".repeat(40) };
  const p = parkedHost();
  const r: Row[] = [...designRows(), ...designRows().map(row => ({ ...row, head_sha: second.headSha,
    ...(row.repair_pr_url === undefined ? {} : { repair_pr_url: second.prUrl }) }))];
  const w = sweepWorld(r, p.h);
  w.deps.behindMainByPr = new Map([[PR, 3], [PR + 1, 3]]);
  await runSweep([view(), view(second)], w.deps);
  assert.equal(w.state.refreshed, 1, "one adoption per pass");
  assert.equal(r.findLast(row => row.step === "sweep.disposed" && row.pr_number === PR + 1)?.design_hold_main_adoption_decision,
    "pass-budget-spent");
  assert.deepEqual(p.closed, [], "the pull request whose adoption the budget held back is not closed");
});

test("W1-T15108 criterion 2: close-and-rebuild waits for the main adoption, bounded by the held-escalation SLO", async () => {
  const young = parkedHost();
  const youngRows = designRows();
  await runSweep([view()], sweepWorld(youngRows, young.h, { light: true }).deps);
  assert.deepEqual(young.closed, [], "a hold younger than the SLO waits for the adoption");

  const old = parkedHost();
  const oldRows = designRows(HELD_ESCALATION_SLO_MS + 60_000);
  const w = sweepWorld(oldRows, old.h, { light: true });
  await runSweep([view()], w.deps);
  assert.deepEqual(w.remedies().map(r => [r.remedy, r.outcome]), [["close-and-rebuild", "taken"]],
    "past the SLO today's ladder acts");
  assert.deepEqual(old.closed, [PR_URL]);

  const attempted = parkedHost();
  const attemptedRows: Row[] = [...designRows(), { step: "sweep.disposed", pr_number: PR, [DESIGN_HOLD_MAIN_ADOPTION_FIELD]: "conflict" }];
  await runSweep([view()], sweepWorld(attemptedRows, attempted.h, { light: true }).deps);
  assert.deepEqual(attempted.closed, [PR_URL], "after the one adoption was attempted the pull request is closed for a rebuild");
});

test("W1-T15108 criterion 3: a head at main or with an attempted adoption keeps today's remedy", async () => {
  const atMain = parkedHost();
  const atMainRows = designRows();
  const m = sweepWorld(atMainRows, atMain.h, { behind: 0, light: true });
  await runSweep([view()], m.deps);
  assert.equal(lastDisposed(atMainRows).design_hold_main_adoption_decision, "updater-unavailable");
  assert.deepEqual(m.remedies().map(r => r.remedy), ["close-and-rebuild"], "a head at main has nothing to take");
  assert.deepEqual(atMain.closed, [PR_URL]);

  const fullAtMain = parkedHost();
  const fullRows = designRows();
  await runSweep([view()], sweepWorld(fullRows, fullAtMain.h, { behind: 0 }).deps);
  assert.equal(lastDisposed(fullRows).design_hold_main_adoption_decision, "not-behind");
  assert.deepEqual(fullAtMain.closed, [PR_URL]);

  const spent = { step: "sweep.disposed", pr_number: PR, [DESIGN_HOLD_MAIN_ADOPTION_FIELD]: "updated" };
  assert.equal(designHoldMainAdoptionDeferred("updater-unavailable", { prNumber: PR }, [], 3), true);
  assert.equal(designHoldMainAdoptionDeferred("pass-budget-spent", { prNumber: PR }, [], undefined), true);
  assert.equal(designHoldMainAdoptionDeferred("updater-unavailable", { prNumber: PR }, [spent], 3), false, "already attempted");
  assert.equal(designHoldMainAdoptionDeferred("updater-unavailable", { prNumber: PR }, [], 0), false, "at main");
  for (const decision of ["due", "not-behind", "already-attempted", "contract-amended"]) {
    assert.equal(designHoldMainAdoptionDeferred(decision, { prNumber: PR }, [], 3), false, decision);
  }
});

test("W1-T15108 criterion 4: one rebuild per closed pull request head", async () => {
  const pr = { prNumber: PR, prUrl: PR_URL, headSha: HEAD, taskId: TASK, unmetCriteria: [] };
  const decision = { remedy: "close-and-rebuild" as const, reason: "the design hold covers every red check", inputCriteria: [] };
  const ctx = (cause: string, rows: Row[]) => ({ runId: "W1-T15108-test", ledgerTaskId: TASK, nowIso: new Date(NOW).toISOString(),
    cause, text: "fix needs design at this exact head", append: (row: Row) => { rows.push(row); } });

  // The first pass files the rebuild; the held task's own text names the pull request and head.
  const first = parkedHost();
  const firstRows: Row[] = [];
  const filed = await takeParkedPrRemedy(pr, decision, firstRows, first.h, ctx("needs-design", firstRows));
  assert.equal(first.landed.length, 1);
  const held = heldRebuildsOfTaskText(first.landed[0]![0]!.content);
  assert.deepEqual(held, [{ id: filed.heldTaskId, prUrl: PR_URL, headSha: HEAD }]);

  // A second pass under another cause, with the first row in its ledger view, reuses it.
  const second = parkedHost();
  const secondRows = [...firstRows];
  const reused = await takeParkedPrRemedy(pr, decision, secondRows, second.h, ctx("escalated:refused-escalate", secondRows));
  assert.equal(second.landed.length, 0, "no second rebuild under another cause");
  assert.equal(reused.heldTaskId, filed.heldTaskId);

  // A second pass whose ledger view lacks the first row reads the held rebuild from the queue or the plan.
  const third = parkedHost(() => held);
  const thirdRows: Row[] = [];
  const found = await takeParkedPrRemedy(pr, decision, thirdRows, third.h, ctx("needs-design", thirdRows));
  assert.equal(third.landed.length, 0, "no second rebuild for the same head, whatever the ledger view holds");
  assert.equal(found.heldTaskId, filed.heldTaskId);
  assert.equal(thirdRows.at(-1)?.reused, true);

  // A rebuild for another head files a new one.
  const other = parkedHost(() => held);
  await takeParkedPrRemedy({ ...pr, headSha: "b".repeat(40) }, decision, [], other.h, ctx("needs-design", []));
  assert.equal(other.landed.length, 1, "another head is another rebuild");

  // Both writers' rationales parse; a task without a rebuild title is not one.
  const plan = heldRebuildOf({ id: "W1-T1", title: "Rebuild the plan filing of pull request 7 (held rebuild)",
    rationale: `REBUILD of the plan filing ${PR_URL}, filed by the sweep (W1-T13047) at ${HEAD}: a reason.\n` });
  assert.deepEqual(plan, { id: "W1-T1", prUrl: PR_URL, headSha: HEAD });
  assert.equal(HELD_REBUILD_RATIONALE_RE.exec("not a rebuild rationale"), null);
  assert.equal(HELD_REBUILD_RATIONALE_RE.exec(`REBUILD of ${PR_URL}, filed by the sweep (W1-T12709) from ${PR_URL} at ${HEAD}: reason`)?.[2], PR_URL,
    "a held rebuild rationale with its pull request and head is recognized");
  assert.equal(heldRebuildOf({ id: "W1-T2", title: "Task (held rebuild)", rationale: "not a rebuild rationale" }), undefined,
    "a held rebuild task with a malformed rationale is refused");
  assert.equal(heldRebuildOf({ ...(parse(first.landed[0]![0]!.content) as Row[])[0], title: "A fixture task" }), undefined);
});
