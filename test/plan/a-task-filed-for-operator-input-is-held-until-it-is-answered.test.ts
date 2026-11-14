import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { nextRunnable, runnableCandidates } from "#src/lib/drain.js";
import { consumeHumanGateCounts, projectHeldTaskQuestionGates, projectHumanGates, renderHeldTaskQuestions } from "#src/lib/human-gate.js";
import { assertRunnable, loadPlanFromYaml, TaskAdmissionError, type Plan } from "#src/lib/plan.js";
import { renderImplementPrompt } from "#src/lib/prompt-render.js";
import { lintTask } from "#src/lib/task-linter.js";
import { appendQuestionAnswer, renderTaskInputAnswer, taskInputAnswer } from "#src/lib/worker.js";

const QUESTION = "Which retry bound should the sweep use: 3 or 5 passes?";
const SHARD = "plan/tasks.d/W1-T90001-held.yaml";

function shard(extra: string, status = "queued"): string {
  return `- id: W1-T90001
  title: "a held fixture task"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: low
  status: ${status}
  origin: architect
  files: [src/lib/plan.ts]
${extra}`;
}

const NEEDS_INPUT = `  needs_input:
    question: "${QUESTION}"
    source_pr: "#18449"
    asked_at: "2026-11-14T20:00:00Z"
`;

function planOf(extra: string, status?: string): Plan {
  return loadPlanFromYaml(shard(extra, status), SHARD);
}

function withStore(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "rmd-held-task-"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

const notMerged = () => false;

function answer(root: string, text: string): void {
  assert.equal(appendQuestionAnswer(root, { ts: "2026-11-14T21:00:00Z", task: "W1-T90001", answer: text, origin: "fixture" }), true);
}

test("W1-T12715 criterion 1: a held task with no answer is never returned by nextRunnable and is refused by assertRunnable", () => {
  withStore((root) => {
    const plan = planOf(NEEDS_INPUT);
    const task = plan.byId.get("W1-T90001")!;
    assert.equal(task.needs_input?.question, QUESTION, "the loader keeps the needs_input block");
    const inputAnswer = (id: string) => taskInputAnswer(root, id);
    const unmet: unknown[] = [];
    assert.equal(nextRunnable(plan, notMerged, { inputAnswer, onPreconditionUnmet: (_t, u) => unmet.push(u) }), undefined);
    assert.deepEqual(unmet, [{ reason: "needs-input", question: QUESTION, source_pr: "#18449" }]);
    assert.equal(runnableCandidates(plan, notMerged, 4, { inputAnswer }).length, 0, "the daemon's selector holds it too");
    assert.equal(nextRunnable(plan, notMerged), undefined, "with no answer port the task stays held");
    assert.throws(() => assertRunnable(plan, task, () => true, undefined, inputAnswer),
      (e: unknown) => e instanceof TaskAdmissionError && e.message.includes(`needs-input: ${QUESTION}`));
    assert.throws(() => assertRunnable(plan, task), TaskAdmissionError, "with no answer port assertRunnable refuses");
  });
});

test("W1-T12715 criterion 2: once the question store has an ANSWER the task runs and the build prompt carries the answer", () => {
  withStore((root) => {
    const plan = planOf(NEEDS_INPUT);
    const task = plan.byId.get("W1-T90001")!;
    answer(root, "an older answer");
    appendQuestionAnswer(root, { ts: "2026-11-14T22:00:00Z", task: "W1-T90001", answer: "Use 5 passes.", origin: "fixture" });
    appendQuestionAnswer(root, { ts: "2026-11-14T23:00:00Z", task: "W1-T90002", answer: "another task's answer", origin: "fixture" });
    const inputAnswer = (id: string) => taskInputAnswer(root, id);
    assert.equal(inputAnswer("W1-T90001"), "Use 5 passes.", "the newest answer for this task wins");
    assert.equal(nextRunnable(plan, notMerged, { inputAnswer })?.id, "W1-T90001");
    assert.doesNotThrow(() => assertRunnable(plan, task, () => true, undefined, inputAnswer));
    const block = renderTaskInputAnswer(task, inputAnswer(task.id));
    assert.match(block, /^- Operator answer to "Which retry bound/);
    const prompt = renderImplementPrompt(task, "", "RUN-1", "", block);
    assert.ok(prompt.includes("Use 5 passes."), "the build prompt carries the answer text");
    assert.ok(prompt.includes("[src: operator#answer@W1-T90001]"), "the answer line is cited for the provenance gate");
  });
});

test("W1-T12715 criterion 3: a task with no needs_input block dispatches exactly as before", () => {
  withStore((root) => {
    const plan = planOf("");
    const task = plan.byId.get("W1-T90001")!;
    assert.equal("needs_input" in task, false, "the loader adds no key to a task without the block");
    let reads = 0;
    const inputAnswer = (id: string) => { reads++; return taskInputAnswer(root, id); };
    assert.equal(nextRunnable(plan, notMerged, { inputAnswer })?.id, nextRunnable(plan, notMerged)?.id);
    assert.equal(nextRunnable(plan, notMerged)?.id, "W1-T90001");
    assert.doesNotThrow(() => assertRunnable(plan, task, () => true, undefined, inputAnswer));
    assert.doesNotThrow(() => assertRunnable(plan, task));
    assert.equal(reads, 0, "the answer store is never read for a task with no question");
    assert.equal(renderTaskInputAnswer(task, "an answer"), "", "no answer line reaches the prompt");
  });
});

test("W1-T12715 criterion 4: each held task is one task_question gate for the inbox, with the question and the source pull request", () => {
  withStore((root) => {
    const plan = planOf(NEEDS_INPUT);
    const inputAnswer = (id: string) => taskInputAnswer(root, id);
    const gates = projectHeldTaskQuestionGates(plan.tasks, inputAnswer, "craigoley/remudero");
    assert.equal(gates.length, 1);
    const [gate] = gates;
    assert.equal(gate.kind, "task_question");
    assert.equal(gate.ownerSurface, "inbox");
    assert.equal(gate.subject, "W1-T90001");
    assert.equal(gate.resolutionVerb, "answer");
    assert.ok(gate.reason.includes(QUESTION) && gate.reason.includes("#18449"), gate.reason);
    assert.equal(gate.url, `https://github.com/craigoley/remudero/blob/main/${SHARD}`);
    const counts = consumeHumanGateCounts(projectHumanGates([{ name: "task-questions", instance: "core", state: "complete", gates }]));
    assert.deepEqual(counts.inbox, { count: 1 });
    assert.equal(counts.byKind.task_question, 1);
    const printed = renderHeldTaskQuestions(gates);
    assert.ok(printed.includes("W1-T90001") && printed.includes(QUESTION) && printed.includes("#18449"), printed);
    answer(root, "Use 3 passes.");
    assert.equal(projectHeldTaskQuestionGates(plan.tasks, inputAnswer).length, 0, "an answered task leaves the inbox");
    assert.equal(renderHeldTaskQuestions([]), "", "rmd inbox prints nothing extra when nothing is held");
  });
});

test("W1-T12715 criterion 5: the task linter refuses an empty question and a needs_input block on a task that is not queued", () => {
  const ok = planOf(NEEDS_INPUT).byId.get("W1-T90001")!;
  assert.equal(lintTask(ok).violations.filter((v) => v.check === "needs-input").length, 0);
  const empty = planOf(NEEDS_INPUT.replace(QUESTION, " ")).byId.get("W1-T90001")!;
  const emptyFindings = lintTask(empty).violations.filter((v) => v.check === "needs-input");
  assert.equal(emptyFindings.length, 1);
  assert.equal(emptyFindings[0].severity, "block");
  assert.match(emptyFindings[0].message, /empty question/);
  const notQueued = planOf(NEEDS_INPUT + "  retirement: withdrawn\n", "blocked").byId.get("W1-T90001")!;
  const statusFindings = lintTask(notQueued).violations.filter((v) => v.check === "needs-input");
  assert.equal(statusFindings.length, 1);
  assert.equal(statusFindings[0].severity, "block");
  assert.match(statusFindings[0].message, /status: blocked/);
});
