/**
 * W1-T3344 — a filing-time ruling belongs to the complete execution contract the judge saw.
 *
 * The pin is computed before a task is persisted and checked after plan loading. These tests
 * therefore drive both the exported digest and the real YAML boundary; a hand-built Task alone
 * would repeat W1-T2968's vacuous wire proof.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { stringify as stringifyYaml } from "yaml";

import { parseTasksFromYaml, type Task, type TaskRiskRuling } from "../src/lib/plan.js";
import { recordFilingRiskRuling } from "../src/lib/risk-judge.js";
import { machineAuthorVerifyViolation, taskRulingPin } from "../src/lib/task-linter.js";

function authorityTask(): Task {
  return {
    id: "W1-TFIXTURE",
    title: "bind the filing-time ruling",
    repo: "remudero",
    depends_on: ["W1-T2", "W1-T1"],
    type: "implement",
    verify: "auto",
    risk: "high",
    band_meaning: "blast-radius",
    priority: 7,
    status: "queued",
    attempts: 2,
    principles: { tdd: "strict", nested: { beta: 2, alpha: 1 } },
    budget_usd: 12,
    acceptance: [
      {
        claim: "the ruling survives persistence",
        proof: "unit test: test/the-ruling-pin-binds-execution-authority.test.ts",
        satisfied_by: "#4994",
        holdout: true,
      },
    ],
    author_class: "machine",
    origin: "test#W1-T3344",
    prompt: "Implement only the authority-pin repair.",
    context: [
      { claim: "the producer sees plan references", src: "src/lib/risk-judge.ts:825" },
      { claim: "the consumer reloads the record", src: "src/lib/task-linter.ts:2020" },
    ],
    plan_refs: ["W1-T3143", "W1-T2977"],
    files: ["test/z.test.ts", "src/lib/z.ts"],
  } as Task;
}

function changed(base: Task, field: string): Task {
  const criterion = base.acceptance![0];
  const changes: Record<string, () => Task> = {
    id: () => ({ ...base, id: "W1-TOTHER" }),
    title: () => ({ ...base, title: "a different execution contract" }),
    repo: () => ({ ...base, repo: "another-repo" }),
    depends_on: () => ({ ...base, depends_on: [...base.depends_on, "W1-T3"] }),
    type: () => ({ ...base, type: "recon" }),
    verify: () => ({ ...base, verify: "human" }),
    risk: () => ({ ...base, risk: "medium" }),
    band_meaning: () => ({ ...base, band_meaning: "span" }),
    priority: () => ({ ...base, priority: 8 }),
    principles: () => ({ ...base, principles: { ...base.principles, tdd: "pragmatic" } }),
    budget_usd: () => ({ ...base, budget_usd: 13 }),
    author_class: () => ({ ...base, author_class: "operator" }),
    prompt: () => ({ ...base, prompt: "A changed worker instruction." }),
    context: () => ({
      ...base,
      context: [...(base.context ?? []), { claim: "new context", src: "src/lib/plan.ts:1" }],
    }),
    plan_refs: () => ({ ...base, plan_refs: [...(base.plan_refs ?? []), "W1-T3336"] }),
    files: () => ({ ...base, files: [...(base.files ?? []), "src/lib/plan.ts"] }),
    "acceptance.claim": () => ({
      ...base,
      acceptance: [{ ...criterion, claim: "a changed proof duty" }],
    }),
    "acceptance.proof": () => ({
      ...base,
      acceptance: [{ ...criterion, proof: "grep: changed in src/lib/task-linter.ts" }],
    }),
    "acceptance.satisfied_by": () => ({
      ...base,
      acceptance: [{ ...criterion, satisfied_by: "#5000" }],
    }),
    "acceptance.holdout": () => ({
      ...base,
      acceptance: [{ ...criterion, holdout: false }],
    }),
  };
  const mutation = changes[field];
  assert.ok(mutation, `fixture must define an authority mutation for ${field}`);
  return mutation();
}

test("W1-T3344 each execution-authority field changes the ruling pin and narrative fields do not", () => {
  const base = authorityTask();
  const authorityFields = [
    "id",
    "title",
    "repo",
    "depends_on",
    "type",
    "verify",
    "risk",
    "band_meaning",
    "priority",
    "principles",
    "budget_usd",
    "author_class",
    "prompt",
    "context",
    "plan_refs",
    "files",
    "acceptance.claim",
    "acceptance.proof",
    "acceptance.satisfied_by",
    "acceptance.holdout",
  ];

  for (const field of authorityFields) {
    assert.notEqual(
      taskRulingPin(base),
      taskRulingPin(changed(base, field)),
      `${field} changes authority and must invalidate the ruling`,
    );
  }

  const ruling: TaskRiskRuling = {
    verdict: "low",
    action: "proceed",
    confidence: 0.9,
    reasons: ["bounded change"],
    judged_at: "2026-09-10T20:00:00.000Z",
    pin: "0".repeat(64),
  } as unknown as TaskRiskRuling;
  const exclusions: Array<[string, Task]> = [
    ["note", { ...base, note: "operator note" }],
    ["rationale", { ...base, rationale: "changed rationale" }],
    ["design", { ...base, design: "changed design" } as Task],
    ["falsifier", { ...base, falsifier: "changed falsifier" } as Task],
    ["origin", { ...base, origin: "another-origin" }],
    ["hand_built", { ...base, hand_built: true }],
    ["attempts", { ...base, attempts: 99 }],
    ["pr", { ...base, pr: 5003 }],
    ["status", { ...base, status: "running" }],
    ["retirement", { ...base, retirement: "retired" }],
    ["sourcePath", { ...base, sourcePath: "plan/tasks.d/other.yaml" }],
    ["risk_ruling", { ...base, risk_ruling: ruling }],
  ];

  for (const [field, candidate] of exclusions) {
    assert.equal(taskRulingPin(candidate), taskRulingPin(base), `${field} must stay outside the authority pin`);
  }
});

test("W1-T3344 set-like authority fields and structured values have deterministic pins", () => {
  const base = authorityTask();
  const reordered: Task = {
    ...base,
    depends_on: [...base.depends_on].reverse(),
    plan_refs: [...(base.plan_refs ?? [])].reverse(),
    files: [...(base.files ?? [])].reverse(),
    principles: { nested: { alpha: 1, beta: 2 }, tdd: "strict" },
    context: base.context?.map((entry) => ({ src: entry.src, claim: entry.claim })),
  } as unknown as Task;

  assert.equal(taskRulingPin(reordered), taskRulingPin(base));
  for (const field of ["depends_on", "plan_refs", "files", "principles", "context"]) {
    assert.notEqual(
      taskRulingPin(changed(base, field)),
      taskRulingPin(base),
      `${field} must contribute before its ordering can be called deterministic`,
    );
  }
});

test("W1-T3344 section markers prevent adjacent set-like fields from aliasing", () => {
  const base = authorityTask();
  assert.notEqual(
    taskRulingPin({ ...base, depends_on: ["a"], plan_refs: ["b"], files: ["c"] }),
    taskRulingPin({ ...base, depends_on: ["a", "b"], plan_refs: [], files: ["c"] }),
    "depends_on and plan_refs must have distinct digest sections",
  );
  assert.notEqual(
    taskRulingPin({ ...base, depends_on: ["a"], plan_refs: ["b"], files: ["c"] }),
    taskRulingPin({ ...base, depends_on: ["a"], plan_refs: ["b", "c"], files: [] }),
    "plan_refs and files must have distinct digest sections",
  );
});

test("W1-T3344 proofless architect criteria are pinned without throwing", () => {
  const proofless = {
    ...authorityTask(),
    acceptance: [{ claim: "already satisfied", satisfied_by: "#4994" }],
  } as Task;
  assert.doesNotThrow(() => taskRulingPin(proofless));
  assert.equal(taskRulingPin(proofless), taskRulingPin({ ...proofless }));
  assert.notEqual(
    taskRulingPin(proofless),
    taskRulingPin({ ...proofless, acceptance: [{ claim: "already satisfied", satisfied_by: "#5000" }] } as Task),
  );
});

test("W1-T3344 the corrected pin remains shared by the filing helper and Law 5 consumer", () => {
  const raw = authorityTask();
  const ruled = recordFilingRiskRuling(
    raw,
    {
      verdict: "low",
      action: "proceed",
      confidence: 0.92,
      reasons: ["the execution contract is bounded"],
      judgedAt: "2026-09-10T20:00:00.000Z",
    },
    taskRulingPin,
  );
  const loaded = parseTasksFromYaml(stringifyYaml([ruled]), "W1-T3344-round-trip")[0];

  assert.deepEqual(loaded.plan_refs, raw.plan_refs, "plan_refs must survive the real loader");
  assert.equal(taskRulingPin(loaded), taskRulingPin(raw), "persistence must not make a fresh ruling stale");
  assert.equal(machineAuthorVerifyViolation(loaded), undefined, "Law 5 must accept the persisted matching ruling");
});
