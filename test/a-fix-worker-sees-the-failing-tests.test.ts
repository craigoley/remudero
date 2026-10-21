import assert from "node:assert/strict";
import { test } from "node:test";
import { renderFixPrompt } from "../src/lib/prompt-render.js";
import {
  BARE_EXIT_CODE_ANNOTATION,
  ciFailurePromptEvidence,
  extractCiFailureRegion,
  fetchCiFailures,
} from "../src/run-task.js";

const TAP_FAILURE = [
  "not ok 7 - W1-T4461 fixture fails with a useful assertion",
  "  ---",
  "  error: |",
  "    AssertionError: expected worker diagnosis",
  "    expected: 2",
  "    actual: 1",
  "  ...",
  "FLAKE-RETRY: first attempt failed — W1-T4461 fixture fails with a useful assertion",
].join("\n");

test("W1-T4461: a test failure's fix prompt names the failing test and its error", () => {
  const [failure] = fetchCiFailures(
    "owner",
    "repo",
    [
      {
        name: "ci-shard (1/4)",
        conclusion: "FAILURE",
        detailsUrl: "https://github.com/owner/repo/actions/runs/1/job/4461",
      },
    ],
    60,
    {
      fetchAnnotations: () => [BARE_EXIT_CODE_ANNOTATION],
      fetchJobLog: () => TAP_FAILURE,
    },
  );

  assert.equal(failure?.tailSource, "log");
  const evidence = ciFailurePromptEvidence([failure!]);
  const prompt = renderFixPrompt({
    task: { id: "W1-T4461", title: "fix worker diagnostics", files: ["src/run-task.ts"] },
    round: 1,
    branch: "run-W1-T4461-test",
    evidence: { ciFailures: evidence },
  });

  assert.match(prompt, /failure detail source: log/);
  assert.match(prompt, /not ok 7 - W1-T4461 fixture fails with a useful assertion/);
  assert.match(prompt, /AssertionError: expected worker diagnosis/);
  assert.match(prompt, /FLAKE-RETRY: first attempt failed/);
  assert.doesNotMatch(prompt, /Process completed with exit code 1/);
});

test("W1-T4461: an annotation with a real finding remains the prompt's source when the log names no failure", () => {
  let logReads = 0;
  const [failure] = fetchCiFailures(
    "owner",
    "repo",
    [{ name: "lint", conclusion: "FAILURE", detailsUrl: "https://github.com/owner/repo/actions/runs/1/job/4462" }],
    60,
    {
      fetchAnnotations: () => ["src/run-task.ts:1: lint finding"],
      fetchJobLog: () => { logReads++; return "ordinary build output"; },
    },
  );

  const prompt = renderFixPrompt({
    task: { id: "W1-T4461", title: "fix worker diagnostics", files: ["src/run-task.ts"] },
    round: 1,
    branch: "run-W1-T4461-test",
    evidence: { ciFailures: ciFailurePromptEvidence([failure!]) },
  });
  assert.match(prompt, /failure detail source: annotations/);
  assert.match(prompt, /src\/run-task\.ts:1: lint finding/);
  assert.equal(logReads, 1, "W1-T9434 checks the log for a failing test before choosing annotations");
  assert.doesNotMatch(prompt, /ordinary build output/);
});

test("W1-T4461: TAP extraction is bounded and preserves retry evidence", () => {
  const lines = Array.from({ length: 100 }, (_, index) => `noise ${index}`);
  lines.splice(50, 0, TAP_FAILURE);
  const extracted = extractCiFailureRegion(lines.join("\n"), 20);
  assert.ok(extracted.split("\n").length <= 20);
  assert.match(extracted, /not ok 7/);
  assert.match(extracted, /AssertionError/);
  assert.match(extracted, /FLAKE-RETRY/);
});
