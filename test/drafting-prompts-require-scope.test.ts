/**
 * W1-T512 — every prompt that MINTS a task must ask for a `files:` scope.
 *
 * WHY THIS IS NOT A STRING TEST. Each assertion below DRIVES THE REAL PROMPT BUILDER and reads the
 * field list it emits, then re-checks that the PRE-CHANGE form of that same list would have failed
 * — so a future edit that drops the field fails here rather than silently returning the fleet to a
 * state where `lintFiledTasks` (`src/lib/relint.ts`) hands a worker a blocking violation no prompt
 * ever told it how to fix.
 *
 * WHY IT MATTERS AT ALL: `overlappingPaths` (`src/lib/dispatch-overlap.ts`) is FAIL-CLOSED on an
 * absent or empty list — it reports such a task as overlapping every entry of the other side — so
 * an undeclared task never fails to dispatch, it serialises the lane behind it.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { inboxDraftPrompt } from "../src/lib/inbox.js";
import { triagePrompt } from "../src/lib/triage.js";
import { planArchitectPrompt } from "../src/lib/plan-architect.js";
import { filedTaskRelintPrompt } from "../src/lib/relint.js";
import { partitionByFileOverlap } from "../src/lib/dispatch-overlap.js";
import { buildSynthesizeTasksYamlPrompt } from "../src/run-task.js";
import type { Task } from "../src/lib/plan.js";

/** A minimal Proposal — only the fields inboxDraftPrompt reads. */
/** Minimal SynthesizeDraftInput — only the fields the prompt interpolates. */
const SYNTH_INPUT = { targetDir: "/tmp/x", owner: "o", repo: "r", inventory: {}, candidates: [], answers: [] } as unknown as Parameters<typeof buildSynthesizeTasksYamlPrompt>[0];

const proposal = { id: "P99", summary: "a proposal", reframeHistory: [] } as unknown as Parameters<typeof inboxDraftPrompt>[0];
/** A minimal FeedbackEntry — only the fields triagePrompt reads. */
const entry = { id: "fb-1", raw: "some feedback", origin: "ui", status: "new", ts: "2026-08-15T00:00:00Z", attachments: [], proposal_pr: null } as unknown as Parameters<typeof triagePrompt>[0];

test("every task-drafting prompt requires a files scope in its output contract", () => {
  const built: Array<[string, string]> = [
    ["inboxDraftPrompt", inboxDraftPrompt(proposal, "- id: W1-T1\n", "run-1")],
    ["triagePrompt", triagePrompt(entry, "run-1")],
    ["planArchitectPrompt", planArchitectPrompt("create", "a brief", "run-1")],
    ["filedTaskRelintPrompt", filedTaskRelintPrompt("triage", ["W1-T1"], [])],
  ];
  for (const [name, text] of built) {
    assert.match(text, /files:/, `${name} never mentions a files: scope — a drafter it spawns cannot know to declare one`);
    assert.match(
      text,
      /never (omit it and never leave it empty|leave it empty)|never omit the field/i,
      `${name} mentions files: but does not REQUIRE it — a field named without being demanded produces the same empty list`,
    );
  }
  // The fifth is DRIVEN too — it was exported for exactly this, rather than settling for a
  // source-text read on the one lane whose worker sits furthest from the plan.
  const synth = buildSynthesizeTasksYamlPrompt(SYNTH_INPUT, undefined);
  assert.match(synth, /every task needs id\/title\/repo\/type\/acceptance\/files/,
    "buildSynthesizeTasksYamlPrompt's field list must name files");
  assert.match(synth, /never omit it and never leave it empty/i);
});

test("the inbox draft contract names files among its required fields", () => {
  const text = inboxDraftPrompt(proposal, "- id: W1-T1\n", "run-1");
  // THE FIELD LIST ITSELF, not merely the word somewhere in the prompt.
  // The enumeration spans two emitted lines, so the join is part of what is asserted.
  const list = text.match(/schema v1 — ([\s\S]*?) at minimum/i);
  assert.ok(list, "the schema enumeration must still be present and parseable");
  const enumerated = (list![1] ?? "").replace(/\s+/g, "");
  assert.ok(enumerated.includes("files"), `files missing from the enumerated schema: ${enumerated}`);
  // FALSIFIER: the pre-change list ended at `origin`, and that form must no longer be what ships.
  assert.ok(
    !/acceptance\/origin at minimum/.test(text),
    "the pre-change field list (…/acceptance/origin at minimum) is still being emitted",
  );
});

test("the onboard synthesize contract requires a files scope too", () => {
  const text = buildSynthesizeTasksYamlPrompt(SYNTH_INPUT, undefined);
  assert.match(text, /files: is the repo-relative paths the task will touch/,
    "the onboarding seed drafter must say what files: is for, not merely name it");
  assert.ok(
    !/every task needs id\/title\/repo\/type\/acceptance,/.test(text),
    "the pre-change onboarding field list is still being emitted",
  );
});

test("a drafted fragment without a files scope is caught before it reaches the plan", () => {
  // WHAT CATCHES IT TODAY, with no lint rule merged: the dispatcher's own fail-closed treatment.
  // A fragment drafted with no scope does not fail to dispatch — it collides with EVERYTHING, which
  // is why the prompt has to ask. This pins that behaviour so the advice half cannot be read as
  // making undeclared scope safe.
  const bare = { id: "DRAFTED", files: undefined } as unknown as Task;
  const other = { id: "OTHER", files: ["src/lib/unrelated.ts"] } as unknown as Task;
  const { dispatch, serialized } = partitionByFileOverlap([bare, other]);
  assert.deepEqual(dispatch.map((t) => t.id), ["DRAFTED"]);
  assert.equal(serialized.length, 1, "an undeclared fragment must still collide with an unrelated task");
  assert.equal(serialized[0]?.blockedBy, "DRAFTED");
  // CONTROL: two declared, disjoint scopes batch — so the assertion above is about the missing
  // scope rather than about the partitioner refusing everything.
  const third = { id: "THIRD", files: ["src/lib/elsewhere.ts"] } as unknown as Task;
  assert.equal(partitionByFileOverlap([other, third]).serialized.length, 0);
});
