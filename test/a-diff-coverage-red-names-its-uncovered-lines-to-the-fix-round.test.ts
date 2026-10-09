/**
 * #10339 (W1-T7092): diff-coverage blocked four added catch-arm lines, two fleet fix rounds
 * committed nothing, and a hand fix added one test per catch arm. renderFixPrompt's ci-log mode
 * now names the gate's own uncovered lines as the round's targets, with the catch-arm and
 * default-seam remedy.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { renderFixPrompt } from "../src/lib/prompt-render.js";

const BLOCKED_LOG = [
  "diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests; cover each line, or only for re-exec/exit glue use a process-boundary directive, even though the aggregate coverage-ratchet floor may still be satisfied:",
  "  - src/lib/daemon-memory-telemetry.ts:277",
  "  - src/lib/daemon-memory-telemetry.ts:324",
  "  - src/lib/daemon-memory-telemetry.ts:323",
  "  - src/lib/daemon.ts:1528 -- c8 ignore waiver is not honoured; use // diff-cov: re-exec or exit",
  "  ... 2 more not listed (cap 100)",
].join("\n");

function ciLogPrompt(logTail: string, harnessCommits?: boolean): string {
  return renderFixPrompt({
    task: { id: "W1-T7092", title: "heap age", files: ["src/lib/daemon-memory-telemetry.ts", "src/lib/daemon.ts"] },
    round: 1,
    branch: "run-W1-T7092-1",
    evidence: { ciFailures: [{ name: "coverage-ratchet", logTail, conclusion: "FAILURE" }] },
    harnessCommits,
  });
}

test("a diff-coverage red names each uncovered file and line to the ci-log fix round", () => {
  const prompt = ciLogPrompt(BLOCKED_LOG);
  assert.match(prompt, /DIFF-COVERAGE TARGETS/);
  assert.ok(prompt.includes("  - src/lib/daemon-memory-telemetry.ts: lines 277, 323, 324"), prompt);
  assert.ok(prompt.includes("  - src/lib/daemon.ts: line 1528"));
  assert.ok(prompt.includes("(and 2 more the gate counted but did not list)"));
  assert.match(prompt, /`catch`\/error arm needs a test that makes that\s+call fail/);
  assert.match(prompt, /DEFAULT implementation needs one test that runs the\s+real default/);
  assert.match(prompt, /npm run diff-coverage:local/);
});

test("a harness-committed diff-coverage round is told to verify without git", () => {
  const prompt = ciLogPrompt(BLOCKED_LOG, true);
  assert.match(prompt, /DIFF-COVERAGE TARGETS/);
  assert.match(prompt, /You cannot run git this round/);
  assert.doesNotMatch(prompt, /npm run diff-coverage:local/);
});

test("a ci-log red that is not a diff-coverage block gets no coverage targets", async () => {
  const prompt = ciLogPrompt("not ok 3 - some unrelated assertion\n# fail 1");
  assert.doesNotMatch(prompt, /DIFF-COVERAGE TARGETS/);
  const mod = await import("../src/lib/diff-coverage-targets.js");
  assert.equal(mod.diffCoverageTargets(["not ok 3 - x"]), undefined);
  assert.deepEqual(mod.diffCoverageTargets([BLOCKED_LOG])?.targets.map((t: { file: string }) => t.file), [
    "src/lib/daemon-memory-telemetry.ts",
    "src/lib/daemon.ts",
  ]);
});
