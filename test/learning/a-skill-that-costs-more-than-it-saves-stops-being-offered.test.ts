import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { selectImplementSkills } from "#src/cli/commands/run-task-verb.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import { gardenPassDue } from "#src/lib/gardener.js";
import { loadProposalRegistry, updateProposalRegistryAsync } from "#src/lib/inbox.js";
import { knowledgeGardenSpec, runGardenPass, skillLifecycleCandidates, skillUsagePath, type GardenWorkspace } from "#src/lib/knowledge-gardener.js";
import { readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import type { CriterionVerdict } from "#src/lib/review.js";
import {
  SKILL_EFFECTIVENESS_LEDGER_STEPS,
  SKILL_WITHHOLDING_SHARE,
  buildSkillEffectivenessReport,
  skillLifecycleProposalId,
} from "#src/lib/skill-workshop.js";
import { SKILL_ARM_EPOCH, taskArmWithheld } from "#src/lib/task-arm.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

// W1-T13860: the skill lifecycle never retired a skill and never looked at cost. Handed-off runs with no merge row
// stayed pending forever, so both live skills read INSUFFICIENT EVIDENCE (pending-shipment), and a retirement
// candidate only staged a proposal while offering went on. These tests drive the report, the gardener's own spec
// and the two lanes' selection code with nothing injected in place of the new code.

type Row = Record<string, unknown>;

const SKILL = "costly-skill";
const PR = "https://github.com/acme/widgets/pull/";
const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-20T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));

const selection = (runId: string, treated: boolean, skill = SKILL, ts?: number): Row => ({
  ...(ts === undefined ? {} : { ts: iso(ts) }),
  run_id: runId, step: "skills.selection", task_type: "implement",
  approved_eligible_names: [skill], selected_names: treated ? [skill] : [], budget_omitted_names: [],
  withheld_names: treated ? [] : [skill],
});

const verdict = (runId: string, v: string, fields: Row = {}): Row => ({ run_id: runId, step: "verdict", verdict: v, ...fields });
const merge = (n: number, ts?: number): Row => ({
  ...(ts === undefined ? {} : { ts: iso(ts) }), step: "pr.terminal", pr_url: `${PR}${n}`, pr_number: n, state: "merged",
});

/** An arm with `merged` later PR merges; the rest close unmerged. Undefined cost leaves a run unpriced. */
function pricedArm(prefix: string, treated: boolean, runs: number, merged: number, cost: (i: number) => number | undefined, prBase: number, skill = SKILL): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < runs; i++) {
    const runId = `${prefix}-${i}`;
    const n = prBase + i;
    rows.push(selection(runId, treated, skill, T0),
      verdict(runId, "handed_off", { ts: iso(T0), pr_url: `${PR}${n}`, total_cost_usd: cost(i) }));
    rows.push(i < merged ? merge(n, T0 + HOUR) : { ts: iso(T0 + HOUR), step: "pr.terminal", pr_url: `${PR}${n}`, pr_number: n, state: "closed" });
  }
  return rows;
}

test("W1-T13860 criterion 1: a closed or long-waiting handed-off run counts as not merged; thin or untimed evidence stays pending", () => {
  // Ten handed-off runs merged after 1..10 hours, so the settle window is the 95th percentile: 10 hours.
  const timed = (waitMs: number, mergedRuns: number): Row[] => {
    const rows: Row[] = [];
    for (let i = 0; i < mergedRuns; i++) {
      const verdictMs = T0 + i * 1000;
      rows.push(selection(`m-${i}`, false, SKILL, verdictMs),
        verdict(`m-${i}`, "handed_off", { ts: iso(verdictMs), pr_url: `${PR}${100 + i}` }),
        merge(100 + i, verdictMs + (i + 1) * HOUR));
    }
    const waitingMs = T0 + 20 * HOUR;
    rows.push(selection("waiting", true, SKILL, waitingMs), verdict("waiting", "blocked_ci", { ts: iso(waitingMs), pr_url: `${PR}999` }));
    rows.push({ ts: iso(waitingMs + waitMs), step: "skills.selection", run_id: "later", task_type: "implement", approved_eligible_names: [] });
    return rows;
  };
  const settled = buildSkillEffectivenessReport(timed(11 * HOUR, 10), SKILL);
  assert.equal(settled.settle_window_ms, 10 * HOUR);
  assert.equal(settled.selected.not_merged_runs, 1, "waited longer than the window");
  assert.equal(settled.selected.pending_merge_runs, 0);

  const inWindow = buildSkillEffectivenessReport(timed(10 * HOUR, 10), SKILL);
  assert.equal(inWindow.selected.pending_merge_runs, 1, "the run must wait strictly longer than the window");
  assert.equal(inWindow.selected.not_merged_runs, 0);

  const thin = buildSkillEffectivenessReport(timed(100 * HOUR, 9), SKILL);
  assert.equal(thin.settle_window_ms, null, "nine merged runs are below the horizon");
  assert.equal(thin.selected.pending_merge_runs, 1);

  const untimed = timed(100 * HOUR, 10).map((row) => (row.run_id === "waiting" ? { ...row, ts: undefined } : row));
  const noTs = buildSkillEffectivenessReport(untimed, SKILL);
  assert.equal(noTs.selected.pending_merge_runs, 1, "a run without a timestamp stays pending");

  const closedRows = [
    selection("closed-1", true),
    verdict("closed-1", "handed_off", { ts: iso(T0), pr_url: `${PR}1` }),
    { ts: iso(T0), step: "pr.terminal", pr_url: `${PR}1`, pr_number: 1, state: "closed" },
  ];
  const directMerges = Array.from({ length: 10 }, (_, i) =>
    verdict(`direct-${i}`, "merged", { ts: iso(T0), pr_url: `${PR}${200 + i}` }));
  const closedThin = buildSkillEffectivenessReport([...closedRows, ...directMerges.slice(1)], SKILL);
  assert.equal(closedThin.settle_window_ms, null);
  assert.equal(closedThin.selected.pending_merge_runs, 1, "closing a PR still requires the merge horizon");
  const closed = buildSkillEffectivenessReport([...closedRows, ...directMerges], SKILL);
  assert.equal(closed.settle_window_ms, 0, "a direct merge verdict records both timestamps");
  assert.equal(closed.selected.not_merged_runs, 1);
  assert.equal(closed.selected.pending_merge_runs, 0);
  assert.equal(closed.selected.merged_runs, 0);
  assert.equal(closed.selected.harmful_terminal_runs, 0);
  assert.deepEqual(closed.selected.outcomes, { not_merged: 1 });
  for (const missing of [1, 2]) {
    const missingTs = closedRows.map((row, i) => i === missing ? { ...row, ts: undefined } : row);
    const closedUntimed = buildSkillEffectivenessReport([...missingTs, ...directMerges], SKILL);
    assert.equal(closedUntimed.settle_window_ms, 0);
    assert.equal(closedUntimed.selected.pending_merge_runs, 1, "untimed verdict or close evidence stays pending");
  }
});

test("W1-T13860 criterion 2: each arm carries its costed runs, run plus fix-round cost, and cost per merged PR", (scope) => {
  const { dir } = writeLedger([
    selection("a", true), verdict("a", "handed_off", { pr_url: `${PR}11`, total_cost_usd: 2, notional_cost_usd: 3 }),
    merge(11),
    // Fix rounds name the PR they repair by repair_pr_url, as the fix lane writes them.
    { step: "fix.done", run_id: "DAEMON-1", repair_pr_url: `${PR}11`, total_cost_usd: 0.5 },
    { step: "fix.done", run_id: "DAEMON-2", repair_pr_url: `${PR}11`, total_cost_usd: 0, notional_cost_usd: 0.25 },
    selection("b", true), verdict("b", "no_diff", { total_cost_usd: 1 }),
    selection("c", true), verdict("c", "handed_off", { pr_url: `${PR}13` }), merge(13),
    { step: "fix.done", pr_url: `${PR}13`, total_cost_usd: 100 },
    selection("d", false), verdict("d", "failed", { total_cost_usd: 4 }),
    selection("e", true), verdict("e", "handed_off", { ts: iso(T0), pr_url: `${PR}15`, total_cost_usd: 2 }),
    { step: "fix.done", pr_url: `${PR}15`, total_cost_usd: 0.5 },
    selection("f", false), verdict("f", "blocked_ci", { ts: iso(T0), pr_url: `${PR}16`, total_cost_usd: 5, notional_cost_usd: 6 }),
    { step: "fix.done", repair_pr_url: `${PR}16`, notional_cost_usd: 1 },
  ], { scope });
  const { ok, rows } = readLedgerUnionRecordsSync(dir, { step: SKILL_EFFECTIVENESS_LEDGER_STEPS, refuseIncomplete: true });
  assert.ok(ok);
  const report = buildSkillEffectivenessReport(rows, SKILL);
  assert.equal(report.selected.pending_merge_runs, 1);
  assert.equal(report.control.pending_merge_runs, 1);
  assert.equal(report.selected.costed_runs, 3, "the priced pending run counts and the unpriced merge does not");
  assert.equal(report.selected.merged_runs, 2, "the unpriced merge still counts toward shipment");
  assert.equal(report.selected.cost_usd, 3 + 0.5 + 0.25 + 1 + 2 + 0.5);
  assert.equal(report.selected.cost_per_merged_pr, 7.25);
  assert.equal(report.control.costed_runs, 2);
  assert.equal(report.control.cost_usd, 4 + 6 + 1);
  assert.equal(report.control.cost_per_merged_pr, null, "no merged costed run");
});

test("W1-T13860 criterion 3: an offered arm that costs more per merged PR at one-sided 95% is a retire candidate, every time", () => {
  const rows = [
    ...pricedArm("sel", true, 20, 20, () => 5, 1000),
    ...pricedArm("ctl", false, 20, 5, () => 0.1, 2000),
  ];
  const report = buildSkillEffectivenessReport(rows, SKILL);
  assert.equal(report.selected.pending_merge_runs, 0);
  assert.equal(report.control.pending_merge_runs, 0);
  assert.ok(report.selected.merged_runs > report.control.merged_runs, "the offered arm has a favorable merge bound");
  assert.equal(report.status, "RETIRE-CANDIDATE");
  assert.equal(report.basis, "costs-more-than-it-saves");
  assert.ok((report.cost_difference_lower_bound_usd ?? 0) > 0, `bound ${report.cost_difference_lower_bound_usd}`);
  assert.deepEqual(buildSkillEffectivenessReport(rows, SKILL), report, "the same rows give the same verdict");
  assert.deepEqual(buildSkillEffectivenessReport([...rows].reverse(), SKILL), report, "in any order");
});

test("W1-T13860 criterion 3: a priced pending shipment counts toward the bootstrap horizon", (scope) => {
  const { dir } = writeLedger([
    ...pricedArm("sel", true, 9, 9, () => 5, 1000),
    selection("sel-pending", true), verdict("sel-pending", "blocked_ci", { ts: iso(T0), pr_url: `${PR}1009`, total_cost_usd: 5 }),
    ...pricedArm("ctl", false, 10, 8, () => 1, 2000),
  ], { scope });
  const { ok, rows } = readLedgerUnionRecordsSync(dir, { step: SKILL_EFFECTIVENESS_LEDGER_STEPS, refuseIncomplete: true });
  assert.ok(ok);
  const report = buildSkillEffectivenessReport(rows, SKILL);
  assert.equal(report.selected.pending_merge_runs, 1);
  assert.equal(report.status, "RETIRE-CANDIDATE");
  assert.equal(report.basis, "costs-more-than-it-saves");
  assert.equal(report.selected.costed_runs, report.horizon);
  assert.equal(report.control.costed_runs, report.horizon);
  assert.ok(report.cost_difference_lower_bound_usd !== null && report.cost_difference_lower_bound_usd > 0);
  assert.deepEqual(buildSkillEffectivenessReport([...rows].reverse(), SKILL), report);
});

test("W1-T13860 criterion 4: a skill that merges more at a cost not confidently higher is never retired on cost", () => {
  // The proof-preflight shape: more merges, cost per merged PR a little higher, intervals wide.
  const shape = buildSkillEffectivenessReport([
    ...pricedArm("sel", true, 20, 11, (i) => (i % 2 === 0 ? 3 : 4), 1000),
    ...pricedArm("ctl", false, 20, 10, (i) => (i % 2 === 0 ? 2 : 4), 2000),
  ], SKILL);
  assert.ok(shape.selected.cost_per_merged_pr! > shape.control.cost_per_merged_pr!, "precondition: it costs a little more");
  assert.ok(shape.cost_difference_lower_bound_usd !== null && shape.cost_difference_lower_bound_usd <= 0);
  assert.equal(shape.status, "REVIEW-CANDIDATE");
  assert.equal(shape.basis, "favorable-comparison");
});

test("W1-T13860 criterion 4: pending control spend prevents a false cost retirement", (scope) => {
  const { dir } = writeLedger([
    ...pricedArm("sel", true, 20, 20, () => 5, 1000),
    ...pricedArm("ctl", false, 20, 10, () => 1, 2000).filter((row) => row.state !== "closed"),
    ...Array.from({ length: 10 }, (_, i) => ({ step: "fix.done", pr_url: `${PR}${2010 + i}`, total_cost_usd: 2.5 })),
  ], { scope });
  const { ok, rows } = readLedgerUnionRecordsSync(dir, { step: SKILL_EFFECTIVENESS_LEDGER_STEPS, refuseIncomplete: true });
  assert.ok(ok);
  const report = buildSkillEffectivenessReport(rows, SKILL);
  assert.equal(report.selected.merged_runs, 20);
  assert.equal(report.control.merged_runs, 10);
  assert.equal(report.control.pending_merge_runs, 10);
  assert.ok(report.cost_difference_lower_bound_usd !== null && report.cost_difference_lower_bound_usd <= 0);
  assert.equal(report.selected.cost_per_merged_pr, 5);
  assert.equal(report.control.cost_per_merged_pr, 4.5);
  assert.equal(report.status, "INSUFFICIENT EVIDENCE");
  assert.equal(report.basis, "pending-shipment");
  const beforeFixRounds = buildSkillEffectivenessReport(rows.filter((row) => row.step !== "fix.done"), SKILL);
  assert.ok(beforeFixRounds.cost_difference_lower_bound_usd !== null && beforeFixRounds.cost_difference_lower_bound_usd > 0);
  assert.equal(beforeFixRounds.basis, "costs-more-than-it-saves");
});

test("W1-T13860 criterion 4: either arm missing a priced merge leaves the cost comparison unavailable", () => {
  for (const offeredUnpriced of [true, false]) {
    const report = buildSkillEffectivenessReport([
      ...pricedArm("sel", true, 21, 11, (i) => offeredUnpriced ? (i < 11 ? undefined : 0) : (i < 11 ? 5 : undefined), 1000),
      ...pricedArm("ctl", false, 22, 10, (i) => offeredUnpriced ? (i < 10 ? 1 : undefined) : (i >= 10 ? 0 : undefined), 2000),
    ], SKILL);
    assert.equal(report.selected.merged_runs, 11);
    assert.equal(report.control.merged_runs, 10);
    assert.ok(report.selected.costed_runs >= report.horizon && report.control.costed_runs >= report.horizon);
    assert.equal(report.selected.cost_per_merged_pr, offeredUnpriced ? null : 5);
    assert.equal(report.control.cost_per_merged_pr, offeredUnpriced ? 1 : null);
    assert.equal(report.status, "REVIEW-CANDIDATE");
    assert.equal(report.basis, "favorable-comparison");
    assert.equal(report.cost_difference_lower_bound_usd, null);
  }
});

/** A repo root with approved skills, a state dir with skills-usage.json and a ledger. */
function gardenFixture(skills: readonly string[], usage: Record<string, { offered: number; used: number }>, rows: Row[]): string {
  const root = tmp("w1t13860-garden-");
  for (const name of skills) {
    mkdirSync(join(root, ".claude", "skills", name), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\napplies-to: implement\n---\n\nDo ${name}.\n`);
  }
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(skillUsagePath(join(root, "state")), JSON.stringify(usage));
  writeLedger(rows, { dir: join(root, "state") });
  return root;
}

/** One skill-lifecycle pass through the gardener's own spec. */
function lifecyclePass(root: string): Array<[string, Row]> {
  const logged: Array<[string, Row]> = [];
  const spec = knowledgeGardenSpec({
    stateDir: join(root, "state"), repoRoot: root, log: (step, extra) => logged.push([step, extra ?? {}]),
    openWorkspace: () => { throw new Error("a skill-lifecycle pass opens no workspace"); },
  });
  const inventory = spec.inventory();
  const actions = spec.candidates(inventory, () => 0.5, []).filter((a) => a.class === "skill-lifecycle");
  const ws: GardenWorkspace = { root, refreshAssertions: () => [], land: () => undefined, dispose: () => {} } as unknown as GardenWorkspace;
  spec.apply(ws, { actions, acting: ["skill-lifecycle"] }, {} as never);
  return logged;
}

test("W1-T13860 criterion 5: a skill-lifecycle pass judges every offered approved skill and writes one row per skill", async () => {
  const rows = [
    ...pricedArm("sel", true, 20, 10, () => 5, 1000),
    ...pricedArm("ctl", false, 20, 10, () => 1, 2000),
  ];
  // Both are used often, so the old use-rate rule named neither; one was never offered.
  const usage = { [SKILL]: { offered: 40, used: 30 }, "useful-skill": { offered: 40, used: 30 }, "unoffered-skill": { offered: 0, used: 0 } };
  const root = gardenFixture([SKILL, "useful-skill", "unoffered-skill"], usage, rows);
  try {
    const registry = join(root, "state", "inbox-proposals.json");
    await updateProposalRegistryAsync(registry, () => {
      const logged = lifecyclePass(root);
      const judged = logged.filter(([step]) => step === "skills.lifecycle_judged");
      assert.deepEqual(judged.map(([, row]) => row.skill), [SKILL, "useful-skill"]);
      assert.equal(judged[0]![1].status, "RETIRE-CANDIDATE");
      assert.equal(judged[1]![1].status, "INSUFFICIENT EVIDENCE");
      const errors = logged.filter(([step]) => step === "knowledge.gardener_failed");
      assert.equal(errors.length, 1);
      assert.equal(errors[0]![1].phase, "skill-lifecycle-proposal");
      assert.equal(errors[0]![1].skill, SKILL);
      assert.match(String(errors[0]![1].error), /same-process-busy/);
      return null;
    }, { maxWaitMs: 500 });
    assert.deepEqual(loadProposalRegistry(registry), [], "a held lock prevents staging");
    const judged = lifecyclePass(root).filter(([step]) => step === "skills.lifecycle_judged");
    assert.deepEqual(judged.map(([, row]) => row.skill).sort(), [SKILL, "useful-skill"]);
    const costly = judged.find(([, row]) => row.skill === SKILL)![1];
    assert.equal(costly.status, "RETIRE-CANDIDATE");
    assert.equal(costly.basis, "costs-more-than-it-saves");
    assert.equal(costly.settle_window_ms, HOUR);
    assert.deepEqual(costly.selected, { terminal_runs: 20, merged_runs: 10, cost_per_merged_pr: 10 });
    assert.deepEqual(costly.control, { terminal_runs: 20, merged_runs: 10, cost_per_merged_pr: 2 });
    const staged = loadProposalRegistry(registry);
    assert.deepEqual(staged.map((p) => p.id), [skillLifecycleProposalId(SKILL)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const criteria: CriterionVerdict[] = [
  { claim: "wire producer", proof: "unit test: wires it", met: false, reason: "consumer disconnected", proof_exec: "executed_fail" },
];
const mount = { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 };

/** One fix round of `taskId` through the fix lane's own selection; returns the prompt the worker got. The arm is
 *  drawn per task (W1-T14137), so the task id, not the run id, picks it. */
async function fixPrompt(stateRoot: string, taskId: string, approvedSkillsDir: string): Promise<string> {
  const fixTask = { id: taskId, title: "wire the producer", files: ["src/changed.ts"], acceptance: criteria };
  const runId = `${taskId}-1791151948510`;
  const worktree = tmp("w1t13860-fix-");
  const initialReview = {
    state: "failure" as const, criteria, testTheater: false, summary: "one visible gap",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    headSha: "a".repeat(40), reviewerOutcome: "success",
  };
  const prompts: string[] = [];
  try {
    await runFixRung({
      task: fixTask, taskId: fixTask.id, runId, prUrl: "https://github.com/acme/remudero/pull/1",
      branch: `run-${runId}`, worktreePath: worktree, initialSessionId: "", initialReview,
      mount, settingsFile: join(worktree, "settings.json"), config: { root: stateRoot } as Config, budgetUsd: 1, strikeCap: 1,
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: worktree, reviewerMount: mount },
      deps: {
        approvedSkillsDir,
        ledgerLines: () => [], ledgerPath: join(worktree, "ledger.ndjson"),
        spawn: async (args) => {
          prompts.push(args.prompt);
          return {
            sessionId: "fix", costUsd: 0, numTurns: 1, text: "fixed", blocks: [], stderr: "",
            subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
            model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
            modelUsage: {}, compactionEvents: [], qualitySuspect: false,
          } satisfies WorkerResult;
        },
        waitForCiGreen: async () => "green",
        runReview: async () => ({ ...initialReview, state: "success", criteria: criteria.map((c) => ({ ...c, met: true })), headSha: "d".repeat(40) }),
        push: () => {}, fetchPrBody: async () => "implemented", fetchPrDiffFiles: async () => fixTask.files,
        issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} },
        log: () => {}, say: () => {}, account: (worker) => worker,
      },
    });
    assert.equal(prompts.length, 1);
    return prompts[0]!;
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
}

test("W1-T13860 criterion 6: a skill with a staged retirement is offered only on the seeded share; withdrawing restores it", async () => {
  const rows = [
    ...pricedArm("sel", true, 20, 10, () => 5, 1000).filter((row) => row.state !== "closed"),
    ...pricedArm("ctl", false, 20, 10, () => 1, 2000),
  ];
  const root = gardenFixture([SKILL], { [SKILL]: { offered: 20, used: 15 } }, []);
  const stateDir = join(root, "state");
  const registry = join(stateDir, "inbox-proposals.json");
  const approved = join(root, ".claude", "skills");
  const taskIds = Array.from({ length: 400 }, (_, i) => `W1-T${50000 + i}`);
  const task = (id: string) => ({ id, type: "implement" as const, files: ["src/a.ts"] });
  const offeredTasks = (): string[] =>
    taskIds.filter((id) => selectImplementSkills(root, root, task(id)).observation.selected_names.includes(SKILL));
  const drawn = (id: string): boolean =>
    taskArmWithheld({ taskId: id, unit: SKILL, share: SKILL_WITHHOLDING_SHARE, epoch: SKILL_ARM_EPOCH });
  const seededShare = taskIds.filter(drawn);
  const normal = taskIds.filter((id) => !drawn(id));
  try {
    writeFileSync(join(approved, SKILL, "SKILL.md"), `---\nname: ${SKILL}\napplies-to: implement, fix\n---\n\nDo ${SKILL}.\n`);
    writeFileSync(join(stateDir, "KNOWLEDGE_OFF-refresh"), "");
    const ledger = writeLedger(rows, { dir: stateDir });
    let now = T0 + HOUR;
    let failJudgment = true;
    const judged: Row[] = [];
    const filingFailures: Row[] = [];
    const keptTask = normal[0]!;
    const deps = {
      stateDir, repoRoot: root, seed: 3, clock: clockFromMillisFn(() => now),
      log: (step: string, extra?: Row) => {
        if (step === "knowledge.garden_filing_failed") filingFailures.push(extra ?? {});
        if (step !== "skills.lifecycle_judged") return;
        if (failJudgment) throw new Error("judgment append failed");
        if (extra?.status === "RETIRE-CANDIDATE") {
          assert.deepEqual(loadProposalRegistry(registry), [], "the judgment precedes publication");
          assert.ok(selectImplementSkills(root, root, task(keptTask)).observation.selected_names.includes(SKILL));
        }
        ledger.append([{ step, ts: iso(now), ...extra }]);
        judged.push(extra ?? {});
      },
      openWorkspace: (): GardenWorkspace => ({
        root, refreshAssertions: () => [], dispose: () => {},
        land: () => { throw new Error("skill lifecycle uses the proposal registry"); },
      }),
    };
    const spec = knowledgeGardenSpec(deps);
    assert.deepEqual(offeredTasks(), normal, "before staging: offered on every task the seed does not withhold");
    assert.equal(gardenPassDue(spec, deps), true);
    assert.deepEqual((await runGardenPass(deps)).plan?.acting, ["skill-lifecycle"]);
    assert.deepEqual(filingFailures.map((row) => row.reason), ["judgment append failed"]);
    assert.equal(judged.length, 0);
    assert.deepEqual(loadProposalRegistry(registry), [], "a failed append leaves no retirement to consume");
    assert.deepEqual(offeredTasks(), normal);
    assert.ok((await fixPrompt(root, keptTask, approved)).includes(`## skill: ${SKILL}`));

    failJudgment = false;
    now += HOUR;
    assert.equal(gardenPassDue(spec, deps), true, "the failed pass can retry");
    assert.deepEqual((await runGardenPass(deps)).plan?.acting, ["skill-lifecycle"]);
    assert.equal(judged[0]?.status, "RETIRE-CANDIDATE");
    assert.deepEqual(loadProposalRegistry(registry).map((proposal) => proposal.id), [skillLifecycleProposalId(SKILL)]);
    assert.equal(gardenPassDue(spec, deps), false, "an unchanged tick is idle");
    assert.deepEqual(offeredTasks(), seededShare, "staged: offered only on the seeded share");
    assert.ok(seededShare.length < normal.length / 2);
    // The fix lane reads the same registry.
    assert.ok(!(await fixPrompt(root, keptTask, approved)).includes(`## skill: ${SKILL}`));
    assert.ok((await fixPrompt(root, seededShare[0]!, approved)).includes(`## skill: ${SKILL}`));

    now += HOUR;
    ledger.append(Array.from({ length: 10 }, (_, i) => [
      merge(1010 + i, now),
      { ts: iso(now), step: "fix.done", repair_pr_url: `${PR}${2000 + i}`, notional_cost_usd: 20 },
    ]).flat());
    assert.equal(gardenPassDue(spec, deps), true, "new ledger evidence is eligible on the next hourly pass");
    assert.deepEqual((await runGardenPass(deps)).plan?.acting, ["skill-lifecycle"]);
    assert.deepEqual(judged.map((row) => row.basis), ["costs-more-than-it-saves", "favorable-comparison"]);
    assert.deepEqual(loadProposalRegistry(registry), []);
    assert.deepEqual(offeredTasks(), normal, "withdrawn: the normal share returns");
    assert.ok((await fixPrompt(root, keptTask, approved)).includes(`## skill: ${SKILL}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T13860 criterion 7: a skill removed from .claude/skills is never offered and never judged, whatever its old counts", () => {
  const usage = { "retired-skill": { offered: 115, used: 2 }, [SKILL]: { offered: 10, used: 5 } };
  const root = gardenFixture([SKILL], usage, []);
  try {
    assert.deepEqual(skillLifecycleCandidates(usage, [SKILL]).map((a) => a.target), [SKILL]);
    const judged = lifecyclePass(root).filter(([step]) => step === "skills.lifecycle_judged");
    assert.deepEqual(judged.map(([, row]) => row.skill), [SKILL]);
    for (let i = 0; i < 50; i++) {
      const observed = selectImplementSkills(root, root, { id: `W1-T${50000 + i}`, type: "implement" as const, files: [] }).observation;
      assert.ok(!observed.approved_eligible_names.includes("retired-skill"));
      assert.ok(!observed.selected_names.includes("retired-skill"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
