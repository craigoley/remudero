import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
import {
  renderDiagnosePrompt,
  renderFixPrompt,
  renderImplementPrompt,
  renderPrerequisitePrPrompt,
  renderReconPrompt,
} from "../src/lib/prompt-render.js";
import {
  renderDiagnosePrompt as compatRenderDiagnosePrompt,
  renderFixPrompt as compatRenderFixPrompt,
  renderImplementPrompt as compatRenderImplementPrompt,
  renderPrerequisitePrPrompt as compatRenderPrerequisitePrPrompt,
  renderReconPrompt as compatRenderReconPrompt,
} from "../src/run-task.js";

const TASK: Task = {
  id: "W1-T2886X",
  title: "move prompt renderers",
  repo: "remudero",
  depends_on: [],
  type: "implement",
  risk: "high",
  verify: "auto",
  status: "queued",
  attempts: 0,
  context: [{ claim: "Recon observed the renderer locations", src: "recon#W1-T2886X" }],
  prompt: "Implement ${TASK_ID} during ${RUN_ID}",
  files: ["src/run-task.ts", "src/lib/prompt-render.ts", "test/prompt-render.test.ts"],
};

const UNMET = {
  claim: "the renderer moved",
  proof: "grep: lib/prompt-render in src/run-task.ts",
  met: false,
  reason: "renderFixPrompt still lives in the dispatcher",
  proof_exec: "not_executable",
} as const;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function contextLines(prompt: string): string[] {
  const [, afterContext = ""] = prompt.split("# CONTEXT\n");
  const [context = ""] = afterContext.split("\n\n# TASK");
  return context.split("\n").filter((line) => line.trim().length > 0);
}

test("prompt renderers: lib exports stay byte-identical to the pre-move dispatcher templates", () => {
  const fix = renderFixPrompt({
    task: TASK,
    round: 2,
    branch: "run-W1-T2886X-1700000000000",
    evidence: { review: { unmetCriteria: [UNMET], summary: "one criterion unmet" } },
    baselineDiffFiles: ["src/run-task.ts"],
  });
  const prerequisite = renderPrerequisitePrPrompt({
    task: TASK,
    branch: "run-W1-T2886X-1700000000000",
    prUrl: "https://github.com/craigoley/remudero/pull/2886",
    instrumentPaths: ["test/prompt-render.test.ts"],
    srcPaths: ["src/run-task.ts", "src/lib/prompt-render.ts"],
  });
  const recon = renderReconPrompt(
    "PLAN INDEX\n- §1: Mission",
    "## OPERATOR NOTES\n- verify byte identity",
    TASK,
    "plan/tasks.d/W1-T2886.yaml",
  );
  const diagnose = renderDiagnosePrompt(TASK, "first attempt failed\nsecond attempt failed");
  const implement = renderImplementPrompt(
    TASK,
    "- Renderer locations observed [src: recon#W1-T2886X]",
    "RUN-2886",
    "- Move pure templates to lib [src: learnings#standing-rule-7]",
    "## OPERATOR NOTES\n- keep API stable",
    "- Rule headline [src: plan#W1-T2508]",
  );

  assert.equal(sha256(fix), "6dfd1cbac80a4f9820ac2c6aa6ba06f0ac9df0662fdd05ed98c5a8a26de200e6");
  assert.equal(sha256(prerequisite), "5c52a37d141fdb3048e692885a6c8b3ae1f9481dd0f4c2f845cde736bcffa239");
  assert.equal(sha256(recon), "b42229ae8e9a92d34553002bc092ee72767c4f74b03175215264750b5195902f");
  assert.equal(sha256(diagnose), "cc1209eecea9ef35572af1a184d1a90850f2ee6eed0139082b9f54ec2edb41bc");
  assert.equal(sha256(implement), "6e1c7cd2b17da74bacbb6a010fbfe51a60f076fd4803d86389c026783e49b1a6");
});

test("prompt renderers: run-task keeps compatibility re-exports of the lib templates", () => {
  assert.equal(
    renderFixPrompt({
      task: TASK,
      round: 2,
      branch: "run-W1-T2886X-1700000000000",
      evidence: { review: { unmetCriteria: [UNMET], summary: "one criterion unmet" } },
    }),
    compatRenderFixPrompt({
      task: TASK,
      round: 2,
      branch: "run-W1-T2886X-1700000000000",
      evidence: { review: { unmetCriteria: [UNMET], summary: "one criterion unmet" } },
    }),
  );
  assert.equal(
    renderPrerequisitePrPrompt({
      task: TASK,
      branch: "run-W1-T2886X-1700000000000",
      prUrl: "https://github.com/craigoley/remudero/pull/2886",
      instrumentPaths: ["test/prompt-render.test.ts"],
      srcPaths: ["src/run-task.ts", "src/lib/prompt-render.ts"],
    }),
    compatRenderPrerequisitePrPrompt({
      task: TASK,
      branch: "run-W1-T2886X-1700000000000",
      prUrl: "https://github.com/craigoley/remudero/pull/2886",
      instrumentPaths: ["test/prompt-render.test.ts"],
      srcPaths: ["src/run-task.ts", "src/lib/prompt-render.ts"],
    }),
  );
  assert.equal(renderReconPrompt("PLAN INDEX"), compatRenderReconPrompt("PLAN INDEX"));
  assert.equal(renderDiagnosePrompt(TASK, "evidence"), compatRenderDiagnosePrompt(TASK, "evidence"));
  assert.equal(renderImplementPrompt(TASK, "", "RUN-2886"), compatRenderImplementPrompt(TASK, "", "RUN-2886"));
});

test("renderImplementPrompt: every injected CONTEXT line still carries a provenance citation", () => {
  const prompt = renderImplementPrompt(
    TASK,
    "- Renderer locations observed [src: recon#W1-T2886X]",
    "RUN-2886",
    "- Move pure templates to lib [src: learnings#standing-rule-7]",
    "- Operator note is cited [src: operator#W1-T2886X]",
    "- Rule headline [src: plan#W1-T2508]",
  );

  assert.ok(contextLines(prompt).length > 0);
  assert.deepEqual(
    contextLines(prompt).filter((line) => !line.includes("[src:")),
    [],
  );
}
);
