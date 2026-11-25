import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyReviewerToolCall, ReviewerToolCallCounter, type RecordedProofCommand,
} from "#src/lib/reviewer-tool-kinds.js";

// W1-T14037 round 2: the review.reviewer row's per-kind counts now come from worker.tool_lineage (see
// test/worker/spawn/a-reviewer-tool-call-that-re-runs-a-recorded-proof-is-its-own-kind.test.ts); this file covers only the
// round-1 module, which no src path reads any more.
const RECORDED: RecordedProofCommand[] = [
  { command: "grep", args: ["-arn", "--", "export async function reviewCommand(", "src/cli/commands/review.ts"] },
  { command: "node", args: ["--test", "--import", "tsx", "--test-name-pattern", "a named proof", "test/review/x.test.ts"] },
];

test("W1-T14037: a reviewer shell call that re-runs a recorded grep proof classifies as proof_rerun", () => {
  const grep = classifyReviewerToolCall("Bash",
    { command: "grep -rn -- 'export async function reviewCommand(' src/cli/commands/review.ts" }, RECORDED);
  assert.equal(grep, "proof_rerun");
  const test = classifyReviewerToolCall("Bash",
    { command: "node --test --import tsx --test-concurrency=1 test/review/x.test.ts --test-name-pattern 'a named proof'" }, RECORDED);
  assert.equal(test, "proof_rerun");
});

test("W1-T14037: a reviewer shell call that is not a recorded proof stays bash, and each other tool keeps its own kind", () => {
  assert.equal(classifyReviewerToolCall("Bash", { command: "git rev-parse HEAD" }, RECORDED), "bash");
  assert.equal(classifyReviewerToolCall("Bash", { command: "grep -rn foo src/other.ts" }, RECORDED), "bash");
  assert.equal(classifyReviewerToolCall("Bash", { command: "grep -rn -- 'export async function reviewCommand(' src/lib/x.ts" }, RECORDED),
    "bash", "the same pattern over another path is a different check");
  assert.equal(classifyReviewerToolCall("Bash", { command: "grep -rn x ." }, []), "bash", "no recorded proof means nothing is a re-run");
  assert.equal(classifyReviewerToolCall("Bash", undefined, RECORDED), "bash");
  assert.equal(classifyReviewerToolCall("Read", { file_path: "a" }, RECORDED), "read");
  assert.equal(classifyReviewerToolCall("Grep", { pattern: "a" }, RECORDED), "grep");
  assert.equal(classifyReviewerToolCall("Glob", { pattern: "a" }, RECORDED), "glob");
  assert.equal(classifyReviewerToolCall("WebFetch", {}, RECORDED), "other");
  assert.equal(classifyReviewerToolCall(undefined, {}, RECORDED), "other");
});

test("W1-T14037: the counter counts each kind once per tool_use and ignores events that are not tool calls", () => {
  const counter = new ReviewerToolCallCounter(() => RECORDED);
  const proof = { command: "grep -rn -- 'export async function reviewCommand(' src/cli/commands/review.ts" };
  counter.observe({ kind: "tool-executing", toolName: "Bash", toolUseId: "a", toolInput: proof });
  counter.observe({ kind: "tool-executing", toolName: "Bash", toolUseId: "a", toolInput: proof });
  counter.observe({ kind: "tool-executing", toolName: "Bash", toolUseId: "b", toolInput: { command: "ls" } });
  counter.observe({ kind: "tool-executing", toolName: "Read", toolUseId: "c" });
  counter.observe({ kind: "tool-executing", toolName: "Read" });
  counter.observe({ kind: "message", toolName: "Read", toolUseId: "d" });
  assert.deepEqual(counter.snapshot(), { proof_rerun: 1, bash: 1, read: 2, grep: 0, glob: 0, other: 0 });
});
