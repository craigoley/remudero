import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse } from "yaml";

import type { Config } from "#src/lib/config.js";
import type { FixProgressJudge } from "#src/lib/fix-progress-judge.js";
import { PARKED_PR_REMEDY_STEP, PLAN_ROUND_EXHAUSTED_CAUSE, planRoundExhaustedRemedy, readParkedPrShard,
  type ParkedPrHost, type ParkedPrTarget } from "#src/lib/parked-pr-remedy.js";
import type { Plan } from "#src/lib/plan.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// W1-T13047: once a plan-only pull request's plan-scoped round is exhausted, the sweep used to escalate it to a person.
// The operator ruled that no pull request waits on the operator: the pull request is closed and rebuilt as a held task.

const PR = 13047;
const PR_URL = `https://github.com/o/r/pull/${PR}`;
const HEAD = "e".repeat(40);
const NOW = Date.parse("2026-11-16T12:00:00Z");
const PLAN_FILE = "plan/tasks.d/W1-T13900-a-filed-task.yaml";
const LINT_LOG = "✗ W1-T13900: 1 violation(s)\n  [rationale-why] the rationale has no WHY: line";
const REFUSAL = "the plan round could not name a WHY for the rationale";
const ESCALATE: FixProgressJudge = async () => ({ verdict: "escalate", loop: "plan rounds repeated", reason: "the same refusal twice" });

const filing = (over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: PR, prUrl: PR_URL, headSha: HEAD, headRefName: "ci-friction-garden-1791084979333", isPlanFiling: true,
  checksState: "red", reviewState: "pending", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
  lastActivityAt: new Date(NOW).toISOString(), ciFailures: [{ name: "lint-plan", logTail: LINT_LOG }], ...over,
} as OpenPrView);

/** #11381-shaped: a fleet gardener's plan filing that went dirty on plan paths only. */
const dirty = (): OpenPrView => filing({ headRefName: "backlog-garden-1791904155914", planFilingSource: "github-files",
  checksState: "none", reviewState: "none", mergeState: "dirty", ciFailures: [],
  mergeConflict: { files: [{ path: PLAN_FILE, oursDeleted: 0, theirsDeleted: 1 }], oursLog: "", theirsLog: "" } });

const roundRefused = (): Record<string, unknown>[] => Array.from({ length: 2 }, () => ({
  step: "sweep.plan_round.refused", task_id: `PR-${PR}`, pr_number: PR, head_sha: HEAD, outcome: "refused", reason: REFUSAL }));
const judgeWaited = (): Record<string, unknown> => ({ step: "sweep.disposed", pr_number: PR, head_sha: HEAD, task_id: "SWEEP",
  run_id: "earlier", disposition: "wait", reason: `refused-twice: plan round ${REFUSAL}` });
const claimRefused = (): Record<string, unknown>[] => Array.from({ length: 2 }, (_, i) => [
  { task_id: `PR-${PR}`, step: "fix.dispatch", round_id: String(i), head_sha: HEAD, ci_failures: ["lint-plan"] },
  { task_id: `PR-${PR}`, step: "fix.commit_refused", round_id: String(i), head_sha: HEAD, reason: REFUSAL },
  { task_id: `PR-${PR}`, step: "fix.done", round_id: String(i), head_sha: HEAD, subtype: "commit_refused" },
]).flat();

function spies() {
  const landed: { relPath: string; content: string }[][] = [];
  const closed: { prUrl: string; comment: string }[] = [];
  let next = 99000;
  const writes: Pick<ParkedPrHost, "reserveTaskId" | "landTaskFiles" | "closePr" | "readPrFiles" | "planFilingTarget"> = {
    planFilingTarget: { owner: "o", repo: "r", checkoutDir: "/fixture/public" },
    reserveTaskId: () => `W1-T${++next}`,
    landTaskFiles: async (files) => { landed.push(files.map(f => ({ relPath: f.relPath, content: f.content }))); return { prUrl: "https://github.com/o/r/pull/99999" }; },
    closePr: async (prUrl, comment) => { closed.push({ prUrl, comment }); },
    readPrFiles: async () => [PLAN_FILE, "plan/MASTER-INDEX.md"],
  };
  return { writes, landed, closed };
}

/** The production parkedPr effect: its task-file read is the real one; its GitHub and git writes are spied. */
function productionParkedPr(t: TestContext, writes: ReturnType<typeof spies>["writes"]): ParkedPrHost {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}plan-round-exhausted-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const effects = buildSweepEffects({ owner: "o", repo: "r", repoRoot: root, config: { claudeBin: "claude", root } as Config,
    ledgerPath: join(root, "ledger.ndjson"), runId: "plan-round-exhausted", plan: { tasks: [], byId: new Map() } as unknown as Plan,
    log: () => {}, reloadPlanForFixImpl: () => undefined, readJsonImpl: async () => assert.fail("no GitHub read") });
  assert.ok(effects.parkedPr, "the production sweep effects wire the remedy");
  assert.equal(typeof effects.parkedPr.readPrFiles, "function", "the production effect reads the pull request's files");
  assert.deepEqual(effects.parkedPr.planFilingTarget, { owner: "o", repo: "r", checkoutDir: root });
  const { planFilingTarget: _target, ...effectWrites } = writes;
  return { ...effects.parkedPr, ...effectWrites };
}

function world(rows: Record<string, unknown>[], parkedPr: ParkedPrHost | undefined, judge: FixProgressJudge | undefined) {
  const escalated: string[] = [], rounds: number[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused/plan-round-ledger", runId: "plan-round-test", now: () => NOW,
    readLedger: () => rows, appendLine: (_path: string, row: Record<string, unknown>) => { rows.push(row); },
    arm: () => {}, close: () => {}, postReview: async () => {},
    escalate: (_pr: OpenPrView, reason: string) => { escalated.push(reason); },
    dispatchFix: () => { assert.fail("a plan filing never enters the code rung"); },
    readPlanRepairFacts: () => ({ authorLogin: "remudero-fleet[bot]" }),
    repairPlanPr: () => ({ repaired: false, reason: "no mechanical cure matches" }),
    dispatchPlanGateRound: async () => { rounds.push(PR); return { outcome: "refused", reason: REFUSAL }; },
    ...(judge ? { fixProgressJudge: judge } : {}),
    ...(parkedPr ? { parkedPr } : {}),
  } as unknown as SweepDeps;
  const remedies = () => rows.filter(r => r.step === PARKED_PR_REMEDY_STEP);
  const disposed = () => rows.filter(r => r.step === "sweep.disposed" && r.run_id === "plan-round-test");
  return { deps, escalated, rounds, remedies, disposed };
}

const heldTask = (content: string) => (parse(content) as Record<string, unknown>[])[0]!;
const conflictPolicy = { ...DEFAULT_SWEEP_POLICY, mergeConflictAdmissionEnabled: true };

test("W1-T13047 criterion 1: an exhausted plan round the judge rules escalate is closed and rebuilt, and escalates nothing", async (t) => {
  const legacy = world([judgeWaited(), ...roundRefused()], undefined, ESCALATE);
  await runSweep([filing()], legacy.deps, DEFAULT_SWEEP_POLICY);
  assert.ok(legacy.escalated.length >= 1, "without the remedy the exhausted round escalates to a person");

  const { writes, landed, closed } = spies();
  const rows = [judgeWaited(), ...roundRefused()];
  const w = world(rows, productionParkedPr(t, writes), ESCALATE);
  await runSweep([filing()], w.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(w.escalated.length, 0, "deps.escalate is called zero times");
  assert.equal(rows.filter(r => r.step === "fix.progress_judged" || (r.site === "refused-twice" && r.verdict === "escalate")).length >= 1, true,
    "the judge's verdict and its receipt row stay");
  assert.equal(closed.length, 1, "the pull request is closed through parkedPr.closePr");
  assert.equal(closed[0]!.prUrl, PR_URL);
  assert.equal(landed.length, 1, "one held task is filed");
  assert.equal(landed[0]!.length, 1);
  const held = heldTask(landed[0]![0]!.content);
  assert.equal(held.id, "W1-T99001");
  assert.equal(held.status, "queued");
  const question = (held.needs_input as { question: string; source_pr: string }).question;
  assert.equal((held.needs_input as { source_pr: string }).source_pr, PR_URL);
  assert.match(question, /Red gates: lint-plan/, "the question names the red gates");
  assert.match(question, new RegExp(REFUSAL), "the question names the refusal reason");
  assert.match(question, /\[rationale-why\] the rationale has no WHY/, "the question names the log line the lint found");
  assert.deepEqual(held.files, [PLAN_FILE, "plan/MASTER-INDEX.md"].sort(), "its files are the plan files the pull request changes");
  assert.match(String(held.rationale), new RegExp(PLAN_FILE.replace(/\./g, "\\.")));
  assert.match(String(held.rationale), /lint-plan/);
  const row = w.disposed().at(-1)!;
  assert.equal(row.disposition, "wait");
  assert.equal(row.blocker, "other");
  assert.doesNotMatch(String(row.reason), /escalating$/);
});

test("W1-T13047 criterion 2: a refused-twice claim, and a refused-twice round with no judge, are closed and rebuilt too", async () => {
  for (const [name, rows, judge, text] of [
    ["refused-twice claim", claimRefused(), ESCALATE, /Refusal: fix rounds refused twice at this head/],
    ["refused twice with no fix progress judge", roundRefused(), undefined, /Refusal: fix rounds refused twice at this head \(the plan round/],
    ["the judge's escalate", [judgeWaited(), ...roundRefused()], ESCALATE, /Refusal: fix progress loop: plan rounds repeated/],
  ] as const) {
    const { writes, landed, closed } = spies();
    const all = [...rows];
    const w = world(all, { readTaskShard: async () => ({ outcome: "refused", reason: "task-absent" }), ...writes }, judge);
    await runSweep([filing()], w.deps, DEFAULT_SWEEP_POLICY);
    assert.equal(w.escalated.length, 0, `${name}: no escalation`);
    assert.deepEqual(w.remedies().map(r => [r.remedy, r.cause, r.outcome]), [["close-and-rebuild", PLAN_ROUND_EXHAUSTED_CAUSE, "taken"]],
      `${name}: one parked_pr.remedy row`);
    assert.equal(w.remedies()[0]!.closed, true, `${name}: the row records the close`);
    assert.match(String(w.remedies()[0]!.text), text, `${name}: the row names why the round is exhausted`);
    assert.equal(closed.length, 1, `${name}: closed`);
    assert.equal(landed.length, 1, `${name}: one held task`);
    assert.equal(w.rounds.length, 0, `${name}: no further round is dispatched`);
  }
});

test("W1-T13047 criterion 3: an exhausted plan-scoped merge-conflict round is closed and rebuilt, and its reason no longer ends in escalating", async () => {
  const legacy = world(roundRefused(), undefined, undefined);
  await runSweep([dirty()], legacy.deps, conflictPolicy);
  assert.match(String(legacy.disposed().at(-1)!.reason), /conflict round on this fleet plan PR is exhausted.* — escalating$/,
    "without the remedy the exhausted conflict round escalates");

  const { writes, landed, closed } = spies();
  const w = world(roundRefused(), { readTaskShard: async () => ({ outcome: "refused", reason: "task-absent" }), ...writes, readPrFiles: async () => [] }, undefined);
  await runSweep([dirty()], w.deps, conflictPolicy);
  assert.equal(w.escalated.length, 0);
  assert.deepEqual(w.remedies().map(r => [r.remedy, r.cause, r.outcome]), [["close-and-rebuild", PLAN_ROUND_EXHAUSTED_CAUSE, "taken"]]);
  assert.equal(closed.length, 1);
  const held = heldTask(landed[0]![0]!.content);
  assert.deepEqual(held.files, [PLAN_FILE], "the conflicting plan files are the held task's files");
  assert.match((held.needs_input as { question: string }).question, /merge conflict, mergeState dirty/);
  const row = w.disposed().at(-1)!;
  assert.equal(row.disposition, "wait");
  assert.doesNotMatch(String(row.reason), /escalating$/);
});

test("W1-T13047 criterion 4: invariant:round-first, a plan filing whose plan-scoped round is not exhausted is never closed", async () => {
  const cases: [string, Record<string, unknown>[], Partial<SweepDeps>, RegExp][] = [
    ["dispatched", [], {}, /plan-scoped round refused/],
    ["deferred to the full sweep", roundRefused(), { actionable: () => false }, /deferred to the full sweep/],
    ["deferred: dry run", roundRefused(), { dryRun: true }, /deferred: dry run/],
    ["deferred until the judge has waited once", roundRefused(), {}, /refused-twice: plan round/],
    ["held by worker admission", roundRefused(), { workerAdmissionHold: () => "the fleet is paused" }, /held by worker admission/],
    ["waiting on base red", [{ step: "main.health.observed", sha: "m".repeat(40), state: "red", failing_checks: ["lint-plan"],
      observed_checks: ["lint-plan"] }, ...roundRefused()], {}, /base.red/],
  ];
  for (const [name, rows, over, reason] of cases) {
    const { writes, landed, closed } = spies();
    const w = world([...rows], { readTaskShard: async () => ({ outcome: "refused", reason: "task-absent" }), ...writes }, ESCALATE);
    await runSweep([filing()], { ...w.deps, ...over } as SweepDeps, DEFAULT_SWEEP_POLICY);
    assert.equal(closed.length, 0, `${name}: never closed`);
    assert.equal(landed.length, 0, `${name}: no held task`);
    assert.equal(w.remedies().filter(r => r.cause === PLAN_ROUND_EXHAUSTED_CAUSE).length, 0, `${name}: no remedy row`);
    if (!over.dryRun) assert.match(String(w.disposed().at(-1)?.reason), reason, `${name}: the round keeps its own reason`);
  }
});

test("W1-T13047 criterion 5: invariant:one-question, later passes over the closed pull request file no second held task", async () => {
  const { writes, landed, closed } = spies();
  const rows = roundRefused();
  const w = world(rows, { readTaskShard: async () => ({ outcome: "refused", reason: "task-absent" }), ...writes }, undefined);
  for (let pass = 0; pass < 3; pass++) await runSweep([filing()], w.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(landed.length, 1, "one held task for the pull request and cause");
  assert.equal(closed.length, 1, "the pull request is closed once");
  assert.equal(w.remedies().filter(r => r.held_task_id !== undefined && r.outcome === "taken" && r.closed === true).length, 1);
  assert.equal(w.escalated.length, 0);
  const later = w.disposed().at(-1)!;
  assert.match(String(later.reason), /held task W1-T99001 was filed for this pull request and cause; this pass reuses it/);
});

for (const readable of [true, false]) {
  test(`an exhausted plan filing with a ${readable ? "readable" : "missing"} catalog task file reserves and lands in that catalog`, async () => {
    const target: ParkedPrTarget = { owner: "private", repo: "ops", checkoutDir: "/fixture/ops" };
    const taskId = "W1-T13901";
    const shard = { relPath: `plan/tasks.d/${taskId}-catalog-task.yaml`, text: [
      `- id: ${taskId}`, "  title: catalog task", "  repo: r", "  files: [src/catalog.ts]",
      "  acceptance:", "    - claim: the catalog task holds", "      proof: 'grep: catalog in src/catalog.ts'",
    ].join("\n") };
    const { writes, landed, closed } = spies();
    const reservations: ParkedPrTarget[] = [], landings: ParkedPrTarget[] = [], rows: Record<string, unknown>[] = [];
    const host: ParkedPrHost = { ...writes,
      readTaskShard: async id => {
        assert.equal(id, taskId);
        return readParkedPrShard({ outcome: "resolved", task: { id }, target }, checkoutDir => {
          assert.equal(checkoutDir, target.checkoutDir);
          return readable ? shard : undefined;
        });
      },
      reserveTaskId: destination => { reservations.push(destination); return writes.reserveTaskId(destination); },
      landTaskFiles: async (files, destination) => { landings.push(destination); return writes.landTaskFiles(files, destination); },
    };
    const out = await planRoundExhaustedRemedy(filing({ taskId }), { redChecks: ["lint-plan"], violations: [], refusal: REFUSAL },
      rows, host, { runId: "catalog-plan-rebuild", ledgerTaskId: taskId, nowIso: new Date(NOW).toISOString(),
        append: row => { rows.push(row); } });
    assert.equal(out.error, undefined, out.reason);
    assert.deepEqual([out.disposition, out.blocker], ["wait", "other"]);
    assert.deepEqual(reservations, [target], "the reservation belongs to the task's catalog");
    assert.deepEqual(landings, [target], "the held task follows the read's target, even when the file is missing");
    assert.equal(closed.length, 1);
    const held = heldTask(landed[0]![0]!.content);
    assert.deepEqual(held.files, readable ? ["src/catalog.ts"] : [PLAN_FILE, "plan/MASTER-INDEX.md"].sort());
    assert.match(String(held.title), readable ? /^catalog task/ : /^Rebuild the plan filing/);
    assert.equal(rows[0]!.outcome, "taken");
  });
}

for (const reason of ["destination-unreadable", "destination-lookup-failed"]) {
  test(`an exhausted plan filing refuses ${reason} without falling back to the public catalog`, async () => {
    const { writes, landed, closed } = spies();
    let reservations = 0;
    const rows: Record<string, unknown>[] = [];
    const out = await planRoundExhaustedRemedy(filing({ taskId: "W1-T13901" }),
      { redChecks: ["lint-plan"], violations: [], refusal: REFUSAL }, [],
      { ...writes, readTaskShard: async () => readParkedPrShard({ outcome: "unreadable", reason }, () => assert.fail("no catalog read")),
        reserveTaskId: () => { reservations++; return "W1-T99001"; } },
      { runId: "catalog-plan-refusal", ledgerTaskId: "W1-T13901", nowIso: new Date(NOW).toISOString(), append: row => { rows.push(row); } });
    assert.equal(out.error, reason);
    assert.equal(reservations, 0);
    assert.deepEqual(landed, []);
    assert.deepEqual(closed, []);
    assert.deepEqual(rows.map(row => [row.outcome, row.reason]), [["refused", reason]]);
  });
}
