import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  inboxDraftPrompt,
  planProjectionForDependsOn,
  PlanProjectionError,
  PLAN_PROJECTION_FIELDS,
} from "../src/lib/inbox.js";
import { OPENWEIGHT_CONTEXT_WINDOWS, OPENWEIGHT_MAX_COMPLETION_TOKENS } from "../src/lib/worker-provider.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAN_PATH = join(REPO_ROOT, "plan", "tasks.yaml");

/** The real plan, never a fixture: the whole finding is about THIS file's size. */
function realPlanText(): string {
  return readFileSync(PLAN_PATH, "utf8");
}

const PROPOSAL = {
  id: "fb-test-0001",
  summary: "a proposal used only to build a prompt",
} as unknown as Parameters<typeof inboxDraftPrompt>[0];

test("the inbox draft prompt grounds depends_on from a projection, not the whole plan", () => {
  // W1-T3621. MEASURED AGAINST THE REAL PLAN. The defect was that plan/tasks.yaml was 97.9% of the
  // request body, so the assertion has to be about the real file's size, not a fixture's.
  const plan = realPlanText();
  const prompt = inboxDraftPrompt(PROPOSAL, plan, "run-1");

  const planBytes = Buffer.byteLength(plan, "utf8");
  const promptBytes = Buffer.byteLength(prompt, "utf8");

  // POSITIVE CONTROL: the plan must actually be large, or "the prompt is smaller than the plan"
  // proves nothing. If the plan ever shrinks below this the assertion below stops being meaningful
  // and this line says so rather than passing quietly.
  assert.ok(planBytes > 200_000, `control: the plan should be large (was ${planBytes} bytes)`);

  // THE LOAD-BEARING ASSERTION: the whole plan is NOT pasted in.
  assert.ok(
    promptBytes < planBytes / 4,
    `the prompt (${promptBytes}) must not carry the plan (${planBytes}) — it was 97.9% of the request before`,
  );
  assert.ok(!prompt.includes(plan), "the prompt must not contain the plan file verbatim");

  // And it still grounds the field it exists to ground: real ids reach the worker.
  const firstId = /^- id: (\S+)/m.exec(plan)?.[1];
  assert.ok(firstId, "control: the plan must have at least one task id");
  assert.ok(prompt.includes(firstId), "a real task id must still reach the worker for depends_on grounding");

  // The worker must be TOLD it is holding an index, or it may reason as if it had full task bodies.
  assert.match(prompt, /INDEX/, "the prompt must say the plan block is an index");
  assert.match(prompt, /Read plan\/tasks\.yaml/, "and must say how to get a full task when it needs one");
});

test("the plan projection fits the smallest priced openweight context window", () => {
  // W1-T3621. THE POINT OF THE TASK: gpt-oss-120b (131,072) could not take this lane AT ALL, which
  // is why FALLBACK_OPENWEIGHT_MODELS had to hand-write divergent leads per tier. Measured against
  // the SMALLEST declared window, so adding a smaller deployment later re-runs this check.
  const windows = Object.values(OPENWEIGHT_CONTEXT_WINDOWS).map((w) => w.totalTokens as number);
  assert.ok(windows.length > 0, "control: there must be declared context windows to compare against");
  const smallest = Math.min(...windows);

  const projection = planProjectionForDependsOn(realPlanText());
  // The same conservative estimate the router's fit gate uses, so the two cannot disagree.
  const estimatedTokens = Math.ceil(Buffer.byteLength(projection, "utf8") / 4);

  assert.ok(
    estimatedTokens + OPENWEIGHT_MAX_COMPLETION_TOKENS <= smallest,
    `the projection is ~${estimatedTokens} tokens and the smallest declared window is ${smallest}`,
  );

  // And the control in the other direction: the UNPROJECTED plan must NOT fit, or this test would
  // pass even if the projection were removed entirely.
  const fullTokens = Math.ceil(Buffer.byteLength(realPlanText(), "utf8") / 4);
  assert.ok(
    fullTokens + OPENWEIGHT_MAX_COMPLETION_TOKENS > smallest,
    "control: the full plan must NOT fit, or the projection is not what makes this pass",
  );
});

test("the plan projection names every task in the plan", () => {
  // W1-T3621. A projection that dropped rows is WORSE than a large prompt: the worker would invent
  // an id or silently omit a real dependency edge.
  const plan = realPlanText();
  const projection = planProjectionForDependsOn(plan);

  const planIds = [...plan.matchAll(/^- id: (\S+)/gm)].map((m) => m[1]!);
  const projectedIds = [...projection.matchAll(/^- id: (\S+)/gm)].map((m) => m[1]!);

  assert.ok(planIds.length > 100, `control: expected a substantial plan, found ${planIds.length} tasks`);
  assert.deepEqual(projectedIds, planIds, "every task must appear in the projection, in order");

  // Titles reach the worker WHOLE. A clipped title loses the finding a dependency choice reads.
  const longest = planIds
    .map((id) => new RegExp(`^- id: ${id}\\n  title: (.*)$`, "m").exec(projection)?.[1] ?? "")
    .reduce((a, b) => (a.length >= b.length ? a : b), "");
  assert.ok(longest.length > 150, `titles must not be clipped (longest projected title was ${longest.length} chars)`);
  assert.ok(!projection.includes("…") && !projection.includes("..."), "no ellipsis: titles are emitted whole");

  // Every declared field is actually projected for at least one task, or the field list is a lie.
  for (const field of PLAN_PROJECTION_FIELDS) {
    assert.ok(projection.includes(`  ${field}: `), `${field} is declared in PLAN_PROJECTION_FIELDS but never emitted`);
  }
});

test("an unprojectable plan refuses rather than pasting the whole file back", () => {
  // W1-T3621. Falling back to the raw text on a parse failure would restore the 258K-token request
  // invisibly — the exact regression this task removes.
  assert.throws(() => planProjectionForDependsOn("{ not: [valid"), PlanProjectionError);
  assert.throws(() => planProjectionForDependsOn("a: mapping\nnot: a list"), PlanProjectionError);
  assert.throws(() => planProjectionForDependsOn("[]"), PlanProjectionError);
  assert.throws(() => planProjectionForDependsOn("- title: no id here"), PlanProjectionError);
  // A well-formed minimal plan still projects, so the refusals are not "always throws".
  assert.match(planProjectionForDependsOn("- id: W1-T1\n  title: a task"), /^- id: W1-T1/);
});
