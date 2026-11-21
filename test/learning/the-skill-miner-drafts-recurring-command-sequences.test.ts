// W1-T13857: the workshop drafted the signal's outcome text ("Execute every acceptance criterion as a real, observed
// proof") as every draft's one Procedure step. The miner now finds the ordered action commands runs of two or more
// tasks repeat, and the workshop drafts the top one as Run and Change lines.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { loadProposalRegistry } from "#src/lib/inbox.js";
import { appendLedger } from "#src/lib/ledger.js";
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
import { toolStepSignature } from "#src/lib/tool-step-signature.js";
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
  "Bash:git diff", "Bash:git log", "Bash:node", "Write:<outside>", "<outside>"];

const HIGH_SCORE_STEPS = ["Bash:npm run typecheck", "Edit:src/lib/*.ts"];

function competingProcedures() {
  const steps = Array.from({ length: 15 }, (_, i) => `Bash:npm run nuisance-${i}`);
  // 120 runs omit one step each. Every subset of two or more steps that still recurs is closed:
  // adding an omitted step always costs its eight supporting runs.
  const specs = steps.flatMap((_, missing) => Array.from({ length: 8 }, (_, i): [string, string, string[]] =>
    [`R${missing}-${i}`, `W1-T${10 + i}`, steps.filter((_, at) => at !== missing)]));
  return corpus([
    ...specs,
    ["H1", "W1-T1", HIGH_SCORE_STEPS, 1_000_000],
    ["H2", "W1-T2", HIGH_SCORE_STEPS, 1_000_000],
  ]);
}

test("W1-T13857 criterion 2: a command sequence recurring in runs of two tasks is returned, one recurring within one task is not", () => {
  const { runs, records } = corpus([
    ["A1", "W1-T1", ["Bash:npm run comment-load-signal", "Bash:sed", "Bash:npm run typecheck"]],
    ["A2", "W1-T2", ["Bash:npm run comment-load-signal", "Bash:npm run typecheck"]],
    ["A3", "", ["Bash:npm run comment-load-signal", "Bash:npm run typecheck"]],
    ["B1", "W1-T3", ["Bash:npm run lint-plan:fast", "Bash:git push"]],
    ["B2", "W1-T3", ["Bash:npm run lint-plan:fast", "Bash:git push"]],
    ["B3", "", ["Bash:npm run lint-plan:fast", "Bash:git push"]],
  ]);
  const found = mineRecurringProcedures(runs, records);
  assert.deepEqual(found.map((p) => p.steps), [["Bash:npm run comment-load-signal", "Bash:npm run typecheck"]]);
  assert.deepEqual(found[0]!.taskIds, ["W1-T1", "W1-T2"]);
  assert.deepEqual(found[0]!.runIds, ["A1", "A2", "A3"]);
  assert.equal(found[0]!.recurrence, 3);
  // The one-task sequence is held back by the task floor alone.
  const oneTask = mineRecurringProcedures(runs, records, { minTaskIds: 1 }).find((p) => p.steps.includes("Bash:git push"));
  assert.deepEqual(oneTask?.taskIds, ["W1-T3"]);
  assert.deepEqual(oneTask?.runIds, ["B1", "B2", "B3"]);

  const crowded = competingProcedures();
  const complete = mineRecurringProcedures(crowded.runs, crowded.records);
  assert.deepEqual(complete[0]?.steps, HIGH_SCORE_STEPS);
  assert.deepEqual(complete[0]?.runIds, ["H1", "H2"]);
  assert.equal(complete.length, 2 ** 15 - 1 - 15);
});

test("W1-T13857 criterion 3: look steps never appear in a procedure, and runs of only look steps yield none", () => {
  const scriptless = toolStepSignature("Bash", { command: "node --import tsx --test" }, REPO_ROOT);
  const withScript = toolStepSignature("Bash", { command: "node --test test/mine.test.ts" }, REPO_ROOT);
  assert.equal(scriptless, "Bash:node --test");
  assert.equal(withScript, "Bash:node --test test/mine.test.ts");
  const { runs, records } = corpus([
    ["L1", "W1-T1", [scriptless, ...LOOK, withScript, ...LOOK.slice().reverse(), "Bash:git commit"]],
    ["L2", "W1-T2", [scriptless, withScript, ...LOOK, "Bash:git commit"]],
  ]);
  const found = mineRecurringProcedures(runs, records);
  assert.deepEqual(found.map((p) => p.steps), [[withScript, "Bash:git commit"]]);
  const onlyLook = corpus([["O1", "W1-T1", [...LOOK, scriptless]], ["O2", "W1-T2", [...LOOK, scriptless]]]);
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

  const unsupported = corpus([
    ["U1", "W1-T1", ["constructor:foo", "Bash:sed", ...HIGH_SCORE_STEPS]],
    ["U2", "W1-T2", ["constructor:foo", "Bash:sed", ...HIGH_SCORE_STEPS]],
    ["U3", "W1-T3", HIGH_SCORE_STEPS],
  ]);
  assert.equal(mineRecurringProcedures(unsupported.runs, unsupported.records)[0]!.steps[0], "constructor:foo");
  const fallback = renderSkillDraft(candidate(["U1", "U2", "U3"]), unsupported)!;
  const expectedLines = ["- Run `npm run typecheck`.", "- Change `src/lib/*.ts`."];
  assert.deepEqual(procedureLines(fallback.markdown), expectedLines);
  assert.deepEqual(scanSkillDraft(fallback, ALLOWLIST), { ok: true });

  const toolNamePaths = corpus([
    ["M1", "W1-T1", ["Bash:npm run typecheck", "Edit:MultiEdit.md"], 2000],
    ["M2", "W1-T2", ["Bash:npm run typecheck", "Edit:MultiEdit.md"], 2000],
    ["B1", "W1-T1", ["Bash:npm run typecheck", "Edit:Bash.md"], 1000],
    ["B2", "W1-T2", ["Bash:npm run typecheck", "Edit:Bash.md"], 1000],
    ["C1", "W1-T1", ["Bash:npm run typecheck", "Edit:RunCheck.md"], 500],
    ["C2", "W1-T2", ["Bash:npm run typecheck", "Edit:RunCheck.md"], 500],
    ["D1", "W1-T1", HIGH_SCORE_STEPS],
    ["D2", "W1-T2", HIGH_SCORE_STEPS],
  ]);
  assert.deepEqual(mineRecurringProcedures(toolNamePaths.runs, toolNamePaths.records).map((p) => p.steps[1]),
    ["Edit:MultiEdit.md", "Edit:Bash.md", "Edit:RunCheck.md", "Edit:src/lib/*.ts"]);
  const safeFallback = renderSkillDraft(candidate(toolNamePaths.runs.map((run) => run.runId)), toolNamePaths)!;
  assert.deepEqual(procedureLines(safeFallback.markdown), expectedLines);
  assert.deepEqual(scanSkillDraft(safeFallback, ALLOWLIST), { ok: true });
  assert.equal(scanSkillDraft(draftWith(["- Change `MultiEdit.md`."]), ALLOWLIST).reason,
    "names tool 'MultiEdit' outside the worker allowlist");

  const crowded = competingProcedures();
  const top = renderSkillDraft(candidate(crowded.runs.map((run) => run.runId)), crowded)!;
  assert.deepEqual(procedureLines(top.markdown), expectedLines);
  assert.match(top.markdown, /^- Score: 2000000\.$/m);
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
  assert.deepEqual(scanSkillDraft(draftWith(["  + Run ``npm run typecheck``.", "1. Change `src/lib/retro.ts`."]), ALLOWLIST), { ok: true });
  for (const line of [
    "- Verify the result before shipping.", "- Run the type checker before the tests.",
    "* Verify the result.", "  - Verify the result.", "1) Verify the result.", "+ Run `  `.", "- Run `` \t ``.",
    `- ${PROCEDURAL_STEP_TEXT.fully_executed_proof}`,
  ]) {
    const result = scanSkillDraft(draftWith(["- Run `npm run typecheck`.", line]), ALLOWLIST);
    assert.equal(result.ok, false, line);
    assert.equal(result.offendingLine, line);
    assert.match(result.reason ?? "", /^not-an-action/, line);
  }
  const alternativeHeading = draftWith(["* Verify the result."]);
  alternativeHeading.markdown = alternativeHeading.markdown.replace("## Procedure", " ## Procedure ##").replaceAll("\n", "\r\n");
  assert.match(scanSkillDraft(alternativeHeading, ALLOWLIST).reason ?? "", /^not-an-action/);

  const shellExample = ["```sh", "## Evidence", "- an example line", "```"];
  const tildeExample = ["  ~~~~sh", "~~~", "````", "~~~~ trailing info", "## Evidence", " ~~~~~"];
  for (const fence of [shellExample, tildeExample]) {
    assert.deepEqual(scanSkillDraft(draftWith([...fence, "- Run `npm run typecheck`."]), ALLOWLIST), { ok: true });
    for (const line of ["- Verify the result.", `- ${PROCEDURAL_STEP_TEXT.fully_executed_proof}`]) {
      const result = scanSkillDraft(draftWith([...fence, line]), ALLOWLIST);
      assert.equal(result.offendingLine, line);
      assert.match(result.reason ?? "", /^not-an-action/, line);
    }
  }

  const signal = `- ${PROCEDURAL_STEP_TEXT.fully_executed_proof}`;
  for (const markdown of [
    draftWith([signal]).markdown.replace("## Procedure", "Procedure\n---------"),
    draftWith([signal]).markdown.replace("## Procedure", "Procedure\n========="),
    draftWith(["<!--\n## Evidence\n```sh\n-->", signal]).markdown,
  ]) {
    const result = scanSkillDraft({ ...draftWith([]), markdown }, ALLOWLIST);
    assert.equal(result.offendingLine, signal);
    assert.match(result.reason ?? "", /^not-an-action/);
  }
  const headings = draftWith(["<!--\n- an example line\n-->", "- Run `npm run typecheck`.", "", "- - -"]);
  headings.markdown = headings.markdown.replace("## Procedure", "Procedure\n=========").replace("## Evidence", "Evidence\n--------");
  assert.deepEqual(scanSkillDraft(headings, ALLOWLIST), { ok: true });
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
  const run = (runId: string, taskId: string, day: number, signatures: string[]): Row[] => {
    const ts = (s: number) => `2026-11-0${day}T00:00:0${s}.000Z`;
    const at = (s: number, row: Row): Row => ({ ts: ts(s), task_id: taskId, ...row });
    return [
      { ts: ts(0), run_id: runId, task_id: taskId, step: "run.start", type: "implement" },
      ...signatures.map((signature, index) => at(index + 1, toolRow(runId, signature))),
      { ts: ts(4), run_id: runId, task_id: taskId, step: "review.posted", proof_exec: ["executed_pass", "executed_pass"] },
      { ts: ts(5), run_id: runId, task_id: taskId, step: "verdict", verdict: "merged" },
    ];
  };
  const commands = ["Bash:npm run comment-load-signal", "Read:src/lib/retro.ts", "Bash:npm run typecheck"];
  const ledger = writeLedger([...run("P1", "W1-T4800", 1, commands), ...run("P2", "W1-T4801", 2, commands)], { scope: t });
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

  const noProcedure = writeLedger([
    ...run("P3", "W1-T4802", 3, ["Read:src/lib/retro.ts"]),
    ...run("P4", "W1-T4803", 4, ["Bash:git status"]),
  ], { scope: t, rotations: [{
    at: "2026-11-01T12:00:00.000Z", gz: true, rows: [
      { ts: "2026-11-01T00:00:00.000Z", step: "ratify.approved", task_id: skillDraftProposalId("approved") },
      { ts: "2026-11-01T00:00:01.000Z", step: "panel.proposal_declined", task_id: skillDraftProposalId("declined") },
    ],
  }] });
  const legacyGather = buildGather({ ledgerNdjson: readFileSync(noProcedure.path, "utf8"), learningsMd: "" });
  assert.ok(legacyGather.proceduralCandidates.some((c) => c.signals.includes("fully_executed_proof")));
  assert.deepEqual(legacyGather.skillDrafts, []);
  const legacyId = "skill-draft:88d9945faf4c75d3";
  const legacyRegistry = join(noProcedure.dir, "proposals.json");
  const legacy = draftWith([`- ${PROCEDURAL_STEP_TEXT.fully_executed_proof}`]);
  const entries = [legacyId, skillDraftProposalId("approved"), skillDraftProposalId("declined")].map((id) => ({
    id, summary: legacy.markdown, evidenceAnchors: [], skillFile: { name: legacy.name, markdown: legacy.markdown },
    skillFileStagedAt: "2026-10-14T00:00:00.000Z",
  }));
  writeFileSync(legacyRegistry, JSON.stringify({ proposals: entries }));
  const events: Array<{ step: string } & Row> = [];
  const stage = () => stageSkillDrafts(legacyRegistry, legacyGather.skillDrafts, ALLOWLIST, describeSkillInjectionReachability,
    (step, extra, expectedLiveVersion) => {
      events.push({ step, ...extra });
      appendLedger(noProcedure.path, { run_id: "RETRO-1", task_id: "RETRO", step, ...extra }, { expectedLiveVersion });
    });
  stage();
  assert.deepEqual(events.map((event) => event.step), ["panel.proposal_declined", "skill.staged"]);
  assert.equal(events[0]?.task_id, legacyId);
  assert.equal(events[0]?.origin, "skill-workshop");
  assert.match(String(events[0]?.reason), /^withdrawn: outcome-only:/);
  assert.deepEqual(loadProposalRegistry(legacyRegistry).map((p) => [p.id, p.skillDraftClose?.reason]), [
    [legacyId, events[0]?.reason], [skillDraftProposalId("approved"), undefined], [skillDraftProposalId("declined"), undefined],
  ]);
  noProcedure.append([{ step: "panel.proposal_restored", task_id: legacyId }]);
  stage();
  assert.equal(events.length, 2, "an operator restore of the same text survives the next pass");
  assert.equal(existsSync(join(noProcedure.dir, ".claude", "skills")), false);
});
