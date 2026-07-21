import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Plan, Task } from "../src/lib/plan.js";
import { projectPlan, type DeriveDeps, type GitHub } from "../src/lib/status.js";
import { FIXED_NOW_ISO, corpusLedgerPath, loadCorpusGithub, loadCorpusLedgerLines, loadCorpusPlan } from "./fixtures/w1-t187/load.js";

/**
 * W1-T187 acceptance criterion 2 — "projectPlan reads and parses the ledger EXACTLY ONCE per
 * projection, not once per task". Proof required: "unit test with an instrumented readLedger
 * counting invocations: projecting a plan of N tasks calls it exactly 1 time, for N > 1."
 *
 * FALSIFIER this guards: projectPlan pre-fix called deriveStatus per task and each opened with
 * `readLedger(deps.ledgerPath)`, so a 218-task plan over an 18,141-line ledger performed
 * ~3.95 million line-parses per projection (readLedger invoked once per task, N times, not once).
 */

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function noopGithub(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

function countingReader(lines: Array<Record<string, unknown>>): { calls: number; read: DeriveDeps["readLedger"] } {
  const counter = { calls: 0, read: undefined as unknown as DeriveDeps["readLedger"] };
  counter.read = (_path: string) => {
    counter.calls++;
    return lines;
  };
  return counter;
}

test("W1-T187 criterion 2: projectPlan invokes readLedger EXACTLY ONCE for a small (N=5) multi-task plan", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1t187-invcount-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const lines: Array<Record<string, unknown>> = [{ step: "run.start", task_id: "A", ts: FIXED_NOW_ISO }];
  const counter = countingReader(lines);
  const plan = planOf([task({ id: "A" }), task({ id: "B" }), task({ id: "C" }), task({ id: "D" }), task({ id: "E" })]);

  const byId = projectPlan(plan, { ledgerPath, github: noopGithub(), readLedger: counter.read });

  assert.equal(byId.size, 5);
  assert.equal(counter.calls, 1, `expected exactly 1 readLedger invocation for a 5-task plan, got ${counter.calls}`);
});

test("W1-T187 criterion 2: projectPlan invokes readLedger EXACTLY ONCE over the production-scale corpus (N=220 tasks, >= 18,000 ledger lines)", () => {
  const plan = loadCorpusPlan();
  const github = loadCorpusGithub();
  const lines = loadCorpusLedgerLines();
  assert.ok(plan.tasks.length > 1, "corpus must have N > 1 tasks for this proof to be meaningful");
  const counter = countingReader(lines);

  const byId = projectPlan(plan, {
    ledgerPath: corpusLedgerPath(),
    github,
    readLedger: counter.read,
    now: () => Date.parse(FIXED_NOW_ISO),
  });

  assert.equal(byId.size, plan.tasks.length);
  assert.equal(
    counter.calls,
    1,
    `expected exactly 1 readLedger invocation for a ${plan.tasks.length}-task plan over ${lines.length} ledger lines, got ${counter.calls} -- pre-fix this would have been ${plan.tasks.length}`,
  );
});
