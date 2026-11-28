import assert from "node:assert/strict";
import { test } from "node:test";

import {
  captureInboxDraftSnapshot,
  inboxDraftExampleFragmentYaml,
  inboxDraftPrompt,
  inboxDraftRelintPrompt,
  lintDraftedFragment,
  MAX_DRAFT_LINT_ATTEMPTS,
  runDraftRung,
  type DraftRungDeps,
  type Proposal,
} from "#src/lib/inbox.js";
import type { WorkerResult } from "#src/lib/worker.js";

// A redraft is a new session, so before this change every relint retry and escalation paid for the whole open-task
// index again: ~278K of a ~287K-char prompt. It now carries only the rows the failed fragment cites and the proposal
// names; state/DRAFT_RETRY_FULL_INDEX restores the full index.

const CITED_LINE = "This index lists only the tasks your last draft cited and the proposal names; Grep plan/tasks.yaml and plan/tasks.d/ for any other dependency.";

/** 1,000 tasks with long titles, every one open but W1-T5, the landed task the proposal names. */
const PLAN = Array.from({ length: 1000 }, (_, i) => [
  `- id: W1-T${i + 1}`,
  `  title: "open task ${i + 1}, whose title is a whole sentence carrying the defect it fixes, as titles here do"`,
  `  status: ${i + 1 === 5 ? "merged" : "queued"}`,
  "  type: implement",
  `  depends_on: [${i === 0 ? "" : `W1-T${i}`}]`,
].join("\n")).join("\n") + "\n";

const row = (n: number): string =>
  `- id: W1-T${n}\n  title: open task ${n}, whose title is a whole sentence carrying the defect it fixes, as titles here do\n` +
  `  status: ${n === 5 ? "merged" : "queued"}\n  type: implement\n  depends_on: ${n === 1 ? "" : `W1-T${n - 1}`}`;

const proposal: Proposal = { id: "P-cited", summary: "follow up on W1-T5, which shipped half the fix", evidenceAnchors: [] };
const stamp = "- P-cited (follow up) — RATIFIED 2026-01-01 -> NEW-1.";
const markers = (fragment: string) => `=== FRAGMENT START ===\n${fragment}\n=== FRAGMENT END ===\nSTAMP: ${stamp}`;
/** Dirty (a string acceptance), and it cites W1-T7 and W1-T9 plus a placeholder and an id the plan lacks. */
const DIRTY_FRAGMENT = "- id: NEW-1\n  title: x\n  depends_on: [W1-T7, W1-T9, NEW-2, W1-T99999]\n  acceptance: not a list";
const dirty = markers(DIRTY_FRAGMENT);
const clean = markers(inboxDraftExampleFragmentYaml());

function worker(model: string, text: string, provider?: WorkerResult["provider"]): WorkerResult {
  return {
    sessionId: `S-${model}`, costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
    permissionDenials: [], childEnvKeys: [], model, routedModel: model, effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
    ...(provider ? { provider } : {}),
  };
}

type Row = { step: string; extra: Record<string, unknown> };

/** Draft once dirty then clean, recording every prompt and every ledger row. */
async function dirtyThenClean(extra: Partial<DraftRungDeps> = {}): Promise<{ prompts: string[]; rows: Row[] }> {
  const prompts: string[] = [];
  const rows: Row[] = [];
  await runDraftRung([proposal], PLAN, {
    spawn: async (_proposal, prompt) => { prompts.push(prompt); return worker(`model-${prompts.length}`, prompts.length === 1 ? dirty : clean); },
    log: (step, fields = {}) => rows.push({ step, extra: fields }),
    ...extra,
  }, "run-cited");
  return { prompts, rows };
}

const synthesized = (rows: Row[]) => rows.filter((r) => r.step === "inbox.draft_synthesized").map((r) => r.extra);

function assertCited(prompt: string): void {
  assert.ok(prompt.includes(CITED_LINE), "the prompt says the index is cited");
  assert.ok(prompt.includes("A dependency on a merged or done task is already satisfied, so leave it out of depends_on."), "a cited redraft keeps the satisfied-dependency rule");
  for (const n of [5, 7, 9]) assert.ok(prompt.includes(row(n)), `the cited row W1-T${n} is carried whole`);
  for (const n of [1, 6, 8, 10, 150, 1000]) assert.ok(!prompt.includes(`- id: W1-T${n}\n`), `the uncited row W1-T${n} is left out`);
}

test("a relint retry carries the cited depends_on rows and no other, and is far shorter than the first prompt", async () => {
  const { prompts, rows } = await dirtyThenClean();
  assert.equal(prompts.length, 2);
  const [first, retry] = prompts as [string, string];
  assertCited(retry);
  assert.ok(retry.includes("The fragment you must fix:\n" + DIRTY_FRAGMENT), "the relint block still follows");
  assert.ok(retry.length * 5 < first.length, `retry ${retry.length} chars against first ${first.length}`);
  const [attempt1, attempt2] = synthesized(rows);
  assert.equal(attempt1!.retry_index, undefined, "the first attempt row gains no field");
  assert.equal(attempt2!.retry_index, "cited");
  assert.equal(attempt2!.plan_index_chars, [5, 7, 9].map(row).join("\n").length, "plan_index_chars counts the index that was sent");
  assert.equal(attempt2!.prompt_chars, retry.length);
});

test("the escalation after a dirty ladder carries the cited depends_on rows and no other", async () => {
  const prompts: string[] = [];
  const escalations: string[] = [];
  const rows: Row[] = [];
  await runDraftRung([proposal], PLAN, {
    spawn: async (_proposal, prompt) => { prompts.push(prompt); return worker("gpt-oss-120b", dirty); },
    escalate: async (_proposal, prompt) => { escalations.push(prompt); return worker("claude-sonnet-5-5", clean); },
    log: (step, fields = {}) => rows.push({ step, extra: fields }),
  }, "run-cited");
  assert.equal(prompts.length, MAX_DRAFT_LINT_ATTEMPTS);
  assert.equal(escalations.length, 1);
  const escalation = escalations[0]!;
  assertCited(escalation);
  assert.ok(escalation.length * 5 < prompts[0]!.length, `escalation ${escalation.length} chars against first ${prompts[0]!.length}`);
  const last = synthesized(rows).at(-1)!;
  assert.equal(last.attempt, MAX_DRAFT_LINT_ATTEMPTS + 1);
  assert.equal(last.retry_index, "cited");
  assert.equal(last.prompt_chars, escalation.length);
});

test("a cash resume of a relint carries the cited depends_on rows and no other", async () => {
  const scope = { repository: "acme/remudero" };
  const generation = captureInboxDraftSnapshot(proposal, scope).generation;
  const relint = inboxDraftRelintPrompt(proposal, DIRTY_FRAGMENT, lintDraftedFragment(DIRTY_FRAGMENT, proposal.id, stamp));
  const cashPrompts: string[] = [];
  const rows: Row[] = [];
  await runDraftRung([proposal], PLAN, {
    causalScope: scope,
    cashFit: () => ({ fits: true }),
    cashResumes: { [proposal.id]: { generation, attempt: 2, paidDeployments: [], avoidModels: [], relint: { from: "gpt-oss-120b", violations: [], prompt: relint } } },
    spawn: async (_proposal, _prompt, ctx) => { cashPrompts.push(ctx!.cashRetry!.prompt); return worker("gpt-oss-120b", clean, "cash"); },
    log: (step, fields = {}) => rows.push({ step, extra: fields }),
  }, "run-cited");
  assert.equal(cashPrompts.length, 1);
  assertCited(cashPrompts[0]!);
  assert.ok(cashPrompts[0]!.endsWith(`\n\n${relint}`));
  const [resumed] = synthesized(rows);
  assert.equal(resumed!.attempt, 2);
  assert.equal(resumed!.retry_index, "cited");
  assert.equal(resumed!.plan_index_chars, [5, 7, 9].map(row).join("\n").length);
});

test("state/DRAFT_RETRY_FULL_INDEX restores the full index on a relint retry and on the escalation", async () => {
  const { prompts, rows } = await dirtyThenClean({ retryFullIndex: true });
  const [first, retry] = prompts as [string, string];
  assert.ok(retry.startsWith(`${first}\n\n`), "the retry repeats the first prompt whole, as before");
  assert.ok(!retry.includes(CITED_LINE));
  const [attempt1, attempt2] = synthesized(rows);
  assert.equal(attempt2!.retry_index, "full");
  assert.equal(attempt2!.plan_index_chars, attempt1!.plan_index_chars);

  const ladder: string[] = [];
  const escalations: string[] = [];
  await runDraftRung([proposal], PLAN, {
    retryFullIndex: true,
    spawn: async (_proposal, prompt) => { ladder.push(prompt); return worker("gpt-oss-120b", dirty); },
    escalate: async (_proposal, prompt) => { escalations.push(prompt); return worker("claude-sonnet-5-5", clean); },
    log: () => undefined,
  }, "run-cited");
  assert.ok(escalations[0]!.startsWith(`${ladder.at(-1)}\n\n`), "the escalation stacks on the last full prompt, as before");
  assert.ok(escalations[0]!.startsWith(ladder[0]!));
});

test("the first draft attempt's prompt is unchanged by the cited redraft index", async () => {
  const { prompts } = await dirtyThenClean();
  const first = prompts[0]!;
  assert.equal(first, inboxDraftPrompt(proposal, PLAN, "run-cited"));
  assert.ok(!first.includes(CITED_LINE));
  for (const n of [1, 7, 150, 1000]) assert.ok(first.includes(row(n)), `the first prompt lists open row W1-T${n}`);
  const { prompts: rollback } = await dirtyThenClean({ retryFullIndex: true });
  assert.equal(rollback[0], first, "the flag does not touch the first attempt either");
});

test("a fragment whose depends_on cannot be parsed falls back to the ids the proposal names", async () => {
  const unparseable = "- id: NEW-1\n  title: [unclosed\n  depends_on: [W1-T7";
  const prompts: string[] = [];
  await runDraftRung([proposal], PLAN, {
    spawn: async (_proposal, prompt) => { prompts.push(prompt); return worker(`m${prompts.length}`, prompts.length === 1 ? markers(unparseable) : clean); },
    log: () => undefined,
  }, "run-cited");
  const retry = prompts[1]!;
  assert.ok(retry.includes(CITED_LINE));
  assert.ok(retry.includes(row(5)), "the named landed row stays");
  assert.ok(!retry.includes(row(7)), "an id only the unparseable fragment holds is not guessed at");
});
