import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PLAN_RECORD_ABSENT, taskRecordSha } from "#src/run-task.js";

// taskRecordSha resolves the task's record path (one read), then hashes the file (a second
// read). If the file vanishes between the two, the second read throws and the digest must read
// as the same ABSENT sentinel a never-resolved record gives. This drives that catch arm.

test("taskRecordSha reads a record that vanishes between path resolution and hashing as absent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-record-vanish-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shardDir = join(root, "plan", "tasks.d");
  mkdirSync(shardDir, { recursive: true });
  const shard = join(shardDir, "task-a.yaml");
  writeFileSync(
    shard,
    ["- id: TASK-A", "  title: task A", "  repo: remudero", "  type: implement", "  files: [src/a.ts]", ""].join("\n"),
  );
  const planPath = join(root, "plan", "tasks.yaml");

  const intact = taskRecordSha(planPath, "TASK-A");
  assert.notEqual(intact, PLAN_RECORD_ABSENT, "control: the intact record hashes to a real digest");

  const real = fs.readFileSync;
  let shardReads = 0;
  let thrown = 0;
  t.mock.method(fs, "readFileSync", ((p: unknown, ...rest: unknown[]) => {
    if (p === shard) {
      shardReads += 1;
      // The first read is taskRecordPath locating the record; the next is the hash read.
      if (shardReads >= 2) {
        thrown += 1;
        throw Object.assign(new Error("ENOENT: record vanished"), { code: "ENOENT" });
      }
    }
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  assert.equal(taskRecordSha(planPath, "TASK-A"), PLAN_RECORD_ABSENT);
  assert.equal(thrown, 1, "the hash read was the one that failed");
});
