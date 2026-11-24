/**
 * W1-T14653 — a `unit test:` proof title of any length passes filing.
 *
 * `proof-resolvability` used to read any `unit test:` body over 100 characters as a scenario
 * narrative and block it, so a valid 106-character title was refused at filing (PORTAL-T63).
 * Whether a title resolves is judged when the build runs the proof, so no length decides it here;
 * only the comma and semicolon checks of `looksLikeScenarioNarrative` still read a body as prose.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { proofResolvabilityViolations, SCENARIO_NARRATIVE_BOUNDS } from "#src/lib/task-linter.js";
import type { Task } from "#src/lib/plan.js";

function taskWithProof(proof: string): Task {
  return {
    id: "FIX-W1-T14653",
    title: "fixture",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "a long single title", proof }],
  };
}

test("W1-T14653: a 160-character single test title passes proof-resolvability", () => {
  const title =
    "a pull request whose single acceptance criterion names one long exact test title " +
    "without any commas or semicolons is accepted at filing and judged at build time";
  assert.equal(title.length, 160);
  assert.ok(!/[,;]/.test(title), "the fixture title carries no comma or semicolon");
  assert.deepEqual(proofResolvabilityViolations(taskWithProof(`unit test: ${title}`)), []);
  assert.ok(
    !Object.hasOwn(SCENARIO_NARRATIVE_BOUNDS, "maxBodyLength"),
    "no length bound remains among the narrative bounds",
  );
});

test("W1-T14653: a title with two commas is still refused as prose", () => {
  const prose = "unit test: the daemon starts, reads its plan, and dispatches the next task";
  const violations = proofResolvabilityViolations(taskWithProof(prose));
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "proof-resolvability");
  assert.equal(violations[0]!.severity, "block");

  const semicolon = "unit test: the daemon starts; it reads its plan, then dispatches";
  assert.equal(proofResolvabilityViolations(taskWithProof(semicolon)).length, 1);

  // The refusal is for the commas, never the length: the same long body is refused with two
  // commas and accepted without them.
  const longBody =
    "the daemon starts and reads its plan and then dispatches the next queued task " +
    "to the worker that the router picked for its kind of work";
  assert.ok(longBody.length > 100);
  assert.deepEqual(proofResolvabilityViolations(taskWithProof(`unit test: ${longBody}`)), []);
  const longProse = longBody.replace(" and reads", ", reads").replace(" and then", ", then");
  assert.equal(proofResolvabilityViolations(taskWithProof(`unit test: ${longProse}`)).length, 1);
});
