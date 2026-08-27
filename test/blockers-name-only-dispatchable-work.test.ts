import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildStatusBoard, type CircuitBrokenBlocker, type StatusBoardDeps } from "../src/lib/status-board.js";
import { loadPlanFromYaml, type Plan } from "../src/lib/plan.js";
import { DEFAULT_MAX_TASK_DISPATCHES, isDispatchBreakerTripped, type GitHub } from "../src/lib/status.js";

// ── W1-T2335: BLOCKERS BY CLASS must not render `circuit_broken` for a task dispatch will NEVER
// take. `isDispatchEligible` (drain.ts) refuses a plan-declared `status: "blocked"` task and a
// task the projection already credits MERGED two guards before it ever reaches the breaker check
// — so a withdrawn or landed task's row was pure history wearing a present-tense verb
// ("investigate before it re-dispatches again"). `deriveCircuitBrokenBlockers` now takes the same
// `plan`/`projections` `deriveBlockers` already holds and skips exactly those two populations,
// copying the identical skip `deriveIndeterminateBlockers` already performs for a merged task.
// The breaker's own ledger state (`dispatchesWithoutNewOwnedPr`/`isDispatchBreakerTripped`) is
// NEVER touched — only the renderer's row is suppressed, so the row returns byte-identical the
// moment the task's status returns to a dispatchable one.

const NOW_ISO = "2026-08-27T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "blockers-name-only-root-"));
}

function baseDeps(overrides: Partial<StatusBoardDeps> = {}): StatusBoardDeps {
  return {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests", // tryLoadDefaultPlan always fails here — plan is undefined unless overridden
    now: () => NOW_MS,
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    ...overrides,
  };
}

function ledgerLine(overrides: Record<string, unknown>): Record<string, unknown> {
  return { run_id: "R1", task_id: "daemon", ts: NOW_ISO, ...overrides };
}

function writeLedger(lines: Record<string, unknown>[]): string {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "blockers-name-only-ledger-")), "ledger.ndjson");
  writeFileSync(ledgerPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return ledgerPath;
}

/** A tripped-breaker ledger fixture for `taskId`: exactly `DEFAULT_MAX_TASK_DISPATCHES`
 *  `run.start` rows and no intervening owned-merge credit — the same shape status-board.test.ts's
 *  own circuit-broken fixtures use. */
function trippedBreakerLines(taskId: string): Record<string, unknown>[] {
  return Array.from({ length: DEFAULT_MAX_TASK_DISPATCHES }, (_, i) =>
    ledgerLine({ step: "run.start", task_id: taskId, run_id: `${taskId}-${i}` }),
  );
}

function planYaml(taskId: string, status: string, extra = ""): string {
  return `
- id: ${taskId}
  title: a dispatch-history-carrying task
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: ${status}
${extra}`;
}

function plan(taskId: string, status: string, extra = ""): Plan {
  return loadPlanFromYaml(planYaml(taskId, status, extra), "fixture");
}

/** A GitHub gateway fixture carrying only the four REQUIRED {@link GitHub} methods, every one
 *  answering "no evidence" by default — mirrors status-board.test.ts's own `fakeGithub`. */
function fakeGithub(overrides: Partial<GitHub> = {}): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => false,
    ...overrides,
  };
}

function circuitBrokenRow(rows: ReturnType<typeof buildStatusBoard>["blockers"]["rows"], taskId: string): CircuitBrokenBlocker | undefined {
  return rows.find((r): r is CircuitBrokenBlocker => r.kind === "circuit_broken" && r.taskId === taskId);
}

// ── acceptance 1 + 3: a plan-declared blocked task contributes no row, and rendering neither
// writes a ledger line nor changes what the breaker itself reports for the same task ───────────

test("W1-T2335: a plan-declared blocked task contributes no circuit-broken blocker row, whatever dispatch streak the ledger still carries for it", () => {
  const taskId = "W1-T314";
  const lines = trippedBreakerLines(taskId);
  const ledgerPath = writeLedger(lines);

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(taskId, "blocked"), github: fakeGithub() }));

  assert.equal(
    circuitBrokenRow(model.blockers.rows, taskId),
    undefined,
    "a plan-declared blocked (withdrawn) task must not render a circuit_broken row",
  );
});

test("W1-T2335: rendering writes no ledger line and leaves the breaker reading tripped for the same task afterwards, so no dispatch decision anywhere changes", () => {
  const taskId = "W1-T314";
  const lines = trippedBreakerLines(taskId);
  const ledgerPath = writeLedger(lines);
  const before = readFileSync(ledgerPath, "utf8");

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(taskId, "blocked"), github: fakeGithub() }));

  assert.equal(circuitBrokenRow(model.blockers.rows, taskId), undefined);
  assert.equal(readFileSync(ledgerPath, "utf8"), before, "buildStatusBoard must write no ledger line — the ledger is untouched");
  assert.equal(
    isDispatchBreakerTripped(lines, taskId),
    true,
    "the breaker's OWN ledger read must still report tripped — only the renderer's row was suppressed",
  );
});

// ── acceptance 2: the next action must fall through to a later rule, not go blank, once the
// impossible row no longer feeds the FIRST (circuit_broken) rule in BLOCKERS_NEXT_ACTIONS ──────

test("W1-T2335: the blockers next action is never computed from a task dispatch will never take, and the later rules still produce their action for the rows that remain", () => {
  const taskId = "W1-T314";
  const lines = [
    ...trippedBreakerLines(taskId),
    ledgerLine({
      step: "sweep.disposed",
      task_id: "W1-T50",
      pr_number: 100,
      pr_url: "https://x/100",
      disposition: "blocked-fixable",
      reason: "required checks red — ci-log fix, strike 1/3",
      acted: true,
    }),
  ];
  const ledgerPath = writeLedger(lines);

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(taskId, "blocked"), github: fakeGithub() }));

  assert.equal(circuitBrokenRow(model.blockers.rows, taskId), undefined);
  assert.ok(model.blockers.rows.some((r) => r.kind === "blocked_pr" && r.prNumber === 100), "the blocked_pr row must still render");
  assert.match(model.blockers.nextAction ?? "", /PR #100 is blocked/, "the LATER rule must fire once circuit_broken no longer applies");
  assert.doesNotMatch(model.blockers.nextAction ?? "", /dispatch circuit is broken/, "the suppressed row must never drive the next action");
});

// ── acceptance 4: the same ledger, replayed against a plan where the task is dispatchable again,
// renders the row again byte-identical — the ledger was never written to, only read differently ─

test("W1-T2335: the same task returned to a dispatchable status renders its circuit-broken row again from the same untouched ledger", () => {
  const taskId = "W1-T314";
  const lines = trippedBreakerLines(taskId);
  const ledgerPath = writeLedger(lines);

  const withdrawn = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(taskId, "blocked"), github: fakeGithub() }));
  assert.equal(circuitBrokenRow(withdrawn.blockers.rows, taskId), undefined);

  const dispatchable = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(taskId, "queued"), github: fakeGithub() }));
  const row = circuitBrokenRow(dispatchable.blockers.rows, taskId);
  assert.ok(row, "the row must return, unchanged, once the plan says the task is dispatchable again");
  assert.equal(row!.dispatchCount, DEFAULT_MAX_TASK_DISPATCHES);
  assert.equal(row!.maxDispatches, DEFAULT_MAX_TASK_DISPATCHES);
  assert.equal(
    row!.resetNote,
    `resets only on a fresh owned PR for ${taskId} — ${DEFAULT_MAX_TASK_DISPATCHES}/${DEFAULT_MAX_TASK_DISPATCHES} dispatches since the last one`,
  );
});

// ── acceptance 5: a task the batched projection already credits MERGED contributes no row —
// copying the identical skip deriveIndeterminateBlockers already performs ──────────────────────

test("W1-T2335: a task the projection already credits merged contributes no circuit-broken row, matching the merged skip the indeterminate class already performs", () => {
  const taskId = "W1-T314";
  const lines = trippedBreakerLines(taskId);
  const ledgerPath = writeLedger(lines);
  const github = fakeGithub({
    prByRef: (ref) => (ref === 900 ? { number: 900, url: "https://x/900", state: "MERGED" } : null),
  });

  // `status: queued` (still dispatchable per the PLAN) but landed per GITHUB — proves this skip
  // is driven by the projection, not by a second read of plan status.
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(taskId, "queued", "  pr: 900\n"), github }));

  assert.equal(
    circuitBrokenRow(model.blockers.rows, taskId),
    undefined,
    "a task the projection already credits merged must not render a circuit_broken row",
  );
});

// ── acceptance 6: with no plan and no projections in hand, the class renders exactly as it does
// today — degrade toward today, never toward silence (design (iv)) ─────────────────────────────

test("W1-T2335: with no plan and no projections available the class renders exactly as it does today rather than withholding rows", () => {
  const taskId = "W1-T314";
  const lines = trippedBreakerLines(taskId);
  const ledgerPath = writeLedger(lines);

  // baseDeps() supplies no `plan` and no `github` — repoDir is a nonexistent path, so
  // tryLoadDefaultPlan fails and buildStatusBoard resolves plan/projections both undefined.
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());

  const row = circuitBrokenRow(model.blockers.rows, taskId);
  assert.ok(row, "with no plan the renderer cannot know the task is withdrawn, so it must render exactly as it always has");
  assert.equal(row!.dispatchCount, DEFAULT_MAX_TASK_DISPATCHES);
});

// ── acceptance 7: an ordinary dispatchable task with a tripped breaker is completely unaffected —
// its row and reset wording render exactly as before this task ─────────────────────────────────

test("W1-T2335: a dispatchable task with a tripped breaker keeps its row and its reset wording unchanged", () => {
  const taskId = "W1-T900";
  const lines = trippedBreakerLines(taskId);
  const ledgerPath = writeLedger(lines);

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(taskId, "queued"), github: fakeGithub() }));

  const row = circuitBrokenRow(model.blockers.rows, taskId);
  assert.ok(row, "a dispatchable task's circuit-broken row must still render");
  assert.equal(row!.dispatchCount, DEFAULT_MAX_TASK_DISPATCHES);
  assert.equal(row!.maxDispatches, DEFAULT_MAX_TASK_DISPATCHES);
  assert.equal(
    row!.resetNote,
    `resets only on a fresh owned PR for ${taskId} — ${DEFAULT_MAX_TASK_DISPATCHES}/${DEFAULT_MAX_TASK_DISPATCHES} dispatches since the last one`,
  );
  assert.match(model.blockers.nextAction ?? "", new RegExp(`${taskId}'s dispatch circuit is broken`));
});
