import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS } from "../src/lib/learnings.js";
import {
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
import { implementPromptParts, renderImplementPrompt } from "../src/lib/prompt-render.js";
import type { Task } from "../src/lib/plan.js";

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

test("the live prompt manifest receives the same selected skills part as the worker prompt", () => {
  // THE FALSIFIER: the pure helper test above stayed green while runTask omitted the optional
  // final argument at its prompt.manifest call. Pin the production call, where that omission made
  // an injected skill read as `present:false` even though the worker received its bytes.
  const source = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /implementPromptParts\(\s*task,\s*reconContext,\s*runId,\s*matchedLearnings,\s*operatorNotesBlock,\s*ruleHeadlinesPart,\s*skillsPart,?\s*\)/,
    "runTask must hand skillsPart to the manifest derivation, not only to renderImplementPrompt",
  );
});

// ── staging writes a proposal, never a skill ──────────────────────────────────────────────────

test("W1-T3101: staging writes a PROPOSAL — approval, not staging, is what makes a skill injectable", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}stage-`));
  const registry = join(dir, "inbox-proposals.json");
  const draft = { name: "proc", description: "d", markdown: "# proc\n\nbody", candidateHash: "h1" };
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
