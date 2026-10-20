import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPreflightOutput, ordinaryTestFailureClass, runRetroPrepublishCommand } from "#src/lib/retro-preflight.js";

const failures = (count: number) => Array.from({ length: count }, (_, i) =>
  `not ok ${i + 1} - assertion ${i + 1}\n  ---\n  failureType: 'testCodeFailure'\n  error: 'actual assertion failed'\n  ...`).join("\n") + "\n";

test("retro failure-name retention stays bounded while the actual trailing totals remain observed", () => {
  const result = classifyPreflightOutput(failures(26) + "# tests 8954\n# fail 26\n# cancelled 0\n");
  assert.equal(result.failingTests.length, 20);
  assert.equal(result.failingTests[0], "assertion 1");
  assert.equal(result.failingTests.at(-1), "assertion 20");
  assert.equal(result.hasSummary, true, "the name cap must not stop the evidence scan");
  assert.equal(result.cancelledCount, 0);
  assert.equal(ordinaryTestFailureClass(result), "tests_failed");
});

test("retro cancellation totals after the name cap cannot turn an incomplete run into an assertion-only failure", () => {
  const result = classifyPreflightOutput(failures(26) + "not ok 27 - late cancellation\n  ---\n  failureType: 'cancelledByParent'\n  ...\n# tests 27\n# fail 26\n# cancelled 1\n");
  assert.equal(result.failingTests.length + result.cancelledTests.length, 20);
  assert.equal(result.hasSummary, true);
  assert.equal(result.cancelledCount, 1);
  assert.equal(ordinaryTestFailureClass(result), "tests_cancelled");
});

test("retro failure-name retention never manufactures totals for a genuinely truncated stream", () => {
  const result = classifyPreflightOutput(failures(2000));
  assert.equal(result.failingTests.length, 20);
  assert.equal(result.hasSummary, false);
  assert.equal(result.cancelledCount, undefined);
  assert.equal(ordinaryTestFailureClass(result), "tests_no_summary");
});

test("a real bounded retro subprocess preserves observed totals without losing its timeout", async () => {
  const output = failures(26) + "# tests 26\n# fail 26\n# cancelled 0\n";
  const result = await runRetroPrepublishCommand(process.execPath,
    ["-e", `process.stdout.write(${JSON.stringify(output)});setInterval(()=>{},1000);`],
    { cwd: process.cwd(), env: { ...process.env, NODE_V8_COVERAGE: "" }, encoding: "utf8", maxBuffer: 65536,
      timeout: 200, totalBackstopMs: 2000 });
  assert.equal((result.error as NodeJS.ErrnoException)?.code, "ETIMEDOUT");
  assert.equal(result.signal, "SIGTERM");
  const classified = classifyPreflightOutput(result.stdout);
  assert.equal(classified.failingTests.length, 20);
  assert.equal(classified.hasSummary, true);
  assert.equal(classified.cancelledCount, 0);
});
