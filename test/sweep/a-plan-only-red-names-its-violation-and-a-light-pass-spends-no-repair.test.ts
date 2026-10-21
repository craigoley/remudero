import assert from "node:assert/strict";
import test from "node:test";

// Read through the namespace, so this file still LOADS at a base that lacks a symbol and fails per test.
import * as sweep from "#src/lib/sweep.js";
import type { CiFailure, OpenPrView, SweepDeps } from "#src/lib/sweep.js";

// PR-13008 — an operator `codex/*` plan filing sat red on lint-plan and ci-shard (2/8) for 22+ hours. The
// plan-repair rung has no signature for a filing's own lint violation, so the PR escalated (#13058), but the
// issue only said "red on lint-plan" and recommended re-arming the code-fix rung that cannot stage plan
// files. The light pass's `sweep.plan_repair` also wrote outcome "unwired" (no updateBranch there), and that
// row burned the head's one base-red attempt, so no full pass could ever press the refresh.

const NOW = Date.parse("2026-10-20T04:30:00Z");
const HEAD = "8".repeat(40);
const MAIN_GREEN = "c".repeat(40);

// The light-gates job's lint-plan step, as its log tail reads: timestamped, a warning after the violation.
const LINT_LOG = [
  "2026-10-20T04:40:01.0000000Z rmd lint-plan: 1 task(s) checked (1 new/changed vs HEAD^1) — 1 failing, 1 warning(s)",
  "2026-10-20T04:40:01.0000000Z ✗ W1-T10160: 1 violation(s) (0 pre-existing on base HEAD^1)",
  "2026-10-20T04:40:01.0000000Z     [machine-filing-admission] task W1-T10160 dependency credit unavailable (UNKNOWN): W1-T9658: merge credit store missing or inaccessible",
  "2026-10-20T04:40:01.0000000Z   ⚠ W1-T10160: [sizing] spans 5 distinct subsystems/concerns at risk:high",
].join("\n");

function failure(name: string, logTail = ""): CiFailure {
  return { name, logTail, conclusion: "FAILURE" };
}

function planPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 13008,
    prUrl: "https://github.com/acme/remudero/pull/13008",
    reviewState: "success",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    headSha: HEAD,
    headRefName: "codex/gardener-judge-price-filing-20261018",
    autoMergeArmed: false,
    isPlanFiling: true,
    planFilingSource: "github-files",
    ciFailures: [failure("lint-plan", LINT_LOG), failure("ci-gate")],
    body: "Files W1-T10160.\n\n## Acceptance\n- W1-T10160 is filed | grep: W1-T10160 in plan/tasks.d",
    ...over,
  };
}

// A green peer keeps the red on ONE PR, so the pass never reads it as every PR's base-caused red.
function greenPeer(): OpenPrView {
  return planPr({
    prNumber: 6900, prUrl: "https://github.com/acme/remudero/pull/6900", taskId: "W1-T4000", checksState: "green",
    headSha: "e".repeat(40), headRefName: "run-W1-T4000-1", isPlanFiling: false, ciFailures: undefined,
  });
}

const mainGreen = { step: "main.health.observed", sha: MAIN_GREEN, state: "green", failing_checks: [] };

async function pass(prs: OpenPrView[], ledger: Record<string, unknown>[], wired: boolean, behind = 25) {
  const escalated: Array<{ pr: number; reason: string }> = [];
  const updated: number[] = [];
  const deps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, postReview: async () => {},
    escalate: (pr: OpenPrView, reason: string) => { escalated.push({ pr: pr.prNumber, reason }); },
    // The light pass leaves updateBranch unwired (run-task.ts's runSweepLightPass deps); the full pass wires it.
    ...(wired ? { updateBranch: (pr: { prNumber: number }) => { updated.push(pr.prNumber); return "updated" as const; } } : {}),
    readPlanRepairFacts: () => ({ authorLogin: "cao825", title: "chore(plan): capture existing gardener judge price evidence" }),
    repairPlanPr: () => ({ outcome: "renumbered" }),
    behindMainByPr: new Map(prs.map((p) => [p.prNumber, p.prNumber === 6900 ? 0 : behind])),
    ledgerPath: "/dev/null/pr-13008.ndjson",
    runId: "PR-13008-test",
    readLedger: () => ledger,
    appendLine: (_path: string, line: Record<string, unknown>) => { ledger.push(line); },
    now: () => NOW,
  } as unknown as SweepDeps;
  await sweep.runSweep(prs, deps, sweep.DEFAULT_SWEEP_POLICY);
  const repairRows = () => ledger.filter((l) => l.step === sweep.PLAN_REPAIR_STEP && l.pr_number === 13008);
  return { escalated, updated, repairRows };
}

test("PR-13008: a plan-only escalation names the violation its own lint-plan log carries", async () => {
  const run = await pass([planPr(), greenPeer()], [mainGreen], true);
  assert.equal(run.escalated.length, 1);
  const reason = run.escalated[0]!.reason;
  assert.match(reason, /plan-only PR is red on lint-plan/);
  assert.ok(reason.includes("W1-T10160 [machine-filing-admission] task W1-T10160 dependency credit unavailable (UNKNOWN)"),
    `the escalation must name the blocking row, got: ${reason}`);
  assert.ok(!reason.includes("[sizing]"), "a warning is not the violation that holds the PR");
});

test("PR-13008: planLintViolationsFromCiFailures dedupes across logs, skips warnings and caps its output", () => {
  const shard = failure("ci-shard (2/8)", `  ✗ W1-T10160: 1 violation(s)\n      [machine-filing-admission] task W1-T10160 dependency credit unavailable (UNKNOWN): W1-T9658: merge credit store missing or inaccessible`);
  const named = sweep.planLintViolationsFromCiFailures([failure("lint-plan", LINT_LOG), shard]);
  assert.deepEqual(named, ["W1-T10160 [machine-filing-admission] task W1-T10160 dependency credit unavailable (UNKNOWN): W1-T9658: merge credit store missing or inaccessible"]);
  const many = Array.from({ length: 5 }, (_, i) => `✗ W1-T${i}: 1 violation(s)\n    [shard-shape] ${"x".repeat(400)}`).join("\n");
  const capped = sweep.planLintViolationsFromCiFailures([failure("lint-plan", many)]);
  assert.equal(capped.length, 3);
  assert.ok(capped.every((v) => v.length === 240));
  assert.deepEqual(sweep.planLintViolationsFromCiFailures([failure("lint-plan", "[orphan] a row with no header")]), []);
});

test("PR-13008: a light pass's unwired plan repair leaves the full pass its one refresh", async () => {
  // At 04:32Z only ci-shard (2/8) was red (an inheritable check), so the rung chose an inherited refresh. The
  // head is 0 commits behind by count but on an old merge base, so the distance refresh never presses as well.
  const pr = planPr({ ciFailures: [failure("ci-shard (2/8)"), failure("ci-gate")], currentMergeBaseSha: "d".repeat(40) });
  const ledger: Record<string, unknown>[] = [mainGreen];
  const light = await pass([pr, greenPeer()], ledger, false, 0);
  assert.deepEqual(light.updated, []);
  assert.equal(light.repairRows().at(-1)?.outcome, "unwired");
  assert.ok(!sweep.planRepairHistoryFromLedger(ledger).has(`13008@${HEAD}@base-red`), "an unwired no-op is not an attempt");

  const full = await pass([pr, greenPeer()], ledger, true, 0);
  assert.deepEqual(full.updated, [13008], "the full pass presses the refresh the light pass could not");
  assert.equal(full.repairRows().at(-1)?.outcome, "updated");

  // The press that did happen is spent: the same head never gets a second one.
  const after = await pass([pr, greenPeer()], ledger, true, 0);
  assert.deepEqual(after.updated, []);
});
