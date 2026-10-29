import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "#src/lib/plan.js";
import { renderImplementPrompt, renderImplementPromptWithParts } from "#src/lib/prompt-render.js";
import { judgeReview } from "#src/lib/review.js";

const task = {
  id: "W1-T10661", title: "repair the worker", repo: "remudero", depends_on: [],
  type: "implement", verify: "auto", risk: "low", status: "queued", attempts: 0,
  files: ["src/lib/prompt-render.ts"],
  acceptance: [
    { claim: "login failure is observable", proof: "unit test: a Claude login that cannot reach the fleet store answers unavailable and creates nothing" },
    { claim: "preserve the fallback", proof: "grep: disconnected-provider src/worker.ts" },
  ],
} satisfies Task;

test("W1-T10661: check:body-coverage is prevented, not retried", () => {
  const { prompt } = renderImplementPromptWithParts(task, "", "run", "", "", "", "", true);
  const report = prompt.split("# ACCEPTANCE REPORT\n")[1]?.split("\n# OUTPUT CONTRACT")[0];
  assert.ok(report, "the initial implement prompt supplies a report scaffold before any fix round");
  for (const criterion of task.acceptance) {
    assert.ok(report.includes(criterion.claim));
    assert.ok(report.includes(criterion.proof));
  }
  const review = (body: string) => judgeReview(task.acceptance, { diff: "", report: body });
  assert.ok(review("updated the worker").criteria.every((c) => !c.met), "control: omitted proofs fail the real coverage floor");
  assert.ok(review(report).criteria.every((c) => c.floorMet), "the supplied scaffold addresses every proof before review");
  assert.match(report, /OBSERVED or NOT OBSERVED/);
  assert.match(report, /actual evidence/);
});

test("the acceptance report omits holdouts and is absent for tasks without visible criteria", () => {
  const hidden = { claim: "private claim", proof: "private proof", holdout: true };
  for (const harnessCommits of [false, true]) {
    const render = (acceptance: Task["acceptance"]) => renderImplementPrompt(
      { ...task, acceptance }, "", "run", "", "", "", "", harnessCommits,
    );
    const prompt = render([...task.acceptance, hidden]);
    assert.ok(!prompt.includes(hidden.claim));
    assert.ok(!prompt.includes(hidden.proof));
    assert.ok(!render([]).includes("# ACCEPTANCE REPORT"));
    assert.ok(!render([hidden]).includes("# ACCEPTANCE REPORT"));
  }
});
