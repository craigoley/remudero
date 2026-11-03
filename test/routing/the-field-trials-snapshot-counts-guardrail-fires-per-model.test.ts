/**
 * W1-T10877 — the field-trials snapshot counts guardrail fires per model.
 *
 * Truncations, refused formats, dirty drafts, exhausted fix rounds and unnamed served models were
 * scattered across ledger rows with no per-model rate. The snapshot's private `guardrails` family
 * counts fires and opportunities per (model, public category, public guardrail class), through the
 * one public vocabulary (src/lib/public-model-vocabulary.ts), from attributable attempts only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { buildFieldTrialsFlowSnapshot, projectFlowRow, type FieldTrialsLedgerRead } from "#src/lib/field-trials-flow.js";
import { emptyRepoStore } from "#src/lib/field-trials-github.js";
import { laneMappedExplicitly, PUBLIC_CATEGORIES, PUBLIC_GUARDRAIL_CLASSES, GUARDRAIL_SIGNALS, publicCategoryOfLane,
  publicGuardrailClassOf } from "#src/lib/public-model-vocabulary.js";
import { CODEX_SERVED_MODEL_REASON, OpenWeightRequestTooLargeError, OpenWeightTruncatedReplyError } from "#src/lib/worker-provider.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const T = (day: number, hour = 0) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();

test("W1-T10877: the public vocabulary is exactly the contract lists", () => {
  assert.deepEqual([...PUBLIC_CATEGORIES], ["repository-change", "code-review", "short-judgment", "summarization",
    "long-context-drafting", "diagnosis-triage"]);
  assert.deepEqual([...PUBLIC_GUARDRAIL_CLASSES], ["independent-model-review", "executable-acceptance-checks",
    "schema-validated-output", "deterministic-sampling", "context-and-rate-fit", "output-cap-truncation-check",
    "bounded-retry-then-escalate", "served-model-verification", "strongest-model-for-high-risk", "per-lane-budget-cap"]);
  // Every signal lands in the closed list, and only the two route properties are never fired by a signal.
  const fired = new Set(GUARDRAIL_SIGNALS.map((signal) => publicGuardrailClassOf(signal)));
  for (const cls of fired) assert.ok(cls !== null && (PUBLIC_GUARDRAIL_CLASSES as readonly string[]).includes(cls), String(cls));
  assert.deepEqual(PUBLIC_GUARDRAIL_CLASSES.filter((cls) => !fired.has(cls)), ["independent-model-review", "executable-acceptance-checks"]);
  assert.equal(publicGuardrailClassOf("truncated-reply"), "output-cap-truncation-check");
  assert.equal(publicGuardrailClassOf("served-model-unnamed"), "served-model-verification");
  // An internal mechanism name the table does not know is never mapped onto a public class.
  assert.equal(publicGuardrailClassOf("OpenWeightTruncatedReplyError"), null);
  assert.equal(publicGuardrailClassOf("toString"), null);
});

test("W1-T10877: every routed lane maps to a public category or explicitly to none", () => {
  const mounts = parse(readFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), "utf8")) as Record<string, unknown>;
  const keys = (value: unknown) => value !== null && typeof value === "object" ? Object.keys(value) : [];
  const rows = Object.entries(mounts).filter(([, value]) => typeof (value as { model?: unknown } | null)?.model === "string")
    .map(([key]) => key);
  const lanes = [...keys(mounts.routes), ...keys(mounts.synthesis), ...rows];
  // Positive control: the walk saw the routes table, the synthesis rows and the standalone mount rows.
  for (const known of ["implement", "reviewer", "inbox_draft", "triage", "escalation_judge", "architect"]) {
    assert.ok(lanes.includes(known), `the routing walk saw ${known}`);
  }
  for (const lane of lanes) {
    assert.ok(laneMappedExplicitly(lane), `${lane} is mapped to a public category or explicitly to null`);
    const category = publicCategoryOfLane(lane);
    assert.ok(category === null || (PUBLIC_CATEGORIES as readonly string[]).includes(category), `${lane} -> ${category}`);
  }
  assert.equal(publicCategoryOfLane("implement"), "repository-change");
  assert.equal(publicCategoryOfLane("inbox_draft"), "long-context-drafting");
  assert.equal(publicCategoryOfLane("escalation_judge"), "short-judgment");
  // A lane nobody mapped is never published by default.
  assert.equal(laneMappedExplicitly("brand-new-lane"), false);
  assert.equal(publicCategoryOfLane("brand-new-lane"), null);
  for (const unpublished of ["containment", "isolation", "worker-smoke"]) {
    assert.equal(laneMappedExplicitly(unpublished), true);
    assert.equal(publicCategoryOfLane(unpublished), null);
  }
  assert.equal(publicCategoryOfLane(null), null);
});

function observedRead(rows: Record<string, unknown>[]): FieldTrialsLedgerRead {
  return { state: "observed", reason: null, forms: { gzip: 0, plain: 0, live: 1 }, malformedRows: 0, duplicateRows: 0, futureRows: 0,
    unreadSources: 0, newestTs: null, rows: rows.map((row, i) => projectFlowRow(row, `fp-${i}`)) };
}

/** A dispatch assignment: its lane rides the benchmark receipt's task shape, as run-task writes it. */
function dispatched(id: string, model: string): Record<string, unknown> {
  return { ts: T(10), step: "worker.assignment", host: "host-a", task_id: `task-${id}`, run_id: `run-${id}`,
    worker_assignment: { id, selected: { provider: "codex", model, effort: "high" } },
    benchmark_run: { work: { shape: { lane: { state: "observed", value: "run-task" } } } } };
}

function attempt(id: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { ts: T(10, 1), step: "worker.attempt", host: "host-a", task_id: `task-${id}`, run_id: `run-${id}`,
    selection_assignment_id: id, ...fields };
}

const TOKENS = { input: 1200, output: 300 };

function fixRound(id: string, model: string, fields: Record<string, unknown> = {}): Record<string, unknown>[] {
  const receipt = { host: "host-a", task_id: "task-fix", run_id: "fix-run", repair_round_id: id,
    worker_run_id: `worker-${id}`, worker_rung: "fix", selection_assignment_id: `selection-${id}` };
  return [
    { ts: T(10, 4), step: "worker.attempt", ...receipt, success: true, served_model: model, tokens: TOKENS, ...fields },
    { ts: T(10, 5), step: "fix.done", ...receipt, round_id: id, requested_model: "sonnet", served_model: model },
  ];
}

function snapshotOf(rows: Record<string, unknown>[], prior?: ReturnType<typeof buildFieldTrialsFlowSnapshot>) {
  return buildFieldTrialsFlowSnapshot({ asOf: T(11), sources: [{ label: "core", repo: "acme/core", ledger: observedRead(rows) }],
    github: { version: "field-trials-github-v1", repos: { "acme/core": emptyRepoStore() } }, ...(prior ? { prior } : {}) });
}

test("W1-T10877: guardrail fires are counted per model, category and class", () => {
  const sol = "gpt-6.1-sol";
  const sonnet = "claude-sonnet-5-5";
  const rows: Record<string, unknown>[] = [
    // Three attributable Sol attempts: a clean success, a truncated reply, and a success whose served model is unnamed.
    dispatched("a1", sol), attempt("a1", { success: true, served_model: sol, tokens: TOKENS }),
    dispatched("a2", sol), attempt("a2", { success: false, served_model: sol, tokens: TOKENS,
      error_class: OpenWeightTruncatedReplyError.name }),
    dispatched("a3", sol), attempt("a3", { success: true, served_model: null, served_model_reason: CODEX_SERVED_MODEL_REASON,
      tokens: TOKENS }),
    // A pre-request refusal and an infrastructure kill are not the model's: neither a fire nor an opportunity.
    dispatched("a4", sol), attempt("a4", { success: false, served_model: null, worker_failure: "spawn-threw-before-result",
      error_class: OpenWeightRequestTooLargeError.name }),
    dispatched("a5", sol), attempt("a5", { success: false, served_model: null, worker_exit: "signal", worker_exit_signal: "SIGKILL" }),
    // A non-dispatch review attempt that broke the draft contract.
    { ts: T(10, 2), step: "worker.attempt", lane: "review", task_id: "REVIEW", run_id: "review-1", selection_assignment_id: "r1",
      success: false, served_model: sonnet, worker_failure: "draft-contract", tokens: TOKENS },
    // Unpublished, unmapped and draft-unit lanes never count as attempts.
    { ts: T(10, 2), step: "worker.attempt", lane: "containment", run_id: "c-1", selection_assignment_id: "c1", success: true, served_model: sonnet },
    { ts: T(10, 2), step: "worker.attempt", lane: "brand-new-lane", run_id: "n-1", selection_assignment_id: "n1", success: true, served_model: sonnet },
    { ts: T(10, 2), step: "worker.attempt", lane: "inbox-draft", run_id: "d-1", selection_assignment_id: "d1", success: true, served_model: null },
    // Drafts are the long-context-drafting unit: a dirty draft, and a clean one whose served model is unnamed.
    { ts: T(10, 3), step: "inbox.drafted", proposal_id: "p1", requested_model: "haiku", served_model: "gpt-oss-120b", lint_clean: false },
    { ts: T(10, 3), step: "inbox.drafted", proposal_id: "p2", requested_model: "haiku", served_model: null,
      served_model_reason: "the provider reported no served model for this call", lint_clean: true },
    // Fix rows join their own worker receipts. Refusal + done + exhaustion still describe one round.
    ...fixRound("f1", sonnet),
    { ts: T(10, 5), step: "fix.commit_refused", host: "host-a", task_id: "task-fix", run_id: "fix-run",
      round_id: "f1", requested_model: "sonnet", served_model: sonnet },
    { ts: T(10, 6), step: "fix.exhausted", host: "host-a", task_id: "task-fix", run_id: "fix-run",
      requested_model: "sonnet", served_model: sonnet },
    ...fixRound("f2", sonnet).map((row) => ({ ...row, ts: T(10, row.step === "worker.attempt" ? 7 : 8) })),
    { ts: T(10, 4), step: "fix.done", task_id: "task-f3", run_id: "fix-3" },
  ];
  const snapshot = snapshotOf(rows);
  const cells = Object.fromEntries(Object.entries(snapshot.families.guardrails).map(([key, partition]) => [key, partition.cells]));
  const cell = (modelId: string, category: string, guardrailClass: string, opportunities: number, fires: number) =>
    [`${modelId}|${category}|${guardrailClass}`, { modelId, category, guardrailClass, opportunities, fires }] as const;
  assert.deepEqual(cells, Object.fromEntries([
    cell(sonnet, "code-review", "output-cap-truncation-check", 1, 0),
    cell(sonnet, "code-review", "schema-validated-output", 1, 1),
    cell(sonnet, "code-review", "served-model-verification", 1, 0),
    cell(sonnet, "repository-change", "bounded-retry-then-escalate", 2, 1),
    cell(sonnet, "repository-change", "output-cap-truncation-check", 2, 0),
    cell(sonnet, "repository-change", "schema-validated-output", 2, 0),
    cell(sonnet, "repository-change", "served-model-verification", 2, 0),
    cell(sol, "repository-change", "output-cap-truncation-check", 3, 1),
    cell(sol, "repository-change", "schema-validated-output", 3, 0),
    cell(sol, "repository-change", "served-model-verification", 3, 1),
    cell("gpt-oss-120b", "long-context-drafting", "schema-validated-output", 1, 1),
    cell("gpt-oss-120b", "long-context-drafting", "served-model-verification", 1, 0),
    cell("haiku", "long-context-drafting", "schema-validated-output", 1, 0),
    cell("haiku", "long-context-drafting", "served-model-verification", 1, 1),
  ].sort(([a], [b]) => a.localeCompare(b))));
  assert.ok(snapshot.rebuild.rebuiltPartitions.includes(`guardrails:${sol}|repository-change|output-cap-truncation-check`));
  // The family follows the rebuild pattern: an unchanged ledger reuses every guardrail partition verbatim.
  const again = snapshotOf(rows, snapshot);
  assert.equal(again.rebuild.rebuiltPartitions.some((key) => key.startsWith("guardrails:")), false);
  assert.deepEqual(again.families.guardrails, snapshot.families.guardrails);
  // The family is private: the internal lane and mechanism names never appear in it.
  const text = JSON.stringify(snapshot.families.guardrails);
  for (const internal of ["run-task", "inbox-draft", "fix.exhausted", OpenWeightTruncatedReplyError.name, "draft-contract\""]) {
    assert.equal(text.includes(internal), false, internal);
  }
});

test("W1-T10877: fix opportunities exclude infrastructure, refusals, unknown and missing attempts", () => {
  const model = "claude-sonnet-5-5";
  const excluded = [
    { success: false, worker_exit: "signal", worker_exit_signal: "SIGKILL" },
    { success: false, worker_failure: "orphaned-by-process-exit" },
    { success: false, served_model: null, tokens: {}, error_class: OpenWeightRequestTooLargeError.name },
    { success: false, served_model: null, tokens: {} },
    { success: null },
  ];
  for (const [index, fields] of excluded.entries()) {
    const rows = [...fixRound("control", model), ...fixRound(`excluded-${index}`, model, fields)];
    rows.push({ ts: T(10, 6), step: "fix.exhausted", host: "host-a", task_id: "task-fix", run_id: "fix-run",
      round_id: `excluded-${index}`, requested_model: "sonnet", served_model: model });
    const cell = snapshotOf(rows).families.guardrails[`${model}|repository-change|bounded-retry-then-escalate`]?.cells;
    assert.deepEqual(cell, { modelId: model, category: "repository-change",
      guardrailClass: "bounded-retry-then-escalate", opportunities: 1, fires: 0 }, JSON.stringify(fields));
  }
  const [, done] = fixRound("no-attempt", model);
  assert.deepEqual(snapshotOf([done!]).families.guardrails, {});
  // A terminal signal is authoritative even when a worker receipt reports a success envelope.
  const signalled = fixRound("signal", model);
  signalled[1] = { ...signalled[1], worker_exit: "signal", worker_exit_signal: "SIGTERM" };
  assert.equal(snapshotOf(signalled).families.guardrails[`${model}|repository-change|bounded-retry-then-escalate`], undefined);
});

test("W1-T10877: fix events consolidate by round and cannot borrow another run's attribution", () => {
  const model = "claude-sonnet-5-5";
  const rows = fixRound("round-1", model, { success: false, worker_failure: "draft-contract" });
  rows.push({ ...rows[1], step: "fix.commit_refused" }, { ...rows[1], step: "fix.stood_down" },
    { ...rows[1], step: "fix.exhausted", ts: T(10, 6) });
  const key = `${model}|repository-change|bounded-retry-then-escalate`;
  const expected = { modelId: model, category: "repository-change", guardrailClass: "bounded-retry-then-escalate",
    opportunities: 1, fires: 1 };
  const snapshot = snapshotOf(rows);
  assert.deepEqual(snapshot.families.guardrails[key]?.cells, expected);
  assert.deepEqual(snapshotOf([...rows].reverse()).families.guardrails[key]?.cells, expected);
  // Older receipts can join by worker or assignment id when round fields are absent.
  for (const identity of ["worker_run_id", "selection_assignment_id"]) {
    const legacy = { ts: T(10, 6), step: "fix.exhausted", host: "host-a", task_id: "task-fix", run_id: "fix-run",
      [identity]: rows[0]![identity], requested_model: "sonnet", served_model: model };
    assert.deepEqual(snapshotOf([rows[0]!, legacy]).families.guardrails[key]?.cells, expected, identity);
  }
  const anonymous = rows.map((row) => ({ ...row, task_id: null, run_id: null }));
  assert.equal(snapshotOf([anonymous[0]!, { ts: T(10, 6), step: "fix.exhausted", host: "host-a",
    requested_model: "sonnet", served_model: model }]).families.guardrails[key], undefined);
  for (const field of ["host", "task_id", "run_id", "round_id"]) {
    const foreign = { ...rows[1], [field]: "another", step: "fix.exhausted" };
    assert.equal(snapshotOf([rows[0]!, foreign]).families.guardrails[key], undefined, field);
  }
  // A later infrastructure result in the same round cannot reuse an earlier model fallback.
  const killed = { ...rows[0], ts: T(10, 5), success: false, worker_failure: "spawn-threw-before-result",
    worker_exit: "signal", worker_exit_signal: "SIGKILL" };
  const repaired = snapshotOf([rows[0]!, killed, ...rows.slice(1)], snapshot);
  assert.equal(repaired.families.guardrails[key], undefined);
  assert.deepEqual(snapshotOf(rows, repaired).families.guardrails[key]?.cells, expected);
});
