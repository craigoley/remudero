import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS } from "../src/lib/learnings.js";
import {
  buildSkillEffectivenessReport,
  observeSkillSelection,
  renderSkillEffectivenessReport,
  SKILL_APPLIES_TO_RE,
  loadInjectableSkills,
  renderSkillsPart,
  selectSkillsForTask,
  skillsInjectedEvent,
  stageSkillDraft,
  stageSkillDrafts,
  workerAllowlistFromSettings,
  describeWorkerSkillReachability,
  type InjectableSkill,
  type SkillDraft,
  type StageSkillDraftResult,
  type WorkerAllowlist,
} from "../src/lib/skill-workshop.js";
import { implementPromptParts, renderImplementPrompt, renderImplementPromptWithParts } from "../src/lib/prompt-render.js";
import { buildPromptManifest } from "../src/lib/prompt-manifest.js";
import { runTask, skillCommand, skillEffectivenessCommand } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { Task } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { gitRepo } from "./helpers/git-repo.js";
import { ghShim } from "./helpers/gh-shim.js";

// W1-T3101 — `stageSkillDraft` had ZERO production callers and `skill.staged` fired ZERO times in
// three days of ledger, so a drafted skill reached no worker by any path. `spawnWorker` passes
// `settingSources: []`, so `~/.claude` is not a route and this does not make it one.

const skillTree = (skills: Array<{ name: string; front: string; body: string }>): string => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}skills-`));
  for (const s of skills) {
    mkdirSync(join(dir, s.name), { recursive: true });
    writeFileSync(join(dir, s.name, "SKILL.md"), `---\nname: ${s.name}\n${s.front}\n---\n\n${s.body}\n`);
  }
  return dir;
};

const task = (over: Partial<Task> = {}): Task =>
  ({ id: "W1-T1", title: "t", type: "implement", ...over }) as unknown as Task;

// ── the opt-in ────────────────────────────────────────────────────────────────────────────────

test("W1-T3101: only a skill declaring applies-to is injectable — the generated macro tree is excluded", () => {
  const dir = skillTree([
    { name: "tddr", front: "disable-model-invocation: true", body: "macro text" },
    { name: "proc", front: "applies-to: implement", body: "procedure text" },
  ]);
  const loaded = loadInjectableSkills(dir);
  assert.deepEqual(loaded.map((s) => s.name), ["proc"], "tddr/grfp are for a human at a terminal");
  // EXCLUDED BY CONSTRUCTION, not by an allowlist naming them — so the macro tree stays excluded
  // as it grows. Injecting it would spend the knowledge budget on text no worker asked for.
  assert.equal(loaded.some((s) => s.name === "tddr"), false);
});

test("W1-T3101: the applies-to matcher drives both arms", () => {
  assert.equal(SKILL_APPLIES_TO_RE.test("applies-to: implement, diagnose"), true);
  assert.equal(SKILL_APPLIES_TO_RE.test("disable-model-invocation: true"), false);
  assert.equal(SKILL_APPLIES_TO_RE.test("name: tddr"), false);
});

test("W1-T3101: an absent tree, a dir with no SKILL.md, and no frontmatter all read as zero, never an error", () => {
  assert.deepEqual(loadInjectableSkills("/no/such/dir/at/all"), []);
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}empty-`));
  mkdirSync(join(dir, "orphan"), { recursive: true });
  assert.deepEqual(loadInjectableSkills(dir), []);
  const noFront = skillTree([]);
  mkdirSync(join(noFront, "bare"), { recursive: true });
  writeFileSync(join(noFront, "bare", "SKILL.md"), "just a body, no frontmatter\n");
  assert.deepEqual(loadInjectableSkills(noFront), []);
});

// ── selection by class, under the existing budget ─────────────────────────────────────────────

test("W1-T3101: a skill matching the task class is selected; one for another class is not", () => {
  const skills = loadInjectableSkills(skillTree([
    { name: "impl", front: "applies-to: implement", body: "for implement" },
    { name: "diag", front: "applies-to: diagnose", body: "for diagnose" },
  ]));
  assert.deepEqual(selectSkillsForTask(skills, "implement", 10_000).map((s) => s.name), ["impl"]);
  assert.deepEqual(selectSkillsForTask(skills, "diagnose", 10_000).map((s) => s.name), ["diag"]);
  assert.deepEqual(selectSkillsForTask(skills, "review", 10_000), [], "an unmatched class selects nothing");
});

test("W1-T3101: selection spends the EXISTING knowledge budget, and an over-budget skill is DROPPED not truncated", () => {
  const big = "x".repeat(DEFAULT_KNOWLEDGE_BUDGET_CHARS + 1);
  const skills = loadInjectableSkills(skillTree([{ name: "huge", front: "applies-to: implement", body: big }]));
  assert.deepEqual(selectSkillsForTask(skills, "implement", DEFAULT_KNOWLEDGE_BUDGET_CHARS), [],
    "half a procedure is worse than none");
  // ...and the budget is a real bound, not decoration: two that fit individually but not together.
  const half = "y".repeat(600);
  const two = loadInjectableSkills(skillTree([
    { name: "a", front: "applies-to: implement", body: half },
    { name: "b", front: "applies-to: implement", body: half },
  ]));
  assert.deepEqual(selectSkillsForTask(two, "implement", 1000).map((s) => s.name), ["a"]);
  assert.equal(selectSkillsForTask(two, "implement", 2000).length, 2, "the POSITIVE control: both fit at a larger budget");
});

// ── it reaches the prompt ─────────────────────────────────────────────────────────────────────

test("W1-T3101: a selected skill appears in the rendered implement prompt's CONTEXT block", () => {
  const skills = loadInjectableSkills(skillTree([{ name: "proc", front: "applies-to: implement", body: "STEP ONE: read the ledger" }]));
  const part = renderSkillsPart(selectSkillsForTask(skills, "implement", 10_000));
  assert.match(part, /## skill: proc/);
  const prompt = renderImplementPrompt(task(), "recon", "RUN-1", "", "", "", part);
  assert.match(prompt, /STEP ONE: read the ledger/, "it reached the worker's text");
  // INSIDE # CONTEXT, not after # TASK — provenance and budget both belong to the context block.
  const ctx = prompt.slice(prompt.indexOf("# CONTEXT"), prompt.indexOf("# TASK"));
  assert.match(ctx, /STEP ONE: read the ledger/);
});

test("W1-T3101: with no applicable skill the prompt is BYTE-IDENTICAL to today's", () => {
  // The whole tree is opt-in, so this is the state of every task until an operator approves one.
  const before = renderImplementPrompt(task(), "recon", "RUN-1", "learnings", "notes", "headlines");
  const after = renderImplementPrompt(task(), "recon", "RUN-1", "learnings", "notes", "headlines", "");
  assert.equal(after, before, "an empty skills part must add nothing, not an empty section");
});

test("W1-T3101: the skills part is a named member of implementPromptParts, so the manifest fingerprints it", () => {
  // implementPromptParts is the ONE derivation shared with the W1-T2297 prompt.manifest call site;
  // a part assembled separately could drift from what the worker received.
  const parts = implementPromptParts(task(), "recon", "RUN-1", "", "", "", "SKILLTEXT");
  const skills = parts.find((p) => p.name === "skills");
  assert.equal(skills?.value, "SKILLTEXT");
  assert.ok(parts.findIndex((p) => p.name === "skills") > parts.findIndex((p) => p.name === "matched_learnings"),
    "beside the learnings it shares a budget with");
});

test("the manifest parts come from the SAME render as the worker's prompt, so an injected skill cannot read present:false", () => {
  // THE DEFECT THIS PINS: runTask rendered the prompt with `skillsPart` and then derived the
  // ledgered manifest from a SECOND `implementPromptParts` call that omitted it, so a skill the
  // worker genuinely received was ledgered `present: false`. Both argument lists end in optional
  // parameters, so nothing caught it.
  //
  // It is pinned on BEHAVIOUR, not on the text of the call site. An earlier version of this test
  // asserted a regex against src/run-task.ts; that is the read `source-text-assertion-census`
  // (W1-T2905) refuses, and rightly — it passes when the prose is right rather than when the
  // wiring is, and it goes stale the moment the call is reformatted.
  const { prompt, parts } = renderImplementPromptWithParts(
    task(), "recon", "RUN-1", "", "", "", "SKILLTEXT",
  );
  const manifest = buildPromptManifest(parts);
  const skills = manifest.find((m) => m.name === "skills");
  assert.ok(skills?.present, "the skills part must be present in the manifest the ledger records");

  // AND the parts must be the ones the prompt was actually built from — a manifest derived from a
  // separately-computed array is exactly what broke, so returning any other array must fail here.
  assert.ok(prompt.includes("SKILLTEXT"), "the worker's prompt must carry the skill's bytes");
  for (const part of parts) {
    if (!part.value) continue;
    assert.ok(prompt.includes(part.value),
      `manifest part "${part.name}" is not in the prompt it claims to describe`);
  }
});

test("renderImplementPrompt is the same render with its parts dropped, never a second one", () => {
  // The thin wrapper is the whole reason the two can no longer disagree; if it ever grows its own
  // derivation, this fails.
  const args = [task(), "recon", "RUN-1", "learnings", "notes", "headlines", "SKILLTEXT"] as const;
  assert.equal(renderImplementPrompt(...args), renderImplementPromptWithParts(...args).prompt);
});

// ── staging writes a proposal, never a skill ──────────────────────────────────────────────────

test("W1-T3101: staging writes a PROPOSAL — approval, not staging, is what makes a skill injectable", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}stage-`));
  const registry = join(dir, "inbox-proposals.json");
  const draft = { name: "proc", description: "d", markdown: "# proc\n\nbody", candidateHash: "h1", procedureKey: "proc-h1", supportingRuns: 2 };
  const r = stageSkillDraft(registry, draft, workerAllowlistFromSettings(undefined), describeWorkerSkillReachability([]));
  assert.equal(r.refused, false);
  assert.equal(r.staged, true, "the production caller retroCommand now makes this happen");
  // AND THE SKILL IS STILL NOT INJECTABLE: nothing wrote under .claude/skills/, so the loader —
  // which reads ONLY the approved tree — still finds nothing. That gap is the operator's release.
  assert.deepEqual(loadInjectableSkills(join(dir, "skills")), []);
});

// ── W1-T3101: the two seams the command bodies hid ────────────────────────────────────────────
// `diff-coverage` blocked #4611 on 14 added source lines with zero covering tests — five in the
// implement path's `skills.injected` branch, nine in retroCommand's staging loop. Both sat inside
// command functions no test drives, so the logic moved into skill-workshop.ts and these cover it.

const injectable = (name: string): InjectableSkill => ({ name, appliesTo: ["implement"], body: name });
const allowlist = workerAllowlistFromSettings(undefined);
const reachable = describeWorkerSkillReachability([]);
const draft = (name: string): SkillDraft => ({ name, candidateHash: `hash-${name}` }) as SkillDraft;

const skillSelectionRow = (runId: string, selected: boolean): Record<string, unknown> => ({
  run_id: runId,
  step: "skills.selection",
  task_type: "implement",
  approved_eligible_names: ["procedure"],
  selected_names: selected ? ["procedure"] : [],
  budget_omitted_names: selected ? [] : ["procedure"],
  budget_chars: DEFAULT_KNOWLEDGE_BUDGET_CHARS,
  zero_selection: !selected,
});

const verdictRow = (runId: string, verdict: string): Record<string, unknown> => ({ run_id: runId, step: "verdict", verdict });

const effectivenessRows = (
  selectedOutcomes: readonly string[],
  controlOutcomes: readonly string[],
): Record<string, unknown>[] => [
  ...selectedOutcomes.flatMap((verdict, index) => [skillSelectionRow(`selected-${index}`, true), verdictRow(`selected-${index}`, verdict)]),
  ...controlOutcomes.flatMap((verdict, index) => [skillSelectionRow(`control-${index}`, false), verdictRow(`control-${index}`, verdict)]),
];

test("W1-T3101: skillsInjectedEvent returns undefined for an empty selection — no row, never a zero-count row", () => {
  assert.equal(skillsInjectedEvent([], "implement", DEFAULT_KNOWLEDGE_BUDGET_CHARS), undefined);
});

test("W1-T3101: skillsInjectedEvent names every selected skill, its task type and the budget it spent from", () => {
  assert.deepEqual(skillsInjectedEvent([injectable("b-skill"), injectable("a-skill")], "implement", 8000), {
    selected: 2,
    selected_names: ["b-skill", "a-skill"],
    task_type: "implement",
    budget_chars: 8000,
  });
});

// ── W1-T3379: evidence-only selection lifecycle ──────────────────────────────────────────────

test("W1-T3379 criterion 1: every observation carries the approved denominator, budget omission, and explicit zero while skills.injected stays compatible", () => {
  const selected = observeSkillSelection(
    [
      { name: "fits", appliesTo: ["implement"], body: "small" },
      { name: "omitted", appliesTo: ["implement"], body: "x".repeat(20) },
      { name: "diagnose-only", appliesTo: ["diagnose"], body: "small" },
    ],
    "implement",
    10,
  );
  assert.deepEqual(selected.observation, {
    task_type: "implement",
    approved_eligible_names: ["fits", "omitted"],
    selected_names: ["fits"],
    budget_omitted_names: ["omitted"],
    budget_chars: 10,
    zero_selection: false,
  });
  const zero = observeSkillSelection([], "implement", 10);
  assert.deepEqual(zero.observation, {
    task_type: "implement",
    approved_eligible_names: [],
    selected_names: [],
    budget_omitted_names: [],
    budget_chars: 10,
    zero_selection: true,
  });
  assert.equal(skillsInjectedEvent(zero.selected, "implement", 10), undefined,
    "the existing compatibility event still omits a zero row; the new observation supplies it");
});

test("W1-T3379 criterion 2: the report joins terminal outcomes by run id and renders selected and same-class control evidence separately", () => {
  const report = buildSkillEffectivenessReport([
    skillSelectionRow("selected-run", true),
    verdictRow("selected-run", "merged"),
    skillSelectionRow("control-run", false),
    verdictRow("control-run", "blocked_ci"),
    verdictRow("unrelated-run", "failed"),
  ], "procedure");
  assert.deepEqual(report.selected, {
    observed_eligible_runs: 1,
    terminal_runs: 1,
    merged_runs: 1,
    harmful_terminal_runs: 0,
    outcomes: { merged: 1 },
  });
  assert.deepEqual(report.control, {
    observed_eligible_runs: 1,
    terminal_runs: 1,
    merged_runs: 0,
    harmful_terminal_runs: 0,
    outcomes: { blocked_ci: 1 },
  });
  const rendered = renderSkillEffectivenessReport(report);
  assert.match(rendered, /^selected: observed_eligible_runs=1; terminal_runs=1/m);
  assert.match(rendered, /^control: observed_eligible_runs=1; terminal_runs=1/m);
});

test("W1-T3379 criterion 3: fewer than ten terminal selected runs or controls is INSUFFICIENT EVIDENCE and makes no lifecycle decision", () => {
  const report = buildSkillEffectivenessReport(effectivenessRows(
    Array(9).fill("merged"),
    Array(10).fill("blocked_ci"),
  ), "procedure");
  assert.equal(report.status, "INSUFFICIENT EVIDENCE");
  assert.equal(report.basis, "below-horizon");
  assert.match(renderSkillEffectivenessReport(report), /status: INSUFFICIENT EVIDENCE/);
});

test("W1-T3379 criterion 4: zero selection, no improvement, and named harm retire; a favorable comparison is reviewable at the fixed horizon", () => {
  const controls = Array(10).fill("blocked_ci");
  const zero = buildSkillEffectivenessReport(effectivenessRows([], controls), "procedure");
  assert.equal(zero.status, "RETIRE-CANDIDATE");
  assert.equal(zero.basis, "zero-selection");

  const noImprovement = buildSkillEffectivenessReport(effectivenessRows(
    [...Array(5).fill("merged"), ...Array(5).fill("blocked_ci")],
    [...Array(5).fill("merged"), ...Array(5).fill("blocked_ci")],
  ), "procedure");
  assert.equal(noImprovement.status, "RETIRE-CANDIDATE");
  assert.equal(noImprovement.basis, "not-better-than-control");

  const harmful = buildSkillEffectivenessReport(effectivenessRows(
    [...Array(9).fill("merged"), "failed"],
    controls,
  ), "procedure");
  assert.equal(harmful.status, "RETIRE-CANDIDATE");
  assert.equal(harmful.basis, "named-harm-signal");

  const favorable = buildSkillEffectivenessReport(effectivenessRows(
    [...Array(8).fill("merged"), ...Array(2).fill("blocked_ci")],
    [...Array(3).fill("merged"), ...Array(7).fill("blocked_ci")],
  ), "procedure");
  assert.equal(favorable.status, "REVIEW-CANDIDATE");
  assert.equal(favorable.basis, "favorable-comparison");
});

test("W1-T3379 criterion 5: reporting is read-only and leaves the approval plus applies-to boundary unchanged", () => {
  const rows = effectivenessRows(Array(10).fill("merged"), Array(10).fill("blocked_ci"));
  for (const row of rows) Object.freeze(row);
  const before = JSON.stringify(rows);
  const report = buildSkillEffectivenessReport(rows, "procedure");
  assert.equal(JSON.stringify(rows), before, "the reporter never changes ledger evidence");
  assert.match(renderSkillEffectivenessReport(report), /does not prove causation or modify a skill/);
  assert.deepEqual(loadInjectableSkills(join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}read-only-`)), "skills")), [],
    "the reporter receives evidence, not a path that could approve or inject a procedure");
});

test("W1-T3379 criterion 5: the CLI dispatcher delegates the evidence verb without creating a skill lifecycle action", async (t) => {
  const delegated: string[][] = [];
  assert.equal(await skillCommand(["effectiveness", "procedure"], {
    effectiveness: (rest) => {
      delegated.push(rest);
      return 0;
    },
  }), 0);
  assert.deepEqual(delegated, [["procedure"]]);
  const errors: string[] = [];
  t.mock.method(console, "error", (line: string) => errors.push(line));
  assert.equal(await skillCommand(["unknown"], { effectiveness: () => 0 }), 2);
  assert.match(errors[0] ?? "", /unknown subcommand/);
});

test("W1-T3379: the report command reads one complete union and refuses malformed invocation or incomplete evidence", () => {
  const output: string[] = [];
  const errors: string[] = [];
  let readCalls = 0;
  const readLedger = ((stateDir: string, opts: { step?: string | readonly string[]; refuseIncomplete?: boolean } = {}) => {
    readCalls++;
    assert.equal(stateDir, "/state");
    assert.deepEqual(opts.step, ["skills.selection", "verdict"]);
    assert.equal(opts.refuseIncomplete, true);
    return {
      stateDir,
      archiveFiles: [],
      archiveCount: 0,
      liveFileRead: true,
      unread: [],
      unclassified: [],
      ok: true,
      rows: effectivenessRows(Array(10).fill("merged"), Array(10).fill("blocked_ci")),
      torn: 0,
      filesRead: 1,
    };
  }) as NonNullable<Parameters<typeof skillEffectivenessCommand>[1]>["readLedger"];
  const deps = { stateDir: "/state", readLedger, write: (line: string) => output.push(line), error: (line: string) => errors.push(line) };
  assert.equal(skillEffectivenessCommand(["procedure"], deps), 0);
  assert.match(output.join("\n"), /status: REVIEW-CANDIDATE/);
  assert.equal(errors.length, 0);
  assert.equal(readCalls, 1);
  assert.equal(skillEffectivenessCommand([], deps), 2);
  assert.equal(readCalls, 1, "a malformed invocation never reads the ledger");
  assert.match(errors.pop() ?? "", /usage/);
  assert.equal(skillEffectivenessCommand(["procedure", "unexpected"], deps), 2);
  assert.match(errors.pop() ?? "", /unexpected argument/);

  const incomplete = skillEffectivenessCommand(["procedure"], {
    ...deps,
    readLedger: (() => ({
      stateDir: "/state", archiveFiles: ["/state/ledger.1.ndjson.gz"], archiveCount: 1, liveFileRead: true,
      unread: ["/state/ledger.1.ndjson.gz"], unclassified: [], ok: false, rows: [], torn: 0, filesRead: 1,
    })) as NonNullable<Parameters<typeof skillEffectivenessCommand>[1]>["readLedger"],
  });
  assert.equal(incomplete, 1);
  assert.match(errors.pop() ?? "", /REFUSED incomplete ledger union/);

  const unreadable = skillEffectivenessCommand(["procedure"], {
    ...deps,
    readLedger: (() => { throw new Error("permission denied"); }) as NonNullable<Parameters<typeof skillEffectivenessCommand>[1]>["readLedger"],
  });
  assert.equal(unreadable, 1);
  assert.match(errors.pop() ?? "", /REFUSED unreadable ledger union: Error: permission denied/);
});

const workerResult = (over: Partial<WorkerResult> = {}): WorkerResult => ({
  sessionId: "skill-observation",
  costUsd: 0,
  numTurns: 0,
  text: "",
  blocks: [],
  stderr: "",
  subtype: "success",
  isError: false,
  apiError: false,
  permissionDenials: [],
  childEnvKeys: [],
  model: "default",
  effort: "default",
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  modelUsage: {},
  compactionEvents: [],
  qualitySuspect: false,
  ...over,
});

const skillObservationGithub: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const skillObservationContainment = (token: string): Promise<ProbeExecResult> => Promise.resolve({
  transcript: `touch ../${token}.txt: Operation not permitted`,
  outsideWriteCreated: false,
  insideWriteCreated: true,
  costUsd: 0,
});

const skillObservationIsolation = (): Promise<IsolationProbeExecResult> => Promise.resolve({
  transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
  aliasCount: 0,
  functionCount: 0,
  functionNames: "-",
  costUsd: 0,
});

const skillObservationPlan = [
  "- id: T-SKILL-OBSERVATION",
  "  title: observe the approved skill denominator",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/skill-workshop.ts]",
  "  origin: test",
  "  status: queued",
  "",
].join("\n");

const makeSkillObservationGitFixture = (root: string): (() => void) => {
  const origin = gitRepo({ bare: true, kind: "skill-observation-origin" });
  const seed = gitRepo({ kind: "skill-observation-seed" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "HEAD:main");
  const checkout = gitRepo({ cloneFrom: origin.dir, kind: "skill-observation-checkout" });
  checkout.git("config", "user.email", "skill-observation@example.invalid");
  checkout.git("config", "user.name", "skill-observation");
  mkdirSync(join(root, "repos"), { recursive: true });
  renameSync(checkout.dir, join(root, "repos", "remudero"));
  return () => {
    origin.cleanup();
    seed.cleanup();
  };
};

const makeSkillObservationGh = (branch: string): string =>
  ghShim([
    { when: "headRefName", stdout: JSON.stringify({ headRefName: branch }) },
    { when: "statusCheckRollup", stdout: '{"statusCheckRollup":[{"name":"ci","conclusion":"FAILURE"}]}' },
    { when: "/check-runs", stdout: '{"check_runs":[{"name":"ci","status":"completed","conclusion":"failure"}]}' },
    { when: "/status", stdout: '{"state":"failure","statuses":[]}' },
    { when: "/pulls/", stdout: JSON.stringify({ number: 1, state: "open", merged: false, head: { sha: "deadbee", ref: branch } }) },
    { when: "body", stdout: '{"body":""}' },
  ], { kind: "skill-observation-gh" }).dir;

test("W1-T3379 criterion 1: a real implement dispatch emits its run-correlated zero-selection observation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}skill-observation-root-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, skillObservationPlan);
  const cleanupGitFixture = makeSkillObservationGitFixture(root);
  const fixedNow = 1785100000000;
  const ghBin = makeSkillObservationGh(`run-T-SKILL-OBSERVATION-${fixedNow}`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${ghBin}:${oldPath}`;
  const now = t.mock.method(Date, "now", () => fixedNow);
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    return spawnCalls.length === 1
      ? workerResult({ text: "RECON REPORT\nOBSERVED: no procedure selected\nINFERRED: -\nCOULDN'T-VERIFY: -\n" })
      : workerResult({ text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" });
  };
  const { withLiveWritesAllowed } = await import("../src/lib/live-write-guard.js");
  try {
    await withLiveWritesAllowed(() => runTask("T-SKILL-OBSERVATION", {
      skipGitSync: true,
      planPath,
      config: { claudeBin: "/bin/true", root } as Config,
      github: skillObservationGithub,
      spawn,
      containmentExec: skillObservationContainment,
      isolationExec: skillObservationIsolation,
    }));
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const selection = ledger.find((row) => row.step === "skills.selection");
    assert.deepEqual(selection && {
      run_id: selection.run_id,
      task_type: selection.task_type,
      approved_eligible_names: selection.approved_eligible_names,
      selected_names: selection.selected_names,
      budget_omitted_names: selection.budget_omitted_names,
      zero_selection: selection.zero_selection,
    }, {
      run_id: `T-SKILL-OBSERVATION-${fixedNow}`,
      task_type: "implement",
      approved_eligible_names: [],
      selected_names: [],
      budget_omitted_names: [],
      zero_selection: true,
    });
    assert.equal(ledger.some((row) => row.step === "skills.injected"), false,
      "the compatibility event still has no zero row; skills.selection is the explicit denominator");
  } finally {
    now.mock.restore();
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    cleanupGitFixture();
  }
});

test("W1-T3379 criterion 6 mutation: without the selection/outcome join, identical injection names with opposite terminal outcomes are indistinguishable", () => {
  const selectedOnly = skillSelectionRow("same-injection", true);
  const control = skillSelectionRow("same-control", false);
  const mergedRows = [selectedOnly, verdictRow("same-injection", "merged"), control, verdictRow("same-control", "blocked_ci")];
  const failedRows = [selectedOnly, verdictRow("same-injection", "failed"), control, verdictRow("same-control", "blocked_ci")];
  assert.deepEqual(
    mergedRows.filter((row) => row.step === "skills.selection").map((row) => row.selected_names),
    failedRows.filter((row) => row.step === "skills.selection").map((row) => row.selected_names),
    "the selection surface alone cannot distinguish the fixtures",
  );
  const merged = buildSkillEffectivenessReport(mergedRows, "procedure");
  const failed = buildSkillEffectivenessReport(failedRows, "procedure");
  assert.deepEqual(merged.selected.outcomes, { merged: 1 });
  assert.deepEqual(failed.selected.outcomes, { failed: 1 });
  assert.notEqual(merged.selected.outcomes, failed.selected.outcomes,
    "the run-correlated terminal outcome is the evidence the report must retain");
});

test("W1-T3101: stageSkillDrafts logs one skill.staged per draft, carrying the stager's own verdict", () => {
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const stub = (_p: string, d: SkillDraft): StageSkillDraftResult =>
    d.name === "one"
      ? { staged: true, alreadyStaged: false, refused: false }
      : { staged: false, alreadyStaged: false, refused: true, reason: "not allowlisted" };
  stageSkillDrafts("/registry.json", [draft("one"), draft("two")], allowlist, reachable, (step, extra) => rows.push([step, extra]), stub as typeof stageSkillDraft);
  assert.deepEqual(rows.map(([step]) => step), ["skill.staged", "skill.staged"]);
  assert.equal(rows[0][1]?.staged, true);
  assert.equal(rows[1][1]?.refused, true);
  assert.equal(rows[1][1]?.reason, "not allowlisted");
});

test("W1-T3101: a THROW on one draft is logged and the loop continues — a bad draft never fails the retro", () => {
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const stub = (_p: string, d: SkillDraft): StageSkillDraftResult => {
    if (d.name === "explodes") throw new Error("registry unwritable");
    return { staged: true, alreadyStaged: false, refused: false };
  };
  stageSkillDrafts("/registry.json", [draft("explodes"), draft("survives")], allowlist, reachable, (step, extra) => rows.push([step, extra]), stub as typeof stageSkillDraft);
  // THE FALSIFIER: a loop that rethrew would never reach the second draft, and a loop that
  // swallowed silently would log nothing for the first.
  assert.deepEqual(rows.map(([step]) => step), ["skill.stage_failed", "skill.staged"]);
  assert.equal(rows[0][1]?.name, "explodes");
  assert.match(String(rows[0][1]?.error), /registry unwritable/);
  assert.equal(rows[1][1]?.name, "survives");
});

test("W1-T3101: no drafts means no staging call and no rows at all", () => {
  const rows: string[] = [];
  let calls = 0;
  const stub = (): StageSkillDraftResult => {
    calls += 1;
    return { staged: true, alreadyStaged: false, refused: false };
  };
  stageSkillDrafts("/registry.json", [], allowlist, reachable, (step) => rows.push(step), stub as typeof stageSkillDraft);
  assert.deepEqual(rows, []);
  assert.equal(calls, 0);
});
