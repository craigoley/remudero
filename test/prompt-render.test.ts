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
    "PLAN INDEX\n- section 1: Mission",
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

  assert.equal(sha256(fix), "b08659f95da978d4dec4e2e9d290d6a786216b7617b952febd7648e88cc233b9");
  assert.equal(sha256(prerequisite), "5c52a37d141fdb3048e692885a6c8b3ae1f9481dd0f4c2f845cde736bcffa239");
  // W1-T3656 DELIBERATELY diverged this ONE template. renderReconPrompt no longer names shell
  // binaries ("git remote -v, git log --oneline -5, ls"), because a worker holding the allowlisted
  // check-runner instead of a shell cannot follow those literally -- which pinned the recon lane to
  // Claude. The observations it asks for are unchanged; only the instruction to use a shell is gone.
  // Re-baselined rather than reverted. The other four hashes are untouched, so this test still
  // guards W1-T2886's move for every template that did NOT intentionally change.
  // W1-T4106 re-baselined fix and implement: both now carry ONE_TEST_SUITE_AT_A_TIME_LINE.
  assert.equal(sha256(recon), "45ccd6b3f8cf9ffbf89a5d7bbe0c5c946cfa9bb27a0faea04d1f920ccdde66ad");
  // W1-T4330 re-baselined diagnose: its contract now leads with REPRODUCTION and adds FALSIFIER
  // (test/a-diagnose-report-names-a-red-capable-reproduction.test.ts pins the new text itself).
  assert.equal(sha256(diagnose), "ab2e0942887144a79c234d86a5b65ef390d05babe7c116bb4f8bd3fa5bf0fa49");
  // Re-baselined implement: its contract now teaches the QUESTION / CURRENT_ASSUMPTION lines
  // (test/a-worker-is-taught-the-question-contract.test.ts pins the new text itself).
  // Re-baselined implement: its DECISION_REQUEST now asks for a FALSIFIER line
  // (test/a-decision-request-names-its-falsifier.test.ts pins the new text itself).
  assert.equal(sha256(implement), "ebd6e18fd9907882d048984a6df3cb36f6788ce9d06d7b7dc7a525dfe40e02fd");
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
});
