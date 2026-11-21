// W1-T13857: the workshop drafted the signal's outcome text ("Execute every acceptance criterion as a real, observed
// proof") as every draft's one Procedure step. The miner now finds the ordered action commands runs of two or more
// tasks repeat, and the workshop drafts the top one as Run and Change lines.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { loadProposalRegistry } from "#src/lib/inbox.js";
import { buildGather } from "#src/lib/retro.js";
import {
  PROCEDURAL_STEP_TEXT,
  describeSkillInjectionReachability,
  renderSkillDraft,
  scanSkillDraft,
  skillDraftProposalId,
  stageSkillDrafts,
  workerAllowlistFromSettings,
  type ProceduralCandidateLike,
  type SkillDraft,
} from "#src/lib/skill-workshop.js";
import { mineRecurringProcedures, type TranscriptRun } from "#src/lib/workflow-mining.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = Record<string, unknown>;

function toolRow(runId: string, signature: string): Row {
  const colon = signature.indexOf(":");
  return {
    run_id: runId,
    step: "worker.activity",
    event_kind: "tool-executing",
    tool_name: colon < 0 ? signature : signature.slice(0, colon),
    ...(colon < 0 ? {} : { tool_signature: signature }),
  };
}

/** Each run as `[runId, taskId, signatures, outputTokens?]`. */
function corpus(specs: Array<[string, string, string[], number?]>): { runs: TranscriptRun[]; records: Row[] } {
  return {
    runs: specs.map(([runId, taskId, , outputTokens]) => ({
      runId, taskId, type: "implement", verdict: "merged", ...(outputTokens === undefined ? {} : { outputTokens }),
    })),
    records: specs.flatMap(([runId, , signatures]) => signatures.map((signature) => toolRow(runId, signature))),
  };
}

const procedureLines = (markdown: string): string[] =>
  (/^## Procedure\n([\s\S]*?)^## /m.exec(markdown)?.[1] ?? "").split("\n").filter((line) => line.startsWith("- "));

const ALLOWLIST = workerAllowlistFromSettings(JSON.parse(readFileSync(join(REPO_ROOT, "settings", "worker.json"), "utf8")));

const LOOK = ["Read:src/lib/review.ts", "Grep:src", "Glob", "Bash:sed", "Bash:grep", "Bash:cat", "Bash:rg", "Bash:git status",
  "Bash:git diff", "Bash:git log", "Bash:node", "Write:<outside>"];

test("W1-T13857 criterion 2: a command sequence recurring in runs of two tasks is returned, one recurring within one task is not", () => {
  const { runs, records } = corpus([
    ["A1", "W1-T1", ["Bash:npm run comment-load-signal", "Bash:sed", "Bash:npm run typecheck"]],
    ["A2", "W1-T2", ["Bash:npm run comment-load-signal", "Bash:npm run typecheck"]],
    ["B1", "W1-T3", ["Bash:npm run lint-plan:fast", "Bash:git push"]],
    ["B2", "W1-T3", ["Bash:npm run lint-plan:fast", "Bash:git push"]],
  ]);
  const found = mineRecurringProcedures(runs, records);
  assert.deepEqual(found.map((p) => p.steps), [["Bash:npm run comment-load-signal", "Bash:npm run typecheck"]]);
  assert.deepEqual(found[0]!.taskIds, ["W1-T1", "W1-T2"]);
  assert.deepEqual(found[0]!.runIds, ["A1", "A2"]);
  assert.equal(found[0]!.recurrence, 2);
  // The one-task sequence is held back by the task floor alone.
  assert.ok(mineRecurringProcedures(runs, records, { minTaskIds: 1 }).some((p) => p.steps.includes("Bash:git push")));
});

test("W1-T13857 criterion 3: look steps never appear in a procedure, and runs of only look steps yield none", () => {
  const { runs, records } = corpus([
    ["L1", "W1-T1", [...LOOK, "Bash:npm run typecheck", ...LOOK.slice().reverse(), "Bash:git commit"]],
    ["L2", "W1-T2", ["Bash:npm run typecheck", ...LOOK, "Bash:git commit"]],
  ]);
  const found = mineRecurringProcedures(runs, records);
  assert.deepEqual(found.map((p) => p.steps), [["Bash:npm run typecheck", "Bash:git commit"]]);
  const onlyLook = corpus([["O1", "W1-T1", LOOK], ["O2", "W1-T2", LOOK]]);
  assert.equal(mineRecurringProcedures(onlyLook.runs, onlyLook.records).length, 0);
});

test("W1-T13857 criterion 4: procedures sort by recurrence times median span times median tokens per call", () => {
  const { runs, records } = corpus([
    ["X1", "W1-T1", ["Bash:npm run typecheck", "Bash:git commit"], 40],
    ["X2", "W1-T2", ["Bash:npm run typecheck", "Bash:git commit"], 40],
    ["X3", "W1-T3", ["Bash:npm run typecheck", "Bash:git commit"], 40],
    ["Y1", "W1-T4", ["Bash:npm run lint-plan:fast", "Bash:git push"], 40],
    ["Y2", "W1-T5", ["Bash:npm run lint-plan:fast", "Bash:git push"], 40],
  ]);
  const found = mineRecurringProcedures(runs, records);
  assert.deepEqual(found.map((p) => [p.steps[0], p.recurrence, p.medianSpannedCalls, p.medianOutputTokensPerCall, p.estimatedTokensPerRun, p.score]), [
    ["Bash:npm run typecheck", 3, 2, 20, 40, 120],
    ["Bash:npm run lint-plan:fast", 2, 2, 20, 40, 80],
  ]);
  // A wider span counts every tool call between the first and last step, look steps included.
  const wide = corpus([
    ["W1", "W1-T1", ["Bash:npm run typecheck", "Bash:sed", "Bash:grep", "Bash:git commit"]],
    ["W2", "W1-T2", ["Bash:npm run typecheck", "Bash:sed", "Bash:grep", "Bash:git commit"]],
  ]);
  const [only] = mineRecurringProcedures(wide.runs, wide.records);
  assert.deepEqual([only!.medianSpannedCalls, only!.medianOutputTokensPerCall, only!.estimatedTokensPerRun, only!.score], [4, null, null, 8]);
});

function candidate(runIds: string[]): ProceduralCandidateLike {
  return { shapeKey: "implement:fully_executed_proof", taskType: "implement", signals: ["fully_executed_proof"], runIds, taskIds: ["W1-T1", "W1-T2"], supportingRuns: runIds.length };
}

test("W1-T13857 criterion 5: the top procedure is drafted as Run and Change lines naming no tool, and none recurring drafts nothing", () => {
  const transcripts = corpus([
    // The highest-scored procedure starts with a bare tool name the renderer cannot write, so the next one is drafted.
    ["R1", "W1-T1", ["TodoWrite", "Bash:sed", "Bash:npm run comment-load-signal", "Edit:src/lib/review.ts"]],
    ["R2", "W1-T2", ["TodoWrite", "Bash:sed", "Bash:npm run comment-load-signal", "Edit:src/lib/retro.ts"]],
    ["R3", "W1-T3", ["Bash:npm run comment-load-signal", "Edit:src/lib/plan.ts"]],
  ]);
  assert.deepEqual(mineRecurringProcedures(transcripts.runs, transcripts.records)[0]!.steps[0], "TodoWrite");
  const draft = renderSkillDraft(candidate(["R1", "R2", "R3"]), transcripts)!;
  assert.deepEqual(procedureLines(draft.markdown), ["- Run `npm run comment-load-signal`.", "- Change `src/lib/*.ts`."]);
  assert.doesNotMatch(draft.markdown, /\b(Bash|Edit|Write|Read|TodoWrite)\b/);
  assert.ok(!draft.markdown.includes(PROCEDURAL_STEP_TEXT.fully_executed_proof));
  assert.match(draft.name, /^npm-run-comment-load-signal-src-lib-ts-[0-9a-f]{8}$/);
  assert.match(draft.markdown, /^- Recurs in 3 runs of 3 tasks: W1-T1, W1-T2, W1-T3\.$/m);
  assert.match(draft.markdown, /^- tokens: not measured$/m);
  assert.deepEqual(scanSkillDraft(draft, ALLOWLIST), { ok: true });
  // A candidate whose runs repeat nothing, or repeat only look steps, gets no draft.
  const none = corpus([["N1", "W1-T1", ["Bash:npm run typecheck", "Bash:sed"]], ["N2", "W1-T2", ["Bash:git commit", "Bash:sed"]]]);
  assert.equal(renderSkillDraft(candidate(["N1", "N2"]), none), undefined);
  // Only the candidate's own runs count: R3 alone holds the sequence once.
  assert.equal(renderSkillDraft(candidate(["R3", "N1"]), { runs: [...transcripts.runs, ...none.runs], records: [...transcripts.records, ...none.records] }), undefined);
});

function draftWith(steps: string[]): SkillDraft {
  return {
    name: "probe",
    description: "d",
    markdown: `---\nname: probe\ndescription: d\napplies-to: implement\n---\n\n## Procedure\n\n${steps.join("\n")}\n\n## Evidence\n\n- [src: run#R1]\n`,
    candidateHash: "h",
    procedureKey: "k",
    supportingRuns: 2,
    outcomeDescriptions: ["Every acceptance criterion has an observed executed proof, without keyword-floor degradation."],
  };
}

test("W1-T13857 criterion 6: scanSkillDraft refuses a Procedure step with no action verb or no backticked command, and the signal line", () => {
  assert.deepEqual(scanSkillDraft(draftWith(["- Run `npm run typecheck`."]), ALLOWLIST), { ok: true });
  for (const line of ["- Verify the result before shipping.", "- Run the type checker before the tests.", `- ${PROCEDURAL_STEP_TEXT.fully_executed_proof}`]) {
    const result = scanSkillDraft(draftWith(["- Run `npm run typecheck`.", line]), ALLOWLIST);
    assert.equal(result.ok, false, line);
    assert.equal(result.offendingLine, line);
    assert.match(result.reason ?? "", /^not-an-action/, line);
  }
});

test("W1-T13857 criterion 7: the three recurring-procedure fixtures pass scanSkillDraft", () => {
  for (const name of ["census-pass-before-commit", "plan-amendment-filing", "coverage-shard-fix"]) {
    const markdown = readFileSync(join(REPO_ROOT, "test", "fixtures", "recurring-procedure-skills", `${name}.md`), "utf8");
    const description = /^description: (.*)$/m.exec(markdown)![1]!;
    assert.match(markdown, new RegExp(`^name: ${name}$`, "m"));
    assert.ok(procedureLines(markdown).length >= 5, name);
    const draft: SkillDraft = { name, description, markdown, candidateHash: name, procedureKey: name, supportingRuns: 2 };
    assert.deepEqual(scanSkillDraft(draft, ALLOWLIST), { ok: true }, name);
  }
});

test("W1-T13857 criterion 8: the retro drafts the recurring census commands in order and stages them only as a proposal", (t) => {
  const run = (runId: string, taskId: string, day: number): Row[] => {
    const ts = (s: number) => `2026-11-0${day}T00:00:0${s}.000Z`;
    const at = (s: number, row: Row): Row => ({ ts: ts(s), task_id: taskId, ...row });
    return [
      { ts: ts(0), run_id: runId, task_id: taskId, step: "run.start", type: "implement" },
      at(1, toolRow(runId, "Bash:npm run comment-load-signal")),
      at(2, toolRow(runId, "Read:src/lib/retro.ts")),
      at(3, toolRow(runId, "Bash:npm run typecheck")),
      { ts: ts(4), run_id: runId, task_id: taskId, step: "review.posted", proof_exec: ["executed_pass", "executed_pass"] },
      { ts: ts(5), run_id: runId, task_id: taskId, step: "verdict", verdict: "merged" },
    ];
  };
  const ledger = writeLedger([...run("P1", "W1-T4800", 1), ...run("P2", "W1-T4801", 2)], { scope: t });
  const gather = buildGather({ ledgerNdjson: readFileSync(ledger.path, "utf8"), learningsMd: "" });
  assert.equal(gather.skillDrafts.length, 1);
  const draft = gather.skillDrafts[0]!;
  assert.deepEqual(procedureLines(draft.markdown), ["- Run `npm run comment-load-signal`.", "- Run `npm run typecheck`."]);

  const dir = ownedFixtureDir(t, "skill-miner-stage").dir;
  const registryPath = join(dir, "proposals.json");
  const rows: string[] = [];
  stageSkillDrafts(registryPath, gather.skillDrafts, ALLOWLIST, describeSkillInjectionReachability, (step) => rows.push(step));
  assert.deepEqual(rows, ["skill.staged"]);
  const proposals = loadProposalRegistry(registryPath);
  assert.deepEqual(proposals.map((p) => p.id), [skillDraftProposalId(draft.procedureKey)]);
  assert.equal(proposals[0]!.skillFile?.markdown, draft.markdown);
  assert.equal(existsSync(join(dir, ".claude", "skills")), false);
  assert.equal(existsSync(join(REPO_ROOT, ".claude", "skills", draft.name)), false);
});
