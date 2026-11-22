import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { stringify as stringifyYaml } from "yaml";

import { fixedClock } from "#src/lib/clock.js";
import {
  blockingLintMessages,
  classifyProposal,
  inboxDraftExampleFragmentYaml,
  inboxDraftPrompt,
  planProjectionForDependsOn,
  runDraftRung,
  type DraftRungOutcome,
  type Proposal,
  type ReadinessContext,
} from "#src/lib/inbox.js";
import { loadPlan, loadPlanFromYaml, parseTasksFromYaml } from "#src/lib/plan.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T14296. MEASURED 2026-11-22: every inbox.draft_synthesized row carried prompt_chars ~2,055,217, of which
// plan_index_chars was 2,047,965, because the depends_on index projected EVERY task and 4,466 of the 5,953 public
// tasks had merged. A depends_on naming a merged or done task is already satisfied (plan.ts MERGED_STATUSES), so
// those rows cannot ground a useful edge. The index now lists open tasks only, plus a landed task the proposal names.

/** Merged, done, queued and blocked tasks in a fixed order; W1-T5 is merged and is the one a proposal names. */
const MIXED_PLAN = [
  "- id: W1-T1",
  '  title: "the first landed task"',
  "  status: merged",
  "  type: implement",
  "  depends_on: []",
  "- id: W1-T2",
  '  title: "an open task that depends on the landed one"',
  "  status: queued",
  "  type: implement",
  "  depends_on: [W1-T1]",
  "- id: W1-T3",
  '  title: "a done task"',
  "  status: done",
  "  type: docs",
  "- id: W1-T4",
  '  title: "a blocked task"',
  "  status: blocked",
  "  type: diagnose",
  "  depends_on: [W1-T2, W1-T3]",
  "- id: W1-T5",
  '  title: "a landed task the proposal names"',
  "  status: merged",
  "  type: implement",
  "- id: W1-T6",
  '  title: "a second queued task"',
  "  status: queued",
  "  type: implement",
  "",
].join("\n");

/** The open rows of MIXED_PLAN, byte for byte in the projection's existing row format. */
const OPEN_ROWS = {
  "W1-T2": "- id: W1-T2\n  title: an open task that depends on the landed one\n  status: queued\n  type: implement\n  depends_on: W1-T1",
  "W1-T4": "- id: W1-T4\n  title: a blocked task\n  status: blocked\n  type: diagnose\n  depends_on: W1-T2, W1-T3",
  "W1-T5": "- id: W1-T5\n  title: a landed task the proposal names\n  status: merged\n  type: implement",
  "W1-T6": "- id: W1-T6\n  title: a second queued task\n  status: queued\n  type: implement",
};

/** A plan with no merged or done task: the invariant's input. */
const OPEN_ONLY_PLAN = [
  "- id: W1-T10",
  '  title: "a queued task"',
  "  status: queued",
  "  type: implement",
  "  depends_on: []",
  "- id: W1-T11",
  '  title: "a blocked task"',
  "  status: blocked",
  "  type: diagnose",
  "  depends_on: [W1-T10]",
  "",
].join("\n");

/** origin/main's projection of OPEN_ONLY_PLAN, copied from its output before this change. */
const OPEN_ONLY_INDEX = "- id: W1-T10\n  title: a queued task\n  status: queued\n  type: implement\n  depends_on: \n- id: W1-T11\n  title: a blocked task\n  status: blocked\n  type: diagnose\n  depends_on: W1-T10";

/** origin/main's GROUND block for OPEN_ONLY_PLAN: the only prompt region this change touches. */
const OPEN_ONLY_GROUND = [
  "=== GROUND ===",
  "Grep/Read MASTER-PLAN.md, LEARNINGS.md, and DECISIONS.md for what is already decided; an",
  "INDEX of the current plan/tasks.yaml is pasted below so you cite REAL existing task ids in",
  "depends_on. It is an index, NOT the whole plan: each task shows only id, title, status, type",
  "and depends_on. If you need a task's rationale, design or acceptance, Read plan/tasks.yaml —",
  "you have Read/Grep/Glob and the file is in this worktree. Do not assume a field you cannot see.",
  "",
  "=== plan/tasks.yaml INDEX (id, title, status, type, depends_on — for depends_on grounding) ===",
  OPEN_ONLY_INDEX,
  "",
  "=== TASK IDS",
].join("\n");

const NAMING_PROPOSAL = { id: "P-index", summary: "follow up on W1-T5, which shipped half the fix", evidenceAnchors: [] } as unknown as Proposal;
const PLAIN_PROPOSAL = { id: "P-plain", summary: "a proposal that names no task", evidenceAnchors: [] } as unknown as Proposal;

const projectedIds = (index: string): string[] => [...index.matchAll(/^- id: (\S+)$/gm)].map((m) => m[1]!);

function worker(text: string): WorkerResult {
  return {
    sessionId: "S-index", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
    permissionDenials: [], childEnvKeys: [], model: "gpt-6-luna", routedModel: "gpt-6-luna", effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

/** Run one draft rung over `plan` with a spawn that records every prompt and answers `text`. */
async function draftOnce(proposals: Proposal[], plan: string, text: string): Promise<{ prompts: Map<string, string>; outcomes: DraftRungOutcome[] }> {
  const prompts = new Map<string, string>();
  const outcomes = await runDraftRung(proposals, plan, {
    spawn: async (proposal, prompt) => { if (!prompts.has(proposal.id)) prompts.set(proposal.id, prompt); return worker(text); },
    log: () => undefined,
  }, "run-index");
  return { prompts, outcomes };
}

const indexBlock = (prompt: string): string => {
  const start = prompt.indexOf("depends_on grounding) ===\n");
  assert.ok(start >= 0, "control: the prompt must carry the index header");
  const body = prompt.slice(start + "depends_on grounding) ===\n".length);
  return body.slice(0, body.indexOf("\n\n=== TASK IDS"));
};

test("W1-T14296 criterion 1: the index lists every open task in plan order, and a landed task only when the proposal names it", async () => {
  const plain = planProjectionForDependsOn(MIXED_PLAN);
  assert.equal(plain, [OPEN_ROWS["W1-T2"], OPEN_ROWS["W1-T4"], OPEN_ROWS["W1-T6"]].join("\n"),
    "open tasks in plan order with today's fields; no merged or done row");

  const kept = planProjectionForDependsOn(MIXED_PLAN, new Set(["W1-T5"]));
  assert.equal(kept, [OPEN_ROWS["W1-T2"], OPEN_ROWS["W1-T4"], OPEN_ROWS["W1-T5"], OPEN_ROWS["W1-T6"]].join("\n"),
    "a landed task the proposal names keeps its row, in plan order");

  // The draft paths derive the kept ids from the proposal's own text, not from the caller.
  assert.equal(indexBlock(inboxDraftPrompt(NAMING_PROPOSAL, MIXED_PLAN, "run-index")), kept, "the prompt keeps the named landed task");
  assert.equal(indexBlock(inboxDraftPrompt(PLAIN_PROPOSAL, MIXED_PLAN, "run-index")), plain, "and keeps no landed task for a proposal naming none");
  // `W1-T5` inside a longer id is not a mention of W1-T5.
  const lookalike = { ...PLAIN_PROPOSAL, id: "P-look", summary: "see W1-T55 and W1-T5x" } as unknown as Proposal;
  assert.deepEqual(projectedIds(indexBlock(inboxDraftPrompt(lookalike, MIXED_PLAN, "run-index"))), ["W1-T2", "W1-T4", "W1-T6"]);
  // A long dashless summary still finds the id it names (a backtracking id regex is quadratic on this).
  const long = { ...PLAIN_PROPOSAL, id: "P-long", summary: `${"x".repeat(300_000)} then W1-T5.` } as unknown as Proposal;
  assert.deepEqual(projectedIds(indexBlock(inboxDraftPrompt(long, MIXED_PLAN, "run-index"))), ["W1-T2", "W1-T4", "W1-T5", "W1-T6"]);

  // runDraftRung builds the index per proposal: one rung, two proposals, two different indexes.
  const { prompts } = await draftOnce([NAMING_PROPOSAL, PLAIN_PROPOSAL], MIXED_PLAN, "no markers");
  assert.equal(prompts.size, 2, "control: both proposals must reach the spawn");
  assert.deepEqual(projectedIds(indexBlock(prompts.get("P-index")!)), ["W1-T2", "W1-T4", "W1-T5", "W1-T6"]);
  assert.deepEqual(projectedIds(indexBlock(prompts.get("P-plain")!)), ["W1-T2", "W1-T4", "W1-T6"]);
});

test("W1-T14296 criterion 2: the prompt says a merged dependency is satisfied, and a draft naming one lints as before", async () => {
  const prompt = inboxDraftPrompt(PLAIN_PROPOSAL, MIXED_PLAN, "run-index");
  assert.match(prompt, /lists OPEN tasks only/, "the worker must be told the index omits landed tasks");
  assert.match(prompt, /dependency on a merged or done task is already satisfied, so leave it out of depends_on/);

  // A drafted fragment whose depends_on names W1-T1, which the index omitted, against one naming nothing.
  const example = inboxDraftExampleFragmentYaml();
  assert.ok(example.includes("  depends_on: []"), "control: the example fragment must carry an empty depends_on");
  const onMerged = example.replace("  depends_on: []", "  depends_on: [W1-T1]");
  assert.ok(!projectedIds(indexBlock(prompt)).includes("W1-T1"), "control: W1-T1 must have no row in the index the worker saw");
  const answer = (fragment: string): string =>
    `=== FRAGMENT START ===\n${fragment}\n=== FRAGMENT END ===\nSTAMP: draft one follow-up task`;
  const [merged] = (await draftOnce([PLAIN_PROPOSAL], MIXED_PLAN, answer(onMerged))).outcomes;
  const [none] = (await draftOnce([PLAIN_PROPOSAL], MIXED_PLAN, answer(example))).outcomes;
  assert.equal(none!.ok, true, `control: the example fragment must draft clean (${JSON.stringify(none)})`);
  assert.equal(merged!.ok, true, `a depends_on on a merged task the index omitted must still draft clean (${JSON.stringify(merged)})`);

  // Lint reads the FULL plan, never the index: the merged dependency changes no lint message.
  // The full plan holds MIXED_PLAN's merged W1-T1 as a complete record (the index carries only four fields).
  const fullPlan = loadPlanFromYaml(example.replace("- id: NEW-1", "- id: W1-T1").replace("  status: queued", "  status: merged"), "fixture");
  assert.equal(fullPlan.byId.get("W1-T1")?.status, "merged", "control: the full plan must hold W1-T1 as merged");
  const fragmentPlan = (yamlText: string) => {
    const tasks = parseTasksFromYaml(yamlText, "fixture fragment");
    return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
  };
  assert.deepEqual(fragmentPlan(onMerged).byId.get("NEW-1")?.depends_on, ["W1-T1"], "control: the fragment must name W1-T1");
  assert.deepEqual(blockingLintMessages(fullPlan, fragmentPlan(onMerged)), blockingLintMessages(fullPlan, fragmentPlan(example)),
    "a depends_on on a merged task lints exactly as a fragment with no dependency");

  // Readiness resolves the dependency against the same full plan: the merged W1-T1 is satisfied, so the draft
  // classifies exactly as the one with no dependency. Read against the index instead, W1-T1 would be unmet.
  assert.ok(merged!.ok && none!.ok, "control: both drafts must carry a candidate");
  const ctx: ReadinessContext = {
    clock: fixedClock(Date.parse("2026-11-22T12:00:00Z")), plan: fullPlan, isMerged: (task) => task.status === "merged" || task.status === "done",
    grepAnchorTrue: () => true, openProposalIds: new Set(), isRatified: () => false,
  };
  const onMergedClass = classifyProposal(PLAIN_PROPOSAL, merged!.candidate, ctx);
  const noneClass = classifyProposal(PLAIN_PROPOSAL, none!.candidate, ctx);
  assert.ok(!onMergedClass.reasons.some((r) => r.predicate === "deps_merged"), `the merged dependency must be satisfied (${JSON.stringify(onMergedClass.reasons)})`);
  assert.deepEqual([onMergedClass.state, onMergedClass.reasons], [noneClass.state, noneClass.reasons], "and the draft classifies as one with no dependency");
});

test("W1-T14296 criterion 3: on the repository's own plan the index omits every merged or done id and keeps every other in order", (t) => {
  // The daemon's own planText shape (run-task's inbox draft wiring): the composed plan, re-serialised.
  const plan = loadPlan(join(REPO_ROOT, "plan", "tasks.yaml"));
  const planText = stringifyYaml(plan.tasks);
  const landed = plan.tasks.filter((task) => task.status === "merged" || task.status === "done").map((task) => task.id);
  const open = plan.tasks.filter((task) => task.status !== "merged" && task.status !== "done").map((task) => task.id);
  assert.ok(landed.length > 0 && open.length > 0, `control: the plan must hold landed (${landed.length}) and open (${open.length}) tasks`);

  const index = planProjectionForDependsOn(planText);
  const ids = projectedIds(index);
  assert.deepEqual(ids, open, "every open id, in plan order, and nothing else");
  const projected = new Set(ids);
  assert.deepEqual(landed.filter((id) => projected.has(id)), [], "no merged or done id may reach the index");
  t.diagnostic(`plan tasks=${plan.tasks.length} landed=${landed.length} open=${open.length} index_bytes=${Buffer.byteLength(index, "utf8")}`);
});

test("W1-T14296 criterion 4: invariant:a-plan-with-no-landed-task-projects-as-today", async () => {
  assert.equal(planProjectionForDependsOn(OPEN_ONLY_PLAN), OPEN_ONLY_INDEX, "the projection is origin/main's text");
  for (const proposal of [PLAIN_PROPOSAL, NAMING_PROPOSAL]) {
    const prompt = inboxDraftPrompt(proposal, OPEN_ONLY_PLAN, "run-index");
    const ground = prompt.slice(prompt.indexOf("=== GROUND ==="), prompt.indexOf("=== TASK IDS") + "=== TASK IDS".length);
    assert.equal(ground, OPEN_ONLY_GROUND, `${proposal.id}: the GROUND block is origin/main's text, with no open-only sentence`);
    const { prompts } = await draftOnce([proposal], OPEN_ONLY_PLAN, "no markers");
    assert.equal(prompts.get(proposal.id), prompt, `${proposal.id}: runDraftRung sends the same prompt`);
  }
});
