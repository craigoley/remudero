import assert from "node:assert/strict";
import test from "node:test";
import { decideTriage, triagePrompt } from "../src/lib/triage.js";
import type { FeedbackEntry } from "../src/lib/feedback.js";

// A triage PROPOSAL must land as its own `plan/tasks.d/<id>-<slug>.yaml` shard, never as an append
// to the 12,547-line `plan/tasks.yaml` monolith. Confirmed in production: the 11:34Z run opened
// PR #1058 with +157/-0 on the monolith. With 69 feedback entries queued to drain, every proposal
// appending at end-of-file collides pairwise at EOF -- the conflict storm W1-T122 sharded the plan
// to prevent.
//
// WHAT THESE TESTS PIN, AND WHY IT IS NOT THE PROMPT STRING. The change is prompt text, and a test
// asserting an exact sentence is brittle -- the next person to reword it deletes the test rather
// than the behaviour. So these assert the SHAPE the prompt asks for: a shard path is accepted by
// the deterministic judge, the monolith still is (rewiring an existing task is legitimate), and the
// pre-existing inconsistency guards still fire. Only the last test touches the prompt text at all,
// and it asserts the DIRECTIVE's substance (a shard path is named as the target), not its wording.

const ENTRY: FeedbackEntry = {
  id: "fb-1780000000000-abcdef",
  ts: "2026-08-01T11:34:00.000Z",
  origin: "cli",
  raw: "the triage worker should write a shard, not append to the monolith",
  attachments: [],
  status: "new",
  proposal_pr: null,
};

const PROPOSED = {
  kind: "proposed" as const,
  summary: "file the shard-target fix as a task",
};

test("a triage run creating a NEW plan/tasks.d shard is ACCEPTED, not judged inconsistent", () => {
  const decision = decideTriage({
    verdict: PROPOSED,
    changedFiles: ["plan/tasks.d/W1-T279-triage-writes-a-shard.yaml"],
  });

  assert.equal(decision.action, "propose", "a new shard must be a valid proposal target");
  assert.equal((decision as { status: string }).status, "proposed");
  assert.deepEqual(
    (decision as { files: string[] }).files,
    ["plan/tasks.d/W1-T279-triage-writes-a-shard.yaml"],
    "the shard path must survive into the decision's file list",
  );
});

test("MASTER-PLAN.md remains a legitimate proposal target alongside a shard", () => {
  // Narrowing this is a separate decision -- a proposal may legitimately amend the master plan.
  const decision = decideTriage({
    verdict: PROPOSED,
    changedFiles: ["plan/tasks.d/W1-T279-triage-writes-a-shard.yaml", "MASTER-PLAN.md"],
  });

  assert.equal(decision.action, "propose");
});

test("rewiring an EXISTING task in plan/tasks.yaml is still accepted", () => {
  // The prompt only forbids APPENDING A NEW task to the monolith. A task that already lives there
  // must still be editable in place, or rewiring becomes impossible.
  const decision = decideTriage({ verdict: PROPOSED, changedFiles: ["plan/tasks.yaml"] });

  assert.equal(decision.action, "propose");
});

test("REGRESSION LOCK: a PROPOSED run that changes NOTHING is still judged inconsistent", () => {
  // The original PROPOSED-but-no-change bug. Its detection must survive this change.
  const decision = decideTriage({ verdict: PROPOSED, changedFiles: [] });

  assert.equal(decision.action, "error");
  assert.match((decision as { reason: string }).reason, /PROPOSED but no plan files were changed/);
});

test("a run touching a NON-PLAN file is still rejected even when it also writes a valid shard", () => {
  const decision = decideTriage({
    verdict: PROPOSED,
    changedFiles: ["plan/tasks.d/W1-T279-triage-writes-a-shard.yaml", "src/lib/triage.ts"],
  });

  assert.equal(decision.action, "error");
  assert.match((decision as { reason: string }).reason, /non-plan file/);
  assert.match(
    (decision as { reason: string }).reason,
    /src\/lib\/triage\.ts/,
    "the offending path must be named, not just counted",
  );
});

test("the PROPOSED directive names a plan/tasks.d shard as the write target for a new task", () => {
  // The one text assertion, deliberately narrow: it pins that a shard path is DIRECTED, not the
  // sentence that directs it. Reword freely; keep naming the target.
  const prompt = triagePrompt(ENTRY, "TRIAGE-fb-1780000000000-abcdef-1", "W1-T279");

  assert.match(prompt, /plan\/tasks\.d\//, "the prompt must name the shard directory as a target");
  assert.match(
    prompt,
    /NEVER append a new task to plan\/tasks\.yaml/,
    "the prompt must forbid the monolith append that produced PR #1058",
  );
});
