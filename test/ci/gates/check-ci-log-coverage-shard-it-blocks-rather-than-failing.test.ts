import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { changedProcfsWriteOffences, procfsWriteOffences, runPreopenGate } from "#src/lib/preopen-gate.js";
import { gitRepo } from "#test/helpers/git-repo.js";

// Assembled so no line here pairs a literal procfs path with a write call (W1-T3345 census).
const PROCFS = "/pro" + "c/";

test("W1-T10267: check:ci-log:coverage-shard:it-blocks-rather-than-failing is prevented, not retried", async () => {
  const bad = `mkdirSync("${PROCFS}definitely-not-writable", { recursive: true });`;
  assert.equal(procfsWriteOffences([{ name: "test/a.test.ts", text: bad }]).length, 1);
  assert.deepEqual(procfsWriteOffences([{ name: "test/a.test.ts", text: `readFileSync("/proc/meminfo")` }]), []);

  const base = { runGate: async () => ({ exitCode: 0 }), runPushGate: async () => ({ kind: "skipped", reason: "x" }) as never };
  const refused = await runPreopenGate("/nonexistent", { ...base, scanProcfsWrites: () => ["test/a.test.ts:1  " + bad] });
  assert.equal(refused.kind, "fail");
  assert.match(refused.kind === "fail" ? refused.failedSteps.join("\n") : "", /procfs-write/);

  const clean = await runPreopenGate("/nonexistent", { ...base, scanProcfsWrites: () => [] });
  assert.equal(clean.kind, "pass");
});

test("W1-T10267: uncommitted untracked and staged tests are scanned before any commit", async () => {
  const repo = gitRepo({ kind: "procfs-scan-uncommitted" });
  try {
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    mkdirSync(join(repo.dir, "test"));
    const badText = `mkdirSync("${PROCFS}nope", { recursive: true });\n`;
    writeFileSync(join(repo.dir, "test", "untracked.test.ts"), badText);
    writeFileSync(join(repo.dir, "test", "staged.test.ts"), badText);
    repo.git("add", "test/staged.test.ts");
    const found = changedProcfsWriteOffences(repo.dir);
    assert.equal(found.length, 2);
    assert.ok(found.some((f) => f.startsWith("test/untracked.test.ts:1 ")));
    assert.ok(found.some((f) => f.startsWith("test/staged.test.ts:1 ")));
    const result = await runPreopenGate(repo.dir, { runGate: async () => ({ exitCode: 0 }), runPushGate: async () => ({ kind: "skipped", reason: "x" }) as never });
    assert.equal(result.kind, "fail");
    assert.match(result.kind === "fail" ? result.failedSteps.join("\n") : "", /procfs-write/);
  } finally {
    repo.cleanup();
  }
});

test("W1-T10267: a renamed test with an added procfs write is still scanned", () => {
  const repo = gitRepo({ kind: "procfs-scan-rename" });
  try {
    mkdirSync(join(repo.dir, "test"));
    const body = Array.from({ length: 30 }, (_, i) => `const line${i} = ${i};\n`).join("");
    writeFileSync(join(repo.dir, "test", "old.test.ts"), body);
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "old");
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    repo.git("mv", "test/old.test.ts", "test/renamed.test.ts");
    writeFileSync(join(repo.dir, "test", "renamed.test.ts"), `${body}mkdirSync("${PROCFS}nope", { recursive: true });\n`);
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "rename");
    const found = changedProcfsWriteOffences(repo.dir);
    assert.equal(found.length, 1);
    assert.match(found[0], /^test\/renamed\.test\.ts:31 /);
  } finally {
    repo.cleanup();
  }
});

test("W1-T10267: the real changed-file scan reads a changed test and reports its procfs write", () => {
  const repo = gitRepo({ kind: "procfs-scan" });
  try {
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    mkdirSync(join(repo.dir, "test"));
    const badText = `mkdirSync("${PROCFS}nope", { recursive: true });\n`;
    writeFileSync(join(repo.dir, "test", "bad.test.ts"), badText);
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "bad");
    const found = changedProcfsWriteOffences(repo.dir);
    assert.equal(found.length, 1);
    assert.match(found[0], /^test\/bad\.test\.ts:1 /);
  } finally {
    repo.cleanup();
  }
});
