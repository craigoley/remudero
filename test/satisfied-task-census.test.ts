import assert from "node:assert/strict";
import { test } from "node:test";
// The script is intentionally a standalone .mjs entry point; tsx executes it in this suite.
// @ts-expect-error no declaration file is needed for the runtime-tested script module.
import { censusSatisfiedTasks, renderReport } from "../scripts/satisfied-task-census.mjs";

const task = (id: string, proofs: string[], extra: Record<string, unknown> = {}) => ({
  id,
  status: "queued",
  acceptance: proofs.map((proof) => ({ claim: proof, proof })),
  ...extra,
});

test("W1-T3961: a task whose proofs all pass at main is reported", () => {
  const result = censusSatisfiedTasks(
    [task("W1-T1", ["unit test: W1-T3961: a task whose proofs all pass at main is reported", "grep: needle in src/example.ts"])],
    () => "pass",
  );
  assert.deepEqual(result.findings[0]?.taskId, "W1-T1");
  assert.equal(result.findings[0]?.proofs.length, 2);
});

test("W1-T3961: a whole-file proof shape is never evidence of satisfaction", () => {
  const result = censusSatisfiedTasks([task("W1-T2", ["unit test: test/example.test.ts"])], () => "pass");
  assert.equal(result.findings.length, 0);
});

test("W1-T3961: a task with work remaining is not reported", () => {
  const result = censusSatisfiedTasks(
    [task("W1-T3", ["unit test: W1-T3961: a task with work remaining is not reported", "grep: missing in src/example.ts"])],
    (_parsed: unknown, proof: string) => (proof.startsWith("grep:") ? "fail" : "pass"),
  );
  assert.equal(result.findings.length, 0);
});

test("W1-T3961: the census reports and does not refuse", () => {
  const result = censusSatisfiedTasks([task("W1-T4", ["grep: present in src/example.ts"])], () => "pass");
  assert.equal(result.findings.length, 1);
  assert.match(renderReport(result), /W1-T4/);
  assert.match(renderReport(result), /pass: grep: present in src\/example\.ts/);
});
