import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFixRung } from "./helpers/run-task-test.js";
import type { Config } from "../src/lib/config.js";
import { renderFixPrompt, type FixEvidence } from "../src/lib/prompt-render.js";
import type { CriterionVerdict } from "../src/lib/review.js";
import {
  buildSkillEffectivenessReport,
  renderSkillsPart,
  SKILL_EFFECTIVENESS_TASK_TYPE,
  skillWithheldForRun,
} from "../src/lib/skill-workshop.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { WorkerResult } from "../src/lib/worker.js";

// The fix lane (review findings, CI failures) used to receive no skills at all. A skill declaring
// `applies-to: fix` is now eligible there, withheld on the same seeded share of runs as the implement
// lane, and its `skills.selection` row carries `task_type: "fix"` so the report can read that lane alone.

const FIX_SKILL = "answer-findings";
const FIX_SKILL_BODY = "Restate each finding in your own words before you touch the code.";
const NOT_WITHHELD_RUN = "fix-run-0";
const WITHHELD_RUN = "fix-run-1";

const criteria: CriterionVerdict[] = [
  { claim: "wire producer", proof: "unit test: wires it", met: false, reason: "consumer disconnected", proof_exec: "executed_fail" },
];
const task = { id: "W1-T9001", title: "wire the producer", files: ["src/changed.ts"], acceptance: criteria };
const mount = { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 };

const skillTree = (skills: Array<{ name: string; appliesTo: string; body: string }>): string => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-skills-`));
  for (const s of skills) {
    mkdirSync(join(dir, s.name), { recursive: true });
    writeFileSync(join(dir, s.name, "SKILL.md"), `---\nname: ${s.name}\napplies-to: ${s.appliesTo}\n---\n\n${s.body}\n`);
  }
  return dir;
};

type Row = Record<string, unknown> & { step: string };

/** One fix round on a blocked review; returns the prompt the worker was spawned with and every ledger row. */
async function fixRound(runId: string, approvedSkillsDir?: string): Promise<{ prompt: string; rows: Row[] }> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-skills-run-`));
  const initialReview = {
    state: "failure" as const, criteria, testTheater: false, summary: "one visible gap",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    headSha: "a".repeat(40), reviewerOutcome: "success",
  };
  const prompts: string[] = [];
  const rows: Row[] = [];
  try {
    await runFixRung({
      task, taskId: task.id, runId, prUrl: "https://github.com/acme/remudero/pull/1",
      branch: "run-W1-T9001-1791151948510", worktreePath: root, initialSessionId: "", initialReview,
      mount, settingsFile: join(root, "settings.json"), config: {} as Config, budgetUsd: 1, strikeCap: 1,
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
      deps: {
        ...(approvedSkillsDir === undefined ? {} : { approvedSkillsDir }),
        ledgerLines: () => [], ledgerPath: join(root, "ledger.ndjson"),
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
        push: () => {}, fetchPrBody: async () => "implemented", fetchPrDiffFiles: async () => task.files,
        issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} },
        log: (step, extra) => rows.push({ ...extra, step }), say: () => {}, account: (worker) => worker,
      },
    });
    assert.equal(prompts.length, 1, "the fixture dispatches exactly one fix worker");
    return { prompt: prompts[0]!, rows };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const selectionRows = (rows: Row[]): Row[] => rows.filter((row) => row.step === "skills.selection");

test("a fix-eligible skill reaches the fix prompt on a run that does not withhold it", async () => {
  assert.equal(skillWithheldForRun(NOT_WITHHELD_RUN, FIX_SKILL), false, "precondition: this run's draw keeps the skill");
  const dir = skillTree([
    { name: FIX_SKILL, appliesTo: "implement, fix", body: FIX_SKILL_BODY },
    { name: "implement-only", appliesTo: "implement", body: "An implement-only procedure." },
  ]);
  try {
    const { prompt, rows } = await fixRound(NOT_WITHHELD_RUN, dir);
    assert.ok(prompt.includes(`## skill: ${FIX_SKILL}\n\n${FIX_SKILL_BODY}`), "the selected skill is rendered by renderSkillsPart");
    assert.ok(!prompt.includes("An implement-only procedure."), "an implement-only skill never reaches a fix round");
    assert.ok(prompt.indexOf(FIX_SKILL_BODY) < prompt.indexOf("The review gate is FAILING"), "the skill precedes the evidence");
    const selection = selectionRows(rows);
    assert.equal(selection.length, 1, "one selection row per fix rung");
    assert.equal(selection[0]!.task_type, "fix");
    assert.deepEqual(selection[0]!.approved_eligible_names, [FIX_SKILL]);
    assert.deepEqual(selection[0]!.selected_names, [FIX_SKILL]);
    assert.deepEqual(selection[0]!.withheld_names, []);
    assert.equal(selection[0]!.zero_selection, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fix-eligible skill is absent from the fix prompt on a run that withholds it, and the row names it", async () => {
  assert.equal(skillWithheldForRun(WITHHELD_RUN, FIX_SKILL), true, "precondition: this run's draw withholds the skill");
  const dir = skillTree([{ name: FIX_SKILL, appliesTo: "fix", body: FIX_SKILL_BODY }]);
  try {
    const { prompt, rows } = await fixRound(WITHHELD_RUN, dir);
    assert.ok(!prompt.includes(FIX_SKILL_BODY));
    assert.ok(!prompt.includes("## skill:"));
    const selection = selectionRows(rows);
    assert.equal(selection.length, 1);
    assert.equal(selection[0]!.task_type, "fix");
    assert.deepEqual(selection[0]!.approved_eligible_names, [FIX_SKILL]);
    assert.deepEqual(selection[0]!.selected_names, []);
    assert.deepEqual(selection[0]!.withheld_names, [FIX_SKILL]);
    assert.equal(selection[0]!.zero_selection, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with no fix-eligible skill the fix prompt is byte-identical and the selection row records zero", async () => {
  // Today's approved tree holds implement-only skills; compare one such tree with a tree holding nothing.
  const implementOnly = skillTree([{ name: "implement-only", appliesTo: "implement", body: "An implement-only procedure." }]);
  const empty = skillTree([]);
  try {
    const { prompt: onImplementOnly, rows } = await fixRound(NOT_WITHHELD_RUN, implementOnly);
    const { prompt: onEmptyTree } = await fixRound(NOT_WITHHELD_RUN, empty);
    assert.equal(onImplementOnly, onEmptyTree);
    assert.ok(!onImplementOnly.includes("## skill:"));
    const selection = selectionRows(rows);
    assert.equal(selection.length, 1, "the zero selection is still recorded");
    assert.equal(selection[0]!.task_type, "fix");
    assert.deepEqual(selection[0]!.approved_eligible_names, []);
    assert.deepEqual(selection[0]!.selected_names, []);
    assert.equal(selection[0]!.zero_selection, true);
  } finally {
    rmSync(implementOnly, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test("an empty skills part leaves every fix prompt mode byte-identical to a render without one", () => {
  const unmet = [{ ...criteria[0]!, criterionIndex: 1 }];
  const evidences: Array<[string, FixEvidence]> = [
    ["reviewer-unmet", { review: { unmetCriteria: unmet, summary: "gap" } }],
    ["body-coverage", { review: { unmetCriteria: [{ ...unmet[0]!, proof_exec: "not_executable",
      reason: "matched 0/2 proof keywords" }], summary: "gap" } }],
    ["ci-log", { ciFailures: [{ name: "test", logTail: "not ok 1" }] }],
    ["merge-conflict", { mergeConflict: { files: [], oursLog: "", theirsLog: "" } }],
    ["gate-fix", { actionableGateFailures: [{ reason: "rename the file" }] }],
    ["proof-discrimination", { proofDiscrimination: { proofs: [{ claim: "c", proof: "unit test: t", proofExec: "not_executable" }] } }],
    ["plan-gate", { planGateFindings: [{ check: "lint-plan", firstLine: "bad" }] }],
  ];
  // An untrusted-data envelope draws a fresh random boundary per render; every other byte must match.
  const render = (opts: Parameters<typeof renderFixPrompt>[0]) =>
    renderFixPrompt(opts).replace(/boundary="[^"]*"/g, 'boundary="B"');
  for (const [mode, evidence] of evidences) {
    const base = { task, round: 1, branch: "run-W1-T9001-1791151948510", evidence };
    const without = render(base);
    assert.ok(without.includes(`MODE: ${mode}.`), `fixture derives ${mode}`);
    assert.equal(render({ ...base, skillsPart: renderSkillsPart([]) }), without, mode);
    assert.equal(render({ ...base, skillsPart: "" }), without, mode);
  }
});

const selectionRow = (runId: string, taskType: string, withheld: boolean) => ({
  run_id: runId, step: "skills.selection", task_type: taskType,
  approved_eligible_names: ["proc"], path_filtered_names: [],
  selected_names: withheld ? [] : ["proc"], budget_omitted_names: [], budget_chars: 100,
  zero_selection: withheld, withheld_names: withheld ? ["proc"] : [],
});
const verdict = (runId: string, v: string) => ({ run_id: runId, step: "verdict", verdict: v });
const implementRows = [
  selectionRow("impl-treated", "implement", false), verdict("impl-treated", "merged"),
  selectionRow("impl-withheld", "implement", true), verdict("impl-withheld", "blocked_ci"),
];
const fixRows = [
  selectionRow("fix-treated-1", "fix", false), verdict("fix-treated-1", "failed"),
  selectionRow("fix-treated-2", "fix", false), verdict("fix-treated-2", "merged"),
  selectionRow("fix-withheld", "fix", true), verdict("fix-withheld", "merged"),
];

test("a fix-lane skill report builds its cohorts from fix rows only", () => {
  const report = buildSkillEffectivenessReport([...implementRows, ...fixRows], "proc", "fix");
  assert.equal(report.task_type, "fix");
  assert.equal(report.assignment, "randomized");
  assert.equal(report.selected.observed_eligible_runs, 2);
  assert.deepEqual(report.selected.outcomes, { failed: 1, merged: 1 });
  assert.equal(report.selected.harmful_terminal_runs, 1);
  assert.equal(report.control.observed_eligible_runs, 1);
  assert.deepEqual(report.control.outcomes, { merged: 1 });
});

test("an implement-lane skill report ignores fix rows and keeps its default task type", () => {
  const mixed = buildSkillEffectivenessReport([...implementRows, ...fixRows], "proc");
  assert.equal(SKILL_EFFECTIVENESS_TASK_TYPE, "implement");
  assert.deepEqual(mixed, buildSkillEffectivenessReport(implementRows, "proc"));
  assert.deepEqual(mixed, buildSkillEffectivenessReport(implementRows, "proc", "implement"));
  assert.equal(mixed.task_type, "implement");
  assert.deepEqual(mixed.selected.outcomes, { merged: 1 });
  assert.deepEqual(mixed.control.outcomes, { blocked_ci: 1 });
});
