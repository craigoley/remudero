/**
 * test/plan-prompt-placement.test.ts — impl-FS.
 *
 * THE DEFECT. `planArchitectPrompt` directed its worker to file NEW tasks into `plan/tasks.yaml`.
 * `monolithFilingViolations` (lib/task-linter.ts) FAILS exactly that at severity `block`, and CI
 * runs the rule in its activating mode (`lint-plan --base <sha>`, an unconditional required check).
 * The lane has never run, so its first `create`/`expand` run would have spent an Architect budget,
 * opened a PR, and sat red on `lint-plan` — surfaced to the operator only as "ci failure".
 *
 * WHAT THIS SUITE IS. A test of the PROMPT against the LINTER. You cannot test a prompt by running
 * it (that costs money and is forbidden), and asserting a string appears in the prompt is nearly
 * worthless — it pins wording, breaks on the next legitimate reword, and proves nothing about
 * compliance. So instead: construct the file placement the prompt now DIRECTS, and assert the gate
 * ACCEPTS it; construct the placement it USED TO direct, and assert the gate still REFUSES it.
 *
 * WHAT IT DOES NOT PROVE, stated plainly: it does not prove an LLM will obey the prompt. Nothing
 * short of a real run can. It proves the instruction and the gate now AGREE — which is the part
 * that was actually wrong, and the part a first run would have died on.
 *
 * `newMonolithIds` is derived here EXACTLY as production derives it (run-task.ts's `lint-plan
 * --base` branch): parse the base monolith text, parse the head monolith text, take the ids present
 * in head and absent from base. Hand-constructing that set would make the test tautological — it
 * would assert the linter honours a set I chose rather than that a PLACEMENT produces that set.
 */
import assert from "node:assert/strict";
import { globSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";

import { planArchitectPrompt } from "../src/lib/plan-architect.js";
import { parseTasksFromYaml } from "../src/lib/plan.js";
import { lintTask, monolithFilingViolations } from "../src/lib/task-linter.js";

/**
 * A task shaped as the CORRECTED prompt directs — including `origin: architect`, which the prompt
 * previously named nowhere at all while `provenanceViolation` BLOCKS its absence. That omission was
 * found BY the aggregate assertion below, not by the recon: the single-rule test passed happily
 * without it, and only running every check the gate runs exposed it.
 */
const TASK_YAML = (id: string, title: string): string =>
  [
    `- id: ${id}`,
    `  title: "${title}"`,
    "  repo: remudero",
    "  origin: architect",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  status: queued",
    "  attempts: 0",
    "  files: [src/lib/example.ts]",
    "",
  ].join("\n");

/** The plan as it stands at the PR's base ref — two pre-existing tasks in the monolith. */
const BASE_MONOLITH = TASK_YAML("W1-T1", "a pre-existing task") + TASK_YAML("W1-T2", "another one");

const NEW_ID = "W1-T900";
const NEW_TASK = TASK_YAML(NEW_ID, "the task a plan worker files");

/**
 * Production's own derivation (run-task.ts, the `--base` branch of `lintPlanCommand`):
 *   baseMonolithIds = parseTasksFromYaml(<base blob>)
 *   headMonolithIds = parseTasksFromYaml(<head file>)
 *   newMonolithIds  = head \ base
 * Note it is a per-FILE comparison against the MONOLITH ALONE — shards are never materialized into
 * it — which is exactly why a shard-filed task leaves the set.
 */
function newMonolithIds(baseMonolithText: string, headMonolithText: string): ReadonlySet<string> {
  const base = new Set(parseTasksFromYaml(baseMonolithText, "base:plan/tasks.yaml").map((t) => t.id));
  const head = parseTasksFromYaml(headMonolithText, "head:plan/tasks.yaml").map((t) => t.id);
  return new Set(head.filter((id) => !base.has(id)));
}

const theNewTask = () => parseTasksFromYaml(NEW_TASK, "fixture")[0];

// ── (3) THE PROMPT'S PLACEMENT PASSES THE GATE ───────────────────────────────

test("a task placed as the prompt now directs — its own shard — trips NO monolith-filing violation", () => {
  // The prompt's NEW TASK PLACEMENT block: the new task goes in plan/tasks.d/<id>-<slug>.yaml, so
  // the MONOLITH IS UNCHANGED between base and head. That is the whole mechanism.
  const headMonolith = BASE_MONOLITH; // untouched — the task went into a shard file
  const ids = newMonolithIds(BASE_MONOLITH, headMonolith);

  assert.deepEqual([...ids], [], "a shard filing adds no id to the monolith");
  assert.deepEqual(
    monolithFilingViolations(theNewTask(), { newMonolithIds: ids }),
    [],
    "so the rule the first run would have died on does not fire",
  );
});

test("the shard-placed task has NO blocking violation from the whole linter, not just this rule", () => {
  // Stronger than the single-rule check: run every check `lint-plan` runs for one task and require
  // the BLOCKING set to be empty. A fix that dodged monolith-filing while tripping something else
  // would still leave the lane red on its first run.
  const ids = newMonolithIds(BASE_MONOLITH, BASE_MONOLITH);
  const result = lintTask(theNewTask(), { newMonolithIds: ids });
  const blocking = result.violations.filter((v) => v.severity === "block");

  assert.deepEqual(
    blocking.map((v) => v.check),
    [],
    `expected no blocking violation; got ${JSON.stringify(blocking, null, 2)}`,
  );
});

// ── (4) THE NEGATIVE: THE OLD PLACEMENT STILL TRIPS ──────────────────────────

test("the placement the prompt USED to direct — appended to the monolith — still BLOCKS", () => {
  // This is the falsifier for the suite itself. If the rule were deleted or downgraded, this test
  // fails and the pair above becomes vacuous — a green suite that proves nothing.
  const headMonolith = BASE_MONOLITH + NEW_TASK; // the old wording: append to plan/tasks.yaml
  const ids = newMonolithIds(BASE_MONOLITH, headMonolith);

  assert.deepEqual([...ids], [NEW_ID], "appending to the monolith DOES add a new monolith id");

  const violations = monolithFilingViolations(theNewTask(), { newMonolithIds: ids });
  assert.equal(violations.length, 1, "the rule fires");
  assert.equal(violations[0].check, "monolith-filing");
  assert.equal(violations[0].severity, "block", "and it BLOCKS — this is what reddens CI");
  assert.match(violations[0].message, /New tasks belong in their own shard/);
});

test("the whole linter reports that same monolith placement as blocking", () => {
  const ids = newMonolithIds(BASE_MONOLITH, BASE_MONOLITH + NEW_TASK);
  const blocking = lintTask(theNewTask(), { newMonolithIds: ids }).violations.filter((v) => v.severity === "block");

  assert.ok(
    blocking.some((v) => v.check === "monolith-filing"),
    `monolith-filing must be among the blocking checks; got ${JSON.stringify(blocking.map((v) => v.check))}`,
  );
});

// ── REWIRING an EXISTING task is unaffected — clarify must not be over-corrected ─

test("rewiring an EXISTING monolith task does not trip the rule — clarify is legitimately different", () => {
  // `clarify`'s PROPOSED branch rewrites tasks that already exist, so its ids are already in the
  // base monolith and can never enter `newMonolithIds`. This is why the shard rule is NOT applied
  // to that branch, and this test is what keeps a future edit from over-applying it.
  const headMonolith = TASK_YAML("W1-T1", "a pre-existing task, REWORDED") + TASK_YAML("W1-T2", "another one");
  const ids = newMonolithIds(BASE_MONOLITH, headMonolith);

  assert.deepEqual([...ids], [], "a rewrite introduces no NEW monolith id");
  const existing = parseTasksFromYaml(headMonolith, "fixture")[0];
  assert.deepEqual(monolithFilingViolations(existing, { newMonolithIds: ids }), []);
});

test("a task moved OUT of the monolith into a shard does not trip either — the right migration is free", () => {
  const headMonolith = TASK_YAML("W1-T2", "another one"); // W1-T1 left for a shard
  const ids = newMonolithIds(BASE_MONOLITH, headMonolith);

  assert.deepEqual([...ids], [], "removing an id from the monolith adds nothing to the new set");
});

// ── THE COUPLING: the placement the PROMPT DIRECTS, run through the real gate ─

/**
 * Derive WHERE the prompt sends a NEW task, then let the linter judge that placement.
 *
 * The tests above judge placements I construct; on their own they would still pass if the prompt
 * were reverted, because they never read it. This is the link that closes that gap — and it is the
 * weakest link in the suite, because coupling prose to behaviour necessarily goes through a parse.
 *
 * It keys on a FILING TEMPLATE (`plan/tasks.d/<…>`), not on any sentence, so a legitimate reword
 * that still directs a shard keeps passing. It deliberately does NOT match the STEP-1 grounding
 * glob (`plan/tasks.d/*.yaml`), which contains no `<` — otherwise merely listing the shards as a
 * read target would look like a filing instruction.
 */
function newTaskDestination(prompt: string): "shard" | "monolith" {
  return /plan\/tasks\.d\/<[^>]+>/.test(prompt) ? "shard" : "monolith";
}

test("the destination the prompt directs for a NEW task is one the linter ACCEPTS", () => {
  const prompt = planArchitectPrompt("create", "a brief", "PLAN-create-1");
  const dest = newTaskDestination(prompt);

  // Build the monolith state that destination implies, then ask the REAL rule.
  const headMonolith = dest === "shard" ? BASE_MONOLITH : BASE_MONOLITH + NEW_TASK;
  const ids = newMonolithIds(BASE_MONOLITH, headMonolith);
  const violations = monolithFilingViolations(theNewTask(), { newMonolithIds: ids });

  assert.deepEqual(
    violations,
    [],
    `the prompt directs a NEW task to the ${dest}, which CI's monolith-filing rule REFUSES — ` +
      `this is the defect that would have reddened the lane's first create/expand run`,
  );
});

test("every mode that FILES a new task directs it somewhere the linter accepts", () => {
  // `clarify` is excluded on purpose: it rewrites existing tasks and files nothing, so it has no
  // new-task destination to check. Over-applying the rule there is its own defect.
  for (const mode of ["create", "expand"] as const) {
    const dest = newTaskDestination(planArchitectPrompt(mode, "a brief", `PLAN-${mode}-1`));
    assert.equal(dest, "shard", `--mode=${mode} must direct a new task to its own shard`);
  }
});

// ── (5) THE GROUNDING READ — assert the RESOLVED FILE SET, not the string ────

/**
 * Pull the glob tokens out of the prompt's STEP 1 line and RESOLVE them against a real directory
 * tree. Asserting the sentence would pin wording and break on the next legitimate reword; asserting
 * what the tokens actually resolve to is the property that matters — the worker is pointed at every
 * file holding a task.
 */
function groundingResolvedFiles(prompt: string, root: string): string[] {
  const line = prompt.split("\n").find((l) => l.startsWith("Grep/Read"));
  assert.ok(line, "the prompt still has a STEP 1 grounding line");
  const tokens = line
    .replace(/^Grep\/Read\s*/, "")
    .split(/[,\s]+/)
    .filter((t) => /^[\w./*-]+$/.test(t) && t.includes("."));
  const out = new Set<string>();
  for (const t of tokens) {
    for (const hit of globSync(t, { cwd: root })) out.add(hit.split(sep).join("/"));
  }
  return [...out].sort();
}

test("the grounding read resolves to every file holding a task, shards included", () => {
  const root = mkdtempSync(join(tmpdir(), "fs-ground-"));
  try {
    mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(root, "plan", "tasks.yaml"), BASE_MONOLITH);
    writeFileSync(join(root, "plan", "tasks.d", "W1-T900-alpha.yaml"), NEW_TASK);
    writeFileSync(join(root, "plan", "tasks.d", "W1-T901-beta.yaml"), TASK_YAML("W1-T901", "a second shard"));
    writeFileSync(join(root, "MASTER-PLAN.md"), "# plan\n");
    writeFileSync(join(root, "LEARNINGS.md"), "x\n");
    writeFileSync(join(root, "DECISIONS.md"), "x\n");

    const resolved = groundingResolvedFiles(planArchitectPrompt("create", "brief", "PLAN-create-1"), root);

    // THE POINT: both shard files are reachable from what the prompt names. Before this PR the
    // resolved set was exactly [DECISIONS.md, LEARNINGS.md, MASTER-PLAN.md, plan/tasks.yaml] and
    // every sharded task — 45 of the plan's 314, and the most recently filed — was invisible.
    assert.ok(resolved.includes("plan/tasks.d/W1-T900-alpha.yaml"), `shard missing from ${JSON.stringify(resolved)}`);
    assert.ok(resolved.includes("plan/tasks.d/W1-T901-beta.yaml"), `shard missing from ${JSON.stringify(resolved)}`);
    assert.ok(resolved.includes("plan/tasks.yaml"), "the monolith is still grounded");
    assert.ok(resolved.includes("MASTER-PLAN.md"), "MASTER-PLAN.md is still grounded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all three modes ground on the shards — the grounding line is shared, and must stay shared", () => {
  const root = mkdtempSync(join(tmpdir(), "fs-ground3-"));
  try {
    mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(root, "plan", "tasks.yaml"), BASE_MONOLITH);
    writeFileSync(join(root, "plan", "tasks.d", "W1-T900-alpha.yaml"), NEW_TASK);

    for (const mode of ["create", "clarify", "expand"] as const) {
      const resolved = groundingResolvedFiles(planArchitectPrompt(mode, "brief", `PLAN-${mode}-1`), root);
      assert.ok(
        resolved.includes("plan/tasks.d/W1-T900-alpha.yaml"),
        `--mode=${mode} does not ground on shards; resolved ${JSON.stringify(resolved)}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
