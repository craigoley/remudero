import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { selectImplementSkills } from "#src/cli/commands/run-task-verb.js";
import type { Config } from "#src/lib/config.js";
import { loadProposalRegistry } from "#src/lib/inbox.js";
import { knowledgeGardenSpec, skillLifecycleCandidates, skillUsagePath, type GardenWorkspace } from "#src/lib/knowledge-gardener.js";
import type { CriterionVerdict } from "#src/lib/review.js";
import {
  buildSkillEffectivenessReport,
  skillLifecycleProposalId,
  skillWithheldForRun,
  stageSkillLifecycleProposal,
  withdrawSkillLifecycleProposal,
} from "#src/lib/skill-workshop.js";
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

/** One arm of priced runs: `merged` of them merge through a later pr.terminal row; the rest close unmerged. */
function pricedArm(prefix: string, treated: boolean, runs: number, merged: number, cost: (i: number) => number, prBase: number, skill = SKILL): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < runs; i++) {
    const runId = `${prefix}-${i}`;
    const n = prBase + i;
    rows.push(selection(runId, treated, skill), verdict(runId, "handed_off", { pr_url: `${PR}${n}`, total_cost_usd: cost(i) }));
    rows.push(i < merged ? merge(n) : { step: "pr.terminal", pr_url: `${PR}${n}`, pr_number: n, state: "closed" });
  }
  return rows;
}

test("W1-T13860 criterion 1: a closed or long-waiting handed-off run counts as not merged; thin or untimed evidence stays pending", () => {
  // A PR closed without merging resolves at once, with or without timestamps.
  const closed = buildSkillEffectivenessReport([
    selection("closed-1", true),
    verdict("closed-1", "handed_off", { pr_url: `${PR}1` }),
    { step: "pr.terminal", pr_url: `${PR}1`, pr_number: 1, state: "closed" },
  ], SKILL);
  assert.equal(closed.selected.not_merged_runs, 1);
  assert.equal(closed.selected.pending_merge_runs, 0);
  assert.equal(closed.selected.merged_runs, 0);
  assert.equal(closed.selected.harmful_terminal_runs, 0, "not merged is not harm");

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

  const inWindow = buildSkillEffectivenessReport(timed(9 * HOUR, 10), SKILL);
  assert.equal(inWindow.selected.pending_merge_runs, 1, "inside the window it can still merge");
  assert.equal(inWindow.selected.not_merged_runs, 0);

  const thin = buildSkillEffectivenessReport(timed(100 * HOUR, 9), SKILL);
  assert.equal(thin.settle_window_ms, null, "nine merged runs are below the horizon");
  assert.equal(thin.selected.pending_merge_runs, 1);

  const untimed = timed(100 * HOUR, 10).map((row) => (row.run_id === "waiting" ? { ...row, ts: undefined } : row));
  const noTs = buildSkillEffectivenessReport(untimed, SKILL);
  assert.equal(noTs.selected.pending_merge_runs, 1, "a run without a timestamp stays pending");
});

test("W1-T13860 criterion 2: each arm carries its costed runs, run plus fix-round cost, and cost per merged PR", () => {
  const report = buildSkillEffectivenessReport([
    selection("a", true), verdict("a", "handed_off", { pr_url: `${PR}11`, total_cost_usd: 2, notional_cost_usd: 3 }),
    merge(11),
    // Fix rounds name the PR they repair by repair_pr_url, as the fix lane writes them.
    { step: "fix.done", run_id: "DAEMON-1", repair_pr_url: `${PR}11`, total_cost_usd: 0.5 },
    { step: "fix.done", run_id: "DAEMON-2", repair_pr_url: `${PR}11`, total_cost_usd: 0, notional_cost_usd: 0.25 },
    selection("b", true), verdict("b", "no_diff", { total_cost_usd: 1 }),
    selection("c", true), verdict("c", "handed_off", { pr_url: `${PR}13` }), merge(13),
    selection("d", false), verdict("d", "failed", { total_cost_usd: 4 }),
  ], SKILL);
  assert.equal(report.selected.costed_runs, 2, "a run with no cost field is left out of the cost comparison");
  assert.equal(report.selected.merged_runs, 2, "but not out of the merge counts");
  assert.equal(report.selected.cost_usd, 3 + 0.5 + 0.25 + 1);
  assert.equal(report.selected.cost_per_merged_pr, 4.75);
  assert.equal(report.control.costed_runs, 1);
  assert.equal(report.control.cost_usd, 4);
  assert.equal(report.control.cost_per_merged_pr, null, "no merged costed run");
});

test("W1-T13860 criterion 3: an offered arm that costs more per merged PR at one-sided 95% is a retire candidate, every time", () => {
  const rows = [
    ...pricedArm("sel", true, 20, 10, () => 5, 1000),
    ...pricedArm("ctl", false, 20, 10, () => 1, 2000),
  ];
  const report = buildSkillEffectivenessReport(rows, SKILL);
  assert.equal(report.selected.pending_merge_runs, 0);
  assert.equal(report.status, "RETIRE-CANDIDATE");
  assert.equal(report.basis, "costs-more-than-it-saves");
  assert.ok((report.cost_difference_lower_bound_usd ?? 0) > 0, `bound ${report.cost_difference_lower_bound_usd}`);
  assert.deepEqual(buildSkillEffectivenessReport(rows, SKILL), report, "the same rows give the same verdict");
  assert.deepEqual(buildSkillEffectivenessReport([...rows].reverse(), SKILL), report, "in any order");
});

test("W1-T13860 criterion 4: a skill that merges more at a cost not confidently higher is never retired on cost", () => {
  // The proof-preflight shape: more merges, cost per merged PR a little higher, intervals wide.
  const shape = buildSkillEffectivenessReport([
    ...pricedArm("sel", true, 20, 11, (i) => (i % 2 === 0 ? 3 : 4), 1000),
    ...pricedArm("ctl", false, 20, 10, (i) => (i % 2 === 0 ? 2 : 4), 2000),
  ], SKILL);
  assert.ok(shape.selected.cost_per_merged_pr! > shape.control.cost_per_merged_pr!, "precondition: it costs a little more");
  assert.ok((shape.cost_difference_lower_bound_usd ?? 0) <= 0);
  assert.notEqual(shape.status, "RETIRE-CANDIDATE");
  // A clear winner on merges is not retired even when its cost is confidently higher.
  const winner = buildSkillEffectivenessReport([
    ...pricedArm("sel", true, 20, 20, () => 5, 1000),
    ...pricedArm("ctl", false, 20, 5, () => 0.1, 2000),
  ], SKILL);
  assert.ok((winner.cost_difference_lower_bound_usd ?? 0) > 0, "precondition: cost is confidently higher");
  assert.equal(winner.status, "REVIEW-CANDIDATE");
  assert.equal(winner.basis, "favorable-comparison");
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

/** One skill-lifecycle pass through the gardener's own spec; returns its ledger rows. */
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
  return logged.filter(([step]) => step === "skills.lifecycle_judged");
}

test("W1-T13860 criterion 5: a skill-lifecycle pass judges every offered approved skill and writes one row per skill", () => {
  const rows = [
    ...pricedArm("sel", true, 20, 10, () => 5, 1000),
    ...pricedArm("ctl", false, 20, 10, () => 1, 2000),
  ];
  // Both are used often, so the old use-rate rule named neither; one was never offered.
  const usage = { [SKILL]: { offered: 40, used: 30 }, "useful-skill": { offered: 40, used: 30 }, "unoffered-skill": { offered: 0, used: 0 } };
  const root = gardenFixture([SKILL, "useful-skill", "unoffered-skill"], usage, rows);
  try {
    const judged = lifecyclePass(root);
    assert.deepEqual(judged.map(([, row]) => row.skill).sort(), [SKILL, "useful-skill"]);
    const costly = judged.find(([, row]) => row.skill === SKILL)![1];
    assert.equal(costly.status, "RETIRE-CANDIDATE");
    assert.equal(costly.basis, "costs-more-than-it-saves");
    assert.equal(costly.settle_window_ms, null);
    assert.deepEqual(costly.selected, { terminal_runs: 20, merged_runs: 10, cost_per_merged_pr: 10 });
    assert.deepEqual(costly.control, { terminal_runs: 20, merged_runs: 10, cost_per_merged_pr: 2 });
    assert.equal(costly.staged, true);
    const staged = loadProposalRegistry(join(root, "state", "inbox-proposals.json"));
    assert.deepEqual(staged.map((p) => p.id), [skillLifecycleProposalId(SKILL)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const criteria: CriterionVerdict[] = [
  { claim: "wire producer", proof: "unit test: wires it", met: false, reason: "consumer disconnected", proof_exec: "executed_fail" },
];
const fixTask = { id: "W1-T9001", title: "wire the producer", files: ["src/changed.ts"], acceptance: criteria };
const mount = { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 };

/** One fix round through the fix lane's own selection; returns the prompt the worker got. */
async function fixPrompt(stateRoot: string, runId: string, approvedSkillsDir: string): Promise<string> {
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
      branch: "run-W1-T9001-1791151948510", worktreePath: worktree, initialSessionId: "", initialReview,
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
    ...pricedArm("sel", true, 20, 10, () => 5, 1000),
    ...pricedArm("ctl", false, 20, 10, () => 1, 2000),
  ];
  const root = gardenFixture([SKILL], {}, []);
  writeFileSync(join(root, ".claude", "skills", SKILL, "SKILL.md"), `---\nname: ${SKILL}\napplies-to: implement, fix\n---\n\nDo ${SKILL}.\n`);
  const registry = join(root, "state", "inbox-proposals.json");
  const task = { type: "implement" as const, files: ["src/a.ts"] };
  const offeredRuns = (): string[] => {
    const out: string[] = [];
    for (let i = 0; i < 400; i++) {
      if (selectImplementSkills(root, root, task, `run-${i}`).observation.selected_names.includes(SKILL)) out.push(`run-${i}`);
    }
    return out;
  };
  const seededShare = Array.from({ length: 400 }, (_, i) => `run-${i}`).filter((r) => skillWithheldForRun(r, SKILL));
  const normal = Array.from({ length: 400 }, (_, i) => `run-${i}`).filter((r) => !skillWithheldForRun(r, SKILL));
  try {
    assert.deepEqual(offeredRuns(), normal, "before staging: offered on every run the seed does not withhold");
    const staged = stageSkillLifecycleProposal(registry, join(root, ".claude", "skills"), buildSkillEffectivenessReport(rows, SKILL));
    assert.equal(staged.staged, true);
    assert.deepEqual(offeredRuns(), seededShare, "staged: offered only on the seeded share");
    assert.ok(seededShare.length < normal.length / 2);
    // The fix lane reads the same registry.
    const keptRun = normal[0]!;
    assert.ok(!(await fixPrompt(root, keptRun, join(root, ".claude", "skills"))).includes(`## skill: ${SKILL}`));
    assert.ok((await fixPrompt(root, seededShare[0]!, join(root, ".claude", "skills"))).includes(`## skill: ${SKILL}`));
    assert.equal(withdrawSkillLifecycleProposal(registry, skillLifecycleProposalId(SKILL)), true);
    assert.deepEqual(offeredRuns(), normal, "withdrawn: the normal share returns");
    assert.ok((await fixPrompt(root, keptRun, join(root, ".claude", "skills"))).includes(`## skill: ${SKILL}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T13860 criterion 7: a skill removed from .claude/skills is never offered and never judged, whatever its old counts", () => {
  const usage = { "retired-skill": { offered: 115, used: 2 }, [SKILL]: { offered: 10, used: 5 } };
  const root = gardenFixture([SKILL], usage, []);
  try {
    assert.deepEqual(skillLifecycleCandidates(usage, [SKILL]).map((a) => a.target), [SKILL]);
    const judged = lifecyclePass(root);
    assert.deepEqual(judged.map(([, row]) => row.skill), [SKILL]);
    for (let i = 0; i < 50; i++) {
      const observed = selectImplementSkills(root, root, { type: "implement" as const, files: [] }, `run-${i}`).observation;
      assert.ok(!observed.approved_eligible_names.includes("retired-skill"));
      assert.ok(!observed.selected_names.includes("retired-skill"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
