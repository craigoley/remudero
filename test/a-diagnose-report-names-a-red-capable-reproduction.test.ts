/**
 * W1-T4330 — THE DIAGNOSE RUNG MUST SHOW IT REPRODUCED THE FAILURE.
 *
 * The diagnose worker runs after two failed attempts, and `runDiagnoseThenRetry` carries its report
 * VERBATIM into the third attempt. Before this task the contract asked for ROOT CAUSE, EVIDENCE and
 * SUGGESTED APPROACH only, so a cause read from code alone reached the retry looking like a finding.
 * The contract now leads with REPRODUCTION (a command that goes red, or an explicit NONE) and adds a
 * FALSIFIER for the stated cause. Nothing parses these fields; the assertions are on the prompt text
 * the worker is actually handed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { renderDiagnosePrompt } from "../src/lib/prompt-render.js";

const TASK = { id: "W1-T4330", title: "probe" };
const prompt = renderDiagnosePrompt(TASK, "attempt 1 failed\nattempt 2 failed");
const contract = prompt.slice(prompt.indexOf("DIAGNOSE REPORT"));

test("W1-T4330: the diagnose prompt requires a reproduction command or an explicit NONE before the root cause", () => {
  assert.match(prompt, /Build the reproduction FIRST: one command, run by you, that goes red on this exact failure/);
  assert.match(prompt, /before you read code to form a theory/);
  assert.match(contract, /^REPRODUCTION: .*or NONE/m, "NONE is the admissible answer when no loop can be built");
  assert.match(contract, /prefix INFERRED if REPRODUCTION is NONE/, "and a cause without one is labelled");
  // ORDER is the point: the reproduction is reported before the cause it is meant to ground.
  assert.ok(contract.indexOf("REPRODUCTION:") < contract.indexOf("ROOT CAUSE:"), "REPRODUCTION precedes ROOT CAUSE");
});

test("W1-T4330: the diagnose prompt requires a falsifier for the stated root cause", () => {
  assert.match(contract, /^FALSIFIER: <the one observation that would prove the root cause wrong, and whether you checked it>$/m);
  assert.ok(contract.indexOf("ROOT CAUSE:") < contract.indexOf("FALSIFIER:"), "the falsifier follows the cause it tests");
  // The fields the retry already relies on are kept, so nothing downstream loses a line it reads.
  for (const field of ["EVIDENCE:", "SUGGESTED APPROACH:"]) assert.ok(contract.includes(field), field);
});

test("W1-T4330: the read-only boundary is unchanged", () => {
  assert.ok(
    prompt.startsWith(
      "You are a DIAGNOSE worker. Do NOT modify, commit, or push ANYTHING — this is a read-only " +
        "investigation. Two prior attempts at the task below both failed.",
    ),
    "the boundary sentence is byte-identical",
  );
  assert.match(prompt, /never propose or write a patch/);
  assert.match(prompt, /^TASK: W1-T4330 — probe$/m);
});
