import assert from "node:assert/strict";
import { test } from "node:test";

import { procfsWriteOffences, runPreopenGate } from "#src/lib/preopen-gate.js";

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
