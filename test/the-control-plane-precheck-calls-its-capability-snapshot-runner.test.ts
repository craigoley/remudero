import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error untyped mjs
import { runCiControlPlanePrecheck } from "#scripts/ci-control-plane-precheck.mjs";

const input = "src/lib/capability-snapshot.ts";
async function run(files: string[], runner: () => unknown) {
  let calls = 0;
  const errs: string[] = [];
  const code = runCiControlPlanePrecheck({
    readChangedFiles: () => files,
    runCapabilitySnapshot: () => { calls++; return runner(); },
    log: () => {}, error: (m: string) => errs.push(m),
  });
  return { code, calls, errs };
}

test("unit test: test/the-control-plane-precheck-calls-its-capability-snapshot-runner.test.ts", async () => {
  const { affectedCapabilitySnapshot } = await import("#scripts/ci-control-plane-precheck.mjs" as string);
  const cap = "plan/policy.yaml";
  assert.ok(affectedCapabilitySnapshot([cap]));
  const ok = await run([cap], () => ({ status: 0 }));
  assert.equal(ok.code, 0);
  assert.equal(ok.calls, 1);
  const bad = await run([cap], () => ({ status: 1, stdout: "", stderr: "" }));
  assert.equal(bad.code, 1);
  assert.match(bad.errs.join("\n"), /capability snapshot is stale/);
  const none = await run(["README.md"], () => ({ status: 1 }));
  assert.equal(none.code, 0);
  assert.equal(none.calls, 0);
});
