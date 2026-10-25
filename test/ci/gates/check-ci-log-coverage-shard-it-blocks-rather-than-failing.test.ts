import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { changedProcfsWriteOffences, procfsWriteOffences, runPreopenGate } from "#src/lib/preopen-gate.js";
import { gitRepo } from "#test/helpers/git-repo.js";

test("W1-T10267: check:ci-log:coverage-shard:it-blocks-rather-than-failing is prevented, not retried", async () => {
  const bad = `mkdirSync("/proc/definitely-not-writable", { recursive: true });`;
  assert.equal(procfsWriteOffences([{ name: "test/a.test.ts", text: bad }]).length, 1);
  assert.deepEqual(procfsWriteOffences([{ name: "test/a.test.ts", text: `readFileSync("/proc/meminfo")` }]), []);

  const base = { runGate: async () => ({ exitCode: 0 }), runPushGate: async () => ({ kind: "skipped", reason: "x" }) as never };
  const refused = await runPreopenGate("/nonexistent", { ...base, scanProcfsWrites: () => ["test/a.test.ts:1  " + bad] });
  assert.equal(refused.kind, "fail");
  assert.match(refused.kind === "fail" ? refused.failedSteps.join("\n") : "", /procfs-write/);

  const clean = await runPreopenGate("/nonexistent", { ...base, scanProcfsWrites: () => [] });
  assert.equal(clean.kind, "pass");
});

test("W1-T10267: the real changed-file scan reads a changed test and reports its procfs write", () => {
  const repo = gitRepo({ kind: "procfs-scan" });
  try {
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    mkdirSync(join(repo.dir, "test"));
    writeFileSync(join(repo.dir, "test", "bad.test.ts"), `mkdirSync("/proc/nope", { recursive: true });\n`);
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "bad");
    const found = changedProcfsWriteOffences(repo.dir);
    assert.equal(found.length, 1);
    assert.match(found[0], /^test\/bad\.test\.ts:1 /);
  } finally {
    repo.cleanup();
  }
});
