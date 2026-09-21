import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// The script is intentionally a standalone .mjs entry point; tsx executes it in this suite.
// @ts-expect-error no declaration file is needed for the runtime-tested script module.
import { censusSatisfiedTasks, main, readTaskRecords, renderReport } from "../scripts/satisfied-task-census.mjs";

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

test("W1-T3961: task records include the monolith and sorted YAML shards", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-satisfied-task-census-records-"));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "- id: W1-T5\n  status: queued\n");
  writeFileSync(join(root, "plan", "tasks.d", "b.yaml"), "- id: W1-T7\n  status: queued\n");
  writeFileSync(join(root, "plan", "tasks.d", "a.yaml"), "- id: W1-T6\n  status: queued\n");
  writeFileSync(join(root, "plan", "tasks.d", "README.md"), "not a task shard\n");

  const records = readTaskRecords({ cwd: root });
  assert.deepEqual(records.map((record: { id: string }) => record.id), ["W1-T5", "W1-T6", "W1-T7"]);
  assert.ok(records.every((record: { sourcePath: string }) => record.sourcePath.endsWith(".yaml")));
});

test("W1-T3961: the default executor runs a real grep proof", () => {
  const result = censusSatisfiedTasks([task("W1-T8", ["grep: satisfied-task-census in scripts/satisfied-task-census.mjs"])]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.proofs[0]?.verdict, "pass");
});

test("W1-T3961: an executor error is reported as unreadable", () => {
  const result = censusSatisfiedTasks([task("W1-T9", ["grep: satisfied-task-census in scripts"])]);
  assert.equal(result.findings.length, 0);
});

test("W1-T3961: main reads fixtures and reports a successful census", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-satisfied-task-census-main-"));
  const planPath = join(root, "tasks.yaml");
  const shardDir = join(root, "tasks.d");
  mkdirSync(shardDir);
  writeFileSync(planPath, "[]\n");
  writeFileSync(join(shardDir, "one.yaml"), "- id: W1-T10\n  status: queued\n");
  const output: string[] = [];

  assert.equal(
    main(["--cwd", root, "--plan-tasks", planPath, "--shard-dir", shardDir], {
      log: { log: (line: string) => output.push(line) },
    }),
    0,
  );
  assert.match(output[0] ?? "", /scanned: 1/);
});

test("W1-T3961: main refuses a non-list task plan", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-satisfied-task-census-refused-"));
  const planPath = join(root, "tasks.yaml");
  const errors: string[] = [];
  writeFileSync(planPath, "id: W1-T11\n");

  assert.equal(
    main(["--plan-tasks", planPath, "--shard-dir", root], {
      log: { log: () => {}, error: (line: string) => errors.push(line) },
    }),
    2,
  );
  assert.match(errors[0] ?? "", /REFUSED/);
});
